    // ═══════════════════════════════════════════════════════
    // POWER SAVER — idle + hidden-tab throttling.
    // A window left open used to work exactly as hard as one being used:
    // the globe rendered 60 fps forever and the Network tab fired ~100 RPC
    // calls a minute even when hidden. Now:
    //   • hidden tab, or no mouse/keyboard/touch for IDLE_AFTER_MS → "idle"
    //   • every poller asks PowerSaver.gate(key) before doing work; while
    //     idle a key is allowed through once per IDLE_EVERY_MS (60 s)
    //   • the globe stops rotating and its render loop pauses while idle
    //   • any activity ends idle immediately; pollers catch up on their next
    //     tick (2–3 s for the fast ones)
    // ═══════════════════════════════════════════════════════
    const PowerSaver = (function () {
      const IDLE_AFTER_MS = 3 * 60 * 1000;
      const IDLE_EVERY_MS = 60 * 1000;
      let lastActivity = Date.now();
      let idle = false;
      let timer = null;
      const lastAllowed = {};
      const listeners = new Set();

      function hidden() { return typeof document !== 'undefined' && document.hidden; }
      function isActive() { return !idle && !hidden(); }

      function setIdle(v) {
        if (idle === v) return;
        idle = v;
        document.body.classList.toggle('power-idle', idle);
        const pill = document.getElementById('powerSaverPill');
        if (pill) pill.hidden = !idle;
        listeners.forEach(fn => { try { fn(isActive()); } catch (e) {} });
        if (window.x1hqDebug) console.info('[power] ' + (idle ? 'idle — live updates slowed' : 'active — live updates resumed'));
      }

      function armTimer() {
        clearTimeout(timer);
        timer = setTimeout(() => setIdle(true), IDLE_AFTER_MS);
      }

      function activity() {
        lastActivity = Date.now();
        if (idle) setIdle(false);
        armTimer();
      }

      // Pollers call this; returns true when the work should run now.
      function gate(key, idleEveryMs) {
        if (isActive()) return true;
        const every = idleEveryMs || IDLE_EVERY_MS;
        const now = Date.now();
        if (!lastAllowed[key] || now - lastAllowed[key] >= every) { lastAllowed[key] = now; return true; }
        return false;
      }

      function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

      ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(ev =>
        window.addEventListener(ev, activity, { passive: true, capture: true }));
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) { clearTimeout(timer); setIdle(true); }
        else activity();
      });
      armTimer();

      // forceIdle(true/false) exists for testing from the console.
      return { gate, isActive, onChange, forceIdle: v => { clearTimeout(timer); setIdle(!!v); if (!v) armTimer(); }, get idle() { return idle; }, get lastActivity() { return lastActivity; } };
    })();

    // ═══════════════════════════════════════════════════════
    // ROUTER — hash routes so every tab / validator / leaderboard /
    // comparison is linkable and back/forward work.
    //   #/lookup/<vote>          (alias #/v/<vote>)
    //   #/leaderboard/<category>
    //   #/compare/<vote>,<vote>,…
    //   #/calculators/<staking|compound|unstaking|breakeven>
    //   #/live  #/terminal  #/datacenter  #/delegation  #/globe
    // Tab handlers call Router.set(); hashchange/popstate call
    // Router.apply(), which replays the route through the same handlers
    // with `applying` set so they don't push it back.
    // ═══════════════════════════════════════════════════════
    const Router = (function () {
      const TAB_TO_ROUTE = { skipmonitor: '/live', vtterminal: '/terminal', lookup: '/lookup', portfolio: '/datacenter',
                             leaderboard: '/leaderboard', compare: '/compare', calculators: '/calculators', delegation: '/delegation', map: '/globe' };
      const ROUTE_TO_TAB = Object.fromEntries(Object.entries(TAB_TO_ROUTE).map(([t, r]) => [r.slice(1), t]));
      const PK = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
      let applying = false;
      let started = false;
      let lastApplied = null;   // route string last applied (or pushed by set())

      function current() { return decodeURIComponent((location.hash || '').replace(/^#/, '')); }

      function set(route) {
        // Ignore route pushes until start() has applied the initial deep
        // link — otherwise a render during page load would clobber it.
        if (applying || !started) return;
        const next = '#' + route;
        lastApplied = route;
        if (location.hash === next) return;
        try { history.pushState(null, '', next); } catch (e) { location.hash = route; }
      }

      function onTab(tab) {
        if (applying || !started) return;
        const base = TAB_TO_ROUTE[tab];
        if (!base) return;
        // Don't clobber a more specific route for the same tab (e.g. we are
        // already at #/lookup/<vote> and lookupValidator just switched tabs).
        if (current().startsWith(base + '/')) return;
        set(base);
      }

      function apply(route) {
        const parts = route.replace(/^\/+/, '').split('/').filter(Boolean);
        if (!parts.length) return false;
        let [head, ...rest] = parts;
        if (head === 'v') head = 'lookup';
        const tab = ROUTE_TO_TAB[head];
        if (!tab) return false;
        applying = true;
        try {
          if (tab === 'lookup' && rest[0] && PK.test(rest[0])) {
            lookupValidator(rest[0]);
          } else if (tab === 'leaderboard' && rest[0]) {
            switchTab('leaderboard');
            const btn = document.querySelector(`.leaderboard-cat-btn[data-category="${CSS.escape(rest[0])}"]`);
            if (btn) switchLeaderboard(rest[0]);
          } else if (tab === 'compare' && rest[0]) {
            switchTab('compare');
            const votes = rest[0].split(',').filter(v => PK.test(v)).slice(0, 4);
            const have = new Set(compareValidators.map(v => v.votePubkey));
            (async () => {
              for (const v of votes) { if (!have.has(v)) { try { await addToComparison(v); } catch (e) { console.warn('[router] compare add failed', v, e); } } }
            })();
          } else if (tab === 'calculators' && rest[0]) {
            switchTab('calculators');
            const btn = document.querySelector(`.calc-nav-btn[data-calc="${CSS.escape(rest[0])}"]`);
            if (btn) switchCalculator(rest[0]);
          } else {
            switchTab(tab);
          }
        } finally { applying = false; }
        return true;
      }

      // A hash navigation (typed URL, clicked #-link, back/forward) fires BOTH
      // popstate and hashchange, so route once per distinct route — otherwise
      // apply() ran twice and e.g. #/compare/<vote> added the validator twice
      // (addToComparison's duplicate check sits before its awaits).
      function onNavigate() {
        const r = current();
        if (r === lastApplied) return;
        lastApplied = r;
        apply(r);
      }

      function start() {
        if (started) return; started = true;
        window.addEventListener('hashchange', onNavigate);
        window.addEventListener('popstate', onNavigate);
        const r = current();
        if (r) { lastApplied = r; apply(r); }
      }

      function link(route) { return location.origin + location.pathname + '#' + route; }

      return { set, onTab, apply, start, link, get applying() { return applying; } };
    })();

    // Share a validator: native share sheet on phones, clipboard elsewhere.
    async function shareValidator(voteAccount, name, buttonEl) {
      const url = Router.link('/lookup/' + voteAccount);
      const title = (name ? name + ' — ' : '') + 'X1 Validator HQ';
      try {
        if (navigator.share && window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
          await navigator.share({ title, url });
          return;
        }
        await navigator.clipboard.writeText(url);
        if (typeof showToast === 'function') showToast('Link copied: ' + url);
        if (buttonEl) {
          const orig = buttonEl.innerHTML;
          buttonEl.innerHTML = buttonEl.classList.contains('share-icon-btn') ? CARD_ICONS.check : '<span>✓ Copied</span>';
          buttonEl.classList.add('is-copied');
          setTimeout(() => { buttonEl.innerHTML = orig; buttonEl.classList.remove('is-copied'); }, 1500);
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return;   // user dismissed the share sheet
        console.warn('[share] failed', e);
        window.prompt('Copy this link:', url);
      }
    }

    function switchTab(tab) {
      // Move the network stats + epoch panel into the Validator Terminal
      // tab's slot (between vt-head and the KPI grid) when that tab is
      // active, or back to its natural position above the tabs row for any
      // other tab. The elements themselves keep their IDs, so all the live
      // updaters (totalValidators, currentSlot, epochProgressFill, ...)
      // keep working regardless of where the nodes currently live.
      (function repositionStats() {
        const main = document.querySelector('main');
        const tabsRow = main && main.querySelector('.tabs');
        const stats = document.getElementById('networkStats');
        const epoch = document.getElementById('epochProgress');
        const slot = document.getElementById('vtStatsSlot');
        if (!main || !tabsRow || !stats || !epoch || !slot) return;
        if (tab === 'vtterminal') {
          // Move into the terminal's slot, in order (stats above epoch).
          slot.appendChild(stats);
          slot.appendChild(epoch);
        } else {
          // Restore to natural position above the tabs row, but only if
          // they're not already there (avoid spurious DOM churn).
          if (stats.parentElement !== main) main.insertBefore(stats, tabsRow);
          if (epoch.parentElement !== main) main.insertBefore(epoch, tabsRow);
        }
      })();

      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      // Tab button may not exist (e.g. skipmonitor has no visible button),
      // so guard against null.
      const tabBtn = document.querySelector(`.tab[data-tab="${CSS.escape(tab)}"]`);
      if (tabBtn) tabBtn.classList.add('active');

      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById(tab + 'Tab').classList.add('active');

      // Leaving the Lookup tab cancels any in-flight result hydration. Those
      // calls share one global 3-slot RPC queue with everything else; if we let
      // them keep draining, the tab the user just opened (e.g. Data Center)
      // would stall behind the backlog. Bumping the search id makes pending
      // hydration workers bail before launching more requests.
      if (tab !== 'lookup') {
        _searchRequestId++;
      }

      if (tab === 'portfolio') {
        loadPortfolio();
      }

      // Lookup tab: silently refresh the validator list if it's older
      // than 5 minutes. New validators that joined since page-load won't
      // appear in searches otherwise — users were having to hard-refresh
      // the whole app to find recently-added validators.
      if (tab === 'lookup') {
        const FIVE_MIN = 5 * 60 * 1000;
        const cacheAge = Date.now() - (allValidatorsFetchedAt || 0);
        if (allValidatorsFetchedAt > 0 && cacheAge > FIVE_MIN) {
          loadNetworkStats().catch(err =>
            console.warn('[switchTab lookup] background refresh failed:', err)
          );
        }
      }
      
      if (tab === 'map') {
        if (!window.mapInitialized) {
          initializeMap();
        } else if (validatorMap) {
          // Re-measure the globe canvas when returning to the map tab — the
          // container had zero size while hidden.
          setTimeout(resizeGlobe, 100);
        }
      }
      
      if (tab === 'leaderboard') {
        loadLeaderboard();
      }

      if (tab === 'delegation' && typeof window.delegOpen === 'function') {
        window.delegOpen();
      }
      
      if (tab === 'calculators') {
        initializeCalculators();
      }

      // Skip Monitor: only poll while its tab is visible, preserve state across switches.
      // The body class drives the flex reordering of <main>'s children on this tab.
      if (tab === 'skipmonitor') {
        document.body.classList.add('active-skipmonitor');
        if (typeof SkipMonitor !== 'undefined') SkipMonitor.start();
      } else {
        document.body.classList.remove('active-skipmonitor');
        if (typeof SkipMonitor !== 'undefined') SkipMonitor.stop();
      }

      // Validator Terminal: kick off fetch + auto-refresh on entry,
      // stop the auto-refresh timer when the user navigates away. The stats
      // panel relocation is handled by the repositionStats IIFE at the top
      // of switchTab; the body class is kept for any CSS hooks.
      if (tab === 'vtterminal') {
        document.body.classList.add('active-vtterminal');
        if (typeof window.vtOpen === 'function') window.vtOpen();
      } else {
        document.body.classList.remove('active-vtterminal');
        if (typeof window.vtClose === 'function') window.vtClose();
      }

      // Keep the URL in sync so every tab is linkable (Router below). Tabs
      // with their own sub-state (lookup, leaderboard, compare, calculators)
      // push a more specific route from their own handlers.
      if (typeof Router !== 'undefined') Router.onTab(tab);
    }

    Actions.register({
      'tab': (el, e, d) => switchTab(d.tab),
    });
