    // =========================================
    // Go to home page (X1 Network tab)
    function goToHome() {
      // Close any open modals
      document.getElementById('manageValidatorModal').style.display = 'none';
      document.getElementById('validatorModal').style.display = 'none';
      
      // Switch to the map tab
      switchTab('map');
    }

    // Validator list modal
    let validatorListMode = 'search'; // 'search' or 'compare'
    let currentValidatorList = []; // The current filtered/full list
    let validatorListDisplayed = 0; // How many are currently shown
    const VALIDATORS_PER_PAGE = 100;

    async function openValidatorList(mode = 'search') {
      validatorListMode = mode;
      const modal = document.getElementById('validatorModal');
      const body = document.getElementById('validatorListBody');
      
      // Reset search
      document.getElementById('validatorSearchInput').value = '';
      
      modal.style.display = 'flex';

      if (allValidators.length === 0) {
        body.innerHTML = '<div class="loading-validators">Loading validators...</div>';
        document.getElementById('validatorListCount').textContent = 'Loading...';
        await loadNetworkStats();
      }
      
      // Reset and render
      currentValidatorList = allValidators;
      validatorListDisplayed = 0;
      renderValidatorList(false);
    }

    function renderValidatorList(append = false) {
      const body = document.getElementById('validatorListBody');
      const countEl = document.getElementById('validatorListCount');
      const loadMoreEl = document.getElementById('validatorLoadMore');
      
      if (currentValidatorList.length === 0) {
        body.innerHTML = '<div class="loading-validators">No validators found</div>';
        countEl.textContent = 'No validators found';
        loadMoreEl.style.display = 'none';
        return;
      }

      // Get next batch
      const startIdx = append ? validatorListDisplayed : 0;
      const endIdx = startIdx + VALIDATORS_PER_PAGE;
      const batch = currentValidatorList.slice(startIdx, endIdx);
      
      const batchHtml = batch.map(v => {
        const isInPortfolio = myPortfolio.includes(v.votePubkey);
        const isInCompare = compareValidators.some(cv => cv.votePubkey === v.votePubkey);
        const tierBadge = getTierBadge(v.rank, v.totalValidators);
        
        // Different button based on mode
        let actionButton;
        if (validatorListMode === 'compare') {
          actionButton = `
            <button class="validator-list-item-add ${isInCompare ? 'added' : ''}" 
                    onclick="${isInCompare ? '' : `addToComparisonFromList('${v.votePubkey}')`}"
                    ${isInCompare ? 'disabled' : ''}>
              ${isInCompare ? 'Added' : '+ Compare'}
            </button>
          `;
        } else {
          actionButton = `
            <button class="validator-list-item-add ${isInPortfolio ? 'added' : ''}" 
                    onclick="${isInPortfolio ? '' : `addToPortfolioFromList('${v.votePubkey}')`}"
                    ${isInPortfolio ? 'disabled' : ''}>
              ${isInPortfolio ? 'Added' : '+ Add'}
            </button>
          `;
        }
        
        // Generate logo HTML
        const initial = v.name ? v.name.charAt(0).toUpperCase() : 'V';
        let logoHtml;
        if (v.iconUrl) {
          logoHtml = `<img src="${safeUrl(v.iconUrl)}" alt="${escHtml(initial)}" onerror="this.style.display='none';this.parentElement.textContent='${escAttrJs(initial)}';">`;
        } else {
          logoHtml = escHtml(initial);
        }
        
        return `
          <div class="validator-list-item">
            <div class="validator-list-item-logo">${logoHtml}</div>
            <div class="validator-list-item-info" onclick="selectValidatorForSearch('${v.votePubkey}')">
              <div class="validator-list-item-name">#${v.rank} - ${escHtml(v.name)}${tierBadge}</div>
              <div class="validator-list-item-address">${v.votePubkey}</div>
            </div>
            ${actionButton}
          </div>
        `;
      }).join('');

      if (append) {
        body.innerHTML += batchHtml;
      } else {
        body.innerHTML = batchHtml;
      }
      
      // Update count
      validatorListDisplayed = Math.min(endIdx, currentValidatorList.length);
      countEl.textContent = `Showing ${validatorListDisplayed} of ${currentValidatorList.length} validators`;
      
      // Show/hide Load More button
      if (validatorListDisplayed < currentValidatorList.length) {
        loadMoreEl.style.display = 'block';
      } else {
        loadMoreEl.style.display = 'none';
      }
    }

    function loadMoreValidators() {
      renderValidatorList(true);
    }

    function filterValidatorList() {
      const search = document.getElementById('validatorSearchInput').value.toLowerCase();
      
      if (search.trim() === '') {
        currentValidatorList = allValidators;
      } else {
        currentValidatorList = allValidators.filter(v => 
          v.name.toLowerCase().includes(search) || 
          v.votePubkey.toLowerCase().includes(search) ||
          v.nodePubkey.toLowerCase().includes(search)
        );
      }
      
      validatorListDisplayed = 0;
      renderValidatorList(false);
    }

    function selectValidatorForSearch(votePubkey) {
      if (validatorListMode === 'compare') {
        addToComparisonFromList(votePubkey);
      } else {
        document.getElementById('searchInput').value = votePubkey;
        closeValidatorList();
        switchTab('lookup');
        performSearch();
      }
    }

    async function addToComparisonFromList(votePubkey) {
      await addToComparison(votePubkey);
      // Re-render the list to update button states
      filterValidatorList();
    }

    function addToPortfolioFromList(voteAccount) {
      if (!myPortfolio.includes(voteAccount)) {
        myPortfolio.push(voteAccount);
        savePortfolio();
        // Re-render the current filtered view. (Passing the array straight into
        // renderValidatorList() hit its `append` parameter, so clicking "+ Add"
        // used to append the next 100 rows and never flip the button to "Added".)
        filterValidatorList();
      }
    }

    function closeValidatorList() {
      document.getElementById('validatorModal').style.display = 'none';
    }

    // Manage Validator Functions
    let currentManageValidator = null;
    let selectedAccountType = 'vote';
    let stakeAccounts = [];
    let manageVoteWithdrawAuthority = null; // cached from fetchVoteAccountAuthoritiesForDisplay, used for action locks

    function openManageValidator(voteAccount, name, rewardsBalance, commission, identityPubkey, iconUrl) {
      currentManageValidator = {
        voteAccount,
        name,
        rewardsBalance,
        commission,
        identityPubkey,
        iconUrl
      };
      
      // Set validator info in header
      const logoEl = document.getElementById('manageValidatorLogo');
      const firstLetter = name.charAt(0).toUpperCase();
      if (iconUrl) {
        logoEl.innerHTML = `<img src="${safeUrl(iconUrl)}" alt="${escHtml(name)}" style="width:100%;height:100%;border-radius:10px;" onerror="this.parentElement.textContent='${escAttrJs(firstLetter)}'">`;
      } else {
        logoEl.textContent = firstLetter;
      }
      document.getElementById('manageValidatorName').textContent = name;
      document.getElementById('manageValidatorFullAddress').textContent = voteAccount;
      
      // Set vote account address in account list
      document.getElementById('voteAccountAddress').textContent = shortenAddress(voteAccount);
      document.getElementById('voteAccountCopyBtn').innerHTML = getCopyButtonHtml(voteAccount);
      
      // Reset stake accounts container
      document.getElementById('stakeAccountsContainer').innerHTML = '<div class="loading-text">Loading stake accounts...</div>';
      
      // Reset cached vote withdraw authority (re-fetched on selection)
      manageVoteWithdrawAuthority = null;
      
      // Update wallet status display
      updateManageWalletDisplay();
      
      // Show modal
      document.getElementById('manageValidatorModal').style.display = 'flex';
      
      // Select vote account by default
      selectAccount('vote');
      
      // Fetch additional data
      fetchManageValidatorData(voteAccount);
      fetchStakeAccounts(voteAccount);
    }

    function updateManageWalletDisplay() {
      const indicator = document.getElementById('walletStatusIndicator');
      const statusText = document.getElementById('walletStatusText');
      const authorityBadge = document.getElementById('authorityBadge');
      
      if (walletPublicKey) {
        indicator.classList.add('connected');
        statusText.textContent = shortenAddress(walletPublicKey);
        statusText.classList.add('connected');
        document.getElementById('connectWalletBtn').style.display = 'none';
        document.getElementById('disconnectWalletBtn').style.display = 'block';
        
        // Check if stake account is selected - only then check withdraw authority
        if (selectedAccountType && selectedAccountType.startsWith('stake-')) {
          document.getElementById('selectedWithdrawAuthority').textContent = 'Checking...';
          authorityBadge.className = 'authority-badge';
          authorityBadge.innerHTML = '<span class="authority-badge-icon">⏳</span><span class="authority-badge-text">Checking authority...</span>';
          checkWithdrawAuthority();
        } else if (selectedAccountType === 'vote') {
          // Vote account selected - just show wallet connected
          authorityBadge.className = 'authority-badge has-authority';
          authorityBadge.innerHTML = '<span class="authority-badge-icon">✓</span><span class="authority-badge-text">Wallet connected</span>';
        }
        // If no account selected (selectedAccountType is null), badges are already hidden
      } else {
        indicator.classList.remove('connected');
        statusText.textContent = 'No wallet connected';
        statusText.classList.remove('connected');
        document.getElementById('connectWalletBtn').style.display = 'block';
        document.getElementById('disconnectWalletBtn').style.display = 'none';
        document.getElementById('selectedWithdrawAuthority').textContent = 'Connect wallet to view';
        
        // Set badge to no wallet state (clickable)
        authorityBadge.className = 'authority-badge clickable';
        authorityBadge.innerHTML = '<span class="authority-badge-icon">🔗</span><span class="authority-badge-text">No wallet connected</span>';
      }
      
      // Action locks depend on the connected wallet, so refresh them
      if (typeof renderActions === 'function') {
        renderActions();
      }
    }

    // Handle authority badge click
    function onAuthorityBadgeClick() {
      if (!walletPublicKey) {
        connectWallet();
      }
    }

    // Copy validator address to clipboard
    async function copyValidatorAddress() {
      if (!currentManageValidator) return;
      
      const address = currentManageValidator.voteAccount;
      const btn = document.querySelector('.copy-address-btn');
      
      try {
        await navigator.clipboard.writeText(address);
        
        // Show copied state
        btn.classList.add('copied');
        btn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        `;
        
        // Reset after 2 seconds
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          `;
        }, 2000);
      } catch (e) {
        console.error('Failed to copy:', e);
        alert('Failed to copy address');
      }
    }

    function closeManageValidator() {
      document.getElementById('manageValidatorModal').style.display = 'none';
      currentManageValidator = null;
      stakeAccounts = [];
    }

    // Performance Explainer Modal functions
    function openPerfExplainerModal(event, voteAccount) {
      event.stopPropagation();
      
      // Get validator info and calculate breakdown
      let breakdown = null;
      let validatorName = 'Validator';
      let validatorIcon = '';
      let totalScore = 0;
      
      if (voteAccount) {
        // Check cache first
        const cached = validatorInfoCache[voteAccount];
        if (cached) {
          breakdown = calculatePerformanceBreakdown(cached);
          validatorName = cached.name;
          validatorIcon = cached.iconUrl || '';
          totalScore = breakdown.totalScore;
        } else {
          // Try allValidators
          const validator = allValidators.find(v => v.votePubkey === voteAccount);
          if (validator) {
            const normalizedValidator = {
              ...validator,
              epochCreditsHistory: validator.epochCredits || [],
              isDelinquent: validator.delinquent
            };
            breakdown = calculatePerformanceBreakdown(normalizedValidator);
            validatorName = validator.name;
            validatorIcon = validator.iconUrl || '';
            totalScore = breakdown.totalScore;
          }
        }
      }
      
      // Generate logo HTML
      const firstLetter = validatorName.charAt(0).toUpperCase();
      const logoHtml = validatorIcon 
        ? `<img class="perf-breakdown-logo" src="${safeUrl(validatorIcon)}" alt="${escHtml(validatorName)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
           <div class="perf-breakdown-logo-placeholder" style="display:none;">${escHtml(firstLetter)}</div>`
        : `<div class="perf-breakdown-logo-placeholder">${escHtml(firstLetter)}</div>`;
      
      // Update the modal with validator-specific scores
      const breakdownSection = document.getElementById('perfBreakdownSection');
      if (breakdown) {
        breakdownSection.innerHTML = `
          <div class="perf-breakdown-header">
            <div class="perf-breakdown-identity">
              ${logoHtml}
              <h4>${escHtml(validatorName)}</h4>
            </div>
            <div class="perf-breakdown-total">Score: <span class="${getScoreColorClass(totalScore)}">${totalScore.toFixed(2)}</span></div>
          </div>
          <div class="perf-breakdown-grid">
            ${Object.entries(breakdown).map(([key, comp]) => {
              if (!comp || typeof comp !== 'object' || !('score' in comp)) return '';
              const label = comp.label || LEGACY_BREAKDOWN_LABELS[key] || key;
              if (comp.score === null || comp.weight === 0) {
                return `
            <div class="perf-breakdown-item" style="opacity: 0.65;">
              <span class="perf-breakdown-label">${label} (info)</span>
              <span class="perf-breakdown-score">—</span>
              <span class="perf-breakdown-detail">${comp.details}</span>
            </div>`;
              }
              return `
            <div class="perf-breakdown-item">
              <span class="perf-breakdown-label">${label} (${Math.round(comp.weight * 100)}%)</span>
              <span class="perf-breakdown-score ${getScoreColorClass(comp.score)}">${comp.score.toFixed(1)}</span>
              <span class="perf-breakdown-detail">${comp.details}</span>
            </div>`;
            }).join('')}
          </div>
          ${(breakdown.flags && breakdown.flags.includes('commission_rug')) ? `<div class="perf-breakdown-detail" style="color: var(--danger, #ff5c5c); margin-top: 0.5rem;">⚠ Commission raised sharply in the last 7 days — score penalty applied</div>` : ''}
          ${breakdown.canonical ? `<div class="perf-breakdown-detail" style="opacity: 0.65; margin-top: 0.5rem;">📡 Official published score · updated hourly · identical for all viewers</div>` : ''}
          <div class="ask-claude-divider"><span>Need Help?</span></div>
          <button class="ask-claude-btn" onclick="askClaudeForHelp('${voteAccount}', '${escAttrJs(validatorName)}', ${totalScore.toFixed(2)}, '${escAttrJs(breakdown.skipRate.details)}')">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
            Ask Claude to Help Optimize My Validator
          </button>
        `;
        breakdownSection.style.display = 'block';
      } else {
        breakdownSection.style.display = 'none';
      }
      
      document.getElementById('perfExplainerModal').style.display = 'flex';
      document.body.style.overflow = 'hidden';
    }
    
    function closePerfExplainerModal(event) {
      if (event && event.target !== event.currentTarget) return;
      document.getElementById('perfExplainerModal').style.display = 'none';
      document.body.style.overflow = '';
    }

    // Ask Claude for Help - opens Claude.ai with pre-filled validator info
    function askClaudeForHelp(voteAccount, validatorName, score, skipRateDetails) {
      // Get more validator details if available
      const validator = allValidators.find(v => v.votePubkey === voteAccount);
      let nodePubkey = '';
      let stake = '';
      let commission = '';
      
      if (validator) {
        nodePubkey = validator.nodePubkey || '';
        stake = validator.activatedStake ? (validator.activatedStake / 1e9).toFixed(0) + ' XN' : '';
        commission = validator.commission !== undefined ? validator.commission + '%' : '';
      }
      
      // Build the pre-filled message
      const message = `Help me optimize my X1 validator performance.

**My Validator Info:**
- Name: ${validatorName}
- Vote Account: ${voteAccount}
${nodePubkey ? '- Node Pubkey: ' + nodePubkey : ''}
- Performance Score: ${score}/100
- Skip Rate: ${skipRateDetails}
${stake ? '- Stake: ' + stake : ''}
${commission ? '- Commission: ' + commission : ''}

Please give me the diagnostic commands to run on my server so you can help me identify issues and optimize my setup. I want to reduce my skip rate and improve my performance score.`;

      // URL encode the message
      const encodedMessage = encodeURIComponent(message);
      
      // Open Claude.ai with the pre-filled message
      window.open(`https://claude.ai/new?q=${encodedMessage}`, '_blank', 'noopener,noreferrer');
    }

    // ===== STAKE BREAKDOWN MODAL =====
    let stakeBreakdownCache = {}; // Cache stake breakdown data
    
    async function openStakeBreakdown(voteAccount, validatorName, totalStake, commission) {
      const modal = document.getElementById('stakeBreakdownModal');
      const body = document.getElementById('stakeBreakdownBody');
      
      modal.style.display = 'flex';
      document.body.style.overflow = 'hidden';
      
      // Show loading
      body.innerHTML = `
        <div class="stake-breakdown-loading">
          <div class="loading-spinner-small"></div>
          <span>Analyzing stake accounts...</span>
          <span style="font-size: 0.75rem; color: var(--text-dim);">Checking reward distribution patterns</span>
        </div>
      `;
      
      // Check cache first (5 minute cache)
      const cacheKey = voteAccount;
      const cached = stakeBreakdownCache[cacheKey];
      if (cached && cached.timestamp > Date.now() - 300000) {
        renderStakeBreakdown(cached.data, validatorName, totalStake, commission, voteAccount);
        return;
      }
      
      try {
        // Fetch all stake accounts delegated to this validator
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
                filters: [
                  {
                    memcmp: {
                      offset: 124,
                      bytes: voteAccount
                    }
                  }
                ]
              }
            ]
          })
        });
        
        const data = await response.json();
        
        if (!data.result || data.result.length === 0) {
          body.innerHTML = `
            <div class="stake-breakdown-loading">
              <span>No stake accounts found for this validator</span>
            </div>
          `;
          return;
        }
        
        // Build account list with withdrawer info
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
        
        // Check for user selections first
        const userSelections = getSelfStakeSelections(voteAccount);
        
        if (hasUserClassification(userSelections)) {
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
            detectionMethod = 'not-configured';
            for (const acc of accountsWithRates) {
              delegatedStake += acc.stakeXNT;
              delegators.push({ address: acc.staker, amount: acc.stakeXNT, pubkey: acc.pubkey });
            }
          }
        }
        
        // Sort delegators by amount (largest first)
        delegators.sort((a, b) => b.amount - a.amount);
        
        // Fetch validator's inflation rewards to calculate derived baseAPY
        let derivedBaseAPY = 8; // Default fallback
        try {
          const validatorRewards = await fetchTotalValidatorRewards(voteAccount, commission, 7);
          if (validatorRewards && validatorRewards.length > 0) {
            const totalRewardsXNT = validatorRewards.reduce((sum, r) => sum + r.amount, 0) / 1e9;
            const avgEpochRewardsXNT = totalRewardsXNT / validatorRewards.length;
            const totalAnnualRewards = avgEpochRewardsXNT * epochsPerYear();
            
            // Derive baseAPY: totalRewards = baseAPY * (selfStake + delegatedStake * commission%)
            const divisor = selfStake + (delegatedStake * commission / 100);
            if (divisor > 0) {
              derivedBaseAPY = (totalAnnualRewards / divisor) * 100;
            }
          }
        } catch (e) {
          console.warn('Could not fetch validator rewards for APY calculation:', e);
        }
        
        const breakdownData = {
          selfStake,
          delegatedStake,
          totalStake: selfStake + delegatedStake,
          delegators,
          selfStakeAccounts,
          accountCount: data.result.length,
          detectionMethod: detectionMethod,
          derivedBaseAPY: derivedBaseAPY
        };
        
        // Cache the result
        stakeBreakdownCache[cacheKey] = {
          timestamp: Date.now(),
          data: breakdownData
        };
        
        renderStakeBreakdown(breakdownData, validatorName, totalStake, commission, voteAccount);
        
      } catch (err) {
        console.error('Error fetching stake breakdown:', err);
        body.innerHTML = `
          <div class="stake-breakdown-loading">
            <span style="color: var(--danger);">Error loading stake breakdown</span>
            <span style="font-size: 0.75rem; color: var(--text-dim);">${err.message}</span>
          </div>
        `;
      }
    }
    
    function closeStakeBreakdown() {
      document.getElementById('stakeBreakdownModal').style.display = 'none';
      document.body.style.overflow = '';
    }
    
    // Stake Selection Modal Functions
    let currentStakeSelectionData = null;
    let currentStakeSelectionVote = null;
    let currentStakeCategories = null;   // Map<pubkey, 'foundation'|'ripper'|'self'|'community'>
    let currentStakeSelectionName = '';
    
    async function openStakeSelection(voteAccount, validatorName) {
      const modal = document.getElementById('stakeSelectionModal');
      const body = document.getElementById('stakeSelectionBody');
      
      modal.style.display = 'flex';
      document.body.style.overflow = 'hidden';
      currentStakeSelectionVote = voteAccount;
      
      body.innerHTML = `
        <div class="stake-selection-loading">
          <div class="loading-spinner-small"></div>
          <span>Loading stake accounts for ${escHtml(validatorName)}...</span>
        </div>
      `;
      
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
        
        if (!data.result || data.result.length === 0) {
          body.innerHTML = `
            <div class="stake-selection-loading">
              <span>No stake accounts found for this validator</span>
            </div>
          `;
          return;
        }
        
        // Current epoch — used to flag stake that's fully cooled-down (inactive)
        // so we can exclude it from the active-eligible delegated total.
        let curEpoch = (typeof currentEpochNumber === 'number') ? currentEpochNumber : 0;
        try { const ei = await getEpochInfoCached(); if (ei && typeof ei.epoch === 'number') curEpoch = ei.epoch; } catch (e) { /* fall back to cached epoch */ }

        // Parse each account's DELEGATED stake (delegation.stake) and a coarse
        // state from the delegation epochs. We deliberately do NOT use
        // getStakeActivation for the active number: it's deprecated and was
        // reporting still-warming delegation as fully active, which disagreed
        // with the validator's authoritative Active Stake (getVoteAccounts).
        // The official active total comes from the card value instead; here we
        // only need delegated amounts + an inactive flag to exclude cooled stake.
        const MAX_U64 = '18446744073709551615';
        const stakeAccounts = data.result.map(acc => {
          const stakeInfo = acc.account.data.parsed?.info;
          const meta = stakeInfo?.meta;
          const delegation = stakeInfo?.stake?.delegation || null;
          const delegatedLamports = (delegation && delegation.stake) ? parseInt(delegation.stake) : 0;
          const actEpoch = delegation ? parseInt(delegation.activationEpoch) : NaN;
          const deactRaw = delegation ? delegation.deactivationEpoch : null;
          const isDeact = deactRaw && deactRaw !== MAX_U64;
          const deactEpoch = isDeact ? parseInt(deactRaw) : null;
          let state = 'active';
          if (!delegation || delegatedLamports === 0) state = 'inactive';
          else if (isDeact) state = (deactEpoch >= curEpoch) ? 'deactivating' : 'inactive';
          else if (!isNaN(actEpoch) && actEpoch >= curEpoch) state = 'activating';
          // "Active-eligible" = anything that contributes to (or is becoming)
          // active stake: fully active, cooling (still counts), or warming up.
          // Excludes only fully-cooled (inactive) delegations like a closed pool.
          const activeEligible = (state !== 'inactive');
          return {
            pubkey: acc.pubkey,
            stakeXNT: delegatedLamports / 1e9,         // delegated stake (real per-account figure)
            delegatedXNT: delegatedLamports / 1e9,
            state,
            activeEligible,
            countsActive: activeEligible,              // used for dim/sort below
            withdrawer: meta?.authorized?.withdrawer || 'Unknown',
            staker: meta?.authorized?.staker || 'Unknown'
          };
        }).sort((a, b) => (b.activeEligible - a.activeEligible) || (b.stakeXNT - a.stakeXNT));
        
        currentStakeSelectionData = stakeAccounts;
        currentStakeSelectionName = validatorName;

        // Fetch the vote account's authorized withdrawer — self-stake is
        // auto-detected when a stake account's withdrawer matches it
        // (same logic the Terminal uses).
        let voteWithdrawer = null;
        try {
          const vaResp = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
              params: [voteAccount, { encoding: 'jsonParsed' }]
            })
          });
          const vaData = await vaResp.json();
          voteWithdrawer = vaData.result?.value?.data?.parsed?.info?.authorizedWithdrawer || null;
        } catch (e) { /* non-fatal: self just won't auto-detect */ }

        // Resolve each account's starting category. Honor a prior explicit
        // classification; otherwise auto-detect. Foundation/Ripper are
        // always hard-coded by withdrawer.
        const stored   = getSelfStakeSelections(voteAccount);
        const explicit = hasUserClassification(stored);
        const storedSelf = new Set((stored && stored.pubkeys) || []);
        const cats = new Map();
        stakeAccounts.forEach(acc => {
          const src = classifyStakeSource(acc.withdrawer);
          let cat;
          if (src === 'foundation') cat = 'foundation';
          else if (src === 'ripper') cat = 'ripper';
          else if (explicit) cat = storedSelf.has(acc.pubkey) ? 'self' : 'community';
          else cat = (acc.withdrawer && voteWithdrawer && acc.withdrawer === voteWithdrawer) ? 'self' : 'community';
          cats.set(acc.pubkey, cat);
        });
        currentStakeCategories = cats;

        // Make sure the authoritative active-stake value (the card / terminal
        // figure from getVoteAccounts) is available so the modal can lead with
        // it. getValidatorInfo returns the cached value instantly when the card
        // is already on screen; only fetches if somehow not cached yet.
        try { await getValidatorInfo(voteAccount); } catch (e) { /* banner falls back to delegated total */ }

        renderStakeSelection(body, stakeAccounts, cats, validatorName, voteAccount);
        
      } catch (err) {
        console.error('Error loading stake accounts:', err);
        body.innerHTML = `
          <div class="stake-selection-loading">
            <span style="color: var(--danger);">Error loading stake accounts</span>
          </div>
        `;
      }
    }
    
    function renderStakeSelection(body, stakeAccounts, cats, validatorName, voteAccount) {
      // Category tiles sum DELEGATED stake (active-eligible: excludes fully-cooled
      // inactive accounts). The authoritative ACTIVE total is the validator's
      // official getVoteAccounts figure (the card / terminal value) — we lead with
      // that and explain the gap, rather than trusting per-account getStakeActivation.
      const sums = { self: 0, foundation: 0, ripper: 0, community: 0 };
      let inactiveTotal = 0;
      stakeAccounts.forEach(acc => {
        if (!acc.activeEligible) { inactiveTotal += acc.delegatedXNT; return; }
        const c = cats.get(acc.pubkey) || 'community';
        sums[c] += acc.delegatedXNT;
      });
      const delegatedActive = sums.self + sums.foundation + sums.ripper + sums.community; // active-eligible delegated

      // Authoritative active stake = the card's getVoteAccounts.activatedStake (XNT).
      let cardActive = null;
      try {
        const ci = (typeof validatorInfoCache === 'object') ? validatorInfoCache[voteAccount] : null;
        if (ci && typeof ci.activatedStake === 'number') cardActive = ci.activatedStake;
      } catch (e) { /* fall back to the delegated total below */ }
      const activeStake = (cardActive !== null) ? cardActive : delegatedActive;
      // Anything delegated-and-eligible beyond the official active figure is stake
      // that's still warming up (cooling stake already counts as active, and
      // inactive stake is excluded above) — so the remainder is activating.
      const activatingTotal = Math.max(0, delegatedActive - activeStake);

      const metric = (val, label, color) => `
        <div class="stake-cat-metric">
          <div class="stake-cat-metric-value" style="color:${color};">${formatNumber(val, 0)}</div>
          <div class="stake-cat-metric-label">${label}</div>
        </div>`;

      // Top reconciliation banner: official active vs delegated, with the gap.
      const reconRow = (label, val, color, sub) => `
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:1rem;padding:0.15rem 0;">
          <span style="color:var(--text-secondary);font-size:0.78rem;">${label}${sub ? ` <span style="opacity:0.7;">${sub}</span>` : ''}</span>
          <span style="font-family:'JetBrains Mono',monospace;font-weight:600;color:${color};">${formatNumber(val, 2)} XNT</span>
        </div>`;
      const reconBanner = `
        <div style="background:rgba(0,0,0,0.18);border:1px solid var(--border);border-radius:10px;padding:0.6rem 0.85rem;margin-bottom:0.7rem;">
          ${reconRow('Active stake', activeStake, 'var(--success)', '· official, matches card')}
          ${activatingTotal > 0.5 ? reconRow('Activating (warming up)', activatingTotal, 'var(--warning)', '· not yet counted') : ''}
          ${inactiveTotal > 0.5 ? reconRow('Inactive (cooled down)', inactiveTotal, 'var(--text-secondary)', '· withdrawable') : ''}
          <div style="border-top:1px solid var(--border);margin:0.35rem 0 0.3rem;"></div>
          ${reconRow('Total delegated', delegatedActive + inactiveTotal, 'var(--text-primary)', '')}
        </div>`;

      body.innerHTML = `
        <div class="stake-selection-intro">
          <strong>Stake classification</strong><br>
          Each account is auto-identified. The <span style="color:var(--success);">Self-Stake</span> and
          <span style="color:var(--accent-blue);">Community</span> badges are clickable — tap one to flip it.
          <span style="color:var(--accent-cyan);">Foundation</span> and <span style="color:var(--accent-gold);">Ripper</span>
          are detected from known pool addresses and locked. Only Self-Stake earns 100%; the rest are delegated (commission only).
        </div>

        ${reconBanner}

        <div style="font-size:0.72rem;color:var(--text-secondary);margin:0 0 0.5rem;text-align:center;line-height:1.5;">
          The validator's <strong style="color:var(--success);">active stake is ${formatNumber(activeStake, 0)} XNT</strong> (from <code>getVoteAccounts</code> — the same figure on the card and the Validator Terminal).${activatingTotal > 0.5 ? ` The tiles below add up to ${formatNumber(delegatedActive, 0)} XNT <em>delegated</em>; the extra <strong style="color:var(--warning);">${formatNumber(activatingTotal, 0)} XNT</strong> is delegation that's still warming up and will roll into active stake once activation completes (typically the next epoch or two).` : ''}
        </div>

        <div style="font-size:0.66rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em;text-align:center;margin-bottom:0.3rem;">Delegated by source</div>
        <div class="stake-cat-summary">
          ${metric(sums.self, 'Self-Stake', 'var(--success)')}
          ${metric(sums.foundation, 'Foundation', 'var(--accent-cyan)')}
          ${metric(sums.ripper, 'Ripper', 'var(--accent-gold)')}
          ${metric(sums.community, 'Community', 'var(--accent-blue)')}
        </div>

        <div class="stake-selection-list">
          ${stakeAccounts.map(acc => {
            const cat = cats.get(acc.pubkey) || 'community';
            const dim = acc.activeEligible ? '' : 'opacity:0.55;';
            let note = '';
            if (!acc.activeEligible) {
              note = ` · <span style="color:var(--text-secondary);">inactive (cooled down)</span>`;
            } else if (acc.state === 'activating') {
              note = ` · <span style="color:var(--warning);">warming up</span>`;
            } else if (acc.state === 'deactivating') {
              note = ` · <span style="color:var(--warning);">cooling down (still active)</span>`;
            }
            return `
            <div class="stake-selection-item" data-pubkey="${acc.pubkey}" style="${dim}">
              <div class="stake-selection-info">
                <div class="stake-selection-address">${acc.pubkey.slice(0, 8)}...${acc.pubkey.slice(-8)} ${stakeCatBadge(acc.pubkey, cat)}</div>
                <div class="stake-selection-details">Withdrawer: ${acc.withdrawer.slice(0, 8)}...${acc.withdrawer.slice(-4)}${note}</div>
              </div>
              <div class="stake-selection-amount">${formatNumber(acc.delegatedXNT, 2)} XNT</div>
            </div>
          `;
          }).join('')}
        </div>

        <div class="stake-selection-actions">
          <button class="stake-selection-btn secondary" onclick="closeStakeSelection()">Cancel</button>
          <button class="stake-selection-btn primary" onclick="saveStakeSelections('${voteAccount}')">Save Classification</button>
        </div>
      `;
    }

    // Render a category badge. Self/Community are clickable (toggle between
    // the two); Foundation/Ripper are locked (hard-coded by pool address).
    function stakeCatBadge(pubkey, cat) {
      const meta = {
        self:       { label: 'Self-Stake', locked: false },
        community:  { label: 'Community',  locked: false },
        foundation: { label: 'Foundation', locked: true  },
        ripper:     { label: 'Ripper',     locked: true  }
      }[cat] || { label: 'Community', locked: false };
      const icon = meta.locked ? '🔒' : '⇄';
      const attrs = meta.locked
        ? 'title="Detected from a known pool address — locked"'
        : `onclick="event.stopPropagation(); cycleStakeCat('${pubkey}')" title="Click to switch between Self-Stake and Community"`;
      return `<span class="stake-cat ${cat}" ${attrs}>${meta.label} <span class="stake-cat-ico">${icon}</span></span>`;
    }

    // Flip a single account between self and community, then re-render.
    function cycleStakeCat(pubkey) {
      if (!currentStakeCategories) return;
      const cat = currentStakeCategories.get(pubkey);
      if (cat !== 'self' && cat !== 'community') return; // locked categories ignore clicks
      currentStakeCategories.set(pubkey, cat === 'self' ? 'community' : 'self');
      const body = document.getElementById('stakeSelectionBody');
      if (body) renderStakeSelection(body, currentStakeSelectionData, currentStakeCategories, currentStakeSelectionName, currentStakeSelectionVote);
    }

    
    function saveStakeSelections(voteAccount) {
      // Collect the accounts currently classified as self-stake. Foundation,
      // Ripper and Community all count as delegated, so only 'self' is stored.
      const selectedPubkeys = [];
      if (currentStakeCategories) {
        currentStakeCategories.forEach((cat, pk) => {
          if (cat === 'self') selectedPubkeys.push(pk);
        });
      }
      
      // Save to localStorage (explicit = the user deliberately classified,
      // so an empty self set is honored rather than re-auto-detected).
      setSelfStakeSelections(voteAccount, selectedPubkeys, true);
      
      // Clear every cache that derives from the self/delegated split so the
      // new classification shows up immediately (no page reload needed).
      // 1) Inline "Stake Details" cache
      if (stakeBreakdownCache[voteAccount]) {
        delete stakeBreakdownCache[voteAccount];
      }
      // 2) Calculator stake-breakdown cache (Staking + Compound read this)
      if (window.stakeBreakdownData && window.stakeBreakdownData[voteAccount]) {
        delete window.stakeBreakdownData[voteAccount];
      }
      // 3) Real-rewards cache (keyed `${vote}_total_${epochs}`) used by all
      //    validator-mode calculators and the historical-APY panel
      if (typeof totalRewardsCache === 'object' && totalRewardsCache) {
        Object.keys(totalRewardsCache).forEach(k => {
          if (k.indexOf(voteAccount + '_total_') === 0) delete totalRewardsCache[k];
        });
      }
      // 4) Reward-breakdown modal cache (honors selections for self bucket)
      if (typeof _rewardBreakdownCache === 'object' && _rewardBreakdownCache) {
        delete _rewardBreakdownCache[voteAccount];
      }
      
      // Also clear any inline stake details that may be open
      const section = document.querySelector(`[data-stake-section="${voteAccount}"]`);
      if (section) {
        section.dataset.loaded = 'false';
      }
      
      closeStakeSelection();
      
      // Show confirmation
      showToast('Stake classification saved! Stake details will now use your selections.');
    }
    
    function closeStakeSelection() {
      document.getElementById('stakeSelectionModal').style.display = 'none';
      document.body.style.overflow = '';
      currentStakeSelectionData = null;
      currentStakeSelectionVote = null;
      currentStakeCategories = null;
      currentStakeSelectionName = '';
    }
    
    // Simple toast notification
    function showToast(message) {
      const existing = document.querySelector('.toast-notification');
      if (existing) existing.remove();
      
      const toast = document.createElement('div');
      toast.className = 'toast-notification';
      toast.textContent = message;
      toast.style.cssText = `
        position: fixed;
        bottom: 2rem;
        left: 50%;
        transform: translateX(-50%);
        background: var(--accent-cyan);
        color: var(--bg-primary);
        padding: 1rem 1.5rem;
        border-radius: 8px;
        font-weight: 500;
        z-index: 10000;
        animation: slideUp 0.3s ease;
      `;
      
      document.body.appendChild(toast);
      
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    }
    
    // Show wallet required popup
    function showWalletRequired(action = 'perform this action') {
      const existing = document.querySelector('.wallet-required-popup');
      if (existing) existing.remove();
      
      const popup = document.createElement('div');
      popup.className = 'wallet-required-popup';
      popup.innerHTML = `
        <div class="wallet-required-content">
          <div class="wallet-required-icon">🔗</div>
          <div class="wallet-required-title">Wallet Required</div>
          <div class="wallet-required-message">Please connect your wallet to ${action}.</div>
          <div class="wallet-required-buttons">
            <button class="wallet-required-btn connect" onclick="this.closest('.wallet-required-popup').remove(); connectWallet();">Connect Wallet</button>
            <button class="wallet-required-btn cancel" onclick="this.closest('.wallet-required-popup').remove();">Cancel</button>
          </div>
        </div>
      `;
      popup.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10001;
        animation: fadeIn 0.2s ease;
      `;
      
      const content = popup.querySelector('.wallet-required-content');
      content.style.cssText = `
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 2rem;
        text-align: center;
        max-width: 360px;
        width: 90%;
        animation: slideUp 0.3s ease;
      `;
      
      const icon = popup.querySelector('.wallet-required-icon');
      icon.style.cssText = `
        font-size: 3rem;
        margin-bottom: 1rem;
      `;
      
      const title = popup.querySelector('.wallet-required-title');
      title.style.cssText = `
        font-size: 1.25rem;
        font-weight: 600;
        color: var(--text-primary);
        margin-bottom: 0.5rem;
      `;
      
      const message = popup.querySelector('.wallet-required-message');
      message.style.cssText = `
        color: var(--text-secondary);
        margin-bottom: 1.5rem;
        line-height: 1.5;
      `;
      
      const buttons = popup.querySelector('.wallet-required-buttons');
      buttons.style.cssText = `
        display: flex;
        gap: 0.75rem;
        justify-content: center;
      `;
      
      popup.querySelectorAll('.wallet-required-btn').forEach(btn => {
        btn.style.cssText = `
          padding: 0.75rem 1.5rem;
          border-radius: 8px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          border: none;
          font-size: 0.95rem;
        `;
        if (btn.classList.contains('connect')) {
          btn.style.background = 'var(--accent-gradient)';
          btn.style.color = 'var(--bg-primary)';
        } else {
          btn.style.background = 'var(--bg-secondary)';
          btn.style.color = 'var(--text-secondary)';
          btn.style.border = '1px solid var(--border)';
        }
      });
      
      // Close on background click
      popup.addEventListener('click', (e) => {
        if (e.target === popup) popup.remove();
      });
      
      document.body.appendChild(popup);
    }
    
    function renderStakeBreakdown(data, validatorName, totalStake, commission, voteAccount) {
      const body = document.getElementById('stakeBreakdownBody');
      // Safely extract with defaults
      if (!data) data = {};
      const selfStake = data.selfStake || 0;
      const delegatedStake = data.delegatedStake || 0;
      const delegators = Array.isArray(data.delegators) ? data.delegators : [];
      const accountCount = data.accountCount || 0;
      const detectionMethod = data.detectionMethod || 'unknown';
      
      const total = selfStake + delegatedStake;
      const selfPercent = total > 0 ? (selfStake / total) * 100 : 0;
      const delegatedPercent = total > 0 ? (delegatedStake / total) * 100 : 0;
      
      // Get validator icon and name
      let iconHtml = '';
      let displayName = validatorName;
      if (validatorInfoCache[voteAccount]) {
        displayName = validatorInfoCache[voteAccount].name || validatorName;
      }
      const firstLetter = (displayName || 'V').charAt(0).toUpperCase();
      if (validatorInfoCache[voteAccount] && validatorInfoCache[voteAccount].iconUrl) {
        iconHtml = `<img class="stake-breakdown-header-logo" src="${safeUrl(validatorInfoCache[voteAccount].iconUrl)}" alt="${escHtml(displayName)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
                    <div class="stake-breakdown-header-placeholder" style="display:none;">${firstLetter}</div>`;
      } else {
        iconHtml = `<div class="stake-breakdown-header-placeholder">${firstLetter}</div>`;
      }
      
      // Calculate SVG pie chart with minimum visual threshold
      const circumference = 2 * Math.PI * 100; // radius = 100
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
      
      // Calculate true APYs - use derived baseAPY if available
      const baseAPY = data.derivedBaseAPY || 8; // Network base APY
      const selfStakeAPY = baseAPY; // Self-stake gets full rewards
      const delegatorAPY = baseAPY * (1 - commission / 100); // Delegators get minus commission
      
      // Calculate validator's earnings breakdown
      const selfStakeEarnings = selfStake * (baseAPY / 100);
      const commissionEarnings = delegatedStake * (baseAPY / 100) * (commission / 100);
      const totalValidatorEarnings = selfStakeEarnings + commissionEarnings;
      
      // Calculate validator's effective APY (return on their self-stake investment)
      const validatorAPY = selfStake > 0 ? (totalValidatorEarnings / selfStake) * 100 : baseAPY;
      
      // Detection method note
      const detectionNote = 
        detectionMethod === 'user-selected' ? 'Based on your manual selections' :
        detectionMethod === 'withdrawer-match' ? 'Auto-detected by matching withdrawer addresses' :
        detectionMethod === 'not-configured' ? 'Not configured - click Active Stake to set up' :
        detectionMethod === 'reward-analysis' ? 'Detected by analyzing reward distribution patterns' :
        detectionMethod === 'cached' ? 'Using cached detection from previous analysis' :
        detectionMethod === 'heuristic-0pct' ? 'Estimated using stake size heuristics (0% commission)' :
        'Estimated using stake size heuristics';
      
      body.innerHTML = `
        <div class="stake-breakdown-header">
          ${iconHtml}
          <div class="stake-breakdown-header-info">
            <h3>${escHtml(displayName || voteAccount.slice(0,8) + '...')}</h3>
            <p>${formatNumber(total, 0)} XNT total • ${accountCount} stake accounts</p>
          </div>
        </div>
        
        ${commission === 0 ? `
        <div class="stake-zero-commission-warning">
          <div class="stake-warning-icon">⚠️</div>
          <div class="stake-warning-text">
            <strong>0% Commission Validator</strong><br>
            <span>With 0% commission, self-stake and delegations earn identical rewards, making it impossible to distinguish between them by analyzing reward patterns. The breakdown below is an estimate based on stake size heuristics.</span>
          </div>
        </div>
        ` : ''}
        
        <div class="stake-pie-container">
          <div class="stake-pie-chart">
            <svg width="240" height="240" viewBox="0 0 240 240">
              <circle cx="120" cy="120" r="100" fill="none" stroke="var(--bg-secondary)" stroke-width="14"/>
              <circle cx="120" cy="120" r="100" fill="none" stroke="var(--accent-cyan)" stroke-width="14"
                stroke-dasharray="${selfDash} ${circumference}" stroke-linecap="round"/>
              <circle cx="120" cy="120" r="100" fill="none" stroke="var(--accent-gold)" stroke-width="14"
                stroke-dasharray="${delegatedDash} ${circumference}" stroke-dashoffset="-${selfDash}" stroke-linecap="round"/>
            </svg>
            <div class="stake-pie-center">
              <div class="stake-pie-center-value">${formatNumber(total, 0)}</div>
              <div class="stake-pie-center-label">Total XNT</div>
            </div>
          </div>
        </div>
        
        <div class="stake-breakdown-stats">
          <div class="stake-stat-card self-stake">
            <div class="stake-stat-icon">👤</div>
            <div class="stake-stat-value">${formatNumber(selfStake, 0)}</div>
            <div class="stake-stat-label">Self-Stake</div>
            <div class="stake-stat-percent">${formatNumber(selfPercent, 1)}% of total</div>
          </div>
          <div class="stake-stat-card delegated">
            <div class="stake-stat-icon">🤝</div>
            <div class="stake-stat-value">${formatNumber(delegatedStake, 0)}</div>
            <div class="stake-stat-label">Delegated</div>
            <div class="stake-stat-percent">${formatNumber(delegatedPercent, 1)}% • ${delegators.length} delegators</div>
          </div>
        </div>
        
        <div class="stake-apy-section">
          <div class="stake-apy-title">
            💰 Earnings Breakdown (Estimated Annual)
            <span style="margin-left: 0.5rem; background: linear-gradient(135deg, var(--accent-cyan), var(--accent-gold)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; font-weight: 700; font-size: 1.1rem;">${formatNumber(validatorAPY, 2)}% APY</span>
            <span style="font-size: 0.7rem; color: var(--text-dim); margin-left: 0.25rem;">(7-day avg)</span>
          </div>
          <div class="stake-apy-grid">
            <div class="stake-apy-item">
              <div class="stake-apy-value">${formatNumber(selfStakeEarnings, 0)} XNT</div>
              <div class="stake-apy-label">From Self-Stake (${selfStakeAPY}% base)</div>
            </div>
            <div class="stake-apy-item">
              <div class="stake-apy-value">${formatNumber(commissionEarnings, 0)} XNT</div>
              <div class="stake-apy-label">From ${commission}% Commission</div>
            </div>
          </div>
          <div style="text-align: center; margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid rgba(0,255,163,0.2);">
            <span style="font-size: 0.8rem; color: var(--text-secondary);">Total Validator Earnings: </span>
            <span style="font-size: 1.1rem; font-weight: 600; color: var(--success);">${formatNumber(totalValidatorEarnings, 0)} XNT/year</span>
          </div>
        </div>
        
        ${delegators.length > 0 ? `
        <div class="stake-delegators-section">
          <div class="stake-delegators-header">
            <h4>🤝 Top Delegators</h4>
            <span class="stake-delegators-count">${delegators.length} total</span>
          </div>
          <div class="stake-delegators-list">
            ${delegators.slice(0, 10).map(d => `
              <div class="stake-delegator-item">
                <span class="stake-delegator-address">${d.address.slice(0, 8)}...${d.address.slice(-6)}</span>
                <span class="stake-delegator-amount">${formatNumber(d.amount, 0)} XNT</span>
              </div>
            `).join('')}
            ${delegators.length > 10 ? `
              <div style="text-align: center; padding: 0.5rem; color: var(--text-dim); font-size: 0.75rem;">
                + ${delegators.length - 10} more delegators
              </div>
            ` : ''}
          </div>
        </div>
        ` : ''}
        
        <div class="stake-cache-note">
          ${detectionNote}<br>
          Data cached for 5 minutes • Click "Stake details" again to refresh
        </div>
      `;
      
      // Store the breakdown data for use in calculators
      if (!window.stakeBreakdownData) window.stakeBreakdownData = {};
      window.stakeBreakdownData[voteAccount] = {
        selfStake,
        delegatedStake,
        total,
        commission,
        delegatorCount: delegators.length
      };
    }

    async function fetchManageValidatorData(voteAccount) {
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getVoteAccounts',
            params: []
          })
        });
        
        const data = await response.json();
        if (data.result) {
          const allValidators = [...data.result.current, ...data.result.delinquent];
          const validator = allValidators.find(v => v.votePubkey === voteAccount);
          
          if (validator) {
            const epochCredits = validator.epochCredits || [];
            if (epochCredits.length > 0) {
              const lastCredits = epochCredits[epochCredits.length - 1];
              document.getElementById('selectedCredits').textContent = formatNumber(lastCredits[1], 0);
            }
          }
        }
      } catch (e) {
        console.error('Error fetching validator data:', e);
      }
    }

    async function fetchStakeAccounts(voteAccount) {
      try {
        // Fetch current epoch first
        const epochInfo = await rpcCall('getEpochInfo');
        const currentEpoch = epochInfo.epoch;
        // Cache globally so other consumers (cooldown popover, projected
        // schedule, etc.) get correct epoch numbers even when the user
        // hasn't visited the Calculators tab. Previously this lived only
        // in a local var, which made the popover render epochs starting
        // from #0 because the global was still null.
        currentEpochData = epochInfo;
        
        // Fetch stake accounts delegated to this validator
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
                filters: [
                  {
                    memcmp: {
                      offset: 124,
                      bytes: voteAccount
                    }
                  }
                ]
              }
            ]
          })
        });
        
        const data = await response.json();
        stakeAccounts = [];
        
        if (data.result && data.result.length > 0) {
          // First pass: build basic record + naive state from delegation epochs
          const basicRecords = data.result.map(acc => {
            const info = acc.account.data.parsed?.info || {};
            const stake = info.stake || {};
            const delegation = stake.delegation || {};
            
            // Determine stake state
            const activationEpoch = parseInt(delegation.activationEpoch) || 0;
            const deactivationEpoch = delegation.deactivationEpoch;
            // MAX_U64 means not deactivating
            const isDeactivating = deactivationEpoch && deactivationEpoch !== '18446744073709551615';
            const deactivationEpochNum = isDeactivating ? parseInt(deactivationEpoch) : null;
            const delegatedLamports = delegation.stake ? parseInt(delegation.stake) : 0;
            
            let state = 'active';
            if (isDeactivating) {
              if (deactivationEpochNum >= currentEpoch) {
                state = 'deactivating';
              } else {
                state = 'inactive';
              }
            } else if (activationEpoch >= currentEpoch) {
              state = 'activating';
            }
            
            return {
              pubkey: acc.pubkey,
              lamports: acc.account.lamports,
              data: info,
              state: state,
              activationEpoch: activationEpoch,
              deactivationEpoch: deactivationEpochNum,
              isDeactivating: isDeactivating,
              delegatedLamports: delegatedLamports,
              // Will be filled in second pass via getStakeActivation:
              activeLamports: 0,
              inactiveLamports: 0,
              activationDataLoaded: false,
              staker: info.meta?.authorized?.staker || null,
              withdrawer: info.meta?.authorized?.withdrawer || null
            };
          });
          
          // Second pass: for any stake that's transitioning OR appears inactive due to
          // a past deactivation epoch, query getStakeActivation to find out how much has
          // *actually* cooled down. Solana/X1 rate-limits deactivations per epoch via
          // the stake history sysvar, so a stake that looks "inactive" by epoch math
          // can still have an active (cooling) portion that is NOT yet withdrawable.
          // This is what causes the "insufficient funds" error on withdraw attempts.
          await Promise.all(basicRecords.map(async rec => {
            // Only query for stakes where the active/inactive split matters.
            // Pure 'active' stakes (never deactivated) and pure 'activating' stakes
            // don't need this — the user can't withdraw them anyway.
            if (rec.state !== 'deactivating' && rec.state !== 'inactive') {
              // For active/activating stakes, the active portion is just the delegation.
              rec.activeLamports = rec.delegatedLamports;
              rec.inactiveLamports = 0;
              rec.activationDataLoaded = true;
              return;
            }
            try {
              const act = await rpcCall('getStakeActivation', [rec.pubkey, { commitment: 'confirmed' }]);
              if (act && typeof act === 'object') {
                rec.activeLamports   = parseInt(act.active   || 0) || 0;
                rec.inactiveLamports = parseInt(act.inactive || 0) || 0;
                rec.activationDataLoaded = true;
                // Reclassify: if RPC says state is something different (e.g. still
                // 'deactivating' even though we're past deactivationEpoch), trust it.
                if (act.state === 'deactivating' || act.state === 'inactive' ||
                    act.state === 'activating'  || act.state === 'active') {
                  rec.state = act.state;
                }
                // Belt-and-suspenders: even if RPC says 'inactive' but active>0
                // (shouldn't happen but seen on some forks), treat as still cooling.
                if (rec.activeLamports > 0 && rec.isDeactivating) {
                  rec.state = 'deactivating';
                }
              }
            } catch (e) {
              // getStakeActivation is deprecated in newer Solana releases. If it fails,
              // fall back to a conservative estimate: assume the delegated amount is
              // still cooling unless the deactivation epoch is well in the past.
              console.warn('getStakeActivation failed for', rec.pubkey, e.message);
              if (rec.state === 'inactive') {
                // Best-effort: assume fully cooled (old behavior)
                rec.activeLamports = 0;
                rec.inactiveLamports = rec.delegatedLamports;
              } else {
                rec.activeLamports = rec.delegatedLamports;
                rec.inactiveLamports = 0;
              }
              rec.activationDataLoaded = false;
            }
          }));
          
          stakeAccounts = basicRecords.sort((a, b) => b.lamports - a.lamports);
          
          renderStakeAccounts();
        } else {
          document.getElementById('stakeAccountsContainer').innerHTML = 
            '<div class="loading-text">No stake accounts found</div>';
        }
      } catch (e) {
        console.error('Error fetching stake accounts:', e);
        document.getElementById('stakeAccountsContainer').innerHTML = 
          '<div class="loading-text">Error loading stake accounts</div>';
      }
    }

    function renderStakeAccounts() {
      const container = document.getElementById('stakeAccountsContainer');
      
      if (stakeAccounts.length === 0) {
        container.innerHTML = '<div class="loading-text">No stake accounts found</div>';
        return;
      }
      
      // Define state priority for sorting (lower = higher priority)
      const statePriority = {
        'active': 1,
        'activating': 2,
        'deactivating': 3,
        'inactive': 4
      };
      
      // Create sorted array with original indices preserved
      const sortedStakes = stakeAccounts
        .map((stake, index) => ({ stake, originalIndex: index }))
        .sort((a, b) => {
          // First sort by state priority
          const priorityA = statePriority[a.stake.state] || 1;
          const priorityB = statePriority[b.stake.state] || 1;
          
          if (priorityA !== priorityB) {
            return priorityA - priorityB;
          }
          
          // Then sort by balance (highest first)
          return b.stake.lamports - a.stake.lamports;
        });
      
      // Resolve stake-source category for the per-row badges, mirroring the
      // Stake Classification modal: Foundation/Ripper are hard-coded by pool
      // address; otherwise honor a saved classification, else auto-detect
      // self via the vote account's withdrawer.
      const mvVote     = currentManageValidator && currentManageValidator.voteAccount;
      const mvSel      = mvVote ? getSelfStakeSelections(mvVote) : null;
      const mvExplicit = hasUserClassification(mvSel);
      const mvSelfSet  = new Set((mvSel && mvSel.pubkeys) || []);

      container.innerHTML = sortedStakes.map(({ stake, originalIndex }) => {
        // Determine badge text and class based on state
        let badgeText = 'STAKE';
        let badgeClass = 'stake';
        
        // A "cooling" stake is one that's deactivating but has at least some
        // already-cooled (withdrawable) lamports — surface this distinctly so
        // users know they can partially withdraw now.
        const isPartiallyCooled = stake.state === 'deactivating' &&
                                  (stake.activeLamports || 0) > 0 &&
                                  (stake.inactiveLamports || 0) > 0;
        
        switch (stake.state) {
          case 'activating':
            badgeText = 'ACTIVATING';
            badgeClass = 'stake activating';
            break;
          case 'deactivating':
            badgeText = isPartiallyCooled ? 'COOLING' : 'DEACTIVATING';
            badgeClass = 'stake deactivating';
            break;
          case 'inactive':
            badgeText = 'INACTIVE';
            badgeClass = 'stake inactive';
            break;
          default:
            badgeText = 'STAKE';
            badgeClass = 'stake active';
        }
        
        // Check if connected wallet has authority
        const hasStakeAuth = walletPublicKey && stake.staker === walletPublicKey;
        const hasWithdrawAuth = walletPublicKey && stake.withdrawer === walletPublicKey;
        
        // Build cooldown hint shown next to the balance for partially-cooled stakes
        let cooldownHint = '';
        if (isPartiallyCooled) {
          const totalDelegated = (stake.activeLamports || 0) + (stake.inactiveLamports || 0);
          const pctCooled = totalDelegated > 0
            ? ((stake.inactiveLamports || 0) / totalDelegated * 100)
            : 0;
          cooldownHint =
            `<span title="${formatNumber((stake.inactiveLamports||0)/1e9, 4)} XNT cooled / ${formatNumber(totalDelegated/1e9, 4)} XNT total" `
            + `style="color: var(--warning); font-size: 0.7rem; margin-left: 0.5rem; font-family: 'JetBrains Mono', monospace;">`
            + `${pctCooled.toFixed(0)}% cooled</span>`;
        }
        
        // Classify the stake into one of four buckets and surface a badge
        // next to the Stake/Withdraw authority badges so the user can see at
        // a glance whether each account is self-stake, foundation, ripper,
        // or community delegation.
        let stakeCat;
        const _src = classifyStakeSource(stake.withdrawer);
        if (_src === 'foundation') stakeCat = 'foundation';
        else if (_src === 'ripper') stakeCat = 'ripper';
        else if (mvExplicit) stakeCat = mvSelfSet.has(stake.pubkey) ? 'self' : 'community';
        else stakeCat = (stake.withdrawer && manageVoteWithdrawAuthority && stake.withdrawer === manageVoteWithdrawAuthority) ? 'self' : 'community';
        const sourceBadgeHtml = ({
          self:       '<span class="stake-source-badge self" title="Validator self-stake — earns 100% of rewards">SELF-STAKE</span>',
          foundation: '<span class="stake-source-badge foundation" title="Stake routed via X1 Labs / Foundation pool">FOUNDATION</span>',
          ripper:     '<span class="stake-source-badge ripper" title="Stake routed via Ripper Pool">RIPPER POOL</span>',
          community:  '<span class="stake-source-badge community" title="Community delegation — validator earns commission only">COMMUNITY</span>'
        })[stakeCat] || '';

        return `
          <div class="account-row ${selectedAccountType === 'stake-${originalIndex}' ? 'selected' : ''}" onclick="selectAccount('stake-${originalIndex}')">
            <div class="account-row-left">
              <span class="account-type-badge ${badgeClass}" data-stake-idx="${originalIndex}">${badgeText}</span>
              <span class="account-address">${shortenAddress(stake.pubkey)}</span>
              ${getCopyButtonHtml(stake.pubkey)}
              <span style="color: var(--text-dim); font-size: 0.75rem; margin-left: 0.5rem;"
                    title="Delegated stake (account balance: ${formatNumber(lamportsToXNT(stake.lamports), 2)} XNT)">
                ${formatNumber(lamportsToXNT(stake.delegatedLamports ?? stake.lamports), 2)} XNT
              </span>
              ${cooldownHint}
            </div>
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              ${sourceBadgeHtml}
              <div class="authority-badges">
                <span class="auth-badge ${hasStakeAuth ? 'has-auth' : 'no-auth'}">Stake</span>
                <span class="auth-badge ${hasWithdrawAuth ? 'has-auth' : 'no-auth'}">Withdraw</span>
              </div>
              <button class="account-select-btn ${selectedAccountType === 'stake-${originalIndex}' ? 'selected' : ''}" id="stakeSelectBtn-${originalIndex}">
                ${selectedAccountType === 'stake-${originalIndex}' ? '● Selected' : 'Select'}
              </button>
            </div>
          </div>
        `;
      }).join('');
      
      // Wire up cooldown popovers on each stake-row badge after render.
      // We do this here (rather than via inline onmouseenter on a string) so the
      // handlers close over the correct stake index and don't have to escape
      // through a global lookup at event time.
      container.querySelectorAll('.account-type-badge[data-stake-idx]').forEach(badge => {
        const idx = parseInt(badge.getAttribute('data-stake-idx'));
        badge.addEventListener('mouseenter', () => showCooldownPopover(badge, idx));
        badge.addEventListener('mouseleave', () => scheduleHideCooldownPopover());
        // Click to pin/unpin (works on touch via tap; also lets desktop users
        // keep the popover open while they read it). We stopPropagation so
        // the click doesn't also trigger row selection.
        badge.addEventListener('click', (e) => {
          e.stopPropagation();
          if (_cdPopoverPinned && _cdPopoverCurrentBadge === badge) {
            hideCooldownPopover();
          } else {
            pinCooldownPopover(badge, idx);
          }
        });
      });
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // COOLDOWN INFO + POPOVER ENGINE
    // Shared across stake-list badges (hover) and the Stake Account Details
    // panel (cooldown progress card). Computes observed cooldown rate from
    // the stake's deactivationEpoch + activeLamports/inactiveLamports split,
    // and projects the remaining release schedule forward.
    // ════════════════════════════════════════════════════════════════════════
    
    function getStakeCooldownInfo(stake) {
      const cooled  = stake.inactiveLamports || 0;
      const cooling = stake.activeLamports   || 0;
      const total   = cooled + cooling;
      const pctCooled = total > 0 ? (cooled / total) * 100 : 0;
      const currentEpoch = currentEpochData?.epoch ?? null;
      const slotsInEpoch = currentEpochData?.slotsInEpoch ?? 432000;
      const slotIndex    = currentEpochData?.slotIndex ?? 0;
      const slotMs       = 400;
      const epochDurationMs = slotsInEpoch * slotMs;
      const currentEpochRemainingMs = epochDurationMs * (1 - slotIndex / slotsInEpoch);
      const now = new Date();
      
      // Approximate completed cooldown epochs:
      // - If we deactivated at epoch D and current is D, no cooldown yet (still in deactivation epoch)
      // - If current is D+1, we're in the 1st cooldown epoch (partially complete)
      // - If current is D+N, we've fully completed N-1 cooldown epochs
      let completedEpochs = 0;
      if (stake.isDeactivating && stake.deactivationEpoch != null && currentEpoch != null) {
        completedEpochs = Math.max(0, currentEpoch - stake.deactivationEpoch - 1);
      }
      
      // Estimate per-epoch rate (lamports). Prefer observation, fall back to
      // a 50% default of the original total — that matches what users have
      // been reporting on X1 right now and gives a reasonable "if congestion
      // continues" projection.
      let rateLamports, rateSource;
      if (cooled > 0 && completedEpochs >= 1) {
        rateLamports = cooled / completedEpochs;
        rateSource = 'observed';
      } else {
        rateLamports = Math.max(1, total * 0.5);
        rateSource = 'estimated';
      }
      
      // Future schedule: project by `rateLamports` until cooling exhausted.
      const future = [];
      let remaining = cooling;
      let cum = cooled;
      // Anchor projection to the first epoch in which a release can actually
      // land. The deactivation epoch itself produces no release (the stake is
      // still active during it); the first cooldown epoch is deactivationEpoch+1.
      // If currentEpoch is already past that — i.e. we're mid-cooldown — we
      // start from currentEpoch (its end is the next pending release).
      let projStartEpoch;
      if (stake.deactivationEpoch != null) {
        const firstCooldownEpoch = stake.deactivationEpoch + 1;
        projStartEpoch = currentEpoch != null
          ? Math.max(currentEpoch, firstCooldownEpoch)
          : firstCooldownEpoch;
      } else {
        projStartEpoch = currentEpoch != null ? currentEpoch : 0;
      }
      for (let i = 0; i < 30 && remaining > 1; i++) {  // cap 30 epochs
        const release = Math.min(rateLamports, remaining);
        remaining -= release;
        cum += release;
        const epoch = projStartEpoch + i;
        // ms from now until END of this epoch. Number of full epochs between
        // currentEpoch and `epoch` is (epoch - currentEpoch); on top of that
        // there's the time remaining in the current epoch itself.
        const epochsAhead = currentEpoch != null ? (epoch - currentEpoch) : i;
        const msFromNow = currentEpochRemainingMs + epochsAhead * epochDurationMs;
        future.push({
          epoch,
          released: release,
          cumulative: cum,
          remainingAfter: remaining,
          msFromNow
        });
      }
      
      const completionEpoch = future.length > 0 ? future[future.length - 1].epoch : null;
      const completionMs = future.length > 0 ? future[future.length - 1].msFromNow : 0;
      const completionDate = new Date(now.getTime() + completionMs);
      
      return {
        currentEpoch, total, cooled, cooling, pctCooled,
        completedEpochs, rateLamports, rateSource,
        future,
        completionEpoch, completionDate,
        isDeactivating: stake.isDeactivating === true,
        isFullyCooled: stake.isDeactivating && cooling === 0
      };
    }
    
    function renderCooldownPopoverHTML(stake) {
      const fmt = (lamports, dp = 4) => formatNumber(lamports / 1e9, dp);
      const stateLabel = (() => {
        if (stake.state === 'deactivating' && stake.activeLamports > 0 && stake.inactiveLamports > 0) return { text: 'COOLING', cls: 'cooling' };
        if (stake.state === 'deactivating') return { text: 'DEACTIVATING', cls: 'deactivating' };
        if (stake.state === 'inactive')      return { text: 'INACTIVE',     cls: 'inactive' };
        if (stake.state === 'activating')    return { text: 'ACTIVATING',   cls: 'activating' };
        return { text: 'ACTIVE', cls: 'active' };
      })();
      const head = `
        <div class="cooldown-popover-head">
          <span class="cd-state ${stateLabel.cls}">${stateLabel.text}</span>
          <span class="cd-addr">${shortenAddress(stake.pubkey)}</span>
        </div>`;
      
      // Simple states (active, activating, fully inactive): one-liner content
      if (stake.state === 'active') {
        return head + `
          <div style="font-size:0.82rem; line-height:1.55;">
            Stake is delegated and earning rewards.<br>
            <span style="font-size:0.74rem; color:var(--text-dim);">
              Activated at epoch <strong style="color:var(--text-primary); font-family:'JetBrains Mono', monospace;">${stake.activationEpoch ?? '—'}</strong>.
              To unstake, click the row → Undelegate.
            </span>
          </div>`;
      }
      if (stake.state === 'activating') {
        return head + `
          <div style="font-size:0.82rem; line-height:1.55;">
            Stake is warming up.<br>
            <span style="font-size:0.74rem; color:var(--text-dim);">
              Becomes fully active at the start of epoch
              <strong style="color:var(--text-primary); font-family:'JetBrains Mono', monospace;">${(stake.activationEpoch ?? 0) + 1}</strong>.
            </span>
          </div>`;
      }
      
      const info = getStakeCooldownInfo(stake);
      
      if (stake.state === 'inactive' && !info.isDeactivating) {
        return head + `
          <div style="font-size:0.82rem; line-height:1.55;">
            Stake is fully inactive — no active delegation.<br>
            <span style="font-size:0.74rem; color:var(--text-dim);">
              ${fmt(stake.lamports)} XNT is liquid and ready to withdraw.
            </span>
          </div>`;
      }
      
      // Deactivating, cooling, or fully-cooled: full breakdown
      const progressBar = `
        <div class="cooldown-progress-row">
          <span class="cd-amount cooled">${fmt(info.cooled)} XNT cooled</span>
          <span style="font-family:'JetBrains Mono', monospace; font-weight:700; color:${info.pctCooled >= 100 ? 'var(--success)' : 'var(--warning)'};">${info.pctCooled.toFixed(1)}%</span>
        </div>
        <div class="cooldown-progress-bar">
          <div class="cooldown-progress-bar-fill" style="width:${info.pctCooled.toFixed(1)}%"></div>
        </div>
        <div class="cooldown-progress-row">
          <span class="cd-amount cooling">${fmt(info.cooling)} XNT still cooling</span>
          <span style="color:var(--text-dim); font-size:0.72rem;">of ${fmt(info.total)} XNT total</span>
        </div>`;
      
      const pastSection = info.isDeactivating ? `
        <div class="cooldown-section-label">Past Activity</div>
        <div class="cooldown-meta-row">
          <span class="cd-meta-key">Initiated</span>
          <span class="cd-meta-val">Epoch ${stake.deactivationEpoch ?? '—'}</span>
        </div>
        <div class="cooldown-meta-row">
          <span class="cd-meta-key">Cooldown epochs elapsed</span>
          <span class="cd-meta-val">${info.completedEpochs}</span>
        </div>
        <div class="cooldown-meta-row">
          <span class="cd-meta-key">${info.rateSource === 'observed' ? 'Observed rate' : 'Assumed rate'}</span>
          <span class="cd-meta-val">~${fmt(info.rateLamports, 2)} XNT/epoch</span>
        </div>` : '';
      
      let scheduleSection = '';
      if (info.future.length > 0) {
        const visible = info.future.slice(0, 5);
        const hiddenCount = info.future.length - visible.length;
        const rows = visible.map((f, i) => {
          const isLast = (i === visible.length - 1) && hiddenCount === 0;
          const date = new Date(Date.now() + f.msFromNow);
          return `
            <div class="cooldown-mini-row ${isLast ? 'complete' : ''}">
              <span class="cooldown-mini-cell epoch">#${f.epoch}</span>
              <span class="cooldown-mini-cell released">+${fmt(f.released)}</span>
              <span class="cooldown-mini-cell" style="color:var(--text-dim); font-size:0.7rem;">${date.toLocaleDateString('en-US', { month:'short', day:'numeric' })}</span>
            </div>`;
        }).join('');
        const moreRow = hiddenCount > 0
          ? `<div class="cooldown-mini-more">+ ${hiddenCount} more epoch${hiddenCount === 1 ? '' : 's'} until fully cooled</div>`
          : '';
        scheduleSection = `
          <div class="cooldown-section-label">Projected Schedule ${info.rateSource === 'estimated' ? '(estimate)' : ''}</div>
          <div style="font-size:0.7rem; color:var(--text-dim); margin: -0.2rem 0 0.4rem;">
            Each row shows when a chunk becomes withdrawable (at the end of that epoch).
          </div>
          <div class="cooldown-mini-table">
            <div class="cooldown-mini-row head">
              <span>End of Epoch</span>
              <span>Released</span>
              <span>Ready by</span>
            </div>
            ${rows}
            ${moreRow}
          </div>`;
      }
      
      let foot = '';
      if (info.cooling > 0 && info.completionEpoch != null) {
        const days = info.future.length > 0
          ? (info.future[info.future.length - 1].msFromNow / (1000 * 60 * 60 * 24))
          : 0;
        const dateLabel = info.completionDate.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
        foot = `
          <div class="cooldown-popover-foot">
            Fully cooled at end of epoch <strong>${info.completionEpoch}</strong> · ~${days.toFixed(1)} days · ${dateLabel}<br>
            <span style="opacity:0.75">Click badge again to unpin · Calculator tab lets you model other rates</span>
          </div>`;
      } else if (info.isFullyCooled) {
        foot = `
          <div class="cooldown-popover-foot" style="color:var(--success);">
            ✓ Fully cooled — ready to withdraw.
          </div>`;
      }
      
      return head + progressBar + pastSection + scheduleSection + foot;
    }
    
    // ── Popover engine state ────────────────────────────────────────────────
    let _cdHideTimer = null;
    let _cdPopoverPinned = false;
    let _cdPopoverCurrentBadge = null;
    
    function ensureCooldownPopoverWired() {
      const pop = document.getElementById('cooldownPopover');
      if (!pop || pop.dataset.wired === '1') return;
      pop.dataset.wired = '1';
      pop.addEventListener('mouseenter', () => {
        if (_cdHideTimer) { clearTimeout(_cdHideTimer); _cdHideTimer = null; }
      });
      pop.addEventListener('mouseleave', () => {
        if (!_cdPopoverPinned) scheduleHideCooldownPopover();
      });
      // Click outside dismisses pinned popover
      document.addEventListener('click', (e) => {
        if (!_cdPopoverPinned) return;
        if (pop.contains(e.target)) return;
        if (e.target.classList && e.target.classList.contains('account-type-badge')) return;
        hideCooldownPopover();
      });
      // Escape dismisses
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideCooldownPopover();
      });
      // Reposition on scroll/resize while shown
      window.addEventListener('scroll', () => {
        if (pop.classList.contains('show') && _cdPopoverCurrentBadge) {
          positionCooldownPopover(_cdPopoverCurrentBadge);
        }
      }, true);
      window.addEventListener('resize', () => {
        if (pop.classList.contains('show') && _cdPopoverCurrentBadge) {
          positionCooldownPopover(_cdPopoverCurrentBadge);
        }
      });
    }
    
    function showCooldownPopover(badgeEl, stakeIndex) {
      ensureCooldownPopoverWired();
      if (_cdHideTimer) { clearTimeout(_cdHideTimer); _cdHideTimer = null; }
      const stake = stakeAccounts[stakeIndex];
      if (!stake) return;
      const pop = document.getElementById('cooldownPopover');
      const content = document.getElementById('cooldownPopoverContent');
      content.innerHTML = renderCooldownPopoverHTML(stake);
      pop.classList.remove('flipped');
      pop.classList.add('show');
      _cdPopoverCurrentBadge = badgeEl;
      requestAnimationFrame(() => positionCooldownPopover(badgeEl));
    }
    
    function pinCooldownPopover(badgeEl, stakeIndex) {
      showCooldownPopover(badgeEl, stakeIndex);
      _cdPopoverPinned = true;
      document.getElementById('cooldownPopover').classList.add('pinned');
    }
    
    function scheduleHideCooldownPopover() {
      if (_cdPopoverPinned) return;
      if (_cdHideTimer) clearTimeout(_cdHideTimer);
      _cdHideTimer = setTimeout(hideCooldownPopover, 180);
    }
    
    function hideCooldownPopover() {
      const pop = document.getElementById('cooldownPopover');
      if (pop) pop.classList.remove('show', 'pinned');
      _cdPopoverPinned = false;
      _cdPopoverCurrentBadge = null;
      if (_cdHideTimer) { clearTimeout(_cdHideTimer); _cdHideTimer = null; }
    }
    
    function positionCooldownPopover(anchorEl) {
      const pop = document.getElementById('cooldownPopover');
      if (!pop || !anchorEl) return;
      const rect = anchorEl.getBoundingClientRect();
      pop.style.top = '0px';
      pop.style.left = '0px';
      const popRect = pop.getBoundingClientRect();
      const margin = 10;
      let top = rect.bottom + margin;
      let left = rect.left;
      let flipped = false;
      if (top + popRect.height > window.innerHeight - 8) {
        top = rect.top - popRect.height - margin;
        flipped = true;
      }
      if (left + popRect.width > window.innerWidth - 8) {
        left = window.innerWidth - popRect.width - 8;
      }
      if (left < 8) left = 8;
      pop.style.top = top + 'px';
      pop.style.left = left + 'px';
      pop.classList.toggle('flipped', flipped);
      // Adjust the arrow horizontally to point at the badge center
      const arrow = pop.querySelector('.cooldown-popover-arrow');
      if (arrow) {
        const badgeCenter = rect.left + rect.width / 2;
        const arrowLeft = Math.max(12, Math.min(popRect.width - 24, badgeCenter - left - 6));
        arrow.style.left = arrowLeft + 'px';
      }
    }
    
    // ── Update Cooldown Progress card in Stake Account Details panel ────────
    function updateCooldownProgressCard(stake) {
      const box = document.getElementById('cooldownProgressBox');
      if (!box) return;
      // Show only for deactivating stakes (any portion still cooling OR partially cooled)
      if (!stake || !stake.isDeactivating) {
        box.style.display = 'none';
        return;
      }
      const info = getStakeCooldownInfo(stake);
      box.style.display = 'block';
      
      const fmt = (l) => formatNumber(l / 1e9, 4);
      document.getElementById('cooldownProgressPct').textContent     = info.pctCooled.toFixed(1) + '%';
      document.getElementById('cooldownProgressBarFill').style.width = info.pctCooled.toFixed(1) + '%';
      document.getElementById('cooldownProgressCooled').textContent  = fmt(info.cooled)  + ' XNT';
      document.getElementById('cooldownProgressCooling').textContent = fmt(info.cooling) + ' XNT';
      document.getElementById('cooldownProgressTotal').textContent   = fmt(info.total)   + ' XNT';
      
      const summary = document.getElementById('cooldownProgressSummary');
      if (info.cooling === 0) {
        summary.innerHTML = `<span style="color:var(--success);">✓ Fully cooled — call <code>withdraw</code> to move funds.</span>`;
      } else if (info.completionEpoch != null) {
        const days = info.future.length > 0 ? info.future[info.future.length - 1].msFromNow / (1000*60*60*24) : 0;
        const dateLabel = info.completionDate.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
        const rateLabel = info.rateSource === 'observed' ? 'observed rate' : 'estimated rate';
        summary.innerHTML = `
          At <code>~${fmt(info.rateLamports)} XNT/epoch</code> (${rateLabel}) →
          fully cooled at end of epoch <code>${info.completionEpoch}</code>
          (~${days.toFixed(1)} days, ${dateLabel}).
          <span style="display:block; margin-top:0.3rem; color:var(--text-dim); font-size:0.72rem;">
            Hover the stake's badge above for the per-epoch projection.
          </span>`;
      } else {
        summary.innerHTML = `<span style="color:var(--text-dim);">Cooldown started — first release expected next epoch.</span>`;
      }
    }
    
    function toggleAuthorityLegend() {
      const legend = document.getElementById('authorityLegend');
      legend.classList.toggle('show');
    }

    function refreshStakeAccounts() {
      if (!currentManageValidator || !currentManageValidator.voteAccount) {
        showToast('No validator selected');
        return;
      }
      
      // Remember the currently selected account
      const currentSelection = selectedAccountType;
      
      // Show loading state
      document.getElementById('stakeAccountsContainer').innerHTML = 
        '<div class="loading-text">Refreshing stake accounts...</div>';
      
      // Fetch stake accounts and re-select after
      fetchStakeAccounts(currentManageValidator.voteAccount).then(() => {
        // Re-select the current account to refresh details
        if (currentSelection && currentSelection.startsWith('stake-')) {
          // Wait a bit for the stake accounts to render
          setTimeout(() => {
            selectAccount(currentSelection);
          }, 100);
        }
      });
      
      showToast('Stake accounts refreshed');
    }

    function selectAccount(accountType) {
      selectedAccountType = accountType;
      const authorityBadge = document.getElementById('authorityBadge');
      
      // Update UI for all rows
      document.querySelectorAll('.account-row').forEach(row => row.classList.remove('selected'));
      document.querySelectorAll('.account-select-btn').forEach(btn => {
        btn.classList.remove('selected');
        btn.textContent = 'Select';
      });
      
      if (accountType === 'vote') {
        document.getElementById('voteAccountRow').classList.add('selected');
        document.getElementById('voteSelectBtn').classList.add('selected');
        document.getElementById('voteSelectBtn').textContent = '● Selected';
        
        // Show vote account details (with address next to the title)
        document.getElementById('selectedAccountTitle').innerHTML = 
          `Vote Account Details<span class="details-title-address">${shortenAddress(currentManageValidator.voteAccount)}</span>${getCopyButtonHtml(currentManageValidator.voteAccount)}`;
        document.getElementById('selectedBalance').textContent = formatNumber(currentManageValidator.rewardsBalance, 4);
        document.getElementById('selectedCommission').textContent = currentManageValidator.commission + '%';
        
        // Show vote-specific boxes, hide stake-specific boxes
        document.getElementById('balanceBox').style.display = 'block';
        document.getElementById('stakedBalanceBox').style.display = 'none';
        document.getElementById('liquidBalanceBox').style.display = 'none';
        document.getElementById('cooldownProgressBox').style.display = 'none';
        document.getElementById('stakeAuthorityBox').style.display = 'none';
        document.getElementById('withdrawAuthorityBox').style.display = 'none';
        document.getElementById('voteAuthorityBox').style.display = 'block';
        document.getElementById('voteWithdrawAuthorityBox').style.display = 'block';
        document.getElementById('validatorIdBalanceBox').style.display = 'block';
        document.getElementById('walletBalanceBox').style.display = 'none';
        document.getElementById('creditsBox').style.display = 'block';
        document.getElementById('commissionBox').style.display = 'block';
        
        // Fetch validator ID balance
        document.getElementById('selectedValidatorIdBalance').textContent = 'Loading...';
        fetchValidatorIdBalance();
        
        // Fetch vote account authorities
        fetchVoteAccountAuthoritiesForDisplay();
        
        // Re-render all action groups for vote selection
        renderActions();
        
        // Re-fetch credits
        fetchManageValidatorData(currentManageValidator.voteAccount);
        
        // Update authority badge (no withdraw authority check needed for vote view)
        document.getElementById('authorityBadge').style.display = 'flex';
        document.getElementById('authorityBadgePair').style.display = 'none';
        
        if (walletPublicKey) {
          authorityBadge.className = 'authority-badge has-authority';
          authorityBadge.innerHTML = '<span class="authority-badge-icon">✓</span><span class="authority-badge-text">Wallet connected</span>';
        } else {
          authorityBadge.className = 'authority-badge clickable';
          authorityBadge.innerHTML = '<span class="authority-badge-icon">🔗</span><span class="authority-badge-text">No wallet connected</span>';
        }
        
      } else if (accountType.startsWith('stake-')) {
        const index = parseInt(accountType.split('-')[1]);
        const stake = stakeAccounts[index];
        
        const stakeRow = document.querySelector(`[onclick="selectAccount('stake-${index}')"]`);
        if (stakeRow) stakeRow.classList.add('selected');
        
        const stakeBtn = document.getElementById(`stakeSelectBtn-${index}`);
        if (stakeBtn) {
          stakeBtn.classList.add('selected');
          stakeBtn.textContent = '● Selected';
        }
        
        // Show stake account details (with address next to the title)
        document.getElementById('selectedAccountTitle').innerHTML = 
          `Stake Account Details<span class="details-title-address">${shortenAddress(stake.pubkey)}</span>${getCopyButtonHtml(stake.pubkey)}`;
        
        // Calculate staked vs liquid balance using rate-limit-aware
        // active/inactive lamports populated by fetchStakeAccounts.
        // (See comment in initiateWithdrawStake for full context on why the
        // naive "state === inactive → all liquid" check is wrong on X1.)
        const totalLamports = stake.lamports;
        const rentExemptForStake = 2282880;
        const activeLamports   = stake.activeLamports   ?? 0;
        const inactiveLamports = stake.inactiveLamports ?? 0;
        // "Locked" is the still-active/cooling portion that can't be withdrawn yet.
        const stakedLamports = activeLamports;
        // "Liquid" includes cooled-down stake + any un-delegated lamports
        // (rewards or extras), minus the rent reserve.
        const liquidLamports = Math.max(0, totalLamports - activeLamports - rentExemptForStake);
        
        document.getElementById('selectedStakedBalance').textContent = formatNumber(lamportsToXNT(stakedLamports), 4);
        document.getElementById('selectedLiquidBalance').textContent = formatNumber(lamportsToXNT(liquidLamports), 4);
        
        // Populate Cooldown Progress card (auto-hides when stake isn't deactivating)
        updateCooldownProgressCard(stake);
        
        // Show stake-specific boxes, hide vote-specific boxes
        document.getElementById('balanceBox').style.display = 'none';
        document.getElementById('stakedBalanceBox').style.display = 'block';
        document.getElementById('liquidBalanceBox').style.display = 'block';
        document.getElementById('withdrawAuthorityBox').style.display = 'block';
        document.getElementById('stakeAuthorityBox').style.display = 'block';
        document.getElementById('voteAuthorityBox').style.display = 'none';
        document.getElementById('voteWithdrawAuthorityBox').style.display = 'none';
        document.getElementById('validatorIdBalanceBox').style.display = 'none';
        document.getElementById('walletBalanceBox').style.display = 'none';
        document.getElementById('creditsBox').style.display = 'none';
        document.getElementById('commissionBox').style.display = 'none';
        
        // Re-render all action groups for stake selection
        renderActions();
        
        // Update stake authority for stake account
        const staker = stake.data.meta?.authorized?.staker;
        const stakeAuthorityIndicator = document.getElementById('stakeAuthorityIndicator');
        if (staker) {
          document.getElementById('selectedStakeAuthority').textContent = shortenAddress(staker);
          document.getElementById('stakeAuthorityCopyBtn').innerHTML = getCopyButtonHtml(staker);
          
          if (walletPublicKey && staker === walletPublicKey) {
            stakeAuthorityIndicator.textContent = '✓';
            stakeAuthorityIndicator.className = 'authority-indicator yours';
          } else if (walletPublicKey) {
            stakeAuthorityIndicator.textContent = '';
            stakeAuthorityIndicator.className = 'authority-indicator';
          } else {
            stakeAuthorityIndicator.textContent = '';
            stakeAuthorityIndicator.className = 'authority-indicator';
          }
        } else {
          document.getElementById('selectedStakeAuthority').textContent = 'Unknown';
          document.getElementById('stakeAuthorityCopyBtn').innerHTML = '';
          stakeAuthorityIndicator.textContent = '';
          stakeAuthorityIndicator.className = 'authority-indicator';
        }
        
        // Update withdraw authority for stake account
        const withdrawer = stake.data.meta?.authorized?.withdrawer;
        const withdrawAuthorityIndicator = document.getElementById('withdrawAuthorityIndicator');
        if (withdrawer) {
          document.getElementById('selectedWithdrawAuthority').textContent = shortenAddress(withdrawer);
          document.getElementById('withdrawAuthorityCopyBtn').innerHTML = getCopyButtonHtml(withdrawer);
          
          if (walletPublicKey && withdrawer === walletPublicKey) {
            withdrawAuthorityIndicator.textContent = '✓';
            withdrawAuthorityIndicator.className = 'authority-indicator yours';
          } else if (walletPublicKey) {
            withdrawAuthorityIndicator.textContent = '';
            withdrawAuthorityIndicator.className = 'authority-indicator';
          } else {
            withdrawAuthorityIndicator.textContent = '';
            withdrawAuthorityIndicator.className = 'authority-indicator';
          }
        } else {
          document.getElementById('selectedWithdrawAuthority').textContent = 'Unknown';
          document.getElementById('withdrawAuthorityCopyBtn').innerHTML = '';
          withdrawAuthorityIndicator.textContent = '';
          withdrawAuthorityIndicator.className = 'authority-indicator';
        }
        
        // Update authority badges - show the pair, hide the single badge
        document.getElementById('authorityBadge').style.display = 'none';
        document.getElementById('authorityBadgePair').style.display = 'flex';
        
        const stakeAuthorityBadge = document.getElementById('stakeAuthorityBadge');
        const withdrawAuthorityBadge = document.getElementById('withdrawAuthorityBadge');
        
        if (walletPublicKey) {
          const hasStakeAuthority = staker === walletPublicKey;
          const hasWithdrawAuthority = withdrawer === walletPublicKey;
          
          // Stake authority badge
          if (hasStakeAuthority) {
            stakeAuthorityBadge.className = 'authority-badge has-authority';
            stakeAuthorityBadge.innerHTML = '<span class="authority-badge-text">Stake Authority ✓</span>';
          } else {
            stakeAuthorityBadge.className = 'authority-badge no-authority';
            stakeAuthorityBadge.innerHTML = '<span class="authority-badge-text">Stake Authority ✗</span>';
          }
          
          // Withdraw authority badge
          if (hasWithdrawAuthority) {
            withdrawAuthorityBadge.className = 'authority-badge has-authority';
            withdrawAuthorityBadge.innerHTML = '<span class="authority-badge-text">Withdraw Authority ✓</span>';
          } else {
            withdrawAuthorityBadge.className = 'authority-badge no-authority';
            withdrawAuthorityBadge.innerHTML = '<span class="authority-badge-text">Withdraw Authority ✗</span>';
          }
        } else {
          // No wallet connected - show both as gray/neutral
          stakeAuthorityBadge.className = 'authority-badge';
          stakeAuthorityBadge.innerHTML = '<span class="authority-badge-text">Stake Authority</span>';
          withdrawAuthorityBadge.className = 'authority-badge';
          withdrawAuthorityBadge.innerHTML = '<span class="authority-badge-text">Withdraw Authority</span>';
        }
      }
    }

    // Fetch validator identity account balance
    async function fetchValidatorIdBalance() {
      if (!currentManageValidator || !currentManageValidator.identityPubkey) {
        document.getElementById('selectedValidatorIdBalance').textContent = '-';
        return;
      }
      
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBalance',
            params: [currentManageValidator.identityPubkey]
          })
        });
        
        const data = await response.json();
        if (data.result && data.result.value !== undefined) {
          document.getElementById('selectedValidatorIdBalance').textContent = formatNumber(lamportsToXNT(data.result.value), 4);
        } else {
          document.getElementById('selectedValidatorIdBalance').textContent = '-';
        }
      } catch (e) {
        console.error('Error fetching validator ID balance:', e);
        document.getElementById('selectedValidatorIdBalance').textContent = '-';
      }
    }

    // Fetch vote account authorities for display on manage page
    async function fetchVoteAccountAuthoritiesForDisplay() {
      if (!currentManageValidator || !currentManageValidator.voteAccount) {
        return;
      }
      
      // Set loading state
      document.getElementById('selectedVoteAuthority').textContent = 'Loading...';
      document.getElementById('selectedVoteWithdrawAuthority').textContent = 'Loading...';
      document.getElementById('voteAuthorityCopyBtn').innerHTML = '';
      document.getElementById('voteWithdrawAuthorityCopyBtn').innerHTML = '';
      
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [currentManageValidator.voteAccount, { encoding: 'jsonParsed' }]
          })
        });
        
        const data = await response.json();
        
        if (data.result && data.result.value) {
          const voteData = data.result.value.data.parsed.info;
          
          // Get vote authority - may be in authorizedVoters array or authorizedVoter field
          const voteAuthority = voteData.authorizedVoters?.[0]?.authorizedVoter || voteData.authorizedVoter;
          const withdrawAuthority = voteData.authorizedWithdrawer;
          
          // Cache withdraw authority and refresh action locks now that it's known
          manageVoteWithdrawAuthority = withdrawAuthority || null;
          renderActions();
          // Re-render the stake list now that the vote withdrawer is known,
          // so self-stake badges (withdrawer-match) resolve correctly even if
          // the stake accounts finished loading first.
          if (typeof stakeAccounts !== 'undefined' && stakeAccounts && stakeAccounts.length > 0) {
            renderStakeAccounts();
          }
          
          // Display Vote Authority
          const voteAuthorityIndicator = document.getElementById('voteAuthorityIndicator');
          if (voteAuthority) {
            document.getElementById('selectedVoteAuthority').textContent = shortenAddress(voteAuthority);
            document.getElementById('voteAuthorityCopyBtn').innerHTML = getCopyButtonHtml(voteAuthority);
            
            if (walletPublicKey && voteAuthority === walletPublicKey) {
              voteAuthorityIndicator.textContent = '✓';
              voteAuthorityIndicator.className = 'authority-indicator yours';
            } else {
              voteAuthorityIndicator.textContent = '';
              voteAuthorityIndicator.className = 'authority-indicator';
            }
          } else {
            document.getElementById('selectedVoteAuthority').textContent = 'Unknown';
            voteAuthorityIndicator.textContent = '';
            voteAuthorityIndicator.className = 'authority-indicator';
          }
          
          // Display Withdraw Authority
          const withdrawIndicator = document.getElementById('voteWithdrawAuthorityIndicator');
          if (withdrawAuthority) {
            document.getElementById('selectedVoteWithdrawAuthority').textContent = shortenAddress(withdrawAuthority);
            document.getElementById('voteWithdrawAuthorityCopyBtn').innerHTML = getCopyButtonHtml(withdrawAuthority);
            
            if (walletPublicKey && withdrawAuthority === walletPublicKey) {
              withdrawIndicator.textContent = '✓';
              withdrawIndicator.className = 'authority-indicator yours';
            } else {
              withdrawIndicator.textContent = '';
              withdrawIndicator.className = 'authority-indicator';
            }
          } else {
            document.getElementById('selectedVoteWithdrawAuthority').textContent = 'Unknown';
            withdrawIndicator.textContent = '';
            withdrawIndicator.className = 'authority-indicator';
          }
          
          // Update vote authority badges in account list
          const voteAuthorityBadges = document.getElementById('voteAuthorityBadges');
          if (voteAuthorityBadges) {
            const hasVoteAuth = walletPublicKey && voteAuthority === walletPublicKey;
            const hasWithdrawAuth = walletPublicKey && withdrawAuthority === walletPublicKey;
            voteAuthorityBadges.innerHTML = `
              <span class="auth-badge ${hasVoteAuth ? 'has-auth' : 'no-auth'}">Vote</span>
              <span class="auth-badge ${hasWithdrawAuth ? 'has-auth' : 'no-auth'}">Withdraw</span>
            `;
          }
        } else {
          manageVoteWithdrawAuthority = null; // unknown - fail open, no locks
          document.getElementById('selectedVoteAuthority').textContent = 'Unable to fetch';
          document.getElementById('selectedVoteWithdrawAuthority').textContent = 'Unable to fetch';
        }
      } catch (e) {
        console.error('Error fetching vote account authorities:', e);
        manageVoteWithdrawAuthority = null; // unknown - fail open, no locks
        document.getElementById('selectedVoteAuthority').textContent = 'Error';
        document.getElementById('selectedVoteWithdrawAuthority').textContent = 'Error';
      }
    }

    // Fetch connected wallet balance
    async function fetchConnectedWalletBalance() {
      if (!walletPublicKey) {
        document.getElementById('selectedWalletBalance').textContent = '-';
        return;
      }
      
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBalance',
            params: [walletPublicKey]
          })
        });
        
        const data = await response.json();
        if (data.result && data.result.value !== undefined) {
          document.getElementById('selectedWalletBalance').textContent = formatNumber(lamportsToXNT(data.result.value), 4);
        } else {
          document.getElementById('selectedWalletBalance').textContent = '-';
        }
      } catch (e) {
        console.error('Error fetching wallet balance:', e);
        document.getElementById('selectedWalletBalance').textContent = '-';
      }
    }

    // Render all action groups (Wallet / Validator / Stake) based on current context.
    // Replaces the old updateActionsForVote/updateActionsForStake innerHTML swap so
    // every available action is always visible, with contextual locks + explainers.
    function renderActions() {
      const walletGrid = document.getElementById('walletActionsGrid');
      const validatorGrid = document.getElementById('validatorActionsGrid');
      const stakeGrid = document.getElementById('stakeActionsGrid');
      if (!walletGrid || !validatorGrid || !stakeGrid) return;
      
      // Helper to create button HTML. opts: { enabled, lockedClick, iconStyle }
      const createBtn = (icon, title, desc, onclick, opts = {}) => {
        const isEnabled = opts.enabled !== false;
        const disabledClass = isEnabled ? '' : 'disabled';
        const clickHandler = isEnabled ? onclick : (opts.lockedClick || '');
        const lockIcon = isEnabled ? '' : '<span class="action-lock">🔒</span>';
        const iconStyle = opts.iconStyle || '';
        
        return `
          <button class="manage-action-btn ${disabledClass}" onclick="${clickHandler}">
            <span class="action-icon" ${iconStyle}>${icon}</span>
            <span class="action-text">
              <span class="action-title">${title}${lockIcon}</span>
              <span class="action-desc">${desc}</span>
            </span>
          </button>
        `;
      };
      
      // ===== Wallet Actions (never depend on selection) =====
      walletGrid.innerHTML = 
        createBtn('+', 'Create & Delegate Stake', 'Create new stake account', 'initiateCreateStake()', { iconStyle: 'style="color: #ffc107; font-weight: bold; font-size: 1.8rem;"' }) +
        createBtn('📤', 'Send XNT to ID Wallet', 'Transfer to validator identity wallet', 'initiateSendToIdentity()');
      
      // ===== Validator Actions (vote account level, independent of selection) =====
      const voteCtx = document.getElementById('validatorActionsContext');
      if (voteCtx) {
        if (currentManageValidator && currentManageValidator.voteAccount) {
          voteCtx.innerHTML = `<span class="action-group-address">${shortenAddress(currentManageValidator.voteAccount)}</span>${getCopyButtonHtml(currentManageValidator.voteAccount)}`;
        } else {
          voteCtx.innerHTML = '';
        }
        voteCtx.classList.remove('unlock-hint');
      }
      
      // Authority gate: fail OPEN when authority is unknown / not yet fetched,
      // so we never wrongly block an action. Each action's own modal still
      // performs its full authority check at runtime.
      const voteAuthKnown = !!(walletPublicKey && manageVoteWithdrawAuthority);
      const hasVoteWithdrawAuth = !voteAuthKnown || manageVoteWithdrawAuthority === walletPublicKey;
      const voteAuthOpts = hasVoteWithdrawAuth ? {} : { enabled: false, lockedClick: "showActionExplainer('voteWithdraw', 'noVoteWithdrawAuth')" };
      
      validatorGrid.innerHTML = 
        createBtn('💸', 'Withdraw XNT', 'Withdraw rewards to your wallet', 'initiateWithdraw()', voteAuthOpts) +
        createBtn('📝', 'Change Commission', 'Update validator commission rate', 'initiateChangeCommission()', voteAuthOpts) +
        createBtn('🏷️', 'Update Identity', 'Change on-chain validator info', 'initiateUpdateIdentity()') +
        createBtn('🔐', 'Change Authority', 'Transfer withdraw authority', 'initiateChangeAuthority()', voteAuthOpts);
      
      // ===== Stake Actions (depend on selected stake account + its state + authority) =====
      const stakeCtx = document.getElementById('stakeActionsContext');
      let stake = null;
      if (selectedAccountType && selectedAccountType.startsWith('stake-')) {
        const idx = parseInt(selectedAccountType.split('-')[1]);
        stake = stakeAccounts[idx] || null;
      }
      
      const stakeActionDefs = [
        { id: 'delegate', icon: '🔄', title: 'Delegate Stake', desc: 'Delegate to a validator', onclick: 'initiateRedelegate()' },
        { id: 'undelegate', icon: '🔓', title: 'Undelegate Stake', desc: 'Begin deactivation process', onclick: 'initiateUndelegate()' },
        { id: 'split', icon: '✂️', title: 'Split Stake', desc: 'Divide into two accounts', onclick: 'initiateSplitStake()' },
        { id: 'merge', icon: '🔗', title: 'Merge Stakes', desc: 'Combine multiple stake accounts', onclick: 'initiateMergeStakes()' },
        { id: 'withdraw', icon: '💸', title: 'Withdraw from Stake', desc: 'Withdraw XNT to wallet', onclick: 'initiateWithdrawStake()' },
        { id: 'close', icon: '🗑️', title: 'Close Stake Account', desc: 'Withdraw all & close account', onclick: 'initiateCloseStakeAccount()' },
        { id: 'setStakeAuth', icon: '🔐', title: 'Set Stake Authority', desc: 'Change who can delegate', onclick: 'initiateSetStakeAuthority()' },
        { id: 'setWithdrawAuth', icon: '🔑', title: 'Set Withdraw Authority', desc: 'Change who can withdraw', onclick: 'initiateSetWithdrawAuthority()' }
      ];
      
      if (!stake) {
        // No stake selected: show all stake actions locked, with a hint in the header
        if (stakeCtx) {
          stakeCtx.textContent = 'No stake selected — choose one from the list above to unlock';
          stakeCtx.classList.add('unlock-hint');
        }
        stakeGrid.innerHTML = stakeActionDefs.map(d => 
          createBtn(d.icon, d.title, d.desc, '', { enabled: false, lockedClick: `showActionExplainer('${d.id}', 'new')` })
        ).join('');
      } else {
        const stakeState = stake.state || 'active';
        if (stakeCtx) {
          stakeCtx.innerHTML = `<span class="action-group-address">${shortenAddress(stake.pubkey)}</span>${getCopyButtonHtml(stake.pubkey)}`;
          stakeCtx.classList.remove('unlock-hint');
        }
        
        // Which actions each stake state allows (same rules as before)
        const stateAvailability = {
          'delegate': stakeState === 'inactive',
          'undelegate': stakeState === 'active' || stakeState === 'activating',
          'split': stakeState === 'active',
          'merge': stakeState === 'active' || stakeState === 'inactive',
          'withdraw': stakeState === 'inactive',
          'close': stakeState === 'inactive',
          'setStakeAuth': true,
          'setWithdrawAuth': true
        };
        
        // Authority gates: stake authority signs delegate/undelegate/split/merge/setStakeAuth;
        // withdraw authority signs withdraw/close/setWithdrawAuth. Fail OPEN when unknown.
        const staker = stake.data?.meta?.authorized?.staker;
        const withdrawer = stake.data?.meta?.authorized?.withdrawer;
        const hasStakeAuth = !(walletPublicKey && staker) || staker === walletPublicKey;
        const hasWithdrawAuth = !(walletPublicKey && withdrawer) || withdrawer === walletPublicKey;
        const usesWithdrawAuth = { 'withdraw': true, 'close': true, 'setWithdrawAuth': true };
        
        stakeGrid.innerHTML = stakeActionDefs.map(d => {
          const authOk = usesWithdrawAuth[d.id] ? hasWithdrawAuth : hasStakeAuth;
          const stateOk = stateAvailability[d.id];
          if (authOk && stateOk) {
            return createBtn(d.icon, d.title, d.desc, d.onclick);
          }
          const reason = !authOk
            ? (usesWithdrawAuth[d.id] ? 'noWithdrawAuth' : 'noStakeAuth')
            : stakeState;
          return createBtn(d.icon, d.title, d.desc, '', { enabled: false, lockedClick: `showActionExplainer('${d.id}', '${reason}')` });
        }).join('');
      }
    }
    
    // Show explainer for disabled actions
    function showActionExplainer(action, stakeState) {
      const explainers = {
        delegate: {
          active: {
            title: 'Cannot Delegate Active Stake',
            message: 'Your stake is currently active with a validator. To switch validators, you need to:',
            steps: ['1. Undelegate your stake (begins deactivation)', '2. Wait ~2 epochs for deactivation to complete', '3. Delegate to your new validator'],
            action: { text: 'Undelegate Now', onclick: 'initiateUndelegate()' }
          },
          activating: {
            title: 'Stake Still Activating',
            message: 'Your stake is still activating with the current validator. Please wait for activation to complete before making changes.',
            steps: ['Wait for activation to complete', 'Then undelegate if you want to switch validators'],
            action: null
          },
          deactivating: {
            title: 'Stake is Deactivating',
            message: 'Your stake is currently deactivating. Once complete, you\'ll be able to delegate to a new validator.',
            steps: ['Wait for deactivation to complete (~2 epochs)', 'Then delegate to your chosen validator'],
            action: null
          },
          new: {
            title: 'No Stake Account Selected',
            message: 'This action requires an inactive stake account to delegate.',
            steps: ['1. Create a new stake account', '2. Or select an existing inactive stake from the list'],
            action: { text: 'Create & Delegate Stake', onclick: 'initiateCreateStake()' }
          }
        },
        undelegate: {
          deactivating: {
            title: 'Already Deactivating',
            message: 'This stake is already in the deactivation process. No further action needed.',
            steps: ['Wait for deactivation to complete', 'Then withdraw or delegate to a new validator'],
            action: null
          },
          inactive: {
            title: 'Stake is Inactive',
            message: 'This stake is already inactive (not delegated). You can delegate it to a validator or withdraw the funds.',
            steps: [],
            action: { text: 'Delegate Stake', onclick: 'initiateRedelegate()' }
          },
          new: {
            title: 'No Stake Account Selected',
            message: 'This action requires an active stake account to undelegate.',
            steps: ['1. Create a new stake account', '2. Or select an existing active stake from the list'],
            action: { text: 'Create & Delegate Stake', onclick: 'initiateCreateStake()' }
          }
        },
        merge: {
          activating: {
            title: 'Cannot Merge Activating Stakes',
            message: 'Stakes can only be merged when they are in the same state (both active or both inactive).',
            steps: ['Wait for activation to complete', 'Then merge with other active stakes'],
            action: null
          },
          deactivating: {
            title: 'Cannot Merge Deactivating Stakes',
            message: 'Stakes can only be merged when they are in the same state (both active or both inactive).',
            steps: ['Wait for deactivation to complete', 'Then merge with other inactive stakes'],
            action: null
          },
          new: {
            title: 'No Stake Account Selected',
            message: 'This action requires stake accounts to merge together.',
            steps: ['1. Create a new stake account', '2. Or select an existing stake from the list'],
            action: { text: 'Create & Delegate Stake', onclick: 'initiateCreateStake()' }
          }
        },
        split: {
          activating: {
            title: 'Cannot Split Activating Stake',
            message: 'Stakes can only be split when fully active.',
            steps: ['Wait for activation to complete', 'Then split if needed'],
            action: null
          },
          deactivating: {
            title: 'Cannot Split Deactivating Stake',
            message: 'Stakes can only be split when fully active.',
            steps: ['This stake is deactivating and cannot be split'],
            action: null
          },
          inactive: {
            title: 'Cannot Split Inactive Stake',
            message: 'Inactive stakes cannot be split. You can delegate it first or withdraw the funds.',
            steps: [],
            action: { text: 'Delegate Stake', onclick: 'initiateRedelegate()' }
          },
          new: {
            title: 'No Stake Account Selected',
            message: 'This action requires an active stake account to split.',
            steps: ['1. Create a new stake account', '2. Or select an existing active stake from the list'],
            action: { text: 'Create & Delegate Stake', onclick: 'initiateCreateStake()' }
          }
        },
        withdraw: {
          active: {
            title: 'Cannot Withdraw Active Stake',
            message: 'You can only withdraw from inactive stakes. To access these funds:',
            steps: ['1. Undelegate your stake', '2. Wait ~2 epochs for deactivation', '3. Withdraw your XNT'],
            action: { text: 'Undelegate Now', onclick: 'initiateUndelegate()' }
          },
          activating: {
            title: 'Cannot Withdraw Activating Stake',
            message: 'Your stake is still activating. You\'ll need to undelegate first.',
            steps: ['1. Undelegate to cancel activation', '2. Wait for deactivation to complete', '3. Withdraw your XNT'],
            action: { text: 'Undelegate Now', onclick: 'initiateUndelegate()' }
          },
          deactivating: {
            title: 'Stake is Deactivating',
            message: 'Your stake is deactivating. Once complete, you\'ll be able to withdraw.',
            steps: ['Wait ~2 epochs for deactivation to complete', 'Then withdraw your XNT'],
            action: null
          },
          new: {
            title: 'No Stake Account Selected',
            message: 'This action requires an inactive stake account to withdraw from.',
            steps: ['1. Create a new stake account', '2. Or select an existing inactive stake from the list'],
            action: { text: 'Create & Delegate Stake', onclick: 'initiateCreateStake()' }
          }
        },
        close: {
          active: {
            title: 'Cannot Close Active Stake',
            message: 'You can only close inactive stake accounts. To close this account:',
            steps: ['1. Undelegate your stake', '2. Wait ~2 epochs for deactivation', '3. Close the account'],
            action: { text: 'Undelegate Now', onclick: 'initiateUndelegate()' }
          },
          activating: {
            title: 'Cannot Close Activating Stake',
            message: 'Your stake is still activating. You\'ll need to undelegate first.',
            steps: ['1. Undelegate to cancel activation', '2. Wait for deactivation to complete', '3. Close the account'],
            action: { text: 'Undelegate Now', onclick: 'initiateUndelegate()' }
          },
          deactivating: {
            title: 'Stake is Deactivating',
            message: 'Your stake is deactivating. Once complete, you\'ll be able to close the account.',
            steps: ['Wait ~2 epochs for deactivation to complete', 'Then close the account'],
            action: null
          },
          new: {
            title: 'No Stake Account Selected',
            message: 'This action requires a stake account. Create a new stake account first.',
            steps: [],
            action: { text: 'Create & Delegate Stake', onclick: 'initiateCreateStake()' }
          }
        },
        setStakeAuth: {
          new: {
            title: 'No Stake Account Selected',
            message: 'This action requires a stake account to change its stake authority.',
            steps: ['1. Create a new stake account', '2. Or select an existing stake from the list'],
            action: { text: 'Create & Delegate Stake', onclick: 'initiateCreateStake()' }
          }
        },
        setWithdrawAuth: {
          new: {
            title: 'No Stake Account Selected',
            message: 'This action requires a stake account to change its withdraw authority.',
            steps: ['1. Create a new stake account', '2. Or select an existing stake from the list'],
            action: { text: 'Create & Delegate Stake', onclick: 'initiateCreateStake()' }
          }
        }
      };
      
      // Authority-based locks share generic explainers regardless of action
      const authorityExplainers = {
        noStakeAuth: {
          title: 'Wallet Lacks Stake Authority',
          message: 'Your connected wallet does not hold the Stake Authority for this stake account, so it cannot sign this action.',
          steps: ['The current Stake Authority is shown in the account details above', 'Connect the wallet that holds the Stake Authority to perform this action'],
          action: null
        },
        noWithdrawAuth: {
          title: 'Wallet Lacks Withdraw Authority',
          message: 'Your connected wallet does not hold the Withdraw Authority for this stake account, so it cannot sign this action.',
          steps: ['The current Withdraw Authority is shown in the account details above', 'Connect the wallet that holds the Withdraw Authority to perform this action'],
          action: null
        },
        noVoteWithdrawAuth: {
          title: 'Wallet Lacks Withdraw Authority',
          message: 'Your connected wallet does not hold the Withdraw Authority for this vote account, so it cannot sign validator-level actions like withdrawing rewards, changing commission, or transferring authority.',
          steps: ['The current Withdraw Authority is shown in the vote account details', 'Connect the wallet that holds the Withdraw Authority to perform these actions'],
          action: null
        }
      };
      
      let info;
      if (authorityExplainers[stakeState]) {
        info = authorityExplainers[stakeState];
      } else {
        info = explainers[action]?.[stakeState];
        // "No stake selected" case: point the user at the account list instead
        if (info && stakeState === 'new') {
          info = { ...info, action: { text: 'Select a Stake Account', onclick: 'highlightAccountList()' } };
        }
      }
      if (!info) {
        showToast('This action is not available for the current stake state');
        return;
      }
      
      // Build modal content
      let stepsHtml = '';
      if (info.steps.length > 0) {
        stepsHtml = `<ul class="explainer-steps">${info.steps.map(s => `<li>${s}</li>`).join('')}</ul>`;
      }
      
      let actionBtn = '';
      if (info.action) {
        actionBtn = `<button class="explainer-action-btn" onclick="${info.action.onclick}; closeActionExplainerModal()">${info.action.text}</button>`;
      }
      
      const modal = document.getElementById('actionExplainerModal');
      document.getElementById('actionExplainerTitle').textContent = info.title;
      document.getElementById('actionExplainerContent').innerHTML = `
        <p>${info.message}</p>
        ${stepsHtml}
        <div class="explainer-actions">
          ${actionBtn}
          <button class="explainer-close-btn" onclick="closeActionExplainerModal()">Got it</button>
        </div>
      `;
      
      modal.style.display = 'flex';
      document.body.style.overflow = 'hidden';
    }
    
    function closeActionExplainerModal() {
      document.getElementById('actionExplainerModal').style.display = 'none';
      document.body.style.overflow = '';
    }
    
    // Scroll to the account list and pulse it (used by locked stake actions
    // when no stake account is selected)
    function highlightAccountList() {
      const list = document.getElementById('accountsList');
      if (!list) return;
      if (typeof list.scrollIntoView === 'function') {
        list.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      list.classList.remove('pulse-highlight');
      void list.offsetWidth; // force reflow so the animation can restart
      list.classList.add('pulse-highlight');
      setTimeout(() => list.classList.remove('pulse-highlight'), 2600);
    }

    // =========================================
    // MERGE STAKES MODAL
    // =========================================
    
    let mergeStakesSelected = []; // Array of selected stake pubkeys
    
    function initiateMergeStakes() {
      if (!walletPublicKey) {
        showWalletRequired('merge stake accounts');
        return;
      }
      
      if (!currentManageValidator) {
        alert('Validator data not available.');
        return;
      }
      
      if (stakeAccounts.length < 2) {
        alert('You need at least 2 stake accounts to merge.');
        return;
      }
      
      // Reset selection
      mergeStakesSelected = [];
      
      // Populate modal
      document.getElementById('mergeStakesValidatorName').textContent = currentManageValidator.name;
      const msgEl = document.getElementById('mergeStakesMessage');
      msgEl.style.display = 'none';
      msgEl.textContent = '';
      msgEl.className = 'send-message';
      document.getElementById('mergeStakesSummarySection').style.display = 'none';
      document.getElementById('mergeStakesConfirmBtn').disabled = true;
      document.getElementById('mergeStakesConfirmBtn').textContent = 'Merge Selected Stakes';
      document.getElementById('mergeStakesConfirmBtn').onclick = confirmMergeStakes;
      document.getElementById('mergeStakesCancelBtn').textContent = 'Cancel';
      
      // Analyze and render stakes
      renderMergeStakesList();
      
      // Show modal
      document.getElementById('mergeStakesModal').style.display = 'flex';
    }
    
    function closeMergeStakesModal() {
      document.getElementById('mergeStakesModal').style.display = 'none';
      mergeStakesSelected = [];
    }
    
    function renderMergeStakesList() {
      const container = document.getElementById('mergeStakesList');
      
      if (stakeAccounts.length === 0) {
        container.innerHTML = '<div class="loading-text">No stake accounts found</div>';
        return;
      }
      
      // Analyze each stake for merge eligibility
      const analyzedStakes = stakeAccounts.map(stake => {
        const staker = stake.data.meta?.authorized?.staker;
        const withdrawer = stake.data.meta?.authorized?.withdrawer;
        const delegation = stake.data.stake?.delegation;
        const voter = delegation?.voter;
        
        // Check eligibility
        let eligible = true;
        let reason = '';
        
        // Must be in a mergeable state (active or inactive only)
        // Activating and deactivating stakes cannot be merged
        if (stake.state === 'activating') {
          eligible = false;
          reason = 'Still activating';
        } else if (stake.state === 'deactivating') {
          eligible = false;
          reason = 'Deactivating';
        }
        
        // Must be delegated to the current validator
        if (eligible && voter !== currentManageValidator.voteAccount) {
          eligible = false;
          reason = 'Different validator';
        }
        
        // Connected wallet must be the stake authority
        if (eligible && staker !== walletPublicKey) {
          eligible = false;
          reason = 'Not stake authority';
        }
        
        return {
          ...stake,
          staker,
          withdrawer,
          voter,
          eligible,
          reason
        };
      });
      
      // Find the "base" stake (first eligible one that others will merge into)
      // All mergeable stakes must share the same staker AND withdrawer AND state
      const eligibleStakes = analyzedStakes.filter(s => s.eligible);
      
      // Group by staker+withdrawer+state combination (stakes must be in same state to merge)
      const groups = {};
      eligibleStakes.forEach(stake => {
        const key = `${stake.staker}_${stake.withdrawer}_${stake.state}`;
        if (!groups[key]) {
          groups[key] = [];
        }
        groups[key].push(stake);
      });
      
      // Mark stakes as mergeable only if they have matching authorities AND state with at least one other stake
      analyzedStakes.forEach(stake => {
        if (stake.eligible) {
          const key = `${stake.staker}_${stake.withdrawer}_${stake.state}`;
          if (groups[key] && groups[key].length < 2) {
            stake.eligible = false;
            stake.reason = 'No matching stakes';
          }
        }
      });
      
      container.innerHTML = analyzedStakes.map(stake => `
        <div class="merge-stake-item ${stake.eligible ? '' : 'disabled'}" 
             onclick="${stake.eligible ? `toggleMergeStakeSelection('${stake.pubkey}')` : ''}">
          <input type="checkbox" 
                 class="merge-stake-checkbox" 
                 id="merge-${stake.pubkey}" 
                 ${stake.eligible ? '' : 'disabled'}
                 ${mergeStakesSelected.includes(stake.pubkey) ? 'checked' : ''}
                 onclick="event.stopPropagation(); toggleMergeStakeSelection('${stake.pubkey}')">
          <div class="merge-stake-info">
            <div class="merge-stake-address">${shortenAddress(stake.pubkey)}</div>
            <div class="merge-stake-details">
              <span>Staker: ${shortenAddress(stake.staker || '-')}</span>
              <span>Withdrawer: ${shortenAddress(stake.withdrawer || '-')}</span>
            </div>
          </div>
          <div class="merge-stake-amount">${formatNumber(lamportsToXNT(stake.lamports), 2)} XNT</div>
          <span class="merge-stake-status ${stake.eligible ? 'eligible' : 'ineligible'}">
            ${stake.eligible ? '✓ Eligible' : stake.reason}
          </span>
        </div>
      `).join('');
    }
    
    function toggleMergeStakeSelection(pubkey) {
      const index = mergeStakesSelected.indexOf(pubkey);
      if (index > -1) {
        mergeStakesSelected.splice(index, 1);
      } else {
        mergeStakesSelected.push(pubkey);
      }
      
      // Update checkbox state
      const checkbox = document.getElementById(`merge-${pubkey}`);
      if (checkbox) {
        checkbox.checked = mergeStakesSelected.includes(pubkey);
      }
      
      // Update item selection state
      const item = checkbox?.closest('.merge-stake-item');
      if (item) {
        item.classList.toggle('selected', mergeStakesSelected.includes(pubkey));
      }
      
      // Update summary and button state
      updateMergeStakesSummary();
    }
    
    function updateMergeStakesSummary() {
      const summarySection = document.getElementById('mergeStakesSummarySection');
      const confirmBtn = document.getElementById('mergeStakesConfirmBtn');
      
      if (mergeStakesSelected.length < 2) {
        summarySection.style.display = 'none';
        confirmBtn.disabled = true;
        return;
      }
      
      // Calculate totals
      const selectedStakes = stakeAccounts.filter(s => mergeStakesSelected.includes(s.pubkey));
      const totalLamports = selectedStakes.reduce((sum, s) => sum + s.lamports, 0);
      
      // Destination is the first selected stake (largest)
      const destination = mergeStakesSelected[0];
      
      document.getElementById('mergeStakesCount').textContent = mergeStakesSelected.length;
      document.getElementById('mergeStakesTotal').textContent = formatNumber(lamportsToXNT(totalLamports), 4) + ' XNT';
      document.getElementById('mergeStakesDestination').textContent = shortenAddress(destination);
      
      summarySection.style.display = 'block';
      confirmBtn.disabled = false;
    }
    
    function showMergeStakesMessage(message, type, signature) {
      renderTxMessage('mergeStakesMessage', message, type, signature);
    }
    
    async function confirmMergeStakes() {
      if (mergeStakesSelected.length < 2) {
        showMergeStakesMessage('Please select at least 2 stakes to merge.', 'error');
        return;
      }
      
      const btn = document.getElementById('mergeStakesConfirmBtn');
      btn.disabled = true;
      btn.textContent = 'Merging Stakes...';
      
      try {
        // The destination stake (first selected) will receive all other stakes
        const destinationPubkey = mergeStakesSelected[0];
        const sourcePubkeys = mergeStakesSelected.slice(1);
        
        // Get Solana web3 classes
        const { PublicKey, Transaction, TransactionInstruction, Connection, SYSVAR_CLOCK_PUBKEY, SYSVAR_STAKE_HISTORY_PUBKEY } = solanaWeb3;
        
        // Stake program ID
        const STAKE_PROGRAM_ID = new PublicKey('Stake11111111111111111111111111111111111111');
        
        // Create connection
        const connection = new Connection(RPC_URL, 'confirmed');
        
        // Get recent blockhash (need lastValidBlockHeight to confirm the merge)
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        
        const fromPubkey = new PublicKey(walletPublicKey);
        const destinationStakePubkey = new PublicKey(destinationPubkey);
        
        // Create a transaction with merge instructions for each source stake
        const transaction = new Transaction();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = fromPubkey;
        
        for (const sourcePubkey of sourcePubkeys) {
          const sourceStakePubkey = new PublicKey(sourcePubkey);
          
          // Create merge instruction manually
          // Merge instruction index is 7 in the Stake program
          const mergeInstructionData = new Uint8Array([7, 0, 0, 0]); // 7 = Merge instruction
          
          const mergeInstruction = new TransactionInstruction({
            keys: [
              { pubkey: destinationStakePubkey, isSigner: false, isWritable: true },
              { pubkey: sourceStakePubkey, isSigner: false, isWritable: true },
              { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
              { pubkey: SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },
              { pubkey: fromPubkey, isSigner: true, isWritable: false }, // stake authority
            ],
            programId: STAKE_PROGRAM_ID,
            data: mergeInstructionData
          });
          
          transaction.add(mergeInstruction);
        }
        
        // Sign + send (with priority fee + rebroadcast)
        const signature = await signSendTx(connection, transaction);
        
        // Wait for the merge to actually confirm on-chain before declaring
        // success. Previously this reported "merged successfully" the instant
        // the tx was sent, so a dropped/unlanded tx still showed success.
        // confirmWithFallback re-checks the signature a few times on a timeout
        // before reporting failure.
        btn.textContent = 'Confirming...';
        showMergeStakesMessage('Transaction sent! Waiting for confirmation...', 'info');
        await confirmWithFallback(connection, signature, blockhash, lastValidBlockHeight, 'confirmed');
        
        showMergeStakesMessage(`Stakes merged successfully! Signature: ${signature.slice(0, 20)}...`, 'success', signature);
        btn.textContent = 'Merge Complete!';
        btn.onclick = closeMergeStakesModal;
        btn.disabled = false;
        document.getElementById('mergeStakesCancelBtn').textContent = 'Close';
        
        // Refresh stake accounts after delay (but don't auto-close modal)
        setTimeout(() => {
          if (currentManageValidator && currentManageValidator.voteAccount) {
            fetchStakeAccounts(currentManageValidator.voteAccount);
          }
        }, 2000);
        
      } catch (e) {
        console.error('Merge stakes error:', e);
        
        // A confirmation timeout is not proof of failure — the merge may still
        // have landed. Flag it distinctly from a hard error.
        const looksExpired = e.isUnconfirmedTimeout || (e.message && (
          e.message.includes('block height exceeded') ||
          e.message.includes('expired') ||
          e.message.includes('TransactionExpired')
        ));
        
        if (e.message?.includes('User rejected') || e.message?.includes('cancelled')) {
          showMergeStakesMessage('Transaction cancelled by user.', 'error');
        } else if (e.message?.includes('Plugin Closed')) {
          showMergeStakesMessage('Wallet closed unexpectedly. Please try again.', 'error');
        } else if (looksExpired) {
          showMergeStakesMessage('Could not confirm in time. The merge may still have gone through — please check your stake accounts before retrying.', 'error');
        } else {
          showMergeStakesMessage(`Error: ${e.message || 'Transaction failed'}`, 'error');
        }
        
        btn.disabled = false;
        btn.textContent = 'Merge Selected Stakes';
      }
    }

    // =========================================
    // SPLIT STAKE MODAL
    // =========================================
    
    let splitStakeAccount = null; // Currently selected stake to split
    let splitStakeBalanceLamports = 0;
    const STAKE_RENT_EXEMPT_MIN = 2282880; // ~0.00228 XNT minimum for stake account
    
    function initiateSplitStake() {
      if (!walletPublicKey) {
        showWalletRequired('split stake');
        return;
      }
      
      if (!currentManageValidator) {
        alert('Validator data not available.');
        return;
      }
      
      // Get currently selected stake account
      if (!selectedAccountType || !selectedAccountType.startsWith('stake-')) {
        alert('Please select a stake account to split.');
        return;
      }
      
      const index = parseInt(selectedAccountType.split('-')[1]);
      const stake = stakeAccounts[index];
      
      if (!stake) {
        alert('Stake account not found.');
        return;
      }
      
      // Check if user has authority
      const staker = stake.data.meta?.authorized?.staker;
      if (staker !== walletPublicKey) {
        alert('You must be the stake authority to split this stake.');
        return;
      }
      
      splitStakeAccount = stake;
      splitStakeBalanceLamports = stake.lamports;
      
      // Populate modal
      document.getElementById('splitStakeValidatorName').textContent = currentManageValidator.name;
      document.getElementById('splitStakeAddress').textContent = shortenAddress(stake.pubkey);
      document.getElementById('splitStakeBalance').textContent = formatNumber(lamportsToXNT(stake.lamports), 4);
      document.getElementById('splitStakeAmountInput').value = '';
      document.getElementById('splitStakeRemaining').textContent = formatNumber(lamportsToXNT(stake.lamports), 4) + ' XNT';
      document.getElementById('splitStakeNew').textContent = '0.0000 XNT';
      document.getElementById('splitStakeMessage').style.display = 'none';
      document.getElementById('splitStakeConfirmBtn').disabled = false;
      document.getElementById('splitStakeConfirmBtn').textContent = 'Split Stake';
      document.getElementById('splitStakeConfirmBtn').onclick = confirmSplitStake;
      document.getElementById('splitStakeCancelBtn').textContent = 'Cancel';
      
      // Show modal
      document.getElementById('splitStakeModal').style.display = 'flex';
    }
    
    function closeSplitStakeModal() {
      document.getElementById('splitStakeModal').style.display = 'none';
      splitStakeAccount = null;
      splitStakeBalanceLamports = 0;
    }
    
    function setSplitStakeAmount(percentage) {
      if (splitStakeBalanceLamports <= 0) return;
      
      // Calculate available amount (leaving minimum rent in original)
      const availableLamports = splitStakeBalanceLamports - STAKE_RENT_EXEMPT_MIN - 10000; // Leave rent + small buffer
      const amountLamports = Math.floor(availableLamports * (percentage / 100));
      const amount = lamportsToXNT(amountLamports);
      
      document.getElementById('splitStakeAmountInput').value = amount.toFixed(4);
      updateSplitStakeSummary();
    }
    
    function updateSplitStakeSummary() {
      const input = document.getElementById('splitStakeAmountInput');
      const amount = parseFloat(input.value) || 0;
      const amountLamports = Math.floor(amount * 1e9);
      
      const remainingLamports = splitStakeBalanceLamports - amountLamports;
      
      document.getElementById('splitStakeRemaining').textContent = formatNumber(lamportsToXNT(remainingLamports), 4) + ' XNT';
      document.getElementById('splitStakeNew').textContent = formatNumber(amount, 4) + ' XNT';
      
      // Validate
      const btn = document.getElementById('splitStakeConfirmBtn');
      const msgEl = document.getElementById('splitStakeMessage');
      
      if (amountLamports < STAKE_RENT_EXEMPT_MIN) {
        msgEl.textContent = 'Split amount must be at least ~0.003 XNT for rent-exempt minimum.';
        msgEl.className = 'send-message error';
        msgEl.style.display = 'block';
        btn.disabled = true;
      } else if (remainingLamports < STAKE_RENT_EXEMPT_MIN) {
        msgEl.textContent = 'Original stake must retain at least ~0.003 XNT for rent-exempt minimum.';
        msgEl.className = 'send-message error';
        msgEl.style.display = 'block';
        btn.disabled = true;
      } else {
        msgEl.style.display = 'none';
        btn.disabled = false;
      }
    }
    
    function showSplitStakeMessage(message, type, signature) {
      renderTxMessage('splitStakeMessage', message, type, signature);
    }
    
    async function confirmSplitStake() {
      const amount = parseFloat(document.getElementById('splitStakeAmountInput').value) || 0;
      const amountLamports = Math.floor(amount * 1e9);
      
      if (amountLamports < STAKE_RENT_EXEMPT_MIN) {
        showSplitStakeMessage('Split amount too small.', 'error');
        return;
      }
      
      if (splitStakeBalanceLamports - amountLamports < STAKE_RENT_EXEMPT_MIN) {
        showSplitStakeMessage('Original stake would be too small.', 'error');
        return;
      }
      
      const btn = document.getElementById('splitStakeConfirmBtn');
      btn.disabled = true;
      btn.textContent = 'Splitting Stake...';
      
      try {
        const { PublicKey, Transaction, TransactionInstruction, Keypair, SystemProgram, Connection, StakeProgram } = solanaWeb3;
        
        const STAKE_PROGRAM_ID = new PublicKey('Stake11111111111111111111111111111111111111');
        
        const connection = new Connection(RPC_URL, 'confirmed');
        
        // Use StakeProgram.space (should be 200)
        const stakeAccountSize = StakeProgram.space;
        console.log('StakeProgram.space:', stakeAccountSize);
        
        // Get rent-exempt minimum for a stake account
        const rentExemptMinimum = await connection.getMinimumBalanceForRentExemption(stakeAccountSize);
        console.log('Rent exempt minimum:', rentExemptMinimum);
        
        // Get recent blockhash
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        
        const fromPubkey = new PublicKey(walletPublicKey);
        const stakeAccountPubkey = new PublicKey(splitStakeAccount.pubkey);
        
        // Generate new stake account keypair
        const newStakeKeypair = Keypair.generate();
        
        // Build transaction
        const transaction = new Transaction();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = fromPubkey;
        
        // Instruction 1: Create the new stake account with rent from wallet
        // This does: transfer lamports + allocate space + assign to program - all in one
        const createAccountIx = SystemProgram.createAccount({
          fromPubkey: fromPubkey,
          newAccountPubkey: newStakeKeypair.publicKey,
          lamports: rentExemptMinimum,  // Rent comes from wallet
          space: stakeAccountSize,
          programId: STAKE_PROGRAM_ID
        });
        transaction.add(createAccountIx);
        
        // Instruction 2: Split - transfers stake lamports from source to destination
        // Split instruction format: [3, 0, 0, 0] + u64 lamports (little-endian)
        const splitData = new Uint8Array(12);
        const view = new DataView(splitData.buffer);
        view.setUint32(0, 3, true); // instruction index 3 = Split
        // Write u64 lamports (little-endian) with range-safety guard
        writeU64LE(view, 4, amountLamports);
        
        const splitIx = new TransactionInstruction({
          keys: [
            { pubkey: stakeAccountPubkey, isSigner: false, isWritable: true },
            { pubkey: newStakeKeypair.publicKey, isSigner: false, isWritable: true },
            { pubkey: fromPubkey, isSigner: true, isWritable: false }
          ],
          programId: STAKE_PROGRAM_ID,
          data: splitData
        });
        transaction.add(splitIx);
        
        // Attach the priority fee BEFORE partialSign — adding instructions after
        // signing would invalidate the new stake account's signature.
        await refreshPriorityFee(connection);
        addPriorityFee(transaction);
        
        // Sign with new stake account keypair (required for createAccount)
        transaction.partialSign(newStakeKeypair);
        
        // Sign + send with wallet (priority fee + rebroadcast)
        const signature = await signSendTx(connection, transaction);
        
        // Wait for on-chain confirmation before declaring success (previously
        // this reported success the instant the tx was sent).
        btn.textContent = 'Confirming...';
        showSplitStakeMessage('Transaction sent! Waiting for confirmation...', 'info');
        await confirmWithFallback(connection, signature, blockhash, lastValidBlockHeight, 'confirmed');
        
        showSplitStakeMessage(`Stake split successfully! New account: ${shortenAddress(newStakeKeypair.publicKey.toString())}`, 'success', signature);
        btn.textContent = 'Split Complete!';
        btn.onclick = closeSplitStakeModal;
        btn.disabled = false;
        document.getElementById('splitStakeCancelBtn').textContent = 'Close';
        
        // Refresh stake accounts after delay (but don't auto-close modal)
        setTimeout(() => {
          if (currentManageValidator && currentManageValidator.voteAccount) {
            fetchStakeAccounts(currentManageValidator.voteAccount);
          }
        }, 2000);
        
      } catch (e) {
        console.error('Split stake error:', e);
        
        // A confirmation timeout is not proof of failure — the split may still
        // have landed.
        const looksExpired = e.isUnconfirmedTimeout || (e.message && (
          e.message.includes('block height exceeded') ||
          e.message.includes('expired') ||
          e.message.includes('TransactionExpired')
        ));
        
        if (e.message?.includes('User rejected') || e.message?.includes('cancelled')) {
          showSplitStakeMessage('Transaction cancelled by user.', 'error');
        } else if (e.message?.includes('Plugin Closed')) {
          showSplitStakeMessage('Wallet closed unexpectedly. Please try again.', 'error');
        } else if (looksExpired) {
          showSplitStakeMessage('Could not confirm in time. The split may still have gone through — please check your stake accounts before retrying.', 'error');
        } else {
          showSplitStakeMessage(`Error: ${e.message || 'Transaction failed'}`, 'error');
        }
        
        btn.disabled = false;
        btn.textContent = 'Split Stake';
      }
    }

    // Stake account action stubs
    // Undelegate Stake state
    let undelegateStakeData = null;

    function initiateUndelegate() {
      if (!walletPublicKey) {
        showWalletRequired('undelegate stake');
        return;
      }
      
      // Get the selected stake account
      if (!selectedAccountType || !selectedAccountType.startsWith('stake-')) {
        alert('Please select a stake account first.');
        return;
      }
      
      const stakeIndex = parseInt(selectedAccountType.replace('stake-', ''));
      const stake = stakeAccounts[stakeIndex];
      
      if (!stake) {
        alert('Stake account not found.');
        return;
      }
      
      undelegateStakeData = stake;
      
      // Get stake authority
      const staker = stake.data.meta?.authorized?.staker;
      const hasStakeAuthority = staker && staker === walletPublicKey;
      
      // Get staked amount
      const stakedLamports = stake.data.stake?.delegation?.stake ? parseInt(stake.data.stake.delegation.stake) : 0;
      
      // Populate modal
      document.getElementById('undelegateStakeAddress').textContent = shortenAddress(stake.pubkey);
      document.getElementById('undelegateStakeAddressCopyBtn').innerHTML = getCopyButtonHtml(stake.pubkey);
      document.getElementById('undelegateValidatorName').textContent = currentManageValidator?.name || 'Unknown';
      document.getElementById('undelegateVoteAccount').textContent = shortenAddress(currentManageValidator?.voteAccount || '');
      document.getElementById('undelegateStakeAmount').textContent = formatNumber(stakedLamports / 1e9, 4);
      
      // Check authority and state
      const authorityWarning = document.getElementById('undelegateAuthorityWarning');
      const alreadyWarning = document.getElementById('undelegateAlreadyWarning');
      const confirmBtn = document.getElementById('undelegateConfirmBtn');
      
      // Hide all warnings initially
      authorityWarning.style.display = 'none';
      alreadyWarning.style.display = 'none';
      
      // Check if already deactivating or inactive
      const isActive = stake.state === 'active' || stake.state === 'activating';
      
      if (!hasStakeAuthority) {
        authorityWarning.style.display = 'flex';
        confirmBtn.disabled = true;
      } else if (!isActive) {
        alreadyWarning.style.display = 'flex';
        confirmBtn.disabled = true;
      } else {
        confirmBtn.disabled = false;
      }
      
      // Reset message
      document.getElementById('undelegateMessage').style.display = 'none';
      confirmBtn.textContent = 'Undelegate Stake';
      confirmBtn.onclick = confirmUndelegateStake;
      document.getElementById('undelegateCancelBtn').textContent = 'Cancel';
      
      // Show modal
      document.getElementById('undelegateStakeModal').style.display = 'flex';
    }

    function closeUndelegateStakeModal() {
      document.getElementById('undelegateStakeModal').style.display = 'none';
      undelegateStakeData = null;
    }

    function showUndelegateMessage(message, type, signature) {
      renderTxMessage('undelegateMessage', message, type, signature);
    }

    async function confirmUndelegateStake() {
      if (!undelegateStakeData || !walletPublicKey) return;
      
      const btn = document.getElementById('undelegateConfirmBtn');
      btn.disabled = true;
      btn.textContent = 'Processing...';
      
      try {
        const { PublicKey, StakeProgram, Transaction, Connection } = solanaWeb3;
        const connection = new Connection(RPC_URL, 'confirmed');
        
        const stakePubkey = new PublicKey(undelegateStakeData.pubkey);
        const authorizedPubkey = new PublicKey(walletPublicKey);
        
        // Create deactivate instruction
        const deactivateInstruction = StakeProgram.deactivate({
          stakePubkey: stakePubkey,
          authorizedPubkey: authorizedPubkey
        });
        
        const transaction = new Transaction().add(deactivateInstruction);
        
        // Get recent blockhash
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = authorizedPubkey;
        
        btn.textContent = 'Sign Transaction...';
        showUndelegateMessage('Please approve the transaction in your wallet...', 'info');
        
        // Sign and send
        let signature;
        signature = await signSendTx(connection, transaction);
        
        btn.textContent = 'Confirming...';
        showUndelegateMessage('Transaction sent! Waiting for confirmation...', 'info');
        
        await confirmWithFallback(connection, signature, blockhash, lastValidBlockHeight, 'confirmed');
        
        btn.textContent = 'Success!';
        btn.onclick = closeUndelegateStakeModal;
        btn.disabled = false;
        document.getElementById('undelegateCancelBtn').textContent = 'Close';
        showUndelegateMessage(`Stake undelegated! It will enter "Deactivating" state. Signature: ${signature.slice(0, 20)}...`, 'success', signature);
        
        // Remember current selection
        const currentSelection = selectedAccountType;
        
        // Refresh stake accounts and re-select (but don't auto-close modal)
        setTimeout(async () => {
          if (currentManageValidator && currentManageValidator.voteAccount) {
            await fetchStakeAccounts(currentManageValidator.voteAccount);
            setTimeout(() => {
              if (currentSelection && currentSelection.startsWith('stake-')) {
                selectAccount(currentSelection);
              }
            }, 200);
          }
        }, 2000);
        
      } catch (e) {
        console.error('Undelegate stake error:', e);
        
        if (e.message?.includes('User rejected') || e.message?.includes('cancelled')) {
          showUndelegateMessage('Transaction cancelled by user.', 'error');
        } else if (e.message?.includes('already deactivated')) {
          showUndelegateMessage('This stake is already deactivated.', 'error');
        } else {
          showUndelegateMessage(`Error: ${e.message || 'Transaction failed'}`, 'error');
        }
        
        btn.disabled = false;
        btn.textContent = 'Undelegate Stake';
      }
    }

    // Redelegate Stake state
    let redelegateStakeData = null;
    let redelegateNewVoteAccount = null;
    let redelegateNewValidatorName = null;
    let allValidatorsForRedelegate = [];

    async function initiateRedelegate() {
      if (!walletPublicKey) {
        showWalletRequired('delegate stake');
        return;
      }
      
      // Get the selected stake account
      if (!selectedAccountType || !selectedAccountType.startsWith('stake-')) {
        alert('Please select a stake account first.');
        return;
      }
      
      const stakeIndex = parseInt(selectedAccountType.replace('stake-', ''));
      const stake = stakeAccounts[stakeIndex];
      
      if (!stake) {
        alert('Stake account not found.');
        return;
      }
      
      redelegateStakeData = stake;
      redelegateNewVoteAccount = null;
      redelegateNewValidatorName = null;
      
      // Get stake authority
      const staker = stake.data.meta?.authorized?.staker;
      const hasStakeAuthority = staker && staker === walletPublicKey;
      
      // Get staked amount
      const stakedLamports = stake.data.stake?.delegation?.stake ? parseInt(stake.data.stake.delegation.stake) : 0;
      
      // Populate modal
      document.getElementById('redelegateStakeAddress').textContent = shortenAddress(stake.pubkey);
      document.getElementById('redelegateStakeAddressCopyBtn').innerHTML = getCopyButtonHtml(stake.pubkey);
      document.getElementById('redelegateCurrentValidator').textContent = currentManageValidator?.name || 'Unknown';
      document.getElementById('redelegateCurrentVoteAccount').textContent = shortenAddress(currentManageValidator?.voteAccount || '');
      document.getElementById('redelegateStakeAmount').textContent = formatNumber(stakedLamports / 1e9, 4);
      
      // Reset search and selection
      document.getElementById('redelegateValidatorSearch').value = '';
      document.getElementById('redelegateSearchResults').style.display = 'none';
      document.getElementById('redelegateNewValidatorBox').style.display = 'none';
      
      // Check authority and state
      const authorityWarning = document.getElementById('redelegateAuthorityWarning');
      const notActiveWarning = document.getElementById('redelegateNotActiveWarning');
      const confirmBtn = document.getElementById('redelegateConfirmBtn');
      
      // Hide all warnings initially
      authorityWarning.style.display = 'none';
      notActiveWarning.style.display = 'none';
      
      // Check if active
      const isActive = stake.state === 'active';
      const isInactive = stake.state === 'inactive';
      const isTransitioning = stake.state === 'activating' || stake.state === 'deactivating';
      
      if (!hasStakeAuthority) {
        authorityWarning.style.display = 'flex';
        confirmBtn.disabled = true;
      } else if (isTransitioning) {
        // Activating or deactivating - can't redelegate
        notActiveWarning.style.display = 'flex';
        document.querySelector('#redelegateNotActiveWarning .warning-text p').textContent = 
          `This stake account is currently "${stake.state}". Wait for it to become active or inactive before redelegating.`;
        confirmBtn.disabled = true;
      } else if (!isInactive) {
        // Active (or any non-inactive state) - show warning that undelegate is needed
        confirmBtn.disabled = true; // Will enable when validator selected
      } else {
        // Inactive stake - can redelegate directly
        confirmBtn.disabled = true; // Will enable when validator selected
      }
      
      // Update "What happens" section based on stake state
      const timeline = document.getElementById('redelegateTimeline');
      const note = document.getElementById('redelegateNote');
      
      if (!isInactive) {
        // Any non-inactive stake - requires manual process
        timeline.innerHTML = `
          <div class="timeline-step">
            <div class="timeline-icon">1️⃣</div>
            <div class="timeline-text">
              <strong>First:</strong> Undelegate from current validator (this action)
            </div>
          </div>
          <div class="timeline-step">
            <div class="timeline-icon">2️⃣</div>
            <div class="timeline-text">
              <strong>Wait:</strong> Cooldown period (~1 epoch)
            </div>
          </div>
          <div class="timeline-step">
            <div class="timeline-icon">3️⃣</div>
            <div class="timeline-text">
              <strong>Then:</strong> Delegate to new validator
            </div>
          </div>
        `;
        note.innerHTML = '⚠️ Active stakes cannot be directly redelegated. You must undelegate first.';
        note.style.color = '#ff9800';
      } else if (isInactive) {
        // Inactive stake - can redelegate directly
        timeline.innerHTML = `
          <div class="timeline-step">
            <div class="timeline-icon">1️⃣</div>
            <div class="timeline-text">
              <strong>Immediately:</strong> Stake delegation changes to new validator
            </div>
          </div>
          <div class="timeline-step">
            <div class="timeline-icon">2️⃣</div>
            <div class="timeline-text">
              <strong>End of epoch:</strong> Stake becomes active on new validator
            </div>
          </div>
        `;
        note.innerHTML = '✅ This stake is inactive and can be directly delegated to a new validator.';
        note.style.color = 'var(--success)';
      }
      
      // Reset message
      document.getElementById('redelegateMessage').style.display = 'none';
      
      // Set appropriate button text based on stake state
      if (!isInactive) {
        confirmBtn.textContent = 'Undelegate First...';
      } else {
        confirmBtn.textContent = 'Redelegate Stake';
      }
      
      // Restore onclick handler (might have been changed)
      confirmBtn.onclick = confirmRedelegateStake;
      document.getElementById('redelegateCancelBtn').textContent = 'Cancel';
      
      // Show modal first with loading state
      document.getElementById('redelegateStakeModal').style.display = 'flex';
      
      // Load validators list for search (await to ensure it's ready)
      await loadValidatorsForRedelegate();
    }

    function closeRedelegateStakeModal() {
      document.getElementById('redelegateStakeModal').style.display = 'none';
      redelegateStakeData = null;
      redelegateNewVoteAccount = null;
      redelegateNewValidatorName = null;
    }

    async function loadValidatorsForRedelegate() {
      // Use existing allValidators if available and has data
      if (allValidators && allValidators.length > 0) {
        allValidatorsForRedelegate = allValidators
          .filter(v => v.votePubkey && v.votePubkey !== currentManageValidator?.voteAccount) // Exclude current validator and invalid entries
          .map(v => ({
            voteAccount: v.votePubkey, // Note: allValidators uses votePubkey
            nodePubkey: v.nodePubkey,
            activatedStake: v.activatedStake / 1e9, // Convert from lamports
            commission: v.commission,
            name: v.name || shortenAddress(v.votePubkey),
            isDelinquent: v.delinquent
          }));
        return;
      }
      
      // Fetch fresh validators
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getVoteAccounts',
            params: [{ commitment: 'confirmed' }]
          })
        });
        
        const data = await response.json();
        
        if (data.result) {
          // Also try to get validator names from existing identities
          const identities = await fetchValidatorIdentitiesForRedelegate([
            ...data.result.current.map(v => v.nodePubkey),
            ...data.result.delinquent.map(v => v.nodePubkey)
          ].slice(0, 100)); // Limit to first 100 for performance
          
          allValidatorsForRedelegate = [
            ...data.result.current.filter(v => v.votePubkey).map(v => ({
              voteAccount: v.votePubkey,
              nodePubkey: v.nodePubkey,
              activatedStake: v.activatedStake / 1e9,
              commission: v.commission,
              name: identities[v.nodePubkey] || identities[v.votePubkey] || shortenAddress(v.votePubkey)
            })),
            ...data.result.delinquent.filter(v => v.votePubkey).map(v => ({
              voteAccount: v.votePubkey,
              nodePubkey: v.nodePubkey,
              activatedStake: v.activatedStake / 1e9,
              commission: v.commission,
              name: identities[v.nodePubkey] || identities[v.votePubkey] || shortenAddress(v.votePubkey),
              isDelinquent: true
            }))
          ].filter(v => v.voteAccount && v.voteAccount !== currentManageValidator?.voteAccount);
        }
      } catch (e) {
        console.error('Error loading validators for redelegate:', e);
      }
    }
    
    async function fetchValidatorIdentitiesForRedelegate(nodePubkeys) {
      const identities = {};
      try {
        // Try to get from localStorage cache first
        const cached = localStorage.getItem('validatorIdentitiesCache');
        if (cached) {
          const { data, timestamp } = JSON.parse(cached);
          // Use cache if less than 1 hour old
          if (Date.now() - timestamp < 3600000) {
            return data;
          }
        }
      } catch (e) {
        console.warn('Could not load identities cache');
      }
      return identities;
    }

    function handleRedelegateSearch() {
      const searchInput = document.getElementById('redelegateValidatorSearch');
      const resultsContainer = document.getElementById('redelegateSearchResults');
      const query = searchInput.value.trim().toLowerCase();
      
      if (query.length < 2) {
        resultsContainer.style.display = 'none';
        return;
      }
      
      const matches = allValidatorsForRedelegate.filter(v => 
        v.voteAccount && // Must have valid voteAccount
        (
          (v.name && v.name.toLowerCase().includes(query)) || 
          v.voteAccount.toLowerCase().includes(query) ||
          (v.nodePubkey && v.nodePubkey.toLowerCase().includes(query))
        )
      ).slice(0, 10); // Limit to 10 results
      
      if (matches.length === 0) {
        resultsContainer.innerHTML = '<div class="redelegate-no-results">No validators found</div>';
        resultsContainer.style.display = 'block';
        return;
      }
      
      resultsContainer.innerHTML = matches.map(v => `
        <div class="redelegate-search-item" onclick="selectRedelegateValidator('${v.voteAccount}', '${escAttrJs((v.name || shortenAddress(v.voteAccount)))}')">
          <div>
            <div class="redelegate-search-item-name">${escHtml(v.name || shortenAddress(v.voteAccount))}${v.isDelinquent ? ' ⚠️' : ''}</div>
            <div class="redelegate-search-item-address">${shortenAddress(v.voteAccount)}</div>
          </div>
          <div class="redelegate-search-item-stake">${formatCompact(v.activatedStake)} XNT</div>
        </div>
      `).join('');
      
      resultsContainer.style.display = 'block';
    }

    function selectRedelegateValidator(voteAccount, name) {
      // Validate voteAccount
      if (!voteAccount || voteAccount === 'undefined') {
        showRedelegateMessage('Invalid validator selected. Please try another.', 'error');
        return;
      }
      
      redelegateNewVoteAccount = voteAccount;
      redelegateNewValidatorName = name;
      
      // Hide search, show selection
      document.getElementById('redelegateValidatorSearch').value = '';
      document.getElementById('redelegateSearchResults').style.display = 'none';
      document.getElementById('redelegateNewValidatorBox').style.display = 'block';
      document.getElementById('redelegateNewValidator').textContent = name;
      document.getElementById('redelegateNewVoteAccount').textContent = shortenAddress(voteAccount);
      
      // Enable confirm button only for inactive stakes with authority
      // Active stakes will redirect to undelegate when clicked
      const staker = redelegateStakeData?.data.meta?.authorized?.staker;
      const hasStakeAuthority = staker && staker === walletPublicKey;
      const isInactive = redelegateStakeData?.state === 'inactive';
      const canProceed = redelegateStakeData?.state && !['activating', 'deactivating'].includes(redelegateStakeData.state);
      
      document.getElementById('redelegateConfirmBtn').disabled = !(hasStakeAuthority && canProceed && voteAccount);
    }

    function clearRedelegateSelection() {
      redelegateNewVoteAccount = null;
      redelegateNewValidatorName = null;
      
      document.getElementById('redelegateNewValidatorBox').style.display = 'none';
      document.getElementById('redelegateConfirmBtn').disabled = true;
    }

    function showRedelegateMessage(message, type, signature) {
      renderTxMessage('redelegateMessage', message, type, signature);
    }

    async function confirmRedelegateStake() {
      if (!redelegateStakeData || !walletPublicKey || !redelegateNewVoteAccount) return;
      
      const btn = document.getElementById('redelegateConfirmBtn');
      
      // If stake is NOT inactive (meaning it's active, activating, or deactivating), redirect to undelegate
      // Only inactive stakes can be directly redelegated
      const stakeState = redelegateStakeData.state;
      
      if (stakeState !== 'inactive') {
        closeRedelegateStakeModal();
        initiateUndelegate();
        return;
      }
      
      btn.disabled = true;
      btn.textContent = 'Processing...';
      
      try {
        const { PublicKey, StakeProgram, Transaction, Connection, Keypair } = solanaWeb3;
        const connection = new Connection(RPC_URL, 'confirmed');
        
        const stakePubkey = new PublicKey(redelegateStakeData.pubkey);
        const authorizedPubkey = new PublicKey(walletPublicKey);
        const newVotePubkey = new PublicKey(redelegateNewVoteAccount);
        
        // Stake is inactive, we can delegate directly
        const delegateInstruction = StakeProgram.delegate({
          stakePubkey: stakePubkey,
          authorizedPubkey: authorizedPubkey,
          votePubkey: newVotePubkey
        });
        
        const transaction = new Transaction().add(delegateInstruction);
        
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = authorizedPubkey;
        
        btn.textContent = 'Sign Transaction...';
        showRedelegateMessage('Please approve the transaction in your wallet...', 'info');
        
        let signature;
        signature = await signSendTx(connection, transaction);
        
        btn.textContent = 'Confirming...';
        showRedelegateMessage('Transaction sent! Waiting for confirmation...', 'info');
        
        await confirmWithFallback(connection, signature, blockhash, lastValidBlockHeight, 'confirmed');
        
        btn.textContent = 'Success!';
        btn.onclick = closeRedelegateStakeModal;
        btn.disabled = false;
        document.getElementById('redelegateCancelBtn').textContent = 'Close';
        showRedelegateMessage(`Stake delegated to ${redelegateNewValidatorName}! Signature: ${signature.slice(0, 20)}...`, 'success', signature);
        
        // Refresh stake accounts in background (but don't auto-close modal)
        setTimeout(async () => {
          if (currentManageValidator && currentManageValidator.voteAccount) {
            await fetchStakeAccounts(currentManageValidator.voteAccount);
          }
        }, 2000);
        
      } catch (e) {
        console.error('Redelegate stake error:', e);
        
        if (e.message?.includes('User rejected') || e.message?.includes('cancelled')) {
          showRedelegateMessage('Transaction cancelled by user.', 'error');
        } else {
          showRedelegateMessage(`Error: ${e.message || 'Transaction failed'}`, 'error');
        }
        
        btn.disabled = false;
        btn.textContent = 'Redelegate Stake';
      }
    }

    // Withdraw from Stake state
    let withdrawStakeData = null;
    let withdrawStakeAvailableLamports = 0;

    function initiateWithdrawStake() {
      if (!walletPublicKey) {
        showWalletRequired('withdraw from stake');
        return;
      }
      
      // Get the selected stake account
      if (!selectedAccountType || !selectedAccountType.startsWith('stake-')) {
        alert('Please select a stake account first.');
        return;
      }
      
      const stakeIndex = parseInt(selectedAccountType.replace('stake-', ''));
      const stake = stakeAccounts[stakeIndex];
      
      if (!stake) {
        alert('Stake account not found.');
        return;
      }
      
      withdrawStakeData = stake;
      
      // ── ACCURATE BALANCE COMPUTATION ────────────────────────────────────────
      // Use rate-limit-aware activeLamports / inactiveLamports populated by
      // fetchStakeAccounts via getStakeActivation. The naive approach (treating
      // anything past deactivationEpoch as fully cooled) gave wrong numbers
      // because Solana/X1 rate-limits cooldowns per epoch via the stake history
      // sysvar — only ~25% of network active stake can deactivate per epoch, so
      // a single account's cooldown can stretch over multiple epochs.
      const totalLamports = stake.lamports;
      const rentExemptLamports = 2282880;
      
      // Fall back gracefully if activation data didn't load (older RPC, etc.)
      const activeLamports   = stake.activeLamports   ?? 0;
      const inactiveLamports = stake.inactiveLamports ?? 0;
      
      // "Locked" = the portion of the account that can't be withdrawn right now.
      // That's the still-active/cooling stake. Anything else (inactive cooled
      // portion + any extra lamports beyond delegation, e.g. stake rewards
      // sitting outside the delegation) is potentially withdrawable.
      const stakedLamports = activeLamports;
      // Withdrawable = total balance - still-active stake - rent reserve.
      // Equivalent to: cooled-down stake + un-delegated lamports - rent reserve.
      const actualAvailable = Math.max(0, totalLamports - activeLamports - rentExemptLamports);
      // Still-cooling portion (what we want to advertise to the user):
      const stillCoolingLamports = activeLamports;
      // Is this stake partially cooled? (deactivation started but not done)
      const isPartiallyCooled = stake.isDeactivating && activeLamports > 0 && inactiveLamports > 0;
      // Is it fully cooled (truly safe to close & withdraw all)?
      const isFullyCooled = stake.isDeactivating && activeLamports === 0;
      withdrawStakeAvailableLamports = actualAvailable;
      
      // Populate modal
      document.getElementById('withdrawStakeAddress').textContent = shortenAddress(stake.pubkey);
      document.getElementById('withdrawStakeAddressCopyBtn').innerHTML = getCopyButtonHtml(stake.pubkey);
      
      // ── STATUS BADGE ────────────────────────────────────────────────────────
      const statusBadge = document.getElementById('withdrawStakeStatus');
      const statusNote = document.getElementById('withdrawStakeStatusNote');
      statusBadge.className = 'status-badge';
      statusBadge.style.background = '';
      statusBadge.style.color = '';
      
      if (stake.state === 'active') {
        statusBadge.textContent = 'Active';
        statusBadge.classList.add('status-active');
        statusNote.textContent = '- Stake is delegated and earning rewards';
      } else if (stake.state === 'deactivating' && isPartiallyCooled) {
        // Partially cooled: some can be withdrawn now, more available next epoch
        statusBadge.textContent = 'Cooling Down';
        statusBadge.style.background = 'rgba(255, 171, 0, 0.15)';
        statusBadge.style.color = 'var(--warning)';
        const cooledXnt  = formatNumber(inactiveLamports / 1e9, 4);
        const coolingXnt = formatNumber(stillCoolingLamports / 1e9, 4);
        statusNote.textContent = `- ${cooledXnt} XNT ready, ${coolingXnt} XNT still cooling (try again next epoch for more)`;
      } else if (stake.state === 'deactivating') {
        // Cooldown started but nothing's cooled yet
        statusBadge.textContent = 'Deactivating';
        statusBadge.classList.add('status-delinquent');
        statusNote.textContent = '- Stake is deactivating, wait for cooldown';
      } else if (stake.state === 'inactive') {
        statusBadge.textContent = 'Inactive';
        statusBadge.classList.add('status-active');
        statusBadge.style.background = 'rgba(0, 230, 118, 0.15)';
        statusNote.textContent = '- Fully deactivated, ready to withdraw';
      } else if (stake.state === 'activating') {
        statusBadge.textContent = 'Activating';
        statusBadge.style.background = 'rgba(0, 229, 255, 0.15)';
        statusBadge.style.color = 'var(--accent-cyan)';
        statusNote.textContent = '- Stake is activating';
      }
      
      // ── BALANCE BREAKDOWN ───────────────────────────────────────────────────
      document.getElementById('withdrawStakeTotalBalance').textContent = formatNumber(totalLamports / 1e9, 4) + ' XNT';
      document.getElementById('withdrawStakeLockedBalance').textContent = formatNumber(stakedLamports / 1e9, 4) + ' XNT';
      document.getElementById('withdrawStakeAvailableBalance').textContent = formatNumber(actualAvailable / 1e9, 4) + ' XNT';
      
      // Cooldown progress row — only visible when partially cooled
      const cooldownRow = document.getElementById('withdrawStakeCooldownRow');
      const cooldownProgress = document.getElementById('withdrawStakeCooldownProgress');
      const cooldownText = document.getElementById('withdrawStakeCooldownText');
      if (cooldownRow) {
        if (isPartiallyCooled) {
          const totalDelegated = activeLamports + inactiveLamports;
          const pctCooled = totalDelegated > 0 ? (inactiveLamports / totalDelegated) * 100 : 0;
          cooldownRow.style.display = 'block';
          if (cooldownProgress) cooldownProgress.style.width = pctCooled.toFixed(1) + '%';
          if (cooldownText) {
            cooldownText.textContent =
              `${formatNumber(inactiveLamports / 1e9, 4)} XNT cooled / ` +
              `${formatNumber(totalDelegated / 1e9, 4)} XNT total (${pctCooled.toFixed(1)}%)`;
          }
        } else {
          cooldownRow.style.display = 'none';
        }
      }
      
      // Get withdraw authority
      const withdrawer = stake.data.meta?.authorized?.withdrawer;
      const hasWithdrawAuthority = withdrawer && withdrawer === walletPublicKey;
      
      // Set default destination to withdraw authority
      document.getElementById('withdrawStakeDestInput').value = withdrawer || '';
      
      // Check authority
      const authorityWarning = document.getElementById('withdrawStakeAuthorityWarning');
      const noBalanceWarning = document.getElementById('withdrawStakeNoBalanceWarning');
      const amountSection = document.getElementById('withdrawStakeAmountSection');
      const destSection = document.getElementById('withdrawStakeDestSection');
      const summarySection = document.getElementById('withdrawStakeSummarySection');
      const confirmBtn = document.getElementById('withdrawStakeConfirmBtn');
      
      // Hide all warnings initially
      authorityWarning.style.display = 'none';
      noBalanceWarning.style.display = 'none';
      
      if (!hasWithdrawAuthority) {
        authorityWarning.style.display = 'flex';
        amountSection.style.opacity = '0.5';
        destSection.style.opacity = '0.5';
        summarySection.style.opacity = '0.5';
        confirmBtn.disabled = true;
      } else if (actualAvailable <= 0) {
        noBalanceWarning.style.display = 'flex';
        amountSection.style.opacity = '0.5';
        destSection.style.opacity = '0.5';
        summarySection.style.opacity = '0.5';
        confirmBtn.disabled = true;
      } else {
        amountSection.style.opacity = '1';
        destSection.style.opacity = '1';
        summarySection.style.opacity = '1';
        confirmBtn.disabled = false;
      }
      
      // Reset form
      document.getElementById('withdrawStakeAmountInput').value = '';
      document.getElementById('withdrawStakeSummaryAmount').textContent = '0.0000 XNT';
      document.getElementById('withdrawStakeSummaryTotal').textContent = '0.0000 XNT';
      document.getElementById('withdrawStakeMessage').style.display = 'none';
      confirmBtn.textContent = 'Withdraw XNT';
      confirmBtn.onclick = confirmWithdrawFromStake;
      document.getElementById('withdrawStakeCancelBtn').textContent = 'Cancel';
      
      // Show close account option ONLY when stake is fully cooled. Showing it
      // for partially-cooled stakes was the original UX trap that led to the
      // confusing "insufficient funds" error.
      const closeSection = document.getElementById('withdrawStakeCloseSection');
      const closeCheckbox = document.getElementById('withdrawStakeCloseCheckbox');
      closeCheckbox.checked = false;
      
      if ((stake.state === 'inactive' || isFullyCooled) && hasWithdrawAuthority) {
        closeSection.style.display = 'block';
      } else {
        closeSection.style.display = 'none';
      }
      
      // Add input listener
      const amountInput = document.getElementById('withdrawStakeAmountInput');
      amountInput.oninput = updateWithdrawStakeSummary;
      
      // Show modal
      document.getElementById('withdrawStakeModal').style.display = 'flex';
    }

    function closeWithdrawStakeModal() {
      document.getElementById('withdrawStakeModal').style.display = 'none';
      withdrawStakeData = null;
    }

    function setWithdrawStakeAmount(percent) {
      // Don't change amount if closing account
      if (document.getElementById('withdrawStakeCloseCheckbox')?.checked) return;
      
      const maxXnt = withdrawStakeAvailableLamports / 1e9;
      const amount = (maxXnt * percent / 100).toFixed(4);
      document.getElementById('withdrawStakeAmountInput').value = amount;
      updateWithdrawStakeSummary();
    }

    function updateWithdrawStakeSummary() {
      // Don't update if closing account (handled by toggle function)
      if (document.getElementById('withdrawStakeCloseCheckbox')?.checked) return;
      
      const amount = parseFloat(document.getElementById('withdrawStakeAmountInput').value) || 0;
      const maxXnt = withdrawStakeAvailableLamports / 1e9;
      
      // Clamp to max
      const finalAmount = Math.min(amount, maxXnt);
      
      document.getElementById('withdrawStakeSummaryAmount').textContent = formatNumber(finalAmount, 4) + ' XNT';
      document.getElementById('withdrawStakeSummaryTotal').textContent = formatNumber(finalAmount - 0.000005, 4) + ' XNT';
      
      // Enable/disable button based on amount
      const btn = document.getElementById('withdrawStakeConfirmBtn');
      const hasAuthority = withdrawStakeData?.data?.meta?.authorized?.withdrawer === walletPublicKey;
      btn.disabled = !hasAuthority || finalAmount <= 0 || withdrawStakeAvailableLamports <= 0;
    }

    function showWithdrawStakeMessage(message, type, signature) {
      renderTxMessage('withdrawStakeMessage', message, type, signature);
    }

    async function confirmWithdrawFromStake() {
      if (!withdrawStakeData || !walletPublicKey) return;
      
      const btn = document.getElementById('withdrawStakeConfirmBtn');
      btn.disabled = true;
      btn.textContent = 'Processing...';
      
      // Check if closing account
      const isClosingAccount = document.getElementById('withdrawStakeCloseCheckbox')?.checked;
      
      try {
        let amountLamports;
        let amountXnt;
        
        if (isClosingAccount) {
          // Withdraw full balance including rent to close the account
          amountLamports = withdrawStakeData.lamports;
          amountXnt = amountLamports / 1e9;
        } else {
          amountXnt = parseFloat(document.getElementById('withdrawStakeAmountInput').value) || 0;
          
          if (amountXnt <= 0) {
            throw new Error('Please enter an amount to withdraw.');
          }
          
          amountLamports = Math.floor(amountXnt * 1e9);
          
          if (amountLamports > withdrawStakeAvailableLamports) {
            throw new Error('Amount exceeds available balance.');
          }
        }
        
        const destination = document.getElementById('withdrawStakeDestInput').value.trim();
        
        if (!destination || !isValidPubkey(destination)) {
          throw new Error('Please enter a valid destination address.');
        }
        
        const { PublicKey, StakeProgram, Transaction, Connection } = solanaWeb3;
        const connection = new Connection(RPC_URL, 'confirmed');
        
        const stakePubkey = new PublicKey(withdrawStakeData.pubkey);
        const authorizedPubkey = new PublicKey(walletPublicKey);
        const toPubkey = new PublicKey(destination);
        
        // Create withdraw instruction
        const withdrawInstruction = StakeProgram.withdraw({
          stakePubkey: stakePubkey,
          authorizedPubkey: authorizedPubkey,
          toPubkey: toPubkey,
          lamports: amountLamports
        });
        
        const transaction = new Transaction().add(withdrawInstruction);
        
        // Get recent blockhash
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = authorizedPubkey;
        
        btn.textContent = 'Sign Transaction...';
        showWithdrawStakeMessage('Please approve the transaction in your wallet...', 'info');
        
        // Sign and send
        let signature;
        signature = await signSendTx(connection, transaction);
        
        btn.textContent = 'Confirming...';
        showWithdrawStakeMessage('Transaction sent! Waiting for confirmation...', 'info');
        
        await confirmWithFallback(connection, signature, blockhash, lastValidBlockHeight, 'confirmed');
        
        btn.textContent = 'Success!';
        btn.onclick = closeWithdrawStakeModal;
        btn.disabled = false;
        document.getElementById('withdrawStakeCancelBtn').textContent = 'Close';
        if (isClosingAccount) {
          showWithdrawStakeMessage(`Account closed! Withdrew ${formatNumber(amountXnt, 4)} XNT. Signature: ${signature.slice(0, 20)}...`, 'success', signature);
        } else {
          showWithdrawStakeMessage(`Withdrew ${formatNumber(amountXnt, 4)} XNT! Signature: ${signature.slice(0, 20)}...`, 'success', signature);
        }
        
        // Remember current selection
        const currentSelection = selectedAccountType;
        
        // Refresh stake accounts and re-select (but don't auto-close modal)
        setTimeout(async () => {
          if (currentManageValidator && currentManageValidator.voteAccount) {
            await fetchStakeAccounts(currentManageValidator.voteAccount);
            setTimeout(() => {
              // If we closed the account, select vote account instead
              if (isClosingAccount) {
                selectAccount('vote');
              } else if (currentSelection && currentSelection.startsWith('stake-')) {
                selectAccount(currentSelection);
              }
            }, 200);
          }
        }, 2000);
        
      } catch (e) {
        console.error('Withdraw from stake error:', e);
        
        if (e.message?.includes('User rejected') || e.message?.includes('cancelled')) {
          showWithdrawStakeMessage('Transaction cancelled by user.', 'error');
        } else if (e.message?.includes('insufficient')) {
          showWithdrawStakeMessage('Insufficient balance for this withdrawal.', 'error');
        } else {
          showWithdrawStakeMessage(`Error: ${e.message || 'Transaction failed'}`, 'error');
        }
        
        btn.disabled = false;
        btn.textContent = isClosingAccount ? 'Close & Withdraw All' : 'Withdraw XNT';
      }
    }

    // Toggle close account checkbox behavior
    function toggleCloseStakeAccount() {
      const isClosing = document.getElementById('withdrawStakeCloseCheckbox').checked;
      const amountSection = document.getElementById('withdrawStakeAmountSection');
      const amountInput = document.getElementById('withdrawStakeAmountInput');
      const btn = document.getElementById('withdrawStakeConfirmBtn');
      
      if (isClosing) {
        // Disable amount input, auto-fill with full balance
        amountSection.style.opacity = '0.5';
        amountInput.disabled = true;
        const fullAmount = withdrawStakeData.lamports / 1e9;
        amountInput.value = formatNumber(fullAmount, 4);
        document.getElementById('withdrawStakeSummaryAmount').textContent = formatNumber(fullAmount, 4) + ' XNT';
        document.getElementById('withdrawStakeSummaryTotal').textContent = formatNumber(fullAmount - 0.000005, 4) + ' XNT';
        btn.textContent = 'Close & Withdraw All';
        btn.disabled = false;
      } else {
        // Re-enable amount input
        amountSection.style.opacity = '1';
        amountInput.disabled = false;
        amountInput.value = '';
        document.getElementById('withdrawStakeSummaryAmount').textContent = '0.0000 XNT';
        document.getElementById('withdrawStakeSummaryTotal').textContent = '0.0000 XNT';
        btn.textContent = 'Withdraw XNT';
        btn.disabled = true; // Will enable when they enter an amount
      }
    }

    // Direct close stake account action
    function initiateCloseStakeAccount() {
      if (!walletPublicKey) {
        showWalletRequired('close stake account');
        return;
      }
      
      // Get the selected stake account
      if (!selectedAccountType || !selectedAccountType.startsWith('stake-')) {
        alert('Please select a stake account first.');
        return;
      }
      
      const stakeIndex = parseInt(selectedAccountType.replace('stake-', ''));
      const stake = stakeAccounts[stakeIndex];
      
      if (!stake) {
        alert('Stake account not found.');
        return;
      }
      
      // Check if stake is inactive
      if (stake.state !== 'inactive') {
        alert(`This stake account is "${stake.state}". You can only close inactive stake accounts.\n\nPlease undelegate first and wait for the cooldown period to complete.`);
        return;
      }
      
      // Check authority
      const withdrawer = stake.data.meta?.authorized?.withdrawer;
      if (withdrawer !== walletPublicKey) {
        alert('You do not have withdraw authority for this stake account.');
        return;
      }
      
      // Open withdraw modal with close checkbox pre-checked
      initiateWithdrawStake();
      
      // Pre-check the close checkbox after a brief delay for modal to render
      setTimeout(() => {
        const closeCheckbox = document.getElementById('withdrawStakeCloseCheckbox');
        if (closeCheckbox && !closeCheckbox.checked) {
          closeCheckbox.checked = true;
          toggleCloseStakeAccount();
        }
      }, 100);
    }

    // Send XNT to Identity Modal State
    let sendWalletBalanceLamports = 0;

    function initiateSendToIdentity() {
      if (!walletPublicKey) {
        showWalletRequired('send XNT');
        return;
      }
      
      if (!currentManageValidator || !currentManageValidator.identityPubkey) {
        alert('Validator identity address not available.');
        return;
      }
      
      // Populate modal with validator info
      document.getElementById('sendDestinationName').textContent = currentManageValidator.name;
      document.getElementById('sendDestinationAddress').textContent = currentManageValidator.identityPubkey;
      document.getElementById('sendDestinationCopyBtn').innerHTML = getCopyButtonHtml(currentManageValidator.identityPubkey);
      
      // Reset form
      document.getElementById('sendAmountInput').value = '';
      document.getElementById('sendSummaryAmount').textContent = '0.0000 XNT';
      document.getElementById('sendSummaryTotal').textContent = '0.0000 XNT';
      document.getElementById('sendWalletBalance').textContent = 'Loading...';
      document.getElementById('sendIdWalletBalance').textContent = 'Loading...';
      document.getElementById('sendMessage').style.display = 'none';
      document.getElementById('sendConfirmBtn').disabled = false;
      document.getElementById('sendConfirmBtn').textContent = 'Send XNT';
      document.getElementById('sendConfirmBtn').onclick = confirmSendXnt;
      document.getElementById('sendXntCancelBtn').textContent = 'Cancel';
      
      // Fetch wallet balance and ID wallet balance
      fetchSendWalletBalance();
      fetchIdWalletBalance();
      
      // Show modal
      document.getElementById('sendXntModal').style.display = 'flex';
    }

    function closeSendXntModal() {
      document.getElementById('sendXntModal').style.display = 'none';
    }

    async function fetchSendWalletBalance() {
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBalance',
            params: [walletPublicKey]
          })
        });
        
        const data = await response.json();
        if (data.result && data.result.value !== undefined) {
          sendWalletBalanceLamports = data.result.value;
          const balance = lamportsToXNT(sendWalletBalanceLamports);
          document.getElementById('sendWalletBalance').textContent = formatNumber(balance, 4);
        } else {
          document.getElementById('sendWalletBalance').textContent = '0.0000';
          sendWalletBalanceLamports = 0;
        }
      } catch (e) {
        console.error('Error fetching wallet balance:', e);
        document.getElementById('sendWalletBalance').textContent = 'Error';
        sendWalletBalanceLamports = 0;
      }
    }

    async function fetchIdWalletBalance() {
      try {
        if (!currentManageValidator || !currentManageValidator.identityPubkey) {
          document.getElementById('sendIdWalletBalance').textContent = 'N/A';
          return;
        }
        
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBalance',
            params: [currentManageValidator.identityPubkey]
          })
        });
        
        const data = await response.json();
        if (data.result && data.result.value !== undefined) {
          const balance = lamportsToXNT(data.result.value);
          document.getElementById('sendIdWalletBalance').textContent = formatNumber(balance, 4);
        } else {
          document.getElementById('sendIdWalletBalance').textContent = '0.0000';
        }
      } catch (e) {
        console.error('Error fetching ID wallet balance:', e);
        document.getElementById('sendIdWalletBalance').textContent = 'Error';
      }
    }

    function setSendAmount(percentage) {
      if (sendWalletBalanceLamports <= 0) return;
      
      // Reserve 0.01 XNT for fees if MAX
      const reserveForFees = percentage === 100 ? 10000000 : 0; // 0.01 XNT in lamports
      const availableLamports = Math.max(0, sendWalletBalanceLamports - reserveForFees);
      const amountLamports = Math.floor(availableLamports * (percentage / 100));
      const amount = lamportsToXNT(amountLamports);
      
      document.getElementById('sendAmountInput').value = amount.toFixed(4);
      updateSendSummary();
    }

    function updateSendSummary() {
      const input = document.getElementById('sendAmountInput');
      const amount = parseFloat(input.value) || 0;
      const fee = 0.000005; // Estimated network fee
      const total = amount + fee;
      
      document.getElementById('sendSummaryAmount').textContent = formatNumber(amount, 4) + ' XNT';
      document.getElementById('sendSummaryTotal').textContent = formatNumber(total, 6) + ' XNT';
    }

    async function confirmSendXnt() {
      const amountInput = document.getElementById('sendAmountInput');
      const amount = parseFloat(amountInput.value);
      
      if (!amount || amount <= 0) {
        showSendMessage('Please enter a valid amount.', 'error');
        return;
      }
      
      const amountLamports = Math.floor(amount * 1000000000); // Convert to lamports
      
      if (amountLamports > sendWalletBalanceLamports) {
        showSendMessage('Insufficient balance.', 'error');
        return;
      }
      
      const destinationAddress = currentManageValidator.identityPubkey;
      
      try {
        // Disable button and show loading state
        const btn = document.getElementById('sendConfirmBtn');
        btn.disabled = true;
        btn.textContent = 'Preparing Transaction...';
        
        showSendMessage('Preparing transaction...', 'info');
        
        // Use Solana web3.js to create the transaction
        const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = solanaWeb3;
        
        const connection = new Connection(RPC_URL, 'confirmed');
        const fromPubkey = new PublicKey(walletPublicKey);
        const toPubkey = new PublicKey(destinationAddress);
        
        // Create transfer instruction
        const transferInstruction = SystemProgram.transfer({
          fromPubkey: fromPubkey,
          toPubkey: toPubkey,
          lamports: amountLamports
        });
        
        // Create transaction
        const transaction = new Transaction().add(transferInstruction);
        
        // Get recent blockhash
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = fromPubkey;
        
        btn.textContent = 'Awaiting Wallet Approval...';
        showSendMessage('Please approve the transaction in your wallet...', 'info');
        
        // Sign and send using the connected wallet
        if (connectedWallet && connectedWallet.provider) {
          let signature;
          
          // Try signAndSendTransaction first
          signature = await signSendTx(connection, transaction);
          
          btn.textContent = 'Confirming...';
          showSendMessage('Transaction sent! Waiting for confirmation...', 'info');
          
          // Wait for confirmation
          await confirmWithFallback(connection, signature, blockhash, lastValidBlockHeight, 'confirmed');
          
          btn.textContent = 'Success!';
          btn.onclick = closeSendXntModal;
          btn.disabled = false;
          document.getElementById('sendXntCancelBtn').textContent = 'Close';
          showSendMessage(`Transaction confirmed! Signature: ${signature.slice(0, 16)}...`, 'success', signature);
          
          // Refresh balances after a delay (but don't auto-close modal)
          setTimeout(() => {
            fetchValidatorIdBalance();
            fetchSendWalletBalance();
          }, 2000);
          
        } else {
          throw new Error('Wallet not connected properly');
        }
        
      } catch (e) {
        console.error('Transaction error:', e);
        
        const btn = document.getElementById('sendConfirmBtn');
        btn.disabled = false;
        btn.textContent = 'Send XNT';
        
        if (e.message && (e.message.includes('User rejected') || e.message.includes('rejected'))) {
          showSendMessage('Transaction cancelled by user.', 'error');
        } else if (e.message && e.message.includes('Plugin Closed')) {
          showSendMessage('Wallet closed unexpectedly. Please try again.', 'error');
        } else {
          showSendMessage(`Transaction failed: ${e.message || 'Unknown error'}`, 'error');
        }
      }
    }

    function showSendMessage(message, type, signature) {
      renderTxMessage('sendMessage', message, type, signature);
    }

    // Add event listeners for form inputs
    document.addEventListener('DOMContentLoaded', function() {
      // Live next-leader countdown chips on validator cards (self-guards
      // against running RPCs when no chips are visible).
      LeaderCountdown.start();

      const sendAmountInput = document.getElementById('sendAmountInput');
      if (sendAmountInput) {
        sendAmountInput.addEventListener('input', updateSendSummary);
      }
      
      const withdrawAmountInput = document.getElementById('withdrawAmountInput');
      if (withdrawAmountInput) {
        withdrawAmountInput.addEventListener('input', updateWithdrawSummary);
      }
      
      const iconInput = document.getElementById('identityIconInput');
      if (iconInput) {
        iconInput.addEventListener('blur', previewIcon);
      }
      
      const createStakeInput = document.getElementById('createStakeAmountInput');
      if (createStakeInput) {
        createStakeInput.addEventListener('input', updateCreateStakeSummary);
      }
      
      const setWithdrawAuthorityInput = document.getElementById('setWithdrawNewAuthority');
      if (setWithdrawAuthorityInput) {
        setWithdrawAuthorityInput.addEventListener('input', validateWithdrawAuthorityInput);
      }
      
      const setStakeAuthorityInput = document.getElementById('setStakerNewAuthority');
      if (setStakeAuthorityInput) {
        setStakeAuthorityInput.addEventListener('input', validateStakeAuthorityInput);
      }
    });

    // Create Stake Modal State
    let createStakeWalletBalanceLamports = 0;
    const STAKE_ACCOUNT_RENT = 2282880; // ~0.00228 XNT rent-exempt minimum for stake account

    function initiateCreateStake() {
      if (!walletPublicKey) {
        showWalletRequired('create a stake account');
        return;
      }
      
      if (!currentManageValidator) {
        alert('Validator data not available.');
        return;
      }
      
      // Populate modal
      document.getElementById('createStakeValidatorName').textContent = currentManageValidator.name;
      document.getElementById('createStakeVoteAddress').textContent = currentManageValidator.voteAccount;
      document.getElementById('createStakeVoteCopyBtn').innerHTML = getCopyButtonHtml(currentManageValidator.voteAccount);
      
      // Show authorities (will be set to connected wallet)
      document.getElementById('createStakeStakerAuthority').textContent = shortenAddress(walletPublicKey);
      document.getElementById('createStakeWithdrawAuthority').textContent = shortenAddress(walletPublicKey);
      
      // Reset form
      document.getElementById('createStakeAmountInput').value = '';
      document.getElementById('createStakeSummaryAmount').textContent = '0.0000 XNT';
      document.getElementById('createStakeSummaryTotal').textContent = '0.0000 XNT';
      document.getElementById('createStakeWalletBalance').textContent = 'Loading...';
      document.getElementById('createStakeMessage').style.display = 'none';
      document.getElementById('createStakeConfirmBtn').disabled = false;
      document.getElementById('createStakeConfirmBtn').textContent = 'Create & Delegate Stake';
      document.getElementById('createStakeConfirmBtn').onclick = confirmCreateStake;
      document.getElementById('createStakeCancelBtn').textContent = 'Cancel';
      
      // Fetch wallet balance
      fetchCreateStakeWalletBalance();
      
      // Show modal
      document.getElementById('createStakeModal').style.display = 'flex';
    }

    function closeCreateStakeModal() {
      document.getElementById('createStakeModal').style.display = 'none';
    }

    async function fetchCreateStakeWalletBalance() {
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBalance',
            params: [walletPublicKey]
          })
        });
        
        const data = await response.json();
        if (data.result && data.result.value !== undefined) {
          createStakeWalletBalanceLamports = data.result.value;
          const balance = lamportsToXNT(createStakeWalletBalanceLamports);
          document.getElementById('createStakeWalletBalance').textContent = formatNumber(balance, 4);
        } else {
          document.getElementById('createStakeWalletBalance').textContent = '0.0000';
          createStakeWalletBalanceLamports = 0;
        }
      } catch (e) {
        console.error('Error fetching wallet balance:', e);
        document.getElementById('createStakeWalletBalance').textContent = 'Error';
        createStakeWalletBalanceLamports = 0;
      }
    }

    function setCreateStakeAmount(percentage) {
      if (createStakeWalletBalanceLamports <= 0) return;
      
      // Reserve rent + fees
      const reserveForRentAndFees = STAKE_ACCOUNT_RENT + 10000000; // rent + 0.01 XNT for fees
      const availableLamports = Math.max(0, createStakeWalletBalanceLamports - reserveForRentAndFees);
      const amountLamports = Math.floor(availableLamports * (percentage / 100));
      const amount = lamportsToXNT(amountLamports);
      
      document.getElementById('createStakeAmountInput').value = amount.toFixed(4);
      updateCreateStakeSummary();
    }

    function updateCreateStakeSummary() {
      const input = document.getElementById('createStakeAmountInput');
      const amount = parseFloat(input.value) || 0;
      const rent = lamportsToXNT(STAKE_ACCOUNT_RENT);
      const fee = 0.000005;
      const total = amount + rent + fee;
      
      document.getElementById('createStakeSummaryAmount').textContent = formatNumber(amount, 4) + ' XNT';
      document.getElementById('createStakeSummaryTotal').textContent = formatNumber(total, 6) + ' XNT';
    }

