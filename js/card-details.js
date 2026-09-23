    // Chart instances storage
    const chartInstances = {};
    
    // Color palette for multiple validators
    const chartColors = [
      { border: '#4da6ff', bg: 'rgba(77, 166, 255, 0.15)' },   // Blue
      { border: '#00e676', bg: 'rgba(0, 230, 118, 0.15)' },    // Green
      { border: '#ffab00', bg: 'rgba(255, 171, 0, 0.15)' },    // Orange
      { border: '#ff6b9d', bg: 'rgba(255, 107, 157, 0.15)' },  // Pink (more visible than red)
      { border: '#b388ff', bg: 'rgba(179, 136, 255, 0.15)' },  // Purple
      { border: '#00d4ff', bg: 'rgba(0, 212, 255, 0.15)' },    // Cyan
      { border: '#76ff03', bg: 'rgba(118, 255, 3, 0.15)' },    // Lime
      { border: '#ff6e40', bg: 'rgba(255, 110, 64, 0.15)' },   // Coral
    ];

    // Toggle stake details visibility and fetch data
    async function toggleStakeDetails(voteAccount, validatorName, totalStake, commission, button) {
      // Resolve inside the clicked card: Lookup and My Data Center may both hold
      // a card for this validator, and their ids collide.
      const card = button && button.closest ? button.closest('.validator-card') : null;
      const section = (card && card.querySelector('.validator-stake-section'))
        || document.getElementById('stake-' + voteAccount + '-section');
      const isExpanded = section.classList.contains('expanded');
      
      if (isExpanded) {
        section.classList.remove('expanded');
        button.classList.remove('expanded');
      } else {
        // Close the chart section if it's open (mutually exclusive)
        const chartSection = card ? card.querySelector('.validator-chart-section') : null;
        if (chartSection && chartSection.classList.contains('expanded')) {
          chartSection.classList.remove('expanded');
          // Find and update the chart button
          const chartBtn = button.parentElement.querySelector('.validator-expand-btn:not(.stake-details-btn)');
          if (chartBtn) chartBtn.classList.remove('expanded');
        }
        
        section.classList.add('expanded');
        button.classList.add('expanded');
        
        // Check if already loaded
        if (section.dataset.loaded === 'true') {
          return;
        }
        
        // Show loading
        section.innerHTML = `
          <div class="stake-section-loading">
            <div class="loading-spinner-small"></div>
            <span>Analyzing stake accounts...</span>
          </div>
        `;
        
        // Check cache first
        const cached = stakeBreakdownCache[voteAccount];
        if (cached && cached.timestamp > Date.now() - 300000) {
          renderInlineStakeBreakdown(section, cached.data, validatorName, totalStake, commission, voteAccount);
          section.dataset.loaded = 'true';
          return;
        }
        
        // Add timeout for slow loading message
        const slowLoadingTimeout = setTimeout(() => {
          if (section.querySelector('.stake-section-loading')) {
            section.innerHTML = `
              <div class="stake-section-loading">
                <div class="loading-spinner-small"></div>
                <span>Still loading... RPC may be slow</span>
                <button data-action="stake-cancel" data-vote="${escHtml(voteAccount)}" style="margin-top: 0.5rem; padding: 0.25rem 0.75rem; background: var(--bg-card); border: 1px solid var(--border); border-radius: 4px; color: var(--text-secondary); cursor: pointer; font-size: 0.75rem;">Cancel</button>
              </div>
            `;
          }
        }, 5000);
        
        try {
          // Helper function with timeout
          const fetchWithTimeout = async (url, options, timeout = 15000) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);
            try {
              const response = await fetch(url, { ...options, signal: controller.signal });
              clearTimeout(timeoutId);
              return response;
            } catch (err) {
              clearTimeout(timeoutId);
              throw err;
            }
          };
          
          // Fetch stake accounts
          const response = await fetchWithTimeout(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'getProgramAccounts',
              params: [
                'Stake11111111111111111111111111111111111111',
                {
                  encoding: 'jsonParsed',
                  filters: [
                    { memcmp: { offset: 124, bytes: voteAccount } }
                  ]
                }
              ]
            })
          });
          
          clearTimeout(slowLoadingTimeout);
          
          const data = await response.json();
          
          if (!data.result || data.result.length === 0) {
            section.innerHTML = `
              <div class="stake-section-loading">
                <span>No stake accounts found</span>
              </div>
            `;
            section.dataset.loaded = 'true';
            return;
          }
          
          // Update loading message
          section.innerHTML = `
            <div class="stake-section-loading">
              <div class="loading-spinner-small"></div>
              <span>Found ${data.result.length} accounts, classifying…</span>
            </div>
          `;
          
          // Gather authority info
          const accountsWithRates = [];
          for (let i = 0; i < data.result.length; i++) {
            const acc = data.result[i];
            const stakeInfo = acc.account.data.parsed?.info;
            const stakeLamports = acc.account.lamports;
            const stakeXNT = stakeLamports / 1e9;
            const meta = stakeInfo?.meta;
            const staker = meta?.authorized?.staker || acc.pubkey;
            const withdrawer = meta?.authorized?.withdrawer || null;
            accountsWithRates.push({ pubkey: acc.pubkey, stakeXNT, staker, withdrawer });
          }
          
          // Classify accounts - prioritize user selections, then withdrawer matching
          let selfStake = 0;
          let delegatedStake = 0;
          const delegators = [];
          const selfStakeAccounts = [];
          let detectionMethod = 'withdrawer-match';
          
          // Check for user selections first (from Stake Selection modal)
          const userSelections = getSelfStakeSelections(voteAccount);
          
          if (hasUserClassification(userSelections)) {
            // Use user-selected self-stake accounts
            detectionMethod = 'user-selected';
            const selectedPubkeys = new Set(userSelections.pubkeys);
            
            for (const acc of accountsWithRates) {
              if (selectedPubkeys.has(acc.pubkey)) {
                selfStake += acc.stakeXNT;
                selfStakeAccounts.push({ pubkey: acc.pubkey, amount: acc.stakeXNT });
              } else {
                delegatedStake += acc.stakeXNT;
                delegators.push({ address: acc.staker, amount: acc.stakeXNT, pubkey: acc.pubkey });
              }
            }
          } else {
            // Auto-detect using withdrawer matching
            // Get vote account's authorized withdrawer
            const voteAccountWithdrawer = await getVoteWithdrawer(voteAccount);
            
            if (voteAccountWithdrawer) {
              // Match stake account withdrawers against vote account withdrawer
              for (const acc of accountsWithRates) {
                if (acc.withdrawer === voteAccountWithdrawer) {
                  selfStake += acc.stakeXNT;
                  selfStakeAccounts.push({ pubkey: acc.pubkey, amount: acc.stakeXNT });
                } else {
                  delegatedStake += acc.stakeXNT;
                  delegators.push({ address: acc.staker, amount: acc.stakeXNT, pubkey: acc.pubkey });
                }
              }
            } else {
              // Fallback: treat all as delegated until configured
              detectionMethod = 'not-configured';
              for (const acc of accountsWithRates) {
                delegatedStake += acc.stakeXNT;
                delegators.push({ address: acc.staker, amount: acc.stakeXNT, pubkey: acc.pubkey });
              }
            }
          }
          
          // Debug: Log classification results
          console.log('Classification result:', {
            method: detectionMethod,
            selfStake: selfStake.toFixed(2) + ' XNT',
            delegatedStake: delegatedStake.toFixed(2) + ' XNT',
            selfStakeAccounts: selfStakeAccounts.length,
            delegatorAccounts: delegators.length
          });
          
          delegators.sort((a, b) => b.amount - a.amount);
          
          // The stake split is ready now — show it. The APY needs reward
          // history, which used to be fetched here for 365 epochs (~730 RPC
          // calls through a 3-slot queue = minutes of "analyzing rewards…").
          // Now: render immediately with the APY marked as calculating, fetch
          // 30 epochs (enough for the 7-day and 30-day figures) in the
          // background, and fill the APY in when it arrives.
          const breakdownData = {
            selfStake,
            delegatedStake,
            totalStake: selfStake + delegatedStake,
            delegators,
            selfStakeAccounts,
            accountCount: data.result.length,
            detectionMethod: detectionMethod,
            derivedBaseAPY: 8,
            historicalAPY: {},
            apyPending: true
          };

          // Cache the split right away (APY is added below when known)
          stakeBreakdownCache[voteAccount] = { timestamp: Date.now(), data: breakdownData };

          // Store for calculator
          if (!window.stakeBreakdownData) window.stakeBreakdownData = {};
          window.stakeBreakdownData[voteAccount] = {
            selfStake,
            delegatedStake,
            total: selfStake + delegatedStake,
            commission,
            delegatorCount: delegators.length
          };

          renderInlineStakeBreakdown(section, breakdownData, validatorName, totalStake, commission, voteAccount);
          section.dataset.loaded = 'true';

          // ── APY, in the background ──
          (async () => {
            const APY_EPOCHS = 30;
            let derivedBaseAPY = 8;
            const historicalAPY = { days7: null, days30: null, days90: null, days365: null };
            try {
              const validatorRewards = await fetchTotalValidatorRewards(voteAccount, commission, APY_EPOCHS);
              if (validatorRewards && validatorRewards.length > 0) {
                const divisor = selfStake + (delegatedStake * commission / 100);
                const calcPeriodAPY = (days) => {
                  const periodRewards = validatorRewards.slice(0, Math.min(days, validatorRewards.length));
                  if (periodRewards.length < days * 0.8) return null; // Need at least 80% of expected data
                  const totalRewardsXNT = periodRewards.reduce((sum, r) => sum + r.amount, 0) / 1e9;
                  const avgEpochRewardsXNT = totalRewardsXNT / periodRewards.length;
                  const annualizedRewards = avgEpochRewardsXNT * epochsPerYear();
                  const baseAPY = divisor > 0 ? (annualizedRewards / divisor) * 100 : 8;
                  const selfEarnings = selfStake * (baseAPY / 100);
                  const commEarnings = delegatedStake * (baseAPY / 100) * (commission / 100);
                  const totalEarnings = selfEarnings + commEarnings;
                  const validatorAPY = selfStake > 0 ? (totalEarnings / selfStake) * 100 : baseAPY;
                  return { earnings: totalRewardsXNT, epochCount: periodRewards.length, avgDaily: annualizedRewards / 365.25, validatorAPY, baseAPY };
                };
                historicalAPY.days7 = calcPeriodAPY(7);
                historicalAPY.days30 = calcPeriodAPY(30);
                if (historicalAPY.days7) derivedBaseAPY = historicalAPY.days7.baseAPY;
              }
            } catch (e) {
              console.warn('Could not fetch validator rewards for APY calculation:', e);
            }
            breakdownData.derivedBaseAPY = derivedBaseAPY;
            breakdownData.historicalAPY = historicalAPY;
            breakdownData.apyPending = false;
            stakeBreakdownCache[voteAccount] = { timestamp: Date.now(), data: breakdownData };
            // Re-render only if this section is still showing (user may have
            // collapsed it or the cards were re-rendered meanwhile).
            const live = section.isConnected ? section : null;
            if (live && live.classList.contains('expanded') && live.dataset.loaded === 'true') {
              renderInlineStakeBreakdown(live, breakdownData, validatorName, totalStake, commission, voteAccount);
            }
          })();

        } catch (err) {
          console.error('Error fetching stake breakdown:', err);
          const errorMsg = err.name === 'AbortError' ? 'Request timed out' : 'Error loading data';
          section.innerHTML = `
            <div class="stake-section-loading">
              <span style="color: var(--danger);">${errorMsg}</span>
              <button data-action="stake-retry" data-vote="${escHtml(voteAccount)}" style="margin-top: 0.5rem; padding: 0.25rem 0.75rem; background: var(--accent-cyan); border: none; border-radius: 4px; color: var(--bg-primary); cursor: pointer; font-size: 0.75rem; font-weight: 500;">Retry</button>
            </div>
          `;
        }
      }
    }
    
    function renderInlineStakeBreakdown(section, data, validatorName, totalStake, commission, voteAccount) {
      // Safely destructure with defaults
      if (!data) data = {};
      const selfStake = data.selfStake || 0;
      const delegatedStake = data.delegatedStake || 0;
      const delegators = Array.isArray(data.delegators) ? data.delegators : [];
      const selfStakeAccounts = Array.isArray(data.selfStakeAccounts) ? data.selfStakeAccounts : [];
      const accountCount = data.accountCount || 0;
      const detectionMethod = data.detectionMethod || 'unknown';
      const historicalAPY = data.historicalAPY || {};
      
      // Store historicalAPY globally for period selector
      if (!window.historicalAPYData) window.historicalAPYData = {};
      window.historicalAPYData[voteAccount] = historicalAPY;
      
      const total = selfStake + delegatedStake;
      const selfPercent = total > 0 ? (selfStake / total) * 100 : 0;
      const delegatedPercent = total > 0 ? (delegatedStake / total) * 100 : 0;
      
      // Pie chart calculations with minimum visual threshold
      const circumference = 2 * Math.PI * 35;
      const MIN_VISUAL_PERCENT = 12; // Minimum 12% visual display for visibility
      
      // Calculate visual percentages (for display only - labels show real values)
      let selfVisual = selfPercent;
      let delegatedVisual = delegatedPercent;
      
      // If both have values, ensure minimum visibility
      if (selfPercent > 0 && delegatedPercent > 0) {
        if (selfPercent < MIN_VISUAL_PERCENT) {
          selfVisual = MIN_VISUAL_PERCENT;
          delegatedVisual = 100 - MIN_VISUAL_PERCENT;
        } else if (delegatedPercent < MIN_VISUAL_PERCENT) {
          delegatedVisual = MIN_VISUAL_PERCENT;
          selfVisual = 100 - MIN_VISUAL_PERCENT;
        }
      }
      
      const selfDash = (selfVisual / 100) * circumference;
      const delegatedDash = (delegatedVisual / 100) * circumference;
      
      // Earnings calculations - use derived baseAPY if available
      const baseAPY = data.derivedBaseAPY || 8;
      const selfStakeEarnings = selfStake * (baseAPY / 100);
      const commissionEarnings = delegatedStake * (baseAPY / 100) * (commission / 100);
      const totalValidatorEarnings = selfStakeEarnings + commissionEarnings;
      
      // Calculate validator's effective APY (return on their self-stake investment)
      // APY = total earnings / self-stake (since they only invested their self-stake)
      const validatorAPY = selfStake > 0 ? (totalValidatorEarnings / selfStake) * 100 : baseAPY;
      
      const detectionNote = 
        detectionMethod === 'user-selected' ? 'Based on your selections' :
        detectionMethod === 'withdrawer-match' ? 'Auto-detected by withdrawer' :
        detectionMethod === 'not-configured' ? 'Click Active Stake to configure' :
        detectionMethod === 'reward-analysis' ? 'Detected by reward analysis' :
        detectionMethod === 'cached' ? 'Using cached detection' :
        detectionMethod === 'heuristic-0pct' ? 'Estimated (0% commission)' :
        'Estimated by stake size';
      
      // Build all accounts list (self-stake first, then delegated)
      const allAccounts = [];
      selfStakeAccounts.forEach(acc => {
        allAccounts.push({ ...acc, type: 'self', address: acc.pubkey });
      });
      delegators.forEach(acc => {
        allAccounts.push({ ...acc, type: 'delegated', address: acc.pubkey });
      });
      // Sort by amount descending
      allAccounts.sort((a, b) => b.amount - a.amount);
      
      const accountsListId = 'accounts-list-' + voteAccount.slice(0, 8);
      
      section.innerHTML = `
        <div class="stake-inline-content">
          ${commission === 0 ? `
          <div class="stake-inline-warning">
            <span>⚠️</span>
            <div class="stake-inline-warning-text">
              <strong>0% Commission:</strong> Cannot distinguish self-stake from delegations. Values are estimates.
            </div>
          </div>
          ` : ''}
          
          <div class="stake-inline-pie-row">
            <div class="stake-inline-pie">
              <svg width="90" height="90" viewBox="0 0 90 90" style="transform: rotate(-90deg);">
                <circle cx="45" cy="45" r="35" fill="none" stroke="var(--bg-card)" stroke-width="10"/>
                <circle cx="45" cy="45" r="35" fill="none" stroke="var(--accent-cyan)" stroke-width="10"
                  stroke-dasharray="${selfDash} ${circumference}" stroke-linecap="round"/>
                <circle cx="45" cy="45" r="35" fill="none" stroke="var(--accent-gold)" stroke-width="10"
                  stroke-dasharray="${delegatedDash} ${circumference}" stroke-dashoffset="-${selfDash}" stroke-linecap="round"/>
              </svg>
            </div>
            <div class="stake-inline-stats">
              <div class="stake-inline-stat">
                <span class="stake-inline-stat-label"><span style="color: var(--accent-cyan);">●</span> Self-Stake</span>
                <span class="stake-inline-stat-value">${formatNumber(selfStake, 0)} XNT <span style="color: var(--text-dim); font-size: 0.75rem;">(${formatNumber(selfPercent, 1)}%)</span></span>
              </div>
              <div class="stake-inline-stat">
                <span class="stake-inline-stat-label"><span style="color: var(--accent-gold);">●</span> Delegated</span>
                <span class="stake-inline-stat-value">${formatNumber(delegatedStake, 0)} XNT <span style="color: var(--text-dim); font-size: 0.75rem;">(${formatNumber(delegatedPercent, 1)}%)</span></span>
              </div>
              <div class="stake-inline-stat stake-accounts-toggle" data-action="stake-accounts-toggle" data-list="${escHtml(accountsListId)}">
                <span class="stake-inline-stat-label">Stake Accounts <span class="accounts-arrow">▼</span></span>
                <span class="stake-inline-stat-value">${accountCount} total</span>
              </div>
            </div>
          </div>
          
          <div class="stake-accounts-list" id="${accountsListId}">
            <div class="stake-accounts-list-inner">
              ${allAccounts.map(acc => `
                <div class="stake-account-item ${acc.type}">
                  <div class="stake-account-left">
                    <span class="stake-account-type-badge ${acc.type}">${acc.type === 'self' ? 'SELF' : 'DELEGATED'}</span>
                    <span class="stake-account-address">${acc.address.slice(0, 6)}...${acc.address.slice(-4)}</span>
                  </div>
                  <span class="stake-account-amount">${formatNumber(acc.amount, 0)} XNT</span>
                </div>
              `).join('')}
            </div>
          </div>
          
          <div class="stake-inline-earnings">
            <div class="stake-inline-apy-display">
              <div class="stake-inline-apy-header">
                <div class="stake-inline-apy-label">Validator APY</div>
                <select class="stake-apy-period-select" data-change="stake-apy-period" data-vote="${escHtml(voteAccount)}">
                  ${historicalAPY.days7 ? `<option value="7" selected>7-day avg</option>` : ''}
                  ${historicalAPY.days30 ? `<option value="30">30-day avg</option>` : ''}
                  ${historicalAPY.days90 ? `<option value="90">90-day avg</option>` : ''}
                  ${historicalAPY.days365 ? `<option value="365">1-year avg</option>` : ''}
                </select>
              </div>
              <div class="stake-inline-apy-value" id="apy-value-${voteAccount.slice(0,8)}">${historicalAPY.days7 ? formatNumber(historicalAPY.days7.validatorAPY, 2) + '%' : (data.apyPending ? '<span style="font-size:0.8em;color:var(--text-secondary)">calculating…</span>' : '—%')}</div>
              <div class="stake-inline-apy-note">
                <span id="apy-earnings-${voteAccount.slice(0,8)}">${historicalAPY.days7 ? formatNumber(historicalAPY.days7.earnings, 2) + ' XNT earned' : (data.apyPending ? 'Reading the last 30 epochs of rewards' : '')}</span>
              </div>
            </div>
            
            <div class="stake-inline-earnings-title" style="margin-top: 1rem;">
              💰 Est. Annual Validator Earnings (based on 7-day avg)
            </div>
            <div class="stake-inline-earnings-grid">
              <div class="stake-inline-earning">
                <div class="stake-inline-earning-value">${formatNumber(selfStakeEarnings, 0)} XNT</div>
                <div class="stake-inline-earning-label">From Self-Stake (${formatNumber(baseAPY, 1)}% base)</div>
              </div>
              <div class="stake-inline-earning">
                <div class="stake-inline-earning-value">${formatNumber(commissionEarnings, 0)} XNT</div>
                <div class="stake-inline-earning-label">From ${commission}% Commission</div>
              </div>
            </div>
            <div class="stake-inline-total">
              <span style="color: var(--text-secondary); font-size: 0.8rem;">Total: </span>
              <span style="color: var(--success); font-weight: 600; font-size: 1rem;">${formatNumber(totalValidatorEarnings, 0)} XNT/year</span>
            </div>
          </div>
          
          <div class="stake-inline-footer">
            <div class="stake-inline-note">${detectionNote} • Cached 5 min</div>
            <button class="stake-manage-btn" data-action="stake-manage-classification" data-vote="${escHtml(voteAccount)}" data-name="${escHtml(validatorName)}">
              ⚙️ Manage Classification
            </button>
          </div>
        </div>
      `;
    }
    
    function updateAPYDisplay(selectEl, voteAccount) {
      const period = selectEl.value;
      const historicalAPY = window.historicalAPYData && window.historicalAPYData[voteAccount];
      
      if (!historicalAPY) return;
      
      const periodKey = 'days' + period;
      const data = historicalAPY[periodKey];
      
      // Resolve inside the select's own stake section: Lookup and Data Center can
      // render the same validator, so these ids are not unique on the page.
      const scope = stakeSectionFor(voteAccount, selectEl) || document;
      const apyValueEl = scope.querySelector('[id="apy-value-' + voteAccount.slice(0, 8) + '"]');
      const earningsEl = scope.querySelector('[id="apy-earnings-' + voteAccount.slice(0, 8) + '"]');
      
      if (data && apyValueEl && earningsEl) {
        apyValueEl.textContent = formatNumber(data.validatorAPY, 2) + '%';
        earningsEl.textContent = formatNumber(data.earnings, 2) + ' XNT earned';
      }
    }
    
    function stakeSectionFor(voteAccount, el) {
      // Prefer the section around the clicked element (ids collide across tabs).
      const own = el && el.closest ? el.closest('.validator-stake-section') : null;
      return own || document.getElementById('stake-' + voteAccount + '-section');
    }

    function cancelStakeLoad(voteAccount, el) {
      const section = stakeSectionFor(voteAccount, el);
      if (section) {
        section.innerHTML = `
          <div class="stake-section-loading">
            <span>Loading cancelled</span>
            <button data-action="stake-retry" data-vote="${escHtml(voteAccount)}" style="margin-top: 0.5rem; padding: 0.25rem 0.75rem; background: var(--accent-cyan); border: none; border-radius: 4px; color: var(--bg-primary); cursor: pointer; font-size: 0.75rem; font-weight: 500;">Retry</button>
          </div>
        `;
        section.dataset.loaded = 'cancelled';
      }
    }
    
    function retryStakeLoad(voteAccount, el) {
      const section = stakeSectionFor(voteAccount, el);
      if (section) {
        section.dataset.loaded = '';
        // Find the button and trigger click
        const card = section.closest('.validator-card');
        if (card) {
          const btn = card.querySelector('.stake-details-btn');
          if (btn) {
            btn.classList.remove('expanded');
            section.classList.remove('expanded');
            btn.click();
          }
        }
      }
    }

    function toggleAccountsList(listId, toggleEl) {
      // Same id-collision caveat as updateAPYDisplay: look inside the toggle's card first.
      const own = toggleEl && toggleEl.closest ? toggleEl.closest('.validator-stake-section') : null;
      const list = (own && own.querySelector('[id="' + listId + '"]')) || document.getElementById(listId);
      if (!list) return;
      const isExpanded = list.classList.contains('expanded');
      
      if (isExpanded) {
        list.classList.remove('expanded');
        toggleEl.classList.remove('expanded');
      } else {
        list.classList.add('expanded');
        toggleEl.classList.add('expanded');
      }
    }


        // Toggle chart visibility and initialize
    function destroyCardCharts() {
      if (typeof chartInstances !== 'object' || !chartInstances) return;
      Object.keys(chartInstances).forEach(k => {
        if (!k.startsWith('chart-')) return;
        try { chartInstances[k].destroy(); } catch (e) {}
        delete chartInstances[k];
      });
    }

    async function toggleChart(chartId, button) {
      const section = document.getElementById(chartId + '-section');
      const isExpanded = section.classList.contains('expanded');
      
      if (isExpanded) {
        section.classList.remove('expanded');
        button.classList.remove('expanded');
      } else {
        // Close the stake details section if it's open (mutually exclusive)
        const stakeSection = section.previousElementSibling;
        if (stakeSection && stakeSection.classList.contains('validator-stake-section') && stakeSection.classList.contains('expanded')) {
          stakeSection.classList.remove('expanded');
          // Find and update the stake details button
          const stakeBtn = button.parentElement.querySelector('.stake-details-btn');
          if (stakeBtn) stakeBtn.classList.remove('expanded');
        }
        
        section.classList.add('expanded');
        button.classList.add('expanded');
        
        // Initialize chart if not already done
        if (!chartInstances[chartId] && window.chartDataStore && window.chartDataStore[chartId]) {
          const data = window.chartDataStore[chartId];
          const loadingEl = document.getElementById(chartId + '-loading');
          
          // Store original credits data before fetching XNT
          data.creditsLabels = data.labels;
          data.creditsData = data.data;
          
          // Show loading while fetching XNT data
          if (loadingEl) loadingEl.style.display = 'flex';
          
          // Fetch XNT rewards data (vote account + self-stake rewards)
          const rewards = await fetchTotalValidatorRewards(data.voteAccount, data.commission, 30);
          
          if (rewards && rewards.length > 0) {
            // Sort by epoch (fetchInflationRewards already excludes current epoch)
            const sortedRewards = rewards.sort((a, b) => a.epoch - b.epoch);
            
            const xntLabels = [];
            const xntData = [];
            
            sortedRewards.slice(-30).forEach(r => {
              xntLabels.push(r.epoch);
              xntData.push(r.amount / 1e9);
            });
            
            if (xntData.length > 0) {
              // Store XNT data separately
              data.xntLabels = xntLabels;
              data.xntData = xntData;
              
              // Set current display to XNT
              data.labels = xntLabels;
              data.data = xntData;
              data.type = 'xnt';
              
              // Update title and subtitle
              const titleEl = document.getElementById(chartId + '-title');
              const subtitleEl = document.getElementById(chartId + '-subtitle');
              const lastEl = document.getElementById(chartId + '-last');
              const avgEl = document.getElementById(chartId + '-avg');
              const peakEl = document.getElementById(chartId + '-peak');
              
              if (titleEl) titleEl.textContent = 'XNT Rewards Trend';
              if (subtitleEl) subtitleEl.textContent = `XNT earned per epoch (last ${xntLabels.length} epochs)`;
              if (lastEl) lastEl.textContent = formatNumber(xntData[xntData.length - 1], 2) + ' XNT';
              if (avgEl) avgEl.textContent = formatNumber(xntData.reduce((a, b) => a + b, 0) / xntData.length, 2) + ' XNT';
              if (peakEl) peakEl.textContent = formatNumber(Math.max(...xntData), 2) + ' XNT';
            }
          }
          
          // Hide loading
          if (loadingEl) loadingEl.style.display = 'none';
          
          // Now initialize the chart with the data we have
          initializeChart(chartId);
        }
      }
    }

    // Switch chart between Epoch Credits and XNT Rewards
    async function switchChartType(chartId, type, button) {
      const data = window.chartDataStore[chartId];
      if (!data) return;
      
      // Update button states
      const container = button.parentElement;
      container.querySelectorAll('.chart-toggle-btn').forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      
      // Get elements
      const titleEl = document.getElementById(chartId + '-title');
      const subtitleEl = document.getElementById(chartId + '-subtitle');
      const lastEl = document.getElementById(chartId + '-last');
      const avgEl = document.getElementById(chartId + '-avg');
      const peakEl = document.getElementById(chartId + '-peak');
      const loadingEl = document.getElementById(chartId + '-loading');
      const statsEl = document.getElementById(chartId + '-stats');
      
      if (type === 'xnt') {
        // Check if we already have XNT data stored
        if (data.xntLabels && data.xntData && data.xntData.length > 0) {
          // Use stored XNT data
          const labels = data.xntLabels;
          const xntData = data.xntData;
          
          if (chartInstances[chartId]) {
            chartInstances[chartId].data.labels = labels;
            chartInstances[chartId].data.datasets[0].data = xntData;
            chartInstances[chartId].options.scales.y.ticks.callback = (value) => value.toFixed(2) + ' XNT';
            chartInstances[chartId].update();
          }
          
          if (titleEl) titleEl.textContent = 'XNT Rewards Trend';
          if (subtitleEl) subtitleEl.textContent = `XNT earned per epoch (last ${labels.length} epochs)`;
          if (lastEl) lastEl.textContent = formatNumber(xntData[xntData.length - 1], 2) + ' XNT';
          if (avgEl) avgEl.textContent = formatNumber(xntData.reduce((a, b) => a + b, 0) / xntData.length, 2) + ' XNT';
          if (peakEl) peakEl.textContent = formatNumber(Math.max(...xntData), 2) + ' XNT';
        } else {
          // Show loading and fetch
          if (loadingEl) loadingEl.style.display = 'flex';
          if (statsEl) statsEl.style.opacity = '0.5';
          
          // Fetch XNT rewards data (vote account + self-stake rewards)
          const rewards = await fetchTotalValidatorRewards(data.voteAccount, data.commission, 30);
          
          if (rewards.length > 0) {
            const labels = rewards.map(r => r.epoch);
            const xntData = rewards.map(r => r.amount / 1e9);
            
            // Store for later use
            data.xntLabels = labels;
            data.xntData = xntData;
            
            if (chartInstances[chartId]) {
              chartInstances[chartId].data.labels = labels;
              chartInstances[chartId].data.datasets[0].data = xntData;
              chartInstances[chartId].options.scales.y.ticks.callback = (value) => value.toFixed(2) + ' XNT';
              chartInstances[chartId].update();
            }
            
            if (titleEl) titleEl.textContent = 'XNT Rewards Trend';
            if (subtitleEl) subtitleEl.textContent = `XNT earned per epoch (last ${labels.length} epochs)`;
            if (lastEl) lastEl.textContent = formatNumber(xntData[xntData.length - 1], 2) + ' XNT';
            if (avgEl) avgEl.textContent = formatNumber(xntData.reduce((a, b) => a + b, 0) / xntData.length, 2) + ' XNT';
            if (peakEl) peakEl.textContent = formatNumber(Math.max(...xntData), 2) + ' XNT';
          } else {
            if (titleEl) titleEl.textContent = 'XNT Rewards Trend';
            if (subtitleEl) subtitleEl.textContent = 'No rewards data available';
            if (lastEl) lastEl.textContent = '--';
            if (avgEl) avgEl.textContent = '--';
            if (peakEl) peakEl.textContent = '--';
          }
          
          if (loadingEl) loadingEl.style.display = 'none';
          if (statsEl) statsEl.style.opacity = '1';
        }
        
      } else {
        // Switch to epoch credits - use stored credits data
        const labels = data.creditsLabels || data.labels;
        const creditsData = data.creditsData || data.data;
        
        // Update chart
        if (chartInstances[chartId]) {
          chartInstances[chartId].data.labels = labels;
          chartInstances[chartId].data.datasets[0].data = creditsData;
          chartInstances[chartId].options.scales.y.ticks.callback = (value) => {
            if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M';
            if (value >= 1e3) return (value / 1e3).toFixed(0) + 'K';
            return value;
          };
          chartInstances[chartId].update();
        }
        
        // Update UI
        if (titleEl) titleEl.textContent = 'Epoch Credits Trend';
        if (subtitleEl) subtitleEl.textContent = `Credits earned per epoch (last ${labels.length} epochs)`;
        if (lastEl) lastEl.textContent = creditsData.length > 0 ? formatNumber(creditsData[creditsData.length - 1], 0) : '--';
        if (avgEl) avgEl.textContent = creditsData.length > 0 ? formatNumber(creditsData.reduce((a, b) => a + b, 0) / creditsData.length, 0) : '--';
        if (peakEl) peakEl.textContent = creditsData.length > 0 ? formatNumber(Math.max(...creditsData), 0) : '--';
      }
    }

    // Switch combined chart between Epoch Credits and XNT Rewards
    async function switchCombinedChartType(type, button) {
      const validators = window.combinedChartValidators;
      if (!validators || validators.length === 0) return;
      
      // Update button states
      const container = button.parentElement;
      container.querySelectorAll('.chart-toggle-btn').forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      
      // Get elements
      const titleEl = document.getElementById('combinedChart-title');
      const subtitleEl = document.getElementById('combinedChart-subtitle');
      const loadingEl = document.getElementById('combinedChart-loading');
      const legendEl = document.getElementById('combinedChartLegend');
      
      if (type === 'xnt') {
        // Show loading
        if (loadingEl) loadingEl.style.display = 'flex';
        
        // Fetch XNT rewards for all validators (vote account + self-stake) in parallel
        const allRewards = {};
        const allEpochs = new Set();
        
        const fetchValidatorRewards = async (validator) => {
          try {
            const rewards = await fetchTotalValidatorRewards(validator.voteAccount, validator.commission, 30);
            return { voteAccount: validator.voteAccount, name: validator.name, rewards: rewards || [] };
          } catch (e) {
            console.error(`Error fetching rewards for ${validator.name}:`, e);
            return { voteAccount: validator.voteAccount, name: validator.name, rewards: [] };
          }
        };
        
        let rewardResults = await Promise.all(validators.map(fetchValidatorRewards));
        
        // Check for validators that didn't return data and retry them
        const missingValidators = rewardResults.filter(r => !r.rewards || r.rewards.length === 0);
        if (missingValidators.length > 0 && missingValidators.length < validators.length) {
          console.log(`Retrying ${missingValidators.length} validators that didn't return data...`);
          await new Promise(resolve => setTimeout(resolve, 500));
          
          const retryResults = await Promise.all(
            missingValidators.map(m => {
              const validator = validators.find(v => v.voteAccount === m.voteAccount);
              return fetchValidatorRewards(validator);
            })
          );
          
          retryResults.forEach(retryResult => {
            const idx = rewardResults.findIndex(r => r.voteAccount === retryResult.voteAccount);
            if (idx !== -1 && retryResult.rewards && retryResult.rewards.length > 0) {
              rewardResults[idx] = retryResult;
            }
          });
        }
        
        // Process results
        rewardResults.forEach(result => {
          if (result.rewards && result.rewards.length > 0) {
            allRewards[result.voteAccount] = {};
            result.rewards.forEach(r => {
              allRewards[result.voteAccount][r.epoch] = r.amount / 1e9;
              allEpochs.add(r.epoch);
            });
          }
        });
        
        // Sort epochs (fetchInflationRewards already excludes current epoch)
        let sortedEpochs = Array.from(allEpochs).sort((a, b) => a - b);
        sortedEpochs = sortedEpochs.slice(-30);
        
        // Build datasets
        const datasets = [];
        const legendHtml = [];
        let maxValue = 0;
        
        validators.forEach((validator, index) => {
          const color = chartColors[index % chartColors.length];
          const dataMap = allRewards[validator.voteAccount] || {};
          const data = sortedEpochs.map(epoch => dataMap[epoch] !== undefined ? dataMap[epoch] : null);
          
          // Track max value for dynamic stepSize
          data.forEach(v => { if (v !== null && v > maxValue) maxValue = v; });
          
          datasets.push({
            label: validator.name,
            data: data,
            borderColor: color.border,
            backgroundColor: color.bg,
            borderWidth: 2,
            fill: false,
            tension: 0.4,
            pointBackgroundColor: color.border,
            pointBorderColor: color.border,
            pointRadius: 2,
            pointHoverRadius: 5,
            spanGaps: true
          });
          
          legendHtml.push(`
            <div class="chart-legend-item">
              <div class="chart-legend-color" style="background: ${color.border}"></div>
              <span>${escHtml(validator.name)}</span>
            </div>
          `);
        });
        
        // Calculate appropriate stepSize based on data range
        let stepSize = 2;
        if (maxValue > 100) stepSize = 20;
        else if (maxValue > 50) stepSize = 10;
        else if (maxValue > 20) stepSize = 5;
        
        // Update chart
        if (chartInstances['combinedChart']) {
          chartInstances['combinedChart'].data.labels = sortedEpochs;
          chartInstances['combinedChart'].data.datasets = datasets;
          chartInstances['combinedChart'].options.scales.y.ticks.stepSize = stepSize;
          chartInstances['combinedChart'].options.scales.y.ticks.callback = (value) => value.toFixed(2) + ' XNT';
          chartInstances['combinedChart'].update();
        }
        
        // Update UI
        if (titleEl) titleEl.textContent = 'Combined XNT Rewards Trend';
        if (subtitleEl) subtitleEl.textContent = `XNT earned per epoch for all validators`;
        if (legendEl) legendEl.innerHTML = legendHtml.join('');
        
        // Hide loading
        if (loadingEl) loadingEl.style.display = 'none';
        
      } else {
        // Switch back to epoch credits - reinitialize the combined chart
        if (chartInstances['combinedChart']) {
          chartInstances['combinedChart'].destroy();
          delete chartInstances['combinedChart'];
        }
        initializeCombinedChart();
        
        // Update UI
        if (titleEl) titleEl.textContent = 'Combined Epoch Credits Trend';
        if (subtitleEl) subtitleEl.textContent = 'Credits earned per completed epoch for all validators';
      }
    }

    // Toggle combined stake details for all portfolio validators
    async function toggleCombinedStakeDetails(button) {
      const section = document.getElementById('combinedStakeContainer');
      const isExpanded = section.classList.contains('expanded');
      
      if (isExpanded) {
        section.classList.remove('expanded');
        button.classList.remove('expanded');
      } else {
        // Close the combined chart if it's open (mutually exclusive)
        const chartSection = document.getElementById('combinedChartContainer');
        if (chartSection && chartSection.classList.contains('expanded')) {
          chartSection.classList.remove('expanded');
          const chartBtn = button.parentElement.querySelector('.validator-expand-btn:not(.stake-details-btn)');
          if (chartBtn) chartBtn.classList.remove('expanded');
        }
        
        section.classList.add('expanded');
        button.classList.add('expanded');
        
        // Check if already loaded
        if (section.dataset.loaded === 'true') {
          return;
        }
        
        // Show loading
        section.innerHTML = `
          <div class="stake-section-loading">
            <div class="loading-spinner-small"></div>
            <span>Loading stake breakdown for all validators...</span>
          </div>
        `;
        
        try {
          // Get all portfolio validators
          const portfolioValidators = myPortfolio;
          if (!portfolioValidators || portfolioValidators.length === 0) {
            section.innerHTML = `
              <div class="stake-section-loading">
                <span>No validators in portfolio</span>
              </div>
            `;
            return;
          }
          
          // Aggregate data from all validators
          let totalSelfStake = 0;
          let totalDelegatedStake = 0;
          let totalSelfStakeEarnings = 0;
          let totalCommissionEarnings = 0;
          let totalAccounts = 0;
          const validatorBreakdowns = [];
          
          for (const voteAccount of portfolioValidators) {
            // Check cache first
            let breakdownData = stakeBreakdownCache[voteAccount]?.data;
            
            if (!breakdownData || stakeBreakdownCache[voteAccount].timestamp < Date.now() - 300000) {
              // Fetch fresh data
              try {
                const response = await fetch(RPC_URL, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getProgramAccounts',
                    params: [
                      'Stake11111111111111111111111111111111111111',
                      { encoding: 'jsonParsed', filters: [{ memcmp: { offset: 124, bytes: voteAccount } }] }
                    ]
                  })
                });
                
                const data = await response.json();
                if (!data.result || data.result.length === 0) continue;
                
                // Get commission
                let commission = 0;
                if (validatorInfoCache[voteAccount]) {
                  commission = validatorInfoCache[voteAccount].commission || 0;
                }
                
                // Build account list with withdrawer info
                const accountsWithRates = [];
                for (let i = 0; i < data.result.length; i++) {
                  const acc = data.result[i];
                  const stakeInfo = acc.account.data.parsed?.info;
                  const stakeLamports = acc.account.lamports;
                  const stakeXNT = stakeLamports / 1e9;
                  const meta = stakeInfo?.meta;
                  const withdrawer = meta?.authorized?.withdrawer || null;
                  accountsWithRates.push({ pubkey: acc.pubkey, stakeXNT, withdrawer });
                }
                
                // Classify using user selections first, then withdrawer matching
                let selfStake = 0, delegatedStake = 0;
                const userSelections = getSelfStakeSelections(voteAccount);
                
                if (hasUserClassification(userSelections)) {
                  const selectedPubkeys = new Set(userSelections.pubkeys);
                  accountsWithRates.forEach(acc => {
                    if (selectedPubkeys.has(acc.pubkey)) {
                      selfStake += acc.stakeXNT;
                    } else {
                      delegatedStake += acc.stakeXNT;
                    }
                  });
                } else {
                  // Auto-detect using withdrawer matching
                  const voteAccountWithdrawer = await getVoteWithdrawer(voteAccount);
                  
                  if (voteAccountWithdrawer) {
                    accountsWithRates.forEach(acc => {
                      if (acc.withdrawer === voteAccountWithdrawer) {
                        selfStake += acc.stakeXNT;
                      } else {
                        delegatedStake += acc.stakeXNT;
                      }
                    });
                  } else {
                    // Fallback: treat all as delegated
                    accountsWithRates.forEach(acc => {
                      delegatedStake += acc.stakeXNT;
                    });
                  }
                }
                
                breakdownData = { selfStake, delegatedStake, accountCount: data.result.length, commission };
                stakeBreakdownCache[voteAccount] = { timestamp: Date.now(), data: breakdownData };
              } catch (e) {
                console.error('Error fetching breakdown for', voteAccount, e);
                continue;
              }
            }
            
            if (breakdownData) {
              const commission = breakdownData.commission || validatorInfoCache[voteAccount]?.commission || 0;
              const baseAPY = breakdownData.derivedBaseAPY || 0.08 * 100; // Use derived if available, else 8%
              const baseRate = baseAPY / 100;
              
              totalSelfStake += breakdownData.selfStake || 0;
              totalDelegatedStake += breakdownData.delegatedStake || 0;
              totalAccounts += breakdownData.accountCount || 0;
              totalSelfStakeEarnings += (breakdownData.selfStake || 0) * baseRate;
              totalCommissionEarnings += (breakdownData.delegatedStake || 0) * baseRate * (commission / 100);
              
              // Get validator name
              let name = voteAccount.slice(0, 8) + '...';
              if (validatorInfoCache[voteAccount]) {
                name = validatorInfoCache[voteAccount].name || name;
              }
              
              validatorBreakdowns.push({
                voteAccount,
                name,
                selfStake: breakdownData.selfStake || 0,
                delegatedStake: breakdownData.delegatedStake || 0,
                commission,
                baseAPY: breakdownData.derivedBaseAPY || 8
              });
            }
          }
          
          // Render combined breakdown
          renderCombinedStakeBreakdown(section, {
            totalSelfStake,
            totalDelegatedStake,
            totalSelfStakeEarnings,
            totalCommissionEarnings,
            totalAccounts,
            validatorBreakdowns,
            validatorCount: portfolioValidators.length
          });
          
          section.dataset.loaded = 'true';
          
        } catch (err) {
          console.error('Error loading combined stake breakdown:', err);
          section.innerHTML = `
            <div class="stake-section-loading">
              <span style="color: var(--danger);">Error loading stake details</span>
            </div>
          `;
        }
      }
    }
    
    function renderCombinedStakeBreakdown(section, data) {
      const { totalSelfStake, totalDelegatedStake, totalSelfStakeEarnings, totalCommissionEarnings, totalAccounts, validatorBreakdowns, validatorCount } = data;
      const total = totalSelfStake + totalDelegatedStake;
      const selfPercent = total > 0 ? (totalSelfStake / total) * 100 : 0;
      const delegatedPercent = total > 0 ? (totalDelegatedStake / total) * 100 : 0;
      const totalEarnings = totalSelfStakeEarnings + totalCommissionEarnings;
      
      // Calculate portfolio APY (return on self-stake investment)
      const portfolioAPY = totalSelfStake > 0 ? (totalEarnings / totalSelfStake) * 100 : 8;
      
      // Pie chart with minimum visual threshold
      const circumference = 2 * Math.PI * 35;
      const MIN_VISUAL_PERCENT = 12;
      let selfVisual = selfPercent, delegatedVisual = delegatedPercent;
      if (selfPercent > 0 && delegatedPercent > 0) {
        if (selfPercent < MIN_VISUAL_PERCENT) {
          selfVisual = MIN_VISUAL_PERCENT;
          delegatedVisual = 100 - MIN_VISUAL_PERCENT;
        } else if (delegatedPercent < MIN_VISUAL_PERCENT) {
          delegatedVisual = MIN_VISUAL_PERCENT;
          selfVisual = 100 - MIN_VISUAL_PERCENT;
        }
      }
      const selfDash = (selfVisual / 100) * circumference;
      const delegatedDash = (delegatedVisual / 100) * circumference;
      
      section.innerHTML = `
        <div class="stake-inline-content">
          <div class="stake-inline-pie-row">
            <div class="stake-inline-pie">
              <svg width="90" height="90" viewBox="0 0 90 90" style="transform: rotate(-90deg);">
                <circle cx="45" cy="45" r="35" fill="none" stroke="var(--bg-card)" stroke-width="10"/>
                <circle cx="45" cy="45" r="35" fill="none" stroke="var(--accent-cyan)" stroke-width="10"
                  stroke-dasharray="${selfDash} ${circumference}" stroke-linecap="round"/>
                <circle cx="45" cy="45" r="35" fill="none" stroke="var(--accent-gold)" stroke-width="10"
                  stroke-dasharray="${delegatedDash} ${circumference}" stroke-dashoffset="-${selfDash}" stroke-linecap="round"/>
              </svg>
            </div>
            <div class="stake-inline-stats">
              <div class="stake-inline-stat">
                <span class="stake-inline-stat-label"><span style="color: var(--accent-cyan);">●</span> Total Self-Stake</span>
                <span class="stake-inline-stat-value">${formatNumber(totalSelfStake, 0)} XNT <span style="color: var(--text-dim); font-size: 0.75rem;">(${formatNumber(selfPercent, 1)}%)</span></span>
              </div>
              <div class="stake-inline-stat">
                <span class="stake-inline-stat-label"><span style="color: var(--accent-gold);">●</span> Total Delegated</span>
                <span class="stake-inline-stat-value">${formatNumber(totalDelegatedStake, 0)} XNT <span style="color: var(--text-dim); font-size: 0.75rem;">(${formatNumber(delegatedPercent, 1)}%)</span></span>
              </div>
              <div class="stake-inline-stat">
                <span class="stake-inline-stat-label">Validators / Accounts</span>
                <span class="stake-inline-stat-value">${validatorCount} / ${totalAccounts}</span>
              </div>
            </div>
          </div>
          
          <div class="stake-inline-earnings">
            <div class="stake-inline-apy-display">
              <div class="stake-inline-apy-label">Portfolio APY (7-day avg)</div>
              <div class="stake-inline-apy-value">${formatNumber(portfolioAPY, 2)}%</div>
              <div class="stake-inline-apy-note">Effective return on total self-stake</div>
            </div>
            <div class="stake-inline-earnings-title">
              💰 Est. Annual Combined Earnings
            </div>
            <div class="stake-inline-earnings-grid">
              <div class="stake-inline-earning">
                <div class="stake-inline-earning-value">${formatNumber(totalSelfStakeEarnings, 0)} XNT</div>
                <div class="stake-inline-earning-label">From Self-Stake (8% base)</div>
              </div>
              <div class="stake-inline-earning">
                <div class="stake-inline-earning-value">${formatNumber(totalCommissionEarnings, 0)} XNT</div>
                <div class="stake-inline-earning-label">From Commission</div>
              </div>
            </div>
            <div class="stake-inline-total">
              <span style="color: var(--text-secondary); font-size: 0.8rem;">Total: </span>
              <span style="color: var(--success); font-weight: 600; font-size: 1rem;">${formatNumber(totalEarnings, 0)} XNT/year</span>
            </div>
          </div>
          
          ${validatorBreakdowns.length > 0 ? `
          <div class="stake-inline-delegators">
            <div class="stake-inline-delegators-header">
              <span class="stake-inline-delegators-title">📊 Per Validator Breakdown</span>
            </div>
            ${validatorBreakdowns.map(v => {
              const baseRate = (v.baseAPY || 8) / 100;
              const vSelfEarnings = v.selfStake * baseRate;
              const vCommEarnings = v.delegatedStake * baseRate * (v.commission / 100);
              const vTotalEarnings = vSelfEarnings + vCommEarnings;
              const vAPY = v.selfStake > 0 ? (vTotalEarnings / v.selfStake) * 100 : (v.baseAPY || 8);
              return `
              <div class="stake-inline-delegator" style="flex-direction: column; align-items: flex-start; gap: 0.25rem;">
                <div style="display: flex; justify-content: space-between; width: 100%;">
                  <span style="font-weight: 500; color: var(--text-primary);">${escHtml(v.name)}</span>
                  <span style="font-weight: 600; background: linear-gradient(135deg, var(--accent-cyan), var(--accent-gold)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">${formatNumber(vAPY, 1)}%</span>
                </div>
                <div style="display: flex; gap: 1rem; font-size: 0.7rem;">
                  <span><span style="color: var(--accent-cyan);">●</span> Self: ${formatNumber(v.selfStake, 0)}</span>
                  <span><span style="color: var(--accent-gold);">●</span> Del: ${formatNumber(v.delegatedStake, 0)}</span>
                  <span style="color: var(--text-dim);">${v.commission}% comm</span>
                </div>
              </div>
            `}).join('')}
          </div>
          ` : ''}
          
          <div class="stake-inline-note">Aggregated from ${validatorCount} validators • Cached 5 min</div>
        </div>
      `;
    }

    // Toggle combined chart
    async function toggleCombinedChart(button) {
      const section = document.getElementById('combinedChartContainer');
      const isExpanded = section.classList.contains('expanded');
      
      if (isExpanded) {
        section.classList.remove('expanded');
        button.classList.remove('expanded');
      } else {
        // Close the combined stake details if it's open (mutually exclusive)
        const stakeSection = document.getElementById('combinedStakeContainer');
        if (stakeSection && stakeSection.classList.contains('expanded')) {
          stakeSection.classList.remove('expanded');
          const stakeBtn = button.parentElement.querySelector('.stake-details-btn');
          if (stakeBtn) stakeBtn.classList.remove('expanded');
        }
        
        section.classList.add('expanded');
        button.classList.add('expanded');
        
        // Initialize combined chart if not already done
        if (!chartInstances['combinedChart'] && window.combinedChartValidators) {
          const loadingEl = document.getElementById('combinedChart-loading');
          const titleEl = document.getElementById('combinedChart-title');
          const subtitleEl = document.getElementById('combinedChart-subtitle');
          
          // Show loading
          if (loadingEl) loadingEl.style.display = 'flex';
          
          // Fetch XNT rewards for all validators (vote account + self-stake) in parallel
          const validators = window.combinedChartValidators;
          const allRewards = {};
          const allEpochs = new Set();
          
          // Fetch all validators in parallel for better reliability
          const fetchValidatorRewards = async (validator) => {
            try {
              const rewards = await fetchTotalValidatorRewards(validator.voteAccount, validator.commission, 30);
              return { voteAccount: validator.voteAccount, name: validator.name, rewards: rewards || [] };
            } catch (e) {
              console.error(`Error fetching rewards for ${validator.name}:`, e);
              return { voteAccount: validator.voteAccount, name: validator.name, rewards: [] };
            }
          };
          
          let rewardResults = await Promise.all(validators.map(fetchValidatorRewards));
          
          // Check for validators that didn't return data and retry them
          const missingValidators = rewardResults.filter(r => !r.rewards || r.rewards.length === 0);
          if (missingValidators.length > 0 && missingValidators.length < validators.length) {
            console.log(`Retrying ${missingValidators.length} validators that didn't return data...`);
            // Small delay before retry
            await new Promise(resolve => setTimeout(resolve, 500));
            
            const retryResults = await Promise.all(
              missingValidators.map(m => {
                const validator = validators.find(v => v.voteAccount === m.voteAccount);
                return fetchValidatorRewards(validator);
              })
            );
            
            // Merge retry results
            retryResults.forEach(retryResult => {
              const idx = rewardResults.findIndex(r => r.voteAccount === retryResult.voteAccount);
              if (idx !== -1 && retryResult.rewards && retryResult.rewards.length > 0) {
                rewardResults[idx] = retryResult;
              }
            });
          }
          
          // Process results
          rewardResults.forEach(result => {
            if (result.rewards && result.rewards.length > 0) {
              allRewards[result.voteAccount] = {};
              result.rewards.forEach(r => {
                allRewards[result.voteAccount][r.epoch] = r.amount / 1e9;
                allEpochs.add(r.epoch);
              });
            }
          });
          
          // Sort epochs (fetchInflationRewards already excludes current epoch)
          let sortedEpochs = Array.from(allEpochs).sort((a, b) => a - b);
          sortedEpochs = sortedEpochs.slice(-30);
          
          // Store for chart initialization
          window.combinedChartXNTData = {
            epochs: sortedEpochs,
            rewards: allRewards,
            hasData: Object.keys(allRewards).length > 0
          };
          
          // Update title
          if (titleEl) titleEl.textContent = 'Combined XNT Rewards Trend';
          if (subtitleEl) subtitleEl.textContent = 'XNT earned per completed epoch for all validators';
          
          // Hide loading
          if (loadingEl) loadingEl.style.display = 'none';
          
          // Now initialize with XNT data
          initializeCombinedChartWithXNT();
        }
      }
    }

    function initializeChart(chartId) {
      const data = window.chartDataStore[chartId];
      if (!data || data.labels.length === 0) return;

      const ctx = document.getElementById(chartId);
      if (!ctx) return;

      // Destroy existing chart if any
      if (chartInstances[chartId]) {
        chartInstances[chartId].destroy();
      }

      const isXNT = data.type === 'xnt';
      
      // Get color from validatorColorMap if available (matches combined chart)
      let colorIndex = 0;
      if (window.validatorColorMap && data.voteAccount && window.validatorColorMap[data.voteAccount] !== undefined) {
        colorIndex = window.validatorColorMap[data.voteAccount];
      }
      const color = chartColors[colorIndex % chartColors.length];

      chartInstances[chartId] = new Chart(ctx, {
        type: 'line',
        data: {
          labels: data.labels,
          datasets: [{
            label: isXNT ? 'XNT Rewards' : 'Epoch Credits',
            data: data.data,
            borderColor: color.border,
            backgroundColor: color.bg,
            borderWidth: 2,
            fill: true,
            tension: 0.4,
            pointBackgroundColor: color.border,
            pointBorderColor: color.border,
            pointRadius: 3,
            pointHoverRadius: 6
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: false
            },
            tooltip: {
              backgroundColor: '#1a1d24',
              titleColor: '#ffffff',
              bodyColor: '#8a8f98',
              borderColor: '#2a2d35',
              borderWidth: 1,
              padding: 12,
              displayColors: false,
              callbacks: {
                title: function(items) {
                  return 'Epoch ' + items[0].label;
                },
                label: function(item) {
                  if (isXNT) {
                    return 'Earned: ' + formatNumber(item.raw, 2) + ' XNT';
                  }
                  return 'Credits: ' + formatNumber(item.raw, 0);
                }
              }
            }
          },
          scales: {
            x: {
              grid: {
                color: 'rgba(42, 45, 53, 0.5)',
                drawBorder: false
              },
              ticks: {
                color: '#5a5f68',
                font: {
                  size: 10
                },
                maxTicksLimit: 10
              }
            },
            y: {
              grid: {
                color: 'rgba(42, 45, 53, 0.5)',
                drawBorder: false
              },
              ticks: {
                color: '#5a5f68',
                font: {
                  size: 10
                },
                stepSize: isXNT ? 2 : undefined,
                callback: function(value) {
                  if (isXNT) {
                    return formatNumber(value, 1) + ' XNT';
                  }
                  return formatCompact(value);
                }
              }
            }
          },
          interaction: {
            intersect: false,
            mode: 'index'
          }
        }
      });
    }

    // Initialize combined chart with multiple lines
    function initializeCombinedChartWithXNT() {
      const validators = window.combinedChartValidators;
      const xntData = window.combinedChartXNTData;
      if (!validators || validators.length === 0 || !xntData) return;

      const ctx = document.getElementById('combinedChart');
      if (!ctx) return;

      // Destroy existing chart if any
      if (chartInstances['combinedChart']) {
        chartInstances['combinedChart'].destroy();
      }

      const datasets = [];
      const legendHtml = [];
      let maxValue = 0;
      
      validators.forEach((validator, index) => {
        const color = chartColors[index % chartColors.length];
        const dataMap = xntData.rewards[validator.voteAccount] || {};
        const data = xntData.epochs.map(epoch => dataMap[epoch] !== undefined ? dataMap[epoch] : null);
        
        // Track max value for dynamic stepSize
        data.forEach(v => { if (v !== null && v > maxValue) maxValue = v; });
        
        datasets.push({
          label: validator.name,
          data: data,
          borderColor: color.border,
          backgroundColor: color.bg,
          borderWidth: 2,
          fill: false,
          tension: 0.4,
          pointBackgroundColor: color.border,
          pointBorderColor: color.border,
          pointRadius: 2,
          pointHoverRadius: 5,
          spanGaps: true
        });
        
        legendHtml.push(`
          <div class="chart-legend-item">
            <div class="chart-legend-color" style="background: ${color.border}"></div>
            <span>${escHtml(validator.name)}</span>
          </div>
        `);
      });

      // Update legend
      document.getElementById('combinedChartLegend').innerHTML = legendHtml.join('');
      
      // Calculate appropriate stepSize based on data range
      // For max < 20: stepSize 2, for max < 50: stepSize 5, for max < 100: stepSize 10
      let stepSize = 2;
      if (maxValue > 100) stepSize = 20;
      else if (maxValue > 50) stepSize = 10;
      else if (maxValue > 20) stepSize = 5;

      chartInstances['combinedChart'] = new Chart(ctx, {
        type: 'line',
        data: {
          labels: xntData.epochs,
          datasets: datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: false
            },
            tooltip: {
              backgroundColor: '#1a1d24',
              titleColor: '#ffffff',
              bodyColor: '#8a8f98',
              borderColor: '#2a2d35',
              borderWidth: 1,
              padding: 12,
              callbacks: {
                title: function(items) {
                  return 'Epoch ' + items[0].label;
                },
                label: function(context) {
                  return context.dataset.label + ': ' + formatNumber(context.raw, 2) + ' XNT';
                }
              }
            }
          },
          scales: {
            x: {
              grid: { color: 'rgba(255, 255, 255, 0.05)' },
              ticks: { color: '#8a8f98' }
            },
            y: {
              grid: { color: 'rgba(255, 255, 255, 0.05)' },
              ticks: { 
                color: '#8a8f98',
                stepSize: stepSize,
                callback: function(value) {
                  return formatNumber(value, 1) + ' XNT';
                }
              }
            }
          }
        }
      });
    }

    function initializeCombinedChart() {
      const validators = window.combinedChartValidators;
      if (!validators || validators.length === 0) return;

      const ctx = document.getElementById('combinedChart');
      if (!ctx) return;

      // Destroy existing chart if any
      if (chartInstances['combinedChart']) {
        chartInstances['combinedChart'].destroy();
      }

      // Check if we have XNT rewards data
      let hasXNTData = false;
      validators.forEach(v => {
        const xntHistory = getValidatorRewardsHistory(v.voteAccount);
        if (xntHistory && xntHistory.length > 1) {
          hasXNTData = true;
        }
      });

      // Build datasets for each validator
      const datasets = [];
      const legendHtml = [];
      
      // Find common epoch range
      let allEpochs = new Set();
      
      if (hasXNTData) {
        // Use XNT rewards data
        validators.forEach(v => {
          const xntHistory = getValidatorRewardsHistory(v.voteAccount);
          if (xntHistory) {
            xntHistory.forEach(entry => {
              if (entry && entry.epoch) allEpochs.add(entry.epoch);
            });
          }
        });
      } else {
        // Use epoch credits - skip the most recent (current incomplete) epoch
        validators.forEach(v => {
          if (v.epochCreditsHistory && v.epochCreditsHistory.length > 1) {
            // Skip the last entry (current epoch) by iterating only up to length-1
            for (let i = 0; i < v.epochCreditsHistory.length - 1; i++) {
              const entry = v.epochCreditsHistory[i];
              if (entry && entry[0]) allEpochs.add(entry[0]);
            }
          }
        });
      }
      
      // Sort epochs and take last 30
      let sortedEpochs = Array.from(allEpochs).sort((a, b) => a - b);
      sortedEpochs = sortedEpochs.slice(-30);
      
      validators.forEach((validator, index) => {
        const color = chartColors[index % chartColors.length];
        
        // Build data map for this validator
        const dataMap = {};
        
        if (hasXNTData) {
          // Use XNT rewards data
          const xntHistory = getValidatorRewardsHistory(validator.voteAccount);
          if (xntHistory) {
            xntHistory.forEach(entry => {
              dataMap[entry.epoch] = entry.earned;
            });
          }
        } else {
          // Use epoch credits - skip the last entry (current incomplete epoch)
          if (validator.epochCreditsHistory && validator.epochCreditsHistory.length > 1) {
            for (let i = 0; i < validator.epochCreditsHistory.length - 1; i++) {
              const entry = validator.epochCreditsHistory[i];
              if (entry && entry.length >= 3) {
                const creditsEarned = entry[1] - entry[2];
                dataMap[entry[0]] = creditsEarned;
              }
            }
          }
        }
        
        // Build data array aligned to sortedEpochs
        const data = sortedEpochs.map(epoch => dataMap[epoch] !== undefined ? dataMap[epoch] : null);
        
        datasets.push({
          label: validator.name,
          data: data,
          borderColor: color.border,
          backgroundColor: color.bg,
          borderWidth: 2,
          fill: false,
          tension: 0.4,
          pointBackgroundColor: color.border,
          pointBorderColor: color.border,
          pointRadius: 2,
          pointHoverRadius: 5,
          spanGaps: true
        });
        
        legendHtml.push(`
          <div class="chart-legend-item">
            <div class="chart-legend-color" style="background: ${color.border}"></div>
            <span>${escHtml(validator.name)}</span>
          </div>
        `);
      });

      // Update legend
      document.getElementById('combinedChartLegend').innerHTML = legendHtml.join('');

      // Update chart title
      const chartTitle = document.querySelector('#combinedChartContainer .chart-title');
      const chartSubtitle = document.querySelector('#combinedChartContainer .chart-subtitle');
      if (chartTitle) chartTitle.textContent = hasXNTData ? 'Combined XNT Rewards Trend' : 'Combined Epoch Credits Trend';
      if (chartSubtitle) chartSubtitle.textContent = hasXNTData ? 'XNT earned per completed epoch for all validators' : 'Credits earned per completed epoch for all validators';

      chartInstances['combinedChart'] = new Chart(ctx, {
        type: 'line',
        data: {
          labels: sortedEpochs,
          datasets: datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: false
            },
            tooltip: {
              backgroundColor: '#1a1d24',
              titleColor: '#ffffff',
              bodyColor: '#8a8f98',
              borderColor: '#2a2d35',
              borderWidth: 1,
              padding: 12,
              callbacks: {
                title: function(items) {
                  return 'Epoch ' + items[0].label;
                },
                label: function(item) {
                  if (hasXNTData) {
                    return item.dataset.label + ': ' + formatNumber(item.raw, 2) + ' XNT';
                  }
                  return item.dataset.label + ': ' + formatNumber(item.raw, 0);
                }
              }
            }
          },
          scales: {
            x: {
              grid: {
                color: 'rgba(42, 45, 53, 0.5)',
                drawBorder: false
              },
              ticks: {
                color: '#5a5f68',
                font: {
                  size: 10
                },
                maxTicksLimit: 15
              }
            },
            y: {
              grid: {
                color: 'rgba(42, 45, 53, 0.5)',
                drawBorder: false
              },
              ticks: {
                color: '#5a5f68',
                font: {
                  size: 10
                },
                stepSize: hasXNTData ? 2 : undefined,
                callback: function(value) {
                  if (hasXNTData) {
                    return formatNumber(value, 1) + ' XNT';
                  }
                  return formatCompact(value);
                }
              }
            }
          },
          interaction: {
            intersect: false,
            mode: 'index'
          }
        }
      });
    }

    Actions.register({
      'stake-cancel':          (el, e, d) => cancelStakeLoad(d.vote, el),
      'stake-retry':           (el, e, d) => retryStakeLoad(d.vote, el),
      'stake-accounts-toggle': (el, e, d) => toggleAccountsList(d.list, el),
      'stake-apy-period':      (el, e, d) => updateAPYDisplay(el, d.vote),
      'stake-manage-classification': (el, e, d) => { e.stopPropagation(); openStakeSelection(d.vote, d.name); },
    });
