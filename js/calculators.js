    // =========================================
    // Calculator Functions
    // =========================================
    
    let calculatorsInitialized = false;
    let compoundChartInstance = null;
    let currentEpochData = null;
    
    // Fill the price inputs with the live XNT price unless the user typed one.
    function applyLiveXntPrice() {
      const price = window.xntPriceUsd;
      if (!(price > 0)) return;
      const v = price >= 1 ? price.toFixed(2) : price.toFixed(4);
      [['stakingPrice', 'renderStakingResults'], ['breakevenPrice', 'calculateBreakeven']].forEach(([id, fn]) => {
        const el = document.getElementById(id);
        if (!el || el.dataset.userSet === '1') return;
        if (el.value === v) return;
        el.value = v; el.placeholder = v;
        const panel = el.closest('.calculator-panel');
        if (panel && panel.classList.contains('active') && typeof window[fn] === 'function') { try { window[fn](); } catch (e) {} }
      });
    }
    window.applyLiveXntPrice = applyLiveXntPrice;

    function switchCalculator(calc) {
      if (typeof Router !== 'undefined') Router.set('/calculators/' + calc);
      applyLiveXntPrice();
      // Update nav buttons
      document.querySelectorAll('.calc-nav-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelector(`.calc-nav-btn[onclick="switchCalculator('${calc}')"]`).classList.add('active');
      
      // Show appropriate panel
      document.querySelectorAll('.calculator-panel').forEach(p => p.classList.remove('active'));
      
      const panelMap = {
        'staking': 'calcStaking',
        'compound': 'calcCompound',
        'unstaking': 'calcUnstaking',
        'breakeven': 'calcBreakeven'
      };
      
      document.getElementById(panelMap[calc]).classList.add('active');
      
      // Initialize specific calculator
      switch (calc) {
        case 'staking':
          onStakingValidatorChange();
          break;
        case 'compound':
          calculateCompoundGrowth();
          break;
        case 'unstaking':
          refreshEpochInfo();
          break;
        case 'breakeven':
          calculateBreakeven();
          break;
      }
    }
    
    let calculatorsPortfolioSig = '';
    async function initializeCalculators() {
      // Validators added to My Data Center after the first visit used to be
      // missing from the dropdowns for the rest of the session. Rebuild them
      // whenever the portfolio changed; bind the one-off listeners only once.
      const sig = (myPortfolio || []).slice().sort().join(',');
      if (calculatorsInitialized && sig === calculatorsPortfolioSig) return;
      const firstRun = !calculatorsInitialized;
      calculatorsPortfolioSig = sig;
      
      // Make sure we have network data loaded for validator info
      if (!allValidators || allValidators.length === 0) {
        await loadNetworkStats();
      }
      
      // Build portfolio options with names, then sort alphabetically
      let portfolioOptions = [];
      if (myPortfolio.length > 0) {
        portfolioOptions = myPortfolio.map(voteAccount => {
          // Try to get name from cache or allValidators
          let name = voteAccount.slice(0, 8) + '...';
          if (validatorInfoCache[voteAccount]) {
            name = validatorInfoCache[voteAccount].name;
          } else if (allValidators) {
            const v = allValidators.find(v => v.votePubkey === voteAccount);
            if (v) name = v.name || v.votePubkey.slice(0, 8) + '...';
          }
          return { voteAccount, name };
        });
        
        // Sort alphabetically by name
        portfolioOptions.sort((a, b) => a.name.localeCompare(b.name));
      }
      
      const portfolioOptionsHtml = portfolioOptions.map(opt => 
        `<option value="${opt.voteAccount}">${escHtml(opt.name)}</option>`
      ).join('');
      
      // Populate staking calculator validator dropdown
      const stakingSelect = document.getElementById('stakingValidator');
      if (myPortfolio.length > 0) {
        stakingSelect.innerHTML = '<option value="">-- Select from your Data Center --</option><option value="custom">📝 Custom / New Validator</option>' + portfolioOptionsHtml;
      } else {
        stakingSelect.innerHTML = '<option value="">-- No validators in Data Center --</option><option value="custom">📝 Custom / New Validator</option>';
      }
      
      // Populate compound calculator validator dropdown
      const compoundSelect = document.getElementById('compoundValidator');
      if (myPortfolio.length > 0) {
        compoundSelect.innerHTML = '<option value="">-- Select from your Data Center --</option><option value="custom">✏️ Custom Values</option>' + portfolioOptionsHtml;
      } else {
        compoundSelect.innerHTML = '<option value="">-- No validators in Data Center --</option><option value="custom">✏️ Custom Values</option>';
      }
      
      // Populate breakeven calculator validator dropdown
      const breakevenSelect = document.getElementById('breakevenValidator');
      if (myPortfolio.length > 0) {
        breakevenSelect.innerHTML = '<option value="">-- Select from your Data Center --</option><option value="custom">✏️ Custom Values</option>' + portfolioOptionsHtml;
      } else {
        breakevenSelect.innerHTML = '<option value="">-- No validators in Data Center --</option><option value="custom">✏️ Custom Values</option>';
      }
      
      if (firstRun) {
        // Initialize all calculators with default values (show empty states)
        onStakingValidatorChange();
        calculateCompoundGrowth();
        calculateBreakeven();

        // Setup unstaking when dropdown
        document.getElementById('unstakingWhen').addEventListener('change', function() {
          const customInput = document.getElementById('unstakingCustomEpoch');
          customInput.style.display = this.value === 'custom' ? 'block' : 'none';
        });
      }
      
      calculatorsInitialized = true;
    }
    
    // ===== STAKING REWARDS CALCULATOR =====
    let stakingCurrency = 'xnt'; // 'xnt' or 'usd'
    let stakingCalcData = { currentStake: 0, commission: 0, selfStake: 0, delegatedStake: 0 };
    let stakingProjectionPeriod = 'yearly'; // 'yearly' or 'monthly'
    let stakingRealRewardsData = null;
    
    function formatStakingInput(input) {
      let value = input.value.replace(/[^0-9.]/g, '');
      if (value) {
        const num = parseFloat(value);
        if (!isNaN(num)) {
          input.value = num.toLocaleString('en-US');
        }
      }
    }
    
    function toggleStakingCurrency(currency, button) {
      stakingCurrency = currency;
      document.querySelectorAll('#stakingCurrencyToggle .calc-currency-btn').forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      renderStakingResults();
    }
    
    async function onStakingValidatorChange() {
      const validatorSelect = document.getElementById('stakingValidator');
      const resultsContent = document.getElementById('stakingResultsContent');
      const apyGroup = document.getElementById('stakingApyGroup');
      const customSelfGroup = document.getElementById('stakingCustomSelfGroup');
      const customDelegatedGroup = document.getElementById('stakingCustomDelegatedGroup');
      const customCommGroup = document.getElementById('stakingCustomCommGroup');
      const simInputs = document.getElementById('stakingSimInputs');
      const currencyToggle = document.getElementById('stakingCurrencyToggle');
      
      // Handle custom mode
      if (validatorSelect.value === 'custom') {
        apyGroup.style.display = 'block';
        customSelfGroup.style.display = 'block';
        customDelegatedGroup.style.display = 'block';
        customCommGroup.style.display = 'block';
        simInputs.style.display = 'none';
        currencyToggle.style.display = 'flex';
        document.getElementById('stakingCurrentStake').textContent = 'Enter your validator details below';
        stakingRealRewardsData = null;
        stakingCalcData = { currentStake: 0, commission: 0, selfStake: 0, delegatedStake: 0, isCustom: true };
        renderStakingResults();
        return;
      }
      
      // Hide custom inputs for real validators
      apyGroup.style.display = 'none';
      customSelfGroup.style.display = 'none';
      customDelegatedGroup.style.display = 'none';
      customCommGroup.style.display = 'none';
      stakingCalcData.isCustom = false;
      
      // If no validator selected, show empty state
      if (!validatorSelect.value) {
        simInputs.style.display = 'none';
        currencyToggle.style.display = 'none';
        stakingRealRewardsData = null;
        resultsContent.innerHTML = `
          <div class="calc-empty-state">
            <div class="calc-empty-icon">💰</div>
            <div class="calc-empty-text">Select a validator to see current earnings and simulate growth</div>
          </div>
        `;
        document.getElementById('stakingCurrentStake').textContent = 'Select a validator or use custom mode';
        return;
      }
      
      // Get current stake and commission from validator selection
      let currentStake = 0;
      let commission = 0;
      let validatorName = '';
      if (validatorInfoCache[validatorSelect.value]) {
        currentStake = validatorInfoCache[validatorSelect.value].activatedStake || 0;
        commission = validatorInfoCache[validatorSelect.value].commission || 0;
        validatorName = validatorInfoCache[validatorSelect.value].name || '';
      } else if (allValidators) {
        const validator = allValidators.find(v => v.votePubkey === validatorSelect.value);
        if (validator) {
          currentStake = validator.activatedStake / 1e9;
          commission = validator.commission || 0;
          validatorName = validator.name || '';
        }
      }
      
      stakingCalcData.currentStake = currentStake;
      stakingCalcData.commission = commission;
      stakingCalcData.validatorName = validatorName;
      
      // Show simulation inputs and currency toggle
      simInputs.style.display = 'block';
      currencyToggle.style.display = 'flex';
      
      // Check if we have stake breakdown data for this validator
      let breakdownData = window.stakeBreakdownData && window.stakeBreakdownData[validatorSelect.value];
      
      // If no breakdown data, auto-fetch it
      if (!breakdownData) {
        document.getElementById('stakingCurrentStake').innerHTML = `
          <span style="color: var(--text-secondary);">Loading stake breakdown...</span>
        `;
        
        // Fetch breakdown in background
        try {
          breakdownData = await fetchStakeBreakdownForCalc(validatorSelect.value, commission);
          if (breakdownData) {
            if (!window.stakeBreakdownData) window.stakeBreakdownData = {};
            window.stakeBreakdownData[validatorSelect.value] = breakdownData;
          }
        } catch (e) {
          console.warn('Could not auto-fetch breakdown:', e);
        }
      }
      
      if (breakdownData) {
        stakingCalcData.selfStake = breakdownData.selfStake;
        stakingCalcData.delegatedStake = breakdownData.delegatedStake;
        stakingCalcData.hasBreakdown = true;
        document.getElementById('stakingCurrentStake').innerHTML = `
          <span style="color: var(--success);">✓ Stake breakdown loaded</span> - 
          Self: ${formatNumber(breakdownData.selfStake, 0)} | Delegated: ${formatNumber(breakdownData.delegatedStake, 0)} | Commission: ${commission}%
          <span style="color: var(--accent-cyan); cursor: pointer; margin-left: 0.5rem;" onclick="openStakeBreakdown('${escAttrJs(validatorSelect.value)}', '${escAttrJs(validatorName)}', ${Number(currentStake) || 0}, ${Number(commission) || 0})">🔍</span>
        `;
      } else {
        stakingCalcData.selfStake = 0;
        stakingCalcData.delegatedStake = 0;
        stakingCalcData.hasBreakdown = false;
        document.getElementById('stakingCurrentStake').innerHTML = `
          Total stake: ${formatNumber(currentStake, 0)} XNT | Commission: ${commission}%
          <span style="color: var(--accent-gold); cursor: pointer; margin-left: 0.5rem;" onclick="fetchAndShowBreakdown('${escAttrJs(validatorSelect.value)}', '${escAttrJs(validatorName)}', ${Number(currentStake) || 0}, ${Number(commission) || 0})">🔍 Retry</span>
        `;
      }
      
      // Show loading while fetching real data
      resultsContent.innerHTML = `
        <div class="calc-loading">
          <div class="loading-spinner-small"></div>
          <span>Fetching validator data...</span>
        </div>
      `;
      
      // Fetch real rewards data (vote account + self-stake rewards)
      try {
        const rewards = await fetchTotalValidatorRewards(validatorSelect.value, commission, 7);
        if (rewards && rewards.length > 0) {
          const totalRewardsXNT = rewards.reduce((sum, r) => sum + r.amount, 0) / 1e9;
          const avgEpochRewardsXNT = totalRewardsXNT / rewards.length;
          
          // Calculate actual APY from real data
          const actualAPY = currentStake > 0 ? (avgEpochRewardsXNT * epochsPerYear() / currentStake) * 100 : 0;
          
          stakingRealRewardsData = {
            avgEpoch: avgEpochRewardsXNT,
            totalFetched: totalRewardsXNT,
            epochs: rewards.length,
            actualAPY: actualAPY
          };
        } else {
          stakingRealRewardsData = null;
        }
      } catch (err) {
        console.error('Failed to fetch real rewards:', err);
        stakingRealRewardsData = null;
      }
      
      renderStakingResults();
    }
    
    // Fetch stake breakdown data for calculator (without opening modal)
    async function fetchStakeBreakdownForCalc(voteAccount, commission) {
      try {
        // Fetch all stake accounts for this validator
        const response = await fetch(RPC_URL, {
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
                filters: [{ memcmp: { offset: 124, bytes: voteAccount } }]
              }
            ]
          })
        });
        
        const data = await response.json();
        if (!data.result || data.result.length === 0) return null;
        
        // Get vote account's authorized withdrawer for matching
        let voteAccountWithdrawer = null;
        try {
          const voteAcctResponse = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'getAccountInfo',
              params: [voteAccount, { encoding: 'jsonParsed' }]
            })
          });
          
          const voteAcctData = await voteAcctResponse.json();
          if (voteAcctData.result?.value?.data?.parsed?.info) {
            voteAccountWithdrawer = voteAcctData.result.value.data.parsed.info.authorizedWithdrawer;
          }
        } catch (e) {
          console.warn('Could not fetch vote account withdrawer:', e);
        }
        
        // Parse stake accounts
        const stakeAccounts = data.result.map(acc => {
          const stakeInfo = acc.account.data.parsed?.info;
          const meta = stakeInfo?.meta;
          return {
            pubkey: acc.pubkey,
            stakeXNT: acc.account.lamports / 1e9,
            withdrawer: meta?.authorized?.withdrawer || null
          };
        });
        
        // Check for user selections first
        const userSelections = getSelfStakeSelections(voteAccount);
        
        let selfStake = 0;
        let delegatedStake = 0;
        
        if (hasUserClassification(userSelections)) {
          const selectedPubkeys = new Set(userSelections.pubkeys);
          stakeAccounts.forEach(acc => {
            if (selectedPubkeys.has(acc.pubkey)) {
              selfStake += acc.stakeXNT;
            } else {
              delegatedStake += acc.stakeXNT;
            }
          });
        } else if (voteAccountWithdrawer) {
          // Use withdrawer matching
          stakeAccounts.forEach(acc => {
            if (acc.withdrawer === voteAccountWithdrawer) {
              selfStake += acc.stakeXNT;
            } else {
              delegatedStake += acc.stakeXNT;
            }
          });
        } else {
          // Fallback - treat all as delegated
          stakeAccounts.forEach(acc => {
            delegatedStake += acc.stakeXNT;
          });
        }
        
        return { selfStake, delegatedStake };
      } catch (e) {
        console.error('Error fetching breakdown for calc:', e);
        return null;
      }
    }
    
    // Helper function to fetch breakdown and update calculator
    async function fetchAndShowBreakdown(voteAccount, validatorName, totalStake, commission) {
      // Open the breakdown modal which will fetch and cache the data
      await openStakeBreakdown(voteAccount, validatorName, totalStake, commission);
      
      // After modal closes, the data should be cached - refresh the calculator
      setTimeout(() => {
        onStakingValidatorChange();
      }, 500);
    }
    
    function renderStakingResults() {
      const validatorSelect = document.getElementById('stakingValidator');
      const resultsContent = document.getElementById('stakingResultsContent');
      const currencyToggle = document.getElementById('stakingCurrencyToggle');
      const priceInput = document.getElementById('stakingPrice');
      
      const xntPrice = parseFloat(priceInput.value) || 1.00;
      
      // Helper to format value based on currency selection
      const formatValue = (xntAmount, decimals = 2) => {
        if (stakingCurrency === 'usd') {
          return '$' + formatNumber(xntAmount * xntPrice, decimals);
        }
        return formatNumber(xntAmount, decimals) + ' XNT';
      };
      
      // Handle custom mode
      if (validatorSelect.value === 'custom') {
        const apyInput = document.getElementById('stakingApy');
        const selfInput = document.getElementById('stakingCustomSelf');
        const delegatedInput = document.getElementById('stakingCustomDelegated');
        const commInput = document.getElementById('stakingCustomComm');
        
        const apy = parseFloat(apyInput.value) || 0;
        const selfStakeStr = selfInput.value.replace(/,/g, '');
        const delegatedStakeStr = delegatedInput.value.replace(/,/g, '');
        const selfStake = parseFloat(selfStakeStr) || 0;
        const delegatedStake = parseFloat(delegatedStakeStr) || 0;
        const commission = parseFloat(commInput.value) || 0;
        const totalStake = selfStake + delegatedStake;
        
        if (totalStake <= 0) {
          resultsContent.innerHTML = `
            <div class="calc-empty-state">
              <div class="calc-empty-icon">📝</div>
              <div class="calc-empty-text">Enter your self-stake and/or delegated amounts to see estimated rewards</div>
            </div>
          `;
          return;
        }
        
        // Calculate percentages
        const selfPercent = totalStake > 0 ? (selfStake / totalStake * 100).toFixed(0) : 0;
        const delegatedPercent = totalStake > 0 ? (delegatedStake / totalStake * 100).toFixed(0) : 0;
        
        // Calculate earnings
        const selfStakeEarnings = selfStake * (apy / 100);
        const commissionEarnings = delegatedStake * (apy / 100) * (commission / 100);
        const totalEarnings = selfStakeEarnings + commissionEarnings;
        
        resultsContent.innerHTML = `
          <div class="calc-current-breakdown">
            <div class="calc-breakdown-title">📝 Custom Validator Estimate</div>
            <div class="calc-breakdown-grid">
              <div class="calc-breakdown-item self">
                <div class="calc-breakdown-value">${formatNumber(selfStake, 0)}</div>
                <div class="calc-breakdown-label">Self-Stake (${selfPercent}%)</div>
              </div>
              <div class="calc-breakdown-item delegated">
                <div class="calc-breakdown-value">${formatNumber(delegatedStake, 0)}</div>
                <div class="calc-breakdown-label">Delegated (${delegatedPercent}%)</div>
              </div>
            </div>
          </div>
          
          <div class="calc-earnings-section">
            <div class="calc-earnings-title">💰 Estimated Annual Earnings</div>
            <div class="calc-earnings-row">
              <span class="calc-earnings-label">From Self-Stake (${apy}% APY)</span>
              <span class="calc-earnings-value">${formatValue(selfStakeEarnings)}</span>
            </div>
            <div class="calc-earnings-row">
              <span class="calc-earnings-label">From ${commission}% Commission</span>
              <span class="calc-earnings-value">${formatValue(commissionEarnings)}</span>
            </div>
            <div class="calc-earnings-row total">
              <span class="calc-earnings-label">Total Validator Earnings</span>
              <span class="calc-earnings-value">${formatValue(totalEarnings)}/year</span>
            </div>
          </div>
        `;
        return;
      }
      
      // If no validator selected
      if (!validatorSelect.value) {
        currencyToggle.style.display = 'none';
        return;
      }
      
      const { currentStake, commission, selfStake, delegatedStake, hasBreakdown, validatorName } = stakingCalcData;
      
      // Get simulation inputs
      const addSelfInput = document.getElementById('stakingAddSelf');
      const addDelegationInput = document.getElementById('stakingAddDelegation');
      const addSelfStr = addSelfInput ? addSelfInput.value.replace(/,/g, '') : '0';
      const addDelegationStr = addDelegationInput ? addDelegationInput.value.replace(/,/g, '') : '0';
      const addSelf = parseFloat(addSelfStr) || 0;
      const addDelegation = parseFloat(addDelegationStr) || 0;
      
      // Calculate actual APY from real rewards data
      let actualAPY = 8; // Default fallback
      if (stakingRealRewardsData && stakingRealRewardsData.actualAPY) {
        actualAPY = stakingRealRewardsData.actualAPY;
      }
      
      // For self-stake, APY is the full network rate (we derive it from actual data)
      // The validator's total rewards include: 100% of self-stake rewards + commission% of delegated stake rewards
      // So: totalRewards = selfStake * baseAPY + delegatedStake * baseAPY * (commission/100)
      // We know totalRewards from real data, and if we have breakdown, we can solve for baseAPY
      
      let baseAPY = 8; // Default network base APY
      if (hasBreakdown && stakingRealRewardsData && selfStake > 0) {
        const totalAnnualRewards = stakingRealRewardsData.avgEpoch * epochsPerYear();
        // totalRewards = selfStake * baseAPY + delegatedStake * baseAPY * (commission/100)
        // totalRewards = baseAPY * (selfStake + delegatedStake * commission/100)
        const divisor = selfStake + (delegatedStake * commission / 100);
        if (divisor > 0) {
          baseAPY = (totalAnnualRewards / divisor) * 100;
        }
      }
      
      // Current earnings breakdown
      const currentSelfEarnings = selfStake * (baseAPY / 100);
      const currentCommissionEarnings = delegatedStake * (baseAPY / 100) * (commission / 100);
      const currentTotalEarnings = currentSelfEarnings + currentCommissionEarnings;
      
      // Calculate Validator APY = total earnings / self-stake (effective return on investment)
      const validatorAPY = selfStake > 0 ? (currentTotalEarnings / selfStake) * 100 : baseAPY;
      
      // Projected earnings with new stake
      const newSelfStake = selfStake + addSelf;
      const newDelegatedStake = delegatedStake + addDelegation;
      const newTotalStake = newSelfStake + newDelegatedStake;
      
      const projectedSelfEarnings = newSelfStake * (baseAPY / 100);
      const projectedCommissionEarnings = newDelegatedStake * (baseAPY / 100) * (commission / 100);
      const projectedTotalEarnings = projectedSelfEarnings + projectedCommissionEarnings;
      
      const earningsIncrease = projectedTotalEarnings - currentTotalEarnings;
      const earningsIncreasePercent = currentTotalEarnings > 0 ? (earningsIncrease / currentTotalEarnings) * 100 : 0;
      
      let html = '';
      
      // Show warning if no breakdown data
      if (!hasBreakdown) {
        html += `
          <div class="calc-no-breakdown-note">
            <span>⚠️</span>
            <span>Stake breakdown not loaded. Click "🔍 Load breakdown" above for accurate self-stake vs delegation data. Currently using estimates.</span>
          </div>
        `;
      }
      
      // Current Stake Breakdown
      html += `
        <div class="calc-current-breakdown">
          <div class="calc-breakdown-title">
            📊 Current Stake Breakdown
            <span class="calc-apy-badge">📈 ${formatNumber(validatorAPY, 2)}% Validator APY <span style="font-size: 0.7rem; opacity: 0.8;">(7-day avg)</span></span>
          </div>
          <div class="calc-breakdown-grid">
            <div class="calc-breakdown-item self">
              <div class="calc-breakdown-value">${formatNumber(selfStake, 0)}</div>
              <div class="calc-breakdown-label">👤 Self-Stake</div>
            </div>
            <div class="calc-breakdown-item delegated">
              <div class="calc-breakdown-value">${formatNumber(delegatedStake, 0)}</div>
              <div class="calc-breakdown-label">🤝 Delegated</div>
            </div>
          </div>
        </div>
      `;
      
      // Current Earnings
      html += `
        <div class="calc-earnings-section">
          <div class="calc-earnings-title">💰 Current Annual Earnings</div>
          <div class="calc-earnings-row">
            <span class="calc-earnings-label">From Self-Stake (${formatNumber(baseAPY, 2)}% base APY)</span>
            <span class="calc-earnings-value">${formatValue(currentSelfEarnings)}</span>
          </div>
          <div class="calc-earnings-row">
            <span class="calc-earnings-label">From ${commission}% Commission on Delegations</span>
            <span class="calc-earnings-value">${formatValue(currentCommissionEarnings)}</span>
          </div>
          <div class="calc-earnings-row total">
            <span class="calc-earnings-label">Total Validator Earnings</span>
            <span class="calc-earnings-value">${formatValue(currentTotalEarnings)}/year</span>
          </div>
        </div>
      `;
      
      // Show projection if user entered simulation values
      if (addSelf > 0 || addDelegation > 0) {
        const isMonthly = stakingProjectionPeriod === 'monthly';
        const periodDivisor = isMonthly ? 12 : 1;
        const periodLabel = isMonthly ? '/month' : '/year';
        
        const displayCurrentEarnings = currentTotalEarnings / periodDivisor;
        const displayProjectedEarnings = projectedTotalEarnings / periodDivisor;
        const displayEarningsIncrease = earningsIncrease / periodDivisor;
        
        html += `
          <div class="calc-projection-section">
            <div class="calc-projection-title">
              📈 Projected After Adding Stake
              <div class="calc-toggle">
                <button class="calc-toggle-btn ${!isMonthly ? 'active' : ''}" onclick="setProjectionPeriod('yearly')">Year</button>
                <button class="calc-toggle-btn ${isMonthly ? 'active' : ''}" onclick="setProjectionPeriod('monthly')">Month</button>
              </div>
            </div>
            
            <div class="calc-projection-comparison">
              <div class="calc-projection-box">
                <div class="calc-projection-value">${formatValue(displayCurrentEarnings)}</div>
                <div class="calc-projection-label">Current ${periodLabel}</div>
              </div>
              <div class="calc-projection-arrow">→</div>
              <div class="calc-projection-box new">
                <div class="calc-projection-value">${formatValue(displayProjectedEarnings)}</div>
                <div class="calc-projection-label">Projected ${periodLabel}</div>
              </div>
            </div>
            
            <div class="calc-earnings-row">
              <span class="calc-earnings-label">New Self-Stake Total</span>
              <span class="calc-earnings-value">${formatNumber(newSelfStake, 0)} XNT</span>
            </div>
            <div class="calc-earnings-row">
              <span class="calc-earnings-label">New Delegated Total</span>
              <span class="calc-earnings-value">${formatNumber(newDelegatedStake, 0)} XNT</span>
            </div>
            <div class="calc-earnings-row" style="color: var(--success);">
              <span class="calc-earnings-label">Earnings Increase${isMonthly ? ' (monthly)' : ''}</span>
              <span class="calc-earnings-value">+${formatValue(displayEarningsIncrease)} (+${formatNumber(earningsIncreasePercent, 1)}%)</span>
            </div>
        `;
        
        // Show breakdown of increase
        if (addSelf > 0) {
          const addSelfEarnings = (addSelf * (baseAPY / 100)) / periodDivisor;
          html += `
            <div class="calc-earnings-row" style="font-size: 0.75rem; color: var(--text-dim);">
              <span class="calc-earnings-label">└ From +${formatNumber(addSelf, 0)} self-stake</span>
              <span class="calc-earnings-value">+${formatValue(addSelfEarnings)}</span>
            </div>
          `;
        }
        if (addDelegation > 0) {
          const addDelegationEarnings = (addDelegation * (baseAPY / 100) * (commission / 100)) / periodDivisor;
          html += `
            <div class="calc-earnings-row" style="font-size: 0.75rem; color: var(--text-dim);">
              <span class="calc-earnings-label">└ From +${formatNumber(addDelegation, 0)} delegation (${commission}% comm)</span>
              <span class="calc-earnings-value">+${formatValue(addDelegationEarnings)}</span>
            </div>
          `;
        }
        
        html += `</div>`;
      }
      
      // Real data note
      if (stakingRealRewardsData) {
        html += `
          <div class="calc-actual-note" style="margin-top: 1rem;">
            📊 APY calculated from actual reward data (last ${stakingRealRewardsData.epochs} days)
          </div>
        `;
      }
      
      resultsContent.innerHTML = html;
    }
    
    function setProjectionPeriod(period) {
      stakingProjectionPeriod = period;
      renderStakingResults();
    }
    
    // ===== COMPOUND GROWTH CALCULATOR =====
    let compoundValidatorStake = 0;
    let compoundRealRewardsData = null;
    
    function formatCompoundInput(input) {
      let value = input.value.replace(/[^0-9.]/g, '');
      if (value) {
        const num = parseFloat(value);
        if (!isNaN(num)) {
          input.value = num.toLocaleString('en-US');
        }
      }
    }
    
    async function onCompoundValidatorChange() {
      const validatorSelect = document.getElementById('compoundValidator');
      const initialGroup = document.getElementById('compoundInitialGroup');
      const apyGroup = document.getElementById('compoundAPYGroup');
      const hintEl = document.getElementById('compoundValidatorHint');
      const resultsContent = document.getElementById('compoundResultsContent');
      
      if (validatorSelect.value === 'custom') {
        // Show manual inputs for custom
        initialGroup.style.display = 'block';
        apyGroup.style.display = 'block';
        hintEl.textContent = 'Enter your custom stake amount and APY above';
        compoundValidatorStake = 0;
        compoundRealRewardsData = null;
        calculateCompoundGrowth();
      } else if (validatorSelect.value) {
        // Hide manual inputs for validator
        initialGroup.style.display = 'none';
        apyGroup.style.display = 'none';
        
        let stake = 0;
        let commission = 0;
        if (validatorInfoCache[validatorSelect.value]) {
          stake = validatorInfoCache[validatorSelect.value].activatedStake || 0;
          commission = validatorInfoCache[validatorSelect.value].commission || 0;
        } else if (allValidators) {
          const validator = allValidators.find(v => v.votePubkey === validatorSelect.value);
          if (validator) {
            stake = validator.activatedStake / 1e9;
            commission = validator.commission || 0;
          }
        }
        compoundValidatorStake = stake;
        hintEl.textContent = `Current stake: ${formatNumber(stake, 0)} XNT`;
        
        // Show loading
        resultsContent.innerHTML = `
          <div class="calc-loading">
            <div class="loading-spinner-small"></div>
            <span>Fetching stake breakdown...</span>
          </div>
        `;
        
        // Fetch stake breakdown to calculate validator APY
        let selfStake = 0;
        let delegatedStake = 0;
        
        try {
          // Check cache first
          let breakdownData = window.stakeBreakdownData && window.stakeBreakdownData[validatorSelect.value];
          
          if (!breakdownData) {
            // Fetch breakdown
            breakdownData = await fetchStakeBreakdownForCalc(validatorSelect.value, commission);
            if (breakdownData) {
              if (!window.stakeBreakdownData) window.stakeBreakdownData = {};
              window.stakeBreakdownData[validatorSelect.value] = breakdownData;
            }
          }
          
          if (breakdownData) {
            selfStake = breakdownData.selfStake || 0;
            delegatedStake = breakdownData.delegatedStake || 0;
          }
        } catch (e) {
          console.warn('Could not fetch stake breakdown:', e);
        }
        
        // Fetch real rewards data (vote account + self-stake rewards)
        try {
          const rewards = await fetchTotalValidatorRewards(validatorSelect.value, commission, 7);
          if (rewards && rewards.length > 0) {
            // Convert from lamports to XNT (divide by 1e9)
            const totalRewardsXNT = rewards.reduce((sum, r) => sum + r.amount, 0) / 1e9;
            const avgEpochRewardsXNT = totalRewardsXNT / rewards.length;

            // Calculate validator's effective APY using derived base APY
            // totalRewards = selfStake * baseAPY + delegatedStake * baseAPY * (commission/100)
            // totalRewards = baseAPY * (selfStake + delegatedStake * commission/100)
            // Solve for baseAPY:
            const totalAnnualRewards = avgEpochRewardsXNT * epochsPerYear();
            const divisor = selfStake + (delegatedStake * commission / 100);
            let baseAPY = 8; // Default
            if (divisor > 0) {
              baseAPY = (totalAnnualRewards / divisor) * 100;
            }

            // Now calculate earnings with derived baseAPY
            const selfStakeEarnings = selfStake * (baseAPY / 100);
            const commissionEarnings = delegatedStake * (baseAPY / 100) * (commission / 100);
            const totalValidatorEarnings = selfStakeEarnings + commissionEarnings;

            // Effective APY = total earnings / self-stake (their investment)
            const validatorAPY = selfStake > 0 ? (totalValidatorEarnings / selfStake) * 100 : baseAPY;

            compoundRealRewardsData = {
              avgDaily: totalAnnualRewards / 365.25,
              avgAnnual: totalAnnualRewards,
              validatorAPY: validatorAPY,
              baseAPY: baseAPY,
              selfStake: selfStake,
              delegatedStake: delegatedStake,
              commission: commission,
              epochs: rewards.length
            };
            
            // Update hint to show self-stake
            if (selfStake > 0) {
              hintEl.textContent = `Self-stake: ${formatNumber(selfStake, 0)} XNT • Delegated: ${formatNumber(delegatedStake, 0)} XNT`;
            }
          } else {
            compoundRealRewardsData = null;
          }
        } catch (err) {
          console.error('Failed to fetch real rewards:', err);
          compoundRealRewardsData = null;
        }
        
        calculateCompoundGrowth();
      } else {
        // No selection
        initialGroup.style.display = 'none';
        hintEl.textContent = 'Select a validator or choose custom values';
        compoundValidatorStake = 0;
        compoundRealRewardsData = null;
        calculateCompoundGrowth();
      }
    }
    
    function calculateCompoundGrowth() {
      const validatorSelect = document.getElementById('compoundValidator');
      const resultsContent = document.getElementById('compoundResultsContent');
      const chartContainer = document.getElementById('compoundChartContainer');
      
      // If no validator selected and not custom, show empty state
      if (!validatorSelect.value) {
        resultsContent.innerHTML = `
          <div class="calc-empty-state">
            <div class="calc-empty-icon">🔄</div>
            <div class="calc-empty-text">Select a validator or choose "Custom Values" to calculate compound growth</div>
          </div>
        `;
        chartContainer.style.display = 'none';
        return;
      }
      
      // Get inputs
      let initial = 0;
      let apy = 8; // Default base network APY
      let isValidatorMode = false;
      
      if (validatorSelect.value === 'custom') {
        const amountStr = document.getElementById('compoundInitial').value.replace(/,/g, '');
        initial = parseFloat(amountStr) || 0;
        apy = parseFloat(document.getElementById('compoundAPY').value) || 8;
      } else {
        // For validators, use self-stake and validator's effective APY
        if (compoundRealRewardsData && compoundRealRewardsData.selfStake > 0) {
          initial = compoundRealRewardsData.selfStake;
          apy = compoundRealRewardsData.validatorAPY || 8;
          isValidatorMode = true;
        } else {
          // Fallback to total stake with base APY
          initial = compoundValidatorStake;
          apy = 8;
        }
      }
      
      const years = parseFloat(document.getElementById('compoundYears').value) || 3;
      const frequency = parseInt(document.getElementById('compoundFrequency').value) || 12;
      
      // Get frequency label
      const freqLabels = {
        365: 'Daily',
        52: 'Weekly',
        26: 'Bi-weekly',
        12: 'Monthly',
        4: 'Quarterly',
        1: 'Yearly'
      };
      const freqLabel = freqLabels[frequency] || 'Periodic';
      
      const rate = apy / 100;
      
      // Calculate compound and simple growth
      const compoundFinal = initial * Math.pow(1 + rate / frequency, frequency * years);
      const simpleFinal = initial * (1 + rate * years);
      const bonus = compoundFinal - simpleFinal;
      
      // Show actual current earnings if we have real data
      let earningsHtml = '';
      if (compoundRealRewardsData && validatorSelect.value !== 'custom') {
        const avgAnnual = compoundRealRewardsData.avgAnnual != null
          ? compoundRealRewardsData.avgAnnual
          : compoundRealRewardsData.avgDaily * 365.25;
        const avgDaily = avgAnnual / 365.25;
        const avgMonthly = avgAnnual / 12;
        const selfStake = compoundRealRewardsData.selfStake || 0;
        const delegatedStake = compoundRealRewardsData.delegatedStake || 0;
        const commission = compoundRealRewardsData.commission || 0;
        
        earningsHtml = `
          <div class="calc-section-header actual">
            <span>📊 Current Validator Earnings</span>
            <span class="calc-section-badge">Last ${compoundRealRewardsData.epochs} epochs</span>
          </div>
          <div class="calc-result-grid">
            <div class="calc-result-item">
              <div class="calc-result-value">${formatNumber(avgDaily, 2)} XNT</div>
              <div class="calc-result-label">Per Day</div>
            </div>
            <div class="calc-result-item">
              <div class="calc-result-value">${formatNumber(avgMonthly, 2)} XNT</div>
              <div class="calc-result-label">Per Month</div>
            </div>
            <div class="calc-result-item highlight">
              <div class="calc-result-value">${formatNumber(avgAnnual, 2)} XNT</div>
              <div class="calc-result-label">Per Year</div>
            </div>
          </div>
          ${selfStake > 0 ? `
          <div class="calc-validator-apy-box">
            <div class="calc-validator-apy-label">Validator Effective APY (7-day avg)</div>
            <div class="calc-validator-apy-value">${apy.toFixed(2)}%</div>
            <div class="calc-validator-apy-note">
              ${formatNumber(selfStake, 0)} self-stake + ${commission}% commission on ${formatNumber(delegatedStake, 0)} delegated
            </div>
          </div>
          ` : ''}
          <div class="calc-section-divider"></div>
        `;
      }
      
      // Label for starting stake
      const startingLabel = isValidatorMode ? 'Self-Stake (Your Investment):' : 'Starting Stake:';
      
      resultsContent.innerHTML = `
        ${earningsHtml}
        <div class="calc-section-header">
          <span>📈 ${years}-Year Projection (${freqLabel} Compounding @ ${apy.toFixed(2)}% APY)</span>
        </div>
        <div class="compound-comparison">
          <div class="compound-vs">
            <div class="compound-vs-item">
              <span class="compound-vs-label">${startingLabel}</span>
              <span class="compound-vs-value">${formatNumber(initial, 0)} XNT</span>
            </div>
            <div class="compound-vs-item">
              <span class="compound-vs-label">Without Compounding:</span>
              <span class="compound-vs-value">${formatNumber(simpleFinal, 0)} XNT</span>
            </div>
            <div class="compound-vs-item">
              <span class="compound-vs-label">With ${freqLabel} Compounding:</span>
              <span class="compound-vs-value">${formatNumber(compoundFinal, 0)} XNT</span>
            </div>
            <div class="compound-vs-item highlight">
              <span class="compound-vs-label">Compounding Bonus:</span>
              <span class="compound-vs-value bonus">+${formatNumber(bonus, 0)} XNT</span>
            </div>
          </div>
        </div>
        <div class="calc-actual-note">
          Projection based on ${apy.toFixed(2)}% APY (7-day average). Actual results will vary.
        </div>
      `;
      
      // Show and draw chart
      chartContainer.style.display = 'block';
      drawCompoundChart(initial, apy, years, frequency);
    }
    
    function drawCompoundChart(initial, apy, years, n) {
      const ctx = document.getElementById('compoundChart');
      if (!ctx) return;
      
      // Destroy existing chart
      if (compoundChartInstance) {
        compoundChartInstance.destroy();
      }
      
      // Generate data points - show EARNINGS (growth) not total balance
      const labels = [];
      const compoundData = [];
      const simpleData = [];
      const rate = apy / 100;
      
      // For periods over 5 years, use yearly data points; otherwise monthly
      const useYearly = years > 5;
      const dataPoints = useYearly ? years : years * 12;
      
      for (let i = 0; i <= dataPoints; i++) {
        const t = useYearly ? i : i / 12; // Time in years
        
        // Labels
        if (i === 0) {
          labels.push('Start');
        } else if (useYearly) {
          labels.push(`${i}yr`);
        } else {
          // Show year markers more prominently
          if (i % 12 === 0) {
            labels.push(`${i/12}yr`);
          } else if (i % 6 === 0) {
            labels.push(`${i}mo`);
          } else {
            labels.push('');
          }
        }
        
        // Compound growth with frequency n - show EARNINGS only (subtract initial)
        const periodsElapsed = t * n;
        const compoundTotal = initial * Math.pow(1 + rate / n, periodsElapsed);
        const compoundEarnings = compoundTotal - initial;
        compoundData.push(compoundEarnings);
        
        // Simple (no compounding) - show EARNINGS only
        const simpleTotal = initial * (1 + rate * t);
        const simpleEarnings = simpleTotal - initial;
        simpleData.push(simpleEarnings);
      }
      
      compoundChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'With Compounding',
              data: compoundData,
              borderColor: '#00ffa3',
              backgroundColor: 'rgba(0, 255, 163, 0.1)',
              borderWidth: 2,
              fill: true,
              tension: 0.4
            },
            {
              label: 'Without Compounding',
              data: simpleData,
              borderColor: '#8a8f98',
              backgroundColor: 'transparent',
              borderWidth: 2,
              borderDash: [5, 5],
              fill: false,
              tension: 0.4
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: true,
              position: 'top',
              labels: {
                color: '#8a8f98',
                usePointStyle: true,
                padding: 15
              }
            },
            tooltip: {
              backgroundColor: '#1a1d24',
              titleColor: '#ffffff',
              bodyColor: '#8a8f98',
              borderColor: '#2a2d35',
              borderWidth: 1,
              callbacks: {
                label: function(context) {
                  return context.dataset.label + ': +' + formatNumber(context.raw, 2) + ' XNT';
                }
              }
            }
          },
          scales: {
            x: {
              grid: { color: 'rgba(255, 255, 255, 0.05)' },
              ticks: { color: '#8a8f98', maxRotation: 0 }
            },
            y: {
              beginAtZero: true,
              title: {
                display: true,
                text: 'Earnings (XNT)',
                color: '#8a8f98'
              },
              grid: { color: 'rgba(255, 255, 255, 0.05)' },
              ticks: {
                color: '#8a8f98',
                callback: function(value) {
                  if (value >= 1000000) return '+' + (value / 1000000).toFixed(1) + 'M';
                  if (value >= 1000) return '+' + (value / 1000).toFixed(0) + 'K';
                  return '+' + value;
                }
              }
            }
          }
        }
      });
    }
    
    // ===== UNSTAKING TIMELINE CALCULATOR =====
    async function refreshEpochInfo() {
      try {
        document.getElementById('unstakingCurrentEpoch').textContent = 'Loading...';
        
        const epochInfo = await rpcCall('getEpochInfo');
        currentEpochData = epochInfo;
        
        const currentEpoch = epochInfo.epoch;
        const slotIndex = epochInfo.slotIndex;
        const slotsInEpoch = epochInfo.slotsInEpoch;
        const progress = ((slotIndex / slotsInEpoch) * 100).toFixed(1);
        
        // Estimate time remaining (assuming ~400ms per slot)
        const slotsRemaining = slotsInEpoch - slotIndex;
        const msRemaining = slotsRemaining * 400;
        const hoursRemaining = msRemaining / (1000 * 60 * 60);
        
        let timeStr;
        if (hoursRemaining < 1) {
          timeStr = Math.round(hoursRemaining * 60) + ' minutes';
        } else if (hoursRemaining < 24) {
          timeStr = hoursRemaining.toFixed(1) + ' hours';
        } else {
          timeStr = (hoursRemaining / 24).toFixed(1) + ' days';
        }
        
        document.getElementById('unstakingCurrentEpoch').textContent = currentEpoch;
        document.getElementById('unstakingEpochProgress').textContent = progress + '%';
        document.getElementById('unstakingTimeRemaining').textContent = '~' + timeStr;
        
        calculateUnstakingTimeline();
      } catch (err) {
        console.error('Failed to fetch epoch info:', err);
        document.getElementById('unstakingCurrentEpoch').textContent = 'Error';
      }
    }
    
    function calculateUnstakingTimeline() {
      if (!currentEpochData) return;
      
      // ── Read inputs ──────────────────────────────────────────────────────
      const whenSelect = document.getElementById('unstakingWhen').value;
      const customEpoch = parseInt(document.getElementById('unstakingCustomEpoch').value) || 0;
      const stakeAmountXNT = Math.max(0, parseFloat(document.getElementById('unstakingAmount')?.value) || 0);
      const ratePct = Math.max(1, Math.min(100, parseInt(document.getElementById('unstakingRate')?.value) || 50));
      
      // Toggle visibility of the custom epoch input
      const customInput = document.getElementById('unstakingCustomEpoch');
      if (customInput) customInput.style.display = whenSelect === 'custom' ? 'block' : 'none';
      
      const currentEpoch = currentEpochData.epoch;
      let initiateEpoch;
      switch (whenSelect) {
        case 'now':    initiateEpoch = currentEpoch; break;
        case 'next':   initiateEpoch = currentEpoch + 1; break;
        case 'custom': initiateEpoch = customEpoch || currentEpoch; break;
      }
      
      // ── Cooldown model ───────────────────────────────────────────────────
      // X1/Solana mechanics:
      //   - Calling deactivate() during epoch N sets delegation.deactivationEpoch = N
      //   - Stake stays "active" through epoch N (still earns rewards)
      //   - In epoch N+1 the cooldown begins; an amount transitions active → inactive
      //   - The protocol caps total network deactivation at 25% of active stake per
      //     epoch via the stake history sysvar. When more than that is in the
      //     deactivation queue, each account gets a proportional share — which is
      //     a fixed lamport amount per epoch (linear decay, not exponential),
      //     because each account's fraction of the queue stays roughly constant
      //     as the queue drains.
      //   - We model this as: each epoch, `ratePct%` of the *original* stake
      //     amount cools, until fully cooled.
      const perEpochAmount = stakeAmountXNT * (ratePct / 100);
      const cooldownEpochsRaw = ratePct >= 100 ? 1 : Math.ceil(100 / ratePct);
      const cooldownEpochs = Math.min(cooldownEpochsRaw, 50); // safety cap
      
      // Per-epoch release schedule. Cooldown starts in epoch initiateEpoch+1.
      const schedule = [];
      let remaining = stakeAmountXNT;
      let cumulative = 0;
      for (let i = 0; i < cooldownEpochs && remaining > 1e-8; i++) {
        const release = Math.min(perEpochAmount, remaining);
        remaining = Math.max(0, remaining - release);
        cumulative += release;
        schedule.push({
          epoch: initiateEpoch + 1 + i,
          released: release,
          cumulative: cumulative,
          remaining: remaining,
          pctOfTotal: stakeAmountXNT > 0 ? (cumulative / stakeAmountXNT) * 100 : 0
        });
      }
      const completionEpoch = schedule.length > 0 ? schedule[schedule.length - 1].epoch : initiateEpoch + 1;
      
      // ── Date math ────────────────────────────────────────────────────────
      // Use actual slot timing instead of a hardcoded 1-day epoch.
      const slotsInEpoch = currentEpochData.slotsInEpoch;
      const slotIndex    = currentEpochData.slotIndex;
      const slotMs = 400; // X1 / Solana target slot time
      const epochDurationMs = slotsInEpoch * slotMs;
      const progressRatio = slotIndex / slotsInEpoch;
      const currentEpochRemainingMs = epochDurationMs * (1 - progressRatio);
      const now = new Date();
      
      // Time from now until the start of a target epoch
      const msUntilEpochStart = (targetEpoch) => {
        const delta = targetEpoch - currentEpoch;
        if (delta <= 0) return 0;
        return currentEpochRemainingMs + (delta - 1) * epochDurationMs;
      };
      // Time from now until end of a target epoch (== start of target+1)
      const msUntilEpochEnd = (targetEpoch) => msUntilEpochStart(targetEpoch + 1);
      
      const initiateDate    = new Date(now.getTime() + msUntilEpochStart(initiateEpoch));
      const cooldownStarts  = new Date(now.getTime() + msUntilEpochStart(initiateEpoch + 1));
      const fullyAvailable  = new Date(now.getTime() + msUntilEpochEnd(completionEpoch));
      
      // Attach a date to each schedule entry (end of that epoch)
      schedule.forEach(s => {
        s.date = new Date(now.getTime() + msUntilEpochEnd(s.epoch));
      });
      
      // ── Visual timeline (top section) ────────────────────────────────────
      const fmtXNT = (n) => formatNumber(n, 4);
      const tl = document.getElementById('unstakingTimeline');
      const firstRelease = schedule[0];
      const cooldownLabel = ratePct >= 100
        ? `Epoch ${initiateEpoch + 1} — full ${fmtXNT(stakeAmountXNT)} XNT cools in one epoch`
        : `Epochs ${initiateEpoch + 1}${schedule.length > 1 ? '–' + completionEpoch : ''} — ~${fmtXNT(perEpochAmount)} XNT released per epoch`;
      
      tl.innerHTML = `
        <div class="timeline-step ${initiateEpoch === currentEpoch ? 'active' : ''}">
          <div class="timeline-icon">📝</div>
          <div class="timeline-content">
            <div class="timeline-title">Initiate Unstake</div>
            <div class="timeline-subtitle">Epoch ${initiateEpoch} — call deactivate() on your stake account</div>
            <div class="timeline-date">${formatDate(initiateDate)}</div>
          </div>
        </div>
        <div class="timeline-step">
          <div class="timeline-icon">❄️</div>
          <div class="timeline-content">
            <div class="timeline-title">Cooldown ${schedule.length > 1 ? `(${schedule.length} epochs)` : ''}</div>
            <div class="timeline-subtitle">${cooldownLabel}</div>
            <div class="timeline-date">starts ${formatDate(cooldownStarts)}</div>
          </div>
        </div>
        <div class="timeline-step">
          <div class="timeline-icon">✅</div>
          <div class="timeline-content">
            <div class="timeline-title">Fully Withdrawable</div>
            <div class="timeline-subtitle">End of epoch ${completionEpoch} — call withdraw() to move funds</div>
            <div class="timeline-date">${formatDate(fullyAvailable)}</div>
          </div>
        </div>
      `;
      
      // ── Summary card ─────────────────────────────────────────────────────
      const totalMs = fullyAvailable.getTime() - now.getTime();
      const totalDays = totalMs / (1000 * 60 * 60 * 24);
      const totalEpochs = (initiateEpoch - currentEpoch) + schedule.length;
      let timeText;
      if (totalDays < 1)        timeText = `~${(totalDays * 24).toFixed(1)} hours`;
      else if (totalDays < 7)   timeText = `~${totalDays.toFixed(1)} days`;
      else                      timeText = `~${(totalDays / 7).toFixed(1)} weeks (${totalDays.toFixed(0)} days)`;
      
      document.getElementById('unstakingSummary').innerHTML = `
        <div class="unstaking-summary-value">${timeText}</div>
        <div class="unstaking-summary-label">
          Until <strong>${fmtXNT(stakeAmountXNT)} XNT</strong> is fully withdrawable
          (${schedule.length} cooldown epoch${schedule.length === 1 ? '' : 's'},
          ${totalEpochs} total epoch${totalEpochs === 1 ? '' : 's'} from now)
        </div>
      `;
      
      // ── Per-epoch breakdown table ────────────────────────────────────────
      const breakdownEl = document.getElementById('unstakingEpochBreakdown');
      if (schedule.length === 0 || stakeAmountXNT <= 0) {
        breakdownEl.innerHTML = '';
      } else {
        const rows = schedule.map((s, i) => {
          const isLast = i === schedule.length - 1;
          return `
            <div class="unstaking-epoch-row ${isLast ? 'complete' : ''}">
              <div class="unstaking-epoch-num">#${s.epoch}</div>
              <div class="unstaking-epoch-released">+${fmtXNT(s.released)}</div>
              <div class="unstaking-epoch-cumulative">${fmtXNT(s.cumulative)}</div>
              <div>
                <div class="unstaking-epoch-bar">
                  <div class="unstaking-epoch-bar-fill" style="width:${s.pctOfTotal.toFixed(1)}%"></div>
                </div>
                <div style="margin-top:0.25rem; font-size:0.7rem; color:var(--text-dim); display:flex; justify-content:space-between;">
                  <span>${s.pctOfTotal.toFixed(1)}% cooled</span>
                  <span>${formatDate(s.date)}</span>
                </div>
              </div>
            </div>`;
        }).join('');
        
        breakdownEl.innerHTML = `
          <div class="calc-result-header" style="margin-top:1.5rem">Per-Epoch Release Schedule</div>
          <div class="unstaking-epoch-table">
            <div class="unstaking-epoch-table-header">
              <div>Epoch</div>
              <div>Released</div>
              <div>Cumulative</div>
              <div>Progress</div>
            </div>
            ${rows}
          </div>`;
      }
    }
    
    // Update slider value label and refresh calc
    function onUnstakingRateChange() {
      const slider = document.getElementById('unstakingRate');
      const v = slider ? slider.value : 50;
      const lbl = document.getElementById('unstakingRateValue');
      if (lbl) lbl.textContent = v + '%';
      // Update preset highlighting
      document.querySelectorAll('.unstaking-rate-preset').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.rate) === parseInt(v));
      });
      calculateUnstakingTimeline();
    }
    
    function setUnstakingRatePreset(pct) {
      const slider = document.getElementById('unstakingRate');
      if (slider) slider.value = pct;
      onUnstakingRateChange();
    }
    
    function formatDate(date) {
      const options = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
      return date.toLocaleDateString('en-US', options);
    }
    
    // ===== BREAK-EVEN CALCULATOR =====
    let breakevenValidatorStake = 0;
    let breakevenViewMode = 'monthly'; // 'monthly' or 'yearly'
    let breakevenRealRewardsData = null;
    
    function formatBreakevenInput(input) {
      let value = input.value.replace(/[^0-9.]/g, '');
      if (value) {
        const num = parseFloat(value);
        if (!isNaN(num)) {
          input.value = num.toLocaleString('en-US');
        }
      }
    }
    
    async function onBreakevenValidatorChange() {
      const validatorSelect = document.getElementById('breakevenValidator');
      const hintEl = document.getElementById('breakevenValidatorHint');
      const resultsContent = document.getElementById('breakevenResultsContent');
      
      if (validatorSelect.value) {
        let stake = 0;
        let commission = 0;
        if (validatorInfoCache[validatorSelect.value]) {
          stake = validatorInfoCache[validatorSelect.value].activatedStake || 0;
          commission = validatorInfoCache[validatorSelect.value].commission || 0;
        } else if (allValidators) {
          const validator = allValidators.find(v => v.votePubkey === validatorSelect.value);
          if (validator) {
            stake = validator.activatedStake / 1e9;
            commission = validator.commission || 0;
          }
        }
        breakevenValidatorStake = stake;
        hintEl.textContent = `Current stake: ${formatNumber(stake, 0)} XNT`;
        
        // Show loading
        resultsContent.innerHTML = `
          <div class="calc-loading">
            <div class="loading-spinner-small"></div>
            <span>Fetching real reward data...</span>
          </div>
        `;
        
        // Fetch real rewards data (vote account + self-stake rewards)
        try {
          const rewards = await fetchTotalValidatorRewards(validatorSelect.value, commission, 7);
          if (rewards && rewards.length > 0) {
            // Convert from lamports to XNT (divide by 1e9)
            const totalRewardsXNT = rewards.reduce((sum, r) => sum + r.amount, 0) / 1e9;
            const avgEpochRewardsXNT = totalRewardsXNT / rewards.length;
            const avgAnnualRewardsXNT = avgEpochRewardsXNT * epochsPerYear();
            const realAPY = stake > 0 ? (avgAnnualRewardsXNT / stake) * 100 : 0;

            breakevenRealRewardsData = {
              avgDaily: avgAnnualRewardsXNT / 365.25,
              avgAnnual: avgAnnualRewardsXNT,
              realAPY: realAPY,
              epochs: rewards.length
            };
          } else {
            breakevenRealRewardsData = null;
          }
        } catch (err) {
          console.error('Failed to fetch real rewards:', err);
          breakevenRealRewardsData = null;
        }
        
        renderBreakevenResults();
      } else {
        hintEl.textContent = 'Select a validator to see profitability';
        breakevenValidatorStake = 0;
        breakevenRealRewardsData = null;
        renderBreakevenResults();
      }
    }
    
    function toggleBreakevenView(mode, button) {
      breakevenViewMode = mode;
      
      document.querySelectorAll('#breakevenToggle .calc-toggle-btn').forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      
      renderBreakevenResults();
    }
    
    function calculateBreakeven() {
      renderBreakevenResults();
    }
    
    function renderBreakevenResults() {
      const validatorSelect = document.getElementById('breakevenValidator');
      const resultsContent = document.getElementById('breakevenResultsContent');
      
      // If no validator selected, show empty state
      if (!validatorSelect.value) {
        resultsContent.innerHTML = `
          <div class="calc-empty-state">
            <div class="calc-empty-icon">💸</div>
            <div class="calc-empty-text">Select a validator to see profitability</div>
          </div>
        `;
        return;
      }
      
      const currentStake = breakevenValidatorStake;
      
      const cost = parseFloat(document.getElementById('breakevenCost').value) || 0;
      const currency = document.getElementById('breakevenCurrency').value;
      const costPeriod = document.getElementById('breakevenPeriod').value;
      const price = parseFloat(document.getElementById('breakevenPrice').value) || 1.00;
      
      // Show/hide price input based on currency
      document.getElementById('breakevenPriceGroup').style.display = currency === 'usd' ? 'block' : 'none';
      
      // Convert cost to XNT
      let annualCostXNT;
      if (currency === 'usd') {
        const costInXNT = price > 0 ? cost / price : 0;
        annualCostXNT = costPeriod === 'monthly' ? costInXNT * 12 : costInXNT;
      } else {
        annualCostXNT = costPeriod === 'monthly' ? cost * 12 : cost;
      }
      
      const monthlyCostXNT = annualCostXNT / 12;
      const isMonthly = breakevenViewMode === 'monthly';
      const periodLabel = isMonthly ? 'Monthly' : 'Yearly';
      const displayCost = isMonthly ? monthlyCostXNT : annualCostXNT;
      
      // Show actual data
      if (breakevenRealRewardsData) {
        const avgAnnual = breakevenRealRewardsData.avgAnnual != null
          ? breakevenRealRewardsData.avgAnnual
          : breakevenRealRewardsData.avgDaily * 365.25;
        const avgDaily = avgAnnual / 365.25;
        const avgMonthly = avgAnnual / 12;
        const displayRewards = isMonthly ? avgMonthly : avgAnnual;
        const profit = displayRewards - displayCost;
        
        const profitClass = profit >= 0 ? 'positive' : 'negative';
        const profitSign = profit >= 0 ? '+' : '';
        const statusText = profit >= 0 ? '✅ Currently Profitable' : '❌ Currently Operating at Loss';
        const statusClass = profit >= 0 ? 'profit-status-positive' : 'profit-status-negative';
        
        // Calculate break-even XNT price
        // Get annual USD costs
        let annualUsdCost;
        if (currency === 'usd') {
          annualUsdCost = costPeriod === 'monthly' ? cost * 12 : cost;
        } else {
          // Costs in XNT - convert to USD using current price
          const annualXntCost = costPeriod === 'monthly' ? cost * 12 : cost;
          annualUsdCost = annualXntCost * price;
        }
        
        // Break-even price = annual USD cost / annual XNT rewards
        const breakevenPrice = avgAnnual > 0 ? annualUsdCost / avgAnnual : 0;
        const displayUsdCost = isMonthly ? annualUsdCost / 12 : annualUsdCost;
        const currentUsdValue = displayRewards * price;
        const priceNeededText = breakevenPrice > 0 ? `$${breakevenPrice.toFixed(4)}` : 'N/A';
        const isProfitable = profit >= 0;
        const breakevenLabel = isProfitable 
          ? 'Profitable down to:' 
          : 'Price needed to break even:';
        const breakevenHeader = isProfitable
          ? '💵 Break-Even Floor'
          : '💵 Break-Even XNT Price';
        
        resultsContent.innerHTML = `
          <div class="calc-section-header actual">
            <span>📊 Break-Even Analysis</span>
            <span class="calc-section-badge">Last ${breakevenRealRewardsData.epochs} epochs</span>
          </div>
          <div class="calc-result-grid">
            <div class="calc-result-item">
              <div class="calc-result-value">${formatNumber(currentStake, 0)} XNT</div>
              <div class="calc-result-label">Current Stake</div>
            </div>
            <div class="calc-result-item">
              <div class="calc-result-value">${formatNumber(displayCost, 2)} XNT</div>
              <div class="calc-result-label">${periodLabel} Costs</div>
            </div>
            <div class="calc-result-item">
              <div class="calc-result-value">${formatNumber(displayRewards, 2)} XNT</div>
              <div class="calc-result-label">${periodLabel} Rewards</div>
            </div>
            <div class="calc-result-item highlight">
              <div class="calc-result-value ${profitClass}">${profitSign}${formatNumber(profit, 2)} XNT</div>
              <div class="calc-result-label">${periodLabel} Profit</div>
            </div>
          </div>
          <div class="breakeven-status ${statusClass}">
            ${statusText} — Earning ${formatNumber(avgDaily, 2)} XNT/day
          </div>
          <div class="breakeven-price-box">
            <div class="breakeven-price-header">${breakevenHeader}</div>
            <div class="breakeven-price-content">
              <div class="breakeven-price-item">
                <span class="breakeven-price-label">${breakevenLabel}</span>
                <span class="breakeven-price-value highlight">${priceNeededText}</span>
              </div>
              <div class="breakeven-price-item">
                <span class="breakeven-price-label">Current XNT price (input):</span>
                <span class="breakeven-price-value">$${price.toFixed(2)}</span>
              </div>
              <div class="breakeven-price-divider"></div>
              <div class="breakeven-price-item">
                <span class="breakeven-price-label">${periodLabel} costs:</span>
                <span class="breakeven-price-value">$${formatNumber(displayUsdCost, 2)}</span>
              </div>
              <div class="breakeven-price-item">
                <span class="breakeven-price-label">${periodLabel} rewards value:</span>
                <span class="breakeven-price-value ${currentUsdValue >= displayUsdCost ? 'positive' : 'negative'}">$${formatNumber(currentUsdValue, 2)}</span>
              </div>
            </div>
          </div>
          <div class="calc-actual-note">
            Earnings include self-stake rewards + commission on delegations
          </div>
        `;
      } else {
        resultsContent.innerHTML = `
          <div class="calc-empty-state">
            <div class="calc-empty-icon">⏳</div>
            <div class="calc-empty-text">Unable to fetch reward data</div>
          </div>
        `;
      }
    }

