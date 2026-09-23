    // ═══════════════════════════════════════════════════════
    // VALIDATOR FORENSICS — module (all names vp-prefixed)
    // ═══════════════════════════════════════════════════════
    (function () {
      const VP_RPC = (typeof RPC_URL !== 'undefined') ? RPC_URL : 'https://rpc.mainnet.x1.xyz';
      const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // sanitize on-chain pubkeys before DOM injection

      const S = {
        rows: [],
        maxCreditsPerSlot: 1,
        tvc: false,
        slotsPerEpoch: 0,
        currentEpoch: 0,
        epochsAnalyzed: 0,
        sortKey: 'risk',
        sortDir: -1,
        lagTimer: null,
        lagSamples: 0,
        prevBodyOverflow: '',
        hideDelinq: true,
        minStake: 3000,
        deepDone: false,
        benchDone: false,
        scanning: false,
      };
      let vpHist = null;
      const vpImgCache = new Map();   // iconUrl -> Image, shared across chart renders

      // The active comparison field: hidden delinquents are excluded from
      // percentiles AND risk pools, not just the display — otherwise dead
      // validators absorb the bottom percentiles and compress everyone
      // else's scores toward the middle.
      function activeRows() {
        return S.rows.filter(r =>
          (!S.hideDelinq || !r.delinquent) &&
          (S.minStake <= 0 || !S.selfStakeOk || r.selfStake >= S.minStake));
      }

      function recomputeAndRender() {
        // wipe stale stats so excluded rows don't show old percentiles/risk
        for (const r of S.rows) { r.pctile = null; r.risk = null; }
        const act = activeRows();
        const withData = act.filter(r => r.epochsCounted > 0).sort((a, b) => a.meanEff - b.meanEff);
        withData.forEach((r, i) => { r.pctile = Math.round(100 * i / Math.max(1, withData.length - 1)); });
        computeRisk();
        renderVerdict(withData);
        renderStats(withData);
        renderCharts();
        renderTable();
      }

      function toggleDelinq() {
        S.hideDelinq = document.getElementById('vpHideDelinq').checked;
        if (S.rows.length) recomputeAndRender();
      }

      function minStakeChange() {
        S.minStake = parseInt(document.getElementById('vpMinStake').value, 10) || 0;
        if (S.rows.length) recomputeAndRender();
      }

      // Reuse the site's hardened escapers (Issue #3); minimal fallbacks if
      // this module ever runs standalone.
      const esc   = (typeof escHtml   === 'function') ? escHtml   : s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const safeU = (typeof safeUrl   === 'function') ? safeUrl   : u => (/^https?:\/\//i.test(String(u||'')) ? String(u) : '');

      function setProgress(pct, label) {
        const p = document.getElementById('vpProgress');
        if (pct === null) { p.classList.add('vp-hidden'); return; }
        p.classList.remove('vp-hidden');
        document.getElementById('vpProgFill').style.width = Math.round(pct) + '%';
        if (label) document.getElementById('vpProgLabel').textContent = label;
      }

      // Hide result panels while a full scan is in flight, so nothing
      // renders until every stage is done (no flickering score changes).
      function setResultsVisible(v) {
        for (const id of ['vpVerdict','vpStatsPanel','vpChartsRow','vpTablePanel']) {
          const el = document.getElementById(id);
          if (!el) continue;
          if (v) el.classList.remove('vp-hidden');
          else el.classList.add('vp-hidden');
        }
        if (v) document.getElementById('vpVerdict').style.display = '';
      }

      function setStatus(msg, isErr) {
        const el = document.getElementById('vpStatus');
        el.textContent = msg;
        el.className = isErr ? 'vp-err' : '';
      }

      // Self stake — same source and definition as the Validator Terminal:
      // api.x1.xyz /v1/stakes (includeInactive), summed per votePubkey where
      // stakePool == null (validator self-stake + 3rd-party direct stakers).
      async function fetchSelfStakes() {
        const API = 'https://api.x1.xyz', PAGE = 10000, MAX_OFFSET = 5000;
        const sums = new Map();   // votePubkey -> BigInt lamports
        for (let offset = 0; ; offset += PAGE) {
          const u = new URL(API + '/v1/stakes');
          u.searchParams.set('includeInactive', 'true');
          u.searchParams.set('limit', String(PAGE));
          u.searchParams.set('offset', String(offset));
          const r = await fetch(u);
          if (!r.ok) throw new Error('/v1/stakes HTTP ' + r.status);
          const page = await r.json();
          for (const s of page) {
            if (!s || !s.votePubkey || s.stakePool) continue;   // foundation excluded
            sums.set(s.votePubkey, (sums.get(s.votePubkey) || 0n) + BigInt(s.amount || 0));
          }
          if (page.length < PAGE || offset >= MAX_OFFSET) break;
        }
        const out = new Map();
        for (const [k, v] of sums) out.set(k, Number(v) / 1e9);
        return out;
      }

      async function rpc(method, params) {
        const res = await fetch(VP_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] })
        });
        if (!res.ok) throw new Error(method + ' HTTP ' + res.status);
        const j = await res.json();
        if (j.error) throw new Error(method + ': ' + (j.error.message || JSON.stringify(j.error)));
        return j.result;
      }

      // ── open / close ────────────────────────────────────
      function onKey(e) {
        if (e.key === 'Escape') {
          e.stopPropagation();
          closeProbe();
        }
      }
      function openProbe() {
        S.prevBodyOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        document.getElementById('vpOverlay').classList.add('open');
        document.addEventListener('keydown', onKey, true);
        setStatus('Idle. RPC: ' + VP_RPC.replace('https://', ''));
      }
      function closeProbe() {
        document.getElementById('vpOverlay').classList.remove('open');
        document.body.style.overflow = S.prevBodyOverflow;
        document.removeEventListener('keydown', onKey, true);
        if (S.lagTimer) { clearInterval(S.lagTimer); S.lagTimer = null;
          const b = document.getElementById('vpLagBtn');
          b.textContent = 'Resume lag sampling'; b.className = 'vp-btn vp-secondary';
        }
      }

      // ── core analysis ───────────────────────────────────
      async function runProbe() {
        const btn = document.getElementById('vpRunBtn');
        btn.disabled = true;
        try {
          const wantEpochs = parseInt(document.getElementById('vpEpochSel').value, 10);
          S.scanning = true;
          setResultsVisible(false);
          setProgress(4, 'Fetching network state…');
          setStatus('Fetching epoch info…');
          const [epochInfo, sched, clusterNodes] = await Promise.all([
            rpc('getEpochInfo'),
            rpc('getEpochSchedule'),
            rpc('getClusterNodes').catch(e => { console.warn('[vote probe] getClusterNodes failed:', e.message); return []; })
          ]);
          S.currentEpoch = epochInfo.epoch;
          S.slotsPerEpoch = sched.slotsPerEpoch;

          setStatus('Fetching vote accounts…');
          const va = await rpc('getVoteAccounts', [{ commitment: 'confirmed' }]);
          const all = [
            ...va.current.map(v => ({ ...v, delinquent: false })),
            ...va.delinquent.map(v => ({ ...v, delinquent: true }))
          ].filter(v => B58.test(v.votePubkey || '') && B58.test(v.nodePubkey || ''));

          // getVoteAccounts truncates epochCredits to the last ~5 entries, so
          // anything beyond "last 4" needs the full 64-epoch history from the
          // vote account state itself. Batched getAccountInfo (jsonParsed),
          // 100 per request — same technique as the site's batch fetcher.
          try {
            const BATCH = 100;
            const extended = {};
            const lastTs = {};   // votePubkey -> {slot, ts} from vote state (free clock-drift signal)
            const nBatches = Math.ceil(all.length / BATCH);
            for (let i = 0; i < all.length; i += BATCH) {
              setStatus('Fetching full credit history… batch ' + (Math.floor(i / BATCH) + 1) + '/' + nBatches);
              const chunk = all.slice(i, i + BATCH);
              const body = chunk.map((v, idx) => ({
                jsonrpc: '2.0', id: idx, method: 'getAccountInfo',
                params: [v.votePubkey, { encoding: 'jsonParsed' }]
              }));
              const res = await fetch(VP_RPC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
              });
              if (!res.ok) throw new Error('getAccountInfo batch HTTP ' + res.status);
              const batch = await res.json();
              if (Array.isArray(batch)) {
                batch.forEach((r2, idx) => {
                  const info = r2?.result?.value?.data?.parsed?.info;
                  const ec = info?.epochCredits;
                  if (ec && Array.isArray(ec) && ec.length) {
                    // Handle both shapes: [{epoch,credits,previousCredits}] or [[e,c,p]]
                    extended[chunk[idx].votePubkey] = ec.map(e =>
                      Array.isArray(e) ? [Number(e[0]), Number(e[1]), Number(e[2])]
                                       : [Number(e.epoch), Number(e.credits), Number(e.previousCredits)]
                    );
                  }
                  const lt = info?.lastTimestamp;
                  if (lt && lt.slot && lt.timestamp) {
                    lastTs[chunk[idx].votePubkey] = { slot: Number(lt.slot), ts: Number(lt.timestamp) };
                  }
                });
              }
            }
            let upgraded = 0;
            for (const v of all) {
              const ext = extended[v.votePubkey];
              if (ext && ext.length > (v.epochCredits || []).length) { v.epochCredits = ext; upgraded++; }
              v._lastTs = lastTs[v.votePubkey] || null;
            }
            console.log('[vote probe] extended credit history for ' + upgraded + '/' + all.length + ' validators');
          } catch (e) {
            console.warn('[vote probe] extended credits fetch failed, using truncated getVoteAccounts history:', e.message);
          }

          setStatus('Analyzing ' + all.length + ' vote accounts…');

          // Pass 1: auto-detect TVC via max credits/slot across the field.
          let maxCps = 0;
          for (const v of all) {
            for (const [ep, cred, prev] of (v.epochCredits || [])) {
              if (ep >= S.currentEpoch) continue; // partial epoch
              const earned = cred - prev;
              if (earned > 0) maxCps = Math.max(maxCps, earned / S.slotsPerEpoch);
            }
          }
          S.tvc = maxCps > 1.5;
          S.maxCreditsPerSlot = S.tvc ? 16 : 1;

          // Pass 2: per-validator efficiency over last N completed epochs.
          const minEpoch = S.currentEpoch - wantEpochs;
          const rows = [];
          for (const v of all) {
            const effs = [];
            for (const [ep, cred, prev] of (v.epochCredits || [])) {
              if (ep >= S.currentEpoch || ep < minEpoch) continue;
              const eff = Math.min(1, (cred - prev) / (S.slotsPerEpoch * S.maxCreditsPerSlot));
              effs.push({ epoch: ep, eff });
            }
            effs.sort((a, b) => a.epoch - b.epoch);
            // Birth epoch — earliest epoch anywhere in the (full 64-epoch)
            // credit history. Fleets spun up together share it exactly.
            let firstEpoch = null;
            for (const e of (v.epochCredits || [])) {
              const ep = Number(Array.isArray(e) ? e[0] : e.epoch);
              if (isFinite(ep) && (firstEpoch === null || ep < firstEpoch)) firstEpoch = ep;
            }
            // Trajectory signature: the last 6 completed epochs' efficiency,
            // each at 4-decimal resolution. Two independent machines never
            // share a multi-epoch DAMAGE pattern to 4dp — but validators on
            // one box (or hit by one incident) do, exactly. Only signatures
            // OUTSIDE the saturated healthy band count (the ≥0.997-everywhere
            // crowd collides by the hundreds and proves nothing).
            // Raw per-epoch trajectory. Distinctiveness is decided LATER,
            // against the field's own median trajectory — an absolute
            // threshold here was the v4 bug: nearly every validator dips to
            // ~0.9949 in some epoch, so the whole healthy field qualified,
            // collided into giant "twin" groups, and inherited coloc-grade
            // evidence it had not earned.
            const trajVals = [];
            for (const e of (v.epochCredits || [])) {
              const ep = Number(Array.isArray(e) ? e[0] : e.epoch);
              if (ep < S.currentEpoch - 6 || ep >= S.currentEpoch) continue;
              const cred = Number(Array.isArray(e) ? e[1] : e.credits);
              const prev = Number(Array.isArray(e) ? e[2] : e.previousCredits);
              trajVals.push({ ep, eff: Math.min(1, (cred - prev) / (S.slotsPerEpoch * S.maxCreditsPerSlot)) });
            }
            trajVals.sort((a, b) => a.ep - b.ep);
            const n = effs.length;
            let mean = 0, sd = 0, worst = null;
            if (n > 0) {
              mean = effs.reduce((s, e) => s + e.eff, 0) / n;
              sd = n > 1 ? Math.sqrt(effs.reduce((s, e) => s + (e.eff - mean) ** 2, 0) / (n - 1)) : 0;
              worst = effs.reduce((m, e) => e.eff < m.eff ? e : m, effs[0]);
            }
            rows.push({
              votePubkey: v.votePubkey,
              nodePubkey: v.nodePubkey,
              stake: v.activatedStake / 1e9,
              commission: Number(v.commission) || 0,
              delinquent: v.delinquent,
              epochsCounted: n,
              meanEff: mean,
              sdEff: sd,
              worstEff: worst ? worst.eff : 0,
              worstEpoch: worst ? worst.epoch : null,
              sparks: effs.map(e => e.eff),
              lastTs: v._lastTs || null,
              clockDrift: null,
              lagN: 0, lagMean: 0, lagM2: 0, lagMax: 0,
              rootLagLast: null,
              stalls: 0, liveBase: null, liveEff: null,
              vlatN: 0, vlatSum: 0, vlatMax: 0, vlatTail: 0, vgapMax: 0, _lastVoteBlock: null,
              vposN: 0, vposMean: 0, vposM2: 0,
              bN: 0, bTail: 0, bGapMax: 0, _bLast: null,
              ledSlots: 0, ledMissed: 0, w1Led: 0, w1Missed: 0,
              version: null,
              selfStake: null,
              firstEpoch: firstEpoch,
              trajVals: trajVals, trajSig: null, twinN: 0, fleetMortality: null, subnet16Shared: null,
              benchWin: 0, benchDN: 0, benchDSum: 0, benchTxN: 0, benchTxSum: 0,
              benchPace: null, benchFill: null, hwScore: null,
              nameGroup: 1, cohortCount: 1, stakeCohort: 1, styleGroup: 1, fleetN: 0,
            });
          }

          // Percentiles + risk are computed in recomputeAndRender() so the
          // "hide delinquent" toggle can rebuild the comparison field live.

          // Names + icons — reuse the site's identity cache, or fetch it once.
          let ids = window.validatorIdentities || null;
          if (!ids || Object.keys(ids).length === 0) {
            try {
              setStatus('Fetching validator identities…');
              ids = await fetchValidatorIdentities();
              window.validatorIdentities = ids;
            } catch (e) { ids = {}; }
          }
          for (const r of rows) {
            const id = ids[r.nodePubkey];
            r.name = (id && id.name) ? String(id.name) : '';
            r.iconUrl = id ? safeU(id.iconUrl || '') : '';
          }

          // Self stake for the column + Min-self-stake filter.
          S.selfStakeOk = false;
          try {
            setStatus('Fetching stake breakdown (self vs foundation)…');
            const selfMap = await fetchSelfStakes();
            for (const r of rows) r.selfStake = selfMap.get(r.votePubkey) ?? 0;
            S.selfStakeOk = true;
          } catch (e) {
            console.warn('[vote probe] self-stake fetch failed, min-self-stake filter disabled:', e.message);
            for (const r of rows) r.selfStake = null;
          }

          // IP sharing — map node identity → gossip IP, then count how many
          // probe validators sit on the exact same IP (same box/NAT: the
          // hardest co-location signal) and in the same /24 subnet (adjacent
          // cheap instances at one host: the softer one).
          const ipOf = addr => {
            if (!addr || typeof addr !== 'string') return null;
            if (addr.startsWith('[')) {                 // [ipv6]:port
              const end = addr.indexOf(']');
              return end > 1 ? addr.slice(1, end) : null;
            }
            const cut = addr.lastIndexOf(':');
            const ip = cut > 0 ? addr.slice(0, cut) : addr;
            return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : (ip || null);
          };
          const nodeIp = new Map(), nodeVer = new Map();
          for (const n of (clusterNodes || [])) {
            if (n && n.pubkey && B58.test(n.pubkey)) {
              const ip = ipOf(n.gossip || n.tpu || null);
              if (ip) nodeIp.set(n.pubkey, ip);
              if (n.version) nodeVer.set(n.pubkey, String(n.version));
            }
          }
          const ipCount = new Map(), subnetCount = new Map(), subnet16Count = new Map();
          for (const r of rows) {
            r.ip = nodeIp.get(r.nodePubkey) || null;
            r.version = nodeVer.get(r.nodePubkey) || null;
            r.subnet = (r.ip && r.ip.includes('.')) ? r.ip.split('.').slice(0, 3).join('.') + '.x' : null;
            r.subnet16 = (r.ip && r.ip.includes('.')) ? r.ip.split('.').slice(0, 2).join('.') + '.x' : null;
            if (r.ip) ipCount.set(r.ip, (ipCount.get(r.ip) || 0) + 1);
            if (r.subnet) subnetCount.set(r.subnet, (subnetCount.get(r.subnet) || 0) + 1);
            if (r.subnet16) subnet16Count.set(r.subnet16, (subnet16Count.get(r.subnet16) || 0) + 1);
          }
          for (const r of rows) {
            r.ipShared = r.ip ? ipCount.get(r.ip) : null;
            r.subnetShared = r.subnet ? subnetCount.get(r.subnet) : null;
            r.subnet16Shared = r.subnet16 ? subnet16Count.get(r.subnet16) : null;
          }

          // ── Trajectory distinctiveness, measured against the FIELD ──
          // On a quiet chain every healthy validator tracks the same
          // per-epoch efficiency curve, so a shared curve proves nothing.
          // Only a shared DEPARTURE from that curve is evidence: identical
          // damage, epoch after epoch, at 4-decimal precision. That is what
          // independent machines cannot fake.
          (function assignTrajSignatures() {
            const perEpoch = new Map();   // epoch -> [eff…]
            for (const r of rows) {
              for (const t of (r.trajVals || [])) {
                if (!(t.eff > 0.5)) continue;   // skip dead/absent epochs
                if (!perEpoch.has(t.ep)) perEpoch.set(t.ep, []);
                perEpoch.get(t.ep).push(t.eff);
              }
            }
            const med = new Map();
            for (const [ep, arr] of perEpoch) {
              if (arr.length < 10) continue;
              const a = arr.slice().sort((x, y) => x - y);
              med.set(ep, a[Math.floor(a.length / 2)]);
            }
            for (const r of rows) {
              const tv = r.trajVals || [];
              if (tv.length < 4) continue;
              let big = 0, maxDev = 0;
              for (const t of tv) {
                const m = med.get(t.ep);
                if (m === undefined) continue;
                const dev = m - t.eff;                 // how far BELOW the field
                if (dev >= 0.010) big++;
                if (dev > maxDev) maxDev = dev;
              }
              // Distinctive = repeated meaningful damage, or one severe epoch.
              if (big >= 2 || maxDev >= 0.025) {
                r.trajSig = tv.map(t => t.ep + ':' + t.eff.toFixed(4)).join('|');
              }
            }
          })();

          // Fleet evidence (soft): name template + birth cohort.
          // Name key strips digits/separators so "Shaka1..Shaka5" groups —
          // but "X1-KITANA" vs "X1-GIRLS" stay distinct (on this chain
          // everyone prefixes X1, so prefix-matching would false-positive).
          // Birth cohort = identical firstEpoch, only meaningful if it lies
          // inside the visible 64-epoch history window.
          const nameKeyOf = n => {
            const k = String(n || '').toLowerCase().replace(/[0-9]/g, '').replace(/[\s_\-\.]+/g, '');
            return k.length >= 4 ? k : null;
          };
          // Structural name-style signature: letter-case runs + separators.
          // "X1-GOKU" and "X1-KITANA" → same template (Ud-U); "X1-Mocha" →
          // Ud-Ul (different). Catches fleets using one naming SCHEME with
          // different words — the pattern raw name-matching can't see.
          const styleKeyOf = n => {
            const s = String(n || '').trim();
            if (s.length < 4) return null;
            const t = s
              .replace(/[A-Z]+/g, 'U').replace(/[a-z]+/g, 'l').replace(/[0-9]+/g, 'd')
              .replace(/[^Uld]+/g, m => m[0]);
            return (t.length >= 2 && t.length <= 12) ? t : null;
          };
          const nameCounts = new Map(), cohortCounts = new Map(), stakeCounts = new Map(), styleCounts = new Map();
          const stakeKeyOf = r => (r.selfStake !== null && r.selfStake > 0) ? Math.round(r.selfStake / 10) * 10 : null;
          const cohortFloor = S.currentEpoch - 60;
          for (const r of rows) {
            const nk = nameKeyOf(r.name);
            if (nk) nameCounts.set(nk, (nameCounts.get(nk) || 0) + 1);
            const sty = styleKeyOf(r.name);
            if (sty) styleCounts.set(sty, (styleCounts.get(sty) || 0) + 1);
            if (r.firstEpoch !== null && r.firstEpoch > cohortFloor) {
              cohortCounts.set(r.firstEpoch, (cohortCounts.get(r.firstEpoch) || 0) + 1);
            }
            const sk = stakeKeyOf(r);
            if (sk !== null) stakeCounts.set(sk, (stakeCounts.get(sk) || 0) + 1);
          }
          for (const r of rows) {
            const nk = nameKeyOf(r.name);
            r.nameGroup = nk ? (nameCounts.get(nk) || 1) : 1;
            r.cohortCount = (r.firstEpoch !== null && r.firstEpoch > cohortFloor)
              ? (cohortCounts.get(r.firstEpoch) || 1) : 1;
            const sk = stakeKeyOf(r);
            r.stakeCohort = sk !== null ? (stakeCounts.get(sk) || 1) : 1;   // CSV corroboration only
            // Evidence caps: a signal shared by half the chain is demographics,
            // not a fleet. Name group counts 3–12, birth cohort 3–15 (a batch,
            // not the delegation-program launch wave), subnet 3–10.
            const sty = styleKeyOf(r.name);
            r.styleGroup = sty ? (styleCounts.get(sty) || 1) : 1;
            const inBand = (n, lo, hi) => (n >= lo && n <= hi) ? n : 0;
            r.fleetN = Math.max(
              inBand(r.nameGroup, 3, 12),
              inBand(r.cohortCount, 3, 15),
              r.subnetShared !== null ? inBand(r.subnetShared, 3, 10) : 0,
              r.subnet16Shared !== null ? inBand(r.subnet16Shared, 4, 25) : 0,
              Math.min(inBand(r.styleGroup, 4, 30), 30)
            );
          }

          // Trajectory twins: validators sharing an identical multi-epoch
          // damage pattern (4dp, outside the saturated band) are on the same
          // machine or shared the same incident — coloc-grade evidence.
          const sigCounts = new Map();
          for (const r of rows) {
            if (r.trajSig) sigCounts.set(r.trajSig, (sigCounts.get(r.trajSig) || 0) + 1);
          }
          for (const r of rows) {
            let n = r.trajSig ? (sigCounts.get(r.trajSig) || 1) : 1;
            // A "twin group" larger than this is chain-wide behaviour
            // (a network-level incident), not co-location — discard it.
            if (n > 150) n = 1;
            r.twinN = n < 2 ? 0 : n;
          }

          // Fleet mortality: a fleet's death rate transfers to its living
          // members. The alive half of a 50%-delinquent fleet looks clean in
          // every snapshot metric — this is how the survivors inherit their
          // siblings' record. Groups: exact name key, WIDE style template
          // (no upper cap here), /16 subnet, and trajectory signature.
          const mortGroups = new Map();   // key -> {n, dead}
          const addMort = (key, dead) => {
            if (!key) return;
            let g = mortGroups.get(key);
            if (!g) { g = { n: 0, dead: 0 }; mortGroups.set(key, g); }
            g.n++; if (dead) g.dead++;
          };
          for (const r of rows) {
            addMort('nm:' + (nameKeyOf(r.name) || ''), r.delinquent);
            addMort('st:' + (styleKeyOf(r.name) || ''), r.delinquent);
            addMort('s16:' + (r.subnet16 || ''), r.delinquent);
            addMort('tw:' + (r.trajSig || ''), r.delinquent);
          }
          // Wilson 95% lower bound, not the raw rate: 2 deaths out of 8 is
          // noise (lower bound ~0.07, scores nothing) while 22 out of 41 is
          // a finding (lower bound ~0.39). This is what stops a small group
          // with one unlucky sibling from being treated like a dying fleet.
          const wilsonLow = (k, n) => {
            if (n < 8) return null;
            const z = 1.96, p = k / n, d = 1 + z * z / n;
            const c = (p + z * z / (2 * n)) / d;
            const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
            return Math.max(0, c - m);
          };
          for (const r of rows) {
            let worst = null, worstLabel = null;
            const keys = [
              ['name group', 'nm:' + (nameKeyOf(r.name) || '')],
              ['name style', 'st:' + (styleKeyOf(r.name) || '')],
              ['/16 subnet', 's16:' + (r.subnet16 || '')],
              ['trajectory group', 'tw:' + (r.trajSig || '')]
            ];
            for (const [label, k] of keys) {
              if (k.endsWith(':')) continue;
              const g = mortGroups.get(k);
              if (!g) continue;
              const lb = wilsonLow(g.dead, g.n);
              if (lb === null) continue;
              if (worst === null || lb > worst) { worst = lb; worstLabel = label + ' (' + g.dead + '/' + g.n + ' delinquent)'; }
            }
            r.fleetMortality = worst;
            r.fleetMortalityWhy = worstLabel;
          }

          // Clock drift — validators self-report a timestamp with each vote.
          // Fit ts = a + D·slot across the field (D ≈ real slot duration),
          // two-pass with outlier trim; each validator's residual is its
          // clock offset vs cluster consensus. Well-run boxes are NTP-tight
          // (< ~1–2s); neglected ones drift.
          (function fitClockDrift() {
            // v2: fit a reference line, then CENTER residuals on the field
            // median — the absolute offset of the line is arbitrary (it
            // produced a uniform ~-2900s artifact); only the BETWEEN-validator
            // differences are real drift. Validators whose lastTimestamp is
            // stale (>300 slots behind the freshest) get null — their clock
            // reading is old news, not a measurement.
            let pts = rows.filter(r => r.lastTs).map(r => ({ r, x: r.lastTs.slot, y: r.lastTs.ts }));
            if (pts.length < 5) return;
            const maxSlot = Math.max(...pts.map(p => p.x));
            const fresh = pts.filter(p => p.x >= maxSlot - 300);
            if (fresh.length < 5) return;
            const fit = ps => {
              const n = ps.length;
              const mx = ps.reduce((s, p) => s + p.x, 0) / n;
              const my = ps.reduce((s, p) => s + p.y, 0) / n;
              let num = 0, den = 0;
              for (const p of ps) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
              const D = den ? num / den : 0.4;   // ~slot duration fallback
              return { D, a: my - D * mx };
            };
            const f = fit(fresh);
            const resids = fresh.map(p => p.y - (f.a + f.D * p.x)).sort((a, b) => a - b);
            const medResid = resids[Math.floor(resids.length / 2)];
            for (const p of pts) {
              if (p.x < maxSlot - 300) { p.r.clockDrift = null; continue; }
              p.r.clockDrift = (p.y - (f.a + f.D * p.x)) - medResid;
            }
          })();

          S.rows = rows;
          S.epochsAnalyzed = wantEpochs;
          S.deepDone = false;

          computeRisk();   // compute silently; do NOT render yet
          setProgress(30, 'History analyzed — scanning vote transactions…');
          document.getElementById('vpCsvBtn').classList.remove('vp-hidden');
          document.getElementById('vpLagBtn').classList.remove('vp-hidden');
          document.getElementById('vpDeepBtn').classList.remove('vp-hidden');
          document.getElementById('vpBenchBtn').classList.remove('vp-hidden');
          // Chain the remaining stages, then reveal everything at once.
          await deepScan(true);          // silent
          setProgress(60, 'Benchmarking block production…');
          await leaderBench(true);       // silent
          setProgress(100, 'Complete');
          S.scanning = false;
          recomputeAndRender();          // single final render
          setResultsVisible(true);
          setProgress(null);
          setStatus('Done. ' + all.length + ' validators, epochs ' + minEpoch + '–' + (S.currentEpoch - 1) + '.');
        } catch (e) {
          console.error('[vote probe]', e);
          setStatus('Error: ' + e.message, true);
        } finally {
          btn.disabled = false;
          S.scanning = false;
          setProgress(null);
          setResultsVisible(true);   // reveal whatever completed
        }
      }

      // ── rendering ───────────────────────────────────────
      function pct(x, dp) { return (100 * x).toFixed(dp === undefined ? 2 : dp) + '%'; }

      function quantile(sortedAsc, q) {
        if (!sortedAsc.length) return 0;
        const pos = (sortedAsc.length - 1) * q;
        const lo = Math.floor(pos), hi = Math.ceil(pos);
        return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
      }

      // ── FARMER RISK v2 — absolute anchored scoring ─────
      // The old percentile model manufactured separation in a tightly
      // clustered field (identical boxes landed in different tiers; the
      // whole top-15 pinned near 95+). Each component now maps a RAW
      // measurement onto fixed anchors — identical hardware scores
      // identically, and a high score requires actually-bad numbers:
      //   coloc  25%  same-IP count          1->0, 2->70, 3->85, >=4->100
      //   eff    20%  deficit vs field p90   <=0.5pt->0, >=8pt->100
      //   sd     20%  epoch sigma            <=1.5%->0, >=12%->100
      //   worst  10%  worst-epoch sag vs p90 <=2pt->0, >=25pt->100
      //   lat    15%  mean vote latency      <=1.3 slots->0, >=4->100  (deep scan)
      //   clock   5%  |drift| seconds        <=2s->0, >=30s->100
      //   live   15%  worst of lag sigma / stalls / lag max            (live watch)
      // Weights renormalize over the components that have data.
      function anchored(v, good, bad) {
        if (v === null || v === undefined || !isFinite(v)) return null;
        return 100 * Math.max(0, Math.min(1, (v - good) / (bad - good)));
      }

      // Robust field stats: median + MAD (median absolute deviation).
      function medMad(vals) {
        const a = vals.filter(v => v !== null && v !== undefined && isFinite(v)).sort((x, y) => x - y);
        if (a.length < 5) return null;
        const med = a[Math.floor(a.length / 2)];
        const devs = a.map(v => Math.abs(v - med)).sort((x, y) => x - y);
        return { med, mad: devs[Math.floor(devs.length / 2)] };
      }

      // Hybrid outlier badness: how many noise-widths above the field's own
      // baseline is this value? MAD is FLOORED at the metric's measurement
      // resolution, so a genuinely uniform field yields z≈1 for everyone
      // (nothing scores) — the identical-hardware guarantee survives — while
      // true outliers vs the field's noise floor light up even when absolute
      // anchors were calibrated too generously for this chain's quiet range.
      // z ≤ 2 → 0 badness … z ≥ 8 → 100.
      function zb(v, stats, floor, zLo, zHi) {
        if (v === null || v === undefined || !isFinite(v) || !stats) return null;
        const scale = Math.max(stats.mad * 1.4826, floor);
        const z = (v - stats.med) / scale;
        return anchored(z, zLo === undefined ? 2 : zLo, zHi === undefined ? 8 : zHi);
      }

      function computeRisk() {
        const act = activeRows();
        const withData = act.filter(r => r.epochsCounted > 0);
        for (const r of S.rows) { r.risk = null; r.riskWhy = ''; }
        if (withData.length < 2) return;

        // Robust top anchor: the field's p90 efficiency — "what good looks
        // like on this chain right now", immune to single outliers.
        const effSorted = withData.map(r => r.meanEff).sort((a, b) => a - b);
        const refEff = quantile(effSorted, 0.90);
        const lagReady = S.lagSamples >= 30;

        // Robust field baselines for the hybrid (absolute + outlier) scoring.
        const stEffDef = medMad(withData.map(r => refEff - r.meanEff));
        const stSd     = medMad(withData.map(r => r.sdEff));
        const stTail   = medMad(withData.filter(r => r.vlatN >= 30).map(r => r.vlatTail / r.vlatN));
        const stPosSd  = medMad(withData.filter(r => r.vposN >= 30).map(r => Math.sqrt(r.vposM2 / (r.vposN - 1))));
        const stDens   = (S.deepDone && S.deepBlocks >= 50)
          ? medMad(withData.filter(r => r.vlatN >= 10).map(r => -(r.vlatN / S.deepBlocks))) : null;  // negated: lower density = worse
        const stGap    = medMad(withData.filter(r => r.vlatN >= 10).map(r => r.vgapMax));
        const stBTail  = medMad(withData.filter(r => r.bN >= 30).map(r => r.bTail / r.bN));
        const stPace   = medMad(withData.filter(r => r.benchPace !== null).map(r => r.benchPace));
        const stFill   = medMad(withData.filter(r => r.benchFill !== null).map(r => -r.benchFill));  // negated: thinner = worse

        for (const r of withData) {
          // Hardware components first — these also feed the fleet amplifier.
          const hw = [];
          const pushHw = (label, w, v) => { if (v !== null) hw.push({ label, w, v }); };
          pushHw('efficiency', 0.35, Math.max(
            anchored(refEff - r.meanEff, 0.005, 0.08) || 0,
            zb(refEff - r.meanEff, stEffDef, 0.0015, 3, 9) || 0));
          pushHw('instability \u03c3', 0.35, Math.max(
            anchored(r.sdEff, 0.015, 0.12) || 0,
            zb(r.sdEff, stSd, 0.0006) || 0));
          pushHw('worst epoch', 0.25, anchored(refEff - r.worstEff, 0.02, 0.25));
          pushHw('clock drift', 0.15, r.clockDrift === null ? null : anchored(Math.abs(r.clockDrift), 2, 30));
          if (S.deepDone && r.vlatN >= 10) {
            // Latency is integer slots, so the MEAN saturates at 1.00 on a
            // quiet chain. The TAIL — fraction of votes that miss the next
            // slot — is the shared-vCPU jitter fingerprint (noisy neighbors
            // cause micro-stalls that show up as occasional 2+ landings).
            const meanLat = r.vlatSum / r.vlatN;
            const tailRate = r.vlatTail / r.vlatN;
            pushHw('vote jitter tail', 0.40, Math.max(
              anchored(meanLat, 1.15, 3) || 0,
              anchored(tailRate, 0.01, 0.12) || 0,
              zb(tailRate, stTail, 0.004) || 0));
            // Cadence: a healthy box lands ~one vote tx per block; an
            // overcommitted one stalls then batches — fewer, burstier txs.
            if (S.deepBlocks >= 50) {
              const density = r.vlatN / S.deepBlocks;
              // Density is scored relative to the field only — X1 batches
              // votes (~1 tx per 4 slots), so an absolute anchor misreads it.
              pushHw('vote cadence', 0.30, Math.max(
                anchored(r.vgapMax, 8, 60) || 0,
                zb(-density, stDens, 0.02) || 0,
                zb(r.vgapMax, stGap, 2) || 0));
            }
            // Arrival-order jitter: σ of this validator's position among the
            // votes inside each block — sub-slot latency stability. Distance
            // shifts the MEAN position; only unstable hardware inflates σ.
            if (r.vposN >= 30) {
              const posSd = Math.sqrt(r.vposM2 / (r.vposN - 1));
              pushHw('arrival jitter', 0.35, Math.max(
                anchored(posSd, 0.13, 0.30) || 0,
                zb(posSd, stPosSd, 0.012) || 0));
            }
          }
          // Epoch-boundary stress: rollover work is the quiet chain's only
          // guaranteed load spike — late/bunched votes there = weak box.
          if ((S.boundaryBlocks || 0) >= 50 && r.bN >= 30) {
            const bTailRate = r.bTail / r.bN;
            pushHw('epoch-boundary stress', 0.40, Math.max(
              anchored(bTailRate, 0.02, 0.20) || 0,
              zb(bTailRate, stBTail, 0.008) || 0,
              anchored(r.bGapMax, 6, 60) || 0));
          }
          // Leader-window forensics (~4.5h of schedule vs produced blocks).
          if (r.ledSlots >= 16) {
            pushHw('skips', 0.30, anchored(r.ledMissed / r.ledSlots, 0.002, 0.05));
            if (r.w1Led >= 8) {
              const w1Rate = r.w1Missed / r.w1Led;
              const rest = r.ledSlots - r.w1Led;
              const otherRate = rest > 0 ? (r.ledMissed - r.w1Missed) / rest : 0;
              pushHw('slot-1 fumbles', 0.35, anchored(w1Rate - otherRate, 0.005, 0.10));
            }
          }
          if (lagReady && r.lagN > 1) {
            const lagSd = Math.sqrt(r.lagM2 / (r.lagN - 1));
            const live = Math.max(
              anchored(lagSd, 2, 20) || 0,
              r.stalls > 0 ? Math.min(100, 60 + 10 * r.stalls) : 0,
              anchored(r.lagMax, 16, 150) || 0
            );
            pushHw('live stalls/lag', 0.45, live);
          }
          // ── PRODUCTION / HARDWARE CLASS ─────────────────────────
          // Block production is the expensive, deadline-bound work — the
          // real hardware test. HW class is a reliability-first composite
          // that always populates once the leader-window pass has run
          // (every probe), and sharpens when pace/fill are measurable:
          //   production skip   — missed leader slots (weak boxes drop them)
          //   slot-1 fumble     — extra misses on the FIRST slot of a window
          //   pace              — sec/slot inside own windows (if measured)
          //   fill              — tx packed vs chain avg (if measured)
          const prodComps = [];
          if (r.ledSlots >= 8) {
            prodComps.push({ label: 'production skips', w: 0.35,
              v: anchored(r.ledMissed / r.ledSlots, 0.003, 0.06) || 0 });
            if (r.w1Led >= 6) {
              const w1 = r.w1Missed / r.w1Led;
              const rest = r.ledSlots - r.w1Led;
              const other = rest > 0 ? (r.ledMissed - r.w1Missed) / rest : 0;
              prodComps.push({ label: 'slot-1 fumbles', w: 0.25,
                v: anchored(w1 - other, 0.01, 0.12) || 0 });
            }
          }
          if (S.benchDone && r.benchPace !== null && stPace) {
            prodComps.push({ label: 'block pace', w: 0.30, v: Math.max(
              anchored(r.benchPace - stPace.med, 0.05, 0.45) || 0,
              zb(r.benchPace, stPace, 0.03) || 0) });
          }
          if (S.benchDone && r.benchFill !== null && stFill) {
            prodComps.push({ label: 'thin blocks', w: 0.20, v: Math.max(
              anchored(1 - r.benchFill, 0.06, 0.45) || 0,
              zb(-r.benchFill, stFill, 0.03) || 0) });
          }
          if (prodComps.length) {
            const pw = prodComps.reduce((s, c) => s + c.w, 0);
            r.hwScore = Math.round(prodComps.reduce((s, c) => s + c.w * c.v, 0) / pw);
            r.hwWhy = prodComps.filter(c => c.v >= 25).sort((a,b)=>b.v-a.v).map(c=>c.label).join(', ') || 'clean production';
            // Production dominates farmer risk — hardware class is the point.
            pushHw('weak production (' + (r.hwWhy) + ')', 0.85, r.hwScore);
          }

          const hwW = hw.reduce((s, c) => s + c.w, 0);
          const hwScore = hwW ? hw.reduce((s, c) => s + c.w * c.v, 0) / hwW : 0;

          const comps = hw.slice();
          const push = (label, w, v) => { if (v !== null) comps.push({ label, w, v }); };

          // Co-location: exact same IP OR identical multi-epoch damage
          // trajectory — both mean "same machine" and score standalone-strong.
          const ipVal = r.ipShared === null ? null : (r.ipShared <= 1 ? 0 : r.ipShared === 2 ? 70 : r.ipShared === 3 ? 85 : 100);
          const twinVal = r.twinN >= 2 ? (r.twinN === 2 ? 70 : r.twinN <= 5 ? 85 : 95) : 0;
          const colocVal = (ipVal === null && !twinVal) ? null : Math.max(ipVal || 0, twinVal);
          const colocLabel = (twinVal > (ipVal || 0))
            ? 'identical trajectory \u2261' + r.twinN
            : (r.ipShared > 1 ? 'shared IP ' + r.ipShared + '\u00d7' : 'co-location');
          push(colocLabel, 0.80, colocVal);

          // Fleet mortality: their siblings' death rate, standalone — this
          // is exactly what current-snapshot metrics can never show.
          if (r.fleetMortality !== null) {
            push('fleet mortality ' + Math.round(100 * r.fleetMortality) + '%', 0.65,
              anchored(r.fleetMortality, 0.12, 0.5));
          }

          // Soft fleet evidence (name group / birth cohort / subnet):
          // same operator ≠ farmer — plenty of people run several GOOD
          // validators. So this only amplifies existing hardware badness:
          // fleetComp = fleetEvidence × (hwScore/100). A clean fleet
          // contributes ~0; a weak fleet gets pushed hard.
          const band = (n, lo, hi) => (n >= lo && n <= hi);
          const subScore = (r.subnetShared !== null && band(r.subnetShared, 3, 10)) ? Math.min(85, 10 * r.subnetShared + 10) : 0;
          const nameScore = band(r.nameGroup, 3, 12) ? Math.min(90, 15 * Math.min(r.nameGroup, 6)) : 0;
          const cohortScore = band(r.cohortCount, 3, 15) ? Math.min(65, 10 * r.cohortCount + 5) : 0;
          // Name-STYLE template (e.g. "X1-" + ALL-CAPS word): broader than
          // exact name grouping, so it scores softer and caps lower.
          const styleScore = band(r.styleGroup, 4, 30) ? Math.min(70, 5 * Math.min(r.styleGroup, 12) + 10) : 0;
          // Identical self-stake deliberately EXCLUDED from scoring — too
          // common at the program minimum to be operator evidence (it
          // mass-grouped ~76 validators). Kept in the CSV as corroboration.
          const softFleet = Math.max(subScore, nameScore, cohortScore, styleScore);
          if (softFleet > 0) {
            push('fleet \u00d7 weak hw', 0.35, softFleet * hwScore / 100);
          }

          // ── EVIDENCE COMBINATION (noisy-OR, not averaging) ────────
          // Averaging was the core flaw: one screaming signal (e.g. 96
          // validators sharing an identical multi-epoch trajectory) got
          // divided by a dozen signals that read ~0 on an idle chain, and
          // came out a whisper. Independent evidence should COMPOUND:
          //   P = 1 - Π(1 - wᵢ · vᵢ/100)
          // where wᵢ is how much that signal alone can prove. Signals at 0
          // contribute exactly nothing (no dilution); two strong signals
          // reinforce. Deliberately conservative: no single signal reaches
          // certainty, so a lone flag lands "high", never "proven".
          if (!comps.length) continue;
          // Split evidence into HARDWARE-inference vs FLEET/identity.
          // If the benchmark measured this box as strong, the hardware
          // GUESSES (vote jitter, efficiency, σ, etc.) are wrong for it and
          // must not inflate risk — only fleet evidence should. This removes
          // the "STRONG hardware yet VERY HIGH farmer" contradiction.
          const HW_LABELS = ['efficiency','instability','worst epoch','clock drift','vote jitter','vote cadence','arrival jitter','epoch-boundary','skips','slot-1','live stalls'];
          const isHwGuess = c => HW_LABELS.some(t => c.label.indexOf(t) === 0 || c.label.indexOf(t) >= 0);
          const benchStrong = (r.hwScore !== null && r.hwScore < 30);   // STRONG/SOLID
          let surv = 1;
          for (const c of comps) {
            let w = c.w;
            // Down-weight vote-side hardware guesses when the benchmark
            // directly contradicts them (measured strong box).
            if (benchStrong && isHwGuess(c) && c.label.indexOf('weak production') !== 0) w *= 0.15;
            surv *= (1 - w * Math.max(0, Math.min(100, c.v)) / 100);
          }
          r.risk = Math.round(100 * (1 - surv));
          r.riskLowConf = r.epochsCounted < 3;

          const drivers = comps
            .filter(c => c.w * c.v / 100 >= 0.12)
            .sort((a, b) => b.w * b.v - a.w * a.v)
            .slice(0, 2)
            .map(c => c.label);
          r.riskWhy = drivers.length ? 'driven by: ' + drivers.join(', ') : 'no strong negative signals';
        }
      }

      function riskPill(r) {
        if (r.risk === null || r.risk === undefined) return '<span class="vp-muted">—</span>';
        const t = r.risk >= 80 ? ['VERY HIGH', 'vp-r5']
                : r.risk >= 60 ? ['HIGH', 'vp-r4']
                : r.risk >= 40 ? ['MODERATE', 'vp-r3']
                : r.risk >= 20 ? ['LOW', 'vp-r2']
                :                ['VERY LOW', 'vp-r1'];
        const conf = r.riskLowConf ? ' · thin data (&lt;3 epochs)' : '';
        return '<span class="vp-riskpill ' + t[1] + '" title="Farmer risk ' + r.risk + '/100 — ' + esc(r.riskWhy || '') + conf + '. Absolute anchored score: identical hardware scores identically.">'
          + r.risk + (r.riskLowConf ? '~' : '') + ' ' + t[0] + '</span>';
      }

      function renderVerdict(withData) {
        const el = document.getElementById('vpVerdict');
        const effs = withData.map(r => r.meanEff);
        const med = quantile(effs, 0.5), p10 = quantile(effs, 0.10), p90 = quantile(effs, 0.90);
        const spread = p90 - p10;
        el.style.display = 'block';
        if (S.tvc) {
          el.className = 'vp-tvc';
          document.getElementById('vpVerdictTitle').textContent = '✓ Timely Vote Credits are ACTIVE on X1 (up to 16 credits/slot)';
          document.getElementById('vpVerdictBody').innerHTML =
            'Vote latency is being priced into credits, so this metric is a usable hardware signal. ' +
            'Median efficiency <b>' + pct(med) + '</b>, p10 <b>' + pct(p10) + '</b>, p90 <b>' + pct(p90) + '</b> ' +
            '&mdash; a p90&ndash;p10 spread of <b>' + pct(spread) + '</b>. ' +
            (spread > 0.02
              ? 'The field separates: the bottom decile is measurably slower than the top. Sort the table by farmer risk and inspect the top cluster.'
              : 'The spread is narrow &mdash; the deep-scan latency, live watch, and cluster signals carry the separation.');
        } else {
          el.className = 'vp-pretvc';
          document.getElementById('vpVerdictTitle').textContent = '⚠ Timely Vote Credits NOT detected (max ≈ 1 credit/slot)';
          document.getElementById('vpVerdictBody').innerHTML =
            'Credits appear to pay a flat rate per voted slot, so vote <i>latency</i> is not priced in &mdash; only fully missed votes cost credits. ' +
            'Efficiency below is "share of slots successfully voted on," a weaker but still nonzero signal. ' +
            'Median <b>' + pct(med) + '</b>, p10 <b>' + pct(p10) + '</b>. ' +
            'The deep-scan latency, live watch, and cluster signals carry the separation.';
        }
      }

      function renderStats(withData) {
        const effs = withData.map(r => r.meanEff);
        const med = quantile(effs, 0.5);
        const below = withData.filter(r => r.meanEff < med - 0.02).length;
        const delinq = S.rows.filter(r => r.delinquent).length;
        const highRisk = S.rows.filter(r => r.risk !== null && r.risk >= 60).length;
        const onSharedIp = S.rows.filter(r => r.ipShared !== null && r.ipShared > 1).length;
        const cells = [
          ['Validators', S.rows.length, 'vp-plain'],
          ['Delinquent now', delinq, delinq ? '' : 'vp-plain'],
          ['Slots / epoch', S.slotsPerEpoch.toLocaleString(), 'vp-plain'],
          ['Max credits / slot', S.maxCreditsPerSlot, 'vp-plain'],
          ['Median efficiency', pct(med), ''],
          ['p10 efficiency', pct(quantile(effs, 0.10)), ''],
          ['p90 efficiency', pct(quantile(effs, 0.90)), ''],
          ['Farmer risk ≥ 60', highRisk, highRisk ? '' : 'vp-plain'],
          ['On shared IPs', onSharedIp, onSharedIp ? '' : 'vp-plain'],
        ];
        document.getElementById('vpStatGrid').innerHTML = cells.map(c =>
          '<div class="vp-stat"><div class="vp-k">' + c[0] + '</div><div class="vp-v ' + c[2] + '">' + c[1] + '</div></div>'
        ).join('');
        document.getElementById('vpStatsPanel').classList.remove('vp-hidden');
      }

      const vpGrid = 'rgba(30,48,80,0.6)';
      const vpTick = '#8a8f98';

      function tierColor(risk, alpha) {
        const a = alpha === undefined ? 0.85 : alpha;
        if (risk === null || risk === undefined) return 'rgba(138,143,152,0.45)';
        if (risk >= 80) return 'rgba(255,82,82,' + a + ')';
        if (risk >= 60) return 'rgba(255,171,0,' + a + ')';
        if (risk >= 40) return 'rgba(240,185,11,' + a + ')';
        if (risk >= 20) return 'rgba(77,166,255,' + (a - 0.15) + ')';
        return 'rgba(0,230,118,' + (a - 0.15) + ')';
      }

      function renderCharts() {
        const act = activeRows().filter(r => r.epochsCounted > 0);
        if (!act.length) return;
        document.getElementById('vpChartsRow').classList.remove('vp-hidden');

        // ── Chart 1: HARDWARE SIGNAL MAP ──────────────────
        // x = mean vote efficiency, y = epoch-to-epoch instability (σ).
        // Weak/oversubscribed boxes drift LEFT (losing credits) and UP
        // (erratic between epochs). Dashed median guides split the field
        // into quadrants; the top-left quadrant is the suspect corner.
        // Colors = farmer-risk tier, so the corner should glow red.
        const effsSorted = act.map(r => r.meanEff).sort((a, b) => a - b);
        const sdsSorted = act.map(r => r.sdEff).sort((a, b) => a - b);
        const medEff = quantile(effsSorted, 0.5) * 100;
        const medSd = quantile(sdsSorted, 0.5) * 100;
        const medianLines = {
          id: 'vpMedianLines',
          afterDatasetsDraw(chart) {
            const { ctx, chartArea, scales } = chart;
            if (!chartArea) return;
            ctx.save();
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = 'rgba(138,143,152,0.5)';
            ctx.lineWidth = 1;
            const x = scales.x.getPixelForValue(medEff);
            if (x >= chartArea.left && x <= chartArea.right) {
              ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
            }
            const y = scales.y.getPixelForValue(medSd);
            if (y >= chartArea.top && y <= chartArea.bottom) {
              ctx.beginPath(); ctx.moveTo(chartArea.left, y); ctx.lineTo(chartArea.right, y); ctx.stroke();
            }
            ctx.restore();
          }
        };

        if (vpHist) vpHist.destroy();
        vpHist = new Chart(document.getElementById('vpHistChart'), {
          type: 'scatter',
          data: { datasets: [{
            data: act.map(r => ({
              x: r.meanEff * 100,
              y: r.sdEff * 100,
              nm: r.name || (r.votePubkey.slice(0, 6) + '…'),
              risk: r.risk
            })),
            backgroundColor: act.map(r => tierColor(r.risk)),
            pointRadius: 4, pointHoverRadius: 6,
          }]},
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: c =>
                c.raw.nm + '  eff ' + c.raw.x.toFixed(2) + '%, σ ' + c.raw.y.toFixed(2) + '%'
                + (c.raw.risk === null ? '' : ', risk ' + c.raw.risk)
              } }
            },
            scales: {
              x: {
                min: Math.max(0, Math.floor(Math.min(...act.map(r => r.meanEff)) * 100) - 1),
                max: 100,
                grid: { color: vpGrid }, ticks: { color: vpTick, callback: v => v + '%', font: { family: "'JetBrains Mono'", size: 10 } }, title: { display: true, text: 'mean vote efficiency →  (weak boxes drift left)', color: vpTick } },
              y: {
                min: 0,
                max: Math.ceil(Math.max(0.02, ...act.map(r => r.sdEff)) * 100) + 2,
                grid: { color: vpGrid }, ticks: { color: vpTick, callback: v => v + '%', font: { family: "'JetBrains Mono'", size: 10 } }, title: { display: true, text: 'epoch σ  (instability ↑)', color: vpTick } }
            }
          },
          plugins: [medianLines]
        });

        // ── TOP SUSPECTS list ─────────────────────────────
        // The mission as a readable list: logo, name, why, risk pill.
        // Clicking a row filters the table to that validator.
        const suspects = act
          .filter(r => r.risk !== null)
          .sort((a, b) => b.risk - a.risk)
          .slice(0, 12);
        const listEl = document.getElementById('vpSuspectList');
        listEl.innerHTML = suspects.map((r, i) => {
          const letter = esc(((r.name || r.votePubkey).trim()[0] || '?').toUpperCase());
          const ava = r.iconUrl
            ? '<img class="vp-ava" src="' + esc(r.iconUrl) + '" alt="" loading="lazy" data-onerror="img-fallback">'
              + '<span class="vp-ava-fb" style="display:none;">' + letter + '</span>'
            : '<span class="vp-ava-fb">' + letter + '</span>';
          const nm = r.name ? esc(r.name) : (r.votePubkey.slice(0, 6) + '…' + r.votePubkey.slice(-4));
          return '<div class="vp-sus-row" data-action="vp-filter-to" data-vote="' + esc(r.votePubkey) + '" title="' + r.votePubkey + '&#10;' + esc(r.riskWhy || '') + '&#10;click to filter the table to this validator">'
            + '<span class="vp-sus-rank">' + (i + 1) + '</span>'
            + ava
            + '<span class="vp-sus-name">' + nm + '</span>'
            + '<span class="vp-sus-why">' + esc((r.riskWhy || '').replace('driven by: ', '')) + '</span>'
            + riskPill(r)
            + '</div>';
        }).join('') || '<div class="vp-muted" style="font-size:0.8rem;">No scored validators in the current filter.</div>';
      }

      // ── table ───────────────────────────────────────────
      const COLS = [
        { key: 'rank',        label: '#',            sortable: false, tip: 'Row number under the current sort' },
        { key: 'name',        label: 'Validator',    left: true, tip: 'On-chain published name and icon; unnamed validators are themselves a mild low-effort signal' },
        { key: 'votePubkey',  label: 'Vote acct',    left: true, tip: 'Vote account — hover for full address, ⧉ copies it' },
        { key: 'hwScore',     label: 'HW class', tip: 'Hardware class from the leader benchmark ONLY — measured while the validator was producing blocks under a deadline, inside its own 4-slot window so geography cancels out. This is the closest thing to a CPU test the chain allows: STRONG / SOLID / AVERAGE / WEAK / VERY WEAK' },
        { key: 'benchPace',   label: 'Pace',         bench: true, hideNull: true, tip: 'Seconds per slot across the validator\'s OWN consecutive leader slots. Block-building has a fixed cost floor (bank setup, PoH hashing, state commitment) that runs every slot regardless of load — slow boxes stretch their own window. Field median is the reference' },
        { key: 'benchFill',   label: 'Fill',         bench: true, tip: 'Transactions packed per block vs the chain average over the same period. A leader that cannot execute fast enough before the deadline ships thinner blocks. 1.00 = average, below 1 = thin' },
        { key: 'risk',        label: 'Farmer risk',  tip: 'Composite likelihood of underprovisioned hardware, 0–100, relative to the visible field' },
        { key: 'ipShared',    label: 'Cluster',      tip: 'Operator-fleet evidence. Red N× = N validators on this EXACT IP (one machine — strong standalone signal, sorts highest). Amber ~N = same operator inferred from name pattern, identical birth epoch, same /24 subnet, or identical self-stake — amber only raises risk when hardware signals are ALSO weak, so legit multi-validator operators with good boxes are unaffected. Red ≡N = N validators with an IDENTICAL multi-epoch efficiency trajectory (4-decimal match outside the healthy band — same machine or same incident, coloc-grade). Gray 1 = independent. Hover any cell for the specific evidence, including the fleet group&#39;s delinquency rate' },
        { key: 'stake',       label: 'Stake',        tip: 'Activated stake (XNT) — includes foundation delegation' },
        { key: 'selfStake',   label: 'Self',         tip: 'Direct (non-foundation) stake: validator self-stake + 3rd-party direct stakers — stakePool = null, same definition as the Validator Terminal' },
        { key: 'meanEff',     label: 'Mean eff',     tip: 'Average vote credits earned vs max possible across analyzed epochs' },
        { key: 'sdEff',       label: 'σ',            tip: 'Epoch-to-epoch instability — strong boxes are steady, weak boxes wobble' },
        { key: 'worstEff',    label: 'Worst ep',     tip: 'Their single worst epoch in the window — a validator&#39;s worst day' },
        { key: 'clockDrift',  label: 'Clock',        tip: 'Self-reported clock vs cluster consensus, seconds. NTP-tight boxes stay within ±2s' },
        { key: 'vlatTail',    label: 'Late %',       deep: true, tip: 'Fraction of votes that missed the next slot — shared-vCPU jitter fingerprint. Dedicated boxes run ~0%; noisy-neighbor VPSes leak 2–15%. Hover a value for mean latency + cadence details' },
        { key: 'vposSd',      label: 'Jitter',       deep: true, tip: 'Arrival-order jitter: σ of this validator\'s position among the votes inside each block — a SUB-SLOT latency stability measure that does not saturate on a quiet chain. Network distance shifts the mean position; only unstable (shared/oversubscribed) hardware inflates the σ' },
        { key: 'bTailPct',    label: 'Boundary',     deep: true, tip: 'Late-vote rate during the ~400 slots right after the last epoch boundary — the one guaranteed load event (rewards + stake processing hit every validator at once). Weak boxes leak late votes exactly here while cruising the rest of the epoch' },
        { key: 'skipPct',     label: 'Skip %',       deep: true, tip: 'Missed leader slots over the last ~4.5 hours (schedule vs produced blocks). Hover for the slot-1-of-window breakdown: slow boxes disproportionately fumble the FIRST slot of their 4-slot window even when overall skips round to zero' },
        { key: 'liveEff',     label: 'Live eff',     lag: true, tip: 'Efficiency over the live watch window — right now, not history' },
        { key: 'stalls',      label: 'Stalls',       lag: true, tip: 'Sampled moments ≥32 slots behind — micro-outages invisible to credits and delinquency' },
        { key: 'lagMean',     label: 'Lag μ',        lag: true, tip: 'Mean slots behind tip (network distance + hardware)' },
        { key: 'lagSd',       label: 'Lag σ',        lag: true, tip: 'Lag variance — the hardware tell; distance shifts the mean, not the variance' },
        { key: 'lagMax',      label: 'Lag max',      lag: true, tip: 'Worst sampled lag' },
        { key: 'rootLagLast', label: 'Root lag',     lag: true, tip: 'Slots between rooted slot and tip — replay/disk pressure' },
      ];

      function sortVal(r, key) {
        if (key === 'lagSd') return r.lagN > 1 ? Math.sqrt(r.lagM2 / (r.lagN - 1)) : -1;
        if (key === 'name') return r.name ? r.name.toLowerCase() : '\uffff' + r.votePubkey.toLowerCase();
        if (key === 'clockDrift') return r.clockDrift === null ? -Infinity : Math.abs(r.clockDrift);
        if (key === 'ipShared') return (r.ipShared !== null && r.ipShared > 1) ? 2000 + r.ipShared : (r.twinN >= 2 ? 1000 + r.twinN : (r.fleetN || 0));
        if (key === 'vlatTail') return r.vlatN >= 5 ? r.vlatTail / r.vlatN : -Infinity;
        if (key === 'vposSd') return r.vposN >= 30 ? Math.sqrt(r.vposM2 / (r.vposN - 1)) : -Infinity;
        if (key === 'skipPct') return r.ledSlots >= 16 ? r.ledMissed / r.ledSlots : -Infinity;
        if (key === 'bTailPct') return r.bN >= 30 ? r.bTail / r.bN : -Infinity;
        if (key === 'hwScore') return r.hwScore === null ? -Infinity : r.hwScore;
        if (key === 'benchPace') return r.benchPace === null ? -Infinity : r.benchPace;
        if (key === 'benchFill') return r.benchFill === null ? Infinity : r.benchFill;
        if (key === 'vlatMean') return r.vlatN > 0 ? r.vlatSum / r.vlatN : -Infinity;
        const v = r[key];
        return (v === null || v === undefined) ? -Infinity : v;
      }

      function setSort(key) {
        if (S.sortKey === key) S.sortDir *= -1;
        else { S.sortKey = key; S.sortDir = (key === 'votePubkey' || key === 'name') ? 1 : -1; }
        renderTable();
      }

      function effClass(e) { return e >= 0.9 ? 'vp-eff-good' : e >= 0.8 ? 'vp-eff-mid' : 'vp-eff-bad'; }

      function sparkSvg(vals) {
        if (!vals.length) return '<span class="vp-muted">—</span>';
        const w = 72, h = 18, n = vals.length;
        const lo = Math.min(...vals), hi = Math.max(...vals);
        const span = Math.max(0.005, hi - lo);
        const pts = vals.map((v, i) => {
          const x = n === 1 ? w / 2 : (i / (n - 1)) * (w - 2) + 1;
          const y = h - 2 - ((v - lo) / span) * (h - 4);
          return x.toFixed(1) + ',' + y.toFixed(1);
        }).join(' ');
        const color = vals[n - 1] >= vals[0] ? '#00e676' : '#ff5252';
        return '<svg class="vp-spark" width="' + w + '" height="' + h + '"><polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.5"/></svg>';
      }

      function copyPk(pk, el) {
        if (!B58.test(pk)) return;
        navigator.clipboard.writeText(pk).then(() => {
          const old = el.textContent;
          el.textContent = '✓';
          el.classList.add('vp-copied');
          setTimeout(() => { el.textContent = old; el.classList.remove('vp-copied'); }, 900);
        });
      }

      function renderTable() {
        const lagOn = S.lagSamples > 0;
        const cols = COLS.filter(c => (!c.lag || lagOn) && (!c.deep || S.deepDone) && (!c.bench || S.benchDone) && !(c.key === 'hwScore' && !S.deepDone));

        document.getElementById('vpTheadRow').innerHTML = cols.map(c => {
          const arrow = S.sortKey === c.key ? ' <span class="vp-arrow">' + (S.sortDir < 0 ? '▼' : '▲') + '</span>' : '';
          const click = c.sortable === false ? '' : ' data-action="vp-sort" data-key="' + esc(c.key) + '"';
          const tip = c.tip ? ' title="' + c.tip + '"' : '';
          return '<th class="' + (c.left ? 'vp-left' : '') + '"' + click + tip + '>' + c.label + arrow + '</th>';
        }).join('');

        const filter = document.getElementById('vpFilterBox').value.trim().toLowerCase();
        let rows = activeRows().slice();
        if (filter) rows = rows.filter(r =>
          r.votePubkey.toLowerCase().includes(filter) ||
          r.nodePubkey.toLowerCase().includes(filter) ||
          (r.name && r.name.toLowerCase().includes(filter)) ||
          (r.ip && r.ip.toLowerCase().includes(filter)));
        rows.sort((a, b) => {
          const av = sortVal(a, S.sortKey), bv = sortVal(b, S.sortKey);
          if (av < bv) return -S.sortDir;
          if (av > bv) return S.sortDir;
          return 0;
        });

        document.getElementById('vpTblCount').textContent = '(' + rows.length + ')';
        const frag = rows.map((r, i) => {
          // votePubkey / nodePubkey were validated against base58 at ingest.
          // name and iconUrl are validator-controlled on-chain data: name is
          // escaped, iconUrl passed through safeUrl (site convention, Issue #3).
          const lagSd = r.lagN > 1 ? Math.sqrt(r.lagM2 / (r.lagN - 1)) : null;
          const badges =
            (r.delinquent ? ' <span class="vp-badge vp-delinq">DELINQ</span>' : '') +
            (r.epochsCounted > 0 && r.epochsCounted < S.epochsAnalyzed
              ? ' <span class="vp-badge vp-new" title="Only ' + r.epochsCounted + ' of the ' + S.epochsAnalyzed + ' analyzed epochs have credit history for this validator (new or previously inactive) — stats rest on a thinner sample">' + r.epochsCounted + '/' + S.epochsAnalyzed + ' ep</span>'
              : '');
          const letter = esc(((r.name || r.votePubkey).trim()[0] || '?').toUpperCase());
          const ava = r.iconUrl
            ? '<img class="vp-ava" src="' + esc(r.iconUrl) + '" alt="" loading="lazy" data-onerror="img-fallback">'
              + '<span class="vp-ava-fb" style="display:none;">' + letter + '</span>'
            : '<span class="vp-ava-fb">' + letter + '</span>';
          const nameHtml = r.name
            ? '<span class="vp-name">' + esc(r.name) + '</span>'
            : '<span class="vp-name vp-unnamed">unnamed</span>';
          let cells = '<td class="vp-muted">' + (i + 1) + '</td>';
          cells += '<td class="vp-left">' + ava + nameHtml + '</td>';
          cells += '<td class="vp-left"><span class="vp-pk" title="' + r.votePubkey + '&#10;node: ' + r.nodePubkey + '">' + r.votePubkey.slice(0, 6) + '…' + r.votePubkey.slice(-4) + '</span>'
            + '<span class="vp-copy" data-action="vp-copy" data-vote="' + esc(r.votePubkey) + '" title="Copy vote account address">⧉</span>' + badges + '</td>';
          if (S.deepDone) {   // HW class header is shown only after deep scan — keep cells in lockstep
            if (r.hwScore === null) {
              cells += '<td class="vp-muted" title="No leader slots produced in the analysis window — validator has not led recently">—</td>';
            } else {
              const hc = r.hwScore >= 70 ? ['VERY WEAK', 'vp-r5'] : r.hwScore >= 50 ? ['WEAK', 'vp-r4']
                       : r.hwScore >= 30 ? ['AVERAGE', 'vp-r3'] : r.hwScore >= 15 ? ['SOLID', 'vp-r2'] : ['STRONG', 'vp-r1'];
              cells += '<td><span class="vp-riskpill ' + hc[1] + '" title="Hardware class from block PRODUCTION (the expensive, deadline-bound work), score ' + r.hwScore + '/100 (higher = weaker). Driven by: ' + esc(r.hwWhy || 'clean production') + '. Based on ' + r.ledSlots + ' scheduled leader slots' + (r.benchPace !== null ? ', pace ' + r.benchPace.toFixed(2) + 's/slot' : '') + '.">' + hc[0] + '</span></td>';
            }
          }
          if (S.benchDone) {
            cells += r.benchPace === null
              ? '<td class="vp-muted">—</td>'
              : '<td title="' + r.benchDN + ' slot-intervals inside this validator\u2019s own leader windows">' + r.benchPace.toFixed(2) + 's</td>';
            cells += r.benchFill === null
              ? '<td class="vp-muted">—</td>'
              : '<td class="' + (r.benchFill >= 0.95 ? 'vp-eff-good' : r.benchFill >= 0.8 ? 'vp-eff-mid' : 'vp-eff-bad') + '" title="Mean ' + (r.benchTxSum / Math.max(1, r.benchTxN)).toFixed(0) + ' tx/block vs chain average ' + (S.benchGlobalTx || 0).toFixed(0) + '">' + r.benchFill.toFixed(2) + '</td>';
          }
          cells += '<td>' + riskPill(r) + '</td>';
          // r.ip comes from getClusterNodes gossip and was shape-validated in
          // ipOf(); esc() it anyway before injection (site convention).
          if (r.ip === null) {
            cells += '<td class="vp-muted" title="Not found in gossip (getClusterNodes) — node may be offline">—</td>';
          } else {
            const fleetBits = [];
            if (r.subnetShared !== null && r.subnetShared >= 3) fleetBits.push(r.subnetShared + ' in /24 ' + esc(r.subnet));
            if (r.subnet16Shared !== null && r.subnet16Shared >= 4 && r.subnet16Shared <= 25) fleetBits.push(r.subnet16Shared + ' in /16 ' + esc(r.subnet16));
            if (r.nameGroup >= 3) fleetBits.push(r.nameGroup + ' matching name pattern');
            if (r.styleGroup >= 4 && r.styleGroup <= 30) fleetBits.push(r.styleGroup + ' matching name style');
            if (r.cohortCount >= 3) fleetBits.push(r.cohortCount + ' born in epoch ' + r.firstEpoch);
            if (r.fleetMortality !== null && r.fleetMortality >= 0.12 && r.fleetMortalityWhy) fleetBits.push('fleet mortality: ' + esc(r.fleetMortalityWhy));
            const fleetTip = fleetBits.length ? ' &middot; ' + fleetBits.join(', ') : '';
            if (r.ipShared > 1) {
              cells += '<td class="vp-eff-bad" title="' + esc(r.ip) + fleetTip + '"><b>' + r.ipShared + '×</b></td>';
            } else if (r.twinN >= 2) {
              cells += '<td class="vp-eff-bad" title="' + esc(r.ip || '') + ' — ' + r.twinN + ' validators share this EXACT multi-epoch efficiency trajectory (4-decimal match outside the healthy band): same machine or same incident' + fleetTip + '"><b>≡' + r.twinN + '</b></td>';
            } else if (r.fleetN >= 3) {
              cells += '<td class="vp-eff-mid" title="' + esc(r.ip) + ' — unique IP' + fleetTip + '">~' + r.fleetN + '</td>';
            } else {
              cells += '<td class="vp-muted" title="' + esc(r.ip) + ' — unique IP, no fleet pattern">1</td>';
            }
          }
          cells += '<td>' + Math.round(r.stake).toLocaleString() + '</td>';
          cells += r.selfStake === null
            ? '<td class="vp-muted" title="api.x1.xyz unavailable">—</td>'
            : '<td>' + Math.round(r.selfStake).toLocaleString() + '</td>';
          cells += r.epochsCounted === 0
            ? '<td class="vp-muted">no data</td><td class="vp-muted">—</td><td class="vp-muted">—</td>'
            : '<td class="' + effClass(r.meanEff) + '">' + pct(r.meanEff) + '</td>'
              + '<td>' + pct(r.sdEff) + '</td>'
              + '<td class="' + effClass(r.worstEff) + '" title="epoch ' + r.worstEpoch + ' — their worst day in the window">' + pct(r.worstEff) + '</td>';
          if (r.clockDrift === null) {
            cells += '<td class="vp-muted">—</td>';
          } else {
            const ad = Math.abs(r.clockDrift);
            const cls = ad <= 2 ? 'vp-muted' : ad <= 10 ? 'vp-eff-mid' : 'vp-eff-bad';
            cells += '<td class="' + cls + '" title="Self-reported vote timestamp vs cluster consensus. NTP-disciplined boxes stay within ~1–2s; large drift = neglected machine">'
              + (r.clockDrift > 0 ? '+' : '') + r.clockDrift.toFixed(1) + 's</td>';
          }
          if (S.deepDone) {
            if (r.vlatN >= 5) {
              const tail = r.vlatTail / r.vlatN;
              const tcls = tail <= 0.01 ? 'vp-eff-good' : tail <= 0.06 ? 'vp-eff-mid' : 'vp-eff-bad';
              const density = (S.deepBlocks >= 50) ? (r.vlatN / S.deepBlocks) : null;
              cells += '<td class="' + tcls + '" title="' + r.vlatTail + '/' + r.vlatN + ' votes missed the next slot. Mean latency ' + (r.vlatSum / r.vlatN).toFixed(2) + ' slots, worst ' + r.vlatMax + '.'
                + (density !== null ? ' Cadence: ' + (density * 100).toFixed(0) + '% of blocks carried a vote (healthy ≈ 90%+), longest silent gap ' + r.vgapMax + ' slots.' : '')
                + '">' + (tail * 100).toFixed(1) + '%</td>';
            } else {
              cells += '<td class="vp-muted" title="Fewer than 5 votes observed in the scan window">—</td>';
            }
            if (r.vposN >= 30) {
              const posSd = Math.sqrt(r.vposM2 / (r.vposN - 1));
              const jcls = posSd <= 0.15 ? 'vp-eff-good' : posSd <= 0.24 ? 'vp-eff-mid' : 'vp-eff-bad';
              cells += '<td class="' + jcls + '" title="Arrival-order σ ' + posSd.toFixed(3) + ' over ' + r.vposN + ' votes; mean position ' + (r.vposMean * 100).toFixed(0) + '% into the block\u2019s vote ordering. Stable boxes hold a consistent position; shared vCPUs bounce around it.">' + (posSd * 100).toFixed(0) + '%</td>';
            } else {
              cells += '<td class="vp-muted" title="Fewer than 30 position samples">—</td>';
            }
            if ((S.boundaryBlocks || 0) >= 50 && r.bN >= 30) {
              const bt = r.bTail / r.bN;
              const bcls = bt <= 0.02 ? 'vp-eff-good' : bt <= 0.08 ? 'vp-eff-mid' : 'vp-eff-bad';
              cells += '<td class="' + bcls + '" title="' + r.bTail + '/' + r.bN + ' votes late during the post-boundary window; longest silent gap there ' + r.bGapMax + ' slots. Compare with steady-state Late % — a big boundary premium means the box chokes the moment real work arrives.">' + (bt * 100).toFixed(1) + '%</td>';
            } else {
              cells += '<td class="vp-muted" title="Boundary blocks unavailable or fewer than 30 votes observed there">—</td>';
            }
            if (r.ledSlots >= 16) {
              const rate = r.ledMissed / r.ledSlots;
              const scls = rate <= 0.001 ? 'vp-eff-good' : rate <= 0.02 ? 'vp-eff-mid' : 'vp-eff-bad';
              const rest = r.ledSlots - r.w1Led;
              const otherMiss = r.ledMissed - r.w1Missed;
              cells += '<td class="' + scls + '" title="Missed ' + r.ledMissed + ' of ' + r.ledSlots + ' led slots over the analysis window. Slot-1 of window: ' + r.w1Missed + '/' + r.w1Led + ' missed vs ' + otherMiss + '/' + rest + ' for slots 2–4 — a slot-1 skew means the box is slow to build its first bank.">' + (rate * 100).toFixed(1) + '%</td>';
            } else {
              cells += '<td class="vp-muted" title="Led fewer than 16 slots in the analysis window">—</td>';
            }
          }
          if (lagOn) {
            const liveCell = r.liveEff === null
              ? '<td class="vp-muted" title="Needs ~1 min of sampling">…</td>'
              : '<td class="' + effClass(r.liveEff) + '" title="Credits earned ÷ max possible over the sampling window — right-now efficiency">' + pct(r.liveEff, 1) + '</td>';
            const stallCell = '<td class="' + (r.stalls > 0 ? 'vp-eff-bad' : 'vp-muted') + '" title="Samples where vote lag ≥ 32 slots — micro-outages that never register as delinquency">' + (r.lagN ? r.stalls : '—') + '</td>';
            cells += r.lagN === 0
              ? liveCell + stallCell + '<td class="vp-muted">—</td><td class="vp-muted">—</td><td class="vp-muted">—</td><td class="vp-muted">—</td>'
              : liveCell + stallCell
                + '<td>' + r.lagMean.toFixed(1) + '</td>'
                + '<td>' + (lagSd === null ? '—' : lagSd.toFixed(1)) + '</td>'
                + '<td>' + r.lagMax + '</td>'
                + '<td>' + (r.rootLagLast === null ? '—' : r.rootLagLast) + '</td>';
          }
          return '<tr>' + cells + '</tr>';
        }).join('');
        document.getElementById('vpTbody').innerHTML = frag;
        document.getElementById('vpTablePanel').classList.remove('vp-hidden');
      }

      // ── live lag sampler ────────────────────────────────
      async function lagTick() {
        try {
          const [epochInfo, va] = await Promise.all([
            rpc('getEpochInfo', [{ commitment: 'processed' }]),
            rpc('getVoteAccounts', [{ commitment: 'processed' }])
          ]);
          const tip = epochInfo.absoluteSlot;
          const curEpoch = epochInfo.epoch;
          const byPk = new Map(S.rows.map(r => [r.votePubkey, r]));
          for (const v of [...va.current, ...va.delinquent]) {
            const r = byPk.get(v.votePubkey);
            if (!r || !v.lastVote) continue;
            const lag = Math.max(0, tip - v.lastVote);
            r.lagN++;
            const d = lag - r.lagMean;
            r.lagMean += d / r.lagN;
            r.lagM2 += d * (lag - r.lagMean);
            r.lagMax = Math.max(r.lagMax, lag);
            if (lag >= 32) r.stalls++;
            r.rootLagLast = v.rootSlot ? Math.max(0, tip - v.rootSlot) : null;

            // Live window efficiency: credits gained since sampling began ÷
            // max possible over the same slots. High-resolution "right now"
            // view — catches flapping the 10-epoch averages smooth over.
            const cur = (v.epochCredits || []).find(e => Number(e[0]) === curEpoch);
            if (cur) {
              const credits = Number(cur[1]);
              if (!r.liveBase) {
                r.liveBase = { slot: tip, credits };
              } else if (tip - r.liveBase.slot >= 120) {   // ≥ ~1 min of slots
                r.liveEff = Math.min(1, Math.max(0,
                  (credits - r.liveBase.credits) / ((tip - r.liveBase.slot) * S.maxCreditsPerSlot)));
              }
            }
          }
          S.lagSamples++;
          const mins = Math.floor(S.lagSamples * 10 / 60);
          document.getElementById('vpLagBtn').textContent = 'Stop lag sampling (' + S.lagSamples + ' samples, ~' + mins + 'm)';
          computeRisk();   // once ≥30 samples, lag variance folds into the score
          if (S.lagSamples === 30) renderCharts();   // score basis changed — re-rank suspects
          // Re-render every 3rd sample (30s), not every 10s — constant DOM
          // replacement was destroying tooltips mid-hover.
          if (S.lagSamples % 3 === 0) renderTable();
        } catch (e) {
          console.warn('[vote probe] lag sample failed:', e.message);
        }
      }

      function toggleLag() {
        const btn = document.getElementById('vpLagBtn');
        if (S.lagTimer) {
          clearInterval(S.lagTimer);
          S.lagTimer = null;
          btn.textContent = 'Resume lag sampling';
          btn.className = 'vp-btn vp-secondary';
        } else {
          S.lagTimer = setInterval(lagTick, 10000);
          lagTick();
          btn.className = 'vp-btn vp-danger';
          btn.textContent = 'Stop lag sampling…';
          document.getElementById('vpLagNote').classList.remove('vp-hidden');
        }
      }

      // ── DEEP SCAN — raw vote-transaction latency ────────
      // Fetches recent blocks and parses every vote transaction. A vote for
      // slot N landing in slot N+k reveals per-vote latency k directly —
      // BEFORE the TVC grace period quantizes it into credits. Two validators
      // both earning full credits can still show mean latency 1.1 vs 1.9;
      // that gap is pure hardware + network, and it breaks the ties the
      // epoch averages can't.
      // ── LEADER BENCHMARK — the closest thing to a CPU test ─────
      // Voting is nearly free: receive, replay, sign. PRODUCING is the
      // expensive half — build the bank, pull and execute transactions,
      // hash state, ship it, all inside one slot. That is where a $10
      // shared vCPU and dedicated iron actually diverge, even at low TPS,
      // because block-building has a fixed cost floor (bank setup, PoH
      // hashing, state commitment) that runs every slot regardless of
      // transaction count.
      //
      // Two measurements, both taken INSIDE a validator's own 4-slot
      // leader window so geography cancels out entirely:
      //   PACE — seconds per slot across their own consecutive slots.
      //          blockTime is second-resolution, so a single window is
      //          coarse; aggregated over many windows the mean converges
      //          and slow producers separate.
      //   FILL — transactions packed per block vs the chain average over
      //          the same period. A leader that cannot execute fast
      //          enough before the deadline ships thinner blocks. On a
      //          quiet chain the steady vote traffic makes this a fair
      //          like-for-like comparison.
      async function leaderBench(silent) {
        if (!S.rows.length) { setStatus('Run the probe first.', true); return; }
        const btn = document.getElementById('vpBenchBtn');
        btn.disabled = true;
        try {
          const info = await rpc('getEpochInfo', [{ commitment: 'confirmed' }]);
          const epochStart = info.absoluteSlot - info.slotIndex;
          const endSlot = info.absoluteSlot - 20;
          const span = Math.min(info.slotIndex - 40, 150000);
          if (span < 4000) throw new Error('too early in this epoch — not enough leader history yet');
          const startSlot = endSlot - span + 1;

          setStatus('Leader benchmark: fetching schedule and produced blocks…');
          const [prodArr, sched] = await Promise.all([
            rpc('getBlocks', [startSlot, endSlot]),
            rpc('getLeaderSchedule', [])
          ]);
          const producedSet = new Set(prodArr || []);

          const act = activeRows();
          const byNode = new Map(act.map(r => [r.nodePubkey, r]));
          for (const r of S.rows) {
            r.benchWin = 0; r.benchDN = 0; r.benchDSum = 0; r.benchTxN = 0; r.benchTxSum = 0;
            r.benchPace = null; r.benchFill = null; r.hwScore = null;
          }

          // Budget ~4,000 block fetches, split evenly across the validators
          // currently in view (the filters decide the comparison field).
          const perVal = Math.max(4, Math.min(24,
            Math.floor(4000 / Math.max(1, act.length) / 4) * 4 || 4));
          const wanted = new Map();   // slot -> owning row
          for (const [ident, idxs] of Object.entries(sched || {})) {
            const r = byNode.get(ident);
            if (!r || !Array.isArray(idxs)) continue;
            // Group this validator's slots into their 4-slot windows and
            // keep only windows with >=2 produced slots (a pace needs a pair).
            const wins = new Map();
            for (const idx of idxs) {
              const abs = epochStart + idx;
              if (abs < startSlot || abs > endSlot) continue;
              if (!producedSet.has(abs)) continue;
              const w = abs - (idx % 4);
              if (!wins.has(w)) wins.set(w, []);
              wins.get(w).push(abs);
            }
            let taken = 0;
            for (const slots of wins.values()) {
              if (slots.length < 2) continue;
              slots.sort((a, b) => a - b);
              for (const s of slots) {
                if (taken >= perVal) break;
                wanted.set(s, r);
                taken++;
              }
              r.benchWin++;
              if (taken >= perVal) break;
            }
          }

          const slots = [...wanted.keys()].sort((a, b) => a - b);
          if (!slots.length) throw new Error('no usable leader windows found in range');

          // Fetch light blocks: signatures give the tx count, and we need
          // blockTime — no full transaction payloads required.
          const BATCH = 25;
          const meta = new Map();   // slot -> {bt, tx}
          for (let i = 0; i < slots.length; i += BATCH) {
            setStatus('Leader benchmark: ' + i + '/' + slots.length + ' blocks…');
            if (S.scanning) setProgress(60 + 38 * i / slots.length, 'Benchmarking block production… ' + i + '/' + slots.length);
            const chunk = slots.slice(i, i + BATCH);
            const body = chunk.map(s => ({
              jsonrpc: '2.0', id: s, method: 'getBlock',
              params: [s, { encoding: 'json', transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 0 }]
            }));
            const res = await fetch(VP_RPC, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
            if (!res.ok) throw new Error('getBlock batch HTTP ' + res.status);
            const batch = await res.json();
            if (!Array.isArray(batch)) continue;
            for (const b of batch) {
              const blk = b && b.result;
              if (!blk || !blk.blockTime) continue;
              meta.set(Number(b.id), { bt: Number(blk.blockTime), tx: (blk.signatures || []).length });
            }
          }

          // Per-validator aggregation, strictly within their own windows.
          let gTxSum = 0, gTxN = 0;
          for (const [slot, r] of wanted) {
            const m = meta.get(slot);
            if (!m) continue;
            r.benchTxN++; r.benchTxSum += m.tx;
            gTxSum += m.tx; gTxN++;
          }
          const byWindow = new Map();
          for (const [slot, r] of wanted) {
            const w = slot - (slot % 4);
            const key = r.nodePubkey + ':' + w;
            if (!byWindow.has(key)) byWindow.set(key, { r, slots: [] });
            byWindow.get(key).slots.push(slot);
          }
          // Pace: seconds-per-slot from intra-window blockTime deltas.
          // blockTime is 1s-resolution and slots are ~0.4s, so a single
          // interval is coarse — we accumulate every usable interval across
          // ALL of a validator's windows and let volume smooth it.
          for (const { r, slots: ws } of byWindow.values()) {
            ws.sort((a, b) => a - b);
            for (let i = 1; i < ws.length; i++) {
              const a = meta.get(ws[i - 1]), b = meta.get(ws[i]);
              if (!a || !b) continue;
              const dt = b.bt - a.bt, ds = ws[i] - ws[i - 1];
              if (ds <= 0 || ds > 4 || dt < 0 || dt > 30) continue;
              r.benchDSum += dt; r.benchDN += ds;
            }
          }
          const gTxMean = gTxN ? gTxSum / gTxN : 0;
          for (const r of S.rows) {
            if (r.benchDN >= 2) r.benchPace = r.benchDSum / r.benchDN;
            if (r.benchTxN >= 2 && gTxMean > 0) r.benchFill = (r.benchTxSum / r.benchTxN) / gTxMean;
          }

          S.benchDone = true;
          S.benchGlobalTx = gTxMean;
          computeRisk();
          if (!silent) { renderCharts(); renderTable(); }
          const n = S.rows.filter(r => r.benchPace !== null).length;
          if (!silent) setStatus('Leader benchmark done: ' + meta.size + ' blocks, pace for ' + n + ' validators.');
        } catch (e) {
          console.error('[vote probe] leader bench', e);
          setStatus('Leader benchmark error: ' + e.message, true);
        } finally {
          btn.disabled = false;
        }
      }

      async function deepScan(silent) {
        if (!S.rows.length) { setStatus('Run the probe first.', true); return; }
        const btn = document.getElementById('vpDeepBtn');
        btn.disabled = true;
        try {
          const SLOTS = 500, BATCH = 20;
          const info = await rpc('getEpochInfo', [{ commitment: 'confirmed' }]);
          const tip = info.absoluteSlot - 5;   // stay behind the un-settled tip
          for (const r of S.rows) {
            r.vlatN = 0; r.vlatSum = 0; r.vlatMax = 0; r.vlatTail = 0; r.vgapMax = 0; r._lastVoteBlock = null;
            r.vposN = 0; r.vposMean = 0; r.vposM2 = 0;
            r.bN = 0; r.bTail = 0; r.bGapMax = 0; r._bLast = null;
            r.ledSlots = 0; r.ledMissed = 0; r.w1Led = 0; r.w1Missed = 0;
          }
          const byPk = new Map(S.rows.map(r => [r.votePubkey, r]));
          let scanned = 0, produced = 0;
          for (let s = tip - SLOTS + 1; s <= tip; s += BATCH) {
            const hi = Math.min(s + BATCH - 1, tip);
            setStatus('Deep scan: ' + scanned + '/' + SLOTS + ' slots…');
            if (S.scanning) setProgress(30 + 25 * scanned / SLOTS, 'Scanning vote transactions… ' + scanned + '/' + SLOTS);
            const body = [];
            for (let slot = s; slot <= hi; slot++) {
              body.push({
                jsonrpc: '2.0', id: slot, method: 'getBlock',
                params: [slot, { encoding: 'jsonParsed', transactionDetails: 'full', rewards: false, maxSupportedTransactionVersion: 0 }]
              });
            }
            const res = await fetch(VP_RPC, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
            if (!res.ok) throw new Error('getBlock batch HTTP ' + res.status);
            const batch = await res.json();
            scanned += (hi - s + 1);
            if (!Array.isArray(batch)) continue;
            for (const b of batch) {
              const blk = b && b.result;
              if (!blk || !Array.isArray(blk.transactions)) continue;   // skipped slot
              produced++;
              const blockSlot = Number(b.id);
              // Two passes: collect this block's votes IN ORDER first —
              // a vote's position among the block's votes is a sub-slot
              // arrival measurement (leaders pack roughly in arrival order).
              const events = [];
              for (const tx of blk.transactions) {
                const ixs = tx?.transaction?.message?.instructions || [];
                for (const ix of ixs) {
                  if (ix.program !== 'vote' || !ix.parsed) continue;
                  const inf = ix.parsed.info || {};
                  const vaPk = inf.voteAccount;
                  if (!vaPk) continue;
                  const r = byPk.get(vaPk);
                  if (!r) continue;
                  // Newest slot this tx votes on, across instruction shapes:
                  // legacy vote (slots[]), (compact)updateVoteState / towerSync (lockouts[])
                  let voted = null;
                  if (inf.vote && Array.isArray(inf.vote.slots) && inf.vote.slots.length) {
                    voted = Math.max(...inf.vote.slots.map(Number));
                  } else {
                    const vsu = inf.voteStateUpdate || inf.towerSync || inf.tower_sync || null;
                    const locks = vsu && (vsu.lockouts || vsu.lockout);
                    if (Array.isArray(locks) && locks.length) {
                      voted = Math.max(...locks.map(l => Number(l && (l.slot !== undefined ? l.slot : l[0]))));
                    }
                  }
                  if (voted === null || !isFinite(voted)) continue;
                  const lat = blockSlot - voted;
                  if (lat < 0 || lat > 64) continue;   // anomalies / deep catch-up
                  events.push({ r, lat });
                }
              }
              const V = events.length;
              events.forEach((ev, i) => {
                const r = ev.r, lat = ev.lat;
                r.vlatN++; r.vlatSum += lat; r.vlatMax = Math.max(r.vlatMax, lat);
                if (lat >= 2) r.vlatTail++;   // missed the next slot — jitter tail
                if (r._lastVoteBlock !== null) {
                  r.vgapMax = Math.max(r.vgapMax, blockSlot - r._lastVoteBlock);
                }
                r._lastVoteBlock = blockSlot;
                // Arrival-order position, normalized 0 (first) … 1 (last).
                // Mean ≈ geography + hardware; VARIANCE ≈ hardware jitter.
                if (V > 1) {
                  const pos = i / (V - 1);
                  r.vposN++;
                  const d = pos - r.vposMean;
                  r.vposMean += d / r.vposN;
                  r.vposM2 += d * (pos - r.vposMean);
                }
              });
            }
          }
          // Epoch-boundary stress scan — the one guaranteed load event on a
          // quiet chain. Rollover forces rewards distribution, stake
          // processing, and schedule computation on every validator; weak
          // boxes leak late/bunched votes exactly there while dedicated
          // hardware sails through. Scans ~400 slots right after the last
          // boundary (skipped gracefully if the RPC no longer has them).
          try {
            const epochStartSlot = info.absoluteSlot - info.slotIndex;
            if (info.slotIndex > 700) {
              const B0 = epochStartSlot + 20, BSLOTS = 400;
              let bProduced = 0, bFailed = false;
              for (let s = B0; s < B0 + BSLOTS && !bFailed; s += BATCH) {
                const hi = Math.min(s + BATCH - 1, B0 + BSLOTS - 1);
                setStatus('Deep scan: epoch-boundary stress ' + (s - B0) + '/' + BSLOTS + ' slots…');
                const body = [];
                for (let slot = s; slot <= hi; slot++) {
                  body.push({ jsonrpc: '2.0', id: slot, method: 'getBlock',
                    params: [slot, { encoding: 'jsonParsed', transactionDetails: 'full', rewards: false, maxSupportedTransactionVersion: 0 }] });
                }
                const res = await fetch(VP_RPC, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body)
                });
                if (!res.ok) { bFailed = true; break; }
                const batch2 = await res.json();
                if (!Array.isArray(batch2)) continue;
                for (const b of batch2) {
                  const blk = b && b.result;
                  if (!blk || !Array.isArray(blk.transactions)) continue;
                  bProduced++;
                  const blockSlot = Number(b.id);
                  for (const tx of blk.transactions) {
                    const ixs = tx?.transaction?.message?.instructions || [];
                    for (const ix of ixs) {
                      if (ix.program !== 'vote' || !ix.parsed) continue;
                      const inf = ix.parsed.info || {};
                      const r = byPk.get(inf.voteAccount);
                      if (!r) continue;
                      let voted = null;
                      if (inf.vote && Array.isArray(inf.vote.slots) && inf.vote.slots.length) {
                        voted = Math.max(...inf.vote.slots.map(Number));
                      } else {
                        const vsu = inf.voteStateUpdate || inf.towerSync || inf.tower_sync || null;
                        const locks = vsu && (vsu.lockouts || vsu.lockout);
                        if (Array.isArray(locks) && locks.length) {
                          voted = Math.max(...locks.map(l => Number(l && (l.slot !== undefined ? l.slot : l[0]))));
                        }
                      }
                      if (voted === null || !isFinite(voted)) continue;
                      const lat = blockSlot - voted;
                      if (lat < 0 || lat > 64) continue;
                      r.bN++; if (lat >= 2) r.bTail++;
                      if (r._bLast !== null) r.bGapMax = Math.max(r.bGapMax, blockSlot - r._bLast);
                      r._bLast = blockSlot;
                    }
                  }
                }
              }
              S.boundaryBlocks = bProduced;
            }
          } catch (e) {
            console.warn('[vote probe] boundary scan failed:', e.message);
          }

          // Leader-window forensics: ~2 cheap calls cover ~4.5 hours.
          // getBlocks gives every produced slot number; getLeaderSchedule
          // maps identities to their slots. Miss-by-window-position falls
          // out: slow boxes disproportionately fumble slot 1 of their
          // 4-slot window (late building the first bank) even when overall
          // skips round to zero.
          try {
            const epochStart = info.absoluteSlot - info.slotIndex;
            const endSlot = tip - 10;
            const span = Math.min(info.slotIndex - 20, 40000);
            if (span > 2000) {
              setStatus('Deep scan: leader-window analysis over ' + span.toLocaleString() + ' slots…');
              const startSlot = endSlot - span + 1;
              const [prodArr, sched] = await Promise.all([
                rpc('getBlocks', [startSlot, endSlot]),
                rpc('getLeaderSchedule', [])
              ]);
              const producedSet = new Set(prodArr || []);
              const byNode = new Map(S.rows.map(r => [r.nodePubkey, r]));
              for (const [ident, idxs] of Object.entries(sched || {})) {
                const r = byNode.get(ident);
                if (!r || !Array.isArray(idxs)) continue;
                for (const idx of idxs) {
                  const abs = epochStart + idx;
                  if (abs < startSlot || abs > endSlot) continue;
                  const first = (idx % 4 === 0);
                  r.ledSlots++; if (first) r.w1Led++;
                  if (!producedSet.has(abs)) { r.ledMissed++; if (first) r.w1Missed++; }
                }
              }
              S.windowSpan = span;
            }
          } catch (e) {
            console.warn('[vote probe] leader-window analysis failed:', e.message);
          }

          S.deepDone = true;
          S.deepBlocks = produced;   // for vote-cadence density
          computeRisk();
          renderCharts();   // top-suspects re-ranks with latency-weighted scores
          renderTable();
          if (!silent) {
            computeRisk(); renderCharts(); renderTable();
            setStatus('Deep scan done (' + produced + ' blocks). Starting CPU benchmark…');
            await leaderBench();
          } else {
            computeRisk();   // silent: compute, no render
          }
        } catch (e) {
          console.error('[vote probe] deep scan', e);
          setStatus('Deep scan error: ' + e.message, true);
        } finally {
          btn.disabled = false;
        }
      }

      // ── CSV export ──────────────────────────────────────
      function downloadCsv() {
        const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
        const head = ['vote_pubkey','node_pubkey','name','farmer_risk','risk_low_confidence','ip','ip_shared_count','subnet24_shared_count','name_group_count','name_style_count','birth_cohort_count','first_epoch','trajectory_twin_count','fleet_mortality_pct','subnet16_count','clock_drift_s','stake_xnt','self_stake_xnt','commission_pct','delinquent','epochs_counted','mean_efficiency','stddev_efficiency','worst_epoch_efficiency','worst_epoch','percentile','lag_samples','lag_mean_slots','lag_stddev_slots','lag_max_slots','root_lag_last','live_efficiency','stall_samples','vote_lat_n','vote_lat_mean_slots','vote_lat_max_slots','vote_late_pct','vote_gap_max_slots','vote_density','stake_cohort_count','arrival_pos_mean','arrival_pos_sd','boundary_votes','boundary_late_pct','boundary_gap_max','led_slots','led_missed','w1_led','w1_missed','bench_windows','bench_pace_s_per_slot','bench_fill_ratio','bench_tx_per_block','hardware_score','software_version'];
        const lines = [head.join(',')];
        for (const r of S.rows) {
          const lagSd = r.lagN > 1 ? Math.sqrt(r.lagM2 / (r.lagN - 1)) : '';
          lines.push([
            r.votePubkey, r.nodePubkey, q(r.name || ''),
            r.risk === null || r.risk === undefined ? '' : r.risk,
            r.riskLowConf ? 'true' : 'false',
            r.ip || '', r.ipShared === null ? '' : r.ipShared, r.subnetShared === null ? '' : r.subnetShared,
            r.nameGroup, r.styleGroup, r.cohortCount, r.firstEpoch === null ? '' : r.firstEpoch,
            r.twinN || 0, r.fleetMortality === null ? '' : (100 * r.fleetMortality).toFixed(1), r.subnet16Shared === null ? '' : r.subnet16Shared,
            r.clockDrift === null ? '' : r.clockDrift.toFixed(2),
            r.stake.toFixed(4), r.selfStake === null ? '' : r.selfStake.toFixed(4), r.commission, r.delinquent,
            r.epochsCounted, r.meanEff.toFixed(6), r.sdEff.toFixed(6), r.worstEff.toFixed(6),
            r.worstEpoch === null ? '' : r.worstEpoch, r.pctile === null ? '' : r.pctile,
            r.lagN, r.lagN ? r.lagMean.toFixed(2) : '', lagSd === '' ? '' : lagSd.toFixed(2),
            r.lagN ? r.lagMax : '', r.rootLagLast === null ? '' : r.rootLagLast,
            r.liveEff === null ? '' : r.liveEff.toFixed(6), r.lagN ? r.stalls : '',
            r.vlatN, r.vlatN ? (r.vlatSum / r.vlatN).toFixed(3) : '', r.vlatN ? r.vlatMax : '',
            r.vlatN ? (100 * r.vlatTail / r.vlatN).toFixed(2) : '', r.vlatN ? r.vgapMax : '',
            (r.vlatN && S.deepBlocks >= 50) ? (r.vlatN / S.deepBlocks).toFixed(3) : '',
            r.stakeCohort,
            r.vposN ? r.vposMean.toFixed(4) : '', r.vposN > 1 ? Math.sqrt(r.vposM2 / (r.vposN - 1)).toFixed(4) : '',
            r.bN, r.bN ? (100 * r.bTail / r.bN).toFixed(2) : '', r.bN ? r.bGapMax : '',
            r.ledSlots, r.ledMissed, r.w1Led, r.w1Missed,
            r.benchWin || 0, r.benchPace === null ? '' : r.benchPace.toFixed(3),
            r.benchFill === null ? '' : r.benchFill.toFixed(3),
            r.benchTxN ? (r.benchTxSum / r.benchTxN).toFixed(1) : '',
            r.hwScore === null ? '' : r.hwScore, q(r.version || '')
          ].join(','));
        }
        const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'x1_validator_forensics_epoch' + S.currentEpoch + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
      }

      // Expose globals (index.html's static controls + the data-action handlers below)
      window.vpOpenProbe   = openProbe;
      window.vpCloseProbe  = closeProbe;
      window.vpRunProbe    = runProbe;
      window.vpToggleLag   = toggleLag;
      window.vpDownloadCsv = downloadCsv;
      window.vpSetSort     = setSort;
      window.vpCopyPk      = copyPk;
      window.vpRenderTable = renderTable;
      window.vpToggleDelinq = toggleDelinq;
      window.vpMinStakeChange = minStakeChange;
      window.vpFilterTo = function (pk) {
        const box = document.getElementById('vpFilterBox');
        box.value = pk;
        renderTable();
        document.getElementById('vpTablePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      window.vpDeepScan    = deepScan;
      window.vpLeaderBench = leaderBench;
    })();

    Actions.register({
      'vp-filter-to': (el, e, d) => vpFilterTo(d.vote),
      'vp-sort':      (el, e, d) => vpSetSort(d.key),
      'vp-copy':      (el, e, d) => vpCopyPk(d.vote, el),
    });
