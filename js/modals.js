    // ===========================================================
    // REWARD BREAKDOWN MODAL
    // Decomposes the last completed epoch's rewards distributed
    // through a validator into four pieces that sum exactly to the
    // grand total:
    //   • Voting Commission      — the validator's vote-account reward
    //   • Self-Stake             — stake whose withdrawer == the vote
    //                              account's withdrawer (or user-flagged)
    //   • X1 Foundation          — stake whose withdrawer == X1 Labs
    //   • Community Delegation   — everything else (Ripper pool + third
    //                              parties)
    // Classification mirrors classifyStakeSource() (withdrawer-based) so
    // it stays consistent with the Delegations leaderboard and stake
    // breakdown. Computed lazily on click (one getProgramAccounts + a
    // chunked getInflationReward over every delegated stake account), so
    // it never runs on page/card load.
    // ===========================================================
    const _rewardBreakdownCache = {};

    function rbEsc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
      ));
    }

    function closeRewardBreakdown() {
      const m = document.getElementById('rewardBreakdownModal');
      if (m) m.style.display = 'none';
    }

    async function openRewardBreakdown(voteAccount, name, commission) {
      const modal = document.getElementById('rewardBreakdownModal');
      const body  = document.getElementById('rewardBreakdownBody');
      const sub   = document.getElementById('rewardBreakdownSub');
      if (!modal || !body) return;
      modal.style.display = 'flex';
      if (sub) sub.textContent = name ? name : 'Last completed epoch';
      body.innerHTML =
        '<div class="rb-loading"><div class="loading-spinner-small"></div>' +
        '<span>Computing reward distribution…</span></div>';
      try {
        const data = await computeRewardBreakdown(voteAccount, commission);
        renderRewardBreakdown(body, sub, data, name);
      } catch (e) {
        console.error('[reward-breakdown] failed:', e);
        const retry = "openRewardBreakdown('" + voteAccount + "', '" +
          escAttrJs(name) + "', " + (commission || 0) + ")";
        body.innerHTML =
          '<div class="rb-error">Could not compute the breakdown.' +
          '<span>' + rbEsc((e && e.message) || String(e)) + '</span>' +
          '<button onclick="' + retry + '">Retry</button></div>';
      }
    }

    async function computeRewardBreakdown(voteAccount, commission) {
      const cached = _rewardBreakdownCache[voteAccount];
      if (cached && cached.ts > Date.now() - 300000) return cached.data; // 5 min

      // 1) Current epoch
      const epochInfo = await rpcCall('getEpochInfo');
      const curEpoch = epochInfo.epoch;

      // 2) Newest indexed epoch for the vote account (same determinant the
      //    card uses) + its voting (commission) reward.
      let targetEpoch = null, votingLamports = 0;
      for (let i = 1; i <= 4 && (curEpoch - i) >= 0; i++) {
        const ep = curEpoch - i;
        const res = await rpcCall('getInflationReward', [[voteAccount], { epoch: ep }]);
        const entry = res && res[0];
        if (entry && entry.amount != null) {
          targetEpoch = ep;
          votingLamports = entry.amount || 0;
          break;
        }
      }
      if (targetEpoch === null) {
        throw new Error('No indexed epoch yet — RPC may still be catching up');
      }

      // 3) Vote account withdrawer (for self-stake matching)
      let voteWithdrawer = null;
      try {
        const va = await rpcCall('getAccountInfo', [voteAccount, { encoding: 'jsonParsed' }]);
        voteWithdrawer = va?.value?.data?.parsed?.info?.authorizedWithdrawer || null;
      } catch (e) { /* non-fatal: self-stake just folds into community */ }

      // 4) Every stake account delegated to this validator
      const stakeAccts = await rpcCall('getProgramAccounts', [
        STAKE_PROGRAM_ID,
        { encoding: 'jsonParsed', filters: [{ memcmp: { offset: 124, bytes: voteAccount } }] }
      ]) || [];

      // 5) Honor any manual self-stake classification the user set
      const userSel = typeof getSelfStakeSelections === 'function'
        ? getSelfStakeSelections(voteAccount) : null;
      const userSelfSet = new Set((userSel && userSel.pubkeys) || []);
      const hasUserSel = hasUserClassification(userSel);

      // 6) Classify each stake account into exactly one bucket
      const catOf  = new Map();
      const counts = { self: 0, foundation: 0, community: 0 };
      for (const acc of stakeAccts) {
        const pk = acc.pubkey;
        const wd = acc.account?.data?.parsed?.info?.meta?.authorized?.withdrawer || null;
        let cat;
        if (hasUserSel) {
          // User override is authoritative for the self bucket.
          if (userSelfSet.has(pk)) cat = 'self';
          else cat = (classifyStakeSource(wd) === 'foundation') ? 'foundation' : 'community';
        } else if (wd && voteWithdrawer && wd === voteWithdrawer) {
          cat = 'self';
        } else if (classifyStakeSource(wd) === 'foundation') {
          cat = 'foundation';
        } else {
          cat = 'community';
        }
        catOf.set(pk, cat);
        counts[cat]++;
      }

      // 7) Inflation rewards for ALL stake accounts at targetEpoch.
      //    getInflationReward returns a positional array aligned to input,
      //    so we attribute each result to its account's bucket by index.
      const allPk = Array.from(catOf.keys());
      const sums = { self: 0, foundation: 0, community: 0 };
      const CHUNK = 100;
      for (let i = 0; i < allPk.length; i += CHUNK) {
        const slice = allPk.slice(i, i + CHUNK);
        const res = await rpcCall('getInflationReward', [slice, { epoch: targetEpoch }]);
        if (Array.isArray(res)) {
          for (let j = 0; j < slice.length; j++) {
            const r = res[j];
            if (r && r.amount != null) sums[catOf.get(slice[j])] += r.amount;
          }
        }
      }

      const toX = (l) => l / 1e9;
      const data = {
        epoch: targetEpoch,
        commission: commission,
        voting:     toX(votingLamports),   // total voting commission collected (on-chain vote reward)
        self:       toX(sums.self),         // net reward on the validator's own self-stake
        foundation: toX(sums.foundation),   // net reward paid to X1 Foundation delegators
        community:  toX(sums.community),    // net reward paid to community / pool delegators
        counts:     counts,
        stakeCount: stakeAccts.length,
      };

      // Attribute the voting commission to the stake source it was earned from.
      // commission_i = voting × (net_i / totalNet). This uses the ACTUAL on-chain
      // vote reward (no commission-rate assumption) and sums back to `voting`
      // exactly. grossSource = the total rewards that source's stake generated
      // (delegator's net share + the validator's commission cut).
      const totalNet = data.self + data.foundation + data.community;
      data.attributed = totalNet > 0;
      if (data.attributed) {
        data.commFoundation = data.voting * (data.foundation / totalNet);
        data.commCommunity  = data.voting * (data.community  / totalNet);
        data.commSelf       = data.voting * (data.self       / totalNet);
      } else {
        data.commFoundation = 0;
        data.commCommunity  = 0;
        data.commSelf       = 0;
      }
      data.grossFoundation = data.foundation + data.commFoundation;
      data.grossCommunity  = data.community  + data.commCommunity;

      // What the validator actually EARNED = its commission + its own stake's
      // net reward. (Delegators keep their own rewards; those are not earnings.)
      data.earned = data.voting + data.self;

      _rewardBreakdownCache[voteAccount] = { ts: Date.now(), data };
      return data;
    }

    function renderRewardBreakdown(body, sub, data, name) {
      const epochText = data.epochLabel || ('Epoch #' + data.epoch);
      if (sub) sub.textContent = (name ? name + ' · ' : '') + epochText;
      const fmt = (x) => formatNumber(x, 4);
      const pctOf = (x) => data.earned > 0 ? (x / data.earned * 100) : 0;
      const acct = (n) => n + ' account' + (n === 1 ? '' : 's');

      // Four flat bars, identical styling, that sum to the card value.
      //   Self-Stake Rewards        = net reward on the validator's own stake
      //   Voting Rewards            = the commission earned on that own self-stake
      //   Commission · X1 Foundation= commission earned from X1 Foundation delegators
      //   Commission · Community    = commission earned from community / pool delegators
      const bars = data.attributed ? [
        { label: 'Self-Stake Rewards',         sub: 'net reward on your own stake · ' + acct(data.counts.self),
          color: 'var(--success)',     val: data.self },
        { label: 'Voting Rewards',             sub: 'commission on your own self-stake',
          color: 'var(--accent-gold)', val: data.commSelf },
        { label: 'Commission · X1 Foundation', sub: acct(data.counts.foundation),
          color: 'var(--accent-cyan)', val: data.commFoundation },
        { label: 'Commission · Community Stakes', sub: acct(data.counts.community) + ' · incl. pools',
          color: '#8b7cf6',            val: data.commCommunity },
      ] : [
        { label: 'Self-Stake Rewards', sub: 'net reward on your own stake · ' + acct(data.counts.self),
          color: 'var(--success)',     val: data.self },
        { label: 'Voting Rewards',     sub: 'validator commission',
          color: 'var(--accent-gold)', val: data.voting },
      ];

      const rowsHtml = bars.map(r => {
        const p = pctOf(r.val);
        return '<div class="rb-row">' +
          '<div class="rb-row-head">' +
            '<span class="rb-label"><span class="rb-dot" style="background:' + r.color + '"></span>' + r.label + '</span>' +
            '<span class="rb-amt">' + fmt(r.val) + ' <span class="rb-unit">XNT</span></span>' +
          '</div>' +
          '<div class="rb-bar"><div class="rb-bar-fill" style="width:' + p.toFixed(2) + '%;background:' + r.color + '"></div></div>' +
          '<div class="rb-row-foot"><span class="rb-sub">' + r.sub + '</span><span class="rb-pct">' + p.toFixed(1) + '%</span></div>' +
        '</div>';
      }).join('');

      const scopeNote = data.isPortfolio
        ? 'Totals across all ' + data.validatorCount + ' validators in your Data Center. '
        : '';

      body.innerHTML =
        '<div class="rb-rows">' + rowsHtml + '</div>' +
        '<div class="rb-divider"></div>' +
        '<div class="rb-line rb-total"><span>Total earned this epoch</span><span class="rb-amt">' + fmt(data.earned) + ' XNT</span></div>' +
        '<div class="rb-note">' + scopeNote + 'This is what the validator <strong>earned</strong> — its self-stake reward, the voting commission on its own stake, and the commission from X1 Foundation and community delegators. Rewards paid to delegators are their own, so the bars sum to the figure shown on the card.</div>';
    }

    // Portfolio-wide breakdown: sums the per-validator earnings breakdown
    // across every validator in My Data Center. Opened from the Breakdown
    // link under the "Rewards Last Epoch" grand total.
    async function openPortfolioRewardBreakdown() {
      const modal = document.getElementById('rewardBreakdownModal');
      const body  = document.getElementById('rewardBreakdownBody');
      const sub   = document.getElementById('rewardBreakdownSub');
      if (!modal || !body) return;
      modal.style.display = 'flex';
      if (sub) sub.textContent = 'All validators';
      body.innerHTML =
        '<div class="rb-loading"><div class="loading-spinner-small"></div>' +
        '<span>Computing portfolio reward distribution…</span></div>';

      const validators = (typeof myPortfolio !== 'undefined' && Array.isArray(myPortfolio)) ? myPortfolio : [];
      if (!validators.length) {
        body.innerHTML = '<div class="rb-error">No validators in your Data Center yet.' +
          '<button onclick="closeRewardBreakdown()">Close</button></div>';
        return;
      }

      try {
        const results = [];
        for (const v of validators) {
          try {
            results.push(await computeRewardBreakdown(v.voteAccount, v.commission || 0));
          } catch (e) {
            console.warn('[portfolio-breakdown] skip', v.voteAccount, (e && e.message) || e);
          }
        }
        if (!results.length) throw new Error('No indexed reward data available yet');

        const agg = {
          isPortfolio: true,
          validatorCount: results.length,
          voting: 0, self: 0, foundation: 0, community: 0,
          commFoundation: 0, commCommunity: 0, commSelf: 0,
          grossFoundation: 0, grossCommunity: 0,
          counts: { self: 0, foundation: 0, community: 0 },
        };
        const epochs = new Set();
        for (const d of results) {
          agg.voting += d.voting;          agg.self += d.self;
          agg.foundation += d.foundation;  agg.community += d.community;
          agg.commFoundation += d.commFoundation;
          agg.commCommunity  += d.commCommunity;
          agg.commSelf       += d.commSelf;
          agg.grossFoundation += d.grossFoundation;
          agg.grossCommunity  += d.grossCommunity;
          agg.counts.self += d.counts.self;
          agg.counts.foundation += d.counts.foundation;
          agg.counts.community += d.counts.community;
          epochs.add(d.epoch);
        }
        agg.attributed = (agg.self + agg.foundation + agg.community) > 0;
        agg.earned = agg.voting + agg.self;
        agg.epochLabel = epochs.size === 1
          ? ('Epoch #' + Array.from(epochs)[0])
          : 'latest epoch · per validator';

        renderRewardBreakdown(body, sub, agg, 'All Validators');
      } catch (e) {
        console.error('[portfolio-breakdown] failed:', e);
        body.innerHTML = '<div class="rb-error">Could not compute the portfolio breakdown.' +
          '<span>' + rbEsc((e && e.message) || String(e)) + '</span>' +
          '<button onclick="openPortfolioRewardBreakdown()">Retry</button></div>';
      }
    }

    // ── Hover / click-to-pin tooltip state ──────────────────────
    // Hover is transient; clicking a bar pins the tooltip open and reveals
    // a "Show first/last tx" button. Module-level (vs. closure) so the SVG's
    // onmouseenter/onclick attributes can reach them without a re-bind.
    let _tpsHoveredBucket = null;
    let _tpsPinnedBucket  = null;
    let _tpsTxData        = {};   // keyed by bucket index → {loading, error, firstTx, lastTx, firstSlot, lastSlot}
    let _tpsBucketMeta    = null; // populated by renderTpsModal — array of bucket-window metadata
    let _tpsBucketGeom    = null; // populated by renderTpsModal — {barW, gap, W, bucketPeak, n}

    // Block-signature fetch with skipped-slot fallback.
    // X1 (Solana fork) skips a small fraction of slots; if the targeted slot
    // wasn't produced, walk in `direction` (+1 forward / -1 backward) up to
    // 3 times to find the nearest produced block. Bounded — worst case 4
    // RPC calls per side per click. Returns {slot, signatures} or null.
    async function _fetchBlockSigsForTps(slot, direction) {
      const MAX_WALK = 3;
      for (let i = 0; i <= MAX_WALK; i++) {
        const trySlot = slot + direction * i;
        try {
          const res = await rpcCall('getBlock', [trySlot, {
            transactionDetails: 'signatures',
            rewards: false,
            maxSupportedTransactionVersion: 0,
          }]);
          if (res && Array.isArray(res.signatures) && res.signatures.length > 0) {
            return { slot: trySlot, signatures: res.signatures };
          }
          // Empty block (0 sigs) — keep walking; we want a slot with txs
        } catch (err) {
          // -32004/-32007/-32009 etc. = skipped/unavailable. rpcCall throws
          // on data.error, so just continue the walk.
          const msg = (err && err.message) || '';
          if (/skip|not available|cleaned up/i.test(msg)) continue;
          // Other errors (network, timeout) — abort the walk
          throw err;
        }
      }
      return null;
    }

    // Fires both block fetches in parallel for the bucket's first + last slot.
    // Updates _tpsTxData[bucketIdx] and re-renders the tooltip.
    async function _fetchTxsForTpsBucket(bucketIdx, startSlot, endSlot) {
      _tpsTxData[bucketIdx] = { loading: true };
      _renderTpsTooltip();
      try {
        const [firstBlk, lastBlk] = await Promise.all([
          _fetchBlockSigsForTps(startSlot, +1),
          _fetchBlockSigsForTps(endSlot, -1),
        ]);
        const firstTx = firstBlk && firstBlk.signatures && firstBlk.signatures[0] || null;
        const lastTx  = lastBlk  && lastBlk.signatures  && lastBlk.signatures[0]  || null;
        if (!firstTx && !lastTx) {
          _tpsTxData[bucketIdx] = {
            loading: false,
            error: 'No blocks produced in this window',
          };
        } else {
          _tpsTxData[bucketIdx] = {
            loading: false,
            firstTx, lastTx,
            firstSlot: firstBlk ? firstBlk.slot : null,
            lastSlot:  lastBlk  ? lastBlk.slot  : null,
          };
        }
      } catch (err) {
        console.warn('[TPS] tx fetch error:', err && err.message || err);
        _tpsTxData[bucketIdx] = {
          loading: false,
          error: 'Couldn’t load — RPC may be busy',
        };
      }
      _renderTpsTooltip();
    }

    // Copy address to clipboard with brief visual confirmation.
    async function _copyTpsTx(sig, btnEl) {
      try {
        await navigator.clipboard.writeText(sig);
        if (btnEl) {
          const orig = btnEl.textContent;
          btnEl.textContent = '✓';
          setTimeout(() => { btnEl.textContent = orig; }, 1500);
        }
      } catch (e) { /* old browsers / non-secure context — no-op */ }
    }

    // Helper invoked by SVG hit-zone elements via inline handlers.
    function _onTpsBarEnter(idx) {
      _tpsHoveredBucket = idx;
      _renderTpsTooltip();
    }
    function _onTpsBarLeave(idx) {
      if (_tpsHoveredBucket === idx) _tpsHoveredBucket = null;
      _renderTpsTooltip();
    }
    function _onTpsBarClick(idx) {
      _tpsPinnedBucket = (_tpsPinnedBucket === idx) ? null : idx;
      _renderTpsTooltip();
    }
    function _closeTpsPin() {
      _tpsPinnedBucket = null;
      _renderTpsTooltip();
    }

    // Renders the HTML tooltip overlay based on current hover/pin state.
    // Called on every interaction (vs. React's reactive re-render).
    function _renderTpsTooltip() {
      const host = document.getElementById('tpsModalTooltipHost');
      if (!host) return;
      const activeIdx = (_tpsPinnedBucket != null) ? _tpsPinnedBucket : _tpsHoveredBucket;
      if (activeIdx == null || !_tpsBucketMeta || !_tpsBucketGeom) {
        host.innerHTML = '';
        return;
      }
      const meta = _tpsBucketMeta[activeIdx];
      if (!meta) { host.innerHTML = ''; return; }
      const geom = _tpsBucketGeom;
      const isPinned = _tpsPinnedBucket != null && _tpsPinnedBucket === activeIdx;

      // Position: tooltip's left = bucket center as % of full SVG width.
      const barCenter = activeIdx * (geom.barW + geom.gap) + geom.barW / 2;
      const leftPct = (barCenter / geom.W) * 100;
      const edge = leftPct < 8 ? 'left' : leftPct > 92 ? 'right' : 'center';

      // ── Tooltip position math ──
      // Anchor tooltip just above the BAR's top edge (not above the chart container,
      // which is what was clipping into the modal header). For tall bars where the
      // bar's top is too close to chart top, flip below the chart entirely.
      // Pinned tooltips ALWAYS flip below — they're too tall (~190px) to fit above
      // almost any bar.
      const barHeightPct = geom.bucketPeak > 0 ? (meta.avgTps / geom.bucketPeak) * 100 : 0;
      const CHART_H_PX = 280;
      const barTopFromChartTop = CHART_H_PX * (1 - barHeightPct / 100);
      const requiredRoom = isPinned ? 190 : 100;
      const flipBelow = isPinned || barTopFromChartTop < requiredRoom;

      const fmtUtc = (ms) => {
        const d = new Date(ms);
        return String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0');
      };
      const fmtLocal = (ms) => {
        const d = new Date(ms);
        return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
      };
      const utcRange   = fmtUtc(meta.startMs) + '–' + fmtUtc(meta.endMs);
      const localRange = fmtLocal(meta.startMs) + '–' + fmtLocal(meta.endMs);
      const singleSample = meta.sampleCount <= 1;

      const tx = _tpsTxData[activeIdx];
      const canShowTxButton = isPinned && meta.startSlot != null && meta.endSlot != null;

      // Build tooltip HTML
      let inner = '';
      if (isPinned) {
        inner += '<button class="tps-tooltip-close" onclick="_closeTpsPin()" title="Close">×</button>';
      }
      inner += '<div class="tps-tooltip-tps">' + _tpsFmt(meta.avgTps) + ' TPS</div>';
      inner += '<div class="tps-tooltip-time">'
            + (singleSample ? fmtUtc(meta.endMs) : utcRange)
            + ' <span class="tps-tooltip-tz">UTC</span></div>';
      inner += '<div class="tps-tooltip-time-local">'
            + (singleSample ? fmtLocal(meta.endMs) : localRange)
            + ' <span class="tps-tooltip-tz">local</span></div>';

      if (canShowTxButton && !tx) {
        inner += '<button class="tps-tooltip-fetch-btn" onclick="_fetchTxsForTpsBucket('
              + activeIdx + ',' + meta.startSlot + ',' + meta.endSlot + ')">Show first/last tx</button>';
      } else if (tx && tx.loading) {
        inner += '<div class="tps-tooltip-tx-loading">Loading transactions…</div>';
      } else if (tx && tx.error) {
        inner += '<div class="tps-tooltip-tx-error">'
              + tx.error
              + '<button class="tps-tooltip-retry-btn" onclick="_fetchTxsForTpsBucket('
              + activeIdx + ',' + meta.startSlot + ',' + meta.endSlot + ')">Retry</button>'
              + '</div>';
      } else if (tx && (tx.firstTx || tx.lastTx)) {
        inner += '<div class="tps-tooltip-tx-block">'
              + _renderTxRow('First', tx.firstTx, tx.firstSlot)
              + _renderTxRow('Last',  tx.lastTx,  tx.lastSlot)
              + '</div>';
      }

      if (!isPinned) {
        inner += '<div class="tps-tooltip-hint">click bar for tx details</div>';
      }

      // Build inline style: left always; bottom only when positioning above bar.
      // When flipped below, CSS handles positioning via top: 100%+12.
      const positionStyle = flipBelow
        ? 'left:' + leftPct + '%'
        : 'left:' + leftPct + '%; bottom:calc(' + barHeightPct + '% + 12px)';

      host.innerHTML =
          '<div class="tps-tooltip ' + (isPinned ? 'tps-tooltip-pinned' : '')
        + '" style="' + positionStyle + '" data-edge="' + edge + '"'
        + ' data-flip="' + (flipBelow ? 'below' : 'above') + '"'
        + ' onclick="event.stopPropagation()">'
        + inner
        + '</div>';
    }

    // Builds one tx-hash row (label · truncated link · copy button).
    function _renderTxRow(label, sig, slot) {
      if (!sig) {
        return '<div class="tps-tx-row tps-tx-row-empty">'
             + '<span class="tps-tx-label">' + label + '</span>'
             + '<span class="tps-tx-missing">— no tx —</span>'
             + '</div>';
      }
      const trunc = sig.slice(0, 6) + '…' + sig.slice(-6);
      const explorerUrl = 'https://explorer.mainnet.x1.xyz/tx/' + encodeURIComponent(sig);
      const title = sig + (slot ? ' (slot ' + slot + ')' : '');
      // Inline copy handler — passes the button element so it can flash ✓
      return '<div class="tps-tx-row">'
           + '<span class="tps-tx-label">' + label + '</span>'
           + '<a href="' + explorerUrl + '" target="_blank" rel="noopener noreferrer" class="tps-tx-sig" title="' + title.replace(/"/g, '&quot;') + '">' + trunc + '</a>'
           + '<button class="tps-tx-copy" onclick="_copyTpsTx(\'' + sig + '\', this)" title="Copy signature">⧉</button>'
           + '</div>';
    }

    // Human-friendly formatter for large cumulative numbers (total
    // transactions, etc). Distinct from _tpsFmt which is tuned for
    // per-second magnitudes.
    function _tpsFmtLarge(n) {
      if (!isFinite(n)) return '—';
      if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
      return Math.round(n).toLocaleString();
    }

    // Clean minute/hour formatter. Rounds FIRST, then splits, so
    // "5h 60m" / "2h 60m" rollover bugs can't happen.
    function _tpsFmtAgo(minutes) {
      const m = Math.round(minutes);
      if (m < 1) return 'now';
      if (m < 60) return m + 'm';
      const h = Math.floor(m / 60);
      const rem = m - h * 60;
      if (h < 12) return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
      return `${Math.round(m / 60)}h`;
    }

    function renderTpsModal() {
      const chartEl = document.getElementById('tpsModalChart');
      if (!chartEl) return;
      const series = tpsSamplesCache;
      if (!series || series.length < 2) {
        chartEl.innerHTML = '<div class="tps-strip-empty" style="height:100%">No samples yet — give it a moment…</div>';
        return;
      }

      // ── Stats from the RAW series (full fidelity) ──────────────
      let peak = -Infinity, peakIdx = 0, low = Infinity, lowIdx = 0;
      let total = 0;
      for (let i = 0; i < series.length; i++) {
        if (series[i] > peak) { peak = series[i]; peakIdx = i; }
        if (series[i] < low)  { low  = series[i]; lowIdx  = i; }
        total += series[i];
      }
      const avg = total / series.length;
      // Median without mutating the source.
      const sorted = series.slice().sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      const median = sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
      // Total transactions — each sample covers 60s, so TPS * 60 = txs.
      const totalTxs = total * 60;
      const totalMinutes = Math.max(1, series.length - 1);

      // ── Bucket into 60 bars for a cleaner visual ──────────────
      const BUCKET_COUNT = 60;
      const bucketSize = Math.max(1, Math.ceil(series.length / BUCKET_COUNT));
      const buckets = [];
      // bucketMeta — same length as buckets[]; carries time window + slot range
      // for tooltip rendering. nowMs captured at render time, slightly stale
      // if modal stays open for many minutes (acceptable; tps values stale too).
      const bucketMeta = [];
      const nowMs = Date.now();
      const SAMPLE_MS = 60000;
      const haveSlots = Array.isArray(tpsSlotDataCache) && tpsSlotDataCache.length === series.length;
      for (let i = 0; i < series.length; i += bucketSize) {
        const end = Math.min(i + bucketSize, series.length);
        let sum = 0;
        for (let j = i; j < end; j++) sum += series[j];
        const avg = sum / (end - i);
        buckets.push(avg);
        // Series is oldest→newest, so older index = further in the past.
        const startMinutesAgo = series.length - 1 - i;
        const endMinutesAgo   = series.length - 1 - (end - 1);
        let startSlot = null, endSlot = null;
        if (haveSlots) {
          const firstSample = tpsSlotDataCache[i];
          const lastSample  = tpsSlotDataCache[end - 1];
          if (firstSample && firstSample.endSlot != null && firstSample.slotCount > 0) {
            startSlot = firstSample.endSlot - firstSample.slotCount + 1;
          }
          if (lastSample && lastSample.endSlot != null) {
            endSlot = lastSample.endSlot;
          }
        }
        bucketMeta.push({
          avgTps: avg,
          startMs: nowMs - startMinutesAgo * SAMPLE_MS,
          endMs:   nowMs - endMinutesAgo   * SAMPLE_MS,
          sampleCount: end - i,
          startSlot,
          endSlot,
        });
      }
      const bucketPeak = Math.max.apply(null, buckets);
      const scaleMax = Math.max(bucketPeak, 1);

      // ── SVG bar chart ─────────────────────────────────────────
      // Reserve a right-side gutter for the Y-axis labels so they don't
      // sit on top of the tallest bars. All drawing math below treats
      // `chartW` (not W) as the usable plotting area.
      const W = 1000, H = 280;
      const RIGHT_PAD = 58;
      const chartW = W - RIGHT_PAD;
      const gap = 2;
      const n = buckets.length;
      const barW = Math.max(1, (chartW - gap * (n - 1)) / n);

      // Stash bucket geom + meta for the tooltip renderer to use.
      _tpsBucketMeta = bucketMeta;
      _tpsBucketGeom = { barW, gap, W, bucketPeak, n };
      // Reset interaction state when the chart is rebuilt (e.g. on poll refresh
      // mid-modal). Leaving stale pin would point at a different bar.
      _tpsHoveredBucket = null;
      _tpsPinnedBucket  = null;
      _tpsTxData        = {};

      // Gridlines at 25/50/75/100% of bucket peak, stopping at the
      // gutter so the label column stays clean.
      const gridValues = [scaleMax, scaleMax * 0.75, scaleMax * 0.5, scaleMax * 0.25];
      const gridLines = gridValues.map(v => {
        const y = (H - (v / scaleMax) * H).toFixed(1);
        return `<line x1="0" y1="${y}" x2="${chartW}" y2="${y}" stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>`
             + `<text x="${chartW + 6}" y="${y}" fill="rgba(255,255,255,0.7)" font-family="JetBrains Mono, monospace" font-size="11" font-weight="500" text-anchor="start" dominant-baseline="middle">${_tpsFmt(v)}</text>`;
      }).join('');

      let bars = '';
      for (let i = 0; i < n; i++) {
        const h = (buckets[i] / scaleMax) * H;
        const x = (i * (barW + gap)).toFixed(2);
        const y = (H - h).toFixed(2);
        bars += `<rect x="${x}" y="${y}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" fill="url(#tpsGradBig)" rx="1.5"/>`;
        // Invisible full-height hit zone for hover/click. Sits over the
        // entire column so skinny low-TPS bars are easy to target.
        bars += `<rect x="${x}" y="0" width="${barW.toFixed(2)}" height="${H}" fill="transparent" style="cursor:pointer"`
             + ` onmouseenter="_onTpsBarEnter(${i})" onmouseleave="_onTpsBarLeave(${i})" onclick="_onTpsBarClick(${i})"/>`;
      }

      chartEl.innerHTML =
          `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="tps-spark-svg" style="overflow:visible">`
        +   `<defs>`
        +     `<linearGradient id="tpsGradBig" x1="0" x2="0" y1="0" y2="1">`
        +       `<stop offset="0"    stop-color="#00d4ff" stop-opacity="0.95"/>`
        +       `<stop offset="0.55" stop-color="#00d4ff" stop-opacity="0.55"/>`
        +       `<stop offset="1"    stop-color="#00d4ff" stop-opacity="0.15"/>`
        +     `</linearGradient>`
        +   `</defs>`
        +   gridLines
        +   bars
        + `</svg>`;

      // Clear any stale tooltip from a previous render
      _renderTpsTooltip();

      // ── Axis labels — adapt to however many samples we actually got ──
      const axisEl = document.getElementById('tpsModalAxisRow');
      if (axisEl) {
        const quarter = totalMinutes / 4;
        axisEl.innerHTML =
            `<span>${_tpsFmtAgo(totalMinutes)} ago</span>`
          + `<span>${_tpsFmtAgo(quarter * 3)}</span>`
          + `<span>${_tpsFmtAgo(quarter * 2)}</span>`
          + `<span>${_tpsFmtAgo(quarter)}</span>`
          + `<span>now</span>`;
      }

      // ── Stat cards ────────────────────────────────────────────
      const currentVal = series[series.length - 1];
      const deltaVsAvg = avg > 0 ? ((currentVal - avg) / avg) * 100 : 0;
      const setText = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
      };
      const minutesAgo = (idx) => (series.length - 1 - idx);

      setText('tpsModalCurrentValue', _tpsFmt(currentVal));
      const curDeltaEl = document.getElementById('tpsModalCurrentDelta');
      if (curDeltaEl) {
        if (Math.abs(deltaVsAvg) < 1) {
          curDeltaEl.textContent = '→ near avg';
          curDeltaEl.className = 'tps-modal-card-sub';
        } else if (deltaVsAvg > 0) {
          curDeltaEl.textContent = `↗ ${deltaVsAvg.toFixed(0)}% vs avg`;
          curDeltaEl.className = 'tps-modal-card-sub up';
        } else {
          curDeltaEl.textContent = `↘ ${Math.abs(deltaVsAvg).toFixed(0)}% vs avg`;
          curDeltaEl.className = 'tps-modal-card-sub down';
        }
      }
      setText('tpsModalAvgValue',    _tpsFmt(avg));
      setText('tpsModalAvgSub',      `${series.length} samples · ${(totalMinutes / 60).toFixed(1)}h`);
      setText('tpsModalMedianValue', _tpsFmt(median));
      setText('tpsModalMedianSub',   'half the time above this');
      setText('tpsModalPeakValue',   _tpsFmt(peak));
      setText('tpsModalPeakSub',     _tpsFmtAgo(minutesAgo(peakIdx)) + ' ago');
      setText('tpsModalLowValue',    _tpsFmt(low));
      setText('tpsModalLowSub',      _tpsFmtAgo(minutesAgo(lowIdx)) + ' ago');
      setText('tpsModalTotalValue',  _tpsFmtLarge(totalTxs));
      setText('tpsModalTotalSub',    `over ${(totalMinutes / 60).toFixed(1)}h`);
    }

    // ── Validator scorecard modal ───────────────────────────────
    // Pops open from any slot/feed/top-skipper/portfolio click on Network
    // Live and shows the validator's "Last Epoch / Current Epoch" scorecard
    // without ever leaving the page.
    function skipmonOpenScorecard(votePubkey) {
      const body  = document.getElementById('skipmonScorecardBody');
      const title = document.getElementById('skipmonScorecardTitle');
      const modal = document.getElementById('skipmonScorecardModal');
      if (!body || !modal) return;

      const v = (typeof allValidators !== 'undefined' && Array.isArray(allValidators))
        ? allValidators.find(x => x.votePubkey === votePubkey) : null;
      if (title) title.textContent = v && v.name ? v.name : 'Validator';

      const html = (typeof SkipMonitor !== 'undefined' && SkipMonitor.getScorecardHtml)
        ? SkipMonitor.getScorecardHtml(votePubkey) : null;
      body.innerHTML = html || '<div class="skipmon-empty">Validator not found in the active set.</div>';
      modal.style.display = 'flex';
    }
    function closeSkipmonScorecard() {
      const modal = document.getElementById('skipmonScorecardModal');
      if (modal) modal.style.display = 'none';
    }

    // Click-outside-to-close and Escape-key-to-close (modals using this file's pattern)
    document.addEventListener('DOMContentLoaded', function() {
      [['epochTimelineModal',   closeEpochTimelineModal],
       ['tpsModal',              closeTpsModal],
       ['skipmonScorecardModal', closeSkipmonScorecard]].forEach(([id, closer]) => {
        const modal = document.getElementById(id);
        if (!modal) return;
        modal.addEventListener('click', function(e) {
          if (e.target === this) closer();
        });
      });
      document.addEventListener('keydown', function(e) {
        if (e.key !== 'Escape') return;
        for (const [id, closer] of [['epochTimelineModal',   closeEpochTimelineModal],
                                     ['tpsModal',              closeTpsModal],
                                     ['skipmonScorecardModal', closeSkipmonScorecard]]) {
          const m = document.getElementById(id);
          if (m && m.style.display === 'flex') { closer(); break; }
        }
      });
    });

    // Validator Lookup search: three bridges the search input calls.
    // handleLookupInput rebuilds the dropdown on every keystroke;
    // handleLookupBlur dismisses it after a brief delay so an onmousedown
    // pick can fire first; pickLookup stashes the selection and renders.
    function skipmonLookupInputChanged() {
      if (typeof SkipMonitor !== 'undefined') SkipMonitor.handleLookupInput();
    }
    function skipmonLookupInputBlurred() {
      if (typeof SkipMonitor !== 'undefined') SkipMonitor.handleLookupBlur();
    }
    function skipmonLookupPick(votePubkey) {
      if (typeof SkipMonitor !== 'undefined') SkipMonitor.pickLookup(votePubkey);
    }
    // Portfolio card → open the on-page scorecard modal for this validator.
    // Routes through the same helper the grid cells, feed items, and top-
    // skipper rows use, so clicking any validator reference on Network Live
    // opens the same wide scorecard view without leaving the page.
    function skipmonOpenPortfolioModal(nodePubkey, name, voteAccount) {
      if (voteAccount) {
        skipmonOpenScorecard(voteAccount);
      } else if (typeof openSlotModal === 'function') {
        // Extreme fallback — scorecard needs a vote account to resolve.
        openSlotModal(nodePubkey, name, voteAccount);
      }
    }

    // ─────────────────────────────────────────────────────────
    // SLOT EXPLORER MODAL  (current + last epoch + both)
    // ─────────────────────────────────────────────────────────
    const SM_SLOT_MS = 420;

    let _smNodePubkey    = null;
    let _smName          = null;
    let _smVoteAccount   = null;
    let _smEpochView     = 'current';   // 'current' | 'last' | 'both'
    let _smCache         = {};          // 'current' | 'last' → data

    // ── Helpers ────────────────────────────────────────────
    function smCountdown(ms) {
      if (ms === null) return 'None left';
      const s = Math.round(ms / 1000);
      if (s < 60)  return `~${s}s`;
      const m = Math.floor(s / 60), rs = s % 60;
      if (m < 60)  return `~${m}m ${rs}s`;
      const h = Math.floor(m / 60), rm = m % 60;
      return `~${h}h ${rm}m`;
    }
    function smSkipStyle(pct) {
      if (pct === 0) return 'color:var(--success)';
      if (pct < 5)   return 'color:var(--warning)';
      return 'color:var(--danger)';
    }

    // ── Fetch one epoch's data ─────────────────────────────
    async function smFetchEpoch(nodePubkey, which) {
      // which: 'current' or 'last'
      const epochInfo = await rpcCall('getEpochInfo');
      const slotsPerEpoch          = epochInfo.slotsInEpoch;
      const firstSlotOfCurrentEpoch = epochInfo.absoluteSlot - epochInfo.slotIndex;

      let assigned = 0, produced = 0, mySlots = [], epochLabel = '';

      if (which === 'current') {
        // Block production — no range = current epoch
        const bp = await fetch(RPC_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc:'2.0', id:1,
            method: 'getBlockProduction', params: [{ identity: nodePubkey }] })
        }).then(r => r.json());
        const byId = bp?.result?.value?.byIdentity?.[nodePubkey];
        if (byId) [assigned, produced] = byId;

        // Leader schedule — cached
        if (!leaderScheduleCache) await loadLeaderSchedule();
        mySlots    = (leaderScheduleCache?.[nodePubkey] || []).slice().sort((a,b)=>a-b);
        epochLabel = `Epoch ${epochInfo.epoch}`;

      } else {
        // Last epoch range
        const firstSlot = firstSlotOfCurrentEpoch - slotsPerEpoch;
        const lastSlot  = firstSlotOfCurrentEpoch - 1;

        const bp = await fetch(RPC_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc:'2.0', id:1,
            method: 'getBlockProduction',
            params: [{ identity: nodePubkey, range: { firstSlot, lastSlot } }] })
        }).then(r => r.json());
        const byId = bp?.result?.value?.byIdentity?.[nodePubkey];
        if (byId) [assigned, produced] = byId;

        // Leader schedule for last epoch — pass a slot within that epoch
        const prevSchedule = await rpcCall('getLeaderSchedule', [lastSlot]);
        mySlots    = ((prevSchedule || {})[nodePubkey] || []).slice().sort((a,b)=>a-b);
        epochLabel = `Epoch ${epochInfo.epoch - 1} — Completed`;
      }

      const skipped = assigned - produced;
      const skipPct = assigned > 0 ? (skipped / assigned * 100) : 0;

      // Next slot (only meaningful for current epoch). Compute the
      // RELATIVE next leader slot first so the countdown math stays in
      // epoch-indexed units, then convert to ABSOLUTE before returning so
      // the displayed "Slot #" matches the Network Live view (which uses
      // absolute slot numbers throughout).
      const si              = which === 'current' ? epochInfo.slotIndex : slotsPerEpoch;
      const nextSlotRel     = which === 'current' ? (mySlots.find(s => s > si) ?? null) : null;
      const msUntil         = nextSlotRel !== null ? (nextSlotRel - si) * SM_SLOT_MS : null;
      const nextSlot        = nextSlotRel !== null ? nextSlotRel + firstSlotOfCurrentEpoch : null;

      // ── Per-slot produced/skipped reconciliation ──────────
      // IMPORTANT: getLeaderSchedule returns slot indexes RELATIVE to the
      // start of the epoch (0..slotsPerEpoch-1). All UI logic (pip display,
      // slotIndex comparisons, nextSlot math) uses relative indexes.
      // We translate relative→absolute when querying the RPC, then store
      // relative slots in producedSet so the renderer doesn't change.
      //
      // Uses the shared fetchProducedSlots helper so this view and the
      // Network Live "My Validators" timeline agree on which past slots
      // were produced vs skipped. If every chunk fails, producedSet stays
      // null and the renderer reverts to all-green pips (legacy behavior).
      let producedSet = null;
      const slotsToCheck = which === 'current'
        ? mySlots.filter(s => s <= si)   // only past slots for in-progress epoch
        : mySlots;                        // all slots for completed epoch
      const epochFirstAbsoluteSlot = which === 'current'
        ? firstSlotOfCurrentEpoch
        : (firstSlotOfCurrentEpoch - slotsPerEpoch);
      // Per-slot fetch only positions red pips. For validators with thousands of
      // leader slots this would fire thousands of getBlock calls and stall the
      // panel (and could starve the other panel in "Both"). Cap it: above the
      // limit we skip per-slot detail and render from the aggregate counts, which
      // still show the correct produced/skipped totals.
      const PER_SLOT_FETCH_CAP = 3000;
      if (slotsToCheck.length > 0 && slotsToCheck.length <= PER_SLOT_FETCH_CAP) {
        const absoluteLeaderSlots = slotsToCheck.map(rel => rel + epochFirstAbsoluteSlot);
        const absProducedSet = await fetchProducedSlots(absoluteLeaderSlots);
        if (absProducedSet !== null) {
          // Convert absolute slots in the returned Set back to relative
          // (renderer uses relative indexes).
          producedSet = new Set();
          for (const abs of absProducedSet) producedSet.add(abs - epochFirstAbsoluteSlot);
          if (Math.abs(producedSet.size - produced) > 1) {
            console.warn(`[SlotExplorer:${which}] Reconciliation mismatch for ${nodePubkey}: aggregate=${produced}, per-slot=${producedSet.size}`);
          }
        }
      }

      // assigned (from RPC) = leader slots elapsed so far in the queried range.
      // assignedTotal = full epoch assignment count (from leader schedule).
      // Skip rate & progress bar still use elapsed `assigned` as denominator.
      const assignedTotal = mySlots.length;

      return { assigned, assignedTotal, produced, skipped, skipPct,
               nextSlot, msUntil, mySlots, slotIndex: si,
               isCurrent: which === 'current', epochLabel,
               producedSet };
    }

    // ── Shared expand/collapse for any slot-timeline grid ──
    // Used by both the Slot Explorer modal (.sm-timeline) and the Network
    // "My Validators" preview (.skipmon-pv-tl). Collapsed view shows a preview
    // of pips PLUS every skipped (red) pip so misses are never hidden; the rest
    // is rendered lazily only when expanded, with a hard cap so a validator with
    // tens of thousands of slots can't freeze the page.
    window._slotTl = window._slotTl || {};
    let _slotTlSeq = 0;
    const SLOT_TL_PREVIEW = 144;   // pips shown while collapsed
    const SLOT_TL_MAX     = 2000;  // hard cap on pips ever rendered (perf guard)

    // pipObjs: [{ html, red }] in chronological order. Returns the grid wrapper
    // (grid div + optional toggle + optional "capped" note) as an HTML string.
    function assembleSlotTimeline(pipObjs, gridClass, assignedTotal) {
      // Cap rendering: always keep every red pip; cap non-red pips at the max.
      const render = [];
      let nonRed = 0, truncated = false;
      for (const p of pipObjs) {
        if (p.red) render.push(p);
        else if (nonRed < SLOT_TL_MAX) { render.push(p); nonRed++; }
        else truncated = true;
      }
      // Collapsed = first PREVIEW pips + any red beyond that window.
      const collapsedParts = [], fullParts = [];
      render.forEach((p, i) => {
        fullParts.push(p.html);
        if (i < SLOT_TL_PREVIEW || p.red) collapsedParts.push(p.html);
      });
      const hidden = render.length - collapsedParts.length;
      const total  = (assignedTotal != null) ? assignedTotal : pipObjs.length;
      const id = 'stl' + (++_slotTlSeq);
      window._slotTl[id] = { collapsed: collapsedParts.join(''), full: fullParts.join('') };

      let html = `<div class="${gridClass} slot-tl collapsed" data-stl="${id}">${window._slotTl[id].collapsed}</div>`;
      if (hidden > 0) {
        const clabel = truncated
          ? `▾ Show more (${hidden.toLocaleString()} pips)`
          : `▾ Show all ${total.toLocaleString()} slots (${hidden.toLocaleString()} more)`;
        html += `<button class="slot-tl-toggle" data-id="${id}" data-clabel="${clabel}" onclick="toggleSlotTimeline(this)">${clabel}</button>`;
      }
      if (truncated) {
        html += `<div class="slot-tl-note">Showing ${render.length.toLocaleString()} of ${total.toLocaleString()} slots — capped for performance.</div>`;
      }
      return html;
    }

    window.toggleSlotTimeline = function (btn) {
      const id = btn.getAttribute('data-id');
      const store = window._slotTl[id];
      const tl = btn.parentElement && (btn.parentElement.querySelector('.slot-tl[data-stl="' + id + '"]') || btn.parentElement.querySelector('.slot-tl'));
      if (!tl || !store) return;
      const expand = tl.classList.contains('collapsed');
      if (expand) {
        tl.innerHTML = store.full;          // lazy-build the overflow now
        tl.classList.remove('collapsed');
        btn.innerHTML = '▴ Collapse';
      } else {
        tl.innerHTML = store.collapsed;
        tl.classList.add('collapsed');
        btn.innerHTML = btn.getAttribute('data-clabel') || '▾ Show all slots';
      }
    };

    // ── Render one panel's inner HTML ──────────────────────
    function smRenderPanel(d) {
      const pct        = d.assigned > 0 ? (d.produced / d.assigned * 100) : 0;
      const skippedPct = d.assigned > 0 ? (d.skipped  / d.assigned * 100) : 0;

      // Show ALL past slots so any skipped ones are visible. Building is bounded
      // (SLOT_TL_MAX) so a validator with tens of thousands of slots can't hang
      // the page; the assembler collapses the rest behind a "Show all" toggle.
      let pastSlots, upcomingSlots;
      if (d.isCurrent) {
        pastSlots     = d.mySlots.filter(s => s <= d.slotIndex);
        upcomingSlots = d.mySlots.filter(s => s >  d.slotIndex);
      } else {
        pastSlots     = d.mySlots.slice();
        upcomingSlots = [];
      }
      const hasProducedData = d.producedSet != null;

      // Avoid materializing tens of thousands of pip strings. Upcoming is always
      // safe to bound (no reds). Past pips are bounded only when we lack per-slot
      // red positions — in that case reds are grouped up front so a slice keeps
      // them; with per-slot data the past list is already small (fetch is capped).
      const SM_BUILD_CAP = SLOT_TL_MAX + 200;
      if (!hasProducedData && pastSlots.length > SM_BUILD_CAP) pastSlots = pastSlots.slice(0, SM_BUILD_CAP);
      if (upcomingSlots.length > SM_BUILD_CAP) upcomingSlots = upcomingSlots.slice(0, SM_BUILD_CAP);

      // Reconcile per-slot data with the aggregate `skipped` count from
      // getBlockProduction (the ground truth). Confirmation lag and
      // pruned-block history can both make getBlock return null/error
      // for blocks that were actually produced, which would otherwise
      // paint those slots red. We cap the number of red pips at exactly
      // `d.skipped`, preferring earlier chronological positions for the
      // red placement (later-missing slots are more likely lag artifacts).
      const skippedBudget0 = d.skipped || 0;
      let redBudget = skippedBudget0;

      const pipObjs = [];
      pastSlots.forEach(s => {
        if (!hasProducedData) {
          // No per-slot detail (RPC failed, or capped for a huge validator):
          // still reflect the aggregate skip count as red pips grouped up front.
          if (redBudget > 0) {
            redBudget--;
            pipObjs.push({ html: `<div class="sm-pip skipped" title="Slot ${s.toLocaleString()} — Skipped"></div>`, red: true });
          } else {
            pipObjs.push({ html: `<div class="sm-pip produced" title="Slot ${s.toLocaleString()}"></div>`, red: false });
          }
          return;
        }
        if (d.producedSet.has(s)) {
          pipObjs.push({ html: `<div class="sm-pip produced" title="Slot ${s.toLocaleString()} — Produced"></div>`, red: false });
          return;
        }
        if (redBudget > 0) {
          redBudget--;
          pipObjs.push({ html: `<div class="sm-pip skipped" title="Slot ${s.toLocaleString()} — Skipped"></div>`, red: true });
          return;
        }
        pipObjs.push({ html: `<div class="sm-pip produced" title="Slot ${s.toLocaleString()} — Produced (pending finalization)"></div>`, red: false });
      });
      upcomingSlots.forEach(s => {
        const ms = (s - d.slotIndex) * SM_SLOT_MS;
        pipObjs.push({ html: `<div class="sm-pip upcoming" title="Slot ${s.toLocaleString()} — in ${smCountdown(ms)}"></div>`, red: false });
      });

      const hasTimeline = (pastSlots.length + upcomingSlots.length) > 0;


      return `
        <div class="sm-body-inner">
          <div class="sm-stats">
            <div class="sm-stat">
              <div class="sm-stat-label">Assigned</div>
              <div class="sm-stat-value" style="color:var(--accent-blue)">${d.assignedTotal.toLocaleString()}</div>
              <div class="sm-stat-sub">slots</div>
            </div>
            <div class="sm-stat">
              <div class="sm-stat-label">Produced</div>
              <div class="sm-stat-value" style="color:var(--success)">${d.produced.toLocaleString()}</div>
              <div class="sm-stat-sub">blocks</div>
            </div>
            <div class="sm-stat">
              <div class="sm-stat-label">Skipped</div>
              <div class="sm-stat-value" style="color:${d.skipped>0?'var(--danger)':'var(--success)'}">${d.skipped.toLocaleString()}</div>
              <div class="sm-stat-sub">missed</div>
            </div>
            <div class="sm-stat">
              <div class="sm-stat-label">Skip Rate</div>
              <div class="sm-stat-value" style="${smSkipStyle(d.skipPct)}">${d.assigned>0 ? d.skipPct.toFixed(2)+'%' : 'N/A'}</div>
              <div class="sm-stat-sub">this epoch</div>
            </div>
          </div>

          <div class="sm-bar-wrap">
            <div class="sm-bar-labels">
              <span>Block production</span>
              <span>${pct.toFixed(1)}% success</span>
            </div>
            <div class="sm-bar-track">
              <div class="sm-bar-produced" style="width:${pct.toFixed(1)}%"></div>
              ${d.skipped>0 ? `<div class="sm-bar-skipped" style="width:${skippedPct.toFixed(1)}%"></div>` : ''}
            </div>
          </div>

          <div class="sm-next-box">
            ${d.isCurrent ? `
            <div class="sm-next-cell">
              <div class="sm-next-cell-label">Next leader slot in</div>
              <div class="sm-next-cell-value">${smCountdown(d.msUntil)}</div>
            </div>
            <div class="sm-next-cell">
              <div class="sm-next-cell-label">Slot #</div>
              <div class="sm-next-cell-value" style="font-size:0.82rem">${d.nextSlot!==null ? d.nextSlot.toLocaleString() : '—'}</div>
            </div>` : `
            <div class="sm-next-cell" style="flex:2">
              <div class="sm-next-cell-label">Status</div>
              <div class="sm-next-cell-value" style="font-size:0.85rem;color:var(--text-secondary)">Epoch completed</div>
            </div>`}
            <div class="sm-next-cell">
              <div class="sm-next-cell-label">Elapsed</div>
              <div class="sm-next-cell-value" style="font-size:0.82rem">${d.assigned.toLocaleString()} / ${d.assignedTotal.toLocaleString()}</div>
            </div>
          </div>

          ${hasTimeline ? `
          <div>
            <div class="sm-timeline-label">
              Slot timeline
              <span class="sm-legend"><span class="sm-pip-demo" style="background:var(--success)"></span> Produced</span>
              ${d.skipped>0 ? `<span class="sm-legend"><span class="sm-pip-demo" style="background:var(--danger)"></span> Skipped</span>` : ''}
              ${upcomingSlots.length ? `<span class="sm-legend"><span class="sm-pip-demo" style="border:1px solid var(--accent-blue);background:transparent"></span> Upcoming</span>` : ''}
            </div>
            ${assembleSlotTimeline(pipObjs, 'sm-timeline', d.assignedTotal)}
          </div>` : ''}
        </div>`;
    }

    // ── Render full modal body for a given view ────────────
    function smRenderBody(view) {
      const cur  = _smCache['current'];
      const last = _smCache['last'];
      const box  = document.getElementById('slotModalBox');

      if (view === 'both' && cur && last) {
        box.classList.add('wide');
        return `
          <div class="sm-both-wrap">
            <div>
              <div class="sm-panel-label">◀ ${last.epochLabel}</div>
              ${smRenderPanel(last)}
            </div>
            <div>
              <div class="sm-panel-label">▶ ${cur.epochLabel}</div>
              ${smRenderPanel(cur)}
            </div>
          </div>
          <div class="sm-footer">
            <button class="sm-refresh-btn" onclick="smRefreshAll()">↻ Refresh</button>
          </div>`;
      } else {
        box.classList.remove('wide');
        const d = view === 'last' ? last : cur;
        if (!d) return `<div class="slot-modal-loading"><div class="loading-spinner-small"></div> Loading…</div>`;
        return smRenderPanel(d) + `
          <div class="sm-footer">
            <button class="sm-refresh-btn" onclick="smRefreshAll()">↻ Refresh</button>
          </div>`;
      }
    }

    // ── Load data and render ───────────────────────────────
    async function smLoadAndRender(view) {
      const body = document.getElementById('slotModalBody');

      // Determine what we need to fetch
      const needCurrent = (view === 'current' || view === 'both') && !_smCache['current'];
      const needLast    = (view === 'last'    || view === 'both') && !_smCache['last'];

      if (needCurrent || needLast) {
        body.innerHTML = `<div class="slot-modal-loading"><div class="loading-spinner-small"></div> Loading slot data…</div>`;
        try {
          const fetches = [];
          if (needCurrent) fetches.push(smFetchEpoch(_smNodePubkey, 'current').then(d => { _smCache['current'] = d; }));
          if (needLast)    fetches.push(smFetchEpoch(_smNodePubkey, 'last').then(d    => { _smCache['last']    = d; }));
          await Promise.all(fetches);
        } catch(e) {
          body.innerHTML = `<div class="slot-modal-error">Failed to load slot data.<br><small>${e.message||'RPC error'}</small></div>`;
          return;
        }
      }

      body.innerHTML = smRenderBody(view);
    }

    // ── Pill switch ────────────────────────────────────────
    async function smSwitchEpoch(view) {
      _smEpochView = view;
      ['last','current','both'].forEach(v => {
        document.getElementById('smPill' + v.charAt(0).toUpperCase() + v.slice(1))
          ?.classList.toggle('active', v === view);
      });
      await smLoadAndRender(view);
    }

    // ── Refresh (clear cache, reload current view) ─────────
    async function smRefreshAll() {
      _smCache = {};
      await smLoadAndRender(_smEpochView);
    }

    // ── Open modal ─────────────────────────────────────────
    async function openSlotModal(nodePubkey, name, voteAccount) {
      _smNodePubkey    = nodePubkey;
      _smName          = name;
      _smVoteAccount   = voteAccount;
      _smEpochView     = 'current';
      _smCache         = {};

      // Set header
      const vInfo = allValidators?.find(v => v.nodePubkey === nodePubkey);
      const logoEl = document.getElementById('slotModalLogo');
      if (vInfo?.iconUrl) {
        logoEl.innerHTML = `<img class="slot-modal-logo" src="${safeUrl(vInfo.iconUrl)}" alt=""
          onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<div class=slot-modal-logo-ph>${escAttrJs(escHtml(name.charAt(0).toUpperCase()))}</div>')">`;
      } else {
        logoEl.innerHTML = `<div class="slot-modal-logo-ph">${escHtml(name.charAt(0).toUpperCase())}</div>`;
      }
      document.getElementById('slotModalName').textContent = name;
      document.getElementById('slotModalAddr').textContent = voteAccount.slice(0, 22) + '…';

      // Reset pills to Current
      ['last','current','both'].forEach(v => {
        document.getElementById('smPill' + v.charAt(0).toUpperCase() + v.slice(1))
          ?.classList.toggle('active', v === 'current');
      });
      document.getElementById('slotModalBox').classList.remove('wide');

      document.getElementById('slotModal').classList.add('show');
      document.body.style.overflow = 'hidden';

      await smLoadAndRender('current');
    }

    function closeSlotModal() {
      document.getElementById('slotModal').classList.remove('show');
      document.getElementById('slotModalBox').classList.remove('wide');
      document.body.style.overflow = '';
    }

    // Close on Escape
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeSlotModal(); if (typeof closeDelegationModal === 'function') closeDelegationModal(); }
    });

    init();
