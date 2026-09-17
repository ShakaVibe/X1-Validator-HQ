    // ─────────────────────────────────────────────────────────────────────
    // PRODUCTION LOGGING GATE
    // The app logs operational detail — including the connected wallet address
    // and transaction metadata — to the browser console. On a live finance
    // site that is more exposure than necessary, so verbose logging is OFF by
    // default. console.error and console.warn are KEPT so real problems are
    // still diagnosable in production. To re-enable full logging for
    // troubleshooting, load the page with ?debug=1 in the URL, or run
    //   localStorage.setItem('x1hq_debug','1')
    // in the console and reload. Nothing here logs secret keys (verified).
    // ─────────────────────────────────────────────────────────────────────
    (function() {
      var debugOn = false;
      try {
        var qs = new URLSearchParams(window.location.search);
        debugOn = qs.get('debug') === '1' ||
                  (window.localStorage && localStorage.getItem('x1hq_debug') === '1');
      } catch (e) { /* storage/URL access can throw in rare contexts; stay quiet */ }
      if (!debugOn) {
        var noop = function() {};
        // Silence verbose channels only. Leave error/warn intact.
        console.log = noop;
        console.debug = noop;
        console.info = noop;
      }
    })();

    // ─────────────────────────────────────────────────────────────────────
    // SECURITY HELPERS (XSS defense)
    // Validator names, icon URLs, and websites come from on-chain config
    // accounts that ANY participant can write arbitrary data into. They must
    // never be placed into the DOM as raw HTML. Use these helpers at every
    // injection point.
    //
    //   escHtml(s)  -> safe for text content AND double-quoted attribute values
    //   escAttrJs(s)-> safe to embed inside a single-quoted JS string that is
    //                  itself inside an HTML attribute (the onclick="fn('...')"
    //                  double-context case). Prefer NOT building inline handlers
    //                  from data at all, but where unavoidable this blocks
    //                  breakout via quotes, angle brackets, and backslashes.
    //   safeUrl(u)  -> returns the URL only if it is a safe http(s) (or
    //                  protocol-relative) URL; otherwise returns '' so that
    //                  javascript:, data:, vbscript: etc. cannot execute.
    // ─────────────────────────────────────────────────────────────────────
    function escHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }
    function escAttrJs(s) {
      // Escape for a single-quoted JS string sitting inside an HTML attribute.
      // Order matters: backslash first, then the characters that could break
      // out of either the JS string or the surrounding HTML attribute.
      // `&` FIRST: the HTML parser decodes entities (&#39; -> ') before the
      // JS engine sees the string, so an unescaped & lets a value like
      // x&#39;);alert(1);// close the JS string. Escaping & to &amp; makes
      // the parser hand JS a literal ampersand instead.
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, '\\&#39;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\r?\n/g, ' ');
    }
    function safeUrl(u) {
      const v = String(u == null ? '' : u).trim();
      if (v === '') return '';
      // Allow only http(s) and protocol-relative URLs. Reject anything else,
      // including javascript:, data:, vbscript:, and control-char tricks.
      // Every caller interpolates the result into an HTML attribute
      // (src="..."), so the value must also be HTML-escaped — otherwise a
      // URL containing "> breaks out of the attribute. Scheme check alone
      // was not enough.
      if (/^https?:\/\//i.test(v)) return escHtml(v);
      if (/^\/\//.test(v)) return escHtml(v);          // protocol-relative //host/...
      if (/^\//.test(v) && !/^\/\//.test(v)) return escHtml(v); // site-relative /path
      return '';
    }

    // ─────────────────────────────────────────────────────────────────────
    // ACTIONS — delegated event dispatcher (C2)
    //
    // Replaces inline on* attributes so the CSP can eventually drop
    // 'unsafe-inline' from script-src. Markup carries DATA, not code:
    //
    //   <button data-action="card-share" data-vote="…" data-name="…">
    //   <img data-onerror="img-fallback">          <select data-change="…">
    //   <input data-input="…">
    //
    // Each file registers its own handlers at the end of the file:
    //
    //   Actions.register({ 'card-share': (el, e, d) => shareValidator(d.vote, d.name, el) });
    //
    // Handler signature: (el, event, dataset). `el` is the element carrying
    // the attribute (what `this` used to be); values are strings — coerce
    // numbers with Number(). Attribute values must be written with
    // escHtml() (double-quoted attribute context), never escAttrJs().
    //
    // Semantics mirror the old inline handlers: the event walks up from the
    // target through every ancestor carrying the attribute (bubbling), a
    // handler may call e.stopPropagation() to stop that walk, and when it
    // does the dispatcher also stops the document-level "click outside"
    // listeners registered later (exactly what the inline version achieved,
    // since the event never reached document). core.js loads first, so
    // these listeners are always the first ones on document.
    // ─────────────────────────────────────────────────────────────────────
    const Actions = (function () {
      const handlers = Object.create(null);
      const ATTRS = [
        ['click',  'data-action',  false],
        ['change', 'data-change',  false],
        ['input',  'data-input',   false],
        ['error',  'data-onerror', true],   // error does not bubble: capture
        ['load',   'data-onload',  true],
      ];
      function register(map) {
        for (const name in map) {
          if (handlers[name]) console.warn('[Actions] duplicate handler', name);
          handlers[name] = map[name];
        }
      }
      function dispatch(evt, attr) {
        let el = evt.target instanceof Element ? evt.target.closest('[' + attr + ']') : null;
        while (el) {
          const name = el.getAttribute(attr);
          const fn = handlers[name];
          if (typeof fn === 'function') {
            try {
              fn.call(el, el, evt, el.dataset);
            } catch (err) {
              console.error('[Actions] ' + attr + '="' + name + '" threw', err);
            }
            if (evt.cancelBubble) { evt.stopImmediatePropagation(); return; }
          } else {
            console.warn('[Actions] no handler registered for ' + attr + '="' + name + '"');
          }
          el = el.parentElement ? el.parentElement.closest('[' + attr + ']') : null;
        }
      }
      ATTRS.forEach(([type, attr, capture]) => {
        document.addEventListener(type, evt => dispatch(evt, attr), capture);
      });
      // Shared helpers used by more than one file.
      register({
        // data-action="stop" — the element only needs event.stopPropagation()
        // (e.g. a link inside a clickable tile).
        'stop': (el, e) => e.stopPropagation(),
        // <img … data-onerror="img-fallback"> — hide the broken image, show the
        // placeholder that immediately follows it.
        'img-fallback': (el) => {
          el.style.display = 'none';
          const next = el.nextElementSibling;
          if (next) next.style.display = 'flex';
        },
      });
      return { register, has: (name) => typeof handlers[name] === 'function' };
    })();
    window.Actions = Actions;

    // ─────────────────────────────────────────────────────────────────────
    // ADDRESS VALIDATION
    // Length-only checks (e.g. "32–44 chars") accept non-base58 garbage and
    // typos that happen to be the right length. For irreversible actions like
    // changing a stake/vote authority or choosing a withdraw destination, that
    // is dangerous. isValidPubkey() defers to solanaWeb3's own base58 +
    // on-curve parser, which is the authoritative definition of a valid key.
    // Returns true only if the string parses to a real PublicKey.
    // ─────────────────────────────────────────────────────────────────────
    function isValidPubkey(addr) {
      const v = String(addr == null ? '' : addr).trim();
      if (v.length < 32 || v.length > 44) return false; // cheap pre-filter
      // web3.js is loaded with `defer`; until it arrives, accept the base58
      // shape (32–44 chars, no 0/O/I/l) — the on-curve check runs once it is here.
      if (typeof solanaWeb3 === 'undefined') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
      try {
        // Throws on invalid base58 or wrong byte length.
        const pk = new solanaWeb3.PublicKey(v);
        // Round-trip guard: the parsed key must serialize back to the same
        // string, rejecting inputs base58 accepts but that aren't canonical.
        return pk.toBase58() === v;
      } catch (e) {
        return false;
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // SAFE u64 LAMPORTS SERIALIZATION
    // Several hand-built instructions (Stake Split, Vote Withdraw) encode a
    // lamports amount as a little-endian u64. The previous code did this with
    // bitwise/Math.floor tricks (`amount & 0xffffffff`, `Math.floor(amount /
    // 0x100000000)`). That happens to produce correct bytes up to
    // Number.MAX_SAFE_INTEGER (2^53 lamports ≈ 9,007,199 XNT), but ABOVE that
    // a JavaScript Number has already silently lost integer precision — so the
    // bytes signed would not match the amount the user intended.
    //
    // writeU64LE centralizes this and converts that silent-corruption risk
    // into a LOUD, SAFE failure: if the amount is not a clean non-negative
    // integer within the precise range, it throws BEFORE any transaction is
    // built or signed, so the user can never sign a wrong-amount transaction.
    // Within the safe range it writes the exact u64 via setBigUint64.
    // ─────────────────────────────────────────────────────────────────────
    function writeU64LE(dataView, offset, amountLamports) {
      // Reject anything that isn't a finite, non-negative, integer Number that
      // is exactly representable. This is intentionally strict.
      if (typeof amountLamports !== 'number' || !Number.isFinite(amountLamports)) {
        throw new Error('Invalid amount: not a finite number.');
      }
      if (!Number.isInteger(amountLamports)) {
        throw new Error('Invalid amount: lamports must be a whole number.');
      }
      if (amountLamports < 0) {
        throw new Error('Invalid amount: cannot be negative.');
      }
      if (amountLamports > Number.MAX_SAFE_INTEGER) {
        // ~9,007,199 XNT. Above this, JS Number precision is unreliable, so we
        // refuse rather than risk signing a transaction for the wrong amount.
        throw new Error('Amount too large to process safely in this interface. Please use a smaller amount or a dedicated CLI tool.');
      }
      dataView.setBigUint64(offset, BigInt(amountLamports), true); // little-endian
    }

    const RPC_URL = 'https://rpc.mainnet.x1.xyz';

    // =========================================================================
    // CANONICAL SCORES (formula v2)
    //
    // Scores are computed hourly by a GitHub Action (scripts/compute-scores.js)
    // and published to data/scores.json on this same origin. Every visitor
    // reads the same file, so every visitor sees the same score — this replaces
    // the old per-browser client-side scoring, which drifted between viewers
    // because it depended on localStorage uptime history, session caches, and
    // fetch timing.
    //
    // If the file is missing or stale (Action broken / local dev), the site
    // falls back to computing scores in the browser like before.
    // =========================================================================
    const CANONICAL_SCORES_URL = 'data/scores.json';
    // GitHub's cron scheduler has been firing the "hourly" bots only every
    // 2–5 h (measured 2026-09-13), so a 3 h cutoff made the site fall back to
    // the heavy client-side crawl most of the day. 7-epoch scores barely move
    // hour to hour; a 12 h-old file beats 50 extra RPC calls per visitor.
    const CANONICAL_MAX_AGE_MS = 12 * 3600000; // treat >12h-old scores as stale
    const CANONICAL_SKIP_MAX_AGE_MS = 24 * 3600000; // skip history stays usable a day

    window.canonicalScores = null;
    window.canonicalScoresDoc = null;   // last fetched file, even if stale (+ _ageMs)

    async function loadCanonicalScores() {
      try {
        // Cache-bust so an hourly update is picked up without a hard refresh
        const res = await fetch(`${CANONICAL_SCORES_URL}?t=${Math.floor(Date.now() / 300000)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const doc = await res.json();
        const age = Date.now() - new Date(doc.generatedAt).getTime();
        if (doc && doc.validators) { doc._ageMs = age; window.canonicalScoresDoc = doc; }
        if (!doc.validators || age > CANONICAL_MAX_AGE_MS) {
          console.warn(`Canonical scores stale (${(age / 3600000).toFixed(1)}h old) — falling back to client-side scoring`);
          return null;
        }
        window.canonicalScores = doc;
        console.log(`Canonical scores loaded: ${doc.validatorCount} validators, generated ${doc.generatedAt}`);
        return doc;
      } catch (e) {
        console.warn('Canonical scores unavailable — falling back to client-side scoring:', e.message);
        return null;
      }
    }

    // Kick the fetch off immediately at page load; scoring paths await this.
    window.canonicalScoresPromise = loadCanonicalScores();

    // ---------------------------------------------------------------
    // Session cache (P2): sessionStorage-backed, per-tab, survives reloads.
    // Used for the two slow, rarely-changing startup fetches — the validator
    // identity accounts (a ~1 MB getProgramAccounts) and the token supply —
    // and for the last live stats-bar numbers so a reload paints them at once.
    // Everything degrades to a normal fetch when storage is unavailable.
    // ---------------------------------------------------------------
    const SessionCache = {
      get(key, maxAgeMs) {
        try {
          const raw = sessionStorage.getItem(key);
          if (!raw) return null;
          const { ts, data } = JSON.parse(raw);
          if (!ts || Date.now() - ts > maxAgeMs) return null;
          return data;
        } catch (e) { return null; }
      },
      set(key, data) {
        try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch (e) { /* quota / private mode */ }
      }
    };
    const IDENTITIES_CACHE_KEY = 'x1IdentitiesCache';   // 1 h — names/icons change rarely
    const SUPPLY_CACHE_KEY     = 'x1SupplyCache';       // 1 h — moves by inflation only
    const STATS_BAR_CACHE_KEY  = 'x1StatsBarCache';     // 24 h — last live stake/supply, fast path only
    const IDENTITIES_CACHE_MS  = 3600000;
    const SUPPLY_CACHE_MS      = 3600000;
    const STATS_BAR_CACHE_MS   = 24 * 3600000;

    // Stats-bar fast path (P2): the header numbers used to wait for the whole
    // loadNetworkStats() Promise.all (getVoteAccounts + identities + …, 1–3 s
    // on the public RPC). scores.json is already in flight and carries the
    // validator count, epoch, slot and per-validator delinquency; stake and
    // supply come from the previous load's cache. Only placeholders ('--')
    // are written, so live RPC data is never overwritten by this.
    function paintStatsBarFastPath(doc) {
      const put = (id, text) => {
        const el = document.getElementById(id);
        if (el && el.textContent.trim() === '--' && text !== null && text !== undefined) el.textContent = text;
      };
      try {
        if (doc && doc.validators && typeof doc._ageMs === 'number' && doc._ageMs < 3 * 3600000) {
          const vals = Object.values(doc.validators);
          const delinquent = vals.filter(v => v.delinquent).length;
          put('totalValidators', doc.validatorCount || vals.length);
          put('activeValidators', vals.length - delinquent);
          put('delinquentValidators', delinquent);
          if (doc.epoch) put('currentEpoch', doc.epoch);
          if (doc.slot) put('currentSlot', formatCompact(doc.slot));
        }
        const bar = SessionCache.get(STATS_BAR_CACHE_KEY, STATS_BAR_CACHE_MS);
        if (bar) {
          if (bar.totalStakeLamports) put('totalStake', formatCompact(lamportsToXNT(bar.totalStakeLamports)));
          if (bar.supplyTotalLamports) put('totalSupply', formatCompact(lamportsToXNT(bar.supplyTotalLamports)));
        }
      } catch (e) { /* cosmetic only */ }
    }
    window.canonicalScoresPromise.then(() => paintStatsBarFastPath(window.canonicalScoresDoc));

    // Look up a validator's canonical breakdown (or null if unavailable)
    function getCanonicalBreakdown(validator) {
      if (!window.canonicalScores) return null;
      const key = validator.voteAccount || validator.votePubkey;
      const entry = key ? window.canonicalScores.validators[key] : null;
      if (!entry) return null;
      // Return in the same shape calculatePerformanceBreakdown produces, with
      // the component map spread at the top level plus totalScore/meta.
      return {
        ...entry.breakdown,
        totalScore: entry.score,
        canonical: true,
        flags: entry.flags || [],
        generatedAt: window.canonicalScores.generatedAt
      };
    }
    const REWARDS_API_URL = null; // Set to your API URL when rewards tracker is running

    // ─────────────────────────────────────────────────────────────────────
    // DELEGATION POOL IDENTITIES
    // Used by the Delegations leaderboard to surface which validators are
    // backed by X1 Labs (Foundation) and which are members of the Ripper
    // liquid-staking pool. These are the staker authorities on the
    // respective stake accounts — used as a memcmp filter at offset 12
    // of stake-program accounts.
    // ─────────────────────────────────────────────────────────────────────
    const X1_LABS_DELEGATOR    = 'uXgzYh1XhJbeoxNYf55t9E9NhpjC1kWe1mMvpp8vM31';
    const RIPPER_POOL_DELEGATOR = 'AZhRy4DQJ9TsMiWA6NuZzFa1MWDmmgKQn6L5St7tPWBk';
    const STAKE_PROGRAM_ID      = 'Stake11111111111111111111111111111111111111';

    // Classify a stake account's source by its withdrawer authority. The X1
    // Labs / Foundation pool and the Ripper Pool each control their stakes
    // through known authorities; everything else is a direct stake (the
    // validator's own self-stake or a third-party stakers). Returns
    // 'foundation' | 'ripper' | null.
    function classifyStakeSource(withdrawer) {
      if (!withdrawer) return null;
      if (withdrawer === X1_LABS_DELEGATOR) return 'foundation';
      if (withdrawer === RIPPER_POOL_DELEGATOR) return 'ripper';
      return null;
    }

    // Vote account's authorized withdrawer — the key to self-stake detection.
    // The hourly rewards ledger (data/rewards.json) carries it for every
    // validator (`w`), so this normally costs 0 RPC calls; getAccountInfo is
    // the fallback for a validator the ledger doesn't know yet.
    async function getVoteWithdrawer(voteAccount) {
      try {
        if (typeof RewardsLedger !== 'undefined') {
          const doc = await RewardsLedger.load();
          const e = doc && doc.validators && doc.validators[voteAccount];
          if (e && e.w) return e.w;
        }
      } catch (e) { /* fall through */ }
      try {
        const info = await rpcCall('getAccountInfo', [voteAccount, { encoding: 'jsonParsed' }]);
        return info?.value?.data?.parsed?.info?.authorizedWithdrawer || null;
      } catch (e) {
        console.warn('Could not fetch vote account withdrawer:', e);
        return null;
      }
    }

    // Resolve a single stake account into exactly one of four buckets:
    //   'foundation' | 'ripper' | 'self' | 'community'
    // Foundation and Ripper are hard-coded by withdrawer (locked — never
    // overridable). For the rest, a user override wins; otherwise self is
    // auto-detected when the stake withdrawer matches the vote account's
    // withdrawer (same logic the Terminal uses), else community.
    // Economically only 'self' is self-stake (100%); the other three are
    // delegated (the validator earns commission only).
    //   overrides: optional Map<pubkey, 'self'|'community'>
    function classifyStakeAccount(pubkey, withdrawer, voteWithdrawer, overrides) {
      const src = classifyStakeSource(withdrawer);
      if (src === 'foundation') return 'foundation';
      if (src === 'ripper') return 'ripper';
      if (overrides && overrides.has(pubkey)) return overrides.get(pubkey);
      if (withdrawer && voteWithdrawer && withdrawer === voteWithdrawer) return 'self';
      return 'community';
    }

    // ─────────────────────────────────────────────────────────────────────
    // Global RPC fetch throttle + retry layer
    //
    // Problem: this app fires many RPC requests in parallel (5 validators ×
    // multiple endpoints × multiple epochs = 50+ concurrent calls on load).
    // The public RPC responds with HTTP 429 (Too Many Requests). When a 429
    // comes back, the RPC also strips CORS headers, so the browser cancels
    // the response before JS can see the status — from JS it looks like a
    // generic "Failed to fetch" error, which cascades and breaks the whole
    // portfolio load.
    //
    // Solution: wrap the global fetch so that any call to RPC_URL is:
    //   (a) throttled to at most MAX_CONCURRENT in-flight requests, and
    //   (b) retried with exponential backoff + jitter on 429 or network errors.
    //
    // This is applied at the fetch layer, so every RPC call path benefits
    // (both rpcCall() and the many direct fetch(RPC_URL, ...) sites).
    // ─────────────────────────────────────────────────────────────────────
    (function installRpcThrottle() {
      const MAX_CONCURRENT    = 3;   // max simultaneous in-flight RPC requests
                                     // (lowered from 4 — the public X1 RPC
                                     // rate-limits aggressively; fewer in flight
                                     // means fewer 429s and less retry churn)
      const MAX_RETRIES_429   = 5;   // rate-limited: be patient, the server is
                                     // alive and just asking us to slow down
      const MAX_RETRIES_NET   = 1;   // network / CORS: fail fast, don't hammer
      const BASE_BACKOFF      = 500; // ms
      const MAX_BACKOFF       = 8000;
      const REQUEST_TIMEOUT_MS = 20000; // a request that never returns used to
                                        // hold one of the 3 throttle slots
                                        // forever; three of those froze the app

      // ── Circuit breaker ───────────────────────────────────────
      // When the RPC is unreachable (CORS blocked, DNS failing, server
      // down, etc.) the app's many pollers all fail near-simultaneously
      // and each one was retrying 4× — a cascade of useless requests
      // that gets the app rate-limited for real, even after the RPC
      // comes back. The breaker tracks consecutive failures globally;
      // when it trips, every RPC fetch rejects instantly for a cooldown
      // window, giving the server breathing room and the browser a
      // chance to stop logging hundreds of errors per second.
      const CB_FAIL_THRESHOLD = 6;     // trip after N back-to-back failures
      const CB_COOLDOWN_MS    = 30000; // pause duration
      let cbFailures     = 0;
      let cbOpenUntil    = 0;          // epoch ms while the breaker is open
      let cbWarnedThisTrip = false;

      function cbIsOpen()     { return Date.now() < cbOpenUntil; }
      function cbRecordFail() {
        cbFailures++;
        if (cbFailures >= CB_FAIL_THRESHOLD && !cbIsOpen()) {
          cbOpenUntil = Date.now() + CB_COOLDOWN_MS;
          if (!cbWarnedThisTrip) {
            console.warn(`[RPC] Circuit breaker tripped after ${cbFailures} failures — pausing all RPC for ${CB_COOLDOWN_MS / 1000}s`);
            cbWarnedThisTrip = true;
          }
        }
      }
      function cbRecordSuccess() {
        if (cbFailures > 0 || cbOpenUntil > 0) {
          console.info('[RPC] Circuit breaker reset — RPC responding normally');
        }
        cbFailures = 0;
        cbOpenUntil = 0;
        cbWarnedThisTrip = false;
      }

      const originalFetch = window.fetch.bind(window);
      let active = 0;
      const waiters = [];

      function acquire() {
        if (active < MAX_CONCURRENT) {
          active++;
          return Promise.resolve();
        }
        return new Promise(resolve => waiters.push(resolve));
      }

      function release() {
        const next = waiters.shift();
        if (next) next();           // hand the slot straight to the next waiter
        else active--;
      }

      function backoffDelay(attempt) {
        const base = Math.min(MAX_BACKOFF, BASE_BACKOFF * Math.pow(2, attempt));
        const jitter = Math.random() * base * 0.3;
        return base + jitter;
      }

      function isRpcUrl(url) {
        if (typeof url === 'string') return url.startsWith(RPC_URL);
        if (url && typeof url.url === 'string') return url.url.startsWith(RPC_URL);
        return false;
      }

      // Per-method call counter for diagnosing RPC load: in the console,
      // `rpcStats.byMethod` / `rpcStats.total` / `rpcStats.reset()`.
      const rpcStats = { total: 0, byMethod: {}, since: Date.now(),
        reset() { this.total = 0; this.byMethod = {}; this.since = Date.now(); } };
      window.rpcStats = rpcStats;
      function countRpc(options) {
        rpcStats.total++;
        try {
          const b = options && typeof options.body === 'string' ? JSON.parse(options.body) : null;
          for (const x of (Array.isArray(b) ? b : [b])) {
            const m = (x && x.method) || '?';
            rpcStats.byMethod[m] = (rpcStats.byMethod[m] || 0) + 1;
          }
        } catch (e) { rpcStats.byMethod['?'] = (rpcStats.byMethod['?'] || 0) + 1; }
      }

      window.fetch = async function throttledFetch(url, options) {
        if (!isRpcUrl(url)) {
          return originalFetch(url, options);
        }
        countRpc(options);

        // Short-circuit immediately if the breaker is open. No fetch, no
        // queue slot, no console spam — just a fast reject so callers can
        // fail cleanly. Cooldown auto-expires based on wall-clock time.
        if (cbIsOpen()) {
          const waitSec = Math.ceil((cbOpenUntil - Date.now()) / 1000);
          throw new Error(`RPC paused by circuit breaker (${waitSec}s remaining)`);
        }

        await acquire();
        try {
          let lastErr;
          for (let attempt = 0; attempt <= MAX_RETRIES_429; attempt++) {
            // Per-attempt timeout, combined with any signal the caller passed.
            const ctrl = new AbortController();
            const callerSignal = options && options.signal;
            let callerAborted = false;
            const onCallerAbort = () => { callerAborted = true; ctrl.abort(); };
            if (callerSignal) {
              if (callerSignal.aborted) onCallerAbort();
              else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
            }
            const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
            const attemptOptions = Object.assign({}, options || {}, { signal: ctrl.signal });
            try {
              const response = await originalFetch(url, attemptOptions);

              // 429 = server is alive and asking us to slow down. Back off
              // and retry — but do NOT count this toward the circuit breaker.
              // The breaker is for genuine outages (CORS, DNS, server down),
              // not for rate-limit pushback, which bursts of parallel calls
              // will trigger harmlessly.
              if (response.status === 429) {
                if (attempt < MAX_RETRIES_429) {
                  // Honor the server's Retry-After hint if it sends one
                  // (seconds, or an HTTP date). Otherwise fall back to our
                  // own exponential backoff. We cap the honored delay so a
                  // misbehaving header can't stall the UI indefinitely.
                  let delay = backoffDelay(attempt);
                  const ra = response.headers.get('Retry-After');
                  if (ra) {
                    let raMs = 0;
                    if (/^\d+$/.test(ra.trim())) {
                      raMs = parseInt(ra.trim(), 10) * 1000;
                    } else {
                      const when = Date.parse(ra);
                      if (!isNaN(when)) raMs = when - Date.now();
                    }
                    if (raMs > 0) delay = Math.min(raMs, 15000); // cap at 15s
                  }
                  await new Promise(r => setTimeout(r, delay));
                  continue;
                }
                return response; // give up this request, let caller see 429
              }

              // Any non-429 response (2xx, 4xx, 5xx) is treated as the
              // server actually responding — reset the breaker.
              cbRecordSuccess();
              return response;
            } catch (e) {
              lastErr = e;
              // R2: an abort is NOT an outage. If the caller aborted, hand
              // the error straight back (retrying with a dead signal is
              // pointless). If OUR timeout fired, treat it as a slow server:
              // one retry, no breaker penalty.
              if (e && e.name === 'AbortError') {
                if (callerAborted) throw e;
                lastErr = new Error('RPC request timed out after ' + (REQUEST_TIMEOUT_MS / 1000) + 's');
                lastErr.name = 'TimeoutError';
                if (attempt < MAX_RETRIES_NET) {
                  await new Promise(r => setTimeout(r, backoffDelay(attempt)));
                  continue;
                }
                throw lastErr;
              }
              // Network error / CORS block / DNS failure land here — these
              // are the genuine outages the circuit breaker is meant for.
              // (A 429 with stripped CORS headers also lands here as a bare
              // TypeError; the retry below covers that case too.)
              cbRecordFail();
              if (attempt < MAX_RETRIES_NET && !cbIsOpen()) {
                await new Promise(r => setTimeout(r, backoffDelay(attempt)));
                continue;
              }
              throw lastErr;
            } finally {
              clearTimeout(timer);
              if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
            }
          }
          throw lastErr || new Error('RPC request failed after retries');
        } finally {
          release();
        }
      };
    })();

    
    let allValidators = [];
    let allValidatorsFetchedAt = 0;   // ms timestamp; 0 = never fetched. Used by
                                       // the lookup tab to decide whether to do a
                                       // silent refresh before / after a search.
    let _searchRequestId = 0;          // monotonic counter; stale searches abort
    let _searchDebounce = null;        // debounce timer for the lookup input
    let validatorInfoCache = {};
    // Guarded: this is a top-level statement in the main script block, so an
    // unparseable value (partial write, extension, manual edit) used to throw
    // at script-eval time and leave the whole site as a dead shell.
    let myPortfolio = (function loadPortfolioSafe() {
      try {
        const raw = localStorage.getItem('x1Portfolio');
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(v => typeof v === 'string' && v.length > 0);
      } catch (e) {
        console.warn('[portfolio] localStorage x1Portfolio unreadable — starting empty', e);
        return [];
      }
    })();
    let rewardsHistory = {};
    let inflationRewardsCache = {}; // Cache for inflation rewards by vote account
    let currentEpochNumber = null;

    // Live epoch length (slots), refreshed whenever getEpochInfo is fetched.
    // Used to annualize per-epoch rewards correctly: X1 epochs are ~2 days
    // (Solana-style), so assuming 365 epochs/year roughly doubled every APY
    // and annual figure. epochsPerYear() derives the true factor from the
    // live epoch length so it self-corrects to whatever the network runs.
    let currentSlotsInEpoch = null;
    const EPOCH_CALC_SLOT_MS = 400; // target slot time (matches unstaking-timeline math)
    function epochsPerYear() {
      if (!currentSlotsInEpoch || currentSlotsInEpoch <= 0) return 365; // safe fallback
      const epochMs = currentSlotsInEpoch * EPOCH_CALC_SLOT_MS;
      const yearMs  = 365.25 * 24 * 60 * 60 * 1000;
      return yearMs / epochMs;
    }

    // Persistent cache for self-stake account pubkeys (survives page reloads and epoch transitions)
    const SELF_STAKE_SELECTIONS_KEY = 'x1SelfStakeSelections';
    
    function loadSelfStakeSelections() {
      try {
        return JSON.parse(localStorage.getItem(SELF_STAKE_SELECTIONS_KEY) || '{}');
      } catch (e) {
        return {};
      }
    }
    
    function saveSelfStakeSelections(selections) {
      try {
        localStorage.setItem(SELF_STAKE_SELECTIONS_KEY, JSON.stringify(selections));
      } catch (e) {
        console.warn('Could not save self-stake selections:', e);
      }
    }
    
    // Get user-selected self-stake pubkeys for a validator
    function getSelfStakeSelections(voteAccount) {
      const selections = loadSelfStakeSelections();
      return selections[voteAccount] || null;
    }
    
    // Save user-selected self-stake pubkeys for a validator.
    // explicit=true (default) records that the user has deliberately
    // classified — so an empty self set is honored as "no self-stake"
    // rather than falling back to auto-detection.
    function setSelfStakeSelections(voteAccount, pubkeys, explicit) {
      const selections = loadSelfStakeSelections();
      selections[voteAccount] = {
        pubkeys: pubkeys,
        explicit: explicit !== false,
        timestamp: Date.now()
      };
      saveSelfStakeSelections(selections);
    }

    // True when the user has deliberately classified this validator —
    // either they have self-stake accounts selected, or they explicitly
    // saved a classification (possibly with zero self-stake).
    function hasUserClassification(sel) {
      return !!(sel && sel.pubkeys && (sel.explicit || sel.pubkeys.length > 0));
    }

    // Tap-to-toggle for the Credit Pace tooltip on touch devices (where hover
    // doesn't fire). Only one stays open at a time; tapping outside closes it.
    function toggleCredTooltip(id) {
      const el = document.getElementById(id);
      if (!el) return;
      const wasOpen = el.classList.contains('show');
      document.querySelectorAll('.cred-tooltip.show').forEach(t => t.classList.remove('show'));
      if (wasOpen) return;

      el.classList.add('show');
      // Position as a fixed popover anchored above the badge (or below if there
      // isn't room above), clamped to the viewport — so the box is always fully
      // on-screen and self-contained, never spilling outside the card layout.
      const badge = el.parentElement;
      if (!badge) return;
      const r = badge.getBoundingClientRect();
      const tw = el.offsetWidth || 230;
      const th = el.offsetHeight || 0;
      let left = r.right - tw;                 // right-align to the badge
      left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
      let top = r.top - th - 8;                // above the badge by default
      if (top < 8) top = r.bottom + 8;         // not enough room above → below
      el.style.left = left + 'px';
      el.style.top = top + 'px';
    }
    if (!window._credTooltipOutsideBound) {
      window._credTooltipOutsideBound = true;
      document.addEventListener('click', function(e) {
        if (e.target.closest && e.target.closest('.cred-pct-badge')) return;
        document.querySelectorAll('.cred-tooltip.show').forEach(t => t.classList.remove('show'));
      });
    }

    // Legacy cache functions (for backwards compatibility)
    const SELF_STAKE_CACHE_KEY = 'x1SelfStakeAccounts';
    
    function loadSelfStakeCache() {
      try {
        return JSON.parse(localStorage.getItem(SELF_STAKE_CACHE_KEY) || '{}');
      } catch (e) {
        return {};
      }
    }
    
    function saveSelfStakeCache(cache) {
      try {
        localStorage.setItem(SELF_STAKE_CACHE_KEY, JSON.stringify(cache));
      } catch (e) {
        console.warn('Could not save self-stake cache:', e);
      }
    }
    
    // Save detected self-stake pubkeys for a validator
    function cacheSelfStakePubkeys(voteAccount, selfStakePubkeys, detectionMethod) {
      const cache = loadSelfStakeCache();
      cache[voteAccount] = {
        pubkeys: selfStakePubkeys,
        detectionMethod: detectionMethod,
        timestamp: Date.now(),
        epoch: currentEpochNumber
      };
      saveSelfStakeCache(cache);
    }
    
    // Get cached self-stake pubkeys for a validator
    function getCachedSelfStakePubkeys(voteAccount) {
      const cache = loadSelfStakeCache();
      const entry = cache[voteAccount];
      // Cache is valid for 7 days (stake relationships rarely change)
      if (entry && entry.timestamp > Date.now() - (7 * 24 * 60 * 60 * 1000)) {
        return entry;
      }
      return null;
    }

    // Fetch inflation rewards for a vote account across recent epochs
    // Short-lived getEpochInfo cache. Per-validator reward fetches each called
    // getEpochInfo independently — on a portfolio open that was N identical
    // round-trips. This dedupes them (and coalesces concurrent callers) so a
    // burst of reward fetches shares a single getEpochInfo round-trip.
    let _epochInfoData = null, _epochInfoTs = 0, _epochInfoPromise = null;
    async function getEpochInfoCached(maxAgeMs = 10000) {
      if (_epochInfoData && Date.now() - _epochInfoTs < maxAgeMs) return _epochInfoData;
      if (_epochInfoPromise) return _epochInfoPromise;
      _epochInfoPromise = rpcCall('getEpochInfo')
        .then(d => { _epochInfoData = d; _epochInfoTs = Date.now(); _epochInfoPromise = null; return d; })
        .catch(e => { _epochInfoPromise = null; throw e; });
      return _epochInfoPromise;
    }

    async function fetchInflationRewards(voteAccount, numEpochs = 30) {
      // Check cache first - include numEpochs in cache key
      const cacheKey = `${voteAccount}-${numEpochs}`;
      const cached = inflationRewardsCache[cacheKey];
      if (cached && cached.timestamp > Date.now() - 300000) { // 5 min cache
        return cached.data;
      }
      
      try {
        // Epoch info — deduped/coalesced across concurrent reward fetches
        const epochInfo = await getEpochInfoCached();
        currentEpochNumber = epochInfo.epoch; currentSlotsInEpoch = epochInfo.slotsInEpoch;
        
        // Fetch all epochs (starting from currentEpoch - 1)
        const epochsToFetch = [];
        for (let i = 1; i <= Math.min(numEpochs, currentEpochNumber); i++) {
          epochsToFetch.push(currentEpochNumber - i);
        }
        
        // Batch requests to avoid overwhelming RPC (50 at a time)
        const batchSize = 50;
        const allRewards = [];
        
        for (let i = 0; i < epochsToFetch.length; i += batchSize) {
          const batch = epochsToFetch.slice(i, i + batchSize);
          
          const epochPromises = batch.map(async (epoch) => {
            try {
              const response = await fetch(RPC_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: 1,
                  method: 'getInflationReward',
                  params: [[voteAccount], { epoch: epoch }]
                })
              });
              
              const data = await response.json();
              if (data.result && data.result[0]) {
                return {
                  epoch: epoch,
                  amount: data.result[0].amount,
                  postBalance: data.result[0].postBalance,
                  commission: data.result[0].commission
                };
              }
              return null;
            } catch (e) {
              console.warn(`Failed to fetch reward for epoch ${epoch}:`, e);
              return null;
            }
          });
          
          const batchResults = await Promise.all(epochPromises);
          allRewards.push(...batchResults.filter(r => r !== null));
        }
        
        // Sort by epoch descending (most recent first)
        allRewards.sort((a, b) => b.epoch - a.epoch);
        
        // Cache the results
        inflationRewardsCache[cacheKey] = {
          timestamp: Date.now(),
          data: allRewards
        };
        
        return allRewards;
      } catch (e) {
        console.error('Error fetching inflation rewards:', e);
        return [];
      }
    }

    // Get cached inflation rewards or empty array
    function getCachedInflationRewards(voteAccount) {
      const cached = inflationRewardsCache[voteAccount];
      return cached ? cached.data : [];
    }

    // ===========================================================
    // REWARDS LEDGER — data/rewards.json, written hourly by
    // scripts/build-rewards-ledger.js (see HANDOVER.md). Per vote
    // account: vote reward + self-stake reward for each of the last
    // ~36 completed epochs, lamports, aligned to doc.epochs.
    // fetchTotalValidatorRewards() reads this first and only asks the
    // RPC for epochs the ledger does not cover (normally none — at most
    // the newest epoch right after a boundary), which turns 60 RPC
    // round-trips per card into zero.
    // ===========================================================
    const RewardsLedger = (function () {
      const URL_ = 'data/rewards.json';
      const MAX_AGE_MS = 48 * 3600 * 1000;   // older → bot is broken, ignore it
      const REFRESH_MS = 10 * 60 * 1000;
      let doc = null, loadedAt = 0, promise = null, failedAt = 0;

      async function load() {
        if (doc && Date.now() - loadedAt < REFRESH_MS) return doc;
        if (promise) return promise;
        if (!doc && failedAt && Date.now() - failedAt < REFRESH_MS) return null; // don't hammer a 404
        promise = (async () => {
          try {
            // 5-minute cache-bust key, same convention as data/scores.json
            const r = await fetch(URL_ + '?t=' + Math.floor(Date.now() / 300000), { cache: 'no-cache' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const d = await r.json();
            if (!d || d.v !== 1 || !Array.isArray(d.epochs) || !d.validators) throw new Error('unexpected shape');
            const gen = Date.parse(d.generatedAt);
            if (!gen || Date.now() - gen > MAX_AGE_MS) throw new Error('stale (' + d.generatedAt + ')');
            d._index = new Map(d.epochs.map((e, i) => [e, i]));
            doc = d; loadedAt = Date.now(); failedAt = 0;
            console.info('[ledger] rewards.json: epochs ' + d.epochs[0] + '..' + d.epochs[d.epochs.length - 1] +
              ', ' + Object.keys(d.validators).length + ' validators, generated ' + d.generatedAt);
          } catch (e) {
            console.warn('[ledger] unavailable (' + e.message + ') — rewards will come from live RPC');
            failedAt = Date.now();
          } finally { promise = null; }
          return doc; // previous copy (if any) survives a failed refresh
        })();
        return promise;
      }

      // Reward rows for the requested epochs, in the shape
      // fetchTotalValidatorRewards() returns. `self` is the ledger's
      // self-stake account list for the validator (null if unknown).
      function rows(voteAccount, epochs, commission) {
        const out = new Map();
        const e = doc && doc.validators[voteAccount];
        if (!e) return { rows: out, self: null };
        for (const ep of epochs) {
          const i = doc._index.get(ep);
          if (i === undefined) continue;
          const v = e.v ? e.v[i] : null;
          const sv = e.s ? e.s[i] : null;
          out.set(ep, { epoch: ep, amount: (v || 0) + (sv || 0), indexed: v != null, postBalance: 0, commission });
        }
        return { rows: out, self: Array.isArray(e.self) ? e.self : [] };
      }

      return { load, rows, get doc() { return doc; }, get generatedAt() { return doc ? doc.generatedAt : null; } };
    })();
    window.RewardsLedger = RewardsLedger;

    // Cache for total validator rewards (vote + self-stake)
    let totalRewardsCache = {};

    // Fetch TOTAL validator rewards (vote account commission + self-stake rewards)
    // for the last `numEpochs` completed epochs, newest first. Rows come from
    // the hourly rewards ledger (data/rewards.json) whenever it covers the
    // epoch; only uncovered epochs go to the RPC (fetchTotalValidatorRewardsLive).
    async function fetchTotalValidatorRewards(voteAccount, commission, numEpochs = 30) {
      // Check cache first
      const cacheKey = `${voteAccount}_total_${numEpochs}`;
      const cached = totalRewardsCache[cacheKey];
      if (cached && cached.timestamp > Date.now() - 300000) { // 5 min cache
        return cached.data;
      }

      try {
        // Epoch info — deduped/coalesced across concurrent reward fetches
        const epochInfo = await getEpochInfoCached();
        currentEpochNumber = epochInfo.epoch; currentSlotsInEpoch = epochInfo.slotsInEpoch;

        // Start from currentEpoch - 1 to exclude the current incomplete epoch
        const epochsToFetch = [];
        for (let i = 1; i <= Math.min(numEpochs, currentEpochNumber); i++) {
          epochsToFetch.push(currentEpochNumber - i);
        }

        // Ledger first — unless this visitor hand-classified the validator's
        // self-stake accounts (the ledger only knows withdrawer matching).
        let ledgerRows = new Map(), knownSelf = null;
        const userSel = typeof getSelfStakeSelections === 'function' ? getSelfStakeSelections(voteAccount) : null;
        if (!hasUserClassification(userSel)) {
          await RewardsLedger.load();
          const got = RewardsLedger.rows(voteAccount, epochsToFetch, commission);
          ledgerRows = got.rows; knownSelf = got.self;
        }

        // Whatever the ledger lacks goes to the RPC: normally nothing, the
        // newest epoch right after a boundary, or everything when the ledger
        // is unavailable. A cell the bot saw as un-indexed in one of the two
        // newest epochs is re-checked live too (RPC may have caught up since).
        const missing = epochsToFetch.filter(ep => {
          const r = ledgerRows.get(ep);
          return !r || (!r.indexed && ep >= currentEpochNumber - 2);
        });
        const liveRows = missing.length
          ? await fetchTotalValidatorRewardsLive(voteAccount, commission, missing, knownSelf)
          : [];

        const byEpoch = new Map(ledgerRows);
        for (const r of liveRows) byEpoch.set(r.epoch, r);
        const rewards = Array.from(byEpoch.values()).sort((a, b) => b.epoch - a.epoch);

        // Cache only if the most recent epoch has real indexed data.
        // Caching a not-yet-indexed result would poison the cache for 5 minutes
        // and force users to see stale zeros.
        if (rewards.length > 0 && rewards[0].indexed) {
          totalRewardsCache[cacheKey] = { timestamp: Date.now(), data: rewards };
        }
        if (ledgerRows.size) {
          console.log(`[ledger] ${voteAccount.slice(0,8)}...: ${ledgerRows.size} epochs from ledger, ${missing.length} live`);
        }
        return rewards;
      } catch (e) {
        console.error('Error fetching total validator rewards:', e);
        // Fallback to just vote account rewards
        return fetchInflationRewards(voteAccount, numEpochs);
      }
    }

    // Live RPC path: one getInflationReward per epoch for the vote account,
    // plus one per epoch for its self-stake accounts. `knownSelfAccounts`
    // (from the ledger) skips the getAccountInfo + getProgramAccounts
    // discovery. Returns rows for `epochsToFetch` only; never caches.
    async function fetchTotalValidatorRewardsLive(voteAccount, commission, epochsToFetch, knownSelfAccounts) {
      try {
        let selfStakeAccounts = [];

        // Step 1: Fetch vote account rewards (commission) in parallel
        const voteRewardsPromises = epochsToFetch.map(async (epoch) => {
          try {
            const response = await fetch(RPC_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getInflationReward',
                params: [[voteAccount], { epoch: epoch }]
              })
            });
            const data = await response.json();
            // Distinguish "indexed with real value" vs "not indexed yet by RPC".
            // A non-null amount (including 0) means the epoch is indexed.
            if (data.result && data.result[0] && data.result[0].amount != null) {
              return { epoch, amount: data.result[0].amount, indexed: true };
            }
            // null result, missing entry, or null amount = RPC hasn't indexed this epoch yet
            return { epoch, amount: 0, indexed: false };
          } catch (e) {
            return { epoch, amount: 0, indexed: false };
          }
        });

        // Step 2: Fetch vote account info to get authorizedWithdrawer
        // (steps 2–4 are skipped when the ledger already knows the self-stake list)
        let voteAccountWithdrawer = null;
        let stakeData = { result: [] };
        if (Array.isArray(knownSelfAccounts)) {
          selfStakeAccounts = knownSelfAccounts;
        } else try {
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

        // Step 3: Fetch stake accounts delegated to this validator
        if (!Array.isArray(knownSelfAccounts)) {
        const stakeResponse = await fetch(RPC_URL, {
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
        stakeData = await stakeResponse.json();
        }

        // Wait for vote rewards
        const voteRewardsResults = await Promise.all(voteRewardsPromises);
        
        // Build vote rewards map by epoch, preserving indexed status
        const rewardsByEpoch = {};
        voteRewardsResults.forEach(r => {
          rewardsByEpoch[r.epoch] = { amount: r.amount, indexed: r.indexed };
        });

        // Step 4: Identify self-stake accounts using WITHDRAWER MATCHING
        // (same method as stake breakdown - much more accurate than reward rate analysis)
        if (Array.isArray(knownSelfAccounts)) {
          // already set from the ledger
        } else if (stakeData.result && stakeData.result.length > 0 && voteAccountWithdrawer) {
          // Check for user selections first
          const userSelections = typeof getSelfStakeSelections === 'function' ? getSelfStakeSelections(voteAccount) : null;
          
          if (hasUserClassification(userSelections)) {
            // Use user-selected self-stake accounts
            selfStakeAccounts = userSelections.pubkeys;
            console.log(`[${voteAccount.slice(0,8)}] Using ${selfStakeAccounts.length} user-selected self-stake accounts`);
          } else {
            // Match stake account withdrawers against vote account withdrawer
            for (const acc of stakeData.result) {
              const stakeInfo = acc.account.data.parsed?.info;
              const stakeWithdrawer = stakeInfo?.meta?.authorized?.withdrawer;
              
              if (stakeWithdrawer === voteAccountWithdrawer) {
                selfStakeAccounts.push(acc.pubkey);
              }
            }
            console.log(`[${voteAccount.slice(0,8)}] Found ${selfStakeAccounts.length} self-stake accounts out of ${stakeData.result.length} total delegated (vote withdrawer: ${voteAccountWithdrawer?.slice(0,8)})`);
          }
        } else {
          console.log(`[${voteAccount.slice(0,8)}] No stake accounts or no withdrawer - stakeData: ${stakeData.result?.length || 0}, withdrawer: ${voteAccountWithdrawer?.slice(0,8) || 'null'}`);
        }

        // Step 5: If we have self-stake accounts, fetch their rewards for all epochs
        if (selfStakeAccounts.length > 0) {
          // Batch epochs to avoid too many parallel requests
          const batchSize = 50;
          
          for (let i = 0; i < epochsToFetch.length; i += batchSize) {
            const batchEpochs = epochsToFetch.slice(i, i + batchSize);
            
            const selfStakePromises = batchEpochs.map(async (epoch) => {
              try {
                const response = await fetch(RPC_URL, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getInflationReward',
                    params: [selfStakeAccounts, { epoch: epoch }]
                  })
                });
                const data = await response.json();
                if (data.result) {
                  // Sum up all self-stake rewards for this epoch
                  let totalSelfStakeReward = 0;
                  data.result.forEach(r => {
                    if (r && r.amount) totalSelfStakeReward += r.amount;
                  });
                  return { epoch, amount: totalSelfStakeReward };
                }
                return { epoch, amount: 0 };
              } catch (e) {
                return { epoch, amount: 0 };
              }
            });

            const selfStakeResults = await Promise.all(selfStakePromises);
            
            // Add self-stake rewards to vote rewards
            selfStakeResults.forEach(r => {
              if (rewardsByEpoch[r.epoch] !== undefined) {
                rewardsByEpoch[r.epoch].amount += r.amount;
              } else {
                // Shouldn't normally happen (vote rewards populated all epochs first),
                // but handle gracefully
                rewardsByEpoch[r.epoch] = { amount: r.amount, indexed: true };
              }
            });
          }
        }

        // Step 6: Build final rewards array (sorted descending - most recent first)
        const rewards = Object.entries(rewardsByEpoch)
          .map(([epoch, v]) => ({
            epoch: parseInt(epoch),
            amount: v.amount,
            indexed: v.indexed,
            postBalance: 0,
            commission: commission
          }))
          .sort((a, b) => b.epoch - a.epoch);

        console.log(`Live rewards for ${voteAccount.slice(0,8)}...: vote + ${selfStakeAccounts.length} self-stake accounts, ${rewards.length} epochs`);
        return rewards;
      } catch (e) {
        console.error('Error fetching live validator rewards:', e);
        return [];
      }
    }

    function formatNumber(num, decimals = 2) {
      if (num === null || num === undefined || isNaN(num)) return '0.00';
      return parseFloat(num).toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      });
    }

    function copyToClipboard(text, buttonEl) {
      navigator.clipboard.writeText(text).then(() => {
        // Visual feedback
        if (buttonEl) {
          buttonEl.classList.add('copied');
          const originalTitle = buttonEl.title;
          buttonEl.title = 'Copied!';
          
          // Change icon to checkmark temporarily
          const originalSvg = buttonEl.innerHTML;
          buttonEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>`;
          
          setTimeout(() => {
            buttonEl.classList.remove('copied');
            buttonEl.title = originalTitle;
            buttonEl.innerHTML = originalSvg;
          }, 1500);
        }
      }).catch(err => {
        console.error('Failed to copy:', err);
      });
    }

    // Generate a copy button HTML
    function getCopyButtonHtml(address) {
      return `<button class="copy-address-btn" onclick="event.stopPropagation(); copyToClipboard('${address}', this)" title="Copy address">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      </button>`;
    }

    function formatCompact(num) {
      if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
      if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
      if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
      return num.toFixed(0);
    }

    function formatStake(lamports) {
      const xnt = lamports / 1e9;
      if (xnt >= 1e6) return (xnt / 1e6).toFixed(2) + 'M';
      if (xnt >= 1e3) return (xnt / 1e3).toFixed(1) + 'K';
      return xnt.toFixed(0);
    }
    
    // Format XNT values compactly for display (input is already in XNT, not lamports)
    function formatXntCompact(xnt) {
      if (xnt === null || xnt === undefined || isNaN(xnt)) return '0';
      if (xnt >= 1e6) return (xnt / 1e6).toFixed(2) + 'M';
      if (xnt >= 1e3) return formatNumber(xnt, 1);
      return formatNumber(xnt, 2);
    }

    function lamportsToXNT(lamports) {
      return lamports / 1e9;
    }

    // Compare semantic version strings (e.g., "2.2.18" vs "2.2.19")
    function compareVersions(a, b) {
      if (!a) return -1;
      if (!b) return 1;
      const partsA = a.split('.').map(n => parseInt(n) || 0);
      const partsB = b.split('.').map(n => parseInt(n) || 0);
      for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const numA = partsA[i] || 0;
        const numB = partsB[i] || 0;
        if (numA < numB) return -1;
        if (numA > numB) return 1;
      }
      return 0;
    }

    // Check if a version is outdated compared to the latest
    function isVersionOutdated(version) {
      if (!version || !window.latestValidatorVersion) return false;
      return compareVersions(version, window.latestValidatorVersion) < 0;
    }

    // Highest semver run by >= MIN_NODES gossip nodes (ignores one-off test
    // builds). `serverHint` is scores.json's latestVersion, computed the same
    // way an hour ago on the Action — use it if it is newer than what this
    // browser can see (e.g. a partial getClusterNodes response).
    function computeLatestVersion(versionMap, serverHint) {
      const MIN_NODES = 3;
      const counts = {};
      Object.values(versionMap || {}).forEach(v => {
        if (v && /^\d+\.\d+\.\d+$/.test(v)) counts[v] = (counts[v] || 0) + 1;
      });
      let latest = null;
      for (const [ver, n] of Object.entries(counts)) {
        if (n >= MIN_NODES && (!latest || compareVersions(ver, latest) > 0)) latest = ver;
      }
      if (serverHint && /^\d+\.\d+\.\d+$/.test(serverHint) && (!latest || compareVersions(serverHint, latest) > 0)) latest = serverHint;
      // Last resort: the most common version among peers.
      if (!latest) {
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        latest = top ? top[0] : null;
      }
      return latest;
    }

    // { latest, totalNodes, totalStake, rows: [{version, nodes, validators, stake, stakePct, behind}] }
    function buildVersionStats(validators, clusterNodes, latest) {
      const byVer = {};
      let totalStake = 0;
      (validators || []).forEach(v => {
        const ver = v.version || 'unknown';
        const row = byVer[ver] || (byVer[ver] = { version: ver, nodes: 0, validators: 0, stake: 0, delinquent: 0 });
        row.validators++;
        row.stake += Number(v.activatedStake) || 0;
        if (v.delinquent) row.delinquent++;
        totalStake += Number(v.activatedStake) || 0;
      });
      // gossip nodes (includes RPC/non-voting nodes) — informational count
      (clusterNodes || []).forEach(n => {
        const ver = n.version || 'unknown';
        const row = byVer[ver] || (byVer[ver] = { version: ver, nodes: 0, validators: 0, stake: 0, delinquent: 0 });
        row.nodes++;
      });
      const rows = Object.values(byVer).map(r => ({
        ...r,
        stakePct: totalStake ? (r.stake / totalStake) * 100 : 0,
        behind: r.version !== 'unknown' && latest ? compareVersions(r.version, latest) < 0 : null,
        ahead:  r.version !== 'unknown' && latest ? compareVersions(r.version, latest) > 0 : null,
      })).sort((a, b) => b.stake - a.stake || b.validators - a.validators);
      const onLatest = rows.find(r => r.version === latest);
      return {
        latest,
        generatedAt: Date.now(),
        totalStake,
        totalValidators: (validators || []).length,
        totalNodes: (clusterNodes || []).length,
        latestStakePct: onLatest ? onLatest.stakePct : 0,
        latestValidators: onLatest ? onLatest.validators : 0,
        behindValidators: rows.filter(r => r.behind).reduce((s, r) => s + r.validators, 0),
        behindStakePct: rows.filter(r => r.behind).reduce((s, r) => s + r.stakePct, 0),
        rows,
      };
    }

    // Network tab strip: stake-weighted adoption bar + legend.
    function renderVersionStrip() {
      const el = document.getElementById('verStrip');
      const vs = window.versionStats;
      if (!el || !vs || !vs.rows.length) return;
      const palette = ['var(--success)', 'var(--accent-cyan)', 'var(--warning)', 'var(--danger)', '#a78bfa', '#f472b6', '#94a3b8'];
      const shown = vs.rows.filter(r => r.stakePct >= 0.05 || r.validators >= 3).slice(0, 7);
      const other = vs.rows.filter(r => !shown.includes(r));
      const otherStake = other.reduce((s, r) => s + r.stakePct, 0), otherVals = other.reduce((s, r) => s + r.validators, 0);
      const colorFor = (r, i) => r.version === vs.latest ? 'var(--success)' : (r.ahead ? '#a78bfa' : (r.version === 'unknown' ? '#94a3b8' : palette[Math.min(i + 2, palette.length - 1)]));
      const segs = shown.map((r, i) => `<div class="ver-seg" style="width:${Math.max(r.stakePct, 0.4)}%;background:${colorFor(r, i)}" title="v${escHtml(r.version)} · ${r.validators} validators · ${r.stakePct.toFixed(1)}% of stake"></div>`).join('')
        + (otherVals ? `<div class="ver-seg" style="width:${Math.max(otherStake, 0.4)}%;background:#475569" title="${otherVals} others · ${otherStake.toFixed(1)}% of stake"></div>` : '');
      const legend = shown.map((r, i) => `<span class="ver-leg"><i style="background:${colorFor(r, i)}"></i>v${escHtml(r.version)}${r.version === vs.latest ? ' <b>latest</b>' : (r.ahead ? ' <em>pre-release</em>' : '')} <span class="ver-leg-n">${r.validators} · ${r.stakePct.toFixed(1)}%</span></span>`).join('')
        + (otherVals ? `<span class="ver-leg"><i style="background:#475569"></i>${other.length} other${other.length === 1 ? '' : 's'} <span class="ver-leg-n">${otherVals} · ${otherStake.toFixed(1)}%</span></span>` : '');
      const minDeleg = (window.delegationConfig && window.delegationConfig.minValidatorVersion) || null;
      el.innerHTML = `
        <div class="ver-strip-head">
          <span class="ver-strip-label">Client versions · Tachyon</span>
          <span class="ver-strip-summary">
            <b>v${escHtml(vs.latest || '?')}</b> latest in use ·
            <span class="${vs.behindValidators ? 'ver-behind' : ''}">${vs.behindValidators} validator${vs.behindValidators === 1 ? '' : 's'} behind (${vs.behindStakePct.toFixed(1)}% of stake)</span>
            ${minDeleg ? ` · delegation minimum <b>v${escHtml(minDeleg)}</b>` : ''}
          </span>
        </div>
        <div class="ver-bar" role="img" aria-label="Share of stake by client version">${segs}</div>
        <div class="ver-legend">${legend}</div>`;
      el.hidden = false;
    }
    
    // Get version status with gradient scoring
    function getVersionStatus(version) {
      if (!version) {
        return { score: 50, details: 'Unknown version' };
      }
      
      if (!window.latestValidatorVersion) {
        return { score: 75, details: `v${version}` };
      }
      
      const comparison = compareVersions(version, window.latestValidatorVersion);
      
      if (comparison >= 0) {
        // Latest or newer
        return { score: 100, details: `v${version} ✓` };
      }
      
      // Calculate how many minor versions behind
      const currentParts = version.split('.').map(n => parseInt(n) || 0);
      const latestParts = window.latestValidatorVersion.split('.').map(n => parseInt(n) || 0);
      
      // Major version difference is critical
      if (currentParts[0] < latestParts[0]) {
        const majorDiff = latestParts[0] - currentParts[0];
        if (majorDiff >= 2) {
          return { score: 20, details: `v${version} (very outdated)` };
        }
        return { score: 40, details: `v${version} (major behind)` };
      }
      
      // Minor version difference
      const minorDiff = (latestParts[1] || 0) - (currentParts[1] || 0);
      
      if (minorDiff <= 1) {
        return { score: 85, details: `v${version} (1 behind)` };
      } else if (minorDiff <= 2) {
        return { score: 60, details: `v${version} (2 behind)` };
      } else {
        return { score: 30, details: `v${version} (3+ behind)` };
      }
    }

    async function rpcCall(method, params = []) {
      const response = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: method,
          params: params
        })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      return data.result;
    }

    // Fetch which of the given ABSOLUTE leader slots actually had blocks
    // produced. Used by both the Slot Explorer modal and the Network Live
    // "My Validators" timeline so they show identical chronological data.
    // Returns a Promise<Set<absoluteSlot>> of slots where getBlock returned
    // a result, or null if every chunk failed (caller should fall back to
    // a non-chronological display).
    async function fetchProducedSlots(absoluteLeaderSlots) {
      if (!absoluteLeaderSlots || absoluteLeaderSlots.length === 0) return new Set();
      const CHUNK = 50;
      const producedSet = new Set();
      let anyChunkOk = false;
      for (let off = 0; off < absoluteLeaderSlots.length; off += CHUNK) {
        const chunk = absoluteLeaderSlots.slice(off, off + CHUNK);
        const batchBody = chunk.map((absSlot, i) => ({
          jsonrpc: '2.0', id: i,
          method: 'getBlock',
          params: [absSlot, { transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }]
        }));
        try {
          const batchResp = await fetch(RPC_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(batchBody)
          }).then(r => r.json());
          if (!Array.isArray(batchResp)) continue;
          anyChunkOk = true;
          for (const resp of batchResp) {
            if (typeof resp.id !== 'number') continue;
            const absSlot = chunk[resp.id];
            if (absSlot === undefined) continue;
            if (resp.result) producedSet.add(absSlot);
          }
        } catch (e) {
          console.warn('[fetchProducedSlots] chunk failed', { off, len: chunk.length, err: e });
        }
      }
      return anyChunkOk ? producedSet : null;
    }

    // Fetch rewards history from tracker API
    async function fetchRewardsHistory() {
      if (!REWARDS_API_URL) return null;
      
      try {
        const response = await fetch(`${REWARDS_API_URL}/api/validators`);
        const data = await response.json();
        if (data.success) {
          rewardsHistory = data.validators;
          return data;
        }
      } catch (err) {
        console.warn('Could not fetch rewards history:', err.message);
      }
      return null;
    }

    // Get rewards history for a specific validator
    function getValidatorRewardsHistory(voteAccount) {
      if (rewardsHistory[voteAccount]) {
        return rewardsHistory[voteAccount].history || [];
      }
      return [];
    }

    // Fetch validator identity name from config account
    async function fetchValidatorIdentities() {
      const cached = SessionCache.get(IDENTITIES_CACHE_KEY, IDENTITIES_CACHE_MS);
      if (cached) return cached;
      try {
        // Fetch validator info accounts from config program
        const configProgramId = 'Config1111111111111111111111111111111111111';
        const accounts = await rpcCall('getProgramAccounts', [
          configProgramId,
          {
            encoding: 'jsonParsed',
            filters: [{ dataSize: 643 }] // Validator info account size
          }
        ]);

        const identities = {};
        
        for (const account of accounts) {
          try {
            const data = account.account.data;
            if (data.parsed && data.parsed.info) {
              const info = data.parsed.info;
              if (info.configData && info.keys) {
                const identityKey = info.keys.find(k => k.signer);
                if (identityKey && info.configData.name) {
                  const cfg = info.configData;
                  
                  // Try direct icon URL fields first
                  let iconUrl = cfg.iconUrl || 
                                cfg.icon_url || 
                                cfg.iconURL ||
                                cfg.icon ||
                                cfg.image ||
                                cfg.logo || '';
                  
                  // Check for keybase username
                  const keybase = cfg.keybaseUsername || 
                                  cfg.keybase || '';
                  if (!iconUrl && keybase) {
                    iconUrl = `https://keybase.io/${keybase}/picture`;
                  }
                  
                  // Parse details field - it may contain JSON with image URL
                  if (!iconUrl && cfg.details) {
                    try {
                      // Details might be a JSON string
                      const detailsObj = typeof cfg.details === 'string' 
                        ? JSON.parse(cfg.details) 
                        : cfg.details;
                      iconUrl = detailsObj.image || 
                                detailsObj.icon || 
                                detailsObj.logo || 
                                detailsObj.iconUrl || 
                                detailsObj.avatar || '';
                    } catch (e) {
                      // Details is not valid JSON, ignore
                    }
                  }
                  
                  identities[identityKey.pubkey] = {
                    name: cfg.name,
                    website: cfg.website || '',
                    details: cfg.details || '',
                    iconUrl: iconUrl
                  };
                }
              }
            }
          } catch (e) {
            // Skip malformed accounts
          }
        }
        
        if (Object.keys(identities).length) SessionCache.set(IDENTITIES_CACHE_KEY, identities);
        return identities;
      } catch (err) {
        console.error('Failed to fetch validator identities:', err);
        return {};
      }
    }

    // getSupply is slow on the public RPC and only moves by inflation; keep
    // the total for an hour per tab. Only the field the site reads is stored.
    async function fetchSupplyCached() {
      const cached = SessionCache.get(SUPPLY_CACHE_KEY, SUPPLY_CACHE_MS);
      if (cached && cached.value && cached.value.total) return cached;
      const supply = await rpcCall('getSupply');
      if (supply && supply.value && supply.value.total) SessionCache.set(SUPPLY_CACHE_KEY, { value: { total: supply.value.total } });
      return supply;
    }

    // Fetch network stats and all validators
    async function loadNetworkStats() {
      try {
        const [voteAccounts, epochInfo, slot, identities, clusterNodes, supply] = await Promise.all([
          rpcCall('getVoteAccounts'),
          rpcCall('getEpochInfo'),
          rpcCall('getSlot'),
          fetchValidatorIdentities(),
          rpcCall('getClusterNodes').catch(() => []),
          fetchSupplyCached().catch(() => null)
        ]);

        // Build version map from cluster nodes
        const versionMap = {};
        clusterNodes.forEach(node => {
          if (node.pubkey && node.version) {
            versionMap[node.pubkey] = node.version;
          }
        });

        // Latest validator version — from the network itself, not GitHub.
        // Tachyon (x1-labs/tachyon) publishes no GitHub releases, so the old
        // releases call always failed and a hard-coded floor (2.2.20) became
        // "latest" while the cluster ran 3.1.14 — nobody was ever flagged as
        // outdated. Rule (same as scripts/compute-scores.js): the highest
        // semver run by at least 3 gossip nodes. The hourly scores.json
        // carries the server's answer too; prefer whichever is newer.
        window.latestValidatorVersion = computeLatestVersion(versionMap, window.canonicalScores && window.canonicalScores.latestVersion);

        const currentValidators = voteAccounts.current || [];
        const delinquentValidators = voteAccounts.delinquent || [];
        const totalValidatorsCount = currentValidators.length + delinquentValidators.length;
        
        let totalStake = 0;
        const allValidatorsList = [...currentValidators, ...delinquentValidators];
        allValidatorsList.forEach(v => {
          totalStake += v.activatedStake;
        });

        document.getElementById('totalValidators').textContent = totalValidatorsCount;
        // Keep the globe's "X of Y validators located" chip in sync with the header.
        if (typeof renderGlobeStats === 'function' && typeof globeState !== 'undefined' && globeState.points.length) {
          renderGlobeStats(globeState.points, globeState.countries);
        }
        document.getElementById('totalStake').textContent = formatCompact(lamportsToXNT(totalStake));
        document.getElementById('currentEpoch').textContent = epochInfo.epoch;
        document.getElementById('currentSlot').textContent = formatCompact(slot);
        document.getElementById('activeValidators').textContent = currentValidators.length;
        document.getElementById('delinquentValidators').textContent = delinquentValidators.length;
        
        // Total supply
        if (supply && supply.value) {
          document.getElementById('totalSupply').textContent = formatCompact(lamportsToXNT(supply.value.total));
        }
        // Remember the live stake/supply so the next reload can paint them
        // before the RPC answers (paintStatsBarFastPath).
        SessionCache.set(STATS_BAR_CACHE_KEY, { totalStakeLamports: totalStake, supplyTotalLamports: supply && supply.value ? supply.value.total : null });

        // Hand the freshly-fetched epoch info to the live updater (single
        // source of truth for the bar — handles rendering and drift correction).
        setEpochBaseline(epochInfo);

        // Expose identities map globally so fallback paths (e.g., zombie validator
        // lookup) can reuse published name/icon data without re-fetching.
        window.validatorIdentities = identities;

        // Build all validators list with names
        allValidators = [...currentValidators, ...delinquentValidators].map(v => {
          const identity = identities[v.nodePubkey];
          return {
            votePubkey: v.votePubkey,
            nodePubkey: v.nodePubkey,
            name: identity ? identity.name : v.nodePubkey.slice(0, 16) + '...',
            website: identity ? identity.website : '',
            iconUrl: identity ? identity.iconUrl : '',
            activatedStake: v.activatedStake,
            commission: v.commission,
            epochCredits: v.epochCredits,
            delinquent: delinquentValidators.some(d => d.votePubkey === v.votePubkey),
            version: versionMap[v.nodePubkey] || null
          };
        });

        // Version adoption (nodes + stake per version) for the tracker strip
        // and the "Update available" badge.
        window.versionStats = buildVersionStats(allValidators, clusterNodes, window.latestValidatorVersion);
        renderVersionStrip();

        // Sort by stake descending to get ranks
        allValidators.sort((a, b) => b.activatedStake - a.activatedStake);
        allValidators.forEach((v, i) => {
          v.rank = i + 1;
          v.totalValidators = totalValidatorsCount;
        });

        // Mark when this list was last refreshed so the lookup tab can
        // decide whether to re-fetch when the user comes looking for a
        // recently-joined validator.
        allValidatorsFetchedAt = Date.now();

        // Calculate network average credits for performance scoring
        calculateNetworkAverageCredits();
        
        // Update uptime tracking for all validators
        updateUptimeTracking(allValidators);
        
        // Fetch skip rates for all validators
        await fetchAllSkipRates();
        
        updatePortfolioCount();

      } catch (err) {
        console.error('Failed to load network stats:', err);
      }
    }

    async function getValidatorInfo(voteAccount, forceRefresh = false) {
      // Check cache
      if (!forceRefresh && validatorInfoCache[voteAccount]) {
        return validatorInfoCache[voteAccount];
      }

      // Check if we have it in allValidators
      let validator = allValidators.find(v => v.votePubkey === voteAccount);
      let rank, totalValidators;
      
      if (validator) {
        // Get fresh rank from allValidators (already sorted by stake)
        rank = allValidators.findIndex(v => v.votePubkey === voteAccount) + 1;
        totalValidators = allValidators.length;
      } else {
        // Fetch fresh
        const voteAccounts = await rpcCall('getVoteAccounts');
        const all = [...voteAccounts.current, ...voteAccounts.delinquent];
        validator = all.find(v => v.votePubkey === voteAccount);

        if (!validator) {
          // Not in the active validator set — try zombie fallback (stake-drained
          // delinquent or similar). Returns null if the vote account is actually
          // closed or invalid, in which case we honor the original "not found".
          const zombie = await fetchZombieValidator(voteAccount);
          if (!zombie) return null;
          validator = zombie;
          // Zombies sit outside the ranked set; mark as unranked.
          rank = null;
          totalValidators = all.length;
        } else {
          validator.delinquent = voteAccounts.delinquent.some(v => v.votePubkey === voteAccount);

          // Calculate rank
          all.sort((a, b) => b.activatedStake - a.activatedStake);
          rank = all.findIndex(v => v.votePubkey === voteAccount) + 1;
          totalValidators = all.length;
        }
      }

      // Fan out the four independent RPC groups in parallel. Previously these
      // ran one-after-another despite having no data dependencies on each
      // other — each call just needs `voteAccount` or `validator.nodePubkey`,
      // both of which are known by this point. Sequential awaits meant every
      // per-validator fetch stacked ~4 round-trips of latency. Promise.all
      // collapses them into ~1 round-trip of latency (queue-limited).
      const [balance, extendedEpochCredits, skipRate, skipRateHistory] = await Promise.all([
        rpcCall('getBalance', [voteAccount]),
        fetchExtendedEpochCredits(voteAccount),
        fetchSkipRate(validator.nodePubkey),
        fetchHistoricalSkipRates(validator.nodePubkey, 7)
      ]);
      const epochCreditsHistory = extendedEpochCredits || validator.epochCredits || [];
      
      const info = {
        name: validator.name || validator.nodePubkey.slice(0, 8) + '...',
        voteAccount: voteAccount,
        nodePubkey: validator.nodePubkey,
        iconUrl: validator.iconUrl || '',
        activatedStake: lamportsToXNT(validator.activatedStake),
        rewardsBalance: lamportsToXNT(balance.value),
        commission: validator.commission,
        isDelinquent: validator.delinquent,
        isZombie: validator.isZombie === true,
        epochCredits: epochCreditsHistory.length > 0 ? epochCreditsHistory[epochCreditsHistory.length - 1][1] : 0,
        epochCreditsHistory: epochCreditsHistory,
        skipRate: skipRate,
        skipRateHistory: skipRateHistory,
        rank: rank,
        totalValidators: totalValidators,
        version: validator.version || null
      };
      
      // Calculate and cache performance score for consistency.
      // Await the published-scores fetch first so the lookup card uses the
      // canonical number whenever it's available (same score for everyone).
      await window.canonicalScoresPromise;
      info.performanceScore = calculatePerformanceScore(info);

      // Cache it
      validatorInfoCache[voteAccount] = info;
      return info;
    }

    // Fetch extended epoch credits history using getAccountInfo (returns more epochs than getVoteAccounts)
    async function fetchExtendedEpochCredits(voteAccount) {
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [voteAccount, { encoding: 'jsonParsed' }]
          })
        });
        
        const data = await response.json();
        if (data.result && data.result.value && data.result.value.data && data.result.value.data.parsed) {
          const parsed = data.result.value.data.parsed;
          if (parsed.info && parsed.info.epochCredits) {
            // epochCredits format: array of { credits, epoch, previousCredits }
            // Convert to our format: [epoch, credits, previousCredits]
            return parsed.info.epochCredits.map(entry => [
              entry.epoch,
              entry.credits,
              entry.previousCredits
            ]);
          }
        }
        return null;
      } catch (e) {
        console.error('Error fetching extended epoch credits:', e);
        return null;
      }
    }

    // Fallback lookup for validators that have fallen out of getVoteAccounts.
    // This happens when a validator is delinquent AND its activated stake has
    // dropped to zero — the RPC hides these by default (keepUnstakedDelinquents
    // defaults to false). Reconstructs a minimal validator record directly from
    // the on-chain vote account so the owner can still find it via Lookup and
    // open the Manage modal. Returns null if the account is closed or not a
    // vote account. The returned record is flagged with isZombie:true so the
    // UI can annotate it, and it is NOT added to the global allValidators list
    // — keeping leaderboards, averages, and the map unaffected.
    async function fetchZombieValidator(voteAccount) {
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [voteAccount, { encoding: 'jsonParsed' }]
          })
        });
        const data = await response.json();
        const value = data?.result?.value;
        if (!value) return null; // Account does not exist (closed)

        // Must be owned by the Vote program to be a valid vote account
        const VOTE_PROGRAM = 'Vote111111111111111111111111111111111111111';
        if (value.owner !== VOTE_PROGRAM) return null;

        const parsed = value.data?.parsed;
        if (!parsed || !parsed.info) return null;
        const info = parsed.info;

        const nodePubkey = info.nodePubkey || info.node || '';
        if (!nodePubkey) return null;

        // Prefer published identity (name + icon) if we have it cached
        const identity = (window.validatorIdentities || {})[nodePubkey] || null;

        return {
          votePubkey: voteAccount,
          nodePubkey: nodePubkey,
          name: identity ? identity.name : nodePubkey.slice(0, 16) + '...',
          website: identity ? identity.website : '',
          iconUrl: identity ? identity.iconUrl : '',
          activatedStake: 0,             // Zombie: no active stake
          commission: typeof info.commission === 'number' ? info.commission : 0,
          epochCredits: Array.isArray(info.epochCredits)
            ? info.epochCredits.map(e => [e.epoch, e.credits, e.previousCredits])
            : [],
          delinquent: true,              // Offline by definition
          version: null,
          isZombie: true                 // Flag for UI / downstream code
        };
      } catch (e) {
        console.error('fetchZombieValidator failed:', e);
        return null;
      }
    }

    // Fetch skip rate from block production data
    async function fetchSkipRate(nodePubkey) {
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBlockProduction',
            params: [{ identity: nodePubkey }]
          })
        });
        
        const data = await response.json();
        if (data.result && data.result.value && data.result.value.byIdentity) {
          const production = data.result.value.byIdentity[nodePubkey];
          if (production && production.length >= 2) {
            const leaderSlots = production[0];
            const blocksProduced = production[1];
            if (leaderSlots > 0) {
              return ((leaderSlots - blocksProduced) / leaderSlots) * 100;
            } else {
              return null; // No leader slots assigned yet
            }
          }
        }
        return null;
      } catch (e) {
        console.error('Error fetching skip rate:', e);
        return null;
      }
    }

    // Cache for historical skip rates per validator
    let skipRateHistoryCache = {};

    // Fetch skip rate for a specific slot range
    async function fetchSkipRateForSlotRange(nodePubkey, firstSlot, lastSlot) {
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBlockProduction',
            params: [{ 
              identity: nodePubkey,
              range: { firstSlot, lastSlot }
            }]
          })
        });
        
        const data = await response.json();
        if (data.result && data.result.value && data.result.value.byIdentity) {
          const production = data.result.value.byIdentity[nodePubkey];
          if (production && production.length >= 2) {
            const leaderSlots = production[0];
            const blocksProduced = production[1];
            if (leaderSlots > 0) {
              return {
                skipRate: ((leaderSlots - blocksProduced) / leaderSlots) * 100,
                leaderSlots,
                blocksProduced
              };
            }
          }
        }
        return null;
      } catch (e) {
        return null;
      }
    }

    // Published 7-epoch skip history (data/scores.json, computed hourly by the
    // scores Action) mapped into the shape fetchHistoricalSkipRates() returns.
    // Same mapping the leaderboard pipeline uses. Returns null when the
    // canonical file is missing/stale or doesn't know this node.
    function publishedSkipHistory(nodePubkey) {
      let doc = window.canonicalScores;
      if (!doc) {
        const d = window.canonicalScoresDoc;
        if (d && d._ageMs <= CANONICAL_SKIP_MAX_AGE_MS) doc = d;   // stale for scoring, fine for skip history
      }
      if (!doc || !doc.validators) return null;
      if (!doc._byNode) {
        doc._byNode = new Map();
        for (const k in doc.validators) { const c = doc.validators[k]; if (c && c.nodePubkey) doc._byNode.set(c.nodePubkey, c); }
      }
      const c = doc._byNode.get(nodePubkey);
      if (!c || typeof c.skipEpochs !== 'number') return null;
      return {
        epochs: [],
        avgSkipRate: c.skipRate7d,
        simpleAvgSkipRate: c.skipRate7d,
        totalLeaderSlots: c.leaderSlots7d,
        epochCount: c.skipEpochs,
        requestedEpochs: 7,
        lastEpochSkipRate: null,
        currentEpoch: doc.epoch,
        source: 'published'
      };
    }

    // Fetch historical skip rates for past epochs
    async function fetchHistoricalSkipRates(nodePubkey, numEpochs = 5) {
      // Check cache
      const cacheKey = nodePubkey;
      const cached = skipRateHistoryCache[cacheKey];
      if (cached && cached.timestamp > Date.now() - 300000) { // 5 min cache
        return cached.data;
      }

      // Published scores first: the Action already crawled 7 epochs of block
      // production for every validator, so a card costs 0 getBlockProduction
      // range calls instead of 7 (each one a full-epoch scan on the RPC).
      try {
        await window.canonicalScoresPromise;
        const pub = publishedSkipHistory(nodePubkey);
        if (pub) {
          skipRateHistoryCache[cacheKey] = { timestamp: Date.now(), data: pub };
          return pub;
        }
      } catch (e) { /* fall through to live RPC */ }

      try {
        // Get epoch info
        const epochInfo = await rpcCall('getEpochInfo');
        const currentEpoch = epochInfo.epoch;
        const slotsPerEpoch = epochInfo.slotsInEpoch;
        const currentSlot = epochInfo.absoluteSlot;
        const slotIndex = epochInfo.slotIndex; // How far into current epoch
        
        // Calculate first slot of current epoch
        const firstSlotOfCurrentEpoch = currentSlot - slotIndex;
        
        // Fetch skip rates for past completed epochs in parallel
        const epochPromises = [];
        for (let i = 1; i <= numEpochs; i++) {
          const epochNum = currentEpoch - i;
          if (epochNum < 0) continue;
          
          const epochFirstSlot = firstSlotOfCurrentEpoch - (i * slotsPerEpoch);
          const epochLastSlot = epochFirstSlot + slotsPerEpoch - 1;
          
          epochPromises.push(
            fetchSkipRateForSlotRange(nodePubkey, epochFirstSlot, epochLastSlot)
              .then(result => ({ epoch: epochNum, ...result }))
          );
        }
        
        const results = await Promise.all(epochPromises);
        const validResults = results.filter(r => r && r.skipRate !== undefined);

        // Compute both: slot-weighted (authoritative) and simple mean (kept for compat).
        // Slot-weighted is the industry-standard approach — it treats one skipped slot the
        // same regardless of which epoch it happened in, so a bad epoch with a small number
        // of leader slots (e.g. 4/32 = 12.5%) doesn't disproportionately lift the average
        // the way a simple-mean-of-percentages does. This matches what the Solana CLI and
        // most other dashboards report.
        let avgSkipRate = null;
        let simpleAvgSkipRate = null;
        const epochCount = validResults.length;
        let totalLeaderSlots = 0;
        let totalSkippedSlots = 0;
        if (epochCount > 0) {
          // Simple mean (legacy)
          simpleAvgSkipRate = validResults.reduce((sum, r) => sum + r.skipRate, 0) / epochCount;

          // Slot-weighted (authoritative)
          for (const r of validResults) {
            if (typeof r.leaderSlots === 'number' && typeof r.blocksProduced === 'number') {
              totalLeaderSlots  += r.leaderSlots;
              totalSkippedSlots += (r.leaderSlots - r.blocksProduced);
            }
          }
          if (totalLeaderSlots > 0) {
            avgSkipRate = (totalSkippedSlots / totalLeaderSlots) * 100;
          } else {
            // Defensive fallback if leaderSlots wasn't present on any result
            avgSkipRate = simpleAvgSkipRate;
          }
        }
        
        // Get last completed epoch's skip rate
        const lastEpochData = validResults.find(r => r.epoch === currentEpoch - 1);
        
        const historyData = {
          epochs: validResults,
          avgSkipRate,               // Slot-weighted — authoritative, used for display
          simpleAvgSkipRate,         // Simple mean of per-epoch %'s — legacy/debug only
          totalLeaderSlots,          // Denominator for slot-weighted
          totalSkippedSlots,         // Numerator for slot-weighted
          epochCount,                // Number of epochs actually in the average
          requestedEpochs: numEpochs,
          lastEpochSkipRate: lastEpochData ? lastEpochData.skipRate : null,
          currentEpoch
        };
        
        // Cache the result
        skipRateHistoryCache[cacheKey] = {
          timestamp: Date.now(),
          data: historyData
        };
        
        return historyData;
      } catch (e) {
        console.error('Error fetching historical skip rates:', e);
        return null;
      }
    }

