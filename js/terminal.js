    // ═══════════════════════════════════════════════════════
    // VALIDATOR TERMINAL — client-side module
    // Bloomberg-style live view of every X1 validator, sorted
    // by self-stake. Adapted from x1-validator-terminal repo
    // to run in-browser as an overlay inside this site.
    // ═══════════════════════════════════════════════════════
    (function () {
      const API = 'https://api.x1.xyz';
      const PAGE = 10000;
      const MAX_OFFSET = 5000;

      let _data = null;       // { cluster, validators, stakes }
      let _computed = null;   // { rows, stakeIndex, agg, pct, cluster, stakesCount }
      let _sortCol = null;
      let _sortDir = 0;       // 1 = desc, -1 = asc, 0 = default
      let _filter = 'all';
      let _autoTimer = null;  // setInterval handle for 1h auto-refresh
      const AUTO_REFRESH_MS = 60 * 60 * 1000;  // 1 hour

      // ── Format helpers ────────────────────────────────
      const fmt2 = lp => (Number(lp) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 2 });
      const fmt0 = lp => (Number(lp) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 0 });
      const num  = (n, d = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
      const esc  = s => String(s ?? '').replace(/[<>&"']/g, c =>
        ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));
      const shortPk = pk => pk.slice(0,6) + '…' + pk.slice(-4);

      // ── Fetch ─────────────────────────────────────────
      // api.x1.xyz serves these payloads UNCOMPRESSED and they are big:
      // /v1/stakes?includeInactive=true is ~11 MB (~7.4k stake accounts as
      // of Sep 2026 — every entry embeds its full validator + pool objects)
      // and /v1/validators is ~2 MB. On a slow or flaky connection (mobile,
      // hotel wifi, VPN) that transfer gets cut off mid-stream, which the
      // browser reports only as a bare "Failed to fetch". The original
      // loader had no timeout, no retry and no fallback, so one hiccup on
      // any of the three requests killed the whole terminal.
      //
      // Every API call now: streams the body (so the loading screen can
      // show real download progress), aborts only if the stream STALLS
      // (no bytes for STALL_MS — a slow-but-steady connection is never
      // punished), and retries with backoff on network errors / 429 / 5xx.
      const STALL_MS      = 30000;   // abort if no bytes arrive for 30s
      const FETCH_RETRIES = 3;       // attempts per request
      const BYTES_KEY     = 'vtLastLoadBytes'; // remembers last full-load size
      let _progress = { bytes: 0, expected: 0, note: '' };
      let _fetchedAt = null;         // Date of the data currently on screen

      function fmtMB(b) { return (b / 1048576).toFixed(1) + ' MB'; }

      function reportProgress(note) {
        if (note !== undefined) _progress.note = note;
        const el = document.querySelector('#vtContent .vt-loading-detail');
        if (!el) return;
        const got = fmtMB(_progress.bytes);
        const exp = _progress.expected ? ' of ~' + fmtMB(_progress.expected) : '';
        el.textContent =
          'Fetching validator and stake data from api.x1.xyz… ' + got + exp +
          (_progress.note ? ' · ' + _progress.note : '');
      }

      function describeError(e, path) {
        const m = (e && e.message) || String(e);
        if (e && e.name === 'AbortError') {
          return new Error('Connection to api.x1.xyz stalled while downloading ' + path +
            ' (no data for ' + (STALL_MS / 1000) + 's). This is a large download (~13 MB) — ' +
            'check your connection and retry.');
        }
        if (e && e.name === 'TypeError') { // "Failed to fetch" / "Load failed"
          return new Error('Could not reach api.x1.xyz for ' + path + ' (' + m + '). ' +
            'Either the API is temporarily unavailable or the ~13 MB download was ' +
            'interrupted. Retried ' + FETCH_RETRIES + '× — please try again in a moment.');
        }
        return e instanceof Error ? e : new Error(m);
      }

      async function apiGet(path, q = {}) {
        const u = new URL(API + path);
        for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v));
        let lastErr = null;
        for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
          const ctrl = new AbortController();
          let timer = null;
          const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), STALL_MS); };
          let counted = 0;
          try {
            bump();
            const r = await fetch(u, { signal: ctrl.signal, cache: 'no-store' });
            if (r.status === 429 || r.status >= 500) {
              throw new Error(path + ' HTTP ' + r.status);          // retryable
            }
            if (!r.ok) {
              const err = new Error(path + ' HTTP ' + r.status);    // 4xx: don't retry
              err.noRetry = true;
              throw err;
            }
            let text;
            if (r.body && typeof r.body.getReader === 'function') {
              const reader = r.body.getReader();
              const chunks = [];
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bump();
                chunks.push(value);
                counted += value.byteLength;
                _progress.bytes += value.byteLength;
                reportProgress();
              }
              const buf = new Uint8Array(counted);
              let off = 0;
              for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
              text = new TextDecoder().decode(buf);
            } else {
              text = await r.text();
              counted = text.length;
              _progress.bytes += counted;
              reportProgress();
            }
            clearTimeout(timer);
            return JSON.parse(text);
          } catch (e) {
            clearTimeout(timer);
            lastErr = e;
            _progress.bytes -= counted;                 // roll back the partial download
            if (e && e.noRetry) break;
            if (attempt < FETCH_RETRIES - 1) {
              const delay = 1000 * Math.pow(2, attempt) + Math.random() * 500;
              console.warn('[VT] ' + path + ' failed (' + ((e && e.message) || e) + ') — retry ' +
                (attempt + 2) + '/' + FETCH_RETRIES + ' in ' + Math.round(delay) + 'ms');
              reportProgress('retrying ' + path + ' (' + (attempt + 2) + '/' + FETCH_RETRIES + ')');
              await new Promise(res => setTimeout(res, delay));
              reportProgress('');
            }
          }
        }
        throw describeError(lastErr, path);
      }

      async function getAll(path, q = {}) {
        // The API rejects offset > 5000 ("offset must not be greater than
        // 5000"), so the old loop (offset += 10000) would 400 the moment a
        // list passed 10k rows. Max reachable is limit=10000 at offset 0
        // plus limit=10000 at offset 5000 = 15k rows, deduped on the
        // overlap. ~7.4k stakes today; revisit if it ever nears 15k.
        const first = await apiGet(path, { ...q, limit: PAGE, offset: 0 });
        if (!Array.isArray(first)) throw new Error(path + ' returned unexpected data');
        if (first.length < PAGE) return first;
        const second = await apiGet(path, { ...q, limit: PAGE, offset: MAX_OFFSET });
        const keyOf = x => x.stakePubkey || x.votePubkey || JSON.stringify(x);
        const seen = new Set(first.map(keyOf));
        const out = first.slice();
        for (const x of second) if (!seen.has(keyOf(x))) { seen.add(keyOf(x)); out.push(x); }
        if (second.length >= PAGE) console.warn('[VT] ' + path + ' may be truncated at 15k rows (API offset cap)');
        return out;
      }

      async function fetchAll() {
        _progress = { bytes: 0, expected: 0, note: '' };
        try { _progress.expected = parseInt(localStorage.getItem(BYTES_KEY) || '0', 10) || 0; } catch (e) {}
        reportProgress('');
        const [cluster, validators, stakes] = await Promise.all([
          apiGet('/v1/cluster'),
          getAll('/v1/validators'),
          getAll('/v1/stakes', { includeInactive: true }),
        ]);
        try { localStorage.setItem(BYTES_KEY, String(_progress.bytes)); } catch (e) {}
        _fetchedAt = new Date();
        return { cluster, validators, stakes };
      }

      // ── Hourly snapshot (preferred source) ────────────
      // A GitHub Action (.github/workflows/update-terminal-snapshot.yml →
      // scripts/build-terminal-snapshot.js) pre-digests the ~13 MB api.x1.xyz
      // payload into data/terminal.json (~0.6 MB, gzipped by Pages) once an
      // hour. We load that first — it is served from this same origin, so it
      // is fast and reliable on any connection — and only fall back to the
      // live API when the snapshot is missing or stale. The "Live" button in
      // the header forces a live fetch for anyone who wants up-to-the-minute
      // numbers.
      const SNAPSHOT_URL        = 'data/terminal.json';
      // GitHub's cron has been running the snapshot bot every 2–5 h, not
      // hourly (measured 2026-09-13). A 3 h cutoff sent most visitors to the
      // 13 MB live download; a half-day-old stake table with a visible age
      // is the better default. The Live button is always there.
      const SNAPSHOT_MAX_AGE_MS = 12 * 3600000;  // >12h old = stale → go live
      let _source = null;                         // 'snapshot' | 'live'

      function snapshotAgeLabel() {
        const ageH = _fetchedAt ? (Date.now() - _fetchedAt.getTime()) / 3600000 : 0;
        if (ageH >= 2) return '<span style="color:#ffab00">Snapshot &middot; ' + Math.floor(ageH) + 'h old</span> &middot; Live for current';
        return 'Hourly snapshot &middot; auto-refresh 1h';
      }

      function inflateSnapshot(doc) {
        if (!doc || doc.version !== 1 || !Array.isArray(doc.validators) || !doc.stakes) {
          throw new Error('snapshot has an unexpected format');
        }
        const vf = doc.validatorFields, sf = doc.stakeFields;
        const validators = doc.validators.map(row => {
          const v = {};
          vf.forEach((f, i) => { v[f] = row[i]; });
          return v;
        });
        const stakes = [];
        for (const [votePubkey, rows] of Object.entries(doc.stakes)) {
          // "" = stake accounts not delegated to any validator; compute()
          // skips them but they count toward the header total, like live.
          for (const row of rows) {
            const s = { votePubkey: votePubkey || null };
            sf.forEach((f, i) => { s[f] = row[i]; });
            // compute() only tests stakePool for truthiness; the snapshot
            // stores it as 0/1.
            s.stakePool = s.stakePool ? true : null;
            stakes.push(s);
          }
        }
        return { cluster: doc.cluster, validators, stakes };
      }

      async function fetchSnapshot() {
        const el = document.querySelector('#vtContent .vt-loading-detail');
        if (el) el.textContent = 'Loading hourly snapshot…';
        // 5-minute cache-bust key, same convention as data/scores.json
        const r = await fetch(SNAPSHOT_URL + '?t=' + Math.floor(Date.now() / 300000), { cache: 'no-cache' });
        if (!r.ok) throw new Error('snapshot HTTP ' + r.status);
        const doc = await r.json();
        const gen = Date.parse(doc.generatedAt);
        if (!gen) throw new Error('snapshot has no generatedAt');
        const age = Date.now() - gen;
        if (age > SNAPSHOT_MAX_AGE_MS) {
          throw new Error('snapshot is ' + Math.round(age / 3600000) + 'h old');
        }
        if (doc.truncated) console.warn('[VT] snapshot flagged as truncated (API offset cap)');
        const data = inflateSnapshot(doc);
        _fetchedAt = new Date(gen);
        _source = 'snapshot';
        console.info('[VT] loaded snapshot generated ' + doc.generatedAt +
          ' (' + data.validators.length + ' validators, ' + data.stakes.length + ' stake accounts)');
        return data;
      }

      // preferLive = true  → live API first, snapshot as a safety net
      // preferLive = false → snapshot first, live API only if it is unusable
      async function loadData(preferLive) {
        if (!preferLive) {
          try { return await fetchSnapshot(); }
          catch (e) { console.warn('[VT] snapshot unavailable (' + e.message + ') — fetching live'); }
        }
        try {
          const data = await fetchAll();
          _source = 'live';
          return data;
        } catch (e) {
          if (preferLive) {
            try {
              const data = await fetchSnapshot();
              console.warn('[VT] live fetch failed (' + e.message + ') — showing snapshot instead');
              return data;
            } catch (e2) { /* fall through to the live error */ }
          }
          throw e;
        }
      }

      // ── Compute breakdown + aggregates ────────────────
      function compute(raw) {
        const { cluster, validators, stakes } = raw;
        const breakdown  = new Map();
        const stakeIndex = new Map();

        for (const s of stakes) {
          const v = s.votePubkey;
          if (!v) continue;
          let b = breakdown.get(v);
          if (!b) {
            b = { fActive:0n, fDel:0n, fCount:0, sActive:0n, sDel:0n, sCount:0, biggestSelf:0n };
            breakdown.set(v, b);
          }
          const amt = BigInt(s.amount || 0);
          const del = BigInt(s.delegatedStake || 0);
          if (s.stakePool) { b.fActive += amt; b.fDel += del; b.fCount++; }
          else {
            b.sActive += amt; b.sDel += del; b.sCount++;
            if (amt > b.biggestSelf) b.biggestSelf = amt;
          }
          if (!stakeIndex.has(v)) stakeIndex.set(v, []);
          stakeIndex.get(v).push({
            p: s.stakePubkey,
            a: String(s.amount || '0'),
            d: String(s.delegatedStake || '0'),
            s: String(s.status || ''),
            x: s.stakePool ? 1 : 0,
          });
        }

        const rows = validators.map(v => {
          const b = breakdown.get(v.votePubkey) || { fActive:0n, fDel:0n, fCount:0, sActive:0n, sDel:0n, sCount:0, biggestSelf:0n };
          const total = b.fActive + b.sActive;
          const selfPct = total > 0n ? Number((b.sActive * 1000000n) / total) / 10000 : 0;
          return { v, b, total, selfPct };
        });

        rows.sort((a, b) =>
          b.b.sActive > a.b.sActive ? 1 :
          b.b.sActive < a.b.sActive ? -1 :
          (BigInt(b.v.activatedStake || 0) > BigInt(a.v.activatedStake || 0) ? 1 : -1)
        );

        const tFnd = rows.reduce((s, r) => s + r.b.fActive, 0n);
        const tSlf = rows.reduce((s, r) => s + r.b.sActive, 0n);
        const tAct = rows.reduce((s, r) => s + BigInt(r.v.activatedStake || 0), 0n);
        const totalSelfPct = tAct > 0n ? Number(tSlf * 1000000n / tAct) / 10000 : 0;

        const x1Rows = rows.filter(r => r.v.x1Labs);
        const nonX1  = rows.filter(r => !r.v.x1Labs);
        const nonX1Self      = nonX1.reduce((s, r) => s + r.b.sActive, 0n);
        const nonX1Activated = nonX1.reduce((s, r) => s + BigInt(r.v.activatedStake || 0), 0n);
        const nonX1SelfPct   = nonX1Activated > 0n ? Number(nonX1Self * 1000000n / nonX1Activated) / 10000 : 0;

        const x1SelfActive = x1Rows.reduce((s, r) => s + r.b.sActive, 0n);
        const x1FndActive  = x1Rows.reduce((s, r) => s + r.b.fActive, 0n);
        const x1AllStakes  = x1SelfActive + x1FndActive;
        const x1SelfCount  = x1Rows.reduce((s, r) => s + r.b.sCount, 0);
        const x1FndCount   = x1Rows.reduce((s, r) => s + r.b.fCount, 0);
        const x1SelfPct    = x1AllStakes > 0n ? Number(x1SelfActive * 1000000n / x1AllStakes) / 10000 : 0;

        const delinqCount = rows.filter(r => r.v.delinquent).length;

        function percentile(arr, p) {
          if (!arr.length) return 0;
          const idx = (p / 100) * (arr.length - 1);
          const lo = Math.floor(idx), hi = Math.ceil(idx);
          if (lo === hi) return arr[lo];
          return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
        }
        const sortedSelf = nonX1.map(r => Number(r.b.sActive) / 1e9).sort((a, b) => a - b);
        const pct = {
          p50: percentile(sortedSelf, 50),
          p75: percentile(sortedSelf, 75),
          p85: percentile(sortedSelf, 85),
          p90: percentile(sortedSelf, 90),
          p95: percentile(sortedSelf, 95),
          p99: percentile(sortedSelf, 99),
        };
        const maxSelf  = sortedSelf.length ? sortedSelf[sortedSelf.length - 1] : 0;
        const meanSelf = sortedSelf.length ? sortedSelf.reduce((a, b) => a + b, 0) / sortedSelf.length : 0;
        const withSelf = sortedSelf.filter(v => v > 0).length;
        const maxSelfLamports = rows.reduce((m, r) => r.b.sActive > m ? r.b.sActive : m, 0n);

        const versions = new Map();
        for (const r of rows) {
          const k = r.v.version || 'unknown';
          versions.set(k, (versions.get(k) || 0) + 1);
        }
        const topVersions = [...versions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);

        return {
          rows, stakeIndex, cluster,
          stakesCount: stakes.length,
          agg: {
            tFnd, tSlf, tAct, totalSelfPct,
            nonX1, nonX1Self, nonX1SelfPct,
            x1Rows, x1AllStakes, x1SelfCount, x1FndCount, x1SelfPct,
            delinqCount, withSelf, maxSelfLamports, meanSelf, maxSelf,
            topVersions, versions,
          },
          pct: { ...pct, maxSelf, meanSelf },
        };
      }

      // ── Render full body ──────────────────────────────
      function render() {
        if (!_computed) return;
        const { rows, agg, pct, cluster, stakesCount } = _computed;
        const isoTime = (_fetchedAt || new Date()).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

        const trs = rows.map((r, i) => {
          const { v, b, selfPct } = r;
          const status = v.delinquent ? 'DLQ' : v.active ? 'OK' : 'INA';
          const cls = v.delinquent ? 'dlq' : (v.active ? '' : 'ina');
          const x1 = v.x1Labs ? '<span class="vt-tag-x1">X1</span>' : '';
          const selfNum = Number(b.sActive);
          const maxNum = Number(agg.maxSelfLamports) || 1;
          const barW = Math.max(0.5, (selfNum / maxNum) * 100);
          const selfClass =
            selfPct >= 50 ? 'vt-pct-hi' :
            selfPct >= 5  ? 'vt-pct-mid' :
            selfPct >  0  ? 'vt-pct-lo' : 'vt-pct-zero';
          const stClass = v.delinquent ? 'st-dlq' : (v.active ? 'st-ok' : 'st-ina');
          const stRank  = v.delinquent ? 2 : v.active ? 0 : 1;
          const search  = (v.votePubkey + ' ' + v.nodePubkey + ' ' + (v.name || '') + ' ' +
                          (v.country || '') + ' ' + (v.version || '') +
                          (v.x1Labs ? ' x1 labs' : '')).toLowerCase();
          const xntActivated = Number(BigInt(v.activatedStake || 0)) / 1e9;
          const xntSelf      = selfNum / 1e9;
          const xntBiggest   = Number(b.biggestSelf) / 1e9;
          const xntFnd       = Number(b.fActive) / 1e9;
          const nameLower    = (v.name || '').toLowerCase();
          const nm           = v.name ? esc(v.name) : '&mdash;';
          const voteShort    = v.votePubkey.slice(0, 6) + '…' + v.votePubkey.slice(-4);
          const idShort      = v.nodePubkey.slice(0, 6) + '…' + v.nodePubkey.slice(-4);

          return '<tr class="' + cls + '" data-search="' + esc(search) + '" data-default="' + i + '">' +
            '<td class="r dim" data-v="' + i + '">' + (i + 1) + '</td>' +
            '<td class="m" data-v="' + esc(v.votePubkey) + '"><span class="pk">' + esc(voteShort) + '</span></td>' +
            '<td class="m id" data-v="' + esc(v.nodePubkey) + '" title="' + esc(v.nodePubkey) + '"><span class="pk dim">' + esc(idShort) + '</span></td>' +
            '<td class="name" data-v="' + esc(nameLower) + '"><span class="nm">' + nm + '</span> ' + x1 + '</td>' +
            '<td class="r dim" data-v="' + (v.commission ?? -1) + '">' + (v.commission ?? '') + '%</td>' +
            '<td data-v="' + stRank + '"><span class="vt-pill ' + stClass + '">' + status + '</span></td>' +
            '<td class="n" data-v="' + xntActivated + '">' + fmt2(v.activatedStake || 0) + '</td>' +
            '<td class="n vt-self-cell" data-v="' + xntSelf + '">' +
              '<span class="bar"><span class="bar-fill" style="width:' + barW.toFixed(2) + '%"></span></span>' +
              '<span class="self-val">' + fmt2(b.sActive) + '</span>' +
            '</td>' +
            '<td class="r dim" data-v="' + b.sCount + '">' + b.sCount + '</td>' +
            '<td class="n dim" data-v="' + xntBiggest + '">' + fmt2(b.biggestSelf) + '</td>' +
            '<td class="n dim" data-v="' + xntFnd + '">' + fmt2(b.fActive) + '</td>' +
            '<td class="r dim" data-v="' + b.fCount + '">' + b.fCount + '</td>' +
            '<td class="r ' + selfClass + '" data-v="' + selfPct + '">' + selfPct.toFixed(2) + '%</td>' +
            '<td class="dim small" data-v="' + esc(v.version || '') + '">' + esc(v.version || '?') + '</td>' +
            '<td class="dim small" data-v="' + esc(v.country || '') + '">' + esc(v.country || '') + '</td>' +
          '</tr>';
        }).join('\n');

        const headHtml =
          '<header class="vt-head">' +
            '<h1>' +
              '<span class="x1-logo-small"><span class="x-char">X</span><span class="one-char">1</span></span>' +
              '<span><span class="word-validator">VALIDATOR</span> <span class="word-terminal">TERMINAL</span></span>' +
            '</h1>' +
            '<div class="meta">' +
              '<span>Real-time validator stake breakdown &middot; X1 mainnet</span>' +
              '<span><b>' + num(stakesCount, 0) + '</b> stake accounts</span>' +
            '</div>' +
            '<div class="vt-refresh-corner">' +
              '<div class="info">' +
                '<div class="lbl">' + (_source === 'live' ? 'Live from api.x1.xyz' : snapshotAgeLabel()) + '</div>' +
                '<div class="upd">Updated ' + isoTime + '</div>' +
              '</div>' +
              '<button id="vtCornerRefresh" onclick="vtRefreshLive()" title="Fetch live data straight from api.x1.xyz (~13 MB download)">' +
                '<span class="vt-refresh-icon">&#x21bb;</span> Live' +
              '</button>' +
            '</div>' +
          '</header>';

        const kpiHtml =
          '<div class="vt-kpi-grid">' +
            '<div class="vt-kpi">' +
              '<div class="lbl">Total Activated</div>' +
              '<div class="v">' + fmt0(agg.tAct) + ' <span style="color:var(--vt-dim);font-size:13px;font-weight:500;">XNT</span></div>' +
              '<div class="sub">across <b>' + rows.length + '</b> validators &middot; ' + agg.delinqCount + ' delinquent</div>' +
            '</div>' +
            '<div class="vt-kpi">' +
              '<div class="lbl">Foundation Pool Stake</div>' +
              '<div class="v cyan">' + fmt0(agg.tFnd) + ' <span style="color:var(--vt-dim);font-size:13px;font-weight:500;">XNT</span></div>' +
              '<div class="sub"><b>' + num(100 - agg.totalSelfPct, 4) + '%</b> of activated &middot; routed via X1 stake pool</div>' +
            '</div>' +
            '<div class="vt-kpi">' +
              '<div class="lbl">Self-Stake (Non-X1)</div>' +
              '<div class="v amber">' + fmt0(agg.nonX1Self) + ' <span style="color:var(--vt-dim);font-size:13px;font-weight:500;">XNT</span></div>' +
              '<div class="sub"><b>' + agg.nonX1.length + '</b> non-X1 validators &middot; ' + agg.withSelf + ' with self &gt; 0 &middot; share <b>' + agg.nonX1SelfPct.toFixed(4) + '%</b></div>' +
            '</div>' +
            '<div class="vt-kpi">' +
              '<div class="lbl">X1 Labs &middot; All Stakes</div>' +
              '<div class="v">' + fmt0(agg.x1AllStakes) + ' <span style="color:var(--vt-dim);font-size:13px;font-weight:500;">XNT</span></div>' +
              '<div class="sub"><b>' + agg.x1Rows.length + '</b> nodes &middot; <b>' + (agg.x1SelfCount + agg.x1FndCount) + '</b> stake accts &middot; self-share <b>' + agg.x1SelfPct.toFixed(0) + '%</b></div>' +
            '</div>' +
            '<div class="vt-kpi">' +
              '<div class="lbl">Mean Self-Stake (Non-X1)</div>' +
              '<div class="v">' + num(agg.meanSelf, 2) + ' <span style="color:var(--vt-dim);font-size:13px;font-weight:500;">XNT</span></div>' +
              '<div class="sub">median <b>' + num(pct.p50, 2) + '</b> &middot; max <b>' + num(agg.maxSelf, 0) + '</b></div>' +
            '</div>' +
            '<div class="vt-kpi">' +
              '<div class="lbl">Top Versions</div>' +
              '<div class="v" style="font-size:13px;line-height:1.45;">' +
                agg.topVersions.map(p => '<span style="color:var(--vt-cyan);">' + esc(p[0]) + '</span> <span style="color:var(--vt-dim);">' + p[1] + '</span>').join(' &middot; ') +
              '</div>' +
              '<div class="sub">' + agg.versions.size + ' distinct client versions</div>' +
            '</div>' +
          '</div>';

        const pctHtml =
          '<div class="vt-pctrow">' +
            '<div class="head">SELF-STAKE PERCENTILES (NON-X1, XNT)</div>' +
            '<div><div class="lbl">P50</div><div class="v">' + num(pct.p50, 2) + '</div></div>' +
            '<div><div class="lbl">P75</div><div class="v hi">' + num(pct.p75, 2) + '</div></div>' +
            '<div><div class="lbl">P85</div><div class="v hi">' + num(pct.p85, 2) + '</div></div>' +
            '<div><div class="lbl">P90</div><div class="v hi">' + num(pct.p90, 2) + '</div></div>' +
            '<div><div class="lbl">P95</div><div class="v">' + num(pct.p95, 2) + '</div></div>' +
            '<div><div class="lbl">P99</div><div class="v">' + num(pct.p99, 2) + '</div></div>' +
            '<div><div class="lbl">Max</div><div class="v">' + num(agg.maxSelf, 2) + '</div></div>' +
          '</div>';

        const toolsHtml =
          '<div class="vt-tools" id="vtTools">' +
            '<div class="label">&#9612; ALL VALIDATORS &middot; SORT &amp; FILTER</div>' +
            '<input id="vtSearch" class="search" placeholder="filter by vote / identity / name / country / version" />' +
            '<div class="seg" id="vtStatusFilter">' +
              '<button data-f="all" class="on">ALL</button>' +
              '<button data-f="ok">CURRENT</button>' +
              '<button data-f="dlq">DELINQ</button>' +
              '<button data-f="x1">X1 LABS</button>' +
              '<button data-f="nox1">NON-X1</button>' +
            '</div>' +
            '<button class="btn" id="vtResetBtn">Reset</button>' +
            '<div class="right">' +
              '<span><b id="vtVisCount">' + rows.length + '</b> shown</span>' +
              '<span class="kbd">Press <kbd>/</kbd> to focus search &middot; <kbd>Esc</kbd> to close</span>' +
            '</div>' +
          '</div>';

        const tableHtml =
          '<div class="vt-tbl-wrap">' +
            '<table class="vt-data" id="vtTbl">' +
              '<thead><tr>' +
                '<th class="r sortable" data-col="0" data-type="num">#<span class="arrow"></span></th>' +
                '<th class="sortable" data-col="1" data-type="str">Vote Account<span class="arrow"></span></th>' +
                '<th class="sortable" data-col="2" data-type="str">Identity<span class="arrow"></span></th>' +
                '<th class="sortable" data-col="3" data-type="str">Name<span class="arrow"></span></th>' +
                '<th class="r sortable" data-col="4" data-type="num">Com<span class="arrow"></span></th>' +
                '<th class="sortable" data-col="5" data-type="num">Status<span class="arrow"></span></th>' +
                '<th class="r sortable" data-col="6" data-type="num">Activated XNT<span class="arrow"></span></th>' +
                '<th class="r sortable" data-col="7" data-type="num">Self XNT<span class="arrow"></span></th>' +
                '<th class="r sortable" data-col="8" data-type="num">#Self<span class="arrow"></span></th>' +
                '<th class="r sortable" data-col="9" data-type="num">Biggest Self<span class="arrow"></span></th>' +
                '<th class="r sortable" data-col="10" data-type="num">Foundation XNT<span class="arrow"></span></th>' +
                '<th class="r sortable" data-col="11" data-type="num">#Fnd<span class="arrow"></span></th>' +
                '<th class="r sortable" data-col="12" data-type="num">Self %<span class="arrow"></span></th>' +
                '<th class="sortable" data-col="13" data-type="str">Ver<span class="arrow"></span></th>' +
                '<th class="sortable" data-col="14" data-type="str">CC<span class="arrow"></span></th>' +
              '</tr></thead>' +
              '<tbody>' + trs + '</tbody>' +
            '</table>' +
          '</div>';

        const footerHtml =
          '<footer class="vt-footer">' +
            '<div class="row">' +
              '<span><span class="vp-dot" onclick="vpOpenProbe()"></span>Generated ' + isoTime + '</span>' +
              '<span>Source &middot; ' + (_source === 'live'
                  ? 'live <code>' + API + '</code>'
                  : 'hourly snapshot <code>' + SNAPSHOT_URL + '</code> (built from <code>' + API + '</code>)') + '</span>' +
              '<span>Definitions &middot; <b>foundation</b> = <code>stakePool &ne; null</code> &middot; <b>self</b> = direct delegations (validator self-stake + 3rd-party direct stakers)</span>' +
            '</div>' +
            '<div class="row" style="margin-top:6px;">' +
              '<span>X1 Labs validators are excluded from non-X1 metrics; they are foundation-operated and have no third-party stake by design.</span>' +
            '</div>' +
          '</footer>' +
          '<div class="vt-tip" id="vtTip" role="tooltip" aria-hidden="true"></div>';

        // Split the render: vt-head goes into its own slot so the stats /
        // epoch panel (moved in by switchTab) can sit BETWEEN the head and
        // the KPI/percentile/table/footer block that lives in vtContent.
        document.getElementById('vtHeadSlot').innerHTML = headHtml;
        document.getElementById('vtContent').innerHTML =
          kpiHtml + pctHtml + toolsHtml + tableHtml + footerHtml;

        wireUp();
      }

      // ── Wire up interactivity after render ────────────
      function wireUp() {
        const overlay   = document.getElementById('vtOverlay');
        const tbody     = document.querySelector('#vtTbl tbody');
        const ths       = document.querySelectorAll('#vtTbl thead th.sortable');
        const search    = document.getElementById('vtSearch');
        const counter   = document.getElementById('vtVisCount');
        const seg       = document.getElementById('vtStatusFilter');
        const resetBtn  = document.getElementById('vtResetBtn');
        const tools     = document.getElementById('vtTools');
        const tip       = document.getElementById('vtTip');
        const allRows   = Array.from(tbody.querySelectorAll('tr'));
        const defaultOrder = allRows.slice();

        // Sticky thead offset
        function syncToolsHeight() {
          const h = Math.ceil(tools.getBoundingClientRect().height) || 48;
          document.documentElement.style.setProperty('--vt-tools-h', h + 'px');
          // Width of the first column, so the second sticky column pins right after it.
          const th1 = document.querySelector('#vtTbl thead th');
          if (th1) document.documentElement.style.setProperty('--vt-col1-w', Math.ceil(th1.getBoundingClientRect().width) + 'px');
        }
        syncToolsHeight();
        window.addEventListener('resize', syncToolsHeight);

        // ── Sort ──
        function compare(a, b, col, type) {
          const ca = a.children[col], cb = b.children[col];
          const va = ca.dataset.v ?? ca.textContent.trim();
          const vb = cb.dataset.v ?? cb.textContent.trim();
          if (type === 'num') {
            const na = parseFloat(va), nb = parseFloat(vb);
            return (isNaN(na) ? -Infinity : na) - (isNaN(nb) ? -Infinity : nb);
          }
          return String(va).localeCompare(String(vb));
        }
        function applySort() {
          let rows;
          if (_sortCol === null) rows = defaultOrder.slice();
          else {
            const type = ths[_sortCol].dataset.type;
            rows = allRows.slice().sort((a, b) => compare(a, b, _sortCol, type) * (_sortDir === -1 ? 1 : -1));
          }
          const frag = document.createDocumentFragment();
          for (const r of rows) frag.appendChild(r);
          tbody.appendChild(frag);
        }
        function updateSortHeaders() {
          ths.forEach(t => t.classList.remove('sort-asc', 'sort-desc'));
          if (_sortCol !== null) ths[_sortCol].classList.add(_sortDir === 1 ? 'sort-desc' : 'sort-asc');
        }
        ths.forEach(th => {
          const colIdx = Number(th.dataset.col);
          th.addEventListener('click', () => {
            if (_sortCol === colIdx) {
              if (_sortDir === 1) _sortDir = -1;
              else if (_sortDir === -1) { _sortCol = null; _sortDir = 0; }
            } else {
              _sortCol = colIdx;
              _sortDir = (th.dataset.type === 'num') ? 1 : -1;
            }
            applySort();
            updateSortHeaders();
          });
        });

        // ── Filter ──
        function applyFilter() {
          const q = (search.value || '').trim().toLowerCase();
          let n = 0;
          for (const r of allRows) {
            const hay = r.dataset.search || '';
            let ok = !q || hay.includes(q);
            if (ok && _filter !== 'all') {
              const cls = r.className;
              const hasX1 = hay.includes('x1 labs');
              if (_filter === 'ok')   ok = !cls.includes('dlq') && !cls.includes('ina');
              if (_filter === 'dlq')  ok = cls.includes('dlq');
              if (_filter === 'x1')   ok = hasX1;
              if (_filter === 'nox1') ok = !hasX1;
            }
            r.style.display = ok ? '' : 'none';
            if (ok) n++;
          }
          counter.textContent = n.toLocaleString('en-US');
        }
        search.addEventListener('input', applyFilter);
        search.addEventListener('keydown', e => {
          if (e.key === 'Escape' && search.value) {
            e.stopPropagation();
            search.value = '';
            applyFilter();
          }
        });
        seg.addEventListener('click', e => {
          const btn = e.target.closest('button[data-f]');
          if (!btn) return;
          seg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
          btn.classList.add('on');
          _filter = btn.dataset.f;
          applyFilter();
        });
        resetBtn.addEventListener('click', () => {
          search.value = '';
          _filter = 'all';
          _sortCol = null;
          _sortDir = 0;
          seg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
          const allBtn = seg.querySelector('button[data-f="all"]');
          if (allBtn) allBtn.classList.add('on');
          applySort();
          updateSortHeaders();
          applyFilter();
        });

        // Re-apply persisted view state (sort + filter) after a refresh re-render.
        // Search input value is restored by refresh() itself via input event.
        if (_filter !== 'all') {
          seg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
          const segBtn = seg.querySelector('button[data-f="' + _filter + '"]');
          if (segBtn) segBtn.classList.add('on');
        }
        if (_sortCol !== null) {
          applySort();
          updateSortHeaders();
        }

        // ── Hover tooltip (per-validator stake breakdown) ──
        function fmtXNT(s, d) { return (Number(s) / 1e9).toLocaleString('en-US', { maximumFractionDigits: d ?? 2 }); }
        function renderTip(vote) {
          const stakes = _computed.stakeIndex.get(vote) || [];
          const validator = (_computed.rows.find(r => r.v.votePubkey === vote) || {}).v || {};
          const sorted = stakes.slice().sort((a, b) => {
            const dd = Number(b.d) - Number(a.d);
            return dd || (Number(b.a) - Number(a.a));
          });
          let totalActive = 0n, totalDelegated = 0n;
          const counts = { active:0, activating:0, deactivating:0, inactive:0 };
          let foundationCnt = 0, directCnt = 0;
          for (const s of stakes) {
            try { totalActive += BigInt(s.a); totalDelegated += BigInt(s.d); } catch (e) {}
            if (counts[s.s] != null) counts[s.s]++;
            if (s.x) foundationCnt++; else directCnt++;
          }
          const tbodyRows = sorted.map(s => {
            const cls = 'vt-stk-' + (s.s || 'inactive');
            const src = s.x ? '<span class="vt-src-pool">FND</span>' : '<span class="vt-src-direct">SELF</span>';
            return '<tr>' +
              '<td class="pk">' + esc(shortPk(s.p)) + '</td>' +
              '<td class="n">' + esc(fmtXNT(s.a)) + '</td>' +
              '<td class="n">' + esc(fmtXNT(s.d)) + '</td>' +
              '<td class="' + cls + '">' + esc(s.s || '') + '</td>' +
              '<td>' + src + '</td>' +
            '</tr>';
          }).join('');
          const statusBits = [
            counts.active        ? '<span class="vt-stk-active">'        + counts.active        + ' active</span>'        : '',
            counts.activating    ? '<span class="vt-stk-activating">'    + counts.activating    + ' activating</span>'    : '',
            counts.deactivating  ? '<span class="vt-stk-deactivating">'  + counts.deactivating  + ' deactivating</span>'  : '',
            counts.inactive      ? '<span class="vt-stk-inactive">'      + counts.inactive      + ' inactive</span>'      : '',
          ].filter(Boolean).join(' &middot; ');
          const x1Tag = validator.x1Labs ? ' <span class="vt-tag-x1" style="font-size:8.5px;">X1</span>' : '';
          return '' +
            '<div class="tip-h">' +
              '<div class="vote">' + esc(vote) + '</div>' +
              '<div class="name">' + esc(validator.name || '(unnamed)') + x1Tag + '</div>' +
              '<div class="totals">' +
                '<span><b>' + stakes.length + '</b> stake accts</span>' +
              '</div>' +
              '<div class="totals">' +
                '<span>active <b class="amber">' + esc(fmtXNT(totalActive)) + '</b> XNT</span>' +
                '<span>delegated <b>' + esc(fmtXNT(totalDelegated)) + '</b> XNT</span>' +
                '<span>foundation <span class="cyan">' + foundationCnt + '</span></span>' +
                '<span>direct <span class="amber">' + directCnt + '</span></span>' +
              '</div>' +
              (statusBits ? '<div class="totals">' + statusBits + '</div>' : '') +
            '</div>' +
            '<table class="tip-tbl">' +
              '<thead><tr><th>STAKE ACCT</th><th class="r">ACTIVE</th><th class="r">DELEGATED</th><th>STATUS</th><th>SRC</th></tr></thead>' +
              '<tbody>' + (tbodyRows || '<tr><td colspan="5" style="text-align:center;color:var(--vt-dim);padding:14px;">no stake accounts</td></tr>') + '</tbody>' +
            '</table>';
        }
        function positionTip(target) {
          const r = target.getBoundingClientRect();
          const tw = tip.offsetWidth, th = tip.offsetHeight;
          const margin = 8;
          // .vt-tip is position:fixed, so it's anchored to the viewport.
          // r.top/left are already viewport coords — no scroll offset needed.
          let left = r.right + 6;
          let top  = r.top;
          if (r.right + 6 + tw > window.innerWidth - margin) {
            left = r.left - tw - 6;
            if (r.left - 6 - tw < margin) {
              left = Math.max(margin, Math.min(window.innerWidth - tw - margin, r.left));
              top  = r.bottom + 4;
            }
          }
          if (r.top + th > window.innerHeight - margin) {
            top = window.innerHeight - th - margin;
          }
          if (r.top < margin) top = margin;
          tip.style.left = left + 'px';
          tip.style.top  = top + 'px';
        }
        let hideT = null, currentVote = null;
        function show(target) {
          clearTimeout(hideT);
          const vote = target && target.dataset.v;
          if (!vote) return;
          if (vote !== currentVote) {
            tip.innerHTML = renderTip(vote);
            currentVote = vote;
          }
          tip.style.display = 'block';
          tip.setAttribute('aria-hidden', 'false');
          positionTip(target);
        }
        function hide() {
          hideT = setTimeout(() => {
            tip.style.display = 'none';
            tip.setAttribute('aria-hidden', 'true');
            currentVote = null;
          }, 120);
        }
        tbody.addEventListener('mouseover', e => {
          const cell = e.target.closest && e.target.closest('td.m:not(.id)');
          if (cell) show(cell);
        });
        tbody.addEventListener('mouseout', e => {
          const cell = e.target.closest && e.target.closest('td.m:not(.id)');
          if (!cell) return;
          const to = e.relatedTarget;
          if (to && (to === tip || tip.contains(to))) return;
          hide();
        });
        tip.addEventListener('mouseenter', () => clearTimeout(hideT));
        tip.addEventListener('mouseleave', hide);
        // Hide the tooltip when the page scrolls (the page is the scroller now
        // that the terminal is an in-flow tab panel rather than a fixed overlay).
        window.addEventListener('scroll', () => {
          if (tip.style.display === 'block') hide();
        }, { passive: true });

        // Auto-focus search shortly after render
        // Desktop only — on touch devices this popped the keyboard every time
        // the tab opened.
        if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
          setTimeout(() => { try { search.focus(); } catch (e) {} }, 50);
        }
      }

      // ── Auto-refresh timer ────────────────────────────
      function startAutoRefresh() {
        stopAutoRefresh();
        _autoTimer = setInterval(() => refresh(false), AUTO_REFRESH_MS);
      }
      function stopAutoRefresh() {
        if (_autoTimer) { clearInterval(_autoTimer); _autoTimer = null; }
      }

      // ── Refresh (re-fetch + re-render) ────────────────
      // Preserves the user's current sort / filter / search across the refresh.
      async function refresh(preferLive) {
        startAutoRefresh();  // reset the 1h timer on every refresh (manual or auto)

        // Capture search input value before render() wipes the DOM
        const searchEl = document.getElementById('vtSearch');
        const prevQuery = searchEl ? searchEl.value : '';

        // Mark both refresh buttons (toolbar + corner) as spinning
        ['vtRefreshBtn', 'vtCornerRefresh'].forEach(id => {
          const b = document.getElementById(id);
          if (b) b.classList.add('spinning');
        });

        try {
          _data = await loadData(!!preferLive);
          _computed = compute(_data);
          render();
          // Restore search query (wireUp recreated the input)
          if (prevQuery) {
            const newSearch = document.getElementById('vtSearch');
            if (newSearch) {
              newSearch.value = prevQuery;
              newSearch.dispatchEvent(new Event('input'));
            }
          }
        } catch (e) {
          // A failed REFRESH used to wipe a perfectly good table and replace
          // it with the error screen — with the 1h auto-refresh, one blip
          // meant anyone who left the tab open came back to "Failed to load
          // terminal data". Keep what we have and show a notice instead.
          if (_computed) showStaleNotice(e);
          else showError(e);
        } finally {
          ['vtRefreshBtn', 'vtCornerRefresh'].forEach(id => {
            const b = document.getElementById(id);
            if (b) b.classList.remove('spinning');
          });
        }
      }

      function showError(err) {
        document.getElementById('vtHeadSlot').innerHTML = '';
        document.getElementById('vtContent').innerHTML =
          '<div class="vt-error">' +
            '<div class="vt-error-title">Failed to load terminal data</div>' +
            '<div class="vt-error-detail">' + esc((err && err.message) || String(err)) + '</div>' +
            '<div class="vt-error-hint">The terminal downloads the full stake list from api.x1.xyz (~13 MB, uncompressed). ' +
              'Slow or unstable connections are the usual cause — the other tabs on this site do not need this download.</div>' +
            '<button onclick="vtRetry()">Retry</button>' +
          '</div>';
      }

      function showStaleNotice(err) {
        const content = document.getElementById('vtContent');
        if (!content) return;
        let n = document.getElementById('vtStaleNotice');
        if (!n) {
          n = document.createElement('div');
          n.id = 'vtStaleNotice';
          n.className = 'vt-stale';
          content.insertBefore(n, content.firstChild);
        }
        const asOf = _fetchedAt ? _fetchedAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'earlier';
        n.innerHTML =
          '<span class="vt-stale-icon">&#9888;</span> ' +
          '<span>Refresh failed — showing data from <b>' + asOf + '</b>. ' +
          '<span class="vt-stale-why">' + esc((err && err.message) || String(err)) + '</span></span> ' +
          '<button onclick="vtRetry()">Retry now</button>';
      }

      // ── Open / close ──────────────────────────────────
      // Visibility is now driven by .tab-content.active (set by switchTab),
      // so open() just handles data loading + auto-refresh, and close()
      // just halts the timer. No more body-overflow hijacking.
      async function open() {
        if (_computed) {
          render();
          startAutoRefresh();
          return;
        }
        // Show loading state (already in DOM from initial render)
        document.getElementById('vtHeadSlot').innerHTML = '';
        document.getElementById('vtContent').innerHTML =
          '<div class="vt-loading">' +
            '<div class="vt-loading-spinner"></div>' +
            '<div class="vt-loading-text">Initializing Terminal</div>' +
            '<div class="vt-loading-detail">Fetching validator and stake data from api.x1.xyz…</div>' +
          '</div>';
        try {
          _data = await loadData(false);
          _computed = compute(_data);
          render();
          startAutoRefresh();
        } catch (e) {
          showError(e);
        }
      }

      function close() {
        stopAutoRefresh();
      }

      // Expose globals for switchTab + inline onclick attributes
      window.vtOpen  = open;
      window.vtClose = close;
      window.vtRetry = () => refresh(false);       // snapshot first, then live
      window.vtRefreshLive = () => refresh(true);  // "Live" button: api.x1.xyz first
    })();


