    // =========================================
    // LEADERBOARDS
    // =========================================
    
    let currentLeaderboard = 'performance';
    let leaderboardData = null;

    // ─────────────────────────────────────────────────────────────────────
    // DELEGATIONS LEADERBOARD STATE
    // delegationsData[source] = { byVoter: { votePubkey -> totalLamports },
    //                             totalLamports, accountCount, validatorCount }
    // Populated lazily on first delegations view; cached in-memory for the
    // session so flipping the source selector is instant.
    // ─────────────────────────────────────────────────────────────────────
    let delegationsData = null;
    let delegationsSource = 'both';        // 'both' | 'x1Labs' | 'ripper'
    let delegationsLoading = false;

    // Fetch every delegated stake account where `stakerPubkey` is the
    // staker authority. We use jsonParsed encoding so we can read the
    // voter pubkey and stake amount directly without manually decoding
    // the binary stake-account layout. The memcmp filter at offset 12
    // narrows the result set to just this staker's accounts.
    async function fetchDelegationsFromStaker(stakerPubkey) {
      const accounts = await rpcCall('getProgramAccounts', [
        STAKE_PROGRAM_ID,
        {
          encoding: 'jsonParsed',
          filters: [
            { dataSize: 200 },
            { memcmp: { offset: 12, bytes: stakerPubkey } },
          ],
        },
      ]);

      const byVoter = {};
      let totalLamports = 0;
      let accountCount = 0;

      for (const acc of accounts || []) {
        const parsed = acc?.account?.data?.parsed;
        if (!parsed || parsed.type !== 'delegated') continue;
        const delegation = parsed.info?.stake?.delegation;
        if (!delegation || !delegation.voter) continue;

        // Skip fully-deactivated stake — it's no longer earning credit
        // for the validator. The "never deactivated" sentinel value is
        // u64::MAX as a string. Anything else is in cooldown or done.
        const deact = delegation.deactivationEpoch;
        if (deact && deact !== '18446744073709551615') continue;

        const voter = delegation.voter;
        const stake = Number(delegation.stake) || 0;
        byVoter[voter] = (byVoter[voter] || 0) + stake;
        totalLamports += stake;
        accountCount++;
      }

      return {
        byVoter,
        totalLamports,
        accountCount,
        validatorCount: Object.keys(byVoter).length,
      };
    }

    async function loadDelegationsData(force = false) {
      if (delegationsData && !force) return delegationsData;
      if (delegationsLoading) return null;
      delegationsLoading = true;
      try {
        const [x1Labs, ripper] = await Promise.all([
          fetchDelegationsFromStaker(X1_LABS_DELEGATOR),
          fetchDelegationsFromStaker(RIPPER_POOL_DELEGATOR),
        ]);
        delegationsData = { x1Labs, ripper };
        return delegationsData;
      } finally {
        delegationsLoading = false;
      }
    }

    function setDelegationsSource(source) {
      delegationsSource = source;
      document.querySelectorAll('.delegations-segment-btn[data-source]').forEach(b => {
        b.classList.toggle('active', b.dataset.source === source);
      });
      if (currentLeaderboard === 'delegations') renderLeaderboard('delegations');
    }
    
    function switchLeaderboard(category) {
      currentLeaderboard = category;
      if (typeof Router !== 'undefined') Router.set('/leaderboard/' + category);
      
      // Update active button
      document.querySelectorAll('.leaderboard-cat-btn').forEach(btn => btn.classList.remove('active'));
      const catBtn = document.querySelector(`.leaderboard-cat-btn[data-category="${CSS.escape(category)}"]`);
      if (catBtn) catBtn.classList.add('active');
      
      // Show/hide the delegations selector controls
      const delegControls = document.getElementById('delegationsControls');
      if (delegControls) {
        delegControls.style.display = category === 'delegations' ? 'flex' : 'none';
      }

      // Update header
      const header = document.getElementById('leaderboardHeader');
      const headers = {
        'performance': { title: '⭐ Top Performance Score', subtitle: 'Validators ranked by official performance score (formula v2)' },
        'stake': { title: '💰 Most Stake', subtitle: 'Validators with the highest total stake' },
        'commission': { title: '🏷️ Lowest Commission', subtitle: 'Active validators with the lowest commission rates' },
        'efficient': { title: '🎯 Most Efficient', subtitle: 'Validators earning the most credits relative to their stake (7-epoch average)' },
        'reliable': { title: '🛡️ Most Reliable', subtitle: 'Validators with the best 7-day uptime and lowest skip rates' },
        'newest': { title: '🆕 Newest Validators', subtitle: 'Most recently started validators on the network' },
        'delegations': { title: '🤝 Delegations', subtitle: 'Validators ranked by stake delegated from X1 Labs and the Ripper Pool' }
      };
      // Published-score stamp: proof to every viewer that the numbers they
      // see are the same numbers everyone else sees.
      let sourceNote = '';
      if (window.canonicalScores) {
        const t = new Date(window.canonicalScores.generatedAt);
        sourceNote = `<p class="leaderboard-subtitle" style="font-size: 0.75rem; opacity: 0.65; margin-top: 0.15rem;">📡 Official scores · updated ${t.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · refreshed hourly · same for all viewers</p>`;
      } else if (category === 'performance') {
        sourceNote = `<p class="leaderboard-subtitle" style="font-size: 0.75rem; opacity: 0.65; margin-top: 0.15rem;">⚠ Published scores unavailable — showing locally computed estimates</p>`;
      }
      header.innerHTML = `<h2>${headers[category].title}</h2><p class="leaderboard-subtitle">${headers[category].subtitle}</p>${sourceNote}`;
      
      // Render the list
      renderLeaderboard(category);
    }
    
    async function loadLeaderboard() {
      const loading = document.getElementById('leaderboardLoading');
      const container = document.getElementById('leaderboardContainer');

      const setStep = (stepNum, status) => {
        // Mark all previous steps done, current step active, future steps pending
        for (let i = 1; i <= 4; i++) {
          const el = document.getElementById(`lbStep${i}`);
          const icon = el.querySelector('.lb-step-icon');
          if (i < stepNum) {
            el.className = 'leaderboard-loading-step done';
            icon.textContent = '✅';
          } else if (i === stepNum) {
            el.className = 'leaderboard-loading-step active';
            icon.textContent = '⏳';
          } else {
            el.className = 'leaderboard-loading-step';
            icon.textContent = '⏳';
          }
        }
        if (status) {
          document.getElementById('leaderboardLoadingStatus').textContent = status;
        }
      };

      loading.style.display = 'flex';
      container.style.display = 'none';

      // Step 1 - validator list
      setStep(1, 'Fetching validators...');
      if (!allValidators || allValidators.length === 0) {
        await loadNetworkStats();
      }
      if (!allValidators[0] || allValidators[0].skipRate === undefined) {
        await fetchAllSkipRates();
      }
      // Make sure the published (canonical) scores had a chance to load —
      // retry once here in case the initial page-load fetch failed.
      await window.canonicalScoresPromise;
      if (!window.canonicalScores) await loadCanonicalScores();

      // Step 2 - epoch credits history for every validator. The hourly
      // scores.json carries the last 8 epochs + first epoch on record per
      // validator (P9, 2026-09-16); only fall back to the 724 batched
      // getAccountInfo calls when the file predates that or lacks most of them.
      const published = publishedCreditsMap();
      let extendedCreditsMap;
      if (published) {
        setStep(2, 'Using published credits history...');
        extendedCreditsMap = published;
      } else {
        setStep(2, `Fetching credits history for ${allValidators.length} validators...`);
        extendedCreditsMap = await fetchAllExtendedEpochCreditsBatch();
      }

      // Merge extended credits back into allValidators so scoring uses full history
      allValidators.forEach(v => {
        if (extendedCreditsMap[v.votePubkey]) {
          v.epochCredits = extendedCreditsMap[v.votePubkey];
        }
      });

      if (window.canonicalScores) {
        // Published scores carry 7-epoch skip data computed server-side, so
        // the expensive client-side crawl (7 getBlockProduction calls) is
        // unnecessary. Map the published skip data into the cache the rest of
        // the pipeline reads (Reliable tab sorting, card display, fallback).
        setStep(3, 'Using published skip-rate history...');
        const nowTs = Date.now();
        allValidators.forEach(v => {
          const c = window.canonicalScores.validators[v.votePubkey];
          if (!c) return;
          skipRateHistoryCache[v.nodePubkey] = {
            timestamp: nowTs,
            data: {
              epochs: [],
              avgSkipRate: c.skipRate7d,
              simpleAvgSkipRate: c.skipRate7d,
              epochCount: c.skipEpochs,
              requestedEpochs: 7,
              lastEpochSkipRate: null,
              currentEpoch: window.canonicalScores.epoch
            }
          };
        });
      } else {
        setStep(3, 'Fetching skip rate history...');
        // Fallback: bulk historical skip rates (7 epochs, 7 RPC calls in parallel)
        await fetchAllHistoricalSkipRatesBulk(7);
      }

      setStep(4, 'Calculating scores...');

      // Step 4 - score every validator using the same full data the lookup card uses
      leaderboardData = allValidators.map(v => {
        // If already individually cached, use that (it's at least as good).
        // EXCEPT when canonical scores are loaded — then always score through
        // the canonical path so a lookup cached earlier in the session can't
        // pin a stale number onto the leaderboard.
        const cached = window.canonicalScores ? null : validatorInfoCache[v.votePubkey];
        if (cached && cached.performanceScore !== undefined) {
          return {
            ...v,
            ...cached,
            activatedStake: v.activatedStake,
            performanceScore: cached.performanceScore
          };
        }

        const skipHistoryFromCache = skipRateHistoryCache[v.nodePubkey];
        const validatorData = {
          ...v,
          epochCreditsHistory: v.epochCredits || [],
          isDelinquent: v.delinquent,
          skipRateHistory: skipHistoryFromCache ? skipHistoryFromCache.data : null
        };

        return {
          ...validatorData,
          performanceScore: calculatePerformanceScore(validatorData)
        };
      });

      // Mark all done
      setStep(5, 'Done!');
      for (let i = 1; i <= 4; i++) {
        const el = document.getElementById(`lbStep${i}`);
        el.className = 'leaderboard-loading-step done';
        el.querySelector('.lb-step-icon').textContent = '✅';
      }

      loading.style.display = 'none';
      container.style.display = 'block';

      // Warm the delegations cache in the background — no spinner, no
      // await. This way switching to the Delegations tab is usually
      // instant. If it isn't ready yet, the render path shows its own
      // small loading state and re-renders when the data arrives.
      loadDelegationsData()
        .then(() => {
          if (currentLeaderboard === 'delegations') renderLeaderboard('delegations');
        })
        .catch(err => console.warn('Delegations fetch failed:', err));

      renderLeaderboard(currentLeaderboard);
    }
    
    // P9: epoch-credits history from scores.json. Returns { vote: [[epoch,
    // credits, prev], …] } when the published file is fresh enough to be used
    // for scoring (CANONICAL_MAX_AGE_MS) and covers ≥ 90 % of the validators
    // we know about; null otherwise (older file, or a stale one). Also stamps
    // `creditsFirstEpoch` / `creditsEpochs` onto allValidators for Newest.
    function publishedCreditsMap() {
      const doc = window.canonicalScores;
      if (!doc || !doc.validators) return null;
      const map = {};
      let covered = 0;
      for (const v of allValidators) {
        const c = doc.validators[v.votePubkey];
        if (!c || !Array.isArray(c.credits) || c.credits.length === 0) continue;
        map[v.votePubkey] = c.credits;
        v.creditsFirstEpoch = c.creditsFirstEpoch ?? null;
        v.creditsEpochs = c.creditsEpochs ?? c.credits.length;
        covered++;
      }
      if (!allValidators.length || covered < allValidators.length * 0.9) return null;
      return map;
    }

    function renderLeaderboard(category) {
      // Delegations is its own data path — it doesn't derive from
      // leaderboardData (which is keyed on performance/skip/credit
      // metrics). Hand off to a dedicated renderer.
      if (category === 'delegations') {
        renderDelegationsLeaderboard();
        return;
      }

      // Clear the delegations-scoped marker so its lighter label color
      // doesn't bleed into other categories.
      const listEl = document.getElementById('leaderboardList');
      if (listEl) delete listEl.dataset.category;

      if (!leaderboardData || leaderboardData.length === 0) {
        document.getElementById('leaderboardList').innerHTML = '<p style="text-align: center; color: var(--text-dim);">No data available</p>';
        return;
      }
      
      let sorted = [...leaderboardData];
      
      // Sort based on category
      switch (category) {
        case 'performance':
          sorted = sorted.filter(v => v.performanceScore > 0).sort((a, b) => b.performanceScore - a.performanceScore);
          break;
        case 'stake':
          sorted = sorted.sort((a, b) => b.activatedStake - a.activatedStake);
          break;
        case 'commission':
          // Only active validators with some minimum stake.
          // (Bug fix: activatedStake is in lamports — the old `> 10000` check
          // was 0.00001 XNT, i.e. no filter at all. 10000 XNT matches the
          // Reliable tab's threshold.)
          sorted = sorted.filter(v => !v.delinquent && v.activatedStake > 10000 * 1e9)
                        .sort((a, b) => a.commission - b.commission);
          break;
        case 'efficient':
          // Validators with highest credits efficiency (credits per stake).
          // Averaged over the last 7 *completed* epochs (skipping the current
          // in-progress one) — a single epoch was noisy enough that one weird
          // epoch could bounce a validator around the board every hour.
          const avgCompletedCredits = (v) => {
            if (!v.epochCredits || v.epochCredits.length < 2) return 0;
            let total = 0, count = 0;
            for (let i = 1; i < Math.min(v.epochCredits.length, 8); i++) {
              const entry = v.epochCredits[v.epochCredits.length - 1 - i];
              if (entry && entry.length >= 3) {
                total += entry[1] - entry[2];
                count++;
              }
            }
            return count > 0 ? total / count : 0;
          };
          sorted = sorted.filter(v => {
              const stakeInXNT = v.activatedStake / 1e9;
              return avgCompletedCredits(v) > 0 && stakeInXNT > 1000 && !v.delinquent;
            })
            .map(v => {
              const stakeInXNT = v.activatedStake / 1e9;
              v.efficiencyRatio = avgCompletedCredits(v) / (stakeInXNT / 1000000); // Avg credits per 1M XNT
              return v;
            })
            .sort((a, b) => b.efficiencyRatio - a.efficiencyRatio);
          break;
        case 'reliable':
          // Validators with lowest skip rates and best uptime - must have skip rate data
          sorted = sorted.filter(v => 
              v.skipRate !== null && 
              v.skipRate !== undefined && 
              !v.delinquent &&
              v.activatedStake > 10000 * 1e9
            )
            .sort((a, b) => {
              // Primary: real 7-day uptime from the published scores, once it
              // exists. During the first days of data collection uptimePct is
              // null for everyone, so this cleanly falls through to skip rate
              // — the board upgrades itself into a true reliability ranking
              // as observations accumulate.
              const aCanon = window.canonicalScores?.validators[a.votePubkey];
              const bCanon = window.canonicalScores?.validators[b.votePubkey];
              const aUp = aCanon?.uptimePct ?? null;
              const bUp = bCanon?.uptimePct ?? null;
              if (aUp !== null || bUp !== null) {
                if (aUp === null) return 1;
                if (bUp === null) return -1;
                if (aUp !== bUp) return bUp - aUp;
              }
              // Secondary: lowest skip rate — confidence-adjusted when
              // published, else the 7-epoch average, else current epoch.
              const aRate = aCanon?.skipRateAdj ?? a.skipRateHistory?.avgSkipRate ?? a.skipRate;
              const bRate = bCanon?.skipRateAdj ?? b.skipRateHistory?.avgSkipRate ?? b.skipRate;
              if (aRate !== bRate) return aRate - bRate;
              // Tertiary: highest performance score
              return b.performanceScore - a.performanceScore;
            });
          break;
        case 'newest':
          // Most recently activated validators - sorted by first epoch in their credits history
          // First, determine the current epoch from the data
          let maxEpochSeen = 0;
          sorted.forEach(v => {
            if (v.epochCredits && v.epochCredits.length > 0) {
              const latestEpoch = v.epochCredits[v.epochCredits.length - 1][0];
              if (latestEpoch > maxEpochSeen) maxEpochSeen = latestEpoch;
            }
          });
          const currentEpoch = maxEpochSeen || currentEpochNumber || 0;
          
          sorted = sorted.filter(v => 
              v.epochCredits && 
              v.epochCredits.length > 0 && 
              !v.delinquent
            )
            .map(v => {
              // Get the first (oldest) epoch in their history — from the
              // published record when we have it (the merged epochCredits
              // may then be only the last 8 epochs), else from the account.
              v.firstEpoch = (v.creditsFirstEpoch !== null && v.creditsFirstEpoch !== undefined) ? v.creditsFirstEpoch : v.epochCredits[0][0];
              v.epochsActive = v.creditsEpochs || v.epochCredits.length;
              v.epochsAgo = currentEpoch - v.firstEpoch;
              return v;
            })
            .sort((a, b) => {
              // Sort by first epoch descending (highest/newest first)
              return b.firstEpoch - a.firstEpoch;
            })
            .slice(0, 50); // Take top 50 newest, then group
          break;
      }
      
      // Take top 50
      const top20 = sorted.slice(0, 50);
      
      const list = document.getElementById('leaderboardList');
      
      if (top20.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: var(--text-dim); padding: 2rem;">No validators match this criteria</p>';
        return;
      }
      
      // Special rendering for newest validators - grouped by time period
      if (category === 'newest') {
        // Group by how long ago they started
        const currentEpochValidators = top20.filter(v => v.epochsAgo === 0);
        const lastEpochValidators = top20.filter(v => v.epochsAgo === 1);
        const recentValidators = top20.filter(v => v.epochsAgo >= 2);
        
        const renderNewestGroup = (validators, title) => {
          if (validators.length === 0) return '';
          
          return `
            <div class="newest-group">
              <div class="newest-group-title">${title}</div>
              ${validators.map(v => {
                // Logo
                let logoHtml;
                if (v.iconUrl) {
                  logoHtml = `<img class="leaderboard-logo" src="${safeUrl(v.iconUrl)}" alt="${escHtml(v.name)}" data-onerror="img-fallback">
                              <div class="leaderboard-logo-placeholder" style="display:none;">${escHtml(v.name.charAt(0).toUpperCase())}</div>`;
                } else {
                  logoHtml = `<div class="leaderboard-logo-placeholder">${escHtml(v.name.charAt(0).toUpperCase())}</div>`;
                }
                
                return `
                  <div class="leaderboard-item newest-item${myPortfolio.includes(v.votePubkey) ? ' mine' : ''}" data-action="lb-lookup" data-vote="${escHtml(v.votePubkey)}">
                    <div class="newest-badge">🆕</div>
                    <div class="leaderboard-validator">
                      ${logoHtml}
                      <div class="leaderboard-name">${escHtml(v.name)}${myPortfolio.includes(v.votePubkey) ? ' <span class="lb-mine-tag" title="In your Data Center">MINE</span>' : ''}</div>
                    </div>
                    <div class="leaderboard-stats">
                      <div class="leaderboard-stat">
                        <div class="leaderboard-stat-value highlight">Epoch ${v.firstEpoch}</div>
                        <div class="leaderboard-stat-label">Started</div>
                      </div>
                      <div class="leaderboard-stat">
                        <div class="leaderboard-stat-value">${formatStake(v.activatedStake)}</div>
                        <div class="leaderboard-stat-label">Stake</div>
                      </div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          `;
        };
        
        let html = '';
        html += renderNewestGroup(currentEpochValidators, '🔥 Started This Epoch');
        html += renderNewestGroup(lastEpochValidators, '✨ Started Last Epoch');
        html += renderNewestGroup(recentValidators, '🌱 Started Recently');
        
        if (html === '') {
          list.innerHTML = '<p style="text-align: center; color: var(--text-dim); padding: 2rem;">No validators found</p>';
        } else {
          list.innerHTML = html;
        }
        return;
      }
      
      const renderItem = (v, index) => {
        const rank = index + 1;
        const rankClass = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : 'normal';
        const itemClass = rank <= 3 ? rankClass : '';
        const rankDisplay = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
        
        // Logo
        let logoHtml;
        if (v.iconUrl) {
          logoHtml = `<img class="leaderboard-logo" src="${safeUrl(v.iconUrl)}" alt="${escHtml(v.name)}" data-onerror="img-fallback">
                      <div class="leaderboard-logo-placeholder" style="display:none;">${escHtml(v.name.charAt(0).toUpperCase())}</div>`;
        } else {
          logoHtml = `<div class="leaderboard-logo-placeholder">${escHtml(v.name.charAt(0).toUpperCase())}</div>`;
        }
        
        // Stats based on category
        let statsHtml = '';
        switch (category) {
          case 'performance':
            const perfScoreClass = getScoreColorClass(v.performanceScore);
            statsHtml = `
              <div class="leaderboard-stat">
                <div class="leaderboard-stat-value ${perfScoreClass}">${v.performanceScore.toFixed(2)}</div>
                <div class="leaderboard-stat-label">Score</div>
              </div>
              <div class="leaderboard-stat">
                <div class="leaderboard-stat-value">${formatStake(v.activatedStake)}</div>
                <div class="leaderboard-stat-label">Stake</div>
              </div>`;
            break;
          case 'stake':
            statsHtml = `
              <div class="leaderboard-stat">
                <div class="leaderboard-stat-value highlight">${formatStake(v.activatedStake)}</div>
                <div class="leaderboard-stat-label">Stake</div>
              </div>`;
            break;
          case 'commission':
            const commClass = getCommissionColorClass(v.commission);
            // Commission-rug flag from the published scores: this board is
            // exactly where a raise-then-lower rugger would resurface looking
            // cheap, so surface the warning right on the row.
            const rugBadge = window.canonicalScores?.validators[v.votePubkey]?.flags?.includes('commission_rug')
              ? `
              <div class="leaderboard-stat" title="This validator raised commission by 10+ percentage points within the last 7 days">
                <div class="leaderboard-stat-value" style="color: var(--danger, #ff5c5c);">⚠</div>
                <div class="leaderboard-stat-label" style="color: var(--danger, #ff5c5c);">Raised recently</div>
              </div>`
              : '';
            statsHtml = `${rugBadge}
              <div class="leaderboard-stat">
                <div class="leaderboard-stat-value ${commClass}">${v.commission}%</div>
                <div class="leaderboard-stat-label">Commission</div>
              </div>
              <div class="leaderboard-stat">
                <div class="leaderboard-stat-value">${formatStake(v.activatedStake)}</div>
                <div class="leaderboard-stat-label">Stake</div>
              </div>`;
            break;
          case 'efficient':
            const effRatio = v.efficiencyRatio ? formatCompact(v.efficiencyRatio) : 'N/A';
            const effScoreClass = v.performanceScore > 0 ? getScoreColorClass(v.performanceScore) : '';
            statsHtml = `
              <div class="leaderboard-stat">
                <div class="leaderboard-stat-value highlight">${effRatio}</div>
                <div class="leaderboard-stat-label">Credits/1M XNT</div>
              </div>
              <div class="leaderboard-stat">
                <div class="leaderboard-stat-value ${effScoreClass}">${v.performanceScore > 0 ? v.performanceScore.toFixed(2) : 'N/A'}</div>
                <div class="leaderboard-stat-label">Score</div>
              </div>
              <div class="leaderboard-stat">
                <div class="leaderboard-stat-value">${formatStake(v.activatedStake)}</div>
                <div class="leaderboard-stat-label">Stake</div>
              </div>`;
            break;
          case 'reliable':
            // Use 7-epoch average if available, otherwise current epoch
            const avgSkip = v.skipRateHistory && v.skipRateHistory.avgSkipRate !== null ? v.skipRateHistory.avgSkipRate : v.skipRate;
            const skipRateDisplay = avgSkip !== null && avgSkip !== undefined ? avgSkip.toFixed(2) + '%' : 'N/A';
            const skipClass = getSkipRateColorClass(avgSkip);
            const relScoreClass = v.performanceScore > 0 ? getScoreColorClass(v.performanceScore) : '';
            // Real 7-day uptime from the published scores; '—' until the
            // monitoring service has collected enough hourly observations.
            const relUp = window.canonicalScores?.validators[v.votePubkey]?.uptimePct;
            const relUpDisplay = (relUp !== null && relUp !== undefined) ? relUp.toFixed(2) + '%' : '—';
            const relUpClass = (relUp === null || relUp === undefined) ? '' : (relUp >= 99.5 ? 'score-good' : relUp >= 98 ? 'score-warning' : 'score-bad');
            statsHtml = `
              <div class="leaderboard-stat">
                <div class="leaderboard-stat-value ${relUpClass}" ${relUpDisplay === '—' ? 'title="Collecting uptime data — populates after ~12 hours of monitoring"' : ''}>${relUpDisplay}</div>
                <div class="leaderboard-stat-label">Uptime (7d)</div>
              </div>
              <div class="leaderboard-stat">
                <div class="leaderboard-stat-value ${skipClass}">${skipRateDisplay}</div>
                <div class="leaderboard-stat-label">Skip Rate</div>
              </div>
              <div class="leaderboard-stat">
                <div class="leaderboard-stat-value ${relScoreClass}">${v.performanceScore > 0 ? v.performanceScore.toFixed(2) : 'N/A'}</div>
                <div class="leaderboard-stat-label">Score</div>
              </div>`;
            break;
          case 'newest':
            const newScoreClass = v.performanceScore > 0 ? getScoreColorClass(v.performanceScore) : '';
            statsHtml = `
              <div class="leaderboard-stat">
                <div class="leaderboard-stat-value highlight">Epoch ${v.firstEpoch}</div>
                <div class="leaderboard-stat-label">Started</div>
              </div>
              <div class="leaderboard-stat">
                <div class="leaderboard-stat-value ${newScoreClass}">${v.performanceScore > 0 ? v.performanceScore.toFixed(2) : 'N/A'}</div>
                <div class="leaderboard-stat-label">Score</div>
              </div>
              <div class="leaderboard-stat">
                <div class="leaderboard-stat-value">${formatStake(v.activatedStake)}</div>
                <div class="leaderboard-stat-label">Stake</div>
              </div>`;
            break;
        }
        
        return `
          <div class="leaderboard-item ${itemClass}${myPortfolio.includes(v.votePubkey) ? ' mine' : ''}" data-action="lb-lookup" data-vote="${escHtml(v.votePubkey)}">
            <div class="leaderboard-rank ${rankClass}">${rankDisplay}</div>
            <div class="leaderboard-validator">
              ${logoHtml}
              <div class="leaderboard-name">${escHtml(v.name)}${myPortfolio.includes(v.votePubkey) ? ' <span class="lb-mine-tag" title="In your Data Center">MINE</span>' : ''}</div>
            </div>
            <div class="leaderboard-stats">
              ${statsHtml}
            </div>
          </div>
        `;
      };

      list.innerHTML = top20.map(renderItem).join('') + whereAmIHtml(sorted, 50, renderItem);
    }

    // F15 — "Where am I": Data Center validators ranked below the visible
    // top-N are pinned under a divider with their real rank, so an operator
    // at #137 doesn't have to guess. Ones the category's filter excluded
    // (delinquent, too little stake, no score yet…) are listed as not ranked.
    function whereAmIHtml(sorted, limit, renderItem) {
      if (!Array.isArray(myPortfolio) || myPortfolio.length === 0) return '';
      const below = [];
      sorted.forEach((v, i) => { if (i >= limit && myPortfolio.includes(v.votePubkey)) below.push(renderItem(v, i)); });
      const ranked = new Set(sorted.map(v => v.votePubkey));
      const missing = myPortfolio.filter(pk => !ranked.has(pk));
      if (below.length === 0 && missing.length === 0) return '';
      let html = `<div class="lb-mine-divider">Your validators outside the top ${limit}</div>` + below.join('');
      if (missing.length) {
        const names = missing.map(pk => {
          const v = (leaderboardData || []).find(x => x.votePubkey === pk) || (allValidators || []).find(x => x.votePubkey === pk);
          return escHtml(v && v.name ? v.name : pk.slice(0, 8) + '…');
        });
        html += `<div class="lb-mine-note">Not ranked in this category: ${names.join(', ')}</div>`;
      }
      return html;
    }

    // ─────────────────────────────────────────────────────────────────────
    // DELEGATIONS LEADERBOARD RENDERER
    //
    // Builds a ranking of validators by stake delegated from the selected
    // source (X1 Labs, Ripper Pool, or both combined). Reads from the
    // `delegationsData` cache populated by loadDelegationsData(). Honors
    // the team filter — when set to "without", validators whose published
    // identity name starts with "X1 Labs:" are excluded so the listing
    // reflects independent operators backed by these pools rather than
    // the team's own validators.
    //
    // The header summary updates based on the same filters:
    //   "X1 Labs has delegated 4.5M XNT across 23 validators"
    // ─────────────────────────────────────────────────────────────────────
    function renderDelegationsLeaderboard() {
      const list = document.getElementById('leaderboardList');
      const header = document.getElementById('leaderboardHeader');
      list.dataset.category = 'delegations';

      // Loading state — data isn't back yet
      if (!delegationsData) {
        list.innerHTML =
          '<p style="text-align: center; color: var(--text-dim); padding: 2rem;">' +
          '<span style="display:inline-block;width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent-blue);border-radius:50%;animation:spin 1s linear infinite;vertical-align:middle;margin-right:0.5rem;"></span>' +
          'Fetching delegation data…</p>';
        // Try to start the fetch if it hasn't already started
        loadDelegationsData()
          .then(() => {
            if (currentLeaderboard === 'delegations') renderDelegationsLeaderboard();
          })
          .catch(err => {
            list.innerHTML = `<p style="text-align: center; color: var(--text-dim); padding: 2rem;">Could not load delegation data: ${err.message}</p>`;
          });
        return;
      }

      // Pull the right slice based on the source selector
      const x1 = delegationsData.x1Labs;
      const rp = delegationsData.ripper;

      // Build a per-voter combined view (always compute both — cheap)
      const allVoters = new Set([
        ...Object.keys(x1.byVoter),
        ...Object.keys(rp.byVoter),
      ]);
      const rows = [];
      allVoters.forEach(votePubkey => {
        const x1Stake = x1.byVoter[votePubkey] || 0;
        const rpStake = rp.byVoter[votePubkey] || 0;
        const validator = (allValidators || []).find(v => v.votePubkey === votePubkey);
        rows.push({
          votePubkey,
          x1Stake,
          rpStake,
          totalStake: x1Stake + rpStake,
          name: validator ? validator.name : votePubkey.slice(0, 8) + '…' + votePubkey.slice(-4),
          iconUrl: validator ? validator.iconUrl : '',
          activatedStake: validator ? validator.activatedStake : 0,
        });
      });

      // Apply source filter — only keep rows that have stake from the
      // selected source(s)
      let filtered = rows;
      if (delegationsSource === 'x1Labs') {
        filtered = filtered.filter(r => r.x1Stake > 0);
      } else if (delegationsSource === 'ripper') {
        filtered = filtered.filter(r => r.rpStake > 0);
      } else {
        filtered = filtered.filter(r => r.totalStake > 0);
      }

      // Sort by the stake from the selected source(s), descending
      filtered.sort((a, b) => {
        if (delegationsSource === 'x1Labs') return b.x1Stake - a.x1Stake;
        if (delegationsSource === 'ripper') return b.rpStake - a.rpStake;
        return b.totalStake - a.totalStake;
      });

      // Header summary line — totals reflect the active source
      const sumX1 = filtered.reduce((s, r) => s + r.x1Stake, 0);
      const sumRp = filtered.reduce((s, r) => s + r.rpStake, 0);
      const sumTotal = sumX1 + sumRp;

      const sourceLabel =
        delegationsSource === 'x1Labs' ? 'X1 Labs' :
        delegationsSource === 'ripper' ? 'Ripper Pool' :
        'X1 Labs + Ripper Pool';

      let summaryAmount;
      let breakdown = '';
      if (delegationsSource === 'x1Labs') {
        summaryAmount = `${formatStake(sumX1)} XNT`;
      } else if (delegationsSource === 'ripper') {
        summaryAmount = `${formatStake(sumRp)} XNT`;
      } else {
        summaryAmount = `${formatStake(sumTotal)} XNT`;
        breakdown = `<div class="delegations-breakdown">X1 Labs: ${formatStake(sumX1)} XNT · Ripper Pool: ${formatStake(sumRp)} XNT</div>`;
      }

      header.innerHTML = `
        <h2>🤝 Delegations</h2>
        <p class="leaderboard-subtitle">Validators ranked by stake delegated from X1 Labs and the Ripper Pool</p>
        <div class="delegations-summary">
          <strong>${sourceLabel}</strong> has delegated <strong>${summaryAmount}</strong>
          across <strong>${filtered.length}</strong> validator${filtered.length === 1 ? '' : 's'}.
          ${breakdown}
        </div>
      `;

      if (filtered.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: var(--text-dim); padding: 2rem;">No delegations match the current filters</p>';
        return;
      }

      // Top 50, same convention as the other leaderboards
      const top = filtered.slice(0, 50);

      const renderItem = (r, i) => {
        const rank = i + 1;
        const rankClass = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : 'normal';
        const itemClass = rank <= 3 ? rankClass : '';
        const rankDisplay = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;

        // Logo (matches existing leaderboard logo treatment)
        let logoHtml;
        if (r.iconUrl) {
          logoHtml = `<img class="leaderboard-logo" src="${safeUrl(r.iconUrl)}" alt="${escHtml(r.name)}" data-onerror="img-fallback">
                      <div class="leaderboard-logo-placeholder" style="display:none;">${escHtml(r.name.charAt(0).toUpperCase())}</div>`;
        } else {
          logoHtml = `<div class="leaderboard-logo-placeholder">${escHtml(r.name.charAt(0).toUpperCase())}</div>`;
        }

        // Stat block — depends on source selector
        let statsHtml;
        if (delegationsSource === 'both') {
          statsHtml = `
            <div class="leaderboard-stat">
              <div class="leaderboard-stat-value highlight">${formatStake(r.totalStake)}</div>
              <div class="leaderboard-stat-label">Total Delegated</div>
            </div>
            <div class="leaderboard-stat">
              <div class="leaderboard-stat-value">${formatStake(r.x1Stake)}</div>
              <div class="leaderboard-stat-label">X1 Labs</div>
            </div>
            <div class="leaderboard-stat">
              <div class="leaderboard-stat-value">${formatStake(r.rpStake)}</div>
              <div class="leaderboard-stat-label">Ripper</div>
            </div>`;
        } else {
          const amount = delegationsSource === 'x1Labs' ? r.x1Stake : r.rpStake;
          const label  = delegationsSource === 'x1Labs' ? 'X1 Labs Delegated' : 'Ripper Delegated';
          statsHtml = `
            <div class="leaderboard-stat">
              <div class="leaderboard-stat-value highlight">${formatStake(amount)}</div>
              <div class="leaderboard-stat-label">${label}</div>
            </div>`;
        }

        return `
          <div class="leaderboard-item ${itemClass}${myPortfolio.includes(r.votePubkey) ? ' mine' : ''}" data-action="lb-lookup" data-vote="${escHtml(r.votePubkey)}">
            <div class="leaderboard-rank ${rankClass}">${rankDisplay}</div>
            <div class="leaderboard-validator">
              ${logoHtml}
              <div class="leaderboard-name">${escHtml(r.name)}${myPortfolio.includes(r.votePubkey) ? ' <span class="lb-mine-tag" title="In your Data Center">MINE</span>' : ''}</div>
            </div>
            <div class="leaderboard-stats">
              ${statsHtml}
            </div>
          </div>
        `;
      };

      list.innerHTML = top.map(renderItem).join('') + whereAmIHtml(filtered, 50, renderItem);
    }

    Actions.register({
      'lb-category': (el, e, d) => switchLeaderboard(d.category),
      'lb-lookup':   (el, e, d) => lookupValidator(d.vote),
    });
