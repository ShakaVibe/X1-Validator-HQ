    // ========== COMPARE TOOL ==========
    let compareValidators = []; // Array of up to 4 validators
    let compareSearchTimeout = null;

    function handleCompareSearch() {
      const input = document.getElementById('compareSearchInput');
      const query = input.value.trim().toLowerCase();
      const resultsContainer = document.getElementById('compareSearchResults');

      clearTimeout(compareSearchTimeout);

      if (query.length < 2) {
        resultsContainer.classList.remove('active');
        return;
      }

      compareSearchTimeout = setTimeout(() => {
        if (!allValidators || allValidators.length === 0) {
          resultsContainer.innerHTML = '<div class="compare-search-result">Loading validators...</div>';
          resultsContainer.classList.add('active');
          return;
        }

        const matches = allValidators.filter(v => {
          const nameMatch = v.name.toLowerCase().includes(query);
          const addressMatch = v.votePubkey.toLowerCase().includes(query);
          const alreadyAdded = compareValidators.some(cv => cv.votePubkey === v.votePubkey);
          return (nameMatch || addressMatch) && !alreadyAdded;
        }).slice(0, 10);

        if (matches.length === 0) {
          resultsContainer.innerHTML = '<div class="compare-search-result" style="color: var(--text-dim);">No validators found</div>';
        } else {
          resultsContainer.innerHTML = matches.map(v => {
            const logoHtml = v.iconUrl
              ? `<img class="compare-search-result-logo" src="${safeUrl(v.iconUrl)}" data-onerror="img-fallback">
                 <div class="compare-search-result-logo-placeholder" style="display:none;">${escHtml(v.name.charAt(0).toUpperCase())}</div>`
              : `<div class="compare-search-result-logo-placeholder">${escHtml(v.name.charAt(0).toUpperCase())}</div>`;

            return `
              <div class="compare-search-result" data-action="compare-add" data-vote="${escHtml(v.votePubkey)}">
                ${logoHtml}
                <div class="compare-search-result-info">
                  <div class="compare-search-result-name">${escHtml(v.name)}</div>
                  <div class="compare-search-result-address">${v.votePubkey.slice(0, 8)}...${v.votePubkey.slice(-6)}</div>
                </div>
              </div>
            `;
          }).join('');
        }
        resultsContainer.classList.add('active');
      }, 200);
    }

    function focusCompareSearch() {
      document.getElementById('compareSearchInput').focus();
    }

    async function addToComparison(votePubkey) {
      if (compareValidators.length >= 4) {
        showToast('Maximum 4 validators can be compared');
        return;
      }

      if (compareValidators.some(v => v.votePubkey === votePubkey)) {
        showToast('Validator already added to comparison');
        return;
      }

      // Find validator in allValidators
      let validator = allValidators.find(v => v.votePubkey === votePubkey);
      if (!validator) {
        showToast('Validator not found');
        return;
      }

      // Get detailed info
      const detailedInfo = await getValidatorInfo(votePubkey);
      if (detailedInfo) {
        validator = { ...validator, ...detailedInfo };
      }

      // Fetch last epoch rewards
      try {
        // Fetch 3 epochs so we can fall back to the most recent indexed one
        // if the very latest isn't indexed by the RPC yet
        const rewards = await fetchTotalValidatorRewards(votePubkey, validator.commission || 0, 3);
        if (rewards && rewards.length > 0) {
          const latestIndexed = rewards.find(r => r.indexed);
          if (latestIndexed) {
            validator.lastEpochReward = latestIndexed.amount / 1e9; // Convert lamports to XNT
            validator.lastEpochRewardEpoch = latestIndexed.epoch;
          }
        }
      } catch (e) {
        console.warn('Could not fetch last epoch rewards for comparison:', e);
      }

      // Use cached performance score if available, otherwise calculate
      if (validator.performanceScore === undefined) {
        validator.performanceScore = calculatePerformanceScore(validator);
      }

      compareValidators.push(validator);
      
      // Clear search
      const searchInput = document.getElementById('compareSearchInput');
      const searchResults = document.getElementById('compareSearchResults');
      if (searchInput) searchInput.value = '';
      if (searchResults) searchResults.classList.remove('active');

      renderComparison();
      
      // Show helpful toast with count
      const count = compareValidators.length;
      if (count === 1) {
        showToast(`Added ${validator.name} to comparison. Add more validators to compare!`);
      } else if (count < 4) {
        showToast(`Added ${validator.name} (${count}/4). Go to Compare tab to see results.`);
      } else {
        showToast(`Added ${validator.name}. Comparison full (4/4)!`);
      }
    }

    function removeFromComparison(votePubkey) {
      compareValidators = compareValidators.filter(v => v.votePubkey !== votePubkey);
      renderComparison();
    }

    function clearComparison() {
      compareValidators = [];
      renderComparison();
    }

    function updateCompareCount() {
      const countEl = document.getElementById('compareCount');
      if (countEl) {
        countEl.textContent = compareValidators.length > 0 ? `(${compareValidators.length})` : '';
      }
    }

    function renderComparison() {
      updateCompareCount();
      if (typeof Router !== 'undefined') {
        const votes = compareValidators.map(v => v.votePubkey).filter(Boolean);
        Router.set(votes.length ? '/compare/' + votes.join(',') : '/compare');
      }
      const slotsContainer = document.getElementById('compareSlots');
      const tableContainer = document.getElementById('compareTableContainer');
      const emptyState = document.getElementById('compareEmptyState');

      // Render slots
      for (let i = 0; i < 4; i++) {
        const slot = document.getElementById(`compareSlot${i}`);
        const validator = compareValidators[i];

        if (validator) {
          const logoHtml = validator.iconUrl
            ? `<img class="compare-slot-logo" src="${safeUrl(validator.iconUrl)}" data-onerror="img-fallback">
               <div class="compare-slot-logo-placeholder" style="display:none;">${escHtml(validator.name.charAt(0).toUpperCase())}</div>`
            : `<div class="compare-slot-logo-placeholder">${escHtml(validator.name.charAt(0).toUpperCase())}</div>`;

          const scoreColor = getPerformanceBarColor(validator.performanceScore);

          slot.className = 'compare-slot filled';
          slot.onclick = null;
          slot.innerHTML = `
            <button class="compare-slot-remove" data-action="compare-remove" data-vote="${escHtml(validator.votePubkey)}">&times;</button>
            <div class="compare-slot-header">
              ${logoHtml}
              <div class="compare-slot-name">${escHtml(validator.name)}</div>
            </div>
            <div class="compare-slot-score" style="color: ${scoreColor}">${validator.performanceScore.toFixed(2)}</div>
            <div class="compare-slot-score-label">Performance Score</div>
          `;
        } else {
          slot.className = 'compare-slot empty';
          slot.onclick = focusCompareSearch;
          slot.innerHTML = `
            <div class="compare-slot-empty">
              <span class="compare-slot-plus">+</span>
              <span>Add Validator</span>
            </div>
          `;
        }
      }

      // Show/hide table and empty state
      if (compareValidators.length >= 2) {
        tableContainer.style.display = 'block';
        emptyState.style.display = 'none';
        renderComparisonTable();
      } else {
        tableContainer.style.display = 'none';
        emptyState.style.display = compareValidators.length === 0 ? 'block' : 'none';
      }
    }

    function renderComparisonTable() {
      const table = document.getElementById('compareTable');
      const cols = compareValidators.length;
      table.style.setProperty('--compare-cols', cols);

      // Define comparison metrics
      const metrics = [
        { 
          label: 'Performance Score', 
          getValue: v => v.performanceScore.toFixed(2),
          getRaw: v => v.performanceScore,
          higherIsBetter: true,
          getColor: v => getPerformanceBarColor(v.performanceScore)
        },
        { 
          label: 'Commission', 
          getValue: v => v.commission + '%',
          getRaw: v => v.commission,
          higherIsBetter: false,
          getColor: v => v.commission <= 5 ? 'var(--success)' : v.commission <= 10 ? 'var(--warning)' : 'var(--danger)'
        },
        { 
          label: 'Last Epoch Earned', 
          getValue: v => {
            if (v.lastEpochReward !== undefined) {
              return formatNumber(v.lastEpochReward, 2) + ' XNT';
            }
            return 'Loading...';
          },
          getRaw: v => v.lastEpochReward || 0,
          higherIsBetter: true,
          getColor: () => 'var(--success)'
        },
        { 
          label: 'Skip Rate (7d avg)', 
          getValue: v => {
            const rate = v.skipRateHistory?.avgSkipRate ?? v.skipRate;
            return rate !== null && rate !== undefined ? rate.toFixed(2) + '%' : 'N/A';
          },
          getRaw: v => v.skipRateHistory?.avgSkipRate ?? v.skipRate ?? 999,
          higherIsBetter: false,
          getColor: v => {
            const rate = v.skipRateHistory?.avgSkipRate ?? v.skipRate;
            if (rate === null || rate === undefined) return 'var(--text-dim)';
            if (rate <= 0.5) return 'var(--success)';
            if (rate <= 1) return 'var(--warning)';
            return 'var(--danger)';
          }
        },
        { 
          label: 'Epoch Credits', 
          getValue: v => {
            const credits = v.epochCredits || 0;
            return formatCompact(credits);
          },
          getRaw: v => v.epochCredits || 0,
          higherIsBetter: true,
          getColor: () => 'var(--accent-blue)'
        },
        { 
          label: 'Total Stake', 
          getValue: v => {
            // activatedStake could be in lamports (from allValidators) or XNT (from getValidatorInfo)
            const stake = v.activatedStake || 0;
            // If stake is very large (> 1 billion), it's in lamports
            const xnt = stake > 1e9 ? stake / 1e9 : stake;
            return formatCompact(xnt) + ' XNT';
          },
          getRaw: v => {
            const stake = v.activatedStake || 0;
            return stake > 1e9 ? stake / 1e9 : stake;
          },
          higherIsBetter: true,
          getColor: () => 'var(--accent-cyan)'
        },
        { 
          label: 'Rewards Balance', 
          getValue: v => formatNumber(v.rewardsBalance || 0, 2) + ' XNT',
          getRaw: v => v.rewardsBalance || 0,
          higherIsBetter: true,
          getColor: () => 'var(--warning)'
        },
        { 
          label: 'Status', 
          getValue: v => v.delinquent || v.isDelinquent ? 'Delinquent' : 'Active',
          getRaw: v => v.delinquent || v.isDelinquent ? 0 : 1,
          higherIsBetter: true,
          getColor: v => v.delinquent || v.isDelinquent ? 'var(--danger)' : 'var(--success)'
        },
        { 
          label: 'Version', 
          getValue: v => v.version || 'Unknown',
          getRaw: v => v.version || '',
          higherIsBetter: null, // No comparison
          getColor: v => isVersionOutdated(v.version) ? 'var(--warning)' : 'var(--text-primary)'
        },
        { 
          label: 'First Seen', 
          getValue: v => {
            // Show the first epoch we have data for
            // RPC only returns last 64 epochs, so if first epoch is 64+ ago, show "64+ epochs"
            if (v.epochCreditsHistory && v.epochCreditsHistory.length > 0) {
              const firstEpoch = v.epochCreditsHistory[0][0];
              const currentEpoch = v.epochCreditsHistory[v.epochCreditsHistory.length - 1][0];
              const epochsAgo = currentEpoch - firstEpoch;
              
              if (v.epochCreditsHistory.length >= 64) {
                return 'Epoch ' + firstEpoch + '+';
              } else {
                return 'Epoch ' + firstEpoch;
              }
            }
            return 'Unknown';
          },
          getRaw: v => {
            if (v.epochCreditsHistory && v.epochCreditsHistory.length > 0) {
              return v.epochCreditsHistory[0][0];
            }
            return 0;
          },
          higherIsBetter: null, // Not really comparable
          getColor: v => {
            if (!v.epochCreditsHistory || v.epochCreditsHistory.length === 0) return 'var(--text-dim)';
            // Green if they have full 64 epoch history (established)
            if (v.epochCreditsHistory.length >= 64) return 'var(--success)';
            // Yellow if newer (less than 64 epochs)
            if (v.epochCreditsHistory.length >= 10) return 'var(--warning)';
            return 'var(--text-dim)';
          }
        }
      ];

      // Find best values for each metric
      const bestValues = metrics.map(metric => {
        if (metric.higherIsBetter === null) return null;
        const values = compareValidators.map(v => metric.getRaw(v));
        if (metric.higherIsBetter) {
          return Math.max(...values);
        } else {
          return Math.min(...values);
        }
      });

      // Build table HTML
      let html = '';

      // Header row with validator names
      html += `<div class="compare-row compare-row-header">
        <div class="compare-cell compare-cell-label">Metric</div>
        ${compareValidators.map(v => `<div class="compare-cell compare-cell-value">${escHtml(v.name)}</div>`).join('')}
      </div>`;

      // Metric rows
      metrics.forEach((metric, idx) => {
        html += `<div class="compare-row">
          <div class="compare-cell compare-cell-label">${metric.label}</div>
          ${compareValidators.map(v => {
            const value = metric.getValue(v);
            const raw = metric.getRaw(v);
            const isBest = bestValues[idx] !== null && raw === bestValues[idx];
            const color = metric.getColor(v);
            return `<div class="compare-cell compare-cell-value ${isBest ? 'compare-cell-best' : ''}" style="color: ${color}">${value}</div>`;
          }).join('')}
        </div>`;
      });

      table.innerHTML = html;
    }

    function openCompareValidatorList() {
      openValidatorList('compare');
    }

    // Close compare search results when clicking outside
    document.addEventListener('click', function(e) {
      const searchBox = document.querySelector('.compare-search-box');
      const results = document.getElementById('compareSearchResults');
      if (searchBox && results && !searchBox.contains(e.target)) {
        results.classList.remove('active');
      }
    });

    

    Actions.register({
      'compare-add':    (el, e, d) => addToComparison(d.vote),
      'compare-remove': (el, e, d) => removeFromComparison(d.vote),
    });
