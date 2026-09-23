    // ─────────────────────────────────────────────────────────
    // SKIP MONITOR  (live leader-slot tracking)
    // ─────────────────────────────────────────────────────────
    // Strategy: every POLL_INTERVAL_MS we call getEpochInfo for the
    // current head, then getBlocks(first, last) for the slot range
    // since we last checked (staying CONFIRM_LAG slots behind head to
    // let newly-produced blocks finalize). Any slot assigned in the
    // cached leader schedule that doesn't appear in the produced set
    // is a skip. Per-slot granularity enables the live feed.
    // getBlockProduction gives aggregates only, so we don't use it here.
    // ─────────────────────────────────────────────────────────
    const SkipMonitor = (function() {
      const POLL_INTERVAL_MS   = 3000;
      const UI_TICK_MS         = 1000;
      const MAX_RECENT_SLOTS   = 1500;   // ~10 min of history at 420ms slots
      const MAX_FEED           = 120;
      const INITIAL_BACKFILL   = 1400;   // slots to hydrate on first tick / long absence
      const CONFIRM_LAG        = 12;     // stay this many slots behind head
      const MAX_RANGE_PER_CALL = 500;    // safety cap on a single getBlocks call
      const HOUR_SLOTS         = 8571;   // ~1 hour at 420ms/slot
      const HOUR_POLL_MS       = 30000;  // refresh last-hour aggregate every 30s
      const EPOCH_POLL_MS      = 60000;  // refresh epoch-to-date aggregate every 60s

      let state    = null;
      let pollTimer = null;
      let uiTimer   = null;
      let hourTimer = null;
      let epochTimer = null;
      let epochTimelineTimer = null;   // long-period refresh so epoch advances get picked up

      // ── Per-identity backfill tracking ─────────────────────────
      // iPad Safari occasionally truncates / fails the unfiltered getBlockProduction
      // response (which can be >1MB on a busy mainnet), causing portfolio validators
      // to render as "no leader slots assigned" even when they do have slots.
      // When we detect a portfolio/lookup validator is missing from the bulk response,
      // we fall back to a per-identity getBlockProduction (same call the Slot Explorer
      // modal uses successfully on iPad — far smaller payload). This Set tracks
      // in-flight (or recently-issued) backfill keys to avoid spamming duplicate
      // RPCs on every render. Keys are reset by pollEpoch / pollPrevEpoch when
      // fresh bulk data arrives.
      const _portfolioBackfillSeen = new Set();

      function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
          { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
        ));
      }

      function fmtNum(n) {
        return typeof n === 'number' ? n.toLocaleString() : '—';
      }

      // Deterministic colorful gradient from any string key.
      // Wider color space than a simple hue roll: three independent hash outputs
      // drive hue1/hue2/saturation/lightness so two adjacent validators can't
      // easily produce near-identical gradients.
      function identiconBg(seed) {
        const s = String(seed || 'x');
        let h1 = 0, h2 = 0, h3 = 0;
        for (let i = 0; i < s.length; i++) {
          h1 = ((h1 * 31) + s.charCodeAt(i)) & 0x7fffffff;
          h2 = ((h2 * 17) ^ s.charCodeAt(s.length - 1 - i)) & 0x7fffffff;
          h3 = ((h3 * 13) + s.charCodeAt(i) * 7) & 0x7fffffff;
        }
        const hue1 = h1 % 360;
        const hue2 = (hue1 + 60 + (h2 % 240)) % 360;
        const sat1 = 52 + (h3 % 25);        // 52-77
        const sat2 = 48 + ((h1 + h3) % 22); // 48-70
        const lit1 = 38 + (h2 % 14);        // 38-52
        const lit2 = 26 + (h3 % 14);        // 26-40
        return `linear-gradient(135deg, hsl(${hue1},${sat1}%,${lit1}%), hsl(${hue2},${sat2}%,${lit2}%))`;
      }

      // Returns { style, inner } to apply on a logo wrapper element.
      //
      // Hybrid strategy: always pre-paint the wrapper with the identicon +
      // initial as the background layer. When iconUrl is present, an absolutely
      // positioned <img> overlays on top. If the image loads, it covers the
      // gradient (you see the real logo). If it fails silently (CORS, 404,
      // empty response), the gradient + initial stays visible underneath.
      // onerror removes the <img> cleanly on explicit load failures.
      function avatarFor(info, seedOverride) {
        const seed = seedOverride || (info && (info.nodePubkey || info.votePubkey || info.name)) || 'x';
        const name = (info && info.name) || seed;
        const initial = esc(name.charAt(0).toUpperCase() || '?');
        const bg = identiconBg(seed);

        if (info && info.iconUrl) {
          return {
            style: `background:${bg};color:#fff;`,
            inner: initial
                 + `<img src="${safeUrl(info.iconUrl)}" alt="${initial}" `
                 +      `style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" `
                 +      `data-onerror="img-remove">`
          };
        }
        return {
          style: `background:${bg};color:#fff;`,
          inner: initial
        };
      }

      // Compact countdown: "~23s", "~3m 12s", "~1h 4m"
      function formatCountdown(ms) {
        if (ms === null || ms === undefined) return 'None';
        const s = Math.max(0, Math.round(ms / 1000));
        if (s < 60) return `~${s}s`;
        const m = Math.floor(s / 60), rs = s % 60;
        if (m < 60) return `~${m}m ${rs}s`;
        const h = Math.floor(m / 60), rm = m % 60;
        return `~${h}h ${rm}m`;
      }

      function freshState(scope) {
        return {
          running: false,
          scope: scope || 'network',
          epoch: null,
          epochStartAbsoluteSlot: null,
          slotToLeader: {},        // absoluteSlot -> nodePubkey for the current epoch
          lastProcessedSlot: null, // last absolute slot we've classified
          lastSeenHead: null,
          lastTickTs: null,        // wall-clock of the last successful tick; used to interpolate head between ticks
          slots: [],               // ring buffer: {slot, leader, produced, ts}
          feed: [],                // skip events (newest first)
          hourProd: null,          // {byIdentity, firstSlot, lastSlot, ts}
          epochProd: null,         // {byIdentity, ts, epoch}
          prevEpochProd: null,     // {byIdentity, ts, epoch}
          feedRenderedTopSlot: null, // slot # of the topmost rendered feed item (for incremental render)
          gridLastMaxSlot: null,     // highest slot # already rendered into the grid (for "new cell" animation)
          topExpanded: false,      // top-skippers panel collapsed by default
          lookupVotePubkey: null,  // Validator Lookup scope: vote address of the currently selected validator
          // Per-validator per-slot block-production cache. Populated lazily
          // when rendering my-validators / lookup cards so the timeline pips
          // can be ordered chronologically with red dots at the exact slots
          // where skips happened (matching the Slot Explorer modal exactly).
          // Shape: Map<key, { producedSet: Set<absSlot>, fetchedAt, fetching, skippedAtFetch }>
          // Keys: `${nodePubkey}` for current epoch, `prev:${nodePubkey}` for prev.
          perSlotCache: new Map(),
          // Lazy-fetched leader schedule for the *previous* epoch — needed so
          // the chronological pip rendering also works for the "Last Epoch"
          // panel. Only loaded once per session (or once per rollover).
          // Shape: { byIdentity: { nodePubkey: [relSlots…] }, firstAbsoluteSlot, epoch }
          prevEpochLeaderSchedule: null,
          _prevEpochLeaderFetching: false,
        };
      }

      async function rebuildSlotMap() {
        if (!leaderScheduleCache) await loadLeaderSchedule();
        if (!leaderScheduleCache) throw new Error('Leader schedule unavailable');

        const epochInfo = await rpcCall('getEpochInfo');
        const epochStart = epochInfo.absoluteSlot - epochInfo.slotIndex;

        const map = {};
        for (const [leader, relSlots] of Object.entries(leaderScheduleCache)) {
          for (const rel of relSlots) map[epochStart + rel] = leader;
        }

        state.epoch                  = epochInfo.epoch;
        state.epochStartAbsoluteSlot = epochStart;
        state.slotToLeader           = map;

        // Epoch rollover wipes the prev-epoch leader schedule (whatever
        // was cached pointed at what's now two-epochs-back). Cleared here
        // so renderPortfolioCard lazy-fetches the new prev epoch's
        // schedule for the chronological pip render.
        if (state.prevEpochLeaderSchedule && state.prevEpochLeaderSchedule.epoch !== epochInfo.epoch - 1) {
          state.prevEpochLeaderSchedule = null;
        }

        return epochInfo;
      }

      // Lazy-fetch the previous epoch's leader schedule. Triggered from
      // renderPortfolioCard the first time we render a "Last Epoch" panel
      // for a portfolio/lookup validator. We don't keep this in the live
      // skipmon state path (it's never needed for the network-scope grid),
      // so loading it on demand saves an unconditional ~1-2MB RPC fetch
      // every time the skipmon starts up.
      async function loadPrevEpochLeaderSchedule() {
        if (state._prevEpochLeaderFetching) return;
        if (state.prevEpochLeaderSchedule
            && state.prevEpochLeaderSchedule.epoch === state.epoch - 1) return;
        state._prevEpochLeaderFetching = true;
        try {
          const epochInfo = await rpcCall('getEpochInfo');
          const slotsPerEpoch = epochInfo.slotsInEpoch;
          const firstSlotOfPrevEpoch = epochInfo.absoluteSlot - epochInfo.slotIndex - slotsPerEpoch;
          const sched = await rpcCall('getLeaderSchedule', [firstSlotOfPrevEpoch]);
          if (sched && typeof sched === 'object') {
            state.prevEpochLeaderSchedule = {
              byIdentity:        sched,
              firstAbsoluteSlot: firstSlotOfPrevEpoch,
              epoch:             epochInfo.epoch - 1,
            };
            // Re-render so the lastPanel can now use the chronological path.
            if (state.scope === 'portfolio' || state.scope === 'lookup') renderAll();
          }
        } catch (e) {
          console.warn('[SkipMonitor] prev epoch leader schedule fetch failed:', e && e.message || e);
        } finally {
          state._prevEpochLeaderFetching = false;
        }
      }

      // Aggregate a getBlockProduction result into {assigned, produced, skipped, rate},
      // respecting the current scope filter (network vs portfolio).
      function prodAgg(prod) {
        if (!prod || !prod.byIdentity) return null;
        let assigned = 0, produced = 0;
        for (const [id, pair] of Object.entries(prod.byIdentity)) {
          if (!inScope(id)) continue;
          assigned += (pair[0] || 0);
          produced += (pair[1] || 0);
        }
        return {
          assigned, produced,
          skipped: assigned - produced,
          rate: assigned > 0 ? ((assigned - produced) / assigned) * 100 : null
        };
      }

      async function pollHour() {
        if (!state || !state.running) return;
        if (!PowerSaver.gate('skipmon.hour', 5 * 60 * 1000)) return;
        try {
          const epochInfo  = await rpcCall('getEpochInfo');
          if (!state || !state.running) return;
          const head       = epochInfo.absoluteSlot;
          const epochStart = head - epochInfo.slotIndex;
          const firstSlot  = Math.max(epochStart, head - HOUR_SLOTS);
          const lastSlot   = head;
          if (lastSlot <= firstSlot) return;
          const prod = await rpcCall('getBlockProduction', [{ range: { firstSlot, lastSlot } }]);
          if (!state || !state.running) return;
          const byIdentity = (prod && prod.value && prod.value.byIdentity) || {};
          state.hourProd = { byIdentity, firstSlot, lastSlot, ts: Date.now() };
          renderStats();
        } catch (e) {
          console.warn('[SkipMonitor] hour poll error:', e && e.message || e);
        }
      }

      async function pollEpoch() {
        if (!state || !state.running) return;
        if (!PowerSaver.gate('skipmon.epoch', 10 * 60 * 1000)) return;
        try {
          // No range param → current epoch to date
          const prod = await rpcCall('getBlockProduction');
          if (!state || !state.running) return;
          const byIdentity = (prod && prod.value && prod.value.byIdentity) || {};
          state.epochProd = { byIdentity, ts: Date.now(), epoch: state.epoch };
          // Fresh current-epoch bulk data → clear cur backfill tracking so any still-missing
          // entries (iPad-truncated bulk response) get retried per-identity.
          for (const k of [..._portfolioBackfillSeen]) {
            if (k.startsWith('cur:')) _portfolioBackfillSeen.delete(k);
          }
          renderStats();
          renderTop();  // top skippers panel is epoch-driven now
          if (state.scope === 'portfolio' || state.scope === 'lookup') {
            backfillPortfolioEpochs();
          }
        } catch (e) {
          console.warn('[SkipMonitor] epoch poll error:', e && e.message || e);
        }
      }

      // One-shot per session / per epoch rollover. Previous-epoch data is immutable,
      // so we only re-fetch when the epoch number changes.
      async function pollPrevEpoch() {
        if (!state || !state.running) return;
        if (state.prevEpochProd && state.prevEpochProd.epoch === (state.epoch - 1)) return;
        try {
          const epochInfo      = await rpcCall('getEpochInfo');
          if (!state || !state.running) return;
          const slotsPerEpoch  = epochInfo.slotsInEpoch;
          const currentStart   = epochInfo.absoluteSlot - epochInfo.slotIndex;
          const prevEnd        = currentStart - 1;
          const prevStart      = prevEnd - slotsPerEpoch + 1;
          if (prevStart < 0) return; // genesis epoch, no previous
          const prod = await rpcCall('getBlockProduction', [{ range: { firstSlot: prevStart, lastSlot: prevEnd } }]);
          if (!state || !state.running) return;
          const byIdentity = (prod && prod.value && prod.value.byIdentity) || {};
          state.prevEpochProd = { byIdentity, ts: Date.now(), epoch: epochInfo.epoch - 1 };
          // Fresh prev-epoch bulk data → clear prev backfill tracking so any still-missing
          // entries get retried per-identity.
          for (const k of [..._portfolioBackfillSeen]) {
            if (k.startsWith('prev:')) _portfolioBackfillSeen.delete(k);
          }
          renderStats();
          if (state.scope === 'portfolio' || state.scope === 'lookup') {
            backfillPortfolioEpochs();
          }
        } catch (e) {
          console.warn('[SkipMonitor] prev epoch poll error:', e && e.message || e);
        }
      }

      // ── Per-identity backfill (iPad Safari fix) ─────────────────────────
      // Ensures portfolio / lookup validators get rendered correctly even when
      // the bulk getBlockProduction response truncates or is incomplete.
      // For each portfolio validator missing from state.epochProd / state.prevEpochProd,
      // fires a small per-identity getBlockProduction (the same shape the Slot
      // Explorer modal uses successfully on iPad). On success, the result is
      // merged into the shared byIdentity map so the next render picks it up.
      // No-op when bulk data is complete, when scope is 'network', or when the
      // portfolio is empty. Safe to call repeatedly — _portfolioBackfillSeen
      // de-duplicates in-flight requests per (which, epoch, nodePubkey).
      async function backfillPortfolioEpochs() {
        if (!state || !state.running) return;
        if (state.scope !== 'portfolio' && state.scope !== 'lookup') return;

        // Resolve the set of nodePubkeys we care about for the active scope.
        const targets = [];
        if (state.scope === 'portfolio') {
          if (!Array.isArray(myPortfolio) || myPortfolio.length === 0) return;
          for (const votePubkey of myPortfolio) {
            const v = Array.isArray(allValidators)
              ? allValidators.find(x => x.votePubkey === votePubkey) : null;
            if (v && v.nodePubkey) targets.push(v.nodePubkey);
          }
        } else { // lookup
          const votePubkey = state.lookupVotePubkey;
          if (!votePubkey) return;
          const v = Array.isArray(allValidators)
            ? allValidators.find(x => x.votePubkey === votePubkey) : null;
          if (v && v.nodePubkey) targets.push(v.nodePubkey);
        }
        if (targets.length === 0) return;

        // Decide which validators are missing from each bulk response.
        // If the bulk poll hasn't completed yet at all (epochProd === null),
        // we still wait — pollEpoch fires shortly after start and will trigger
        // this backfill itself. Backfilling pre-poll would race against the
        // bulk call and risk creating an empty epochProd shell that flips
        // panels from "Loading…" to "no slots".
        const curBulk  = state.epochProd     && state.epochProd.byIdentity;
        const prevBulk = state.prevEpochProd && state.prevEpochProd.byIdentity;
        const needCur  = curBulk  ? targets.filter(np => !curBulk[np])  : [];
        const needPrev = prevBulk ? targets.filter(np => !prevBulk[np]) : [];
        if (needCur.length === 0 && needPrev.length === 0) return;

        const curEpochNum  = (state.epochProd && state.epochProd.epoch) ?? state.epoch ?? '?';
        const prevEpochNum = (state.prevEpochProd && state.prevEpochProd.epoch)
          ?? ((typeof state.epoch === 'number') ? state.epoch - 1 : '?');

        const tasks = [];

        // ── Current epoch backfills ────────────────────────────
        for (const np of needCur) {
          const key = `cur:${curEpochNum}:${np}`;
          if (_portfolioBackfillSeen.has(key)) continue;
          _portfolioBackfillSeen.add(key);
          tasks.push((async () => {
            try {
              const prod = await rpcCall('getBlockProduction', [{ identity: np }]);
              if (!state || !state.running) return;
              const pair = prod && prod.value && prod.value.byIdentity && prod.value.byIdentity[np];
              if (!pair) return;
              if (!state.epochProd) {
                state.epochProd = { byIdentity: {}, ts: Date.now(), epoch: state.epoch };
              }
              state.epochProd.byIdentity[np] = pair;
            } catch (e) {
              // Allow retry next render
              _portfolioBackfillSeen.delete(key);
              console.warn('[SkipMonitor] portfolio backfill (cur) failed for', np, e && e.message || e);
            }
          })());
        }

        // ── Previous epoch backfills (need range from epochInfo) ──
        if (needPrev.length > 0) {
          tasks.push((async () => {
            let prevRange = null;
            try {
              const epochInfo = await rpcCall('getEpochInfo');
              if (!state || !state.running) return;
              const slotsPerEpoch = epochInfo.slotsInEpoch;
              const currentStart  = epochInfo.absoluteSlot - epochInfo.slotIndex;
              const prevEnd       = currentStart - 1;
              const prevStart     = prevEnd - slotsPerEpoch + 1;
              if (prevStart >= 0) prevRange = { firstSlot: prevStart, lastSlot: prevEnd };
            } catch (e) {
              console.warn('[SkipMonitor] portfolio backfill (epochInfo) failed:', e && e.message || e);
              return;
            }
            if (!prevRange) return;

            const prevTasks = [];
            for (const np of needPrev) {
              const key = `prev:${prevEpochNum}:${np}`;
              if (_portfolioBackfillSeen.has(key)) continue;
              _portfolioBackfillSeen.add(key);
              prevTasks.push((async () => {
                try {
                  const prod = await rpcCall('getBlockProduction', [{ identity: np, range: prevRange }]);
                  if (!state || !state.running) return;
                  const pair = prod && prod.value && prod.value.byIdentity && prod.value.byIdentity[np];
                  if (!pair) return;
                  if (!state.prevEpochProd) {
                    state.prevEpochProd = { byIdentity: {}, ts: Date.now(), epoch: prevEpochNum };
                  }
                  state.prevEpochProd.byIdentity[np] = pair;
                } catch (e) {
                  _portfolioBackfillSeen.delete(key);
                  console.warn('[SkipMonitor] portfolio backfill (prev) failed for', np, e && e.message || e);
                }
              })());
            }
            await Promise.allSettled(prevTasks);
          })());
        }

        if (tasks.length === 0) return;
        await Promise.allSettled(tasks);

        // Re-render the active view so the freshly-backfilled validators show up.
        if (!state || !state.running) return;
        if (state.scope === 'portfolio')   renderPortfolioView();
        else if (state.scope === 'lookup') renderLookupView();
      }

      function inScope(leader) {
        if (state.scope === 'network') return true;
        const v = (typeof getValidatorByNodePubkey === 'function')
          ? getValidatorByNodePubkey(leader) : null;
        if (!v) return false;
        return Array.isArray(myPortfolio) && myPortfolio.includes(v.votePubkey);
      }

      function recordSlot(slot, leader, produced) {
        if (state.slots.length >= MAX_RECENT_SLOTS) state.slots.shift();
        state.slots.push({ slot, leader, produced, ts: Date.now() });
        if (!produced) {
          state.feed.unshift({ slot, leader, ts: Date.now() });
          if (state.feed.length > MAX_FEED) state.feed.pop();
        }
      }

      async function tick() {
        if (!state || !state.running) return;
        if (!PowerSaver.gate('skipmon.tick')) return;
        try {
          const epochInfo = await rpcCall('getEpochInfo');

          // Epoch rollover → rebuild schedule map
          if (state.epoch !== null && epochInfo.epoch !== state.epoch) {
            await rebuildSlotMap();
            state.lastProcessedSlot = null; // re-seed below
            state.prevEpochProd = null;     // the previous epoch is now a different epoch
            pollPrevEpoch();
            pollEpoch();
          }

          const head   = epochInfo.absoluteSlot;
          const target = head - CONFIRM_LAG;
          state.lastSeenHead = head;
          state.lastTickTs   = Date.now();

          // First tick ever — seed a backfill window
          if (state.lastProcessedSlot === null) {
            state.lastProcessedSlot = Math.max(
              state.epochStartAbsoluteSlot - 1,
              target - INITIAL_BACKFILL
            );
          }
          // Returning after a long absence — cap the catch-up
          else if (target - state.lastProcessedSlot > INITIAL_BACKFILL * 2) {
            state.lastProcessedSlot = target - INITIAL_BACKFILL;
          }

          if (target <= state.lastProcessedSlot) {
            setLiveStatus(true, 'Live');
            return;
          }

          const firstSlot = state.lastProcessedSlot + 1;
          const lastSlot  = Math.min(target, firstSlot + MAX_RANGE_PER_CALL - 1);

          const produced = await rpcCall('getBlocks', [firstSlot, lastSlot]);
          const producedSet = new Set(produced || []);

          for (let s = firstSlot; s <= lastSlot; s++) {
            const leader = state.slotToLeader[s];
            if (!leader) continue;  // unassigned (shouldn't happen inside an epoch)
            recordSlot(s, leader, producedSet.has(s));
          }

          state.lastProcessedSlot = lastSlot;
          setLiveStatus(true, 'Live');
          renderAll();
        } catch (e) {
          console.warn('[SkipMonitor] tick error:', e && e.message || e);
          setLiveStatus(false, 'RPC error · retrying');
        }
      }

      // ── Rendering ──────────────────────────────────────────
      function setLiveStatus(live, label) {
        const el = document.getElementById('skipmonLive');
        if (!el) return;
        el.classList.toggle('paused', !live);
        el.innerHTML = `<span class="skipmon-live-dot"></span> ${esc(label || (live ? 'Live' : 'Paused'))}`;
      }

      function filteredSlots() {
        if (!state) return [];
        return state.scope === 'network'
          ? state.slots
          : state.slots.filter(s => inScope(s.leader));
      }

      function filteredFeed() {
        if (!state) return [];
        return state.scope === 'network'
          ? state.feed
          : state.feed.filter(e => inScope(e.leader));
      }

      function renderStats() {
        if (!state) return;

        // Only update the text span — do NOT overwrite the whole paragraph,
        // or we'd wipe out the inline Live/Idle indicator that shares this subtitle.
        const subText = document.querySelector('#skipmonSubtitle .skipmon-subtitle-text');
        if (subText) {
          subText.textContent = `Real-time leader-slot tracking · Epoch ${state.epoch ?? '—'}`;
        }

        // Current Slot card
        const curEl = document.getElementById('skipmonCurSlot');
        if (curEl) curEl.textContent = state.lastSeenHead ? fmtNum(state.lastSeenHead) : '—';
        const curSubEl = document.getElementById('skipmonCurSlotSub');
        if (curSubEl) {
          curSubEl.textContent = state.lastSeenHead ? 'live · head of chain' : 'head of chain';
        }

        // ── LIVE (rolling window) ────────────────────────────
        const slots = filteredSlots();
        const skips = slots.filter(s => !s.produced);
        const liveRate = slots.length ? (skips.length / slots.length) * 100 : null;
        const liveEl = document.getElementById('skipmonLiveRate');
        if (liveEl) {
          liveEl.textContent = (liveRate === null) ? '—' : liveRate.toFixed(2) + '%';
          liveEl.className = 'skipmon-stat-value ' + (
            liveRate === null ? '' :
            liveRate < 1  ? 'ok' :
            liveRate < 5  ? 'warn' : 'bad'
          );
        }
        const liveSub = document.getElementById('skipmonLiveSub');
        if (liveSub) {
          if (!slots.length) {
            liveSub.textContent = state.scope === 'portfolio'
              ? 'no portfolio slots in window yet'
              : 'warming up…';
          } else {
            const mins = (slots.length * 0.42 / 60).toFixed(1);
            liveSub.textContent = `${skips.length} skip${skips.length===1?'':'s'} · ${fmtNum(slots.length)} slots · ~${mins} min`;
          }
        }

        // ── LAST HOUR ────────────────────────────────────────
        const hour = prodAgg(state.hourProd);
        const hourEl = document.getElementById('skipmonHourRate');
        const hourSub = document.getElementById('skipmonHourSub');
        if (hourEl) {
          if (!state.hourProd) {
            hourEl.textContent = '—';
            hourEl.className = 'skipmon-stat-value';
            if (hourSub) hourSub.textContent = 'fetching…';
          } else if (!hour || hour.rate === null) {
            hourEl.textContent = '—';
            hourEl.className = 'skipmon-stat-value';
            if (hourSub) hourSub.textContent = state.scope === 'portfolio' ? 'no portfolio slots this hour' : 'no slots';
          } else {
            hourEl.textContent = hour.rate.toFixed(2) + '%';
            hourEl.className = 'skipmon-stat-value ' + (hour.rate < 1 ? 'ok' : hour.rate < 5 ? 'warn' : 'bad');
            if (hourSub) hourSub.textContent = `${fmtNum(hour.skipped)} skip${hour.skipped===1?'':'s'} · ${fmtNum(hour.assigned)} slots`;
          }
        }

        // ── EPOCH (split: this / prev) ───────────────────────
        const epoch = prodAgg(state.epochProd);
        const prev  = prodAgg(state.prevEpochProd);
        const epEl    = document.getElementById('skipmonEpochRate');
        const prevEl  = document.getElementById('skipmonPrevRate');

        // "This" epoch value
        if (epEl) {
          if (!state.epochProd || !epoch || epoch.rate === null) {
            epEl.textContent = '—';
            epEl.className = 'skipmon-stat-epoch-col-value';
          } else {
            epEl.textContent = epoch.rate.toFixed(2) + '%';
            epEl.className = 'skipmon-stat-epoch-col-value ' + (
              epoch.rate < 1 ? 'ok' : epoch.rate < 5 ? 'warn' : 'bad'
            );
          }
        }

        // "Previous" epoch value (dimmer, smaller — deliberate)
        if (prevEl) {
          if (!state.prevEpochProd || !prev || prev.rate === null) {
            prevEl.textContent = '—';
          } else {
            prevEl.textContent = prev.rate.toFixed(2) + '%';
          }
        }

        // ── PULSE ROW: clean streak, last skip, trend ───────
        // Streak: consecutive produced slots walking back from the newest
        const streakEl = document.getElementById('skipmonStreak');
        if (streakEl) {
          if (!slots.length) {
            streakEl.textContent = '—';
            streakEl.className = 'skipmon-pulse-value dim';
          } else {
            let streak = 0;
            for (let i = slots.length - 1; i >= 0; i--) {
              if (slots[i].produced) streak++; else break;
            }
            const streakMin = (streak * 0.42 / 60).toFixed(1);
            streakEl.textContent = streak >= 60
              ? `${fmtNum(streak)} slots · ~${streakMin}m`
              : `${fmtNum(streak)} slots`;
            streakEl.className = 'skipmon-pulse-value ' + (streak >= 40 ? 'good' : streak >= 5 ? '' : 'dim');
          }
        }

        // Last skip: newest item in filtered feed
        const lastSkipEl = document.getElementById('skipmonLastSkip');
        if (lastSkipEl) {
          const feed = filteredFeed();
          const last = feed[0];
          if (!last) {
            lastSkipEl.textContent = state.scope === 'portfolio' ? 'none in window' : 'none in window';
            lastSkipEl.className = 'skipmon-pulse-value dim';
          } else {
            const ago = Math.max(0, Math.floor((Date.now() - last.ts) / 1000));
            const agoStr = ago < 60
              ? `${ago}s ago`
              : `${Math.floor(ago/60)}m ${ago%60}s ago`;
            const info = (typeof getValidatorByNodePubkey === 'function')
              ? getValidatorByNodePubkey(last.leader) : null;
            const name = info && info.name ? info.name : (last.leader.slice(0,4) + '…' + last.leader.slice(-4));
            // Truncate long names in the compact pulse row
            const shortName = name.length > 22 ? name.slice(0, 20) + '…' : name;
            lastSkipEl.textContent = `${agoStr} · ${shortName}`;
            lastSkipEl.className = 'skipmon-pulse-value ' + (ago < 30 ? 'bad' : ago < 120 ? '' : 'dim');
          }
        }

        // Trend: live rate vs last-hour rate
        const trendEl = document.getElementById('skipmonTrend');
        if (trendEl) {
          // Require enough data on both sides for a meaningful comparison
          const haveLive = slots.length >= 400;
          const haveHour = hour && hour.assigned >= 1000 && hour.rate !== null;
          if (!haveLive || !haveHour) {
            trendEl.textContent = 'not enough data';
            trendEl.className = 'skipmon-pulse-value dim';
            trendEl.title = '';
          } else {
            const delta = liveRate - hour.rate;
            trendEl.title = 'Points: percentage-point difference between the live rolling window and the last-hour average.';
            if (Math.abs(delta) < 0.1) {
              trendEl.textContent = `→ steady (${Math.abs(delta).toFixed(2)} pts)`;
              trendEl.className = 'skipmon-pulse-value dim';
            } else if (delta < 0) {
              trendEl.textContent = `↓ ${Math.abs(delta).toFixed(2)} pts better`;
              trendEl.className = 'skipmon-pulse-value good';
            } else {
              trendEl.textContent = `↑ ${delta.toFixed(2)} pts worse`;
              trendEl.className = 'skipmon-pulse-value bad';
            }
          }
        }
      }

      function renderGrid() {
        const el = document.getElementById('skipmonGrid');
        const metaEl = document.getElementById('skipmonGridMeta');
        if (!el) return;

        const slots = filteredSlots();
        if (!slots.length) {
          el.innerHTML = '<div class="skipmon-empty">' +
            (state && state.scope === 'portfolio' ? 'No portfolio validators have held leader slots in this window yet.' : 'Warming up…') +
            '</div>';
          if (metaEl) metaEl.textContent = '—';
          state.gridLastMaxSlot = null;
          return;
        }

        // Preserve scroll position if user has scrolled away from the bottom
        const wasNearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 40;

        // Cells whose slot # is strictly greater than the last render's high-water mark
        // are "new" and get the entrance animation. On first render, nothing animates.
        const prevMaxSlot = state.gridLastMaxSlot;
        const newestSlot  = slots[slots.length - 1].slot;

        const cells = new Array(slots.length);
        for (let i = 0; i < slots.length; i++) {
          const s = slots[i];
          const info = (typeof getValidatorByNodePubkey === 'function')
            ? getValidatorByNodePubkey(s.leader) : null;
          const name = info && info.name ? info.name : (s.leader.slice(0,4) + '…' + s.leader.slice(-4));
          const label = `Slot ${s.slot.toLocaleString()} · ${name} · ${s.produced ? 'Produced' : 'SKIPPED'}`;
          const isNew = prevMaxSlot !== null && s.slot > prevMaxSlot;
          const cls = 'skipmon-cell ' + (s.produced ? 'produced' : 'skipped') + (isNew ? ' new' : '');
          cells[i] = `<div class="${cls}" `
                   + `title="${esc(label)}" `
                   + `data-action="skipmon-jump" data-node="${esc(s.leader)}"></div>`;
        }

        // Pad the trailing row so it never looks like a half-finished line.
        // Measure how many cells fit per row against the container's current width,
        // then append neutral "ghost" cells to fill out the last row.
        //   cell = 14px, gap = 3px, container padding-x = 8px (matches .skipmon-grid CSS)
        const CELL = 14, GAP = 3, PAD_X = 8;
        const usable = Math.max(0, el.clientWidth - PAD_X * 2);
        const perRow = Math.max(1, Math.floor((usable + GAP) / (CELL + GAP)));
        const remainder = slots.length % perRow;
        const ghostCount = remainder === 0 ? 0 : (perRow - remainder);
        if (ghostCount > 0) {
          const ghost = '<div class="skipmon-cell ghost"></div>';
          for (let i = 0; i < ghostCount; i++) cells.push(ghost);
        }

        el.innerHTML = cells.join('');
        if (wasNearBottom) el.scrollTop = el.scrollHeight;
        state.gridLastMaxSlot = newestSlot;

        if (metaEl) {
          metaEl.textContent = `${slots.length} slots · ${slots[0].slot.toLocaleString()} → ${slots[slots.length-1].slot.toLocaleString()}`;
        }

        // Scrubber is driven by the same slot array, so render it alongside.
        renderScrubber(slots);
      }

      // ── Mini-scrubber ──────────────────────────────────────
      // Aggregates the full slot history into up to BUCKET_COUNT buckets and
      // renders each as a color-coded bar. Clicking a bar scrolls the main
      // grid to the first slot in that bucket. Color is interpolated from
      // green (no skips) toward red (many skips) in HSL space.
      function renderScrubber(slots) {
        const el = document.getElementById('skipmonScrubber');
        if (!el) return;
        if (!slots || !slots.length) { el.innerHTML = ''; return; }

        const BUCKET_COUNT = 100;
        const bucketSize = Math.max(1, Math.ceil(slots.length / BUCKET_COUNT));
        const pieces = [];
        for (let start = 0; start < slots.length; start += bucketSize) {
          const end = Math.min(start + bucketSize, slots.length);
          let produced = 0, skipped = 0;
          for (let i = start; i < end; i++) {
            if (slots[i].produced) produced++; else skipped++;
          }
          const total = produced + skipped;
          const skipRate = total > 0 ? skipped / total : 0;
          // Interpolate between the same teal (produced) and coral (skipped)
          // colors the grid cells use, so the scrubber reads as a smooth
          // condensed view of the grid above it rather than a different
          // chart with a different palette.
          //   0% skip  → rgb(64, 220, 180)  cyan-teal
          //   100%     → rgb(255, 120, 110) coral
          const r = Math.round(64  + (255 - 64)  * skipRate);
          const g = Math.round(220 - (220 - 120) * skipRate);
          const b = Math.round(180 - (180 - 110) * skipRate);
          // Keep clean (no-skip) buckets a touch more transparent so the
          // eye naturally lands on hotspots instead of an even green wall.
          const alpha = skipRate === 0 ? 0.42 : (0.55 + skipRate * 0.35);
          const color = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
          const firstSlot = slots[start].slot;
          const lastSlot  = slots[end - 1].slot;
          const title = `Slots ${firstSlot.toLocaleString()}–${lastSlot.toLocaleString()} · `
                      + `${total} cells · ${(skipRate * 100).toFixed(1)}% skipped`;
          pieces.push(
            `<button class="skipmon-scrubber-bar" `
            + `style="background:${color}" `
            + `data-idx="${start}" `
            + `title="${esc(title)}" `
            + `data-action="skipmon-scrub"></button>`
          );
        }
        el.innerHTML = pieces.join('');
      }

      // Scroll the main grid so the cell at `index` in the slots array is
      // near the top of the visible area. Uses the same CELL/GAP/PAD math
      // as the ghost-padding computation in renderGrid.
      function scrubberJumpTo(index) {
        const gridEl = document.getElementById('skipmonGrid');
        if (!gridEl) return;
        const CELL = 14, GAP = 3, PAD = 8;
        const usable = Math.max(0, gridEl.clientWidth - PAD * 2);
        const perRow = Math.max(1, Math.floor((usable + GAP) / (CELL + GAP)));
        const rowIdx = Math.floor(index / perRow);
        const rowHeight = CELL + GAP;
        gridEl.scrollTo({
          top: Math.max(0, rowIdx * rowHeight - 40),
          behavior: 'smooth'
        });
      }

      // Render a single feed item's HTML (used by both full-rebuild and incremental paths)
      function feedItemHtml(e) {
        const info = (typeof getValidatorByNodePubkey === 'function')
          ? getValidatorByNodePubkey(e.leader) : null;
        const name = info && info.name ? info.name : (e.leader.slice(0,6) + '…' + e.leader.slice(-4));
        const a = avatarFor(info, e.leader);
        const d = new Date(e.ts);
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        const ss = String(d.getUTCSeconds()).padStart(2, '0');
        const tStr = `${hh}:${mm}:${ss} UTC`;
        return `<div class="skipmon-feed-item" data-slot="${e.slot}" data-action="skipmon-jump" data-node="${esc(e.leader)}">`
             +   `<div class="skipmon-feed-logo" style="${a.style}">${a.inner}</div>`
             +   `<div class="skipmon-feed-body">`
             +     `<div class="skipmon-feed-top">`
             +       `<span class="skipmon-feed-name" title="${esc(name)}">${esc(name)}</span>`
             +       `<span class="skipmon-feed-badge">Skipped</span>`
             +     `</div>`
             +     `<div class="skipmon-feed-meta">slot ${e.slot.toLocaleString()}</div>`
             +   `</div>`
             +   `<div class="skipmon-feed-time-right">${esc(tStr)}</div>`
             + `</div>`;
      }

      function renderFeed() {
        const el = document.getElementById('skipmonFeed');
        const metaEl = document.getElementById('skipmonFeedMeta');
        if (!el) return;

        const feed = filteredFeed();
        if (metaEl) metaEl.textContent = `${feed.length} event${feed.length === 1 ? '' : 's'}`;

        if (!feed.length) {
          el.innerHTML = '<div class="skipmon-empty">' +
            (state && state.scope === 'portfolio' ? 'No skips from your portfolio yet.' : 'Waiting for skips…') +
            '</div>';
          state.feedRenderedTopSlot = null;
          return;
        }

        // Feed is newest-first. Prepending new items at the top keeps scroll behavior natural:
        // - If user is at top, they see new events push old ones down.
        // - If user has scrolled down to read older events, we compensate scrollTop so nothing
        //   jumps under them.
        const isEmptyDom = !!el.querySelector('.skipmon-empty') || el.children.length === 0;
        const doFullRebuild = isEmptyDom || state.feedRenderedTopSlot === null;

        if (doFullRebuild) {
          el.innerHTML = feed.map(feedItemHtml).join('');
          state.feedRenderedTopSlot = feed[0].slot;
          return;
        }

        // Incremental: find events newer than the topmost currently rendered slot, prepend them
        const newItems = [];
        for (const e of feed) {
          if (e.slot <= state.feedRenderedTopSlot) break; // feed is sorted newest-first
          newItems.push(e);
        }

        if (newItems.length) {
          const wasScrolledDown = el.scrollTop > 4;
          const prevScrollHeight = el.scrollHeight;
          // newItems is already newest-first; insertAdjacentHTML preserves order at the top
          el.insertAdjacentHTML('afterbegin', newItems.map(feedItemHtml).join(''));
          state.feedRenderedTopSlot = feed[0].slot;
          // Compensate scroll so what the user was reading doesn't slide under them
          if (wasScrolledDown) {
            el.scrollTop += (el.scrollHeight - prevScrollHeight);
          }
        }

        // Trim overflow from the bottom without disturbing the scroll
        const rendered = el.querySelectorAll('.skipmon-feed-item');
        if (rendered.length > MAX_FEED) {
          for (let i = MAX_FEED; i < rendered.length; i++) rendered[i].remove();
        }
      }

      function renderTop() {
        const el = document.getElementById('skipmonTopWrap');
        const metaEl = document.getElementById('skipmonTopMeta');
        if (!el) return;

        // Top Skippers uses EPOCH data (refreshed every 60s) rather than the
        // 10-minute rolling window. That picks up chronic offenders, not
        // validators who happened to have 1 unlucky slot in the last 10 min.
        const prod = state.epochProd;
        if (!prod || !prod.byIdentity) {
          el.innerHTML = '<div class="skipmon-empty">Loading epoch data…</div>';
          if (metaEl) metaEl.textContent = '—';
          return;
        }

        const tallies = [];
        for (const [leader, pair] of Object.entries(prod.byIdentity)) {
          if (!inScope(leader)) continue;
          const assigned = pair[0] || 0;
          const produced = pair[1] || 0;
          const skipped  = assigned - produced;
          if (assigned < 10 || skipped === 0) continue;  // denoise: need enough slots
          tallies.push({ leader, assigned, produced, skipped, rate: (skipped / assigned) * 100 });
        }

        // Sort by skip rate desc, tiebreak on absolute skipped count
        tallies.sort((a, b) => b.rate - a.rate || b.skipped - a.skipped);

        if (metaEl) {
          metaEl.textContent = `${tallies.length} validator${tallies.length === 1 ? '' : 's'} with skips · epoch ${state.epoch ?? '—'}`;
        }

        if (!tallies.length) {
          el.innerHTML = '<div class="skipmon-empty">' +
            (state.scope === 'portfolio' ? 'No skips from your portfolio this epoch.' : 'No validators with skips this epoch yet.') +
            '</div>';
          return;
        }

        const expanded   = !!state.topExpanded;
        const maxVisible = 15;
        const visible    = tallies.slice(0, expanded ? maxVisible : Math.min(3, tallies.length));

        let html = '<table class="skipmon-top-table"><thead><tr>'
                 + '<th style="width:48px">#</th>'
                 + '<th>Validator</th>'
                 + '<th style="width:110px" title="Leader slots assigned to this validator so far in this epoch">Assigned</th>'
                 + '<th style="width:100px" title="Slots where this validator failed to produce a block">Skipped</th>'
                 + '<th style="width:120px" title="Skipped ÷ Assigned, as a percentage">Skip Rate</th>'
                 + '</tr></thead><tbody>';

        visible.forEach((r, i) => {
          const info = (typeof getValidatorByNodePubkey === 'function')
            ? getValidatorByNodePubkey(r.leader) : null;
          const name = info && info.name ? info.name : (r.leader.slice(0,6) + '…' + r.leader.slice(-4));
          const rank = i + 1;
          const rankCls = rank === 1 ? 'gold' : '';
          const a = avatarFor(info, r.leader);

          html += `<tr data-action="skipmon-jump" data-node="${esc(r.leader)}">`
                + `<td><span class="skipmon-top-rank ${rankCls}">${rank}</span></td>`
                + `<td><div class="skipmon-top-name">`
                +   `<div class="skipmon-top-logo" style="${a.style}">${a.inner}</div>`
                +   `<span>${esc(name)}</span>`
                + `</div></td>`
                + `<td>${fmtNum(r.assigned)}</td>`
                + `<td style="color:var(--danger);font-weight:600">${fmtNum(r.skipped)}</td>`
                + `<td>${r.rate.toFixed(2)}%</td>`
                + `</tr>`;
        });

        html += '</tbody></table>';

        // Expand/collapse only when there's more to show than the top 3
        if (tallies.length > 3) {
          const remaining = Math.min(maxVisible, tallies.length) - 3;
          html += `<div class="skipmon-top-expand">`
                +   `<button class="skipmon-top-expand-btn" data-action="skipmon-toggle-top">`
                +     (expanded ? '▲ Show top 3' : `▼ Show ${remaining} more`)
                +   `</button>`
                + `</div>`;
        }

        el.innerHTML = html;
      }

      // Interpolate head between ticks: at 420ms/slot the chain is constantly
      // advancing, and if we only re-render on tick (every 3s) the NOW indicator
      // feels frozen. Derive a "presumed" head from wall-clock elapsed since
      // the last tick, capped so a stalled connection can't run away.
      function presumedHead() {
        if (!state || !state.lastSeenHead) return null;
        if (!state.lastTickTs) return state.lastSeenHead;
        const elapsedMs = Date.now() - state.lastTickTs;
        const advance = Math.max(0, Math.floor(elapsedMs / 420));
        return state.lastSeenHead + Math.min(advance, 20);
      }

      // ── Live Timeline ──────────────────────────────────────
      // Renders ~40 past + current + 60 upcoming slots as a horizontal strip.
      // Past cells that have been classified appear green (produced) / red (skipped).
      // Slots between lastProcessedSlot and head are "pending" — assigned and
      // awaiting confirmation — and get a soft cyan pulse so the strip reads
      // as continuous rather than having a dead gap up against NOW.
      // Upcoming cells are derived from the leader schedule; in portfolio
      // scope, your own validators' upcoming slots get a gold glow.
      function renderTimeline() {
        const el = document.getElementById('skipmonTimelineTrack');
        const metaEl = document.getElementById('skipmonTimelineMeta');
        if (!el) return;

        const head = presumedHead();
        if (!state || !head) {
          el.innerHTML = '<div class="skipmon-empty" style="padding:0.5rem;">Warming up…</div>';
          if (metaEl) metaEl.textContent = '—';
          return;
        }

        const PAST = 85, FUTURE = 15;
        const lastProc = state.lastProcessedSlot;

        // Index past slot statuses for O(1) lookup
        const slotStatus = {};
        for (const s of state.slots) slotStatus[s.slot] = s.produced ? 'produced' : 'skipped';

        // Portfolio membership for highlighting "your" upcoming slots
        const portfolioNodePubkeys = new Set();
        if (state.scope === 'portfolio' && Array.isArray(myPortfolio) && allValidators) {
          for (const v of allValidators) {
            if (myPortfolio.includes(v.votePubkey)) portfolioNodePubkeys.add(v.nodePubkey);
          }
        }

        const parts = new Array(PAST + 1 + FUTURE);
        for (let offset = -PAST; offset <= FUTURE; offset++) {
          const slot   = head + offset;
          const leader = state.slotToLeader[slot];
          const info   = leader ? (typeof getValidatorByNodePubkey === 'function' ? getValidatorByNodePubkey(leader) : null) : null;
          const name   = info && info.name ? info.name : (leader ? leader.slice(0,4) + '…' + leader.slice(-4) : 'unknown');

          let cls = 'sm-tl-cell';
          let label;

          if (offset === 0) {
            cls += ' current';
            label = `Slot ${slot.toLocaleString()} · NOW · ${name}`;
          } else if (offset < 0) {
            const status = slotStatus[slot];
            if (status === 'produced')      cls += ' produced';
            else if (status === 'skipped')  cls += ' skipped';
            else if (lastProc !== null && slot > lastProc) cls += ' pending';
            else                            cls += ' unknown';
            const statusLabel = status || (lastProc !== null && slot > lastProc ? 'pending' : 'no data');
            label = `Slot ${slot.toLocaleString()} · ${name} · ${statusLabel}`;
          } else {
            // Upcoming
            if (offset <= 4)                cls += ' upcoming-next';
            else                            cls += ' upcoming';
            if (leader && portfolioNodePubkeys.has(leader)) cls += ' portfolio-mine';
            const etaSec = offset * 0.42;
            const etaStr = etaSec < 60 ? `${etaSec.toFixed(1)}s` : `${(etaSec/60).toFixed(1)}m`;
            label = `Slot ${slot.toLocaleString()} · ${name} · in ${etaStr}`;
          }

          parts[offset + PAST] = `<div class="${cls}" title="${esc(label)}"`
            + (leader ? ` data-action="skipmon-jump" data-node="${esc(leader)}"` : '')
            + `></div>`;
        }

        el.innerHTML = parts.join('');

        if (metaEl) {
          metaEl.textContent = `head ${fmtNum(head)} · ${PAST} past / ${FUTURE} ahead`;
        }
      }

      // ── Portfolio View (per-validator slot-explorer-style scorecards) ──
      // Each card shows the validator's header plus two panels side-by-side:
      // "◀ Last Epoch" and "Current Epoch ▶". Each panel mirrors the slot
      // explorer modal: 4 stat boxes, a block-production bar, an info row
      // (next-leader countdown for current, "Epoch completed" for last), and
      // a slot-timeline strip for the current epoch.
      //
      // All data is derived from state we already poll — no new RPC calls:
      //   current epoch → state.epochProd.byIdentity[nodePubkey]
      //   last epoch    → state.prevEpochProd.byIdentity[nodePubkey]
      //   upcoming      → state.slotToLeader filtered by leader
      function renderPortfolioView() {
        const grid = document.getElementById('skipmonPortfolioGrid');
        const meta = document.getElementById('skipmonPvMeta');
        if (!grid) return;

        if (!Array.isArray(myPortfolio) || myPortfolio.length === 0) {
          grid.innerHTML = `<div class="skipmon-empty" style="grid-column:1/-1">`
            + `Your Data Center is empty. Add validators from the My Data Center tab to track them here.`
            + `</div>`;
          if (meta) meta.textContent = '0 validators';
          return;
        }

        // Previously we bailed out here unless both the chain head AND the
        // full-epoch getBlockProduction result were ready, which meant the
        // user could stare at "Loading portfolio data…" for 5–15 s while
        // pollEpoch completed. renderPortfolioCard already handles null
        // epochProd gracefully (it shows "—" for missing pieces), so we
        // render the cards immediately and the next renderAll() after the
        // poll resolves will fill in the numbers in place.

        if (meta) {
          const curN  = state.epoch ?? '—';
          const prevN = (typeof state.epoch === 'number') ? state.epoch - 1 : '—';
          meta.textContent = `${myPortfolio.length} validator${myPortfolio.length===1?'':'s'} · epochs ${prevN} & ${curN}`;
        }

        const cards = [];
        for (const votePubkey of myPortfolio) {
          const v = allValidators && allValidators.find(x => x.votePubkey === votePubkey);
          if (!v) {
            cards.push(`<div class="skipmon-pv-card" style="opacity:0.6">`
              + `<div class="skipmon-pv-head" style="border-bottom:none;padding-bottom:0;cursor:default">`
              +   `<div class="skipmon-pv-logo" style="background:${identiconBg(votePubkey)};color:#fff">?</div>`
              +   `<div class="skipmon-pv-meta">`
              +     `<div class="skipmon-pv-name">Unknown validator</div>`
              +     `<div class="skipmon-pv-addr">${esc(votePubkey.slice(0,16))}…</div>`
              +   `</div>`
              + `</div></div>`);
            continue;
          }
          cards.push(renderPortfolioCard(v));
        }
        grid.innerHTML = cards.join('') || `<div class="skipmon-empty">No portfolio validators found.</div>`;

        // iPad Safari fix: if the bulk getBlockProduction response was truncated
        // and any portfolio validators are missing from state.epochProd /
        // state.prevEpochProd, fetch them per-identity. No-op when bulk is complete.
        backfillPortfolioEpochs();
      }

      // Validator Lookup scope: render the single selected validator's scorecard
      // by piggybacking on renderPortfolioCard — the card already does exactly
      // what this scope needs (two-epoch side-by-side stats + timeline pips).
      // Showing a friendly hint when nothing's selected yet lets the user know
      // the page is waiting on them.
      function renderLookupView() {
        const grid  = document.getElementById('skipmonLookupGrid');
        const meta  = document.getElementById('skipmonLookupMeta');
        const title = document.getElementById('skipmonLookupHeadTitle');
        if (!grid) return;

        const votePubkey = state && state.lookupVotePubkey;
        if (!votePubkey) {
          grid.innerHTML = `<div class="skipmon-lookup-hint" style="grid-column:1/-1">`
                         + `Type a validator name or vote address above to see their live skip stats.`
                         + `</div>`;
          if (meta)  meta.textContent  = 'Search any validator above';
          if (title) title.textContent = 'Validator Lookup';
          return;
        }

        const v = allValidators && allValidators.find(x => x.votePubkey === votePubkey);
        if (!v) {
          grid.innerHTML = `<div class="skipmon-empty" style="grid-column:1/-1">`
                         + `Validator not found in the active set.`
                         + `</div>`;
          if (meta)  meta.textContent  = '—';
          if (title) title.textContent = 'Validator Lookup';
          return;
        }

        if (!state.lastSeenHead || !state.epochProd) {
          // Data not ready yet — the card would render as mostly zeros otherwise.
          grid.innerHTML = `<div class="skipmon-empty" style="grid-column:1/-1">Loading skip data…</div>`;
          if (title) title.textContent = v.name || 'Validator Lookup';
          if (meta)  meta.textContent  = 'Warming up…';
          return;
        }

        if (title) title.textContent = v.name || 'Validator Lookup';
        if (meta) {
          const curN  = state.epoch ?? '—';
          const prevN = (typeof state.epoch === 'number') ? state.epoch - 1 : '—';
          meta.textContent = `Epochs ${prevN} & ${curN}`;
        }
        grid.innerHTML = renderPortfolioCard(v);

        // iPad Safari fix: if the bulk getBlockProduction response is missing
        // this validator, backfill per-identity (same call shape the Slot
        // Explorer uses successfully on iPad).
        backfillPortfolioEpochs();
      }

      function renderPortfolioCard(v) {
        const nodePubkey = v.nodePubkey;
        const head       = state.lastSeenHead;

        // ── Current epoch (elapsed portion; upcoming from schedule) ──
        const curPair    = (state.epochProd && state.epochProd.byIdentity && state.epochProd.byIdentity[nodePubkey]) || null;
        const curElapsed = curPair ? (curPair[0] || 0) : 0;
        const curProduced= curPair ? (curPair[1] || 0) : 0;
        const curSkipped = curElapsed - curProduced;

        let curUpcoming = 0;
        const upcomingSlots = [];
        const pastSlots     = [];
        for (const slotStr in state.slotToLeader) {
          if (state.slotToLeader[slotStr] === nodePubkey) {
            const slot = +slotStr;
            if (slot > head) { curUpcoming++; upcomingSlots.push(slot); }
            else pastSlots.push(slot);
          }
        }
        upcomingSlots.sort((a, b) => a - b);
        pastSlots.sort((a, b) => a - b);
        const curAssignedTotal = curElapsed + curUpcoming;
        const curRate          = curElapsed > 0 ? (curSkipped / curElapsed) * 100 : null;
        const nextSlot         = upcomingSlots[0];
        const nextSlotsAway    = nextSlot !== undefined ? nextSlot - head : null;
        const nextMs           = nextSlotsAway !== null ? nextSlotsAway * 420 : null;

        // Kick off (or refresh) the per-slot block-production cache for this
        // validator so the current-epoch timeline can render red dots at the
        // exact slots where skips happened — same data the Slot Explorer
        // modal shows. The fetch is async, debounced via the `fetching` flag,
        // and re-runs every 60s OR whenever curSkipped changes since the
        // last fetch. When it completes it triggers a re-render.
        const cacheEntry = state.perSlotCache.get(nodePubkey);
        const cacheStale = !cacheEntry
          || (Date.now() - cacheEntry.fetchedAt > 60000)
          || cacheEntry.skippedAtFetch !== curSkipped;
        if (pastSlots.length > 0 && cacheStale && !(cacheEntry && cacheEntry.fetching)) {
          const inFlight = { producedSet: cacheEntry && cacheEntry.producedSet, fetchedAt: cacheEntry ? cacheEntry.fetchedAt : 0, fetching: true, skippedAtFetch: cacheEntry ? cacheEntry.skippedAtFetch : null };
          state.perSlotCache.set(nodePubkey, inFlight);
          (async () => {
            const result = await fetchProducedSlots(pastSlots);
            if (result !== null) {
              state.perSlotCache.set(nodePubkey, {
                producedSet: result,
                fetchedAt: Date.now(),
                fetching: false,
                skippedAtFetch: curSkipped,
              });
              // Only re-render if we're still on a scope that needs this data.
              if (state.scope === 'portfolio' || state.scope === 'lookup') renderAll();
            } else {
              // Mark not-fetching so a later render can retry.
              const cur = state.perSlotCache.get(nodePubkey);
              if (cur) cur.fetching = false;
            }
          })();
        }
        const producedSet = cacheEntry && cacheEntry.producedSet;

        // ── Previous epoch (completed; aggregate + lazy per-slot) ──
        const prevPair     = (state.prevEpochProd && state.prevEpochProd.byIdentity && state.prevEpochProd.byIdentity[nodePubkey]) || null;
        const prevAssigned = prevPair ? (prevPair[0] || 0) : 0;
        const prevProduced = prevPair ? (prevPair[1] || 0) : 0;
        const prevSkipped  = prevAssigned - prevProduced;
        const prevRate     = prevAssigned > 0 ? (prevSkipped / prevAssigned) * 100 : null;

        // Chronological pip data for the last-epoch panel. Needs the prev
        // epoch's leader schedule (lazy-loaded once per epoch rollover) plus
        // a per-slot getBlock pass cached under a `prev:` key. Prev epoch
        // is completed so cache lifetime can be long (skipped count is
        // stable; no confirmation lag to worry about).
        let prevPastSlots  = null;
        let prevProducedSet = null;
        if (state.prevEpochLeaderSchedule
            && typeof state.epoch === 'number'
            && state.prevEpochLeaderSchedule.epoch === state.epoch - 1) {
          const relSlots = state.prevEpochLeaderSchedule.byIdentity[nodePubkey] || [];
          if (relSlots.length > 0) {
            const firstAbs = state.prevEpochLeaderSchedule.firstAbsoluteSlot;
            prevPastSlots = relSlots.map(rel => rel + firstAbs).sort((a, b) => a - b);

            const prevKey = 'prev:' + nodePubkey;
            const prevCache = state.perSlotCache.get(prevKey);
            const prevStale = !prevCache
              || (Date.now() - prevCache.fetchedAt > 300000); // 5min; prev epoch is frozen
            if (prevStale && !(prevCache && prevCache.fetching)) {
              const inFlight = {
                producedSet: prevCache && prevCache.producedSet,
                fetchedAt: prevCache ? prevCache.fetchedAt : 0,
                fetching: true,
              };
              state.perSlotCache.set(prevKey, inFlight);
              (async () => {
                const result = await fetchProducedSlots(prevPastSlots);
                if (result !== null) {
                  state.perSlotCache.set(prevKey, {
                    producedSet: result,
                    fetchedAt: Date.now(),
                    fetching: false,
                  });
                  if (state.scope === 'portfolio' || state.scope === 'lookup') renderAll();
                } else {
                  const cur = state.perSlotCache.get(prevKey);
                  if (cur) cur.fetching = false;
                }
              })();
            }
            prevProducedSet = prevCache && prevCache.producedSet;
          }
        } else {
          // Trigger the lazy load (only fires once per session/rollover).
          if (typeof state.epoch === 'number') loadPrevEpochLeaderSchedule();
        }

        const a = avatarFor(v);
        const delinquentBadge = v.delinquent
          ? `<span class="skipmon-pv-badge-delinquent">Delinquent</span>`
          : '';
        const cardCls = v.delinquent ? 'skipmon-pv-card delinquent' : 'skipmon-pv-card';

        const lastPanel = renderEpochPanel({
          isCurrent: false,
          epochNum:  (typeof state.epoch === 'number') ? state.epoch - 1 : null,
          hasData:   !!state.prevEpochProd,
          hasValidatorData: prevPair !== null && prevAssigned > 0,
          assigned:  prevAssigned,
          produced:  prevProduced,
          skipped:   prevSkipped,
          rate:      prevRate,
          // Chronological pip data for the completed epoch. Renderer will
          // fall back to the grouped layout until prevProducedSet lands.
          pastSlots:  prevPastSlots,
          producedSet: prevProducedSet,
        });

        const curPanel = renderEpochPanel({
          isCurrent: true,
          epochNum:  state.epoch,
          hasData:   !!state.epochProd,
          // NOTE: don't require curPair !== null here. curPair comes from the
          // bulk getBlockProduction response (state.epochProd.byIdentity),
          // which only includes validators that have already had a leader slot
          // elapse this epoch. A validator whose slots are entirely upcoming
          // is missing from that map but still has curAssignedTotal > 0 from
          // the leader schedule — and we absolutely want to show those.
          hasValidatorData: curAssignedTotal > 0,
          assigned:  curAssignedTotal,
          elapsed:   curElapsed,
          produced:  curProduced,
          skipped:   curSkipped,
          upcoming:  curUpcoming,
          rate:      curRate,
          nextMs,
          nextSlot,
          // Chronological pip data — when producedSet is available, the
          // renderer walks pastSlots in order and marks each as produced or
          // skipped accordingly (matches the Slot Explorer's timeline).
          pastSlots,
          upcomingSlots,
          producedSet,
        });

        return `<div class="${cardCls}">`
          +   `<div class="skipmon-pv-head" `
          +        `data-action="skipmon-portfolio-modal" data-node="${esc(nodePubkey)}" data-name="${esc(v.name)}" data-vote="${esc(v.votePubkey)}" `
          +        `title="Click for full slot explorer">`
          +     `<div class="skipmon-pv-logo" style="${a.style}">${a.inner}</div>`
          +     `<div class="skipmon-pv-meta">`
          +       `<div class="skipmon-pv-name">${esc(v.name)}${delinquentBadge}</div>`
          +       `<div class="skipmon-pv-addr">${esc(v.votePubkey.slice(0,20))}…${esc(v.votePubkey.slice(-4))}</div>`
          +     `</div>`
          +     `<span class="skipmon-pv-chevron">›</span>`
          +   `</div>`
          +   `<div class="skipmon-pv-epochs">`
          +     lastPanel
          +     curPanel
          +   `</div>`
          + `</div>`;
      }

      function renderEpochPanel(d) {
        const headerEpochNum = (d.epochNum === null || d.epochNum === undefined) ? '—' : d.epochNum;
        const panelCls = d.isCurrent ? 'skipmon-pv-epoch-panel current' : 'skipmon-pv-epoch-panel';
        const headerHtml = `<div class="skipmon-pv-epoch-header">`
          + (d.isCurrent ? '' : '<span>◀</span>')
          + `${d.isCurrent ? 'Current Epoch' : 'Last Epoch'} `
          + `<span class="epoch-num">${esc(String(headerEpochNum))}</span>`
          + (d.isCurrent ? ' <span>▶</span>' : '')
          + `</div>`;

        if (!d.hasData) {
          return `<div class="${panelCls}">${headerHtml}`
               + `<div class="skipmon-empty" style="padding:1rem 0.5rem;">Loading…</div>`
               + `</div>`;
        }

        if (!d.hasValidatorData) {
          return `<div class="${panelCls}">${headerHtml}`
               + `<div class="skipmon-empty" style="padding:1rem 0.5rem;">`
               +   (d.isCurrent ? 'No leader slots assigned yet this epoch.' : 'No leader slots last epoch.')
               + `</div>`
               + `</div>`;
        }

        // Denominator for block-production rate: elapsed for current, full assigned for last
        const denom       = d.isCurrent ? (d.elapsed || 0) : d.assigned;
        const successPct  = denom > 0 ? (d.produced / denom) * 100 : 0;
        const skipPctBar  = denom > 0 ? (d.skipped  / denom) * 100 : 0;
        const rateStr     = d.rate === null ? '—' : d.rate.toFixed(2) + '%';
        const rateCls     = d.rate === null ? '' :
                            d.rate === 0    ? 'ok' :
                            d.rate < 1      ? 'ok' :
                            d.rate < 5      ? 'warn' : 'danger';

        // Stats row — 4 boxes
        const statsHtml = `<div class="skipmon-pv-epoch-stats">`
          + `<div class="skipmon-pv-stat"><div class="skipmon-pv-stat-label">Assigned</div>`
          +   `<div class="skipmon-pv-stat-value">${fmtNum(d.assigned)}</div></div>`
          + `<div class="skipmon-pv-stat"><div class="skipmon-pv-stat-label">Produced</div>`
          +   `<div class="skipmon-pv-stat-value ok">${fmtNum(d.produced)}</div></div>`
          + `<div class="skipmon-pv-stat"><div class="skipmon-pv-stat-label">Skipped</div>`
          +   `<div class="skipmon-pv-stat-value ${d.skipped > 0 ? 'danger' : 'ok'}">${fmtNum(d.skipped)}</div></div>`
          + `<div class="skipmon-pv-stat"><div class="skipmon-pv-stat-label">Skip Rate</div>`
          +   `<div class="skipmon-pv-stat-value ${rateCls}">${rateStr}</div></div>`
          + `</div>`;

        // Block production bar
        const barHtml = `<div class="skipmon-pv-bar-wrap">`
          + `<div class="skipmon-pv-bar-labels">`
          +   `<span>Block production</span>`
          +   `<span>${successPct.toFixed(1)}% success</span>`
          + `</div>`
          + `<div class="skipmon-pv-bar-track">`
          +   `<div class="skipmon-pv-bar-fill-produced" style="width:${successPct.toFixed(1)}%"></div>`
          +   (d.skipped > 0
               ? `<div class="skipmon-pv-bar-fill-skipped" style="width:${skipPctBar.toFixed(1)}%"></div>`
               : '')
          + `</div>`
          + `</div>`;

        // Info row
        let infoHtml;
        if (d.isCurrent) {
          const countdown = d.nextMs !== null ? formatCountdown(d.nextMs) : 'None remaining';
          const slotDisplay = d.nextSlot ? d.nextSlot.toLocaleString() : '—';
          infoHtml = `<div class="skipmon-pv-info-row">`
            + `<div class="skipmon-pv-info-cell">`
            +   `<div class="skipmon-pv-info-label">Next leader in</div>`
            +   `<div class="skipmon-pv-info-value">${esc(countdown)}</div>`
            + `</div>`
            + `<div class="skipmon-pv-info-cell">`
            +   `<div class="skipmon-pv-info-label">Slot #</div>`
            +   `<div class="skipmon-pv-info-value" style="font-size:0.78rem">${esc(slotDisplay)}</div>`
            + `</div>`
            + `<div class="skipmon-pv-info-cell">`
            +   `<div class="skipmon-pv-info-label">Elapsed</div>`
            +   `<div class="skipmon-pv-info-value" style="font-size:0.78rem">${fmtNum(d.elapsed)} / ${fmtNum(d.assigned)}</div>`
            + `</div>`
            + `</div>`;
        } else {
          infoHtml = `<div class="skipmon-pv-info-box">Epoch completed</div>`;
        }

        // Slot timeline — show for both epochs. Current epoch also gets upcoming
        // hollow pips; last epoch is complete so there are none. Ordering is by
        // status (green → red → hollow), not chronological — same convention the
        // slot-explorer modal uses when it hasn't fetched per-slot history.
        let timelineHtml = '';
        const produced = d.produced || 0;
        const skipped  = d.skipped || 0;
        const upcoming = d.isCurrent ? (d.upcoming || 0) : 0;
        if (produced + skipped + upcoming > 0) {
          // RENDERING STRATEGY:
          // Aggregate getBlockProduction is the ONLY ground truth for how
          // many slots were produced vs skipped. Per-slot getBlock data is
          // used purely to position red pips at the right chronological
          // location — it must NEVER override the aggregate count.
          //
          // Why: getBlock returns null/errors for two indistinguishable
          // cases — (a) the block was genuinely skipped, and (b) the block
          // was produced but isn't yet finalized (current epoch) or has
          // been pruned from RPC history (previous epoch). A naïve "not
          // in producedSet → skipped" rule paints lag/pruned slots red.
          //
          // Fix: walk pastSlots chronologically with a `redBudget` capped
          // at the aggregate `skipped` count. Slots missing from
          // producedSet consume budget; once exhausted, further missing
          // slots are rendered green (treated as confirmation-lag false
          // positives, not real skips). This guarantees the timeline can
          // never show more red than the stats panel says exist.
          //
          // When aggregate skipped is 0, no per-slot data can produce red
          // pips at all — equivalent to the grouped fallback, so we just
          // take that path directly.
          const perSlotAvailable = d.producedSet && Array.isArray(d.pastSlots);

          const SK_BUILD_CAP = SLOT_TL_MAX + 200; // bound string building for huge validators
          const pipObjs = [];
          if (perSlotAvailable && skipped > 0) {
            let redBudget = skipped;
            d.pastSlots.forEach(s => {
              if (d.producedSet.has(s)) { pipObjs.push({ html: '<div class="skipmon-pv-pip produced"></div>', red: false }); return; }
              if (redBudget > 0) { redBudget--; pipObjs.push({ html: '<div class="skipmon-pv-pip skipped"></div>', red: true }); return; }
              pipObjs.push({ html: '<div class="skipmon-pv-pip produced"></div>', red: false });
            });
            const upN = Math.min((d.upcomingSlots || []).length, SK_BUILD_CAP);
            for (let i = 0; i < upN; i++) pipObjs.push({ html: '<div class="skipmon-pv-pip upcoming"></div>', red: false });
          } else {
            // No per-slot data yet, OR aggregate says zero skips (all green/upcoming).
            const prodN = Math.min(produced, SK_BUILD_CAP);
            for (let i = 0; i < prodN; i++) pipObjs.push({ html: '<div class="skipmon-pv-pip produced"></div>', red: false });
            for (let i = 0; i < skipped; i++) pipObjs.push({ html: '<div class="skipmon-pv-pip skipped"></div>', red: true });
            const upN = Math.min(upcoming, SK_BUILD_CAP);
            for (let i = 0; i < upN; i++) pipObjs.push({ html: '<div class="skipmon-pv-pip upcoming"></div>', red: false });
          }
          const legends = [
            produced > 0 ? '<span class="skipmon-pv-tl-leg"><span class="skipmon-pv-pip produced"></span> Produced</span>' : '',
            skipped  > 0 ? '<span class="skipmon-pv-tl-leg"><span class="skipmon-pv-pip skipped"></span> Skipped</span>' : '',
            upcoming > 0 ? '<span class="skipmon-pv-tl-leg"><span class="skipmon-pv-pip upcoming"></span> Upcoming</span>' : ''
          ].filter(Boolean).join('');
          const assignedTotal = produced + skipped + upcoming;
          timelineHtml = `<div class="skipmon-pv-tl-wrap">`
            + `<div class="skipmon-pv-tl-label">Slot timeline ${legends}</div>`
            + assembleSlotTimeline(pipObjs, 'skipmon-pv-tl', assignedTotal)
            + `</div>`;
        }

        return `<div class="${panelCls}">`
             +   headerHtml
             +   statsHtml
             +   barHtml
             +   infoHtml
             +   timelineHtml
             + `</div>`;
      }

      function renderAll() {
        renderStats();
        renderTimeline();
        if (state && state.scope === 'portfolio') {
          renderPortfolioView();
        } else if (state && state.scope === 'lookup') {
          renderLookupView();
        } else {
          renderGrid();
          renderFeed();
          renderTop();
        }
      }

      // ── Lifecycle ──────────────────────────────────────────
      async function start() {
        if (state && state.running) return;
        if (!state) state = freshState('network');
        state.running = true;
        setLiveStatus(true, 'Live');
        renderAll();   // reflect preserved state immediately on re-entry

        // Ensure we have a schedule map (skip if we already rebuilt it this session)
        if (!state.epoch) {
          try {
            await rebuildSlotMap();
          } catch (e) {
            console.warn('[SkipMonitor] schedule load failed:', e);
            setLiveStatus(false, 'Schedule unavailable');
            state.running = false;
            return;
          }
          if (!state || !state.running) return;   // tab left during the load
        }

        await tick();
        // The user may have left the tab during the awaits above; stop()
        // already ran and cleared (null) timers — don't create new ones now.
        if (!state || !state.running) return;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer  = setInterval(tick,        POLL_INTERVAL_MS);
        // UI ticker: re-runs stats + timeline every second so the NOW marker
        // advances smoothly between RPC ticks via interpolated head.
        uiTimer    = setInterval(() => {
          if (!PowerSaver.isActive()) return;   // nothing to animate for nobody
          renderStats();
          renderTimeline();
        }, UI_TICK_MS);

        // Staggered kickoff for the heavier aggregate polls.
        //
        // Why: pollEpoch and pollPrevEpoch each issue a getBlockProduction
        // that can scan hundreds of thousands of slots — 5–15 s per call on
        // a loaded RPC. If they all fired synchronously alongside tick(),
        // they'd saturate the shared 4-slot rpcCall queue and starve any
        // work the user does in other tabs (loadPortfolio, validator lookup)
        // for the duration.
        //
        // Each setTimeout rechecks `state.running` at fire time so a quick
        // tab-switch cancels pending kick-offs before they start.
        const safely = (fn, delay) => setTimeout(() => {
          if (state && state.running) fn();
        }, delay);
        safely(pollHour,      2000);
        safely(pollEpoch,     5000);
        safely(pollPrevEpoch, 12000);   // heaviest — defer longest
        // TPS polling lives at the top level now (init()) so the top-bar
        // readout stays fresh on every tab, not just Network Live. We just
        // kick the cache once here to ensure renderTpsStrip() has data to
        // draw as soon as the tab opens.
        safely(() => {
          if (typeof loadTpsSamples === 'function') loadTpsSamples();
        }, 1500);
        // Epoch timeline: up to 7 getBlockProduction calls fanning out across
        // the last 6 epochs + current. Deferred the longest so it never fights
        // the user's first interactions on this tab. The loader itself caches
        // per-epoch, so later tab visits within the same epoch are free.
        // We only prefetch here — no DOM work — since the bars live inside a
        // modal that may never be opened. openEpochTimelineModal() triggers
        // the actual render and pulls from the warm cache.
        safely(() => {
          if (typeof loadNetworkEpochHistory === 'function') loadNetworkEpochHistory();
        }, 20000);
        if (hourTimer)  clearInterval(hourTimer);
        if (epochTimer) clearInterval(epochTimer);
        hourTimer  = setInterval(pollHour,  HOUR_POLL_MS);
        epochTimer = setInterval(pollEpoch, EPOCH_POLL_MS);
        // 15-minute refresh is plenty — the loader's per-epoch cache returns
        // instantly when the current epoch hasn't advanced, so most ticks
        // cost nothing. We only pay the ~7-RPC fan-out when the chain
        // crosses an epoch boundary. This just warms the cache; re-rendering
        // happens the next time the user opens the Past Epochs modal.
        epochTimelineTimer = setInterval(() => {
          if (state && state.running && typeof loadNetworkEpochHistory === 'function') {
            loadNetworkEpochHistory();
          }
        }, 15 * 60 * 1000);
      }

      function stop() {
        if (!state || !state.running) return;
        state.running = false;
        if (pollTimer)  clearInterval(pollTimer);
        if (uiTimer)    clearInterval(uiTimer);
        if (hourTimer)  clearInterval(hourTimer);
        if (epochTimer) clearInterval(epochTimer);
        if (epochTimelineTimer) clearInterval(epochTimelineTimer);
        pollTimer = uiTimer = hourTimer = epochTimer = epochTimelineTimer = null;
        setLiveStatus(false, 'Paused');
      }

      function setScope(scope) {
        if (!state) state = freshState(scope);
        if (state.scope === scope) return;
        const prevScope = state.scope;
        state.scope = scope;
        // Invalidate feed render marker so incremental-render does a clean rebuild
        // under the new filter (otherwise we'd be appending to the wrong filtered list).
        state.feedRenderedTopSlot = null;
        // Toggle the layout mode class on the wrap — CSS hides whichever layout
        // doesn't match the active scope.
        const wrap = document.querySelector('#skipmonitorTab .skipmon-wrap');
        if (wrap) {
          wrap.classList.toggle('skipmon-mode-network',   scope === 'network');
          wrap.classList.toggle('skipmon-mode-portfolio', scope === 'portfolio');
          wrap.classList.toggle('skipmon-mode-lookup',    scope === 'lookup');
        }
        const nBtn = document.getElementById('skipmonScopeNetwork');
        const pBtn = document.getElementById('skipmonScopePortfolio');
        const lBtn = document.getElementById('skipmonScopeLookup');
        if (nBtn) nBtn.classList.toggle('active', scope === 'network');
        if (pBtn) pBtn.classList.toggle('active', scope === 'portfolio');
        if (lBtn) lBtn.classList.toggle('active', scope === 'lookup');
        // Leaving lookup mode: clear the dropdown so it doesn't flash back on return.
        // (Selected validator is preserved in state so it re-renders on return.)
        if (prevScope === 'lookup' && scope !== 'lookup') {
          const results = document.getElementById('skipmonLookupResults');
          if (results) results.innerHTML = '';
        }
        renderAll();
      }

      // Validator Lookup: handle typing in the search input. Uses allValidators
      // (already loaded for the rest of the app) so lookup is instant — no RPC calls.
      // We score name exact → prefix → contains → pubkey-contains, matching the
      // main Validator Lookup tab's behavior, and cap the dropdown at 10 items.
      function handleLookupInput() {
        const input   = document.getElementById('skipmonLookupInput');
        const results = document.getElementById('skipmonLookupResults');
        if (!input || !results) return;
        const raw = input.value.trim();
        if (!raw) { results.innerHTML = ''; return; }
        if (!Array.isArray(allValidators) || allValidators.length === 0) {
          results.innerHTML = `<div class="skipmon-lookup-empty">Validator set still loading…</div>`;
          return;
        }
        const q = raw.toLowerCase();
        const scored = [];
        for (const v of allValidators) {
          const name = (v.name || '').toLowerCase();
          const vote = (v.votePubkey || '').toLowerCase();
          const node = (v.nodePubkey || '').toLowerCase();
          let score = 0;
          if (name === q)                 score = 100;
          else if (name.startsWith(q))    score = 80;
          else if (name.includes(q))      score = 60;
          else if (vote.includes(q) || node.includes(q)) score = 20;
          if (score > 0) scored.push({ v, score });
        }
        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, 10).map(x => x.v);
        if (top.length === 0) {
          results.innerHTML = `<div class="skipmon-lookup-empty">No validators match "${esc(raw)}"</div>`;
          return;
        }
        results.innerHTML = top.map(v => {
          const av = avatarFor(v);
          const short = (v.votePubkey || '').slice(0, 10) + '…' + (v.votePubkey || '').slice(-6);
          return `<div class="skipmon-lookup-result" `
               +      `data-mousedown="skipmon-lookup-pick" data-vote="${esc(v.votePubkey)}">`
               +   `<div class="skipmon-lookup-result-logo" style="${av.style}">${av.inner}</div>`
               +   `<div class="skipmon-lookup-result-info">`
               +     `<div class="skipmon-lookup-result-name">${esc(v.name || short)}</div>`
               +     `<div class="skipmon-lookup-result-addr">${esc(short)}</div>`
               +   `</div>`
               + `</div>`;
        }).join('');
      }

      // Dropdown dismiss. Delayed so the data-mousedown pick on a result item
      // can run before the blur wipes the list.
      function handleLookupBlur() {
        setTimeout(() => {
          const results = document.getElementById('skipmonLookupResults');
          if (results) results.innerHTML = '';
        }, 150);
      }

      // Pick a result: stash the vote pubkey and re-render.
      function pickLookup(votePubkey) {
        if (!state) state = freshState('lookup');
        state.lookupVotePubkey = votePubkey;
        // Populate the input with the selected validator's name so it's clear
        // what's being shown, and clear the results dropdown.
        const v = allValidators && allValidators.find(x => x.votePubkey === votePubkey);
        const input   = document.getElementById('skipmonLookupInput');
        const results = document.getElementById('skipmonLookupResults');
        if (input && v) input.value = v.name || votePubkey;
        if (results)    results.innerHTML = '';
        renderLookupView();
      }

      function toggleTopExpanded() {
        if (!state) return;
        state.topExpanded = !state.topExpanded;
        renderTop();
      }

      // Lookup the produced/skipped status of a specific absolute slot from the live cache.
      // Used by the leader bar to color the 4 block dots. Returns 'produced' | 'skipped' | null.
      function getSlotStatus(slot) {
        if (!state || !state.slots || !state.slots.length) return null;
        // state.slots is ascending by slot; newest at the end. Scan from the end since
        // the leader bar almost always asks about very recent slots.
        for (let i = state.slots.length - 1; i >= 0; i--) {
          if (state.slots[i].slot === slot) {
            return state.slots[i].produced ? 'produced' : 'skipped';
          }
          if (state.slots[i].slot < slot) break; // ascending scan guard
        }
        return null;
      }

      // Public helper: return the full scorecard HTML for a given vote
      // address, so top-level UI (the scorecard modal) can render the same
      // wide "last epoch / current epoch" view the Validator Lookup scope uses.
      function getScorecardHtml(votePubkey) {
        const v = allValidators && allValidators.find(x => x.votePubkey === votePubkey);
        if (!v) return null;
        return renderPortfolioCard(v);
      }

      return { start, stop, setScope, renderAll, toggleTopExpanded, handleLookupInput, handleLookupBlur, pickLookup, getSlotStatus, scrubberJumpTo, getScorecardHtml };
    })();

    // Bridges used by the data-action handlers below (and index.html)
    function setSkipMonitorScope(s) {
      if (typeof SkipMonitor !== 'undefined') SkipMonitor.setScope(s);
    }
    function skipmonJumpToValidator(nodePubkey) {
      const v = (typeof getValidatorByNodePubkey === 'function')
        ? getValidatorByNodePubkey(nodePubkey) : null;
      if (!v) return;
      skipmonOpenScorecard(v.votePubkey);
    }
    function skipmonToggleTop() {
      if (typeof SkipMonitor !== 'undefined') SkipMonitor.toggleTopExpanded();
    }

    // Mini-scrubber click → jump the main Recent Slots grid to that bucket.
    function skipmonScrubberJump(index) {
      if (typeof SkipMonitor !== 'undefined' && SkipMonitor.scrubberJumpTo) {
        SkipMonitor.scrubberJumpTo(index);
      }
    }

    Actions.register({
      'skipmon-jump':            (el, e, d) => skipmonJumpToValidator(d.node),
      'skipmon-scrub':           (el, e, d) => skipmonScrubberJump(Number(d.idx) || 0),
      'skipmon-toggle-top':      () => skipmonToggleTop(),
      // skipmonOpenPortfolioModal / skipmonLookupPick live in js/modals.js (resolved at click time).
      'skipmon-portfolio-modal': (el, e, d) => skipmonOpenPortfolioModal(d.node, d.name, d.vote),
      'skipmon-lookup-pick':     (el, e, d) => skipmonLookupPick(d.vote),
    });

    // ── Epoch Timeline modal ────────────────────────────────────
    // Opens the historical skip-rate chart. Data is prefetched 20s
    // after SkipMonitor.start so the modal usually populates instantly;
    // if the user clicks before the fetch finishes, renderEpochTimeline
    // awaits the in-flight load and fills in when it resolves.
    function openEpochTimelineModal() {
      const modal = document.getElementById('epochTimelineModal');
      if (!modal) return;
      modal.style.display = 'flex';
      if (typeof renderEpochTimeline === 'function') renderEpochTimeline();
    }
    function closeEpochTimelineModal() {
      const modal = document.getElementById('epochTimelineModal');
      if (modal) modal.style.display = 'none';
    }

    // ── TPS modal ──────────────────────────────────────────────
    // Expands the TPS sparkline into a full-height chart with axis
    // gridlines and richer stats. Uses the same tpsSamplesCache that
    // feeds the inline strip, so there's no extra RPC on open.
    function openTpsModal() {
      const modal = document.getElementById('tpsModal');
      if (!modal) return;
      modal.style.display = 'flex';
      renderTpsModal();
    }
    function closeTpsModal() {
      const modal = document.getElementById('tpsModal');
      if (modal) modal.style.display = 'none';
      // Reset tooltip state on close so it doesn't reopen stale on next open.
      _tpsHoveredBucket = null;
      _tpsPinnedBucket  = null;
      _tpsTxData        = {};
      _tpsBucketMeta    = null;
      _tpsBucketGeom    = null;
    }

