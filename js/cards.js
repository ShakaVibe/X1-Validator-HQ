    // Inline line icons for the validator card (16/24 grid, stroke-based, recolor via currentColor).
    const CARD_ICONS = {
      star:     '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 6.6 7.1.7-5.3 4.8 1.6 7L12 17.5 5.7 21l1.6-7L2 9.3l7.1-.7z"></path></svg>',
      share:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"></path><path d="m16 6-4-4-4 4"></path><path d="M12 2v13"></path></svg>',
      check:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4 10-10"></path></svg>',
      plus:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>',
      sliders:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h10M18 18h2"></path><circle cx="16" cy="6" r="2"></circle><circle cx="8" cy="12" r="2"></circle><circle cx="16" cy="18" r="2"></circle></svg>',
      clock:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>',
      search:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>',
      arrow:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>',
      chevron:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>',
    };

    function getTierBadge(rank, totalValidators) {
      if (!rank || !totalValidators) return '';
      
      const percentile = (rank / totalValidators) * 100;
      
      if (percentile <= 10) {
        return '<span class="tier-badge elite" title="This validator ranks in the top 10% by total stake">' + CARD_ICONS.star + 'Top 10%</span>';
      } else if (percentile <= 20) {
        return '<span class="tier-badge excellent" title="This validator ranks in the top 20% by total stake">' + CARD_ICONS.star + 'Top 20%</span>';
      } else if (percentile <= 30) {
        return '<span class="tier-badge great" title="This validator ranks in the top 30% by total stake">' + CARD_ICONS.star + 'Top 30%</span>';
      }
      
      return '';
    }

    function renderValidatorCard(validator, showAddBtn = true, showRemoveBtn = false) {
      // Use cached performance score if available, otherwise calculate
      const perfScore = validator.performanceScore !== undefined ? validator.performanceScore : calculatePerformanceScore(validator);
      const perfColor = getPerformanceColor(perfScore);
      const perfBarColor = getPerformanceBarColor(perfScore);
      const perfTooltip = getPerformanceTooltipHtml(validator);
      
      // Current epoch skip rate
      const currentSkipRate = validator.skipRate;
      
      // Historical skip rate data (from RPC, not localStorage)
      const skipHistory = validator.skipRateHistory;
      const lastEpochSkipRate = skipHistory ? skipHistory.lastEpochSkipRate : null;
      const avgSkipRate = skipHistory ? skipHistory.avgSkipRate : null;
      
      // Build skip rate display - show 7-epoch average as main value
      let skipRateDisplay, skipLabel, skipColor;
      
      if (avgSkipRate !== null && avgSkipRate !== undefined) {
        // Show actual epoch count in the average label
        const epochCount = skipHistory.epochCount || skipHistory.epochs?.length || '?';
        skipRateDisplay = formatNumber(avgSkipRate, 2) + '%';
        skipColor = getSkipRateColor(avgSkipRate);
        skipLabel = `${epochCount}-epoch average`;
      } else if (currentSkipRate !== null && currentSkipRate !== undefined) {
        // Fallback to current epoch if no history
        skipRateDisplay = formatNumber(currentSkipRate, 2) + '%';
        skipColor = getSkipRateColor(currentSkipRate);
        skipLabel = 'This epoch only';
      } else if (lastEpochSkipRate !== null) {
        // No current epoch data, but have last epoch
        skipRateDisplay = formatNumber(lastEpochSkipRate, 2) + '%';
        skipColor = getSkipRateColor(lastEpochSkipRate);
        skipLabel = 'Last epoch only';
      } else {
        // No data at all
        skipRateDisplay = 'Awaiting';
        skipColor = '';
        skipLabel = 'No slots yet';
      }
      
      const isInPortfolio = myPortfolio.includes(validator.voteAccount);
      
      // Record performance snapshot for history tracking
      recordPerformanceSnapshot(validator);

      let actionBtn = '';
      if (showRemoveBtn) {
        actionBtn = `<button class="remove-btn" onclick="removeFromPortfolio('${validator.voteAccount}')">Remove</button>`;
      } else if (showAddBtn && !isInPortfolio) {
        actionBtn = `<button class="add-btn" data-add-vote="${validator.voteAccount}" onclick="addToPortfolio('${validator.voteAccount}')">${CARD_ICONS.plus}Add to Data Center</button>`;
      } else if (showAddBtn && isInPortfolio) {
        actionBtn = `<button class="add-btn is-added" disabled>${CARD_ICONS.check}In Data Center</button>`;
      }

      // Generate logo or placeholder
      const firstLetter = escHtml(validator.name.charAt(0).toUpperCase());
      const logoHtml = validator.iconUrl 
        ? `<img class="validator-logo" src="${safeUrl(validator.iconUrl)}" alt="${escHtml(validator.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
           <div class="validator-logo-placeholder" style="display:none;">${firstLetter}</div>`
        : `<div class="validator-logo-placeholder">${firstLetter}</div>`;

      // Version badge with update warning if outdated
      let versionHtml = '';
      if (validator.version) {
        const outdated = isVersionOutdated(validator.version);
        if (outdated) {
          versionHtml = `<span class="version-badge outdated">v${escHtml(validator.version)}</span><span class="version-update-warning" title="Latest version in use: v${escHtml(window.latestValidatorVersion)}${window.versionStats ? ' (' + window.versionStats.latestStakePct.toFixed(0) + '% of stake)' : ''}">⚠️ Update to v${escHtml(window.latestValidatorVersion)}</span>`;
        } else {
          versionHtml = `<span class="version-badge">v${escHtml(validator.version)}</span>`;
        }
      }

      // Unique ID for chart. Lookup and My Data Center can both hold a card for
      // the same validator, so the id also carries the card's context — otherwise
      // getElementById() (and chartInstances / chartDataStore) hit the other card.
      const chartId = 'chart-' + (showRemoveBtn ? 'dc-' : 'lk-') + validator.voteAccount.slice(0, 8);

      // Get chart data - prefer XNT rewards from API, fallback to epoch credits
      let rewardsData = [];
      let epochLabels = [];
      let chartType = 'credits'; // 'xnt' or 'credits'
      
      // Check for XNT rewards history from API
      const xntHistory = getValidatorRewardsHistory(validator.voteAccount);
      if (xntHistory && xntHistory.length > 1) {
        chartType = 'xnt';
        xntHistory.slice(-30).forEach(entry => {
          epochLabels.push(entry.epoch);
          rewardsData.push(entry.earned);
        });
      } else {
        // Fallback to epoch credits
        // Skip the current (most recent) epoch as it will always show 0 until finalized
        const epochCreditsHistory = validator.epochCreditsHistory || [];
        if (epochCreditsHistory.length > 2) {
          for (let i = 1; i < Math.min(epochCreditsHistory.length, 31); i++) {
            const entry = epochCreditsHistory[epochCreditsHistory.length - 1 - i];
            if (entry && entry.length >= 3) {
              const creditsEarned = entry[1] - entry[2];
              rewardsData.unshift(creditsEarned);
              epochLabels.unshift(entry[0]);
            }
          }
        }
      }

      // Store chart data globally for initialization
      if (!window.chartDataStore) window.chartDataStore = {};
      window.chartDataStore[chartId] = {
        labels: epochLabels,
        data: rewardsData,
        name: validator.name,
        type: chartType,
        voteAccount: validator.voteAccount,
        commission: validator.commission
      };

      // Credit pace score: how well is validator earning vs network average, adjusted for epoch progress
      let credPctHtml = '';
      const credHistory = validator.epochCreditsHistory || [];
      if (window.networkFullEpochCredits && window.epochProgressRatio && credHistory.length >= 1) {
        const latestEntry = credHistory[credHistory.length - 1];
        if (latestEntry && latestEntry.length >= 3) {
          const epochEarned = latestEntry[1] - latestEntry[2];
          const expectedSoFar = window.networkFullEpochCredits * window.epochProgressRatio;
          const paceScore = expectedSoFar > 0 ? (epochEarned / expectedSoFar) * 100 : null;

          if (paceScore !== null) {
            const onTrack = paceScore >= 92;
            const pctColor = onTrack ? 'var(--success)' : 'var(--danger)';
            const statusIcon = onTrack ? '✅' : '⚠️';
            const statusText = onTrack ? 'ON TRACK' : 'AT RISK';
            const tooltipId = 'credTip-' + validator.voteAccount.slice(0,8);

            const tooltipHtml = `
              <div class="cred-tooltip" id="${tooltipId}">
                <div class="cred-tooltip-title">Credit Pace Score</div>
                <div class="cred-tooltip-row">
                  <span class="cred-tooltip-label">Earned this epoch</span>
                  <span class="cred-tooltip-val">${epochEarned.toLocaleString()}</span>
                </div>
                <div class="cred-tooltip-row">
                  <span class="cred-tooltip-label">Avg validator earned so far</span>
                  <span class="cred-tooltip-val">${Math.round(expectedSoFar).toLocaleString()}</span>
                </div>
                <div class="cred-tooltip-row">
                  <span class="cred-tooltip-label">Network avg / epoch</span>
                  <span class="cred-tooltip-val">${Math.round(window.networkFullEpochCredits).toLocaleString()}</span>
                </div>
                <div class="cred-tooltip-divider"></div>
                <div class="cred-tooltip-row">
                  <span class="cred-tooltip-label">Pace score</span>
                  <span class="cred-tooltip-val" style="color:${pctColor};font-weight:700">${paceScore.toFixed(1)}%</span>
                </div>
                <div class="cred-tooltip-row">
                  <span class="cred-tooltip-label">Requirement</span>
                  <span class="cred-tooltip-val">≥ 92% of avg</span>
                </div>
                <div class="cred-tooltip-status" style="color:${pctColor}">${statusIcon} ${statusText}</div>
                <div class="cred-tooltip-note">Compares your credits earned so far vs where the network average would be at ${(window.epochProgressRatio*100).toFixed(1)}% epoch progress</div>
              </div>`.replace(/\n\s*/g, '');

            credPctHtml = `
              <span class="cred-pct-badge" 
                onclick="event.stopPropagation(); toggleCredTooltip('${tooltipId}')"
                style="position:relative;font-size:0.65rem;font-weight:600;color:var(--accent-cyan);line-height:1;cursor:pointer;white-space:nowrap;">
                ${paceScore.toFixed(1)}%
                ${tooltipHtml}
              </span>`;
          }
        }
      }

      // ── Leader band: live "time to next leader slot" + Slot Explorer ──
      // The .vh-next-leader text (and the band's is-leader / is-none state)
      // is updated in place once per second by LeaderCountdown, which reads
      // the shared leaderScheduleCache. The Slot Explorer button opens the
      // same modal the Skip Rate box used to.
      const _vhVa   = validator.voteAccount;
      const _vhNode = validator.nodePubkey || '';
      const leaderBandHtml = _vhNode ? `
          <div class="vh-leader-band">
            <span class="vh-band-icon">${CARD_ICONS.clock}</span>
            <span class="vh-next-leader" data-node="${escHtml(_vhNode)}">…</span>
            <span class="vh-band-note"></span>
            <button class="vh-slot-explorer" onclick="event.stopPropagation(); openSlotModal('${escAttrJs(_vhNode)}', '${escAttrJs(validator.name)}', '${escAttrJs(_vhVa)}')" title="View slot-by-slot leader assignment and block production">${CARD_ICONS.search}Slot explorer${CARD_ICONS.arrow}</button>
          </div>` : '';

      return `
        <div class="validator-card">
          <div class="validator-header">
            <div class="validator-info">
              ${logoHtml}
              <div class="validator-identity">
                <div class="validator-name">
                  ${escHtml(validator.name)}${validator.isZombie ? '' : getTierBadge(validator.rank, validator.totalValidators)}
                  <span class="validator-rank" title="${validator.isZombie ? 'This validator is not in the active set — its activated stake has dropped to zero. It is hidden from the main list by default.' : 'Stake rank: Position among all validators sorted by total stake'}">${validator.isZombie ? 'Unranked' : `#${validator.rank} of ${validator.totalValidators}`}</span>
                </div>
                <div class="validator-meta">
                  <span class="validator-address" title="${escHtml(validator.voteAccount)}">${escHtml(String(validator.voteAccount).slice(0, 8))}…${escHtml(String(validator.voteAccount).slice(-6))}</span>
                  <button class="copy-address-btn" onclick="event.stopPropagation(); copyToClipboard('${validator.voteAccount}', this)" title="Copy address">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                  </button>
                  ${versionHtml}
                  <span class="vh-status ${validator.isDelinquent ? 'is-delinquent' : 'is-active'}"><span class="vh-status-dot"></span>${validator.isDelinquent ? 'Delinquent' : 'Active'}</span>
                </div>
              </div>
            </div>
            <div class="validator-actions">
              <button class="share-icon-btn" onclick="shareValidator('${escAttrJs(validator.voteAccount)}', '${escAttrJs(validator.name)}', this)" title="Copy a link to this validator" aria-label="Share">${CARD_ICONS.share}</button>
              ${actionBtn}
              <button class="manage-validator-btn" onclick="openManageValidator('${escAttrJs(validator.voteAccount)}', '${escAttrJs(validator.name)}', ${Number(validator.rewardsBalance) || 0}, ${Number(validator.commission) || 0}, '${escAttrJs(validator.nodePubkey || '')}', '${escAttrJs(validator.iconUrl || '')}')">
                <span class="mv-icon">${CARD_ICONS.sliders}</span>Manage Validator
              </button>
            </div>
          </div>
          ${leaderBandHtml}
          ${validator.isZombie ? `
          <div style="margin:0.25rem 1rem 1.25rem;padding:0.65rem 0.85rem;background:rgba(255,82,82,0.08);border:1px solid rgba(255,82,82,0.3);border-left:3px solid var(--danger);border-radius:6px;display:flex;gap:0.6rem;align-items:flex-start;font-size:0.82rem;line-height:1.4;color:var(--text-secondary);position:relative;z-index:2;">
            <span style="color:var(--danger);font-size:1rem;line-height:1;flex-shrink:0;margin-top:0.05rem;">⚠</span>
            <div>
              <strong style="color:var(--text-primary);">Outside the active validator set.</strong>
              This vote account is long-delinquent with zero activated stake, so it&rsquo;s hidden from the main network list by default. On-chain it still exists — commission, identity, and withdraw authority can still be managed if you hold the keys.
            </div>
          </div>` : ''}
          
          <div class="stats-grid">
          <div class="stat-group stat-group-earn">
            <div class="stat-group-label">Earnings &amp; stake</div>
            <div class="stat-group-grid">
            <div class="stat-item" title="The validator's accumulated rewards that can be withdrawn.">
              <div class="stat-label">Rewards balance</div>
              <div class="stat-value accent">${formatNumber(validator.rewardsBalance)}</div>
              <div class="stat-subtext">XNT</div>
            </div>
            
            <div class="stat-item" title="What the validator earned in the last completed epoch — its voting commission plus the rewards on its own self-stake. Click Breakdown to see this split by source." id="lastEpoch-${validator.voteAccount.slice(0,8)}">
              <div class="stat-label">Earned last epoch</div>
              <div class="last-epoch-value-row">
                <span class="stat-value" style="color: var(--success);">Loading...</span>
                <span class="stat-change" id="lastEpochChange-${validator.voteAccount.slice(0,8)}"></span>
              </div>
              <div class="stat-sub-row">
                <span class="stat-subtext">XNT</span>
                <span class="rb-open-link" onclick="event.stopPropagation();openRewardBreakdown('${validator.voteAccount}', '${escAttrJs(validator.name)}', ${validator.commission})">Breakdown</span>
              </div>
            </div>
            
            <div class="stat-item clickable-stat" onclick="openStakeSelection('${validator.voteAccount}', '${escAttrJs(validator.name)}')" title="Click to manage your stake classification (self-stake vs delegated)">
              <div class="stat-label">Active stake</div>
              <div class="stat-value">${formatXntCompact(validator.activatedStake)}</div>
              <div class="stat-sub-row">
                <span class="stat-subtext">XNT</span>
                <span style="color: var(--accent-cyan); font-size: 0.65rem;">Classify</span>
              </div>
            </div>
            
            <div class="stat-item deleg-section" data-vote="${escHtml(validator.voteAccount)}" title="X1 Foundation Delegation Program — official status and delegated stake. Click Details for the criteria checklist.">
              <div class="stat-label">Foundation delegation</div>
              <div class="stat-value" style="color: var(--text-dim);">…</div>
              <div class="stat-subtext">Program</div>
            </div>
            
            </div>
          </div>
          <div class="stat-group stat-group-health">
            <div class="stat-group-label">Health</div>
            <div class="stat-group-grid">
            <div class="stat-item epoch-credits-card" style="position:relative;" title="Epoch credits represent the validator's voting activity. More credits generally means better uptime and participation in consensus.">
              <div class="stat-label">Epoch credits</div>
              <div class="stat-value">${formatCompact(validator.epochCredits)}</div>
              <div class="stat-sub-row">
                <span class="stat-subtext">Cumulative</span>
                ${credPctHtml}
              </div>
            </div>
            
            <div class="stat-item" title="Skip rate = % of leader slots where no block was produced. When showing a multi-epoch average, we use the slot-weighted method: (total skipped slots across epochs) / (total leader slots across epochs) — the same method the Solana CLI uses. This avoids small-sample epochs dominating the average.">
              <div class="stat-label">Skip rate</div>
              <div class="stat-value ${skipColor}">${skipRateDisplay}</div>
              <div class="stat-subtext">${skipLabel}</div>
            </div>

            <div class="stat-item" title="Commission is the percentage of staking rewards the validator keeps. The remaining percentage goes to delegators.">
              <div class="stat-label">Commission</div>
              <div class="stat-value">${validator.commission}%</div>
              <div class="stat-subtext">Fee rate</div>
            </div>
            
            <div class="stat-item perf-score-wrapper" onclick="openPerfExplainerModal(event, '${validator.voteAccount}')">
              <div class="stat-label">Performance, 7d <span class="perf-info-icon">?</span></div>
              <div class="stat-value ${perfColor}">${formatNumber(perfScore, 2)}</div>
              <div class="perf-bar-container">
                <div class="perf-bar">
                  <div class="perf-bar-fill" style="width: ${perfScore}%; background: ${perfBarColor};"></div>
                </div>
              </div>
            </div>
            </div>
          </div>
          </div>

          <div class="validator-action-buttons">
            <button class="validator-expand-btn stake-details-btn" onclick="toggleStakeDetails('${validator.voteAccount}', '${escAttrJs(validator.name)}', ${validator.activatedStake}, ${validator.commission}, this)">
              <span>Stake details</span>
              <span class="arrow">${CARD_ICONS.chevron}</span>
            </button>
            <button class="validator-expand-btn" onclick="toggleChart('${chartId}', this)">
              <span>Earnings trend</span>
              <span class="arrow">${CARD_ICONS.chevron}</span>
            </button>
          </div>

          <div class="validator-stake-section" id="stake-${validator.voteAccount}-section">
            <div class="stake-section-loading">
              <div class="loading-spinner-small"></div>
              <span>Analyzing stake accounts...</span>
            </div>
          </div>

          <div class="validator-chart-section" id="${chartId}-section">
            <div class="chart-toggle-container">
              <button class="chart-toggle-btn active" onclick="switchChartType('${chartId}', 'xnt', this)" data-type="xnt">XNT Rewards</button>
              <button class="chart-toggle-btn" onclick="switchChartType('${chartId}', 'credits', this)" data-type="credits">Epoch Credits</button>
            </div>
            <div class="chart-header">
              <div>
                <div class="chart-title" id="${chartId}-title">XNT Rewards Trend</div>
                <div class="chart-subtitle" id="${chartId}-subtitle">Credits earned per epoch (last ${epochLabels.length} epochs)</div>
              </div>
            </div>
            <div class="chart-container">
              <canvas id="${chartId}"></canvas>
            </div>
            <div class="chart-stats" id="${chartId}-stats">
              <div class="chart-stat">
                <div class="chart-stat-value" id="${chartId}-last">${rewardsData.length > 0 ? formatNumber(rewardsData[rewardsData.length - 1], 0) : '--'}</div>
                <div class="chart-stat-label">Last Epoch</div>
              </div>
              <div class="chart-stat">
                <div class="chart-stat-value" id="${chartId}-avg">${rewardsData.length > 0 ? formatNumber(rewardsData.reduce((a, b) => a + b, 0) / rewardsData.length, 0) : '--'}</div>
                <div class="chart-stat-label">Average</div>
              </div>
              <div class="chart-stat">
                <div class="chart-stat-value" id="${chartId}-peak">${rewardsData.length > 0 ? formatNumber(Math.max(...rewardsData), 0) : '--'}</div>
                <div class="chart-stat-label">Peak</div>
              </div>
            </div>
            <div class="chart-loading" id="${chartId}-loading" style="display: none;">
              <div class="loading-spinner-small"></div>
              <span>Loading XNT rewards data...</span>
            </div>
          </div>
        </div>
      `;
    }

    // Search functionality
    //
    // Fires on every keystroke. We *don't* debounce here on purpose —
    // most keystrokes resolve from validatorInfoCache in microseconds,
    // and the original "populates while you type" feel comes from that
    // immediate render. The protections that matter for fast typing
    // happen elsewhere:
    //   • performSearch's request-id race-guard ensures only the latest
    //     search ever renders, so a slow uncached search can't overwrite
    //     a newer result.
    //   • The global RPC throttle (installRpcThrottle) caps concurrent
    //     in-flight requests, so even a flurry of keystrokes against an
    //     empty cache doesn't hammer the endpoint.
    // Base58 excludes 0, O, I, l. A Solana/X1 pubkey is 32–44 of these chars
    // (vote accounts and identities are typically 43–44).
    const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
    function looksLikePubkey(s) {
      return BASE58_RE.test(s) && s.length >= 32 && s.length <= 44;
    }

    function handleSearchInput() {
      clearTimeout(_searchDebounce);
      const input = document.getElementById('searchInput').value.trim();
      if (input.length < 2) return;

      const fullKey = looksLikePubkey(input) && input.length >= 43;
      // A long base58 string that isn't yet a full key is almost certainly an
      // address mid-type/paste. Don't fire a (useless, expensive) name search
      // on a partial key — wait until it's complete.
      const partialKey = !fullKey && input.length > 20 && BASE58_RE.test(input);
      if (partialKey) return;

      // Full keys resolve immediately; names get a short debounce so we don't
      // launch a fresh search (and a wave of RPC calls) on every keystroke.
      _searchDebounce = setTimeout(performSearch, fullKey ? 0 : 250);
    }

    // Lookup a specific validator (called from leaderboard)
    function lookupValidator(voteAccount) {
      // Clear cache to get fresh data with skip rate
      delete validatorInfoCache[voteAccount];
      
      // Switch to lookup tab
      switchTab('lookup');
      
      // Set the search input
      document.getElementById('searchInput').value = voteAccount;
      
      // Perform the search
      performSearch();
    }

    async function performSearch() {
      const input = document.getElementById('searchInput').value.trim();
      if (!input) return;

      // Race-guard: each invocation gets a unique id. Async work only commits
      // to the DOM if our id is still the latest — a newer search supersedes us.
      const myRequestId = ++_searchRequestId;
      const isStale = () => myRequestId !== _searchRequestId;

      const loading = document.getElementById('loading');
      const results = document.getElementById('resultsSection');
      const error = document.getElementById('errorMessage');
      const container = document.getElementById('validatorResults');

      results.style.display = 'none';
      error.style.display = 'none';
      loading.style.display = 'flex';

      const showError = () => {
        loading.style.display = 'none';
        const noData = !allValidators || allValidators.length === 0;
        error.querySelector('p').textContent = noData
          ? 'Validator data is still loading — please try again in a moment.'
          : 'No validators found. Try searching by name or check the address.';
        error.style.display = 'block';
      };

      try {
        // Ensure the validator list is loaded before scoring / resolving.
        if (!allValidators || allValidators.length === 0) {
          await loadNetworkStats();
          if (isStale()) return;
        }

        const isPubkey = looksLikePubkey(input) && input.length >= 43;

        // ── Address / vote-ID path: resolve vote-OR-identity, fetch one card ──
        if (isPubkey) {
          const voteToFetch = resolveVoteAccount(input);
          const validator = await getValidatorInfo(voteToFetch).catch(() => null);
          if (isStale()) return;
          if (!validator) { showError(); return; }
          destroyCardCharts();
          container.innerHTML = renderValidatorCard(validator, true, false);
          if (typeof Router !== 'undefined') Router.set('/lookup/' + validator.voteAccount);
          document.getElementById('resultCount').textContent = '1';
          document.getElementById('lastUpdated').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
          fetchLastEpochForCards([validator]);
          loading.style.display = 'none';
          results.style.display = 'block';
          return;
        }

        // ── Name path: score against the cached list (no RPC) ──
        let matches = scoreNameMatches(input);

        // No match? The list may be stale (a validator joined since last fetch).
        // Refresh once and retry before giving up.
        const STALE_THRESHOLD_MS = 30 * 1000;
        const cacheAge = Date.now() - (allValidatorsFetchedAt || 0);
        if (matches.length === 0 && cacheAge > STALE_THRESHOLD_MS) {
          await loadNetworkStats();
          if (isStale()) return;
          matches = scoreNameMatches(input);
          if (isStale()) return;
        }

        if (matches.length === 0) { showError(); return; }

        // Single unambiguous match → just show its full card directly.
        if (matches.length === 1) {
          const info = await getValidatorInfo(matches[0].votePubkey).catch(() => null);
          if (isStale()) return;
          if (!info) { showError(); return; }
          destroyCardCharts();
          container.innerHTML = renderValidatorCard(info, true, false);
          if (typeof Router !== 'undefined' && info.voteAccount) Router.set('/lookup/' + info.voteAccount);
          document.getElementById('resultCount').textContent = '1';
          document.getElementById('lastUpdated').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
          fetchLastEpochForCards([info]);
          loading.style.display = 'none';
          results.style.display = 'block';
          return;
        }

        // Multiple matches → show a lightweight, selectable list (all from cached
        // data, zero RPC). The user picks the one they want and ONLY that card is
        // loaded — instead of hydrating dozens of full cards on every search,
        // which was slow and flooded the RPC queue.
        const hint = `<div class="lookup-results-hint">${matches.length} matches — select one to load its full card.</div>`;
        container.innerHTML = hint + matches.map(lookupSlotHtml).join('');
        document.getElementById('resultCount').textContent = matches.length;
        document.getElementById('lastUpdated').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
        loading.style.display = 'none';
        results.style.display = 'block';

      } catch (err) {
        if (isStale()) return; // newer search in flight — drop silently
        console.error(err);
        showError();
      }
    }

    // Score name/pubkey matches against the already-loaded validator list.
    // Returns lightweight allValidators entries (NO RPC) in best-match order so
    // result cards can render instantly and hydrate afterward.
    function scoreNameMatches(input) {
      const searchLower = input.toLowerCase();
      return allValidators
        .map(v => {
          const nameLower = (v.name || '').toLowerCase();
          const voteL = v.votePubkey.toLowerCase();
          const nodeL = v.nodePubkey.toLowerCase();

          let score = 0;
          if (nameLower === searchLower)               score = 100; // exact name match
          else if (nameLower.startsWith(searchLower))  score = 80;  // name prefix match
          else if (nameLower.includes(searchLower))    score = 60;  // partial name match
          else if (voteL.includes(searchLower) ||
                   nodeL.includes(searchLower))         score = 20;  // pubkey substring

          return { v, score };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map(item => item.v);
    }

    // Resolve a pasted key to a vote account, accepting EITHER the vote account
    // or the validator identity (node) address. Falls back to the raw input so
    // getValidatorInfo can still try the chain (active set + zombie) for keys
    // that aren't in the cached list.
    function resolveVoteAccount(key) {
      if (allValidators.some(v => v.votePubkey === key)) return key;
      const byNode = allValidators.find(v => v.nodePubkey === key);
      return byNode ? byNode.votePubkey : key;
    }

    // Compact, selectable result row built purely from cached list data (no RPC).
    // Clicking it hydrates *just that one* validator into a full card, instead of
    // eagerly loading every match.
    function lookupSlotHtml(v) {
      const id = 'lkslot-' + v.votePubkey.slice(0, 8);
      const letter = (v.name || '?').charAt(0).toUpperCase();
      const logo = v.iconUrl
        ? `<img class="validator-logo" src="${safeUrl(v.iconUrl)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"><div class="validator-logo-placeholder" style="display:none;">${letter}</div>`
        : `<div class="validator-logo-placeholder">${letter}</div>`;
      const stake = formatXntCompact(lamportsToXNT(v.activatedStake));
      const status = v.delinquent
        ? ' · <span style="color:var(--danger);">Delinquent</span>'
        : '';
      return `<div id="${id}" class="lookup-slot lookup-slot-selectable" onclick="selectLookupValidator('${v.votePubkey}')" title="Click to view this validator">
        <div class="lookup-slot-main">${logo}
          <div style="min-width:0;">
            <div class="lookup-slot-name">${escHtml(v.name)}<span class="lookup-slot-rank">#${v.rank} of ${v.totalValidators}</span></div>
            <div class="lookup-slot-sub">${stake} XNT · ${v.commission}% commission${status}</div>
          </div>
        </div>
        <div class="lookup-slot-action">View ›</div>
      </div>`;
    }

    // Hydrate a single chosen result row into a full validator card on demand.
    async function selectLookupValidator(votePubkey) {
      const id = 'lkslot-' + votePubkey.slice(0, 8);
      const slot = document.getElementById(id);
      if (!slot || slot.dataset.loading === '1') return;
      slot.dataset.loading = '1';
      slot.classList.remove('lookup-slot-selectable');
      slot.style.cursor = 'default';
      slot.onclick = null;
      const action = slot.querySelector('.lookup-slot-action');
      if (action) action.innerHTML = '<span class="lookup-spin"></span>';
      try {
        const info = await getValidatorInfo(votePubkey);
        if (!slot.isConnected) return; // a newer search replaced the list
        if (!info) { slot.remove(); return; }
        slot.outerHTML = renderValidatorCard(info, true, false);
        fetchLastEpochForCards([info]);
      } catch (err) {
        console.warn('[selectLookupValidator]', votePubkey, err && err.message || err);
        if (!slot.isConnected) return;
        slot.dataset.loading = '';
        slot.classList.add('lookup-slot-selectable');
        slot.style.cursor = 'pointer';
        slot.onclick = () => selectLookupValidator(votePubkey);
        if (action) action.innerHTML = '<span style="color:var(--danger);">Retry ›</span>';
      }
    }

    // Portfolio management
    function savePortfolio() {
      try {
        localStorage.setItem('x1Portfolio', JSON.stringify(myPortfolio));
      } catch (e) {
        // Quota exceeded / Safari private mode — keep the in-memory list working.
        console.warn('[portfolio] could not persist x1Portfolio', e);
        if (typeof showToast === 'function') showToast('Could not save your Data Center list in this browser (storage blocked).');
      }
      updatePortfolioCount();
    }

    function updatePortfolioCount() {
      const countEl = document.getElementById('portfolioCount');
      if (myPortfolio.length > 0) {
        countEl.textContent = `(${myPortfolio.length})`;
      } else {
        countEl.textContent = '';
      }
    }

    function addToPortfolio(voteAccount) {
      if (!myPortfolio.includes(voteAccount)) {
        myPortfolio.push(voteAccount);
        savePortfolio();

        // Flip any visible "+ Add" buttons for this validator to "Added" in
        // place. Re-running performSearch() would collapse a card the user is
        // viewing back to the results list, so we update the button directly.
        document.querySelectorAll('button.add-btn[data-add-vote="' + voteAccount + '"]').forEach(btn => {
          btn.innerHTML = CARD_ICONS.check + 'In Data Center';
          btn.classList.add('is-added');
          btn.disabled = true;
          btn.onclick = null;
        });
      }
    }

    function removeFromPortfolio(voteAccount) {
      myPortfolio = myPortfolio.filter(v => v !== voteAccount);
      savePortfolio();
      loadPortfolio();
    }

    function clearPortfolio() {
      if (confirm('Are you sure you want to remove all validators from your Data Center?')) {
        myPortfolio = [];
        savePortfolio();
        loadPortfolio();
      }
    }

    // Refresh just active-stake / rank / delinquency for all validators from a
    // single getVoteAccounts. `allValidators` is otherwise only built at page
    // load, so after the page has been open a while its stake figures go stale —
    // which showed up as some Data Center cards displaying lower-than-actual
    // active stake until a manual refresh. One cheap call corrects them.
    async function refreshValidatorStakes() {
      try {
        const va = await rpcCall('getVoteAccounts');
        const all = [...(va.current || []), ...(va.delinquent || [])];
        if (!all.length || !allValidators.length) return;
        const stakeMap = new Map(all.map(v => [v.votePubkey, v.activatedStake]));
        const delinquentSet = new Set((va.delinquent || []).map(v => v.votePubkey));
        allValidators.forEach(v => {
          if (stakeMap.has(v.votePubkey)) {
            v.activatedStake = stakeMap.get(v.votePubkey);
            v.delinquent = delinquentSet.has(v.votePubkey);
          }
        });
        allValidators.sort((a, b) => b.activatedStake - a.activatedStake);
        allValidators.forEach((v, i) => { v.rank = i + 1; });
        allValidatorsFetchedAt = Date.now();
      } catch (e) {
        console.warn('[refreshValidatorStakes] failed:', e && e.message || e);
      }
    }

    async function loadPortfolio() {
      const loading = document.getElementById('portfolioLoading');
      const results = document.getElementById('portfolioResults');
      const empty = document.getElementById('emptyPortfolio');

      if (myPortfolio.length === 0) {
        results.style.display = 'none';
        empty.style.display = 'block';
        loading.style.display = 'none';
        return;
      }

      empty.style.display = 'none';
      loading.style.display = 'flex';
      results.style.display = 'none';

      try {
        // Active stake (and rank) come from `allValidators`, which is only built
        // at page load. After the page has been open a while that snapshot goes
        // stale — which showed up as some cards displaying lower-than-actual
        // active stake until a manual refresh. Refresh those figures from a
        // single getVoteAccounts first (skipped if the list was just loaded, so a
        // fresh page load doesn't double-fetch). An empty list needs no refresh —
        // getValidatorInfo fetches fresh per-validator in that case.
        if (allValidators.length > 0 && Date.now() - (allValidatorsFetchedAt || 0) > 30000) {
          await refreshValidatorStakes();
        }

        // Fetch all portfolio validators IN PARALLEL, not sequentially.
        // The previous `for (...) await` loop made each user wait for
        // N × getValidatorInfo() round-trips back-to-back. Promise.all
        // lets them all share the 4-slot RPC queue so typical portfolios
        // load in 2–3 queue-cycles instead of N.
        // .catch per-item so a single broken vote account doesn't reject the batch.
        const settled = await Promise.all(
          myPortfolio.map(voteAccount =>
            getValidatorInfo(voteAccount, true).catch(err => {
              console.warn('[loadPortfolio] skip', voteAccount, err && err.message || err);
              return null;
            })
          )
        );
        const validators = settled.filter(Boolean);

        if (validators.length === 0) {
          empty.style.display = 'block';
          loading.style.display = 'none';
          return;
        }

        // Update summary
        let totalStake = 0;
        let totalRewards = 0;
        let totalPerf = 0;
        let activeCount = 0;

        validators.forEach(v => {
          totalStake += v.activatedStake;
          totalRewards += v.rewardsBalance;
          // Use cached performance score if available
          totalPerf += v.performanceScore !== undefined ? v.performanceScore : calculatePerformanceScore(v);
          if (!v.isDelinquent) activeCount++;
        });

        document.getElementById('totalPortfolioStake').textContent = formatNumber(totalStake);
        document.getElementById('totalPortfolioRewards').textContent = formatNumber(totalRewards);
        document.getElementById('portfolioLastEpochRewards').textContent = 'Loading...';
        const avgPerf = totalPerf / validators.length;
        const avgPerfEl = document.getElementById('avgPortfolioPerf');
        avgPerfEl.textContent = formatNumber(avgPerf, 1);
        avgPerfEl.style.color = getPerformanceBarColor(avgPerf);
        document.getElementById('activePortfolioCount').textContent = `${activeCount}/${validators.length}`;
        if (typeof window.delegPortfolioSummary === 'function') window.delegPortfolioSummary();
        document.getElementById('portfolioResultCount').textContent = validators.length;
        document.getElementById('portfolioUpdated').textContent = 'Last updated: ' + new Date().toLocaleTimeString();

        // Sort validators alphabetically (natural sort for numbers)
        const sortedValidators = [...validators].sort((a, b) => {
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });

        // Store combined chart data (sorted)
        window.combinedChartValidators = sortedValidators;
        
        // Store color mapping for each validator
        window.validatorColorMap = {};
        sortedValidators.forEach((v, index) => {
          window.validatorColorMap[v.voteAccount] = index;
        });

        // Render validator cards (also sorted alphabetically). The old cards'
        // canvases are gone, so drop their Chart instances too — otherwise
        // toggleChart() thinks the chart already exists and leaves the new
        // canvas blank (and the old instance leaks).
        destroyCardCharts();
        document.getElementById('portfolioValidatorResults').innerHTML = sortedValidators.map(v => renderValidatorCard(v, false, true)).join('');

        // Now that the cards exist, fetch each validator's rewards ONCE and
        // stream the result into its card the moment it arrives (and compute the
        // portfolio "Rewards Last Epoch" summary when all are in). Single pass —
        // no separate summary + per-card passes — and no card waits on the
        // slowest validator. Fire-and-forget; rendering isn't blocked on it.
        fetchPortfolioLastEpochRewards(sortedValidators);

        loading.style.display = 'none';
        results.style.display = 'block';

        // Destroy old combined chart if exists
        if (chartInstances['combinedChart']) {
          chartInstances['combinedChart'].destroy();
          delete chartInstances['combinedChart'];
        }

      } catch (err) {
        console.error('Failed to load portfolio:', err);
        loading.style.display = 'none';
        empty.style.display = 'block';
      }
    }

    function refreshPortfolio() {
      // Clear cache to force refresh
      validatorInfoCache = {};
      loadPortfolio();
    }

    // Fetch last epoch rewards for all portfolio validators
    async function fetchPortfolioLastEpochRewards(validators) {
      const valueEl = document.getElementById('portfolioLastEpochRewards');
      const labelEl = valueEl?.parentElement?.querySelector('.portfolio-stat-label');
      try {
        // Fetch a generous buffer (6 epochs) because at an epoch boundary the
        // RPC may take a while to index the most recent completed epoch — and
        // if ANY validator in the portfolio is missing that epoch, we'd fall
        // through to "—" unnecessarily. More buffer = more chance of finding
        // a recent epoch where every validator has data.
        const EPOCH_BUFFER = 6;
        const rewardPromises = validators.map(async (v) => {
          let list = [];
          try {
            list = await fetchTotalValidatorRewards(v.voteAccount, v.commission || 0, EPOCH_BUFFER);
          } catch (e) {
            console.warn(`[rewards] fetch failed for ${v.voteAccount}:`, e && e.message || e);
            list = [];
          }
          // Stream: fill THIS card's "Last Epoch Earned" the moment its own data
          // arrives, instead of waiting for the whole batch (and the summary).
          fillCardLastEpoch(v, list);
          return list;
        });

        const allRewards = await Promise.all(rewardPromises);

        // Collect every epoch we saw across any validator, sorted newest first.
        const epochSet = new Set();
        for (const list of allRewards) {
          for (const r of list) if (r && typeof r.epoch === 'number') epochSet.add(r.epoch);
        }
        const sortedEpochs = Array.from(epochSet).sort((a, b) => b - a);

        // Primary path: newest epoch where EVERY validator has indexed data.
        // This gives a clean, accurate total.
        let chosenEpoch = null;
        let totalAmount = 0;
        let isPartial = false;
        let indexedCount = 0;

        for (const epoch of sortedEpochs) {
          const perValidator = allRewards.map(list => list.find(r => r.epoch === epoch));
          if (perValidator.every(r => r && r.indexed)) {
            chosenEpoch = epoch;
            totalAmount = perValidator.reduce((s, r) => s + (r.amount || 0) / 1e9, 0);
            indexedCount = perValidator.length;
            break;
          }
        }

        // Fallback: if no epoch has complete data, find the newest epoch where
        // at least half the validators have indexed data and show a partial
        // total so the card still conveys useful information.
        if (chosenEpoch === null) {
          for (const epoch of sortedEpochs) {
            const perValidator = allRewards.map(list => list.find(r => r.epoch === epoch));
            const indexed = perValidator.filter(r => r && r.indexed);
            if (indexed.length >= Math.max(1, Math.ceil(validators.length / 2))) {
              chosenEpoch = epoch;
              totalAmount = indexed.reduce((s, r) => s + (r.amount || 0) / 1e9, 0);
              isPartial = true;
              indexedCount = indexed.length;
              break;
            }
          }
        }

        if (chosenEpoch !== null) {
          if (valueEl) valueEl.textContent = formatNumber(totalAmount, 2);
          if (labelEl) {
            const partialSuffix = isPartial
              ? ` · ${indexedCount}/${validators.length} indexed`
              : '';
            labelEl.innerHTML = `Rewards Last Epoch (XNT) <span style="opacity:0.55;font-size:0.85em;font-weight:400;">· Epoch #${chosenEpoch}${partialSuffix}</span>`;
          }
        } else {
          // Nothing indexed at all — RPC probably hasn't caught up on any
          // recent epoch for the portfolio. Show a clearer state than a bare "-".
          if (valueEl) valueEl.textContent = '—';
          if (labelEl) labelEl.innerHTML = `Rewards Last Epoch (XNT) <span style="opacity:0.55;font-size:0.85em;font-weight:400;">· awaiting RPC indexing</span>`;
          console.warn('[rewards] no indexed epoch found across portfolio — RPC may be catching up');
        }
      } catch (e) {
        console.error('[rewards] fetch error:', e);
        if (valueEl) valueEl.textContent = '—';
        if (labelEl) labelEl.innerHTML = `Rewards Last Epoch (XNT) <span style="opacity:0.55;font-size:0.85em;font-weight:400;">· fetch failed</span>`;
      }
    }

    // Fetch last epoch rewards for each validator card
    // Fill a single card's "Last Epoch Earned" stat from a rewards list.
    // Extracted so both the portfolio streaming pass and the lookup hydration
    // can reuse identical fill logic.
    function fillCardLastEpoch(v, rewards) {
      // The same validator can be on screen twice (Lookup + My Data Center) with
      // the same ids — fill every copy, not just the first one in the DOM.
      const key = v.voteAccount.slice(0, 8);
      document.querySelectorAll(`[id="lastEpoch-${key}"]`).forEach(cardEl => {
        fillOneCardLastEpoch(cardEl, cardEl.querySelector(`[id="lastEpochChange-${key}"]`), rewards);
      });
    }

    function fillOneCardLastEpoch(cardEl, changeEl, rewards) {
      if (!cardEl) return;
      const sv = cardEl.querySelector('.stat-value');

      if (rewards && rewards.length > 0) {
        const indexedRewards = rewards.filter(r => r.indexed);
        if (indexedRewards.length > 0) {
          const latest = indexedRewards[0];
          const lastEpochAmount = (latest.amount || 0) / 1e9;
          if (sv) sv.textContent = formatNumber(lastEpochAmount, 2);

          const subtextEl = cardEl.querySelector('.stat-subtext');
          if (subtextEl) {
            subtextEl.innerHTML = `XNT <span style="opacity:0.6;">· #${latest.epoch}</span>`;
          }

          if (changeEl && indexedRewards.length >= 2 && indexedRewards[1].amount > 0) {
            const priorEpochAmount = (indexedRewards[1].amount || 0) / 1e9;
            const changePercent = ((lastEpochAmount - priorEpochAmount) / priorEpochAmount) * 100;
            if (changePercent > 0) {
              changeEl.innerHTML = `<span style="color: var(--success);">↑ ${formatNumber(changePercent, 2)}%</span>`;
            } else if (changePercent < 0) {
              changeEl.innerHTML = `<span style="color: var(--danger);">↓ ${formatNumber(Math.abs(changePercent), 2)}%</span>`;
            } else {
              changeEl.innerHTML = `<span style="color: var(--text-dim);">→ 0%</span>`;
            }
          }
        } else if (sv) {
          sv.textContent = '—';
        }
      } else if (sv) {
        sv.textContent = '—';
      }
    }

    async function fetchLastEpochForCards(validators) {
      for (const v of validators) {
        try {
          // 6-epoch window matches fetchTotalValidatorRewards' cache key used
          // elsewhere, so this mostly hits the warm cache.
          const rewards = await fetchTotalValidatorRewards(v.voteAccount, v.commission || 0, 6);
          fillCardLastEpoch(v, rewards);
        } catch (e) {
          console.error(`Error fetching last epoch for ${v.voteAccount}:`, e);
          const cardEl = document.getElementById(`lastEpoch-${v.voteAccount.slice(0,8)}`);
          const sv = cardEl && cardEl.querySelector('.stat-value');
          if (sv && sv.textContent === 'Loading...') sv.textContent = '—';
        }
      }
    }

