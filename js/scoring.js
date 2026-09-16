    // =========================================
    // PERFORMANCE TRACKING SYSTEM
    // =========================================
    
    const PERF_STORAGE_KEY = 'x1ValidatorPerformanceHistory';
    const PERF_HISTORY_DAYS = 7; // Track 7 days of history
    
    // Load performance history from localStorage
    function loadPerformanceHistory() {
      try {
        const stored = localStorage.getItem(PERF_STORAGE_KEY);
        return stored ? JSON.parse(stored) : {};
      } catch (e) {
        console.error('Error loading performance history:', e);
        return {};
      }
    }
    
    // Save performance history to localStorage
    function savePerformanceHistory(history) {
      try {
        localStorage.setItem(PERF_STORAGE_KEY, JSON.stringify(history));
      } catch (e) {
        console.error('Error saving performance history:', e);
      }
    }
    
    // ==========================================
    // VALIDATOR UPTIME TRACKING
    // Tracks delinquency observations over time
    // ==========================================
    const UPTIME_STORAGE_KEY = 'x1ValidatorUptimeHistory';
    let uptimeHistoryCache = null; // Cache to avoid repeated localStorage reads
    
    function loadUptimeHistory() {
      // Return cached version if available
      if (uptimeHistoryCache !== null) {
        return uptimeHistoryCache;
      }
      try {
        const stored = localStorage.getItem(UPTIME_STORAGE_KEY);
        uptimeHistoryCache = stored ? JSON.parse(stored) : {};
        return uptimeHistoryCache;
      } catch (e) {
        uptimeHistoryCache = {};
        return uptimeHistoryCache;
      }
    }
    
    function saveUptimeHistory(history) {
      try {
        uptimeHistoryCache = history; // Update cache
        localStorage.setItem(UPTIME_STORAGE_KEY, JSON.stringify(history));
      } catch (e) {
        console.error('Error saving uptime history:', e);
      }
    }
    
    // Get uptime data for a specific validator
    function getValidatorUptimeHistory(voteAccount) {
      const history = loadUptimeHistory();
      return history[voteAccount] || null;
    }
    
    // Update uptime tracking for all validators (called when validators are loaded)
    function updateUptimeTracking(validators) {
      if (!validators || validators.length === 0) return;
      
      const history = loadUptimeHistory();
      const now = Date.now();
      
      // Only update once per hour to avoid excessive tracking
      const lastUpdate = history._lastUpdate || 0;
      if (now - lastUpdate < 3600000) return; // 1 hour
      
      for (const v of validators) {
        const voteAccount = v.voteAccount || v.votePubkey;
        if (!voteAccount) continue;
        
        if (!history[voteAccount]) {
          history[voteAccount] = {
            observations: 0,
            delinquentCount: 0,
            firstSeen: now,
            lastSeen: now
          };
        }
        
        const record = history[voteAccount];
        record.observations++;
        record.lastSeen = now;
        
        if (v.isDelinquent || v.delinquent) {
          record.delinquentCount++;
        }
      }
      
      history._lastUpdate = now;
      
      // Clean up old entries (not seen in 30 days)
      const cutoff = now - (30 * 24 * 60 * 60 * 1000);
      for (const key of Object.keys(history)) {
        if (key === '_lastUpdate') continue;
        if (history[key].lastSeen < cutoff) {
          delete history[key];
        }
      }
      
      saveUptimeHistory(history);
    }
    
    // Clean up old entries (older than 7 days)
    function cleanupOldHistory(history) {
      const cutoffTime = Date.now() - (PERF_HISTORY_DAYS * 24 * 60 * 60 * 1000);
      
      Object.keys(history).forEach(voteAccount => {
        const validatorHistory = history[voteAccount];
        if (validatorHistory.snapshots) {
          validatorHistory.snapshots = validatorHistory.snapshots.filter(s => s.timestamp > cutoffTime);
        }
        if (validatorHistory.delinquentEvents) {
          validatorHistory.delinquentEvents = validatorHistory.delinquentEvents.filter(e => e.timestamp > cutoffTime);
        }
      });
      
      return history;
    }
    
    // Record a performance snapshot for a validator
    function recordPerformanceSnapshot(validator) {
      const history = loadPerformanceHistory();
      const voteAccount = validator.voteAccount || validator.votePubkey;
      
      if (!voteAccount) return;
      
      if (!history[voteAccount]) {
        history[voteAccount] = {
          snapshots: [],
          delinquentEvents: [],
          lastDelinquentState: false
        };
      }
      
      const validatorHistory = history[voteAccount];
      const now = Date.now();
      
      // Only record one snapshot per hour to avoid bloating storage
      const lastSnapshot = validatorHistory.snapshots[validatorHistory.snapshots.length - 1];
      if (lastSnapshot && (now - lastSnapshot.timestamp) < 3600000) {
        return; // Skip if less than 1 hour since last snapshot
      }
      
      // Record snapshot
      validatorHistory.snapshots.push({
        timestamp: now,
        isDelinquent: validator.isDelinquent || validator.delinquent || false,
        skipRate: validator.skipRate,
        version: validator.version,
        epochCredits: validator.epochCredits
      });
      
      // Track delinquency events
      const isDelinquentNow = validator.isDelinquent || validator.delinquent || false;
      if (isDelinquentNow && !validatorHistory.lastDelinquentState) {
        // Just became delinquent
        validatorHistory.delinquentEvents.push({
          timestamp: now,
          type: 'start'
        });
      } else if (!isDelinquentNow && validatorHistory.lastDelinquentState) {
        // Just recovered from delinquency
        validatorHistory.delinquentEvents.push({
          timestamp: now,
          type: 'end'
        });
      }
      validatorHistory.lastDelinquentState = isDelinquentNow;
      
      // Cleanup and save
      savePerformanceHistory(cleanupOldHistory(history));
    }
    
    // ==========================================
    // PERFORMANCE SCORING SYSTEM v2
    // Absolute scoring - rewards actual performance
    // ==========================================
    
    // Calculate comprehensive performance score
    function calculatePerformanceScore(validator) {
      const breakdown = calculatePerformanceBreakdown(validator);
      return breakdown.totalScore;
    }
    
    // Get detailed performance breakdown.
    // CANONICAL FIRST: if the hourly published scores are loaded, return the
    // canonical breakdown so every viewer sees identical numbers everywhere
    // (leaderboard, lookup cards, tooltips). The absolute-scoring code below
    // only runs as a fallback when data/scores.json is missing or stale.
    function calculatePerformanceBreakdown(validator) {
      const canonical = getCanonicalBreakdown(validator);
      if (canonical) return canonical;

      const breakdown = {
        voteEfficiency: { score: 85, weight: 0.30, details: '' },
        skipRate: { score: 75, weight: 0.25, details: '' },
        consistency: { score: 85, weight: 0.20, details: '' },
        commission: { score: 90, weight: 0.05, details: '' },
        longevity: { score: 50, weight: 0.05, details: '' },
        softwareVersion: { score: 50, weight: 0.05, details: '' },
        reliability: { score: 0, weight: 0.10, details: '' },
        totalScore: 50
      };
      
      const voteAccount = validator.voteAccount || validator.votePubkey;
      const epochCreditsHistory = validator.epochCreditsHistory || validator.epochCredits || [];
      
      // ==========================================
      // 1. VOTE EFFICIENCY (30%) - Absolute scoring
      // Credits earned vs network average
      // ==========================================
      if (epochCreditsHistory.length >= 2 && window.networkAverageCredits) {
        let totalCredits = 0;
        let epochCount = 0;
        
        // Skip current epoch, use last 7 completed
        for (let i = 1; i < Math.min(epochCreditsHistory.length, 8); i++) {
          const entry = epochCreditsHistory[epochCreditsHistory.length - 1 - i];
          if (entry && entry.length >= 3) {
            const earned = entry[1] - entry[2];
            totalCredits += earned;
            epochCount++;
          }
        }
        
        if (epochCount > 0) {
          const avgCredits = totalCredits / epochCount;
          const efficiency = (avgCredits / window.networkAverageCredits) * 100;
          
          // Absolute scoring: 100% of avg = 90, 105% = 100, 95% = 75
          let score;
          if (efficiency >= 105) score = 100;
          else if (efficiency >= 103) score = 98;
          else if (efficiency >= 101) score = 96;
          else if (efficiency >= 100) score = 93;
          else if (efficiency >= 99) score = 88;
          else if (efficiency >= 98) score = 82;
          else if (efficiency >= 97) score = 75;
          else if (efficiency >= 95) score = 65;
          else if (efficiency >= 93) score = 55;
          else if (efficiency >= 90) score = 45;
          else if (efficiency >= 85) score = 30;
          else if (efficiency >= 80) score = 15;
          else score = 5;
          
          breakdown.voteEfficiency.score = score;
          breakdown.voteEfficiency.details = `${efficiency.toFixed(1)}% of avg`;
        } else {
          breakdown.voteEfficiency.details = 'Insufficient data';
        }
      } else {
        breakdown.voteEfficiency.details = 'Building history...';
      }
      
      // ==========================================
      // 2. SKIP RATE (25%) - Absolute scoring
      // Lower skip rate = higher score
      // ==========================================
      const skipHistory = validator.skipRateHistory;
      let skipRate = null;
      let skipSource = '';
      
      if (skipHistory && skipHistory.avgSkipRate !== null) {
        skipRate = skipHistory.avgSkipRate;
        const epochCount = skipHistory.epochCount || skipHistory.epochs?.length || '?';
        skipSource = `${epochCount}-epoch avg`;
      } else if (skipHistory && skipHistory.lastEpochSkipRate !== null) {
        skipRate = skipHistory.lastEpochSkipRate;
        skipSource = 'last epoch';
      } else if (validator.skipRate !== null && validator.skipRate !== undefined) {
        skipRate = validator.skipRate;
        skipSource = 'current';
      }
      
      if (skipRate !== null) {
        // Absolute scoring for skip rate - tighter thresholds
        let score;
        if (skipRate === 0) score = 100;
        else if (skipRate <= 0.1) score = 98;
        else if (skipRate <= 0.25) score = 95;
        else if (skipRate <= 0.5) score = 90;
        else if (skipRate <= 1.0) score = 85;
        else if (skipRate <= 2.0) score = 70;
        else if (skipRate <= 3.0) score = 50;
        else if (skipRate <= 5.0) score = 35;
        else if (skipRate <= 10.0) score = 20;
        else score = 10;
        
        breakdown.skipRate.score = score;
        breakdown.skipRate.details = `${skipRate.toFixed(2)}% (${skipSource})`;
      } else {
        breakdown.skipRate.score = 75;
        breakdown.skipRate.details = 'No blocks yet';
      }
      
      // ==========================================
      // 3. CONSISTENCY (20%) - Coefficient of Variation
      // Lower variance in credits over 7 epochs = better
      // ==========================================
      if (epochCreditsHistory.length >= 4) {
        const creditsPerEpoch = [];
        
        // Skip current epoch, use last 7 completed
        for (let i = 1; i < Math.min(epochCreditsHistory.length, 8); i++) {
          const entry = epochCreditsHistory[epochCreditsHistory.length - 1 - i];
          if (entry && entry.length >= 3) {
            const earned = entry[1] - entry[2];
            creditsPerEpoch.push(earned);
          }
        }
        
        if (creditsPerEpoch.length >= 3) {
          const avg = creditsPerEpoch.reduce((sum, c) => sum + c, 0) / creditsPerEpoch.length;
          
          // Calculate standard deviation
          let variance = 0;
          creditsPerEpoch.forEach(c => {
            variance += Math.pow(c - avg, 2);
          });
          variance /= creditsPerEpoch.length;
          const stdDev = Math.sqrt(variance);
          
          // Coefficient of variation (CV) - normalized measure of dispersion
          const cv = avg > 0 ? (stdDev / avg) * 100 : 0;
          
          // Absolute scoring: CV of 0% = 100, CV of 1% = 92, CV of 5% = 60
          let score;
          if (cv <= 0.1) score = 100;
          else if (cv <= 0.3) score = 98;
          else if (cv <= 0.5) score = 96;
          else if (cv <= 1.0) score = 92;
          else if (cv <= 2.0) score = 85;
          else if (cv <= 3.0) score = 75;
          else if (cv <= 5.0) score = 60;
          else if (cv <= 8.0) score = 45;
          else if (cv <= 12.0) score = 30;
          else score = 15;
          
          breakdown.consistency.score = score;
          breakdown.consistency.details = `CV: ${cv.toFixed(2)}% over ${creditsPerEpoch.length} epochs`;
        } else {
          breakdown.consistency.details = 'Need 3+ epochs';
        }
      } else {
        breakdown.consistency.details = 'Building history...';
      }
      
      // ==========================================
      // 4. COMMISSION (5%)
      // 0% = 100, 10% = 90, 100% = 0
      // ==========================================
      const commission = validator.commission || 0;
      const commissionScore = Math.max(0, 100 - commission);
      breakdown.commission.score = commissionScore;
      breakdown.commission.details = `${commission}%`;
      
      // ==========================================
      // 5. LONGEVITY (5%) - Validator Age
      // More epochs = more established, but flatter curve
      // ==========================================
      const epochsActive = epochCreditsHistory.length;
      let longevityScore;
      let longevityTier;
      
      if (epochsActive >= 100) {
        longevityScore = 100;
        longevityTier = 'Veteran';
      } else if (epochsActive >= 50) {
        longevityScore = 90;
        longevityTier = 'Established';
      } else if (epochsActive >= 30) {
        longevityScore = 80;
        longevityTier = 'Mature';
      } else if (epochsActive >= 20) {
        longevityScore = 70;
        longevityTier = 'Experienced';
      } else if (epochsActive >= 10) {
        longevityScore = 60;
        longevityTier = 'Growing';
      } else if (epochsActive >= 5) {
        longevityScore = 50;
        longevityTier = 'New';
      } else {
        longevityScore = 40;
        longevityTier = 'Very New';
      }
      
      breakdown.longevity.score = longevityScore;
      breakdown.longevity.details = `${epochsActive} epochs (${longevityTier})`;
      
      // ==========================================
      // 6. SOFTWARE VERSION (5%)
      // Gradient scoring based on how far behind
      // ==========================================
      if (validator.version) {
        const versionStatus = getVersionStatus(validator.version);
        breakdown.softwareVersion.score = versionStatus.score;
        breakdown.softwareVersion.details = versionStatus.details;
      } else {
        breakdown.softwareVersion.score = 50;
        breakdown.softwareVersion.details = 'Unknown version';
      }
      
      // ==========================================
      // 7. RELIABILITY (10%)
      // +50 for uptime history (tracked over observations)
      // +50 for reliable performance (80%+ credits in all epochs)
      // ==========================================
      let reliabilityScore = 0;
      const reliabilityDetails = [];
      
      // Uptime check (+50) - current status only.
      // NOTE: this used to read per-browser localStorage uptime history, which
      // was the main reason two viewers saw different scores for the same
      // validator. Real 24/7 uptime tracking now lives in the canonical score
      // pipeline (scripts/compute-scores.js); this fallback stays deterministic.
      const isDelinquent = validator.isDelinquent || validator.delinquent || false;
      if (!isDelinquent) {
        reliabilityScore += 50;
        reliabilityDetails.push('✓ Active');
      } else {
        reliabilityDetails.push('✗ Delinquent');
      }
      
      // Reliable performance check (+50) - all epochs at 80%+ of network average
      if (epochCreditsHistory.length >= 3 && window.networkEpochCredits) {
        let allGood = true;
        let checkedEpochs = 0;
        
        for (let i = 1; i < Math.min(epochCreditsHistory.length, 8); i++) {
          const entry = epochCreditsHistory[epochCreditsHistory.length - 1 - i];
          if (!entry || entry.length < 3) continue;
          
          const epoch = entry[0];
          const creditsEarned = entry[1] - entry[2];
          const networkAvg = window.networkEpochCredits[epoch];
          
          if (networkAvg && networkAvg > 0) {
            checkedEpochs++;
            const ratio = creditsEarned / networkAvg;
            if (ratio < 0.80) {
              allGood = false;
              break;
            }
          }
        }
        
        if (allGood && checkedEpochs >= 3) {
          reliabilityScore += 50;
          reliabilityDetails.push('✓ Consistent');
        } else {
          reliabilityDetails.push('✗ Gaps');
        }
      } else {
        reliabilityDetails.push('? History');
      }
      
      breakdown.reliability.score = reliabilityScore;
      breakdown.reliability.details = reliabilityDetails.join(' ');
      
      // ==========================================
      // CALCULATE TOTAL SCORE
      // ==========================================
      breakdown.totalScore = 
        (breakdown.voteEfficiency.score * breakdown.voteEfficiency.weight) +
        (breakdown.skipRate.score * breakdown.skipRate.weight) +
        (breakdown.consistency.score * breakdown.consistency.weight) +
        (breakdown.commission.score * breakdown.commission.weight) +
        (breakdown.longevity.score * breakdown.longevity.weight) +
        (breakdown.softwareVersion.score * breakdown.softwareVersion.weight) +
        (breakdown.reliability.score * breakdown.reliability.weight);
      
      // Round to 2 decimal places for more separation
      breakdown.totalScore = Math.round(Math.max(0, Math.min(100, breakdown.totalScore)) * 100) / 100;
      
      return breakdown;
    }
    
    // ==========================================
    // LEGACY PERFORMANCE SCORING (kept for rollback)
    // ==========================================
    function calculatePerformanceScore_LEGACY(validator) {
      const breakdown = calculatePerformanceBreakdown_LEGACY(validator);
      return breakdown.totalScore;
    }
    
    function calculatePerformanceBreakdown_LEGACY(validator) {
      const breakdown = {
        epochCreditsConsistency: { score: 100, weight: 0.10, details: '' },
        creditsVsNetwork: { score: 100, weight: 0.20, details: '' },
        currentStatus: { score: 100, weight: 0.10, details: '' },
        skipRate: { score: 100, weight: 0.25, details: '' },
        versionStatus: { score: 100, weight: 0.10, details: '' },
        uptimeHistory: { score: 100, weight: 0.25, details: '' },
        totalScore: 100
      };
      
      const voteAccount = validator.voteAccount || validator.votePubkey;
      const history = loadPerformanceHistory();
      const validatorHistory = history[voteAccount] || { snapshots: [], delinquentEvents: [] };
      
      // Normalize data - handle both allValidators format and getValidatorInfo format
      const epochCreditsHistory = validator.epochCreditsHistory || validator.epochCredits || [];
      
      // Determine stake in XNT - allValidators has lamports, getValidatorInfo has XNT
      // If stake > 1 billion, it's probably in lamports
      let stakeInXNT = validator.activatedStake || 0;
      if (stakeInXNT > 1e12) {
        stakeInXNT = stakeInXNT / 1e9; // Convert from lamports
      }
      
      // 1. EPOCH CREDITS CONSISTENCY (10%)
      if (epochCreditsHistory.length >= 4) {
        const creditsPerEpoch = [];
        for (let i = 1; i < Math.min(epochCreditsHistory.length, 6); i++) {
          const entry = epochCreditsHistory[epochCreditsHistory.length - 1 - i];
          if (entry && entry.length >= 3) {
            const earned = entry[1] - entry[2];
            creditsPerEpoch.push({ earned, weight: 1 });
          }
        }
        
        if (creditsPerEpoch.length >= 3) {
          const avg = creditsPerEpoch.reduce((sum, c) => sum + c.earned, 0) / creditsPerEpoch.length;
          let variance = 0;
          creditsPerEpoch.forEach(c => {
            variance += Math.pow(c.earned - avg, 2);
          });
          variance /= creditsPerEpoch.length;
          const cv = Math.sqrt(variance) / avg;
          const cvPercent = cv * 100;
          
          let score;
          if (cvPercent <= 0.3) score = 96;
          else if (cvPercent <= 0.5) score = 93;
          else if (cvPercent <= 0.8) score = 89;
          else if (cvPercent <= 1.2) score = 84;
          else if (cvPercent <= 2) score = 78;
          else if (cvPercent <= 3) score = 71;
          else if (cvPercent <= 5) score = 62;
          else if (cvPercent <= 8) score = 52;
          else if (cvPercent <= 12) score = 40;
          else if (cvPercent <= 18) score = 28;
          else if (cvPercent <= 25) score = 16;
          else score = 8;
          
          breakdown.epochCreditsConsistency.score = score;
          breakdown.epochCreditsConsistency.details = `CV: ${cvPercent.toFixed(1)}%`;
        }
      } else {
        breakdown.epochCreditsConsistency.score = 50;
      }
      
      // 2. CREDITS EFFICIENCY (20%)
      if (epochCreditsHistory.length > 1 && window.networkAverageCreditsPerStake && stakeInXNT > 1000) {
        const latestCredits = epochCreditsHistory[epochCreditsHistory.length - 2];
        if (latestCredits && latestCredits.length >= 3) {
          const earned = latestCredits[1] - latestCredits[2];
          const validatorRatio = earned / (stakeInXNT / 1000000);
          const efficiencyRatio = validatorRatio / window.networkAverageCreditsPerStake;
          
          let score;
          if (efficiencyRatio >= 1.15) score = 100;
          else if (efficiencyRatio >= 1.12) score = 96;
          else if (efficiencyRatio >= 1.10) score = 92;
          else if (efficiencyRatio >= 1.08) score = 88;
          else if (efficiencyRatio >= 1.06) score = 84;
          else if (efficiencyRatio >= 1.04) score = 80;
          else if (efficiencyRatio >= 1.02) score = 75;
          else if (efficiencyRatio >= 1.00) score = 70;
          else if (efficiencyRatio >= 0.98) score = 64;
          else if (efficiencyRatio >= 0.96) score = 57;
          else if (efficiencyRatio >= 0.94) score = 50;
          else if (efficiencyRatio >= 0.92) score = 42;
          else if (efficiencyRatio >= 0.90) score = 34;
          else if (efficiencyRatio >= 0.85) score = 24;
          else if (efficiencyRatio >= 0.80) score = 14;
          else score = 5;
          
          breakdown.creditsVsNetwork.score = score;
          breakdown.creditsVsNetwork.details = `${(efficiencyRatio * 100).toFixed(1)}% of avg`;
        }
      } else {
        breakdown.creditsVsNetwork.score = 75;
      }
      
      // 3. CURRENT STATUS (10%)
      const isDelinquent = validator.isDelinquent || validator.delinquent || false;
      breakdown.currentStatus.score = isDelinquent ? 0 : 100;
      breakdown.currentStatus.details = isDelinquent ? 'Currently delinquent' : 'Active';
      
      // 4. SKIP RATE (25%)
      const skipRate = validator.skipRate;
      const skipHistory = validator.skipRateHistory;
      
      function getSkipRateScore(rate) {
        if (rate === 0) return 100;
        if (rate <= 0.05) return 98;
        if (rate <= 0.1) return 95;
        if (rate <= 0.2) return 91;
        if (rate <= 0.35) return 86;
        if (rate <= 0.5) return 80;
        if (rate <= 0.75) return 72;
        if (rate <= 1) return 63;
        if (rate <= 1.5) return 50;
        if (rate <= 2) return 38;
        if (rate <= 3) return 25;
        if (rate <= 4) return 15;
        if (rate <= 5) return 8;
        return 0;
      }
      
      if (skipHistory && skipHistory.avgSkipRate !== null) {
        const epochCount = skipHistory.epochCount || skipHistory.epochs?.length || '?';
        breakdown.skipRate.score = getSkipRateScore(skipHistory.avgSkipRate);
        breakdown.skipRate.details = `${skipHistory.avgSkipRate.toFixed(2)}% (${epochCount}-epoch avg)`;
      } else if (skipHistory && skipHistory.lastEpochSkipRate !== null) {
        breakdown.skipRate.score = getSkipRateScore(skipHistory.lastEpochSkipRate);
        breakdown.skipRate.details = `${skipHistory.lastEpochSkipRate.toFixed(2)}% (last epoch)`;
      } else if (skipRate !== null && skipRate !== undefined) {
        breakdown.skipRate.score = getSkipRateScore(skipRate);
        breakdown.skipRate.details = `${skipRate.toFixed(2)}% (this epoch)`;
      } else {
        breakdown.skipRate.score = 75;
        breakdown.skipRate.details = 'Awaiting slots';
      }
      
      // 5. VERSION STATUS (10%)
      if (validator.version) {
        const outdated = isVersionOutdated(validator.version);
        breakdown.versionStatus.score = outdated ? 50 : 100;
        breakdown.versionStatus.details = `v${validator.version} (${outdated ? 'outdated' : 'latest'})`;
      } else {
        breakdown.versionStatus.score = 50;
        breakdown.versionStatus.details = 'Unknown version';
      }
      
      // 6. UPTIME HISTORY (25%)
      const epochCreditsHist = validator.epochCreditsHistory || validator.epochCredits || [];
      
      if (epochCreditsHist.length >= 3 && window.networkEpochCredits) {
        const epochsToCheck = Math.min(7, epochCreditsHist.length - 1);
        let goodEpochs = 0;
        let checkedEpochs = 0;
        
        for (let i = 1; i <= epochsToCheck; i++) {
          const entry = epochCreditsHist[epochCreditsHist.length - 1 - i];
          if (!entry || entry.length < 3) continue;
          
          const epoch = entry[0];
          const creditsEarned = entry[1] - entry[2];
          const networkAvg = window.networkEpochCredits[epoch];
          
          if (networkAvg && networkAvg > 0) {
            checkedEpochs++;
            const ratio = creditsEarned / networkAvg;
            if (ratio >= 0.80) goodEpochs++;
          }
        }
        
        if (checkedEpochs > 0) {
          let score;
          if (goodEpochs === checkedEpochs) score = 95;
          else if (goodEpochs >= checkedEpochs - 1) score = 80;
          else if (goodEpochs >= checkedEpochs - 2) score = 60;
          else score = Math.max(10, (goodEpochs / checkedEpochs) * 50);
          
          breakdown.uptimeHistory.score = score;
          breakdown.uptimeHistory.details = `${goodEpochs}/${checkedEpochs} good epochs`;
        } else {
          breakdown.uptimeHistory.score = 75;
        }
      } else {
        breakdown.uptimeHistory.score = 75;
        breakdown.uptimeHistory.details = 'Building history...';
      }
      
      // Calculate total
      breakdown.totalScore = 
        (breakdown.epochCreditsConsistency.score * breakdown.epochCreditsConsistency.weight) +
        (breakdown.creditsVsNetwork.score * breakdown.creditsVsNetwork.weight) +
        (breakdown.currentStatus.score * breakdown.currentStatus.weight) +
        (breakdown.skipRate.score * breakdown.skipRate.weight) +
        (breakdown.versionStatus.score * breakdown.versionStatus.weight) +
        (breakdown.uptimeHistory.score * breakdown.uptimeHistory.weight);
      
      breakdown.totalScore = Math.max(0, Math.min(100, breakdown.totalScore));
      
      return breakdown;
    }
    
    // Calculate network average credits (call this when loading validators)
    function calculateNetworkAverageCredits() {
      if (!allValidators || allValidators.length === 0) return;
      
      let totalCredits = 0;
      let totalRatio = 0;
      let count = 0;
      let ratioCount = 0;
      
      // For full epoch average: use the last COMPLETED epoch (second-to-last entry)
      let totalFullEpochCredits = 0;
      let fullEpochCount = 0;
      
      // Also calculate per-epoch network averages for uptime detection
      const epochCreditsMap = {}; // { epoch: { total: 0, count: 0 } }
      
      allValidators.forEach(v => {
        if (v.epochCredits && v.epochCredits.length > 0) {
          const latest = v.epochCredits[v.epochCredits.length - 1];
          if (latest && latest.length >= 3) {
            const earned = latest[1] - latest[2];
            totalCredits += earned;
            count++;
            
            // Calculate credits per stake ratio (credits per 1M XNT staked)
            const stakeInXNT = v.activatedStake / 1e9;
            if (stakeInXNT > 1000) { // Only include validators with meaningful stake
              const ratio = earned / (stakeInXNT / 1000000); // Credits per 1M XNT
              totalRatio += ratio;
              ratioCount++;
            }
          }
          
          // Last completed epoch = second-to-last entry
          if (v.epochCredits.length >= 2) {
            const lastCompleted = v.epochCredits[v.epochCredits.length - 2];
            if (lastCompleted && lastCompleted.length >= 3) {
              const fullEarned = lastCompleted[1] - lastCompleted[2];
              if (fullEarned > 0) {
                totalFullEpochCredits += fullEarned;
                fullEpochCount++;
              }
            }
          }
          
          // Build per-epoch credits for uptime history calculation
          // Skip current epoch (index 0 from end), look at last 7 completed epochs
          for (let i = 1; i < Math.min(v.epochCredits.length, 8); i++) {
            const entry = v.epochCredits[v.epochCredits.length - 1 - i];
            if (entry && entry.length >= 3) {
              const epoch = entry[0];
              const creditsEarned = entry[1] - entry[2];
              
              if (!epochCreditsMap[epoch]) {
                epochCreditsMap[epoch] = { total: 0, count: 0 };
              }
              epochCreditsMap[epoch].total += creditsEarned;
              epochCreditsMap[epoch].count++;
            }
          }
        }
      });
      
      window.networkAverageCredits = count > 0 ? totalCredits / count : null;
      window.networkAverageCreditsPerStake = ratioCount > 0 ? totalRatio / ratioCount : null;
      window.networkFullEpochCredits = fullEpochCount > 0 ? totalFullEpochCredits / fullEpochCount : null;
      
      // Calculate per-epoch averages
      window.networkEpochCredits = {};
      for (const epoch in epochCreditsMap) {
        const data = epochCreditsMap[epoch];
        if (data.count > 0) {
          window.networkEpochCredits[epoch] = data.total / data.count;
        }
      }
    }
    
    // Fetch skip rates for all validators at once
    async function fetchAllSkipRates() {
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBlockProduction'
          })
        });
        
        const data = await response.json();
        if (data.result && data.result.value && data.result.value.byIdentity) {
          const byIdentity = data.result.value.byIdentity;
          
          // Update each validator's skip rate
          allValidators.forEach(v => {
            const production = byIdentity[v.nodePubkey];
            if (production && production.length >= 2) {
              const leaderSlots = production[0];
              const blocksProduced = production[1];
              if (leaderSlots > 0) {
                v.skipRate = ((leaderSlots - blocksProduced) / leaderSlots) * 100;
              } else {
                v.skipRate = null; // No leader slots assigned yet
              }
            } else {
              v.skipRate = null; // No data available
            }
          });
        }
      } catch (e) {
        console.error('Error fetching all skip rates:', e);
      }
    }
    
    // Fetch historical skip rates for ALL validators in bulk (7 RPC calls instead of N*7)
    // Populates skipRateHistoryCache for every validator before leaderboard scoring
    async function fetchAllHistoricalSkipRatesBulk(numEpochs = 7) {
      try {
        const epochInfo = await rpcCall('getEpochInfo');
        const currentEpoch = epochInfo.epoch;
        const slotsPerEpoch = epochInfo.slotsInEpoch;
        const firstSlotOfCurrentEpoch = epochInfo.absoluteSlot - epochInfo.slotIndex;

        // Fetch all validators' block production for each past epoch in parallel
        const epochPromises = [];
        for (let i = 1; i <= numEpochs; i++) {
          const epochNum = currentEpoch - i;
          if (epochNum < 0) continue;
          const firstSlot = firstSlotOfCurrentEpoch - (i * slotsPerEpoch);
          const lastSlot = firstSlot + slotsPerEpoch - 1;

          epochPromises.push(
            fetch(RPC_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0', id: 1,
                method: 'getBlockProduction',
                params: [{ range: { firstSlot, lastSlot } }]
              })
            })
            .then(r => r.json())
            .then(data => ({
              epoch: epochNum,
              byIdentity: data.result?.value?.byIdentity || {}
            }))
            .catch(() => ({ epoch: epochNum, byIdentity: {} }))
          );
        }

        const epochResults = await Promise.all(epochPromises);

        // Now build skipRateHistoryCache for every validator
        allValidators.forEach(v => {
          const nodePubkey = v.nodePubkey;
          // Skip if already recently cached
          const existing = skipRateHistoryCache[nodePubkey];
          if (existing && existing.timestamp > Date.now() - 300000) return;

          const validResults = [];
          for (const { epoch, byIdentity } of epochResults) {
            const production = byIdentity[nodePubkey];
            if (production && production.length >= 2 && production[0] > 0) {
              const skipRate = ((production[0] - production[1]) / production[0]) * 100;
              validResults.push({ epoch, skipRate, leaderSlots: production[0], blocksProduced: production[1] });
            }
          }

          // Slot-weighted average across all valid epochs (matches fetchHistoricalSkipRates).
          // Treats one skipped slot equally regardless of which epoch it occurred in — prevents
          // a small-sample bad epoch from disproportionately lifting the displayed number.
          let avgSkipRate = null;
          let simpleAvgSkipRate = null;
          if (validResults.length > 0) {
            simpleAvgSkipRate = validResults.reduce((sum, r) => sum + r.skipRate, 0) / validResults.length;
            let totalLeader = 0, totalSkipped = 0;
            for (const r of validResults) {
              totalLeader  += r.leaderSlots;
              totalSkipped += (r.leaderSlots - r.blocksProduced);
            }
            avgSkipRate = totalLeader > 0 ? (totalSkipped / totalLeader) * 100 : simpleAvgSkipRate;
          }

          const lastEpochData = validResults.find(r => r.epoch === currentEpoch - 1);

          skipRateHistoryCache[nodePubkey] = {
            timestamp: Date.now(),
            data: {
              epochs: validResults,
              avgSkipRate,
              simpleAvgSkipRate,
              epochCount: validResults.length,
              requestedEpochs: numEpochs,
              lastEpochSkipRate: lastEpochData ? lastEpochData.skipRate : null,
              currentEpoch
            }
          };
        });

      } catch (e) {
        console.error('Error in bulk historical skip rate fetch:', e);
      }
    }

    // Fetch extended epoch credits for ALL validators in one batched RPC call
    // Returns { votePubkey: [[epoch, credits, prevCredits], ...], ... }
    async function fetchAllExtendedEpochCreditsBatch() {
      try {
        const batchSize = 100; // chunk to avoid RPC node limits
        const results = {};

        for (let i = 0; i < allValidators.length; i += batchSize) {
          const chunk = allValidators.slice(i, i + batchSize);
          const batchRequest = chunk.map((v, idx) => ({
            jsonrpc: '2.0',
            id: idx,
            method: 'getAccountInfo',
            params: [v.votePubkey, { encoding: 'jsonParsed' }]
          }));

          const response = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(batchRequest)
          });

          const batchData = await response.json();

          if (Array.isArray(batchData)) {
            batchData.forEach((res, idx) => {
              const validator = chunk[idx];
              try {
                const epochCredits = res?.result?.value?.data?.parsed?.info?.epochCredits;
                if (epochCredits && Array.isArray(epochCredits)) {
                  results[validator.votePubkey] = epochCredits.map(e => [e.epoch, e.credits, e.previousCredits]);
                }
              } catch (e) { /* skip malformed */ }
            });
          }
        }

        return results;
      } catch (e) {
        console.error('Error in batch epoch credits fetch:', e);
        return {};
      }
    }

    // Legacy (fallback formula) component labels — canonical components carry
    // their own `label` field, so this map is only needed for the old keys.
    const LEGACY_BREAKDOWN_LABELS = {
      voteEfficiency: 'Vote Efficiency',
      skipRate: 'Skip Rate',
      consistency: 'Consistency',
      commission: 'Commission',
      longevity: 'Longevity',
      softwareVersion: 'Software',
      reliability: 'Reliability'
    };

    // Generate performance tooltip HTML.
    // Renders whatever components the breakdown contains — works for both the
    // canonical v2 formula (vote latency, uptime, root distance, info rows)
    // and the legacy client-side fallback, so a formula change on the server
    // never requires touching this renderer again.
    function getPerformanceTooltipHtml(validator) {
      const breakdown = calculatePerformanceBreakdown(validator);

      let rows = '';
      for (const [key, comp] of Object.entries(breakdown)) {
        if (!comp || typeof comp !== 'object' || !('score' in comp)) continue; // skip totalScore/meta
        const label = comp.label || LEGACY_BREAKDOWN_LABELS[key] || key;
        if (comp.score === null || comp.weight === 0) {
          // Informational (unweighted) entry — e.g. commission, validator age
          rows += `
          <div class="perf-tooltip-row">
            <span class="perf-tooltip-label">${label} <span style="opacity:0.6;">(info)</span></span>
            <span class="perf-tooltip-value" style="opacity:0.6;">—</span>
          </div>
          <div class="perf-tooltip-detail">${comp.details}</div>`;
        } else {
          rows += `
          <div class="perf-tooltip-row">
            <span class="perf-tooltip-label">${label} (${Math.round(comp.weight * 100)}%)</span>
            <span class="perf-tooltip-value ${getScoreColorClass(comp.score)}">${comp.score.toFixed(1)}</span>
          </div>
          <div class="perf-tooltip-detail">${comp.details}</div>`;
        }
      }

      const flagRow = (breakdown.flags && breakdown.flags.includes('commission_rug'))
        ? `<div class="perf-tooltip-detail" style="color: var(--danger, #ff5c5c);">⚠ Commission raised sharply in the last 7 days — penalty applied</div>`
        : '';

      const sourceRow = breakdown.canonical
        ? `<div class="perf-tooltip-detail" style="margin-top: 0.4rem; opacity: 0.7;">Published score · updated ${new Date(breakdown.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · identical for all viewers</div>`
        : `<div class="perf-tooltip-detail" style="margin-top: 0.4rem; opacity: 0.7;">Computed locally (published scores unavailable)</div>`;

      return `
        <div class="perf-tooltip">
          <div class="perf-tooltip-title">Performance Breakdown${breakdown.canonical ? '' : ' (7-epoch)'}</div>
          ${rows}
          ${flagRow}
          <div class="perf-tooltip-total">
            <span>Total Score</span>
            <span class="${getScoreColorClass(breakdown.totalScore)}">${breakdown.totalScore.toFixed(2)}</span>
          </div>
          ${sourceRow}
        </div>
      `;
    }
    
    function getScoreColorClass(score) {
      if (score >= 90) return 'score-good';
      if (score >= 70) return 'score-warning';
      if (score >= 50) return 'score-orange';
      return 'score-bad';
    }

    function getPerformanceColor(score) {
      if (score >= 90) return 'success';
      if (score >= 70) return 'warning';
      if (score >= 50) return 'orange';
      return 'danger';
    }

    function getPerformanceBarColor(score) {
      if (score >= 90) return 'var(--success)';
      if (score >= 70) return 'var(--warning)';
      if (score >= 50) return '#ff9800';
      return 'var(--danger)';
    }

    function getSkipRateColor(rate) {
      if (rate === null || rate === 0) return 'success';
      if (rate <= 5) return 'success';
      if (rate <= 10) return 'warning';
      return 'danger';
    }

    function getSkipRateColorClass(rate) {
      if (rate === null || rate === undefined) return '';
      if (rate <= 2) return 'score-good';
      if (rate <= 5) return 'score-warning';
      if (rate <= 10) return 'score-orange';
      return 'score-bad';
    }

    function getCommissionColorClass(commission) {
      if (commission <= 5) return 'score-good';
      if (commission <= 10) return 'score-warning';
      if (commission <= 15) return 'score-orange';
      return 'score-bad';
    }

