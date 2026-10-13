    // ═══════════════════════════════════════════════════════════════════════
    // DELEGATOR APR (F11, 2026-10-13) — card tile + Details modal
    // What a delegator earned per XNT, annualised, from the rewards ledger
    // (data/rewards.json): the vote account's inflation reward is the
    // validator's commission slice, so  reward ÷ commission  is the total
    // reward paid on all stake delegated to it that epoch, × (1 − commission)
    // is the delegators' share, ÷ active stake is the per-epoch yield, × epochs
    // per year (216,000 slots at the measured slot time ≈ 22 h → ~397/yr) is
    // the APR. Per-epoch stake/commission come from the ledger's `st` / `c`
    // arrays when present (recorded from 2026-10-13 on), else current values.
    // 0 % commission validators fall back to the reward observed on their own
    // self-stake accounts (`s` ÷ self-stake from the Delegation Program
    // snapshot). Validators at 100 % commission pay delegators nothing.
    // Globals used: Actions, escHtml, formatNumber, RewardsLedger, rpcCall,
    // SessionCache, allValidators, currentSlotsInEpoch, delegEvaluate, delegLoad.
    // ═══════════════════════════════════════════════════════════════════════
    (function () {
      const LONG = 30, SHORT = 7, MIN_EPOCHS = 3;
      const MIN_NETWORK_STAKE_XNT = 1000;            // ignore dust validators in the network comparison
      const FALLBACK_SLOTS = 216000, FALLBACK_SLOT_SEC = 0.368;  // measured 2026-10-13
      const SLOT_CACHE_KEY = 'x1SlotTimeCache', SLOT_CACHE_MS = 3600000;
      const esc = (s) => escHtml(String(s == null ? '' : s));
      const num = (n, d) => formatNumber(n, d == null ? 2 : d);
      const pct = (x, d) => (x == null || !isFinite(x)) ? '—' : num(x, d == null ? 2 : d) + '%';

      // ── Epoch length ──────────────────────────────────────────────
      let _slotSec = null, _slotPromise = null;
      function slotSeconds() {
        if (_slotSec) return Promise.resolve(_slotSec);
        const cached = (typeof SessionCache !== 'undefined') && SessionCache.get(SLOT_CACHE_KEY, SLOT_CACHE_MS);
        if (cached && cached > 0.1 && cached < 2) { _slotSec = cached; return Promise.resolve(_slotSec); }
        if (_slotPromise) return _slotPromise;
        _slotPromise = (async () => {
          try {
            const s = await rpcCall('getRecentPerformanceSamples', [60]);
            const secs = s.reduce((a, x) => a + (x.samplePeriodSecs || 0), 0), slots = s.reduce((a, x) => a + (x.numSlots || 0), 0);
            if (slots > 0 && secs > 0) { _slotSec = secs / slots; if (typeof SessionCache !== 'undefined') SessionCache.set(SLOT_CACHE_KEY, _slotSec); }
          } catch (e) { /* fall back below */ }
          if (!_slotSec) _slotSec = FALLBACK_SLOT_SEC;
          _slotPromise = null;
          return _slotSec;
        })();
        return _slotPromise;
      }
      function epochsPerYear() {
        const slots = (typeof currentSlotsInEpoch !== 'undefined' && currentSlotsInEpoch) || FALLBACK_SLOTS;
        return 365.25 * 86400 / (slots * (_slotSec || FALLBACK_SLOT_SEC));
      }

      // ── Core computation ──────────────────────────────────────────
      function currentOf(vote) {
        const v = (typeof allValidators !== 'undefined' && Array.isArray(allValidators)) ? allValidators.find(x => x.votePubkey === vote) : null;
        return v ? { stakeXnt: Number(v.activatedStake) / 1e9, commission: Number(v.commission), name: v.name } : null;
      }
      function selfStakeXnt(vote) {
        try { const r = typeof delegEvaluate === 'function' ? delegEvaluate(vote) : null; return r && r.entry && r.entry.ss != null ? Number(r.entry.ss) / 1e9 : null; } catch (e) { return null; }
      }

      // rates per epoch for the newest `n` indexed epochs of one validator.
      // fallback = { stakeXnt, commission } used for cells without st / c.
      function rates(vote, n, fallback) {
        const doc = window.RewardsLedger && window.RewardsLedger.doc;
        const e = doc && doc.validators && doc.validators[vote];
        if (!doc || !e || !Array.isArray(e.v)) return null;
        const out = [];
        let method = 'commission';
        for (let i = doc.epochs.length - 1; i >= 0 && out.length < n; i--) {
          const v = e.v[i];
          if (v == null) continue;                           // not indexed / no reward → skip
          const c = (e.c && e.c[i] != null) ? Number(e.c[i]) : (fallback && fallback.commission != null ? Number(fallback.commission) : null);
          const stXnt = (e.st && e.st[i] != null) ? Number(e.st[i]) : (fallback ? fallback.stakeXnt : null);
          if (c == null || !(stXnt > 0)) continue;
          let net, gross;
          if (c >= 100) continue;                           // nothing reaches delegators — handled by the callers
          if (c > 0) { gross = (v / (c / 100)) / (stXnt * 1e9); net = gross * (1 - c / 100); }
          else {
            // 0 % commission: the vote account gets nothing — use the yield on the validator's own stake
            const s = e.s && e.s[i]; const ss = selfStakeXnt(vote);
            if (s == null || !(ss > 0)) continue;
            method = 'self'; net = s / (ss * 1e9); gross = net;
          }
          out.push({ epoch: doc.epochs[i], net, gross, v, c, stXnt });
        }
        return { rows: out, method };
      }
      function summarise(r) {
        if (!r || r.rows.length < MIN_EPOCHS) return null;
        const epy = epochsPerYear();
        const avg = (k) => { const xs = r.rows.map(x => x[k]).filter(x => x != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
        const net = avg('net'), gross = avg('gross');
        return { netApr: net * epy * 100, grossApr: gross == null ? null : gross * epy * 100, netPerEpoch: net * 100, epochs: r.rows.length,
                 first: r.rows[r.rows.length - 1].epoch, last: r.rows[0].epoch, method: r.method, commission: r.rows[0].c, stakeXnt: r.rows[0].stXnt, lastV: r.rows[0].v };
      }
      function aprFor(vote, fallback) {
        const fb = fallback || currentOf(vote);
        const l = summarise(rates(vote, LONG, fb)), s = summarise(rates(vote, SHORT, fb));
        return { long: l, short: s, fallback: fb };
      }

      // Network distribution (net APR over the long window) — cached per ledger build
      let _net = null, _netKey = null;
      function network() {
        const doc = window.RewardsLedger && window.RewardsLedger.doc;
        if (!doc) return null;
        const key = doc.generatedAt + '|' + Math.round(epochsPerYear());
        if (_net && _netKey === key) return _net;
        const xs = [];
        for (const vote of Object.keys(doc.validators)) {
          const cur = currentOf(vote);
          const e = doc.validators[vote];
          const hasLedgerStake = e.st && e.st.some(x => x != null);
          if (!cur && !hasLedgerStake) continue;
          const stake = cur ? cur.stakeXnt : Math.max(...e.st.filter(x => x != null));
          if (!(stake >= MIN_NETWORK_STAKE_XNT)) continue;
          const c = cur ? cur.commission : (e.c || []).find(x => x != null);
          if (!(c > 0) || c >= 100) continue;             // same method for everyone in the comparison
          const r = summarise(rates(vote, LONG, { stakeXnt: stake, commission: c }));
          if (r && isFinite(r.netApr) && r.netApr >= 0 && r.netApr < 100) xs.push(r.netApr);
        }
        xs.sort((a, b) => a - b);
        const q = p => xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null;
        _net = { n: xs.length, median: q(0.5), p90: q(0.9), max: xs.length ? xs[xs.length - 1] : null };
        _netKey = key;
        return _net;
      }

      // ── Card tile ─────────────────────────────────────────────────
      function renderTile(el) {
        const vote = el.dataset.vote; if (!vote) return;
        const valueEl = el.querySelector('.stat-value'); if (!valueEl) return;
        const fb = { stakeXnt: Number(el.dataset.stake) || (currentOf(vote) || {}).stakeXnt || null, commission: el.dataset.commission !== '' && el.dataset.commission != null ? Number(el.dataset.commission) : (currentOf(vote) || {}).commission };
        const details = '<span class="rb-open-link" data-action="apr-details" data-vote="' + esc(vote) + '">Details</span>';
        const sub = (txt) => {
          const row = el.querySelector('.stat-sub-row'), old = el.querySelector('.stat-subtext');
          const html = '<div class="stat-sub-row"><span class="stat-subtext">' + txt + '</span>' + details + '</div>';
          if (row) row.outerHTML = html; else if (old) old.outerHTML = html;
        };
        const doc = window.RewardsLedger && window.RewardsLedger.doc;
        if (!doc) {
          valueEl.innerHTML = '…'; valueEl.style.color = 'var(--text-dim)';
          const old = el.querySelector('.stat-subtext'); if (old) old.textContent = 'estimated · loading';
          return;
        }
        const a = aprFor(vote, fb);
        const trendEl = el.querySelector('.apr-trend');
        if (!a.long && !a.short) {
          valueEl.textContent = fb.commission >= 100 ? '0%' : '—'; valueEl.style.color = 'var(--text-dim)';
          if (trendEl) trendEl.remove();
          sub(fb.commission >= 100 ? '100% commission · nothing to delegators' : 'not enough reward history yet');
          return;
        }
        const main = a.long || a.short;
        valueEl.innerHTML = num(main.netApr, 2) + '<small>%</small>';
        valueEl.style.color = main.netApr > 0 ? 'var(--success)' : 'var(--text-secondary)';
        if (a.short && a.long) {
          const up = a.short.netApr >= a.long.netApr;
          const t = '<span class="stat-change apr-trend ' + (up ? 'up' : 'down') + '" title="Last ' + a.short.epochs + ' epochs">' + SHORT + 'd ' + num(a.short.netApr, 2) + '%</span>';
          if (trendEl) trendEl.outerHTML = t; else valueEl.insertAdjacentHTML('afterend', t);
        } else if (trendEl) trendEl.remove();
        const fee = main.method === 'self' ? 'own-stake yield' : ('net of ' + num(main.commission, 0) + '% fee');
        sub(main.epochs + ' ep · ' + fee);
      }
      function hydrateAll(root) { (root || document).querySelectorAll('.apr-section').forEach(renderTile); }

      // ── Details modal ─────────────────────────────────────────────
      function closeModal() { const m = document.getElementById('aprModal'); if (m) m.style.display = 'none'; }
      async function openModal(vote) {
        const m = document.getElementById('aprModal'), body = document.getElementById('aprModalBody'); if (!m || !body) return;
        m.style.display = 'flex';
        body.innerHTML = '<div class="rb-loading"><div class="loading-spinner-small"></div><span>Reading the rewards ledger…</span></div>';
        try { await Promise.all([window.RewardsLedger.load(), slotSeconds(), (typeof delegLoad === 'function' ? delegLoad().catch(() => {}) : null)]); } catch (e) {}
        let cur = currentOf(vote);
        if (!cur) {   // validator list not loaded (or not in it): take stake/commission from the card's tile
          const t = document.querySelector('.apr-section[data-vote="' + (window.CSS && CSS.escape ? CSS.escape(vote) : vote) + '"]');
          if (t) cur = { stakeXnt: Number(t.dataset.stake) || null, commission: t.dataset.commission !== '' && t.dataset.commission != null ? Number(t.dataset.commission) : null, name: null };
        }
        const name = (cur && cur.name) || vote.slice(0, 8) + '…';
        const sub = document.getElementById('aprModalSub'); if (sub) sub.textContent = name;
        const doc = window.RewardsLedger && window.RewardsLedger.doc;
        if (!doc) { body.innerHTML = '<div class="dm-empty">The rewards ledger is not available right now — APR cannot be estimated.</div>'; return; }
        const a = aprFor(vote, cur);
        const L = a.long || a.short;
        if (!L) {
          body.innerHTML = '<div class="dm-empty">' + (cur && cur.commission >= 100 ? 'This validator keeps 100% of rewards, so delegators earn nothing.' : 'Not enough completed epochs with rewards in the ledger yet (needs ' + MIN_EPOCHS + ').') + '</div>';
          return;
        }
        const S = a.short, net = network(), epy = epochsPerYear();
        const perTenK = L.netApr / 100 * 10000;
        const barW = (x, max) => Math.max(2, Math.min(100, (x / max) * 100)).toFixed(0) + '%';
        const maxBar = Math.max(L.netApr, net ? net.p90 : 0, S ? S.netApr : 0) * 1.1 || 1;
        const method = L.method === 'self'
          ? 'This validator charges 0% commission, so its vote account receives no reward to work from. The figure is the yield observed on its own self-stake accounts (' + esc(num(selfStakeXnt(vote) || 0, 0)) + ' XNT), which earn exactly what a delegator would.'
          : 'The vote account\'s inflation reward is the validator\'s commission slice, so <b>reward ÷ ' + esc(num(L.commission, 0)) + '%</b> recovers the total paid on all stake delegated to it that epoch; <b>× (1 − ' + esc(num(L.commission, 0)) + '%)</b> is the delegators\' share and <b>÷ active stake</b> the per-epoch yield.';
        const stakeNote = (doc.validators[vote] && doc.validators[vote].st && doc.validators[vote].st.some(x => x != null))
          ? 'Stake and commission are the values recorded with each epoch.' : 'Per-epoch stake is not in the ledger yet for these epochs, so today\'s active stake (' + esc(num(L.stakeXnt, 0)) + ' XNT) is used — if stake was added recently the APR is understated; the ' + SHORT + '-epoch figure is the safer read.';
        body.innerHTML =
          '<div class="apm-hero">' +
            '<div><label>Net APR · ' + L.epochs + ' epochs</label><b>' + pct(L.netApr) + '</b><span>what a delegator earns</span></div>' +
            '<div><label>Net APR · ' + (S ? S.epochs : SHORT) + ' epochs</label><b>' + (S ? pct(S.netApr) : '—') + '</b><span>recent trend</span></div>' +
            '<div><label>Gross yield</label><b class="dim">' + pct(L.grossApr) + '</b><span>' + (L.method === 'self' ? 'no commission' : 'before the ' + esc(num(L.commission, 0)) + '% commission') + '</span></div>' +
          '</div>' +
          (net && net.n >= 10 ? '<div class="apm-bars"><label>vs network · net APR · ' + net.n + ' validators with ≥ ' + num(MIN_NETWORK_STAKE_XNT, 0) + ' XNT</label>' +
            '<div class="apm-bar"><span>this</span><i style="width:' + barW(L.netApr, maxBar) + '"></i><em>' + pct(L.netApr) + '</em></div>' +
            '<div class="apm-bar"><span>median</span><i class="net" style="width:' + barW(net.median, maxBar) + '"></i><em>' + pct(net.median) + '</em></div>' +
            '<div class="apm-bar"><span>top 10%</span><i class="net" style="width:' + barW(net.p90, maxBar) + '"></i><em>' + pct(net.p90) + '</em></div></div>' : '') +
          '<div class="apm-rows">' +
            '<div class="apm-row"><span>Epochs used</span><b>' + esc(L.first) + ' → ' + esc(L.last) + ' (' + L.epochs + ' with rewards)</b></div>' +
            '<div class="apm-row"><span>Active stake' + (L.method === 'self' ? '' : ' the reward was earned on') + '</span><b>' + esc(num(L.stakeXnt, 0)) + ' XNT</b></div>' +
            (L.method === 'self' ? '' : '<div class="apm-row"><span>Vote-account reward, epoch ' + esc(L.last) + ' (commission income)</span><b>' + esc(num(L.lastV / 1e9, 2)) + ' XNT</b></div>') +
            '<div class="apm-row"><span>Average yield per epoch</span><b>' + pct(L.netPerEpoch, 4) + '</b></div>' +
            '<div class="apm-row"><span>Epochs per year</span><b>' + esc(num(epy, 0)) + ' <small>(' + esc(num((typeof currentSlotsInEpoch !== 'undefined' && currentSlotsInEpoch) || FALLBACK_SLOTS, 0)) + ' slots × ' + esc(num((_slotSec || FALLBACK_SLOT_SEC) * 1000, 0)) + ' ms ≈ ' + esc(num(((typeof currentSlotsInEpoch !== 'undefined' && currentSlotsInEpoch) || FALLBACK_SLOTS) * (_slotSec || FALLBACK_SLOT_SEC) / 3600, 1)) + ' h)</small></b></div>' +
            '<div class="apm-row"><span>On 10,000 XNT delegated</span><b>≈ ' + esc(num(perTenK, 0)) + ' XNT / year</b></div>' +
          '</div>' +
          '<div class="dm-foot">' + method + ' ' + stakeNote + ' Source: <code>data/rewards.json</code>, rebuilt hourly from on-chain inflation rewards. Estimates from past epochs; future rewards depend on inflation (currently ~' + esc(num(6.4, 1)) + '% to validators and falling), vote credits and stake.</div>';
      }

      // ── Wiring ────────────────────────────────────────────────────
      const mo = new MutationObserver(muts => {
        let found = false;
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches('.apr-section')) { found = true; renderTile(n); }
          else if (n.querySelector && n.querySelector('.apr-section')) { found = true; hydrateAll(n); }
        }
        if (found) ensureData();
      });
      mo.observe(document.body, { childList: true, subtree: true });

      let _ensured = false;
      function ensureData() {
        if (_ensured) return; _ensured = true;
        const after = () => { _ensured = false; hydrateAll(); };
        Promise.all([
          window.RewardsLedger ? Promise.resolve(window.RewardsLedger.load()).catch(() => {}) : null,
          slotSeconds().catch(() => {}),
          (typeof delegLoad === 'function') ? delegLoad().catch(() => {}) : null,
        ]).then(after, after);
      }

      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
      Actions.register({
        'apr-details': (el, e, d) => { e.stopPropagation(); openModal(d.vote); },
        'apr-close':   () => closeModal(),
        'apr-overlay': (el, e) => { if (e.target === el) closeModal(); },
      });
      window.aprFor = aprFor;              // for other modules (fleet board / leaderboards later)
      window.aprHydrate = hydrateAll;
      window.aprNetwork = network;
      window.aprEpochsPerYear = epochsPerYear;
    })();
