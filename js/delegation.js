    // ═══════════════════════════════════════════════════════
    // DELEGATION PROGRAM — eligibility checker + tab
    // Data: data/delegation.json, written hourly by
    // scripts/build-delegation-snapshot.js from the X1 Foundation's own
    // delegation API (api.delegation.mainnet.x1.xyz — the feed behind
    // delegation.x1.xyz). Status and failingCriteria come straight from
    // the Foundation; this module only adds the numbers next to each
    // criterion so an operator can see how far they are from passing.
    // ═══════════════════════════════════════════════════════
    (function () {
      const URL_ = 'data/delegation.json';
      const MAX_AGE_MS = 6 * 3600000;          // warn (not hide) when older than 6h
      const PORTAL = 'https://delegation.x1.xyz/';
      let _doc = null, _loading = null, _err = null;
      let _filter = 'all', _query = '', _sortKey = 'ds', _sortDir = -1;

      const esc  = s => String(s ?? '').replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));
      const xnt  = (lamports, d = 0) => (Number(lamports || 0) / 1e9).toLocaleString('en-US', { maximumFractionDigits: d });
      const pct  = (n, d = 1) => (n == null || isNaN(n)) ? '—' : Number(n).toFixed(d) + '%';
      const short = pk => pk ? pk.slice(0, 4) + '…' + pk.slice(-4) : '';
      const fmtTime = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; };

      function semver(v) {
        const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
        return m ? [+m[1], +m[2], +m[3]] : null;
      }
      function semverGte(a, b) {
        const x = semver(a), y = semver(b);
        if (!x || !y) return false;
        for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
        return true;
      }

      async function load(force) {
        if (_doc && !force) return _doc;
        if (_loading) return _loading;
        _loading = (async () => {
          try {
            const r = await fetch(URL_ + '?t=' + Math.floor(Date.now() / 300000), { cache: 'no-cache' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const d = await r.json();
            if (!d || d.version !== 1 || !d.validators) throw new Error('unexpected format');
            _doc = d; _err = null;
            window.delegationConfig = d.config;
            if (typeof renderVersionStrip === 'function') renderVersionStrip();
            return d;
          } catch (e) {
            _err = e; console.warn('[delegation] snapshot unavailable:', e.message);
            throw e;
          } finally { _loading = null; }
        })();
        return _loading;
      }

      // ── Evaluate one validator against the criteria ────────────────
      // Returns { status, statusClass, statusText, rows[], delegated, strikes }
      function evaluate(vote) {
        const d = _doc; if (!d) return null;
        const e = d.validators[vote];
        const c = d.config || {}, cl = d.cluster || {};
        if (!e) return { status: 'none', statusClass: 'na', statusText: 'Not participating', rows: [], delegated: 0 };

        const fc = new Set(e.fc || []);
        const rows = [];
        const add = (key, ok, label, value, hint) => rows.push({ key, ok, label, value, hint });

        // Active (not delinquent)
        add('delinquent', !fc.has('delinquent') && !e.dq, 'Active validator',
            e.dq ? 'delinquent' : (fc.has('delinquent') ? 'delinquent recently' : 'voting'),
            e.dq ? 'Delinquent validators are removed immediately.' : (fc.has('delinquent') ? 'Flagged delinquent by the Foundation in a recent check' : ''));

        // Self-stake
        const minSelf = Number(c.minSelfStake || 0), self = Number(e.ss || 0);
        const selfOk = !fc.has('minSelfStake') && self >= minSelf;
        add('minSelfStake', selfOk, 'Self-stake ≥ ' + xnt(minSelf) + ' XNT', xnt(self) + ' XNT',
            selfOk ? '' : 'Short by ' + xnt(minSelf - self) + ' XNT');

        // Commission
        const cmOk = e.cm == null ? null : (!fc.has('maxCommission') && e.cm <= Number(c.maxCommissionPercent));
        add('maxCommission', cmOk, 'Commission ≤ ' + c.maxCommissionPercent + '%', e.cm == null ? '—' : e.cm + '%',
            cmOk === false ? 'Lower commission to ' + c.maxCommissionPercent + '% or below' : '');

        // Vote credits vs network average
        let vcOk = null, vcVal = '—', vcHint = '';
        if (e.vc != null && cl.avgVoteCreditsPct) {
          const ratio = (e.vc / cl.avgVoteCreditsPct) * 100;
          vcOk = !fc.has('minVoteCredits') && ratio >= Number(c.voteCreditsThresholdPct);
          vcVal = ratio.toFixed(0) + '% of network avg';
          if (!vcOk) vcHint = ratio >= Number(c.voteCreditsThresholdPct)
            ? 'Flagged by the Foundation over recent epochs (latest epoch ' + e.ep + ' shown)'
            : 'Need ≥ ' + c.voteCreditsThresholdPct + '% — credits at ' + pct(e.vc) + ' of max vs network ' + pct(cl.avgVoteCreditsPct) + ' (epoch ' + e.ep + ')';
        } else if (fc.has('minVoteCredits')) { vcOk = false; vcHint = 'Below the ' + c.voteCreditsThresholdPct + '% threshold'; }
        add('minVoteCredits', vcOk, 'Vote credits ≥ ' + c.voteCreditsThresholdPct + '% of avg', vcVal, vcHint);

        // Skip rate vs network average + tolerance
        let skOk = null, skVal = '—', skHint = '';
        if (e.sk != null && cl.skipRatePct != null) {
          const limit = Number(cl.skipRatePct) + Number(c.skipRateTolerancePct || 0);
          skOk = !fc.has('maxSkipRate') && e.sk <= limit;
          skVal = pct(e.sk, 2) + (e.ls ? ' · ' + e.ls + ' slots' : '');
          if (!skOk) skHint = e.sk <= limit
            ? 'Flagged by the Foundation over recent epochs (latest epoch ' + e.ep + ' shown)'
            : 'Limit ' + pct(limit, 2) + ' (network ' + pct(cl.skipRatePct, 2) + ' + ' + c.skipRateTolerancePct + ' pts), epoch ' + e.ep;
        } else if (fc.has('maxSkipRate')) { skOk = false; skHint = 'Above the network average + ' + c.skipRateTolerancePct + ' pts'; }
        add('maxSkipRate', skOk, 'Skip rate ≤ avg + ' + c.skipRateTolerancePct + ' pts', skVal, skHint);

        // Version
        const noVer = fc.has('noVersionInfo') || !semver(e.ver);
        const verOk = !noVer && !fc.has('minValidatorVersion') && semverGte(e.ver, c.minValidatorVersion);
        add('minValidatorVersion', verOk, 'Tachyon ≥ ' + c.minValidatorVersion, noVer ? 'unknown' : 'v' + e.ver,
            verOk ? '' : (noVer ? 'No version reported in gossip' : 'Upgrade to ' + c.minValidatorVersion + ' or newer'));

        // Total stake caps
        const maxTotal = Number(c.maxTotalStake || 0), as = Number(e.as || 0);
        const capOk = (maxTotal ? as <= maxTotal : true) && (e.np == null || c.maxValidatorStakePct == null || e.np <= Number(c.maxValidatorStakePct));
        add('maxStake', capOk, 'Total stake ≤ ' + xnt(maxTotal) + ' XNT · ≤ ' + c.maxValidatorStakePct + '% of network',
            xnt(as) + ' XNT · ' + (e.np == null ? '—' : e.np.toFixed(3) + '%'), capOk ? '' : 'Over the stake cap — delegation is reduced');

        const failing = rows.filter(r => r.ok === false).length;
        const delegated = Number(e.ds || 0), transient = Number(e.tr || 0);
        let status, statusClass, statusText;
        if (e.st === 'Rejected') { status = 'rejected'; statusClass = 'bad'; statusText = 'Rejected'; }
        else if (fc.size > 0 || failing > 0) {
          // The Foundation's list can stop at the first failure (a validator
          // with 2 XNT self-stake is flagged only for minSelfStake even when
          // it is also delinquent); count what the checklist below shows so
          // the headline never contradicts the rows.
          const nFail = Math.max(fc.size, failing);
          status = 'failing'; statusClass = 'warn'; statusText = 'Not meeting ' + nFail + ' criteri' + (nFail === 1 ? 'on' : 'a');
        }
        else if (delegated > 0) { status = 'delegated'; statusClass = 'ok'; statusText = 'Approved · receiving stake'; }
        else { status = 'approved'; statusClass = 'ok'; statusText = 'Approved · awaiting delegation'; }
        return { entry: e, status, statusClass, statusText, rows, delegated, transient, strikes: e.rs || 0, multiplier: e.mb };
      }

      // ── Card section ──────────────────────────────────────────────
      function renderCard(el) {
        const vote = el.dataset.vote; if (!vote) return;
        const valueEl = el.querySelector('.stat-value'), subEl = el.querySelector('.stat-subtext');
        if (!valueEl || !subEl) return;
        if (!_doc) {
          valueEl.textContent = _err ? 'n/a' : '…'; valueEl.style.color = 'var(--text-dim)';
          subEl.textContent = _err ? 'status unavailable' : 'Program';
          return;
        }
        const r = evaluate(vote);
        const details = '<span class="rb-open-link" data-action="delegation-details" data-vote="' + esc(vote) + '">Details</span>';
        let value, color, sub;
        if (r.status === 'none')          { value = '—';            color = 'var(--text-dim)'; sub = 'Not enrolled'; }
        else if (r.status === 'rejected') { value = 'Rejected';     color = 'var(--danger)';   sub = Math.max((r.entry.fc || []).length, 1) + ' unmet'; }
        else if (r.status === 'failing')  { const n = Math.max((r.entry.fc || []).length, r.rows.filter(x => x.ok === false).length); value = 'Failing'; color = 'var(--warning)'; sub = n + ' criteri' + (n === 1 ? 'on' : 'a') + ' unmet'; }
        else if (r.delegated > 0)         { value = xnt(r.delegated); color = 'var(--success)'; sub = 'XNT · Approved'; }
        else                              { value = 'Approved';     color = 'var(--success)';   sub = 'awaiting delegation'; }
        valueEl.textContent = value; valueEl.style.color = color;
        valueEl.style.fontSize = (value.length > 9 && !/^[\d,]+$/.test(value)) ? '1.05rem' : '';
        // Idempotent: renderCard can run twice (observer + post-load hydrate),
        // so replace the whole sub-row if one already exists.
        const rowHtml = '<div class="stat-sub-row"><span class="stat-subtext">' + esc(sub) + '</span>' + (r.status === 'none' ? '<a class="rb-open-link" href="' + PORTAL + '" target="_blank" rel="noopener noreferrer" data-action="stop">Enrol ↗</a>' : details) + '</div>';
        const existingRow = el.querySelector('.stat-sub-row');
        if (existingRow) existingRow.outerHTML = rowHtml; else subEl.outerHTML = rowHtml;
      }

      function closeDelegationModalImpl() {
        const m = document.getElementById('delegationModal'); if (m) m.style.display = 'none';
      }

      async function openDelegationModalImpl(vote) {
        const m = document.getElementById('delegationModal'), body = document.getElementById('delegationModalBody');
        if (!m || !body) return;
        m.style.display = 'flex';
        body.innerHTML = '<div class="rb-loading"><div class="loading-spinner-small"></div><span>Loading official status…</span></div>';
        try { await load(); } catch (e) {}
        if (!_doc) { body.innerHTML = '<div class="dm-empty">The delegation snapshot is not available right now. <a href="' + PORTAL + '" target="_blank" rel="noopener noreferrer" style="color:var(--accent-cyan)">Open the Foundation portal ↗</a></div>'; return; }
        const r = evaluate(vote);
        const name = (r.entry && r.entry.name) || (typeof allValidators !== 'undefined' && (allValidators.find(v => v.votePubkey === vote) || {}).name) || short(vote);
        const sub = document.getElementById('delegationModalSub'); if (sub) sub.textContent = name;
        const stale = Date.now() - Date.parse(_doc.generatedAt) > MAX_AGE_MS;
        const foot = '<div class="dm-foot">Status and failing criteria are the X1 Foundation\'s own, read from its delegation API and refreshed hourly (updated ' + esc(fmtTime(_doc.generatedAt)) + (stale ? ', <span style="color:var(--warning)">may be stale</span>' : '') + '). ' +
          'Criteria are re-checked every epoch; a validator that stops meeting them loses its delegation immediately. <a href="' + PORTAL + '" target="_blank" rel="noopener noreferrer">Foundation portal ↗</a></div>';
        if (r.status === 'none') {
          body.innerHTML = '<div class="dm-head"><span class="deleg-status na">Not enrolled</span></div>' +
            '<div class="dm-empty">This validator is not enrolled in the X1 Foundation delegation program. Operators enrol on the portal; validators that meet the criteria below receive foundation stake.</div>' +
            renderCriteriaSummary() + foot;
          return;
        }
        const rows = r.rows.map(row => {
          const cls = row.ok === false ? 'bad' : (row.ok === true ? 'ok' : 'na');
          const ic = row.ok === false ? '✗' : (row.ok === true ? '✓' : '·');
          return '<div class="dm-row ' + cls + '"><span class="ic">' + ic + '</span><span class="lbl">' + esc(row.label) + '</span><span class="val">' + esc(row.value) + '</span>' +
                 (row.ok === false && row.hint ? '<span class="hint">' + esc(row.hint) + '</span>' : '') + '</div>';
        }).join('');
        const amount = r.delegated > 0
          ? '<span class="dm-amount">' + xnt(r.delegated) + '<small>XNT delegated' + (r.transient > 0 ? ' · ' + xnt(r.transient) + ' in transit' : '') + '</small></span>'
          : '<span class="dm-amount" style="color:var(--text-secondary);font-size:0.85rem">No foundation stake delegated</span>';
        const strikes = r.strikes > 0
          ? '<div class="dm-strikes">⚠ ' + r.strikes + ' removal strike' + (r.strikes === 1 ? '' : 's') + (r.multiplier != null ? ' · stake multiplier ' + (r.multiplier / 100).toFixed(0) + '%' : '') + ' · decays over ' + (_doc.config.strikeDecayEpochs || '?') + ' epochs</div>'
          : '';
        body.innerHTML = '<div class="dm-head">' + amount + '<span class="deleg-status ' + r.statusClass + '">' + esc(r.statusText) + '</span></div>' +
          '<div class="dm-rows">' + rows + '</div>' + strikes + foot;
      }

      function renderCriteriaSummary() {
        const c = _doc.config || {}, cl = _doc.cluster || {};
        const items = [
          ['Self-stake', '≥ ' + xnt(c.minSelfStake) + ' XNT'], ['Commission', '≤ ' + c.maxCommissionPercent + '%'],
          ['Vote credits', '≥ ' + c.voteCreditsThresholdPct + '% of network avg'], ['Skip rate', '≤ network avg + ' + c.skipRateTolerancePct + ' pts'],
          ['Tachyon version', '≥ v' + c.minValidatorVersion], ['Total stake', '≤ ' + xnt(c.maxTotalStake) + ' XNT · ≤ ' + c.maxValidatorStakePct + '% of network'], ['Status', 'not delinquent'],
        ];
        return '<div class="dm-rows">' + items.map(([l, v]) => '<div class="dm-row na"><span class="ic">·</span><span class="lbl">' + esc(l) + '</span><span class="val">' + esc(v) + '</span></div>').join('') + '</div>';
      }

      function hydrateAll(root) {
        (root || document).querySelectorAll('.deleg-section').forEach(renderCard);
        renderPortfolioSummary();
      }

      // My Data Center summary tile: total foundation stake across the
      // portfolio, how many are approved, and who is failing.
      function renderPortfolioSummary() {
        const valueEl = document.getElementById('portfolioDelegationValue');
        const labelEl = document.getElementById('portfolioDelegationLabel');
        if (!valueEl || !labelEl) return;
        const votes = (typeof myPortfolio !== 'undefined' && Array.isArray(myPortfolio)) ? myPortfolio : [];
        if (!_doc || !votes.length) { valueEl.textContent = _err ? 'n/a' : (votes.length ? '…' : '—'); valueEl.style.color = 'var(--text-dim)'; labelEl.textContent = 'Foundation Delegation'; return; }
        let total = 0, approved = 0, enrolled = 0; const failing = [];
        for (const v of votes) {
          const r = evaluate(v); if (!r || r.status === 'none') continue;
          enrolled++;
          total += r.delegated || 0;
          if (r.status === 'approved' || r.status === 'delegated') approved++;
          else failing.push((r.entry && r.entry.name) || short(v));
        }
        const compact = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n));
        valueEl.textContent = total > 0 ? compact(total / 1e9) : (enrolled ? '0' : '—');
        valueEl.style.color = total > 0 ? 'var(--success)' : 'var(--text-secondary)';
        const parts = ['XNT delegated'];
        if (enrolled) parts.push(approved + '/' + enrolled + ' approved');
        if (failing.length) parts.push('<span class="warn" title="' + esc(failing.join(', ')) + '">' + failing.length + ' failing</span>');
        if (!enrolled) parts.push('none enrolled');
        labelEl.innerHTML = parts.join(' · ');
      }
      window.delegPortfolioSummary = renderPortfolioSummary;
      window.delegFilterMine = () => {
        const b = document.querySelector('#delegFilter button[data-f="mine"]'); if (b) b.click();
      };

      // Cards are rendered by several code paths (lookup, Data Center,
      // compare); watch the DOM instead of hooking each one.
      const mo = new MutationObserver(muts => {
        let found = false;
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches('.deleg-section')) { found = true; renderCard(n); }
          else if (n.querySelector && n.querySelector('.deleg-section')) { found = true; hydrateAll(n); }
        }
        if (found && !_doc && !_loading) load().then(() => hydrateAll()).catch(() => hydrateAll());
      });
      mo.observe(document.body, { childList: true, subtree: true });

      // ── Tab ───────────────────────────────────────────────────────
      const COLS = [
        { key: 'name', label: 'Validator', n: false },
        { key: 'status', label: 'Status', n: false },
        { key: 'fc', label: 'Failing', n: false },
        { key: 'ss', label: 'Self-stake', n: true },
        { key: 'ds', label: 'Delegated', n: true },
        { key: 'vcRatio', label: 'Credits vs avg', n: true },
        { key: 'sk', label: 'Skip', n: true },
        { key: 'cm', label: 'Comm', n: true },
        { key: 'ver', label: 'Version', n: false },
        { key: 'rs', label: 'Strikes', n: true },
      ];
      const FC_LABEL = { minSelfStake: 'self-stake', delinquent: 'delinquent', minValidatorVersion: 'version', minVoteCredits: 'vote credits', maxSkipRate: 'skip rate', noVersionInfo: 'no version', maxCommission: 'commission' };

      function rowsForTable() {
        const d = _doc, cl = d.cluster || {};
        const mine = new Set((typeof myPortfolio !== 'undefined' && Array.isArray(myPortfolio)) ? myPortfolio : []);
        const out = [];
        for (const [vote, e] of Object.entries(d.validators)) {
          const r = evaluate(vote);
          out.push({
            vote, e, r,
            name: e.name || short(vote),
            status: r.status,
            fc: (e.fc || []).map(k => FC_LABEL[k] || k).join(', '),
            ss: Number(e.ss || 0), ds: Number(e.ds || 0),
            vcRatio: (e.vc != null && cl.avgVoteCreditsPct) ? (e.vc / cl.avgVoteCreditsPct) * 100 : -1,
            sk: e.sk == null ? -1 : e.sk, cm: e.cm == null ? -1 : e.cm, ver: e.ver || '', rs: e.rs || 0,
            mine: mine.has(vote),
          });
        }
        return out;
      }

      function renderTab() {
        const tiles = document.getElementById('delegTiles');
        const table = document.getElementById('delegTable');
        const note  = document.getElementById('delegNote');
        if (!tiles || !table) return;
        if (!_doc) {
          tiles.innerHTML = '';
          table.innerHTML = '<div class="deleg-empty">' + (_err ? 'Delegation data is not available right now (' + esc(_err.message) + '). <a href="' + PORTAL + '" target="_blank" rel="noopener noreferrer" style="color:var(--accent-cyan)">Open the Foundation portal ↗</a>' : 'Loading delegation data…') + '</div>';
          return;
        }
        const c = _doc.config, cl = _doc.cluster || {}, k = _doc.counts || {};
        tiles.innerHTML =
          '<div class="deleg-tile"><div class="v">' + xnt(c.minSelfStake) + ' XNT</div><div class="k">Min self-stake</div></div>' +
          '<div class="deleg-tile"><div class="v">≤ ' + c.maxCommissionPercent + '%</div><div class="k">Max commission</div></div>' +
          '<div class="deleg-tile"><div class="v">≥ ' + c.voteCreditsThresholdPct + '%</div><div class="k">Vote credits vs network avg</div></div>' +
          '<div class="deleg-tile"><div class="v">avg + ' + c.skipRateTolerancePct + ' pts</div><div class="k">Max skip rate (avg ' + pct(cl.skipRatePct, 2) + ')</div></div>' +
          '<div class="deleg-tile"><div class="v">v' + esc(c.minValidatorVersion) + '</div><div class="k">Min Tachyon version</div></div>' +
          '<div class="deleg-tile"><div class="v">' + xnt(c.maxTotalStake) + '</div><div class="k">Max total stake (XNT) · ' + c.maxValidatorStakePct + '% of network</div></div>' +
          '<div class="deleg-tile count ok"><div class="v">' + (k.approved ?? '—') + '</div><div class="k">Approved</div></div>' +
          '<div class="deleg-tile count warn"><div class="v">' + (k.notMeetingCriteria ?? '—') + '</div><div class="k">Failing ≥ 1 criterion</div></div>' +
          '<div class="deleg-tile count bad"><div class="v">' + (k.rejected ?? '—') + '</div><div class="k">Rejected</div></div>' +
          '<div class="deleg-tile count"><div class="v">' + (k.activeDelegations ?? '—') + '</div><div class="k">Receiving foundation stake</div></div>';

        let rows = rowsForTable();
        const q = _query.trim().toLowerCase();
        if (q) rows = rows.filter(r => (r.e.name || '').toLowerCase().includes(q) || r.vote.toLowerCase().includes(q) || (r.e.id || '').toLowerCase().includes(q));
        if (_filter === 'approved')  rows = rows.filter(r => r.status === 'approved' || r.status === 'delegated');
        if (_filter === 'delegated') rows = rows.filter(r => r.ds > 0);
        if (_filter === 'failing')   rows = rows.filter(r => r.status === 'failing');
        if (_filter === 'rejected')  rows = rows.filter(r => r.status === 'rejected');
        if (_filter === 'mine')      rows = rows.filter(r => r.mine);
        const col = COLS.find(x => x.key === _sortKey) || COLS[4];
        rows.sort((a, b) => {
          const x = a[col.key], y = b[col.key];
          const cmp = col.n ? (x - y) : String(x).localeCompare(String(y));
          return cmp * _sortDir || (b.ds - a.ds);
        });

        const head = '<tr>' + COLS.map(cn => '<th class="' + (cn.n ? 'n ' : '') + (cn.key === _sortKey ? 'sorted' : '') + '" data-k="' + cn.key + '">' + esc(cn.label) + (cn.key === _sortKey ? (_sortDir < 0 ? ' ▼' : ' ▲') : '') + '</th>').join('') + '</tr>';
        const body = rows.length ? rows.map(r => {
          const st = r.r;
          return '<tr class="' + (r.mine ? 'mine' : '') + '">' +
            '<td class="name" data-vote="' + esc(r.vote) + '" title="Open in Validator Lookup">' + esc(r.name) + '<small>' + esc(short(r.vote)) + '</small>' + (r.mine ? ' <span class="vt-tag-x1" style="font-size:8px">MINE</span>' : '') + '</td>' +
            '<td><span class="deleg-status ' + st.statusClass + '" style="font-size:0.72rem">' + esc(st.statusText.replace(' · awaiting delegation', '').replace(' · receiving stake', '')) + '</span></td>' +
            '<td class="fc ' + (r.fc ? '' : 'none') + '">' + (r.fc ? esc(r.fc) : '—') + '</td>' +
            '<td class="n">' + xnt(r.ss) + '</td>' +
            '<td class="n">' + (r.ds > 0 ? xnt(r.ds) : '<span style="color:var(--text-dim)">—</span>') + '</td>' +
            '<td class="n">' + (r.vcRatio >= 0 ? r.vcRatio.toFixed(0) + '%' : '—') + '</td>' +
            '<td class="n">' + (r.sk >= 0 ? pct(r.sk, 2) : '—') + '</td>' +
            '<td class="n">' + (r.cm >= 0 ? r.cm + '%' : '—') + '</td>' +
            '<td>' + esc(r.ver || '?') + '</td>' +
            '<td class="n">' + (r.rs ? '<span style="color:var(--warning)">' + r.rs + '</span>' : '0') + '</td>' +
          '</tr>';
        }).join('') : '<tr><td colspan="' + COLS.length + '"><div class="deleg-empty">No validators match.</div></td></tr>';
        table.innerHTML = '<div class="deleg-tbl-wrap"><table class="deleg-tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';

        const stale = Date.now() - Date.parse(_doc.generatedAt) > MAX_AGE_MS;
        note.innerHTML = rows.length + ' of ' + _doc.validatorCount + ' enrolled validators shown · ' + (k.notParticipating ?? '?') + ' validators are not enrolled. ' +
          'Status and failing criteria are the X1 Foundation\'s own, read from its delegation API and refreshed hourly (last ' + esc(fmtTime(_doc.generatedAt)) + (stale ? ', <span style="color:var(--warning)">may be stale</span>' : '') + '). ' +
          'Criteria are re-checked every epoch; a validator that stops meeting them loses its delegation immediately and collects a removal strike (−' + ((c.strikePenaltyBps || 0) / 100) + '% stake multiplier per strike, decaying over ' + (c.strikeDecayEpochs || '?') + ' epochs). ' +
          '<a href="' + PORTAL + '" target="_blank" rel="noopener noreferrer">Foundation portal ↗</a>';
      }

      function wireTab() {
        const f = document.getElementById('delegFilter');
        const s = document.getElementById('delegSearch');
        const t = document.getElementById('delegTable');
        if (!f || f.dataset.wired) return;
        f.dataset.wired = '1';
        f.addEventListener('click', e => {
          const b = e.target.closest('button[data-f]'); if (!b) return;
          _filter = b.dataset.f;
          f.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
          renderTab();
        });
        let deb = null;
        s.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => { _query = s.value; renderTab(); }, 120); });
        t.addEventListener('click', e => {
          const th = e.target.closest('th[data-k]');
          if (th) { const k = th.dataset.k; if (_sortKey === k) _sortDir = -_sortDir; else { _sortKey = k; _sortDir = COLS.find(c => c.key === k).n ? -1 : 1; } renderTab(); return; }
          const td = e.target.closest('td.name[data-vote]');
          if (td && typeof window.lookupValidator === 'function') { window.switchTab('lookup'); window.lookupValidator(td.dataset.vote); }
        });
      }

      async function open() {
        wireTab();
        renderTab();
        try { await load(); } catch (e) { /* renderTab shows the error */ }
        renderTab();
      }

      window.delegOpen = open;
      window.delegRefresh = () => load(true).then(() => { hydrateAll(); renderTab(); });
      window.delegEvaluate = evaluate;   // for other modules (fleet board later)
      window.openDelegationModal = openDelegationModalImpl;
      Actions.register({
        'delegation-details': (el, e, d) => { e.stopPropagation(); openDelegationModalImpl(d.vote); },
      });
      window.closeDelegationModal = closeDelegationModalImpl;

      // Pre-warm so card sections render on first lookup without a wait.
      setTimeout(() => load().then(() => hydrateAll()).catch(() => {}), 2500);
    })();
