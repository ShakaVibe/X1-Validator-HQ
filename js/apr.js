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
    // CREDITS METHOD (2026-11-18, audit #28): when the ledger carries `pv` (the
    // network's reward per staked lamport per vote credit, per epoch) and the
    // validator's `cr` (vote credits earned per epoch), the yield needs no stake
    // and no reward at all:  pv[E] × cr[E] × (1 − commission). Every staked XNT
    // earns the same per vote credit, so this is exact, also for 0 %-commission
    // validators. The stake-based formula above, with its clean-epoch filter,
    // remains only for a ledger (or a validator entry) without those fields.
    // Globals used: Actions, escHtml, formatNumber, RewardsLedger, allValidators,
    // currentSlotsInEpoch, epochsPerYear, measuredSlotMs, ensureMeasuredSlotMs,
    // delegEvaluate, delegLoad.
    // ═══════════════════════════════════════════════════════════════════════
    (function () {
      const LONG = 30, SHORT = 7, MIN_EPOCHS = 3;
      // An epoch in which the validator earned no vote credits at all (offline the whole epoch)
      // paid its delegators nothing, and counts as 0 %. Decision 2026-11-18; set to false to
      // leave such epochs out instead.
      const COUNT_OFFLINE_EPOCHS = true;
      const MAX_CREDITS_PER_EPOCH = 16;              // × slots in the epoch (timely vote credits)
      const MIN_NETWORK_STAKE_XNT = 1000;            // ignore dust validators in the network comparison
      const FALLBACK_SLOTS = 216000;
      const esc = (s) => escHtml(String(s == null ? '' : s));
      const num = (n, d) => formatNumber(n, d == null ? 2 : d);
      const pct = (x, d) => (x == null || !isFinite(x)) ? '—' : num(x, d == null ? 2 : d) + '%';

      // ── Epoch length ──────────────────────────────────────────────
      // One slot time and one epochs-per-year figure for the whole site, both
      // owned by core.js: ensureMeasuredSlotMs() measures (once an hour per
      // session), measuredSlotMs() reads, epochsPerYear() derives.
      function slotSeconds() { return ensureMeasuredSlotMs().then(ms => ms / 1000); }
      function epy() { return epochsPerYear(); }

      // ── Core computation ──────────────────────────────────────────
      function currentOf(vote) {
        const v = (typeof allValidators !== 'undefined' && Array.isArray(allValidators)) ? allValidators.find(x => x.votePubkey === vote) : null;
        return v ? { stakeXnt: Number(v.activatedStake) / 1e9, commission: Number(v.commission), name: v.name } : null;
      }
      function selfStakeXnt(vote) {
        try { const r = typeof delegEvaluate === 'function' ? delegEvaluate(vote) : null; return r && r.entry && r.entry.ss != null ? Number(r.entry.ss) / 1e9 : null; } catch (e) { return null; }
      }

      // ── Clean-epoch filter (audit 2026-11-17 #1, interim guard) ───
      // The ledger's `st` is the stake read when a cell was FETCHED: normally
      // one epoch after the reward was earned, and "that day's" stake for cells
      // re-fetched later. For a validator whose stake moved, reward ÷ st is then
      // wrong in both directions (cards showed 250,000 %). Until APR is computed
      // from vote credits (no stake needed), an epoch is only used when its
      // numbers fit each other. Every staked XNT earns the same per vote credit,
      // so no validator can beat the network's per-epoch rate by much:
      //   reference(E) = median gross rate of the validators whose recorded
      //                  stake was steady around E (their cells are right)
      //   left out: rate > 1.25 × reference          (recorded stake too small)
      //   left out: reward 0 at a commission > 0     (reward and recorded
      //             commission disagree)
      //   left out: rate < 0.9 × reference AND the recorded stake is suspect —
      //             it moved > 0.5 % against the neighbouring cell, is identical
      //             to it (stamped by a re-fetch), or was never recorded
      // A genuinely weak epoch (low credits on a steady stake) is kept. Checked
      // on 2026-11-18 against the credits model for 323 validators: 2 differ by
      // more than 0.25 pts (worst 0.53), down from 122 (worst 250,267).
      const RATE_MAX = 1.25, RATE_MIN = 0.9, STEADY = 0.005, REF_MIN_VALIDATORS = 5;
      function neighbourStake(e, i) {          // the cell before; for the oldest cell, the one after
        if (!e.st) return null;
        const j = i > 0 ? i - 1 : 1;
        return e.st[j] != null ? Number(e.st[j]) : null;
      }
      let _ref = null, _refKey = null;
      function referenceRates() {              // gross per-epoch rate per ledger column, cached per ledger build
        const doc = window.RewardsLedger && window.RewardsLedger.doc;
        if (!doc || !doc.validators || !Array.isArray(doc.epochs)) return null;
        const key = doc.generatedAt + '|' + doc.epochs.length + '|' + Object.keys(doc.validators).length;
        if (_ref && _refKey === key) return _ref;
        const n = doc.epochs.length, buckets = [];
        for (let i = 0; i < n; i++) buckets.push([]);
        for (const vote of Object.keys(doc.validators)) {
          const e = doc.validators[vote];
          if (!e || !Array.isArray(e.v) || !e.st || !e.c) continue;
          for (let i = 0; i < n; i++) {
            if (!(e.v[i] > 0) || e.st[i] == null || e.c[i] == null) continue;
            const st = Number(e.st[i]), c = Number(e.c[i]), nb = neighbourStake(e, i);
            if (!(st >= MIN_NETWORK_STAKE_XNT) || !(c > 0) || c >= 100) continue;
            if (!(nb > 0) || Math.abs(st / nb - 1) > STEADY) continue;
            buckets[i].push((e.v[i] / (c / 100)) / (st * 1e9));
          }
        }
        const ref = buckets.map(xs => {
          if (xs.length < REF_MIN_VALIDATORS) return null;
          xs.sort((a, b) => a - b);
          const m = xs.length >> 1;
          return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
        });
        // An epoch with too few steady validators borrows the nearest epoch's
        // rate — it moves a few % between epochs, far inside the limits above.
        const have = [];
        ref.forEach((x, i) => { if (x != null) have.push(i); });
        if (have.length) for (let i = 0; i < n; i++) {
          if (ref[i] == null) ref[i] = ref[have.reduce((b, j) => Math.abs(j - i) < Math.abs(b - i) ? j : b, have[0])];
        }
        _ref = ref; _refKey = key;
        return ref;
      }

      // Credits method: pv[E] × cr[E] × (1 − commission) for the newest `n` epochs that have
      // both numbers. `offline` = epochs with 0 credits among them (counted as 0 % or left out,
      // see COUNT_OFFLINE_EPOCHS).
      function ratesFromCredits(doc, e, n, fallback) {
        const out = [];
        let offline = 0;
        for (let i = doc.epochs.length - 1; i >= 0 && out.length < n; i--) {
          const pv = doc.pv[i], cr = e.cr[i];
          if (pv == null || cr == null) continue;           // no rate published / before the validator's first epoch
          const c = (e.c && e.c[i] != null) ? Number(e.c[i]) : (fallback && fallback.commission != null ? Number(fallback.commission) : null);
          if (c == null || c >= 100) continue;              // 100 %: nothing reaches delegators — handled by the callers
          if (cr === 0) { if (!COUNT_OFFLINE_EPOCHS) continue; offline++; }
          const gross = pv * cr;
          out.push({ epoch: doc.epochs[i], net: gross * (1 - c / 100), gross, v: e.v ? e.v[i] : null, c, cr,
                     stXnt: (e.st && e.st[i] != null) ? Number(e.st[i]) : (fallback ? fallback.stakeXnt : null) });
        }
        return { rows: out, method: 'credits', dropped: 0, offline };
      }

      // rates per epoch for the newest `n` usable epochs of one validator.
      // fallback = { stakeXnt, commission } used for cells without st / c.
      // `dropped` = epochs left out by the clean-epoch filter on the way.
      function rates(vote, n, fallback) {
        const doc = window.RewardsLedger && window.RewardsLedger.doc;
        const e = doc && doc.validators && doc.validators[vote];
        if (!doc || !e || !Array.isArray(e.v)) return null;
        if (Array.isArray(doc.pv) && Array.isArray(e.cr)) return ratesFromCredits(doc, e, n, fallback);
        const ref = referenceRates();
        const out = [];
        let method = 'commission', dropped = 0;
        for (let i = doc.epochs.length - 1; i >= 0 && out.length < n; i--) {
          const v = e.v[i];
          if (v == null) continue;                           // not indexed / no reward → skip
          const c = (e.c && e.c[i] != null) ? Number(e.c[i]) : (fallback && fallback.commission != null ? Number(fallback.commission) : null);
          const recorded = !!(e.st && e.st[i] != null);
          const stXnt = recorded ? Number(e.st[i]) : (fallback ? fallback.stakeXnt : null);
          if (c == null || !(stXnt > 0)) continue;
          const r = ref && ref[i] > 0 ? ref[i] : null;       // network rate for this epoch (null → no filtering possible)
          let net, gross;
          if (c >= 100) continue;                           // nothing reaches delegators — handled by the callers
          if (c > 0) {
            if (v === 0) { dropped++; continue; }            // a 0 reward cannot be a c % slice of anything
            gross = (v / (c / 100)) / (stXnt * 1e9); net = gross * (1 - c / 100);
            if (r) {
              const ratio = gross / r;
              if (ratio > RATE_MAX) { dropped++; continue; }
              if (ratio < RATE_MIN) {
                const nb = neighbourStake(e, i);
                const suspect = !recorded || (nb != null && (nb === stXnt || Math.abs(stXnt / nb - 1) > STEADY));
                if (suspect) { dropped++; continue; }
              }
            }
          } else {
            // 0 % commission: the vote account gets nothing — use the yield on the validator's own stake
            const s = e.s && e.s[i]; const ss = selfStakeXnt(vote);
            if (s == null || !(ss > 0)) continue;
            method = 'self'; net = s / (ss * 1e9); gross = net;
            if (r && net / r > RATE_MAX) { dropped++; continue; }   // today's self-stake is smaller than it was then
          }
          out.push({ epoch: doc.epochs[i], net, gross, v, c, stXnt });
        }
        return { rows: out, method, dropped };
      }
      function summarise(r) {
        if (!r || r.rows.length < MIN_EPOCHS) return null;
        const k = epy();
        const avg = (k) => { const xs = r.rows.map(x => x[k]).filter(x => x != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
        const net = avg('net'), gross = avg('gross');
        return { netApr: net * k * 100, grossApr: gross == null ? null : gross * k * 100, netPerEpoch: net * 100, epochs: r.rows.length, dropped: r.dropped || 0,
                 offline: r.offline || 0, lastCredits: r.rows[0].cr == null ? null : r.rows[0].cr,
                 first: r.rows[r.rows.length - 1].epoch, last: r.rows[0].epoch, method: r.method, commission: r.rows[0].c, stakeXnt: r.rows[0].stXnt, lastV: r.rows[0].v };
      }
      function aprFor(vote, fallback) {
        const fb = fallback || currentOf(vote);
        const rl = rates(vote, LONG, fb);
        const l = summarise(rl), s = summarise(rates(vote, SHORT, fb));
        return { long: l, short: s, fallback: fb, dropped: rl ? rl.dropped : 0 };
      }

      // Network distribution (net APR over the long window) — cached per ledger build
      let _net = null, _netKey = null;
      function network() {
        const doc = window.RewardsLedger && window.RewardsLedger.doc;
        if (!doc) return null;
        const key = doc.generatedAt + '|' + Math.round(epy());
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
          const viaCredits = Array.isArray(doc.pv) && Array.isArray(e.cr);
          if (!(c >= 0) || c >= 100 || (!viaCredits && !(c > 0))) continue;   // one method for everyone in the comparison
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
          sub(fb.commission >= 100 ? '100% commission · nothing to delegators' : (a.dropped ? 'stake changed · not enough clean epochs yet' : 'not enough reward history yet'));
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
        const fee = main.method === 'self' ? 'own-stake yield' : (main.commission > 0 ? 'net of ' + num(main.commission, 0) + '% fee' : 'no fee');
        sub(main.epochs + ' ep · ' + (main.offline ? main.offline + ' offline · ' : '') + fee);
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
          body.innerHTML = '<div class="dm-empty">' + (cur && cur.commission >= 100 ? 'This validator keeps 100% of rewards, so delegators earn nothing.' : 'Not enough completed epochs with rewards in the ledger yet (needs ' + MIN_EPOCHS + ').' +
            (a.dropped ? ' ' + a.dropped + ' epoch' + (a.dropped === 1 ? ' was' : 's were') + ' left out because the stake recorded for ' + (a.dropped === 1 ? 'it' : 'them') + ' does not fit the reward — this validator\'s stake changed around then.' : '')) + '</div>';
          return;
        }
        const S = a.short, net = network(), k = epy();
        const perTenK = L.netApr / 100 * 10000;
        const barW = (x, max) => Math.max(2, Math.min(100, (x / max) * 100)).toFixed(0) + '%';
        const maxBar = Math.max(L.netApr, net ? net.p90 : 0, S ? S.netApr : 0) * 1.1 || 1;
        const viaCredits = L.method === 'credits';
        const slotsNow = (typeof currentSlotsInEpoch !== 'undefined' && currentSlotsInEpoch) || FALLBACK_SLOTS;
        const method = viaCredits
          ? 'Every staked XNT on the network earns the same reward per vote credit. This validator\'s yield in an epoch is that <b>network rate per credit × the vote credits it earned</b>' + (L.commission > 0 ? ' <b>× (1 − ' + esc(num(L.commission, 0)) + '%)</b> commission' : '') + ', averaged over the epochs above. The rate is read each epoch from the rewards actually paid to stake accounts.' + (L.offline ? ' An epoch with no vote credits at all paid delegators nothing and counts as 0%.' : '')
          : L.method === 'self'
          ? 'This validator charges 0% commission, so its vote account receives no reward to work from. The figure is the yield observed on its own self-stake accounts (' + esc(num(selfStakeXnt(vote) || 0, 0)) + ' XNT), which earn exactly what a delegator would.'
          : 'The vote account\'s inflation reward is the validator\'s commission slice, so <b>reward ÷ ' + esc(num(L.commission, 0)) + '%</b> recovers the total paid on all stake delegated to it that epoch; <b>× (1 − ' + esc(num(L.commission, 0)) + '%)</b> is the delegators\' share and <b>÷ active stake</b> the per-epoch yield.';
        const stakeNote = viaCredits ? '' : (doc.validators[vote] && doc.validators[vote].st && doc.validators[vote].st.some(x => x != null))
          ? 'Stake and commission are the values recorded with each epoch; an epoch is left out when its recorded stake does not fit the reward (the stake changed around it).' :'Per-epoch stake is not in the ledger yet for these epochs, so today\'s active stake (' + esc(num(L.stakeXnt, 0)) + ' XNT) is used — if stake was added recently the APR is understated; the ' + SHORT + '-epoch figure is the safer read.';
        body.innerHTML =
          '<div class="apm-hero">' +
            '<div><label>Net APR · ' + L.epochs + ' epochs</label><b>' + pct(L.netApr) + '</b><span>what a delegator earns</span></div>' +
            '<div><label>Net APR · ' + (S ? S.epochs : SHORT) + ' epochs</label><b>' + (S ? pct(S.netApr) : '—') + '</b><span>recent trend</span></div>' +
            '<div><label>Gross yield</label><b class="dim">' + pct(L.grossApr) + '</b><span>' + (L.method === 'self' || !(L.commission > 0) ? 'no commission' : 'before the ' + esc(num(L.commission, 0)) + '% commission') + '</span></div>' +
          '</div>' +
          (net && net.n >= 10 ? '<div class="apm-bars"><label>vs network · net APR · ' + net.n + ' validators with ≥ ' + num(MIN_NETWORK_STAKE_XNT, 0) + ' XNT</label>' +
            '<div class="apm-bar"><span>this</span><i style="width:' + barW(L.netApr, maxBar) + '"></i><em>' + pct(L.netApr) + '</em></div>' +
            '<div class="apm-bar"><span>median</span><i class="net" style="width:' + barW(net.median, maxBar) + '"></i><em>' + pct(net.median) + '</em></div>' +
            '<div class="apm-bar"><span>top 10%</span><i class="net" style="width:' + barW(net.p90, maxBar) + '"></i><em>' + pct(net.p90) + '</em></div></div>' : '') +
          '<div class="apm-rows">' +
            '<div class="apm-row"><span>Epochs used</span><b>' + esc(L.first) + ' → ' + esc(L.last) + ' (' + L.epochs + (viaCredits ? ')' : ' with rewards)') + '</b></div>' +
            (L.dropped ? '<div class="apm-row"><span>Epochs left out</span><b>' + esc(L.dropped) + ' <small>(stake changed · recorded stake does not fit the reward)</small></b></div>' : '') +
            (viaCredits
              ? (L.offline ? '<div class="apm-row"><span>Epochs offline</span><b>' + esc(L.offline) + ' of ' + L.epochs + ' <small>(no vote credits · counted as 0%)</small></b></div>' : '') +
                '<div class="apm-row"><span>Vote credits, epoch ' + esc(L.last) + '</span><b>' + esc(num(L.lastCredits, 0)) + ' <small>(' + esc(num(L.lastCredits / (slotsNow * MAX_CREDITS_PER_EPOCH) * 100, 1)) + '% of the maximum)</small></b></div>'
              : '<div class="apm-row"><span>Active stake' + (L.method === 'self' ? '' : ' the reward was earned on') + '</span><b>' + esc(num(L.stakeXnt, 0)) + ' XNT</b></div>' +
                (L.method === 'self' ? '' : '<div class="apm-row"><span>Vote-account reward, epoch ' + esc(L.last) + ' (commission income)</span><b>' + esc(num(L.lastV / 1e9, 2)) + ' XNT</b></div>')) +
            '<div class="apm-row"><span>Average yield per epoch</span><b>' + pct(L.netPerEpoch, 4) + '</b></div>' +
            '<div class="apm-row"><span>Epochs per year</span><b>' + esc(num(k, 0)) + ' <small>(' + esc(num((typeof currentSlotsInEpoch !== 'undefined' && currentSlotsInEpoch) || FALLBACK_SLOTS, 0)) + ' slots × ' + esc(num(measuredSlotMs(), 0)) + ' ms ≈ ' + esc(num(((typeof currentSlotsInEpoch !== 'undefined' && currentSlotsInEpoch) || FALLBACK_SLOTS) * measuredSlotMs() / 3600000, 1)) + ' h)</small></b></div>' +
            '<div class="apm-row"><span>On 10,000 XNT delegated</span><b>≈ ' + esc(num(perTenK, 0)) + ' XNT / year</b></div>' +
          '</div>' +
          '<div class="dm-foot">' + method + ' ' + stakeNote + ' Source: <code>data/rewards.json</code>, rebuilt hourly from on-chain ' + (viaCredits ? 'vote credits and ' : '') + 'inflation rewards. Estimates from past epochs; future rewards depend on inflation (currently ~' + esc(num(6.4, 1)) + '% to validators and falling), vote credits and stake.</div>';
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

      // A tile rendered before the ledger arrived shows "…" until this fills it.
      // It needs only the ledger: the slot time refines epochs/year and the
      // delegation snapshot matters for 0 %-commission validators, so each of
      // those re-renders the tiles when it arrives. They used to be awaited all
      // together, so one stalled request (delegation.json, or a slow RPC for
      // the slot time) held every tile on "…" with the ledger long loaded
      // (seen once live on 2026-11-18, right after a deploy).
      let _ensured = false;
      function ensureData() {
        if (_ensured) return; _ensured = true;
        const again = () => hydrateAll();
        const ledger = window.RewardsLedger ? Promise.resolve(window.RewardsLedger.load()).catch(() => {}) : Promise.resolve();
        ledger.then(() => { _ensured = false; hydrateAll(); });
        slotSeconds().then(again, again);
        if (typeof delegLoad === 'function') delegLoad().then(again, again);
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
      window.aprEpochsPerYear = epy;

      // Tiles that are already on the page. init() runs at the end of js/modals.js,
      // before this file is loaded, so on a slow load a deep-linked card can be
      // rendered before the observer above exists and would stay on "…" for good
      // (seen live twice on 2026-11-18, each time on the first load after a deploy).
      if (document.querySelector('.apr-section')) { hydrateAll(); ensureData(); }
    })();
