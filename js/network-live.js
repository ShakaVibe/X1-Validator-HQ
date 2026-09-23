    // ==========================================
    // Network TPS Functions
    // ==========================================
    
    async function updateNetworkTps() {
      try {
        const samples = await rpcCall('getRecentPerformanceSamples', [1]);
        if (samples && samples.length > 0) {
          const sample = samples[0];
          // TPS = transactions / seconds
          const tps = sample.numTransactions / sample.samplePeriodSecs;
          document.getElementById('networkTps').textContent = formatCompact(Math.round(tps));
        }
      } catch (e) {
        console.error('Error fetching TPS:', e);
        document.getElementById('networkTps').textContent = '--';
      }
    }

    // ==========================================
    // Leader Schedule Functions
    // ==========================================
    
    let leaderScheduleCache = null;
    let leaderScheduleEpoch = null;

    // ───────────────────────────────────────────────────────────
    // LeaderCountdown — live "time to next leader slot" chips.
    //
    // Each validator card renders a <span class="vh-next-leader"
    // data-node="<nodePubkey>"> inside a .vh-leader-band. This module
    // updates every such chip once per second (and mirrors the state onto
    // the band so its colour follows):
    //   • upcoming  → "Next leader slot in ~3m"
    //   • leader    → "Leader now"                  (band turns green)
    //   • none      → "No upcoming leader slots"    (muted)
    //
    // It reads the shared leaderScheduleCache (nodePubkey -> [relative
    // slot indices within the current epoch]) and interpolates the
    // current epoch slot index between getEpochInfo syncs, so the
    // countdown ticks smoothly without an RPC every second. A sync is
    // only issued when at least one chip is on screen, so idle tabs
    // make no network calls.
    // ───────────────────────────────────────────────────────────
    const LeaderCountdown = (() => {
      const SLOT_MS = 420;     // X1 slot time — matches the Validator Terminal
      const SYNC_MS = 12000;   // re-sync epoch slot index / schedule
      let epochSlotIndex = null;  // slotIndex at last sync
      let slotsInEpoch   = null;
      let syncedAt       = 0;
      let syncing        = false;
      let started        = false;

      function estIndex() {
        if (epochSlotIndex === null) return null;
        const adv = Math.floor((Date.now() - syncedAt) / SLOT_MS);
        const idx = epochSlotIndex + adv;
        return slotsInEpoch ? Math.min(idx, slotsInEpoch - 1) : idx;
      }

      function fmt(ms) {
        const totalMin = Math.floor(Math.max(0, ms) / 60000);
        if (totalMin < 1) return '<1m';
        if (totalMin < 60) return `~${totalMin}m`;
        const h = Math.floor(totalMin / 60), rm = totalMin % 60;
        return rm > 0 ? `~${h}h ${rm}m` : `~${h}h`;
      }

      async function sync() {
        if (syncing) return;
        if (!document.querySelector('.vh-next-leader')) return; // no chips → no RPC
        if (!PowerSaver.gate('leader.countdown')) return;
        syncing = true;
        try {
          const info = await rpcCall('getEpochInfo');
          epochSlotIndex = info.slotIndex;
          slotsInEpoch   = info.slotsInEpoch;
          currentSlotsInEpoch = info.slotsInEpoch;
          syncedAt       = Date.now();
          if (leaderScheduleEpoch !== info.epoch || !leaderScheduleCache) {
            const sched = await rpcCall('getLeaderSchedule');
            if (sched) { leaderScheduleCache = sched; leaderScheduleEpoch = info.epoch; }
          }
        } catch (e) {
          // keep last-known values; interpolation continues
        } finally {
          syncing = false;
        }
      }

      function tick() {
        const chips = document.querySelectorAll('.vh-next-leader');
        if (chips.length === 0) return;
        // Lazily (re)sync when chips appear or our snapshot is stale.
        if (epochSlotIndex === null || Date.now() - syncedAt > SYNC_MS) sync();

        const idx = estIndex();
        // Write the chip text, mirror the state onto the enclosing band
        // (.vh-leader-band → amber / green / muted) and fill the note.
        const setChip = (chip, text, state, note) => {
          if (chip.textContent !== text) chip.textContent = text;
          chip.classList.toggle('is-leader', state === 'leader');
          chip.classList.toggle('is-none', state === 'none');
          const band = chip.parentElement;
          if (band && band.classList.contains('vh-leader-band')) {
            band.classList.toggle('is-leader', state === 'leader');
            band.classList.toggle('is-none', state === 'none');
            const noteEl = band.querySelector('.vh-band-note');
            if (noteEl && noteEl.textContent !== note) noteEl.textContent = note;
          }
        };
        chips.forEach(chip => {
          const node = chip.dataset.node;
          if (idx === null || !leaderScheduleCache || !node) {
            setChip(chip, '…', '', '');
            return;
          }
          const slots = leaderScheduleCache[node];
          const epochNote = (slots && slots.length ? slots.length + ' leader slot' + (slots.length === 1 ? '' : 's') + ' this epoch' : 'no leader slots this epoch') +
                            (currentEpochNumber ? ' · epoch ' + currentEpochNumber : '');
          if (!slots || slots.length === 0) {
            setChip(chip, 'No upcoming leader slots', 'none', epochNote);
            return;
          }
          // Leader for the current slot?
          if (slots.indexOf(idx) !== -1) {
            setChip(chip, 'Leader now', 'leader', epochNote);
            return;
          }
          // Smallest upcoming slot index (schedule isn't guaranteed sorted).
          let next = Infinity;
          for (let i = 0; i < slots.length; i++) {
            const s = slots[i];
            if (s > idx && s < next) next = s;
          }
          if (next === Infinity) {
            setChip(chip, 'No more leader slots this epoch', 'none', epochNote);
          } else {
            setChip(chip, 'Next leader slot in ' + fmt((next - idx) * SLOT_MS), '', epochNote);
          }
        });
      }

      function start() {
        if (started) return;
        started = true;
        sync();
        tick();
        setInterval(tick, 1000);
        setInterval(sync, SYNC_MS);
      }

      return { start, sync, tick };
    })();
    
    async function loadLeaderSchedule() {
      try {
        // Get current epoch info
        const epochInfo = await rpcCall('getEpochInfo');
        
        // Only reload schedule if epoch changed
        if (leaderScheduleEpoch === epochInfo.epoch && leaderScheduleCache) {
          updateCurrentLeader();
          return;
        }
        
        // Fetch leader schedule for current epoch
        const schedule = await rpcCall('getLeaderSchedule');
        
        if (schedule) {
          leaderScheduleCache = schedule;
          leaderScheduleEpoch = epochInfo.epoch;
          updateCurrentLeader();
        }
      } catch (e) {
        console.error('Error loading leader schedule:', e);
        document.getElementById('currentLeaderName').textContent = 'Unable to load';
      }
    }
    
    // Shared html-escape helper. SkipMonitor has its own `esc` but it's
    // scoped inside the IIFE; renderEpochTimeline lives at top level.
    function _escHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
      ));
    }

    // ───────────────────────────────────────────────────────────
    // Epoch timeline strip — network-wide skip rate for the last N
    // completed epochs plus the current (partial) epoch. Lazy-loaded
    // once per session (staggered 20s after SkipMonitor.start) and
    // cached until the current epoch advances.
    // ───────────────────────────────────────────────────────────
    const EPOCH_TIMELINE_COUNT = 4; // past completed epochs to fetch (plus current)
    const networkEpochHistory = {
      data: null,            // array of {epoch, skipRate, leaderSlots, blocksProduced, partial?}
      fetchedAtEpoch: null,  // current epoch at the time of the fetch — invalidates on advance
      fetching: false        // guard against overlapping loads
    };

    // Network-wide variant of fetchSkipRateForSlotRange. Returns totals
    // aggregated across ALL identities instead of filtering to one.
    async function fetchNetworkSkipRateForSlotRange(firstSlot, lastSlot) {
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBlockProduction',
            params: [{ range: { firstSlot, lastSlot } }]
          })
        });
        const data = await response.json();
        const byIdentity = data && data.result && data.result.value && data.result.value.byIdentity;
        if (!byIdentity) return null;
        let leaderSlots = 0, blocksProduced = 0;
        for (const pair of Object.values(byIdentity)) {
          if (Array.isArray(pair) && pair.length >= 2) {
            leaderSlots    += pair[0] || 0;
            blocksProduced += pair[1] || 0;
          }
        }
        if (leaderSlots <= 0) return null;
        return {
          skipRate: ((leaderSlots - blocksProduced) / leaderSlots) * 100,
          leaderSlots,
          blocksProduced
        };
      } catch (e) {
        return null;
      }
    }

    async function loadNetworkEpochHistory(numEpochs) {
      numEpochs = numEpochs || EPOCH_TIMELINE_COUNT;
      if (networkEpochHistory.fetching) return networkEpochHistory.data;
      try {
        const epochInfo = await rpcCall('getEpochInfo');
        const currentEpoch = epochInfo.epoch;

        // Cache hit for this epoch — skip the RPC fan-out entirely.
        if (networkEpochHistory.data && networkEpochHistory.fetchedAtEpoch === currentEpoch) {
          return networkEpochHistory.data;
        }
        networkEpochHistory.fetching = true;

        const slotsPerEpoch      = epochInfo.slotsInEpoch;
        const currentSlot        = epochInfo.absoluteSlot;
        const slotIndex          = epochInfo.slotIndex;
        const firstSlotOfCurrent = currentSlot - slotIndex;

        const promises = [];
        for (let i = 1; i <= numEpochs; i++) {
          const epochNum = currentEpoch - i;
          if (epochNum < 0) continue;
          const epochFirst = firstSlotOfCurrent - (i * slotsPerEpoch);
          const epochLast  = epochFirst + slotsPerEpoch - 1;
          promises.push(
            fetchNetworkSkipRateForSlotRange(epochFirst, epochLast)
              .then(r => r ? ({ epoch: epochNum, ...r }) : ({ epoch: epochNum, skipRate: null }))
          );
        }
        // Current partial epoch — from epoch-start up to the current head.
        promises.push(
          fetchNetworkSkipRateForSlotRange(firstSlotOfCurrent, currentSlot)
            .then(r => r
              ? ({ epoch: currentEpoch, partial: true, ...r })
              : ({ epoch: currentEpoch, partial: true, skipRate: null }))
        );

        const results = await Promise.all(promises);
        results.sort((a, b) => a.epoch - b.epoch);

        networkEpochHistory.data = results;
        networkEpochHistory.fetchedAtEpoch = currentEpoch;
        networkEpochHistory.fetching = false;
        return results;
      } catch (e) {
        networkEpochHistory.fetching = false;
        console.warn('[EpochTimeline] load error:', e && e.message || e);
        return null;
      }
    }

    async function renderEpochTimeline() {
      const barsEl = document.getElementById('epochTimelineBars');
      if (!barsEl) return;

      const data = await loadNetworkEpochHistory();
      if (!data || !data.length) {
        barsEl.innerHTML = '<div class="epoch-timeline-empty">No epoch history available</div>';
        return;
      }

      // Curated palette — three discrete color stops instead of a raw hue sweep.
      //   0–2%   → teal/cyan (clean)
      //   2–6%   → amber    (watch)
      //   6%+    → coral    (concerning)
      // Each stop provides a gradient top (brighter) and bottom (dimmer), plus
      // a glow color for the bar's drop-shadow.
      function colorStopsFor(rate) {
        if (typeof rate !== 'number') {
          return {
            top:  'rgba(140, 150, 170, 0.55)',
            bot:  'rgba(140, 150, 170, 0.25)',
            glow: 'rgba(140, 150, 170, 0.08)'
          };
        }
        if (rate < 2) return {
          top:  'rgba(64, 230, 190, 0.95)',
          bot:  'rgba(32, 180, 150, 0.45)',
          glow: 'rgba(64, 230, 170, 0.28)'
        };
        if (rate < 6) return {
          top:  'rgba(255, 205, 110, 0.95)',
          bot:  'rgba(230, 160, 60,  0.45)',
          glow: 'rgba(255, 190, 70,  0.26)'
        };
        return {
          top:  'rgba(255, 130, 120, 0.95)',
          bot:  'rgba(220, 80,  72,  0.45)',
          glow: 'rgba(255, 100, 80,  0.32)'
        };
      }

      const pieces = data.map(d => {
        const r = d.skipRate;
        const hasData  = typeof r === 'number';
        const isPartial = !!d.partial;
        // Height scaling: 0..8% skip → 15..100% of the column.
        // Above 8% pegs at 100%. Clean epochs still show a visible sliver.
        const heightPct = hasData
          ? Math.min(100, Math.max(15, (r / 8) * 100))
          : 12;
        const c = colorStopsFor(hasData ? r : null);
        const rateStr = hasData ? `${r.toFixed(2)}%` : '—';
        const rateCls = hasData ? '' : 'empty';
        const partialTag = isPartial ? `<span class="epoch-timeline-partial">Live</span>` : '';
        const wrapCls = isPartial ? 'epoch-timeline-bar-wrap is-current' : 'epoch-timeline-bar-wrap';
        const title = hasData
          ? `Epoch ${d.epoch}${isPartial ? ' (in progress)' : ''} · ${rateStr} skip · ${(d.blocksProduced||0).toLocaleString()} produced / ${(d.leaderSlots||0).toLocaleString()} assigned`
          : `Epoch ${d.epoch} — data unavailable`;
        return `<div class="${wrapCls}" title="${_escHtml(title)}">`
             +   `<div class="epoch-timeline-rate ${rateCls}">${rateStr}</div>`
             +   `<div class="epoch-timeline-col">`
             +     `<div class="epoch-timeline-fill" style="`
             +       `height:${heightPct.toFixed(1)}%;`
             +       `--bar-top:${c.top};--bar-bot:${c.bot};--bar-glow:${c.glow}`
             +     `"></div>`
             +   `</div>`
             +   `<div class="epoch-timeline-num">${d.epoch}${partialTag}</div>`
             + `</div>`;
      });
      barsEl.innerHTML = pieces.join('');

      // Summary row — rolling averages and totals across the completed epochs
      // in the returned set. Excludes the current (partial) epoch so the
      // average isn't skewed by whatever early slice we happened to sample.
      // Rendered as a 3x2 grid of screenshot-quality cards to match the TPS
      // modal's treatment.
      const summaryEl = document.getElementById('epochTimelineSummary');
      if (summaryEl) {
        const completed = data.filter(d => !d.partial && typeof d.skipRate === 'number');
        if (!completed.length) {
          summaryEl.innerHTML = '';
        } else {
          let leaderSlots = 0, skippedSlots = 0;
          let best = completed[0], worst = completed[0];
          for (const d of completed) {
            leaderSlots  += d.leaderSlots || 0;
            skippedSlots += (d.leaderSlots || 0) - (d.blocksProduced || 0);
            if (d.skipRate < best.skipRate)  best  = d;
            if (d.skipRate > worst.skipRate) worst = d;
          }
          const rollingAvg = leaderSlots > 0
            ? (skippedSlots / leaderSlots) * 100
            : null;
          const avgCls = rollingAvg == null ? ''
            : (rollingAvg < 2 ? 'good'
             : rollingAvg < 6 ? 'warn'
             : 'bad');
          const avgStr = rollingAvg == null ? '—' : `${rollingAvg.toFixed(2)}%`;
          // Network uptime = (1 - skipRate). 99.xx% is the screenshot-worthy
          // framing — skip rate says "how bad", uptime says "how good".
          const uptime = rollingAvg == null ? null : (100 - rollingAvg);
          const uptimeStr = uptime == null ? '—' : `${uptime.toFixed(2)}%`;
          const uptimeCls = uptime == null ? ''
            : (uptime >= 98 ? 'good'
             : uptime >= 94 ? 'warn'
             : 'bad');

          const card = (label, value, sub, valueCls) =>
              `<div class="epoch-timeline-summary-item">`
            +   `<div class="epoch-timeline-summary-label">${label}</div>`
            +   `<div class="epoch-timeline-summary-value${valueCls ? ' ' + valueCls : ''}">${value}</div>`
            +   (sub ? `<div class="epoch-timeline-summary-sub">${sub}</div>` : '')
            + `</div>`;

          summaryEl.innerHTML =
              card('Rolling Avg',   avgStr,    `${completed.length} completed epochs`, avgCls)
            + card('Network Uptime', uptimeStr, '100 − skip rate',                      uptimeCls)
            + card('Best Epoch',    `${best.skipRate.toFixed(2)}%`,  `epoch ${best.epoch}`,  'good')
            + card('Worst Epoch',   `${worst.skipRate.toFixed(2)}%`, `epoch ${worst.epoch}`, 'bad')
            + card('Total Skipped', skippedSlots.toLocaleString(),   'across window')
            + card('Total Assigned', leaderSlots.toLocaleString(),   'leader slots');
        }
      }
    }

    // ───────────────────────────────────────────────────────────
    // TPS strip — compact sparkline of network throughput from
    // getRecentPerformanceSamples. One RPC per refresh (cheap); we
    // fetch the RPC's maximum (720 samples = 12 hours at 60s each) so
    // the expanded modal has real history to show, while the inline
    // strip trims to the last 60 samples for its "past 60 min" scope.
    // ───────────────────────────────────────────────────────────
    const TPS_SAMPLES = 720;          // 12 hours at 60s/sample — the RPC max
    const TPS_STRIP_WINDOW = 60;      // last 60 samples drive the inline strip
    let tpsSamplesCache = [];         // oldest-first, each = TPS number
    let tpsSlotDataCache = [];        // oldest-first parallel array; each = {endSlot, slotCount}
                                       // Used by the modal tooltip's "Show first/last tx"
                                       // feature to derive bucket slot ranges.
    let tpsFetching = false;

    async function loadTpsSamples() {
      if (tpsFetching) return;
      if (!PowerSaver.gate('tps', 5 * 60 * 1000)) return;
      tpsFetching = true;
      try {
        // Off the Network tab only the top-bar number is visible: poll one
        // sample (~100 B) instead of 720 (~60 KB). Opening the tab triggers a
        // full load (SkipMonitor.start → loadTpsSamples).
        const wantFull = document.body.classList.contains('active-skipmonitor') || !tpsSamplesCache || !tpsSamplesCache.length;
        if (!wantFull) {
          const one = await rpcCall('getRecentPerformanceSamples', [1]);
          const s0 = Array.isArray(one) && one[0];
          if (s0 && s0.samplePeriodSecs > 0) {
            const latest = s0.numTransactions / s0.samplePeriodSecs;
            const topEl = document.getElementById('networkTps');
            if (topEl) topEl.textContent = (typeof formatCompact === 'function') ? formatCompact(Math.round(latest)) : Math.round(latest).toLocaleString();
          }
          return;
        }
        // Always fetch the full 720 samples (12h) on every poll. This
        // ensures the 12-hour view always reflects the RPC's current
        // authoritative state, so any client querying at the same moment
        // sees the same numbers (matches X1Prism's behavior).
        //
        // The previous incremental pattern (one full backfill, then count=1
        // appends) saved bandwidth but produced session-dependent history:
        // each tab's cache became a rolling tape recording specific to when
        // that tab was opened, which drifted from the RPC's current view as
        // the node's rolling sample buffer rotated. ~20 KB/min is fine.
        const raw = await rpcCall('getRecentPerformanceSamples', [TPS_SAMPLES]);
        if (!Array.isArray(raw) || !raw.length) return;
        const reversed = raw.slice().reverse();
        const tps = reversed.map(s => (s && s.samplePeriodSecs > 0)
          ? (s.numTransactions / s.samplePeriodSecs)
          : 0);
        tpsSamplesCache = tps;
        // Parallel slot data — same indexing as tpsSamplesCache.
        // .slot is the LAST slot of the sample window; .numSlots is window length.
        tpsSlotDataCache = reversed.map(s => ({
          endSlot:   (s && typeof s.slot === 'number') ? s.slot : null,
          slotCount: (s && typeof s.numSlots === 'number') ? s.numSlots : 0,
        }));

        // Drive the shared top-of-page TPS readout from the same cache
        // (replaces the old dedicated updateNetworkTps poll).
        const latest = tpsSamplesCache[tpsSamplesCache.length - 1];
        const topEl = document.getElementById('networkTps');
        if (topEl && typeof latest === 'number') {
          topEl.textContent = (typeof formatCompact === 'function')
            ? formatCompact(Math.round(latest))
            : Math.round(latest).toLocaleString();
        }

        renderTpsStrip();
      } catch (e) {
        console.warn('[TPS] load error:', e && e.message || e);
      } finally {
        tpsFetching = false;
      }
    }

    function _tpsFmt(n) {
      if (!isFinite(n)) return '—';
      if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
      if (n >= 1000)  return (n / 1000).toFixed(2) + 'k';
      return Math.round(n).toLocaleString();
    }

    function renderTpsStrip() {
      const valueEl = document.getElementById('tpsStripValue');
      const trendEl = document.getElementById('tpsStripTrend');
      const avgEl   = document.getElementById('tpsStripAvg');
      const peakEl  = document.getElementById('tpsStripPeak');
      const chartEl = document.getElementById('tpsStripChart');
      if (!valueEl || !chartEl) return;

      // Strip shows only the trailing hour even though the cache holds 12h.
      const all = tpsSamplesCache;
      const series = (all && all.length > TPS_STRIP_WINDOW)
        ? all.slice(-TPS_STRIP_WINDOW)
        : (all || []);
      if (!series || series.length < 2) {
        valueEl.textContent = '—';
        if (trendEl) trendEl.textContent = '';
        if (avgEl)   avgEl.textContent   = '—';
        if (peakEl)  peakEl.textContent  = '—';
        chartEl.innerHTML = '<div class="tps-strip-empty">Warming up…</div>';
        return;
      }

      const current = series[series.length - 1];
      const prev    = series[series.length - 2];
      const avg     = series.reduce((a, b) => a + b, 0) / series.length;
      const peak    = Math.max.apply(null, series);

      valueEl.textContent = _tpsFmt(current);
      if (avgEl)  avgEl.textContent  = _tpsFmt(avg);
      if (peakEl) peakEl.textContent = _tpsFmt(peak);

      if (trendEl) {
        if (avg > 0) {
          const deltaPct = ((current - avg) / avg) * 100;
          if (Math.abs(deltaPct) < 1) {
            trendEl.textContent = '→ near avg';
            trendEl.className = 'tps-strip-trend';
          } else if (deltaPct > 0) {
            trendEl.textContent = `↗ ${deltaPct.toFixed(0)}% vs avg`;
            trendEl.className = 'tps-strip-trend up';
          } else {
            trendEl.textContent = `↘ ${Math.abs(deltaPct).toFixed(0)}% vs avg`;
            trendEl.className = 'tps-strip-trend down';
          }
        } else {
          trendEl.textContent = '';
        }
      }

      // Build the sparkline SVG. We use a fixed viewBox and stretch it with
      // preserveAspectRatio="none" so the chart fills whatever width the
      // flex container gives us without re-measuring.
      const W = 100, H = 40;
      const min = 0; // anchor at zero so the fill reads as absolute magnitude
      const max = Math.max(peak, 1);
      const range = max - min || 1;
      const step = W / (series.length - 1);
      let stroke = '';
      for (let i = 0; i < series.length; i++) {
        const x = (i * step).toFixed(2);
        const y = (H - ((series[i] - min) / range) * H).toFixed(2);
        stroke += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
      }
      const area = stroke + `L${W},${H} L0,${H} Z`;
      chartEl.innerHTML =
          `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="tps-spark-svg">`
        +   `<defs>`
        +     `<linearGradient id="tpsGrad" x1="0" x2="0" y1="0" y2="1">`
        +       `<stop offset="0" stop-color="#00d4ff" stop-opacity="0.45"/>`
        +       `<stop offset="1" stop-color="#00d4ff" stop-opacity="0"/>`
        +     `</linearGradient>`
        +   `</defs>`
        +   `<path d="${area}" fill="url(#tpsGrad)"/>`
        +   `<path d="${stroke.trim()}" fill="none" stroke="#00d4ff" stroke-width="1.25" `
        +         `stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`
        + `</svg>`;

      // If the expanded modal is currently open, keep it live too.
      const tpsModal = document.getElementById('tpsModal');
      if (tpsModal && tpsModal.style.display === 'flex' && typeof renderTpsModal === 'function') {
        renderTpsModal();
      }
    }

    async function updateCurrentLeader() {
      if (!leaderScheduleCache) {
        await loadLeaderSchedule();
        return;
      }
      
      try {
        const epochInfo = await rpcCall('getEpochInfo');
        const currentSlotInEpoch = epochInfo.slotIndex;
        
        // Reload schedule if epoch changed
        if (leaderScheduleEpoch !== epochInfo.epoch) {
          await loadLeaderSchedule();
          return;
        }
        
        // Build slot -> leader map
        const slotToLeader = {};
        for (const [leader, slots] of Object.entries(leaderScheduleCache)) {
          for (const slot of slots) {
            slotToLeader[slot] = leader;
          }
        }
        
        // Find current leader (the one for current slot in epoch)
        const currentLeader = slotToLeader[currentSlotInEpoch];
        
        // Find next unique leaders
        const nextLeaders = [];
        const seenLeaders = new Set();
        if (currentLeader) seenLeaders.add(currentLeader);
        
        for (let i = currentSlotInEpoch + 1; i < epochInfo.slotsInEpoch && nextLeaders.length < 10; i++) {
          const leader = slotToLeader[i];
          if (leader && !seenLeaders.has(leader)) {
            seenLeaders.add(leader);
            nextLeaders.push(leader);
          }
        }
        
        // Get validator info for leaders
        const currentLeaderInfo = currentLeader ? getValidatorByNodePubkey(currentLeader) : null;
        
        // Calculate which block of 4 the leader is producing
        let blockOfFour = 1;
        if (currentLeader && leaderScheduleCache[currentLeader]) {
          const leaderSlots = leaderScheduleCache[currentLeader].sort((a, b) => a - b);
          // Find current slot's position in leader's consecutive slots
          for (let i = 0; i < leaderSlots.length; i++) {
            if (leaderSlots[i] === currentSlotInEpoch) {
              // Check if this is part of a consecutive group
              let groupStart = i;
              while (groupStart > 0 && leaderSlots[groupStart - 1] === leaderSlots[groupStart] - 1) {
                groupStart--;
              }
              blockOfFour = (i - groupStart) + 1;
              break;
            }
          }
        }
        
        // Update current leader display
        const currentSlot = epochInfo.absoluteSlot || (epochInfo.epoch * epochInfo.slotsInEpoch + currentSlotInEpoch);
        document.getElementById('currentLeaderSlot').textContent = formatCompact(currentSlot);
        document.getElementById('currentLeaderBlock').textContent = `Block ${blockOfFour} of 4`;

        // Paint the 4 block dots with real produced/skipped state.
        //   Past dots  → produced (green) / skipped (red) / unknown (dim) if SkipMonitor hasn't cached yet
        //   Current    → pulsing cyan
        //   Pending    → hollow
        // The block's absolute slot range is [currentSlot - (blockOfFour-1) .. +4].
        const dotsEl = document.querySelector('#currentLeaderCard .slot-dots');
        if (dotsEl) {
          const blockStartAbs = currentSlot - (blockOfFour - 1);
          const smReady = (typeof SkipMonitor !== 'undefined' && SkipMonitor.getSlotStatus);
          let html = '';
          for (let i = 0; i < 4; i++) {
            const pos = i + 1; // 1..4
            const slotAbs = blockStartAbs + i;
            let cls;
            let title;
            if (pos < blockOfFour) {
              // Past slot in this block — look up status
              const status = smReady ? SkipMonitor.getSlotStatus(slotAbs) : null;
              if (status === 'produced')      { cls = 'produced';  title = `Slot ${slotAbs} · Produced`; }
              else if (status === 'skipped')  { cls = 'skipped';   title = `Slot ${slotAbs} · Skipped`; }
              else                            { cls = 'unknown';   title = `Slot ${slotAbs} · Awaiting confirmation`; }
            } else if (pos === blockOfFour) {
              cls = 'current'; title = `Slot ${slotAbs} · Landing now`;
            } else {
              cls = 'pending'; title = `Slot ${slotAbs} · Pending`;
            }
            html += `<div class="slot-dot ${cls}" title="${title}"></div>`;
          }
          dotsEl.innerHTML = html;
        }
        
        if (currentLeaderInfo) {
          document.getElementById('currentLeaderName').textContent = currentLeaderInfo.name;
          // Show vote account
          const voteAccount = currentLeaderInfo.votePubkey;
          if (voteAccount) {
            document.getElementById('currentLeaderVote').textContent = shortenAddress(voteAccount);
            document.getElementById('currentLeaderVote').title = voteAccount;
            // Make card clickable
            const card = document.getElementById('currentLeaderCard');
            card.onclick = () => lookupValidator(voteAccount);
            card.title = `View ${currentLeaderInfo.name} in Validator Lookup`;
          }
          const logoEl = document.getElementById('currentLeaderLogo');
          if (currentLeaderInfo.iconUrl) {
            logoEl.innerHTML = `<img src="${safeUrl(currentLeaderInfo.iconUrl)}" alt="${escHtml(currentLeaderInfo.name.charAt(0))}" data-onerror="img-fallback-text" data-fallback="${escHtml(currentLeaderInfo.name.charAt(0).toUpperCase())}">`;
          } else {
            logoEl.textContent = currentLeaderInfo.name.charAt(0).toUpperCase();
          }
        } else if (currentLeader) {
          document.getElementById('currentLeaderName').textContent = shortenAddress(currentLeader);
          document.getElementById('currentLeaderVote').textContent = '';
          document.getElementById('currentLeaderLogo').textContent = '?';
          // No vote pubkey available, disable click
          const card = document.getElementById('currentLeaderCard');
          card.onclick = null;
          card.title = '';
        } else {
          document.getElementById('currentLeaderName').textContent = 'Unknown';
          document.getElementById('currentLeaderVote').textContent = '';
          document.getElementById('currentLeaderLogo').textContent = '?';
          const card = document.getElementById('currentLeaderCard');
          card.onclick = null;
          card.title = '';
        }
        
        // Update next leaders display
        const nextListEl = document.getElementById('nextLeadersList');
        if (nextLeaders.length > 0) {
          nextListEl.innerHTML = nextLeaders.map(leader => {
            const info = getValidatorByNodePubkey(leader);
            const fullName = info ? info.name : shortenAddress(leader);
            // Abbreviate name to max 8 chars
            const name = fullName.length > 8 ? fullName.slice(0, 7) + '…' : fullName;
            const initial = fullName.charAt(0).toUpperCase();
            let logoHtml;
            if (info && info.iconUrl) {
              logoHtml = `<div class="leader-next-logo"><img src="${safeUrl(info.iconUrl)}" alt="${escHtml(initial)}" data-onerror="img-fallback-text" data-fallback="${escHtml(initial)}"></div>`;
            } else {
              logoHtml = `<div class="leader-next-logo">${escHtml(initial)}</div>`;
            }
            const isClickable = info && info.votePubkey;
            const clickAttr = isClickable ? `data-action="leader-lookup" data-vote="${escHtml(info.votePubkey)}"` : '';
            const clickClass = isClickable ? ' clickable' : '';
            const titleAttr = isClickable ? `title="View ${escHtml(fullName)} in Validator Lookup"` : `title="${escHtml(fullName)}"`;
            return `
              <div class="leader-next-item${clickClass}" ${clickAttr} ${titleAttr}>
                ${logoHtml}
                <span class="leader-next-name">${escHtml(name)}</span>
              </div>
            `;
          }).join('');
        } else {
          nextListEl.innerHTML = '<div class="leader-next-item">No upcoming leaders found</div>';
        }
        
      } catch (e) {
        console.error('Error updating current leader:', e);
      }
    }
    
    function getValidatorByNodePubkey(nodePubkey) {
      if (!allValidators || allValidators.length === 0) return null;
      return allValidators.find(v => v.nodePubkey === nodePubkey) || null;
    }

    // Disclaimer Modal Functions
    const DISCLAIMER_VERSION = '1.0';
    const DISCLAIMER_STORAGE_KEY = 'x1_validator_hq_disclaimer_accepted';

    function checkDisclaimerAccepted() {
      const accepted = localStorage.getItem(DISCLAIMER_STORAGE_KEY);
      if (accepted) {
        try {
          const data = JSON.parse(accepted);
          // Check if the accepted version matches current version
          if (data.version === DISCLAIMER_VERSION) {
            return true;
          }
        } catch (e) {
          // Invalid data, show disclaimer again
        }
      }
      return false;
    }

    function showDisclaimerModal() {
      document.getElementById('disclaimerModal').classList.add('show');
      document.body.style.overflow = 'hidden';
    }

    function hideDisclaimerModal() {
      document.getElementById('disclaimerModal').classList.remove('show');
      document.body.style.overflow = '';
    }

    function toggleDisclaimerCheckbox() {
      const checkbox = document.getElementById('disclaimerCheckbox');
      checkbox.checked = !checkbox.checked;
      updateDisclaimerButton();
    }

    function updateDisclaimerButton() {
      const checkbox = document.getElementById('disclaimerCheckbox');
      const btn = document.getElementById('disclaimerAcceptBtn');
      btn.disabled = !checkbox.checked;
    }

    function acceptDisclaimer() {
      const checkbox = document.getElementById('disclaimerCheckbox');
      if (!checkbox.checked) return;

      // Store acceptance with version and timestamp
      const acceptanceData = {
        version: DISCLAIMER_VERSION,
        acceptedAt: new Date().toISOString(),
        userAgent: navigator.userAgent
      };
      localStorage.setItem(DISCLAIMER_STORAGE_KEY, JSON.stringify(acceptanceData));
      
      hideDisclaimerModal();
    }

    // Check disclaimer on page load
    document.addEventListener('DOMContentLoaded', function() {
      if (!checkDisclaimerAccepted()) {
        showDisclaimerModal();
      }
    });

    // Network Toggle Functions
    let currentNetwork = 'x1';

    function toggleNetwork() {
      const toggle = document.getElementById('networkToggle');
      const x1Label = document.getElementById('x1Label');
      const solanaLabel = document.getElementById('solanaLabel');
      
      if (currentNetwork === 'x1') {
        // Switch to Solana (show coming soon)
        toggle.classList.add('solana-active');
        x1Label.classList.add('inactive');
        x1Label.classList.remove('x1');
        solanaLabel.classList.remove('inactive');
        solanaLabel.classList.add('solana');
        currentNetwork = 'solana';
        
        // Show coming soon modal
        document.getElementById('solanaModal').classList.add('show');
      } else {
        // Switch back to X1
        toggle.classList.remove('solana-active');
        x1Label.classList.remove('inactive');
        x1Label.classList.add('x1');
        solanaLabel.classList.add('inactive');
        solanaLabel.classList.remove('solana');
        currentNetwork = 'x1';
      }
    }

    function closeSolanaModal() {
      document.getElementById('solanaModal').classList.remove('show');
      
      // Reset toggle back to X1
      const toggle = document.getElementById('networkToggle');
      const x1Label = document.getElementById('x1Label');
      const solanaLabel = document.getElementById('solanaLabel');
      
      toggle.classList.remove('solana-active');
      x1Label.classList.remove('inactive');
      x1Label.classList.add('x1');
      solanaLabel.classList.add('inactive');
      solanaLabel.classList.remove('solana');
      currentNetwork = 'x1';
    }

    // Close modal on overlay click
    document.addEventListener('DOMContentLoaded', function() {
      const solanaModal = document.getElementById('solanaModal');
      if (solanaModal) {
        solanaModal.addEventListener('click', function(e) {
          if (e.target === this) {
            closeSolanaModal();
          }
        });
      }
    });

    // ─────────────────────────────────────────────────────────────────────
    // EPOCH PROGRESS BAR — live updater
    //
    // The epoch bar (#epochProgress) shows up on every tab and used to only
    // refresh when loadNetworkStats() ran, which meant a tab left open went
    // stale (frozen percent, lying time-remaining). This block makes the bar
    // truly live by combining three things:
    //
    //   1. Local 1-second tick that advances the bar based on the chain's
    //      ~400ms slot duration relative to the last known baseline. Free —
    //      no RPC calls — so it can run forever without burning the public
    //      endpoint.
    //   2. Background re-sync of getEpochInfo every 90s to correct any drift
    //      and pick up the next epoch when the chain rolls over.
    //   3. Immediate re-sync on tab visibilitychange, so a user who alt-tabs
    //      back after an hour sees correct values right away instead of
    //      whatever the local prediction drifted to.
    //
    // Single source of truth: setEpochBaseline() is called by loadNetworkStats
    // (initial + manual refreshes) and by the periodic / visibility re-syncs.
    // The renderer reads the baseline and projects forward.
    // ─────────────────────────────────────────────────────────────────────
    let _epochBaseline = null;  // { epoch, slotIndex, slotsInEpoch, fetchedAt }
    const _EPOCH_SLOT_MS = 400;            // X1/Solana target slot time
    const _EPOCH_RESYNC_MS = 90 * 1000;    // background re-sync cadence

    function setEpochBaseline(epochInfo) {
      const prevEpoch = _epochBaseline?.epoch;
      _epochBaseline = {
        epoch: epochInfo.epoch,
        slotIndex: epochInfo.slotIndex,
        slotsInEpoch: epochInfo.slotsInEpoch,
        fetchedAt: Date.now(),
      };
      renderEpochBar();

      // If the epoch number actually changed (rolled over), kick a full
      // network refresh so credits, leader schedule, validator list etc.
      // all pick up fresh data. Don't await — let it run in the background.
      if (prevEpoch !== undefined && prevEpoch !== epochInfo.epoch) {
        loadNetworkStats().catch(err =>
          console.error('Epoch rollover refresh failed:', err)
        );
      }
    }

    function renderEpochBar() {
      if (!_epochBaseline) return;
      if (document.hidden) return;
      const fill = document.getElementById('epochProgressFill');
      const pctEl = document.getElementById('epochPercent');
      const timeEl = document.getElementById('epochTimeRemaining');
      if (!fill || !pctEl || !timeEl) return;

      const elapsedMs = Date.now() - _epochBaseline.fetchedAt;
      const slotsAdvanced = elapsedMs / _EPOCH_SLOT_MS;
      const predictedIdx = Math.min(
        _epochBaseline.slotIndex + slotsAdvanced,
        _epochBaseline.slotsInEpoch
      );
      const pct = (predictedIdx / _epochBaseline.slotsInEpoch) * 100;
      const remainingSlots = Math.max(0, _epochBaseline.slotsInEpoch - predictedIdx);
      const secondsRemaining = remainingSlots * (_EPOCH_SLOT_MS / 1000);
      const hours = Math.floor(secondsRemaining / 3600);
      const minutes = Math.floor((secondsRemaining % 3600) / 60);
      const timeString = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

      fill.style.width = pct + '%';
      pctEl.textContent = pct.toFixed(1) + '%';
      timeEl.textContent = timeString;

      // Keep this exposed for the credit-pace tooltip and other consumers
      window.epochProgressRatio = predictedIdx / _epochBaseline.slotsInEpoch;

      // If the local prediction has crossed the end of the epoch, force a
      // real re-sync — the chain has rolled over (or we drifted past it).
      // Guard with a flag so we don't spam during the gap between predicted
      // rollover and the resync resolving.
      if (predictedIdx >= _epochBaseline.slotsInEpoch && !_epochBaseline._resyncing) {
        _epochBaseline._resyncing = true;
        resyncEpochBaseline();
      }
    }

    async function resyncEpochBaseline() {
      if (!PowerSaver.gate('epoch.resync', 5 * 60 * 1000)) return;
      try {
        const epochInfo = await rpcCall('getEpochInfo');
        // Keep the displayed epoch # and absolute slot fresh too, since
        // those live in the same top stats row and would otherwise stale
        // out alongside the bar.
        const ce = document.getElementById('currentEpoch');
        const cs = document.getElementById('currentSlot');
        if (ce) ce.textContent = epochInfo.epoch;
        if (cs && typeof formatCompact === 'function') {
          cs.textContent = formatCompact(epochInfo.absoluteSlot);
        }
        setEpochBaseline(epochInfo);
      } catch (e) {
        console.warn('Epoch resync failed:', e);
        // Clear the resync flag so we'll try again next tick if we did
        // hit the rollover branch.
        if (_epochBaseline) _epochBaseline._resyncing = false;
      }
    }

    // 1-second local tick — pure visual, no RPC
    setInterval(renderEpochBar, 1000);

    // Background re-sync against RPC
    setInterval(resyncEpochBaseline, _EPOCH_RESYNC_MS);

    // Re-sync immediately when the user returns to the tab
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        resyncEpochBaseline();
      }
    });

    // Initialize
    async function init() {
      // Warm the hourly rewards ledger (data/rewards.json) in the background
      // so the first validator card's rewards don't wait on the download.
      if (typeof RewardsLedger !== 'undefined') RewardsLedger.load().catch(() => {});

      // Fetch rewards history first if API is configured
      await fetchRewardsHistory();
      
      // Then load network stats
      await loadNetworkStats();
      updatePortfolioCount();

      // Deep link (#/lookup/<vote>, #/leaderboard/<cat>, #/compare/a,b, …)
      if (typeof Router !== 'undefined') Router.start();
      
      // Initialize map in background (don't await - let it load independently)
      setTimeout(() => {
        initializeMap().catch(err => {
          console.error('Map init error:', err);
          document.getElementById('mapLoading').style.display = 'none';
          document.getElementById('countryList').innerHTML = '<div class="map-loading-text">Map unavailable</div>';
        });
      }, 500);
      
      // The multi-MB leader schedule is loaded on demand (Network tab,
      // next-leader chips, Slot Explorer all call loadLeaderSchedule() when
      // they need it) — not for every visitor at page load.

      // TPS: full 720-sample history is only needed for the Network tab's
      // sparkline; other tabs just need the latest number for the top bar.
      loadTpsSamples();

      // Leader card only exists on the Network Live tab, so don't poll when
      // the user isn't looking at it. This cuts the 2-second blaster from
      // running on every page (~3,600 RPC calls/hour) to running only while
      // Network Live is active.
      setInterval(() => {
        if (document.body.classList.contains('active-skipmonitor') && PowerSaver.gate('leader.card')) {
          updateCurrentLeader();
        }
      }, 2000);

      // TPS — the top-bar readout and the Network Live sparkline share
      // tpsSamplesCache. One poller covers both. New samples only arrive
      // every 60s, so polling faster than that is pure waste.
      setInterval(loadTpsSamples, 60000);
    }

    Actions.register({
      'leader-lookup': (el, e, d) => lookupValidator(d.vote),
    });
