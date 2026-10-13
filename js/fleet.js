    // ═══════════════════════════════════════════════════════════════════════
    // FLEET HEALTH (F4) — My Data Center bar + issues-first table
    // One line between the summary tiles and the cards: overall state,
    // what is wrong in plain words, Critical / Watch / Healthy counts and a
    // Details button that expands the per-validator table. Checks mirror the
    // Telegram alerts bot (scripts/alerts-bot.js): delinquency, leader-slot
    // skips vs the cluster rate, version vs the Foundation minimum,
    // Delegation Program status / criteria, vote credits, self-stake.
    // Data: the validator objects loadPortfolio() already fetched, the
    // Delegation Program snapshot (delegEvaluate / window.delegationConfig /
    // window.delegationCluster) and the rewards ledger (RewardsLedger) —
    // no network calls of its own.
    // Globals used: Actions, escHtml, formatNumber, lookupValidator,
    // delegEvaluate, delegLoad, RewardsLedger (all defined in earlier files).
    // ═══════════════════════════════════════════════════════════════════════
    (function () {
      const LS_OPEN = 'x1FleetOpen';
      const DEFAULT_MIN_SELF = 5000;          // XNT, used only until the Program config has loaded
      let _validators = [];                   // from loadPortfolio (sorted by name)
      let _filter = 'all';                    // all | crit | warn | ok
      let _open = readOpen();
      let _hooked = false;

      function readOpen() { try { return localStorage.getItem(LS_OPEN) === '1'; } catch (e) { return false; } }
      function writeOpen(v) { try { localStorage.setItem(LS_OPEN, v ? '1' : '0'); } catch (e) {} }

      const esc = (s) => escHtml(String(s == null ? '' : s));
      const num = (n, d) => (typeof formatNumber === 'function') ? formatNumber(n, d == null ? 0 : d) : String(n);
      const pct = (n, d) => (n == null || !isFinite(n)) ? '—' : Number(n).toFixed(d == null ? 2 : d) + '%';

      function semverParts(v) {
        const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
      }
      function semverGte(a, b) {
        const x = semverParts(a), y = semverParts(b);
        if (!x || !y) return null;
        for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
        return true;
      }

      // ── Last completed epoch's reward (vote + self-stake) from the ledger ──
      function lastEpochFromLedger(v) {
        const L = window.RewardsLedger, doc = L && L.doc;
        if (!doc || !Array.isArray(doc.epochs) || !doc.epochs.length) return null;
        const epochs = doc.epochs.slice(-3);
        const got = L.rows(v.voteAccount, epochs, v.commission || 0);
        if (!got || !got.rows) return null;
        for (let i = epochs.length - 1; i >= 0; i--) {
          const r = got.rows.get(epochs[i]);
          if (r && r.indexed) return { xnt: (r.amount || 0) / 1e9, epoch: r.epoch };
        }
        return null;
      }

      // ── Evaluate one Data Center validator ─────────────────────────
      function evaluate(v) {
        const cfg = window.delegationConfig || {};
        const cl = window.delegationCluster || {};
        const minSelf = cfg.minSelfStake ? Number(cfg.minSelfStake) / 1e9 : DEFAULT_MIN_SELF;
        const minVer = cfg.minValidatorVersion || null;
        const clusterSkip = cl.skipRatePct != null ? Number(cl.skipRatePct) : null;
        const tolerance = cfg.skipRateTolerancePct != null ? Number(cfg.skipRateTolerancePct) : 10;

        const dg = (typeof delegEvaluate === 'function') ? delegEvaluate(v.voteAccount) : null;
        const e = dg && dg.entry ? dg.entry : null;
        const issues = [];
        const add = (sev, html) => issues.push({ sev, html });

        // 1. Delinquency (live, from getVoteAccounts)
        const delinquent = !!v.isDelinquent;
        if (delinquent) add('crit', '<b>Delinquent</b> — not voting' + (v.isZombie ? ' (outside the active set)' : ''));

        // 2. Version vs Foundation minimum (live version from gossip)
        const ver = v.version || null;
        let verState = 'ok';
        if (!ver) { verState = 'unknown'; add('warn', 'No version reported in gossip'); }
        else if (minVer) {
          const ok = semverGte(ver, minVer);
          if (ok === false) { verState = 'below'; add('crit', 'Version <b>' + esc(ver) + '</b> is below the Foundation minimum ' + esc(minVer) + ' — delegation at risk'); }
        }

        // 3. Leader-slot skips this epoch (live rate when we have it, slots from the snapshot)
        const liveSkip = (typeof v.skipRate === 'number' && isFinite(v.skipRate)) ? v.skipRate : null;
        const snapSkip = e && e.sk != null ? Number(e.sk) : null;
        const slots = e && e.ls != null ? Number(e.ls) : null;
        const skip = liveSkip != null ? liveSkip : snapSkip;
        const skipped = (slots && skip != null) ? Math.round(skip / 100 * slots) : null;
        let skipState = 'ok';
        if (skip != null && skip > 0) {
          const limit = clusterSkip != null ? clusterSkip + tolerance : null;
          if (limit != null && skip > limit) {
            skipState = 'crit';
            add('crit', 'Skip rate <b>' + pct(skip) + '</b> is over the Delegation Program limit (' + pct(limit) + ')');
          } else if (clusterSkip == null || skip > clusterSkip) {
            skipState = 'warn';
            const what = (skipped != null && slots) ? '<b>' + skipped + ' of ' + slots + '</b> leader slots' : 'leader slots';
            add('warn', 'Skipped ' + what + ' this epoch (' + pct(skip) + (clusterSkip != null ? ' · cluster ' + pct(clusterSkip) : '') + ')');
          }
        }

        // 4. Delegation Program status + criteria (snapshot)
        let delegStatus = 'none', delegText = 'Not enrolled', delegated = 0, unmet = [];
        if (dg) {
          delegStatus = dg.status; delegated = (dg.delegated || 0) / 1e9;   // lamports → XNT
          unmet = (dg.rows || []).filter(r => r.ok === false).map(r => r.key);
          if (dg.status === 'rejected') { delegText = 'Rejected'; add('crit', 'Delegation Program <b>rejected</b>' + (unmet.length ? ' — ' + esc(unmet.join(', ')) : '')); }
          else if (dg.status === 'failing') {
            delegText = 'Failing';
            // skip / version / delinquency already have their own lines — only list the rest
            const rest = unmet.filter(k => k !== 'maxSkipRate' && k !== 'minValidatorVersion' && k !== 'delinquent');
            if (rest.length) add('warn', 'Delegation Program: not meeting <b>' + esc(rest.join(', ')) + '</b>');
            else if (!issues.length) add('warn', 'Delegation Program: flagged by the Foundation in a recent check');
          }
          else if (dg.status === 'delegated') delegText = 'Approved';
          else if (dg.status === 'approved') delegText = 'Approved';
        }

        // 5. Self-stake vs minimum (snapshot). Below the minimum is already a
        //    Program failure above; near the minimum is a heads-up.
        const self = e && e.ss != null ? Number(e.ss) / 1e9 : null;
        let selfState = 'ok';
        if (self != null) {
          if (self < minSelf) { selfState = 'below'; if (!unmet.includes('minSelfStake')) add('warn', 'Self-stake <b>' + num(self) + ' XNT</b> — short by ' + num(minSelf - self) + ' of the ' + num(minSelf) + ' minimum'); }
          else if (self < minSelf * 1.1) { selfState = 'near'; add('warn', 'Self-stake <b>' + num(self) + ' XNT</b> is within 10% of the ' + num(minSelf) + ' minimum'); }
        }

        // 6. Vote credits vs cluster average (snapshot)
        if (e && e.vc != null && cl.avgVoteCreditsPct && cfg.voteCreditsThresholdPct != null) {
          const ratio = (Number(e.vc) / Number(cl.avgVoteCreditsPct)) * 100;
          if (ratio < Number(cfg.voteCreditsThresholdPct) + 3 && !unmet.includes('minVoteCredits')) {
            add('warn', 'Vote credits at <b>' + ratio.toFixed(1) + '%</b> of the cluster average (Program threshold ' + cfg.voteCreditsThresholdPct + '%)');
          }
        }

        const sev = issues.some(i => i.sev === 'crit') ? 'crit' : issues.length ? 'warn' : 'ok';
        if (!issues.length) {
          const bits = ['No issues', delinquent ? '' : 'voting', ver ? 'v' + esc(ver) : '', delegStatus === 'approved' || delegStatus === 'delegated' ? 'Delegation Program approved' : ''].filter(Boolean);
          add('ok', bits.join(' · '));
        }

        const score = (typeof v.performanceScore === 'number') ? v.performanceScore : null;
        return {
          vote: v.voteAccount, name: v.name || v.voteAccount.slice(0, 8) + '…', iconUrl: v.iconUrl || '',
          sev, issues, delinquent,
          score, skip, skipped, slots, skipState, liveSkip: liveSkip != null,
          ver, verState, minVer,
          delegStatus, delegText, delegated, unmet,
          self, selfState, minSelf,
          lastEpoch: lastEpochFromLedger(v),
        };
      }

      // ── Rendering ─────────────────────────────────────────────────
      const SEV_RANK = { crit: 0, warn: 1, ok: 2 };
      function sortRows(rows) {
        return rows.slice().sort((a, b) => (SEV_RANK[a.sev] - SEV_RANK[b.sev]) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      }

      function summaryText(rows) {
        const crit = rows.filter(r => r.sev === 'crit'), warn = rows.filter(r => r.sev === 'warn'), ok = rows.filter(r => r.sev === 'ok');
        if (!rows.length) return 'No validators in your Data Center yet';
        if (!crit.length && !warn.length) {
          const n = rows.length;
          const vers = [...new Set(rows.map(r => r.ver).filter(Boolean))];
          const allApproved = rows.every(r => r.delegStatus === 'approved' || r.delegStatus === 'delegated');
          return '<b>All ' + n + ' healthy</b> · voting' + (vers.length === 1 ? ' · v' + esc(vers[0]) : '') + (allApproved ? ' · Delegation Program approved' : '');
        }
        // name the worst problems first, short form
        const parts = [];
        const headline = (r) => {
          if (r.delinquent) return '<span class="c">' + esc(r.name) + ' is delinquent</span>';
          if (r.verState === 'below') return '<span class="c">' + esc(r.name) + ' is on v' + esc(r.ver) + '</span> (min ' + esc(r.minVer) + ')';
          if (r.skipState === 'crit') return '<span class="c">' + esc(r.name) + ' skip rate ' + pct(r.skip) + '</span>';
          if (r.delegStatus === 'rejected') return '<span class="c">' + esc(r.name) + ' rejected by the Program</span>';
          if (r.skipState === 'warn') return '<span class="w">' + esc(r.name) + ' skipped ' + (r.skipped != null && r.slots ? r.skipped + ' of ' + r.slots + ' slots' : 'leader slots') + '</span>';
          if (r.delegStatus === 'failing') return '<span class="w">' + esc(r.name) + ' failing ' + (r.unmet.length || 1) + ' Program criteri' + (r.unmet.length === 1 ? 'on' : 'a') + '</span>';
          if (r.selfState !== 'ok') return '<span class="w">' + esc(r.name) + ' self-stake near the minimum</span>';
          if (r.verState === 'unknown') return '<span class="w">' + esc(r.name) + ' has no version in gossip</span>';
          return '<span class="w">' + esc(r.name) + ' needs a look</span>';
        };
        crit.concat(warn).slice(0, 3).forEach(r => parts.push(headline(r)));
        const more = crit.length + warn.length - 3;
        if (more > 0) parts.push('+' + more + ' more');
        if (ok.length) parts.push('<b>' + ok.length + '</b> healthy');
        return parts.join(' · ');
      }

      function renderBar(rows) {
        const crit = rows.filter(r => r.sev === 'crit').length, warn = rows.filter(r => r.sev === 'warn').length, ok = rows.filter(r => r.sev === 'ok').length;
        const cls = crit ? 'has-crit' : warn ? 'has-warn' : '';
        const cl = window.delegationCluster || {};
        const meta = cl.epoch ? 'epoch ' + esc(cl.epoch) : '';
        const chip = (key, label, n) => n ? '<button type="button" class="fleet-chip ' + key + (_filter === key ? ' active' : '') + '" data-action="fleet-filter" data-filter="' + key + '" title="Show only these">' + label + ' <b>' + n + '</b></button>' : '';
        return '<div class="fleet-bar ' + cls + (_open ? ' open' : '') + '" id="fleetBar">' +
          '<span class="fleet-bar-title">Fleet health</span>' +
          '<span class="fleet-bar-text">' + summaryText(rows) + '</span>' +
          '<div class="fleet-sum">' + chip('crit', 'Critical', crit) + chip('warn', 'Watch', warn) + chip('ok', 'Healthy', ok) + '</div>' +
          (meta ? '<span class="fleet-bar-meta">' + meta + '</span>' : '') +
          '<button type="button" class="fleet-bar-btn" data-action="fleet-toggle" aria-expanded="' + (_open ? 'true' : 'false') + '" aria-controls="fleetBoard">' + (_open ? 'Hide <span class="chev">▲</span>' : 'Details <span class="chev">▼</span>') + '</button>' +
          '</div>';
      }

      const scoreCls = (s) => s == null ? 'fleet-dim' : s >= 95 ? 'fleet-good' : s >= 80 ? 'fleet-warnc' : 'fleet-bad';
      function cellSkip(r) {
        if (r.skip == null) return '<span class="fleet-dim">—</span><span class="fleet-sub">no slots yet</span>';
        const c = r.skipState === 'crit' ? 'fleet-bad' : r.skipState === 'warn' ? 'fleet-warnc' : '';
        const sub = (r.skipped != null && r.slots) ? r.skipped + '/' + r.slots + ' slots' : (r.liveSkip ? 'this epoch' : 'snapshot');
        return '<span class="' + c + '">' + pct(r.skip) + '</span><span class="fleet-sub">' + sub + '</span>';
      }
      function cellVer(r) {
        if (!r.ver) return '<span class="fleet-warnc">unknown</span>' + (r.minVer ? '<span class="fleet-sub">min ' + esc(r.minVer) + '</span>' : '');
        if (r.verState === 'below') return '<span class="fleet-bad">v' + esc(r.ver) + '</span><span class="fleet-sub fleet-bad">min ' + esc(r.minVer) + '</span>';
        return '<span class="fleet-good">v' + esc(r.ver) + '</span>';
      }
      function cellDeleg(r) {
        if (r.delegStatus === 'none') return '<span class="fleet-pill dim">Not enrolled</span>';
        if (r.delegStatus === 'rejected') return '<span class="fleet-pill bad">Rejected</span><span class="fleet-sub">' + (r.unmet.length || 1) + ' unmet</span>';
        if (r.delegStatus === 'failing') return '<span class="fleet-pill warn">Failing</span><span class="fleet-sub">' + esc(r.unmet.join(', ') || 'see Details') + '</span>';
        return '<span class="fleet-pill ok">Approved</span><span class="fleet-sub">' + (r.delegated > 0 ? num(r.delegated) + ' XNT delegated' : 'awaiting delegation') + '</span>';
      }
      function cellSelf(r) {
        if (r.self == null) return '<span class="fleet-dim">—</span>';
        if (r.selfState === 'below') return '<span class="fleet-bad">' + num(r.self) + '</span><span class="fleet-sub fleet-bad">short by ' + num(r.minSelf - r.self) + '</span>';
        return num(r.self) + '<span class="fleet-sub' + (r.selfState === 'near' ? ' fleet-warnc' : '') + '">' + num(r.self - r.minSelf) + ' over min</span>';
      }
      function cellLast(r) {
        if (!r.lastEpoch) return '<span class="fleet-dim">…</span>';
        return '<span class="fleet-good">' + num(r.lastEpoch.xnt, 2) + '</span><span class="fleet-sub">#' + esc(r.lastEpoch.epoch) + '</span>';
      }
      function logo(r) {
        const letter = esc((r.name || '?').charAt(0).toUpperCase());
        return r.iconUrl
          ? '<span class="fleet-logo"><img src="' + safeUrl(r.iconUrl) + '" alt="" data-onerror="img-fallback-text" data-fallback="' + letter + '"></span>'
          : '<span class="fleet-logo">' + letter + '</span>';
      }
      const issuesHtml = (r) => '<div class="fleet-issues">' + r.issues.map(i => '<span class="fleet-issue ' + i.sev + '">' + i.html + '</span>').join('') + '</div>';
      const statusPill = (r) => r.delinquent ? '<span class="fleet-pill bad">DELINQUENT</span>' : '<span class="fleet-pill ok">VOTING</span>';
      const shortVote = (v) => esc(v.slice(0, 4)) + '…' + esc(v.slice(-4));

      function renderTable(rows, stateCls) {
        const shown = _filter === 'all' ? rows : rows.filter(r => r.sev === _filter);
        const trs = shown.map(r =>
          '<tr class="sev-' + r.sev + '" data-action="fleet-row" data-vote="' + esc(r.vote) + '" title="Open ' + esc(r.name) + ' in Validator Lookup" tabindex="0">' +
          '<td><div class="fleet-name">' + logo(r) + '<div class="fleet-name-text">' + esc(r.name) + '<small>' + shortVote(r.vote) + ' · ' + statusPill(r) + '</small></div></div></td>' +
          '<td>' + issuesHtml(r) + '</td>' +
          '<td class="r"><span class="' + scoreCls(r.score) + '">' + (r.score == null ? '—' : num(r.score, 1)) + '</span></td>' +
          '<td class="r">' + cellSkip(r) + '</td>' +
          '<td>' + cellVer(r) + '</td>' +
          '<td>' + cellDeleg(r) + '</td>' +
          '<td class="r">' + cellSelf(r) + '</td>' +
          '<td class="r">' + cellLast(r) + '</td>' +
          '</tr>').join('');
        const cards = shown.map(r =>
          '<div class="fleet-card sev-' + r.sev + '" data-action="fleet-row" data-vote="' + esc(r.vote) + '" tabindex="0">' +
          '<div class="fleet-name">' + logo(r) + '<div class="fleet-name-text">' + esc(r.name) + '<small>' + shortVote(r.vote) + '</small></div></div>' +
          '<div>' + statusPill(r) + '</div>' +
          issuesHtml(r) +
          '<div class="fleet-kv">' +
          '<div><label>Score</label><span class="' + scoreCls(r.score) + '">' + (r.score == null ? '—' : num(r.score, 1)) + '</span></div>' +
          '<div><label>Skip · epoch</label>' + (r.skip == null ? '—' : pct(r.skip)) + '</div>' +
          '<div><label>Version</label>' + cellVer(r) + '</div>' +
          '<div><label>Delegation</label>' + (r.delegStatus === 'approved' || r.delegStatus === 'delegated' ? '<span class="fleet-good">Approved</span>' : r.delegStatus === 'none' ? '<span class="fleet-dim">—</span>' : '<span class="' + (r.delegStatus === 'rejected' ? 'fleet-bad' : 'fleet-warnc') + '">' + esc(r.delegText) + '</span>') + '</div>' +
          '<div><label>Self-stake</label>' + (r.self == null ? '—' : num(r.self)) + '</div>' +
          '<div><label>Last epoch</label>' + (r.lastEpoch ? num(r.lastEpoch.xnt, 2) : '…') + '</div>' +
          '</div></div>').join('');
        const empty = '<div class="fleet-empty">Nothing in this group.</div>';
        const cfg = window.delegationConfig || {};
        return '<div class="fleet-board ' + (stateCls || '') + '" id="fleetBoard"' + (_open ? '' : ' hidden') + '>' +
          '<div class="fleet-tbl-wrap"><table class="fleet-tbl">' +
          '<colgroup><col class="c-name"><col class="c-issues"><col class="c-score"><col class="c-skip"><col class="c-ver"><col class="c-deleg"><col class="c-self"><col class="c-earn"></colgroup>' +
          '<thead><tr><th>Validator</th><th>Issues</th><th class="r">Score</th><th class="r">Skip · epoch</th><th>Version</th><th>Delegation Program</th><th class="r">Self-stake XNT</th><th class="r">Last epoch</th></tr></thead>' +
          '<tbody>' + (trs || '<tr><td colspan="8">' + empty + '</td></tr>') + '</tbody></table></div>' +
          '<div class="fleet-cards">' + (cards || empty) + '</div>' +
          '<div class="fleet-foot"><span>Click a row → Validator Lookup</span>' +
          '<span>Checks: delinquency · leader-slot skips vs cluster · version vs Foundation minimum' + (cfg.minValidatorVersion ? ' <code>' + esc(cfg.minValidatorVersion) + '</code>' : '') +
          ' · Delegation Program criteria · self-stake vs <code>' + num(cfg.minSelfStake ? Number(cfg.minSelfStake) / 1e9 : DEFAULT_MIN_SELF) + '</code> XNT</span>' +
          '<span>Same rules as the 🔔 Telegram alerts</span></div>' +
          '</div>';
      }

      function render() {
        const host = document.getElementById('fleetHealth');
        if (!host) return;
        if (!_validators.length) { host.innerHTML = ''; return; }
        const rows = sortRows(_validators.map(evaluate));
        if (_filter !== 'all' && !rows.some(r => r.sev === _filter)) _filter = 'all';
        const stateCls = rows.some(r => r.sev === 'crit') ? 'has-crit' : rows.some(r => r.sev === 'warn') ? 'has-warn' : '';
        host.innerHTML = renderBar(rows) + renderTable(rows, stateCls);
      }

      // ── Hooks: re-render when the async sources arrive ───────────
      function hookSources() {
        if (_hooked) return; _hooked = true;
        if (typeof window.delegLoad === 'function') { try { window.delegLoad().then(render, () => {}); } catch (e) {} }
        if (window.RewardsLedger && typeof window.RewardsLedger.load === 'function') { try { Promise.resolve(window.RewardsLedger.load()).then(render, () => {}); } catch (e) {} }
      }

      // Called by loadPortfolio() with the validators it just rendered cards for.
      window.fleetRender = function (validators) {
        _validators = Array.isArray(validators) ? validators : [];
        render();
        hookSources();
      };
      // Called when the per-card rewards stream in (cards.js) so the
      // "Earned · epoch" column fills without waiting for a full reload.
      window.fleetRefresh = function () { if (_validators.length) render(); };

      Actions.register({
        'fleet-toggle': () => { _open = !_open; writeOpen(_open); render(); },
        'fleet-filter': (el, e, d) => { _filter = (_filter === d.filter) ? 'all' : d.filter; if (!_open) { _open = true; writeOpen(true); } render(); },
        'fleet-row':    (el, e, d) => { if (d.vote && typeof lookupValidator === 'function') lookupValidator(d.vote); },
      });
      // Keyboard: Enter / Space on a focused row opens it
      document.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.matches && e.target.matches('[data-action="fleet-row"]')) {
          e.preventDefault(); const v = e.target.dataset.vote; if (v && typeof lookupValidator === 'function') lookupValidator(v);
        }
      });
    })();
