// Offline smoke of the F11 Delegator APR tile + modal (js/apr.js, #aprModal):
// serve the repo, abort external requests, render real validator cards with
// renderValidatorCard(), let the ledger (data/rewards.json, same-origin) load
// and check: the card layout (4 + 4, APR in Earnings, Foundation delegation in
// Health, no Commission tile), the tile value against the same formula run in
// node over the served JSON, the 7-epoch trend pill, the Details modal (hero,
// network comparison, rows, close paths), the 100 % and 0 % commission paths,
// 0 inline handlers, 0 page errors, 0 [Actions] warnings.
// Since 2026-11-18 (audit #1) also the clean-epoch filter: the expected values
// below come from a second implementation of the rule documented in js/apr.js,
// and synthetic validators cover each way a ledger cell can be wrong (stake
// recorded as 1 XNT, a stake ramp shifted by one epoch, a re-fetch stamp, a 0
// reward) plus the case that must NOT be filtered (a weak epoch on steady stake).
//   node scripts/c2-tests/apr-test.js /path/to/repo
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.argv[2] || '.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const slow = {};   // served path → 'stall' (never answered) | delay in ms — for the "slow data" section at the end
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  const send = () => { res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f)); };
  if (slow[p] === 'stall') return;
  if (typeof slow[p] === 'number') return void setTimeout(send, slow[p]);
  send();
});

const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/rewards.json')));
const terminal = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/terminal.json')));
const ti = Object.fromEntries(terminal.validatorFields.map((f, i) => [f, i]));
// Subject: the largest non-X1 validator at 10 % commission with 30 indexed epochs
const subject = terminal.validators
  .filter(r => !r[ti.x1Labs] && r[ti.commission] === 10 && ledger.validators[r[ti.votePubkey]] && ledger.validators[r[ti.votePubkey]].v.slice(-30).every(x => x != null))
  .sort((a, b) => b[ti.activatedStake] - a[ti.activatedStake])[0];
const VOTE = subject[ti.votePubkey], STAKE_XNT = subject[ti.activatedStake] / 1e9, NAME = subject[ti.name];
// Expected APR with the page's offline constants (216,000 slots × 0.368 s)
const EPY = 365.25 * 86400 / (216000 * 0.368);
// ── Clean-epoch filter, second implementation (rule: js/apr.js "Clean-epoch filter") ──
const RATE_MAX = 1.25, RATE_MIN = 0.9, STEADY = 0.005, NE = ledger.epochs.length;
const nbr = (e, i) => { if (!e.st) return null; const j = i > 0 ? i - 1 : 1; return e.st[j] != null ? e.st[j] : null; };
function refRates(validators) {            // network gross rate per ledger column: median over validators with a steady recorded stake
  const ref = [];
  for (let i = 0; i < NE; i++) {
    const xs = [];
    for (const e of Object.values(validators)) {
      if (!e.st || !e.c || !(e.v[i] > 0) || e.st[i] == null || e.c[i] == null) continue;
      const st = e.st[i], c = e.c[i], nb = nbr(e, i);
      if (st < 1000 || !(c > 0) || c >= 100 || !(nb > 0) || Math.abs(st / nb - 1) > STEADY) continue;
      xs.push((e.v[i] / (c / 100)) / (st * 1e9));
    }
    xs.sort((a, b) => a - b);
    const m = xs.length >> 1;
    ref.push(xs.length < 5 ? null : (xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2));
  }
  const have = ref.map((x, i) => x == null ? -1 : i).filter(i => i >= 0);
  return ref.map((x, i) => x != null ? x : (have.length ? ref[have.reduce((b, j) => Math.abs(j - i) < Math.abs(b - i) ? j : b, have[0])] : null));
}
function cleanRows(e, n, ref, fbStake, fbComm) {   // newest-first net rates of the usable epochs (+ their ledger columns) + how many were left out
  const rows = [], idx = []; let dropped = 0;
  for (let i = NE - 1; i >= 0 && rows.length < n; i--) {
    const v = e.v[i]; if (v == null) continue;
    const c = (e.c && e.c[i] != null) ? e.c[i] : fbComm, rec = !!(e.st && e.st[i] != null), st = rec ? e.st[i] : fbStake;
    if (c == null || !(st > 0) || !(c > 0) || c >= 100) continue;
    if (v === 0) { dropped++; continue; }
    const g = (v / (c / 100)) / (st * 1e9), r = ref[i];
    if (r) {
      const ratio = g / r, nb = nbr(e, i);
      if (ratio > RATE_MAX) { dropped++; continue; }
      if (ratio < RATE_MIN && (!rec || (nb != null && (nb === st || Math.abs(st / nb - 1) > STEADY)))) { dropped++; continue; }
    }
    rows.push(g * (1 - c / 100)); idx.push(i);
  }
  return { rows, idx, dropped };
}
const aprOf = (rows) => rows.reduce((a, b) => a + b, 0) / rows.length * EPY * 100;
const ref0 = refRates(ledger.validators);
// ── Credits method, second implementation (rule: js/apr.js "CREDITS METHOD"): pv[E] × cr[E] × (1 − c) ──
// Used by the page whenever the ledger has `pv` and the validator has `cr`; an epoch with 0 credits counts as 0 %.
function creditRows(e, n, pv, fbComm) {
  const rows = []; let offline = 0;
  for (let i = NE - 1; i >= 0 && rows.length < n; i--) {
    if (pv[i] == null || e.cr[i] == null) continue;
    const c = (e.c && e.c[i] != null) ? e.c[i] : fbComm;
    if (c == null || c >= 100) continue;
    if (e.cr[i] === 0) offline++;
    rows.push(pv[i] * e.cr[i] * (1 - c / 100));
  }
  return { rows, dropped: 0, offline };
}
// The served ledger carries pv / cr from the first hourly run after 2026-11-18; this test passes with either kind.
const SERVED_HAS_CREDITS = Array.isArray(ledger.pv) && Array.isArray(ledger.validators[VOTE].cr);
const expectFor = (n) => SERVED_HAS_CREDITS ? creditRows(ledger.validators[VOTE], n, ledger.pv, 10) : cleanRows(ledger.validators[VOTE], n, ref0, STAKE_XNT, 10);
const subj30 = expectFor(30), subj7 = expectFor(7);
const mk = (vote, name, stakeXnt, commission, extra) => Object.assign({ voteAccount: vote, nodePubkey: 'node-' + name, name, commission, activatedStake: stakeXnt, rewardsBalance: 1, isDelinquent: false, version: '4.0.3', performanceScore: 97.5, skipRate: 0, epochCredits: 1, epochCreditsHistory: [], iconUrl: '' }, extra || {});
const V_100 = 'Vote11111111111111111111111111111111111111', V_0 = 'Vote00000000000000000000000000000000000000', V_NEW = 'VoteNewNewNewNewNewNewNewNewNewNewNewNewNew';

let fails = 0;
const check = (ok, label, extra) => { console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok || extra === undefined ? '' : ' — ' + JSON.stringify(extra))); if (!ok) fails++; };

(async () => {
  await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [], warnings = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { const t = m.text(); if (/\[Actions\]/.test(t)) warnings.push(t); });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
  await page.goto(`http://127.0.0.1:${port}/#/lookup/${VOTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { const m = document.getElementById('disclaimerModal'); if (m) m.style.display = 'none'; });

  check(await page.evaluate(() => Actions.has('apr-details') && Actions.has('apr-close') && Actions.has('apr-overlay') && typeof window.aprFor === 'function'), 'apr actions registered, aprFor exposed');

  // Feed allValidators from the served terminal snapshot (the RPC is blocked offline) so the network comparison works
  await page.evaluate(async (rows) => {
    allValidators = rows;
    document.getElementById('resultsSection').style.display = 'block';
    try { await window.RewardsLedger.load(); } catch (e) {}
    try { await window.delegLoad(); } catch (e) {}
  }, terminal.validators.filter(r => !r[ti.x1Labs]).map(r => ({ votePubkey: r[ti.votePubkey], nodePubkey: r[ti.nodePubkey], name: r[ti.name], activatedStake: r[ti.activatedStake], commission: r[ti.commission], delinquent: r[ti.delinquent] })));

  // Render the subject's card
  await page.evaluate((v) => { document.getElementById('validatorResults').innerHTML = renderValidatorCard(v, true, false); }, mk(VOTE, NAME, STAKE_XNT, 10));
  await page.waitForTimeout(2500); // ledger is loaded; slotSeconds() falls back after the blocked RPC call

  const card = await page.evaluate(() => {
    const c = document.querySelector('#validatorResults .validator-card');
    const earn = [...c.querySelectorAll('.stat-group-earn .stat-item .stat-label')].map(e => e.textContent.trim().replace(/\s+/g, ' '));
    const health = [...c.querySelectorAll('.stat-group-health .stat-item .stat-label')].map(e => e.textContent.trim().replace(/\s+/g, ' '));
    const t = c.querySelector('.apr-section');
    return { earn, health, value: t.querySelector('.stat-value').textContent, sub: (t.querySelector('.stat-subtext') || {}).textContent, trend: (t.querySelector('.apr-trend') || {}).textContent, details: !!t.querySelector('[data-action="apr-details"]'), inline: c.querySelectorAll('[onclick],[onerror],[onchange]').length, delegInHealth: !!c.querySelector('.stat-group-health .deleg-section'), commissionTile: /Commission/.test(health.join('|')) };
  });
  check(card.earn.length === 4 && card.health.length === 4, 'card keeps 4 + 4 tiles', { earn: card.earn, health: card.health });
  check(card.earn[3] === 'Delegator APR' && card.delegInHealth && !card.commissionTile, 'APR is the 4th Earnings tile; Foundation delegation moved to Health; Commission tile gone', card);
  const shown = parseFloat(card.value);
  const exp30 = aprOf(subj30.rows), exp7 = aprOf(subj7.rows);
  check(Math.abs(shown - exp30) < 0.006, `tile value ${card.value} matches the formula over the served ledger (${exp30.toFixed(2)}%)`, { shown, exp30 });
  check(card.sub === subj30.rows.length + ' ep · net of 10% fee' && card.details, 'subtext: ' + subj30.rows.length + ' ep · net of 10% fee + Details', card.sub);
  check(new RegExp('7d ' + exp7.toFixed(2).replace('.', '\\.') + '%').test(card.trend), '7-epoch trend pill matches', { trend: card.trend, exp7 });
  check(card.inline === 0, '0 inline handlers in the card');

  // Details modal
  await page.click('#validatorResults .apr-section [data-action="apr-details"]');
  await page.waitForTimeout(600);
  const modal = await page.evaluate(() => {
    const m = document.getElementById('aprModal');
    const hero = [...m.querySelectorAll('.apm-hero b')].map(b => b.textContent);
    return { display: getComputedStyle(m).display, sub: document.getElementById('aprModalSub').textContent, hero, bars: m.querySelectorAll('.apm-bar').length, barsLabel: (m.querySelector('.apm-bars label') || {}).textContent, rows: [...m.querySelectorAll('.apm-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()), foot: (m.querySelector('.dm-foot') || {}).textContent };
  });
  check(modal.display === 'flex' && modal.sub === NAME, 'modal opens with the validator name', { display: modal.display, sub: modal.sub });
  check(modal.hero.length === 3 && parseFloat(modal.hero[0]) === shown && parseFloat(modal.hero[2]) > parseFloat(modal.hero[0]), 'hero: net 30 = tile, gross > net', modal.hero);
  check(modal.bars === 3 && /\d+ validators/.test(modal.barsLabel), 'network comparison: this / median / top 10% over N validators', modal.barsLabel);
  const net = await page.evaluate(() => window.aprNetwork());
  check(net && net.n > 100 && net.median > 3 && net.median < 20 && net.p90 >= net.median, 'network median/p90 plausible', net);
  check(modal.rows.some(r => /Epochs per year\s*39\d/.test(r)) && modal.rows.some(r => /On 10,000 XNT delegated\s*≈ \d/.test(r)), 'rows: epochs per year ~397 and the 10,000 XNT example', modal.rows);
  if (SERVED_HAS_CREDITS) check(/network rate per credit × the vote credits it earned/.test(modal.foot) && /× \(1 − 10%\)/.test(modal.foot) && modal.rows.some(r => /^Vote credits, epoch \d+\s*[\d,]+ \([\d.]+% of the maximum\)/.test(r)), 'credits method: the footnote explains it and the rows show the epoch\'s vote credits', { foot: modal.foot, rows: modal.rows });
  else check(/reward ÷ 10%/.test(modal.foot) && ((/recorded with each epoch/.test(modal.foot) && /left out/.test(modal.foot)) || /today's active stake/.test(modal.foot)), 'footnote explains the method, the recorded stake and that unfit epochs are left out', modal.foot);
  check(subj30.dropped === 0 ? !modal.rows.some(r => /Epochs left out/.test(r)) : modal.rows.some(r => new RegExp('Epochs left out\\s*' + subj30.dropped + '\\b').test(r)), 'modal ' + (subj30.dropped ? 'lists ' + subj30.dropped + ' epoch(s) left out' : 'has no "left out" row for a clean validator'), modal.rows);
  // close paths
  await page.click('#aprModal .modal-close'); await page.waitForTimeout(100);
  const c1 = await page.evaluate(() => getComputedStyle(document.getElementById('aprModal')).display);
  await page.click('#validatorResults .apr-section [data-action="apr-details"]'); await page.waitForTimeout(300);
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  const c2 = await page.evaluate(() => getComputedStyle(document.getElementById('aprModal')).display);
  await page.click('#validatorResults .apr-section [data-action="apr-details"]'); await page.waitForTimeout(300);
  await page.click('#aprModal .modal-body'); await page.waitForTimeout(100);
  const c3 = await page.evaluate(() => getComputedStyle(document.getElementById('aprModal')).display);
  await page.mouse.click(5, 5); await page.waitForTimeout(100);
  const c4 = await page.evaluate(() => getComputedStyle(document.getElementById('aprModal')).display);
  check(c1 === 'none' && c2 === 'none' && c3 === 'flex' && c4 === 'none', '× / Escape / backdrop close; inner click keeps it open', { c1, c2, c3, c4 });

  // 100 % commission, no history, and 0 % commission (synthetic ledger + Program entries)
  await page.evaluate(async ({ v100, v0, vnew }) => {
    const doc = window.RewardsLedger.doc; const n = doc.epochs.length;
    doc.validators[v100] = { w: null, self: [], v: new Array(n).fill(5e9) };
    doc.validators[v0] = { w: null, self: ['x'], v: new Array(n).fill(0), s: new Array(n).fill(2e9) };   // 2 XNT/epoch on 10,000 XNT self-stake
    const d = await window.delegLoad(); d.validators[v0] = { name: 'ZeroFee', st: 'Approved', fc: [], ss: '10000000000000', ds: '0', cm: 0, ver: '4.0.3', dq: false, as: '10000000000000', vc: 99, sk: 0, ls: 10 };
  }, { v100: V_100, v0: V_0, vnew: V_NEW });
  await page.evaluate((cards) => { document.getElementById('validatorResults').innerHTML = cards.map(c => renderValidatorCard(c, true, false)).join(''); }, [mk(V_100, 'AllMine', 50000, 100), mk(V_0, 'ZeroFee', 10000, 0), mk(V_NEW, 'Newcomer', 5000, 10)]);
  await page.waitForTimeout(800);
  const edge = await page.evaluate(() => [...document.querySelectorAll('#validatorResults .apr-section')].map(t => ({ v: t.querySelector('.stat-value').textContent, sub: (t.querySelector('.stat-subtext') || {}).textContent })));
  check(edge[0].v === '0%' && /100% commission/.test(edge[0].sub), '100% commission → 0% · nothing to delegators', edge[0]);
  const exp0 = 2e9 / 1e13 * EPY * 100;
  check(Math.abs(parseFloat(edge[1].v) - exp0) < 0.006 && /own-stake yield/.test(edge[1].sub), `0% commission → self-stake method (${exp0.toFixed(2)}%)`, edge[1]);
  check(edge[2].v === '—' && /not enough reward history/.test(edge[2].sub), 'unknown validator → — · not enough reward history', edge[2]);

  // ── Clean-epoch filter (audit #1): synthetic validators built on the served ledger's own network rate ──
  const S = 500000, last = NE - 1;
  const steady = Array.from({ length: NE }, (_, i) => +(S * (1 + 0.0002 * i)).toFixed(3));   // grows a little every epoch, like real stake
  // v = the 10 % slice of ref × the stake that REALLY earned it; `st` = what the ledger recorded
  const mkEntry = (st, real, tweak) => {
    const e = { w: null, self: [], v: [], st: st.slice(), c: new Array(NE).fill(10) };
    for (let i = 0; i < NE; i++) e.v.push(Math.round(ref0[i] * 0.10 * (real || st)[i] * 1e9));
    if (tweak) tweak(e);
    return e;
  };
  // Stake ramps ×10 over five epochs; every cell holds the NEXT epoch's stake (how the builder records it)
  const k0 = last - 14;
  const rampReal = steady.map((s, i) => i <= k0 ? s : i > k0 + 5 ? s * 10 : s * (1 + 9 * (i - k0) / 5));
  const rampRec = rampReal.map((_, i) => +(i < last ? rampReal[i + 1] : rampReal[i] * 1.0002).toFixed(3));
  const SY = { clean: 'VoteCLEANxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', spike: 'VoteSPiKExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', ramp: 'VoteRAMPxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
               weak: 'VoteWEAKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', zero: 'VoteZERoxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', stamp: 'VoteSTAMPxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', bad: 'VoteBADxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' };
  const synth = {
    [SY.clean]: mkEntry(steady),
    [SY.spike]: mkEntry(steady, steady, e => { e.st[last - 4] = 1; }),                                   // one cell recorded 1 XNT against a normal reward (the 250,000 % card)
    [SY.ramp]:  mkEntry(rampRec, rampReal),                                                              // five cells recorded against a larger, later stake
    [SY.weak]:  mkEntry(steady, steady, e => { e.v[last - 3] = Math.round(e.v[last - 3] * 0.5); }),      // really earned half that epoch, stake steady → must stay in
    [SY.zero]:  mkEntry(steady, steady, e => { e.v[last - 2] = 0; }),                                    // a 0 reward at 10 % commission
    [SY.stamp]: mkEntry(steady, steady, e => { for (let i = 0; i < 12; i++) e.st[i] = 5 * S; }),         // re-fetch stamp: twelve old cells carry one identical, larger stake
    [SY.bad]:   mkEntry(steady, steady, e => { for (let i = 0; i < last - 1; i++) e.st[i] = 1; }),       // only two usable epochs
  };
  await page.evaluate((entries) => { Object.assign(window.RewardsLedger.doc.validators, entries); }, synth);
  // both sides now compute the reference over the same set (served ledger + the synthetic entries)
  const ref1 = refRates(Object.assign({}, ledger.validators, synth));
  const order = ['clean', 'spike', 'ramp', 'weak', 'zero', 'stamp', 'bad'];
  await page.evaluate((cards) => { document.getElementById('validatorResults').innerHTML = cards.map(c => renderValidatorCard(c, true, false)).join(''); }, order.map(k => mk(SY[k], 'Synth-' + k, S, 10)));
  await page.waitForTimeout(800);
  const sy = await page.evaluate((votes) => votes.map(v => {
    const t = document.querySelector('.apr-section[data-vote="' + v + '"]'), a = window.aprFor(v);
    return { value: t.querySelector('.stat-value').textContent, sub: (t.querySelector('.stat-subtext') || {}).textContent, epochs: a.long && a.long.epochs, dropped: a.dropped };
  }), order.map(k => SY[k]));
  const got = Object.fromEntries(order.map((k, i) => [k, sy[i]]));
  const want = Object.fromEntries(order.map(k => [k, cleanRows(synth[SY[k]], 30, ref1, S, 10)]));
  const cleanApr = aprOf(want.clean.rows);
  // "Stays at the clean rate" = the clean validator's APR over the SAME epochs this one kept. Leaving
  // cells out reaches further back for the 30, and the network rate is not flat over the window:
  // comparing with the clean 30 broke on 2026-11-21 when the ledger window moved (CI #13).
  const cleanAll = cleanRows(synth[SY.clean], NE, ref1, S, 10);
  const cleanAt = Object.fromEntries(cleanAll.idx.map((i, j) => [i, cleanAll.rows[j]]));
  const cleanSame = (k) => aprOf(want[k].idx.map(i => cleanAt[i]));
  const matches = (k) => Math.abs(parseFloat(got[k].value) - aprOf(want[k].rows)) < 0.006 && got[k].dropped === want[k].dropped && got[k].epochs === want[k].rows.length;
  check(matches('clean') && got.clean.dropped === 0 && got.clean.epochs === 30, `steady stake → ${got.clean.value}, 30 epochs, nothing left out`, got.clean);
  check(matches('spike') && got.spike.dropped === 1 && Math.abs(parseFloat(got.spike.value) - cleanSame('spike')) < 0.05, `one cell recorded as 1 XNT → left out, tile ${got.spike.value} stays at the clean rate (${cleanSame('spike').toFixed(2)}%)`, { got: got.spike, want: aprOf(want.spike.rows), clean: cleanSame('spike') });
  check(matches('ramp') && got.ramp.dropped === 5 && Math.abs(parseFloat(got.ramp.value) - cleanSame('ramp')) < 0.05, `stake ramp shifted by one epoch → 5 understated cells left out, tile ${got.ramp.value}`, { got: got.ramp, want: aprOf(want.ramp.rows), clean: cleanSame('ramp') });
  check(matches('weak') && got.weak.dropped === 0 && parseFloat(got.weak.value) < cleanApr - 0.05, `a weak epoch on a steady stake is kept (tile ${got.weak.value} < ${cleanApr.toFixed(2)}%)`, { got: got.weak, want: aprOf(want.weak.rows) });
  check(matches('zero') && got.zero.dropped === 1 && Math.abs(parseFloat(got.zero.value) - cleanSame('zero')) < 0.05, `0 reward at 10% commission → left out, tile ${got.zero.value}`, { got: got.zero, want: aprOf(want.zero.rows), clean: cleanSame('zero') });
  check(matches('stamp') && got.stamp.dropped === 12 && got.stamp.epochs === 24 && Math.abs(parseFloat(got.stamp.value) - cleanSame('stamp')) < 0.05, `re-fetch stamp (12 identical, larger stakes) → left out, 24 epochs, tile ${got.stamp.value}`, { got: got.stamp, want: aprOf(want.stamp.rows), clean: cleanSame('stamp') });
  check(got.bad.value === '—' && /not enough clean epochs/.test(got.bad.sub) && got.bad.dropped === NE - 2, 'fewer than 3 clean epochs → — · stake changed · not enough clean epochs yet', got.bad);
  const modalText = async (vote) => {
    await page.click('.apr-section[data-vote="' + vote + '"] [data-action="apr-details"]'); await page.waitForTimeout(300);
    const t = await page.evaluate(() => ({ rows: [...document.querySelectorAll('#aprModal .apm-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()), body: document.getElementById('aprModalBody').textContent.replace(/\s+/g, ' ').trim() }));
    await page.keyboard.press('Escape'); await page.waitForTimeout(100);
    return t;
  };
  const mSpike = await modalText(SY.spike), mBad = await modalText(SY.bad), mClean = await modalText(SY.clean);
  check(mSpike.rows.some(r => /^Epochs left out\s*1\b/.test(r)) && !mClean.rows.some(r => /Epochs left out/.test(r)), 'modal: "Epochs left out 1" for the spiked validator, no such row for the clean one', mSpike.rows);
  check(/Not enough completed epochs/.test(mBad.body) && new RegExp((NE - 2) + ' epochs were left out').test(mBad.body), 'modal for the unusable validator says how many epochs were left out and why', mBad.body);
  // Whole served ledger: nothing above what the rule allows, and the comparison bars are sane (audit #7's gate)
  const whole = await page.evaluate((skip) => {
    const doc = window.RewardsLedger.doc, out = [];
    for (const vote of Object.keys(doc.validators)) {
      if (skip.includes(vote)) continue;
      const e = doc.validators[vote]; if (!e.st || !e.c) continue;
      const st = [...e.st].reverse().find(x => x != null), c = [...e.c].reverse().find(x => x != null);
      if (!(st >= 1000) || !(c > 0) || c >= 100) continue;
      const a = window.aprFor(vote, { stakeXnt: st, commission: c });
      if (a.long) out.push(a.long.netApr);
    }
    return { n: out.length, max: Math.max(...out), net: window.aprNetwork() };
  }, Object.values(SY));
  const ceiling = RATE_MAX * Math.max(...ref1.filter(x => x != null)) * EPY * 100;
  check(whole.n > 100 && whole.max <= ceiling, `served ledger: ${whole.n} validators, highest APR ${whole.max.toFixed(2)}% ≤ ${ceiling.toFixed(2)}% (1.25 × the network rate)`, whole);
  check(whole.net && whole.net.p90 <= 1.3 * whole.net.median, `network bars: top 10% ${whole.net && whole.net.p90.toFixed(2)}% within 1.3 × median ${whole.net && whole.net.median.toFixed(2)}%`, whole.net);

  // ── Credits method (audit #28): synthetic validators with `cr`, on the ledger's own (or an injected) `pv` ──
  const PVS = await page.evaluate((n) => { const doc = window.RewardsLedger.doc; if (!Array.isArray(doc.pv)) doc.pv = Array.from({ length: n }, (_, i) => 5.3e-11 + i * 1e-14); return doc.pv.slice(); }, NE);
  const pvGap = PVS.slice(); pvGap[last - 1] = null;            // used at the end: an epoch without a published rate
  const CY = { full: 'VoteCRFULLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', off: 'VoteCRoFFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', fresh: 'VoteCRNEWxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
               free: 'VoteCRFREExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', two: 'VoteCRTWoxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', wrongSt: 'VoteCRSTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' };
  const crEntry = (cr, c, st) => ({ w: null, self: [], v: new Array(NE).fill(123456789), st: st || steady.slice(), c: new Array(NE).fill(c), cr });
  const fullCr = Array.from({ length: NE }, (_, i) => 3400000 + i * 100);
  const csynth = {
    [CY.full]: crEntry(fullCr.slice(), 10),
    [CY.off]: crEntry(fullCr.map((x, i) => (i === last - 2 || i === last - 9 || i === last - 20) ? 0 : x), 10),     // offline for three whole epochs
    [CY.fresh]: crEntry(fullCr.map((x, i) => i < NE - 5 ? null : x), 10),                                             // first epoch on record five epochs ago
    [CY.free]: crEntry(fullCr.slice(), 0),                                                                           // 0 % commission
    [CY.two]: crEntry(fullCr.map((x, i) => i < NE - 2 ? null : x), 10),                                               // two epochs only
    [CY.wrongSt]: crEntry(fullCr.slice(), 10, new Array(NE).fill(1)),                                                // recorded stake of 1 XNT in every cell: must not matter
  };
  await page.evaluate((entries) => { Object.assign(window.RewardsLedger.doc.validators, entries); }, csynth);
  const corder = ['full', 'off', 'fresh', 'free', 'two', 'wrongSt'];
  await page.evaluate((cards) => { document.getElementById('validatorResults').innerHTML = cards.map(c => renderValidatorCard(c, true, false)).join(''); }, corder.map(k => mk(CY[k], 'Credits-' + k, S, k === 'free' ? 0 : 10)));
  await page.waitForTimeout(800);
  const cy = await page.evaluate((votes) => votes.map(v => {
    const t = document.querySelector('.apr-section[data-vote="' + v + '"]'), a = window.aprFor(v);
    return { value: t.querySelector('.stat-value').textContent, sub: (t.querySelector('.stat-subtext') || {}).textContent, epochs: a.long && a.long.epochs, offline: a.long && a.long.offline, method: a.long && a.long.method, gross: a.long && a.long.grossApr, net: a.long && a.long.netApr };
  }), corder.map(k => CY[k]));
  const cg = Object.fromEntries(corder.map((k, i) => [k, cy[i]]));
  const cw = Object.fromEntries(corder.map(k => [k, creditRows(csynth[CY[k]], 30, PVS, 10)]));
  const cmatch = (k) => Math.abs(parseFloat(cg[k].value) - aprOf(cw[k].rows)) < 0.006 && cg[k].epochs === cw[k].rows.length && cg[k].method === 'credits';
  const fullApr = aprOf(cw.full.rows);
  check(cmatch('full') && cg.full.sub === '30 ep · net of 10% fee', `credits: full credits → ${cg.full.value} = rate × credits × 0.9, "30 ep · net of 10% fee"`, { got: cg.full, want: fullApr });
  check(cmatch('off') && cg.off.offline === 3 && cg.off.sub === '30 ep · 3 offline · net of 10% fee' && parseFloat(cg.off.value) < fullApr * 0.92, `credits: three offline epochs count as 0% → ${cg.off.value}, "30 ep · 3 offline · net of 10% fee"`, { got: cg.off, want: aprOf(cw.off.rows) });
  check(cmatch('fresh') && cg.fresh.epochs === 5 && cg.fresh.offline === 0, `credits: epochs before the validator's first one are not counted (5 epochs, ${cg.fresh.value})`, cg.fresh);
  check(cmatch('free') && /no fee$/.test(cg.free.sub) && Math.abs(cg.free.net - cg.free.gross) < 1e-9 && parseFloat(cg.free.value) > fullApr, `credits: 0% commission → ${cg.free.value}, net = gross, "no fee"`, cg.free);
  check(cg.two.value === '—', 'credits: two epochs only → —', cg.two);
  check(cmatch('wrongSt') && Math.abs(parseFloat(cg.wrongSt.value) - fullApr) < 0.006, `credits: a recorded stake of 1 XNT in every cell changes nothing (${cg.wrongSt.value})`, cg.wrongSt);
  const mOff = await modalText(CY.off), mFull = await modalText(CY.full);
  check(mOff.rows.some(r => /^Epochs offline\s*3 of 30/.test(r)) && /counts as 0%/.test(mOff.body) && !mFull.rows.some(r => /Epochs offline/.test(r)) && !mFull.rows.some(r => /Active stake|Vote-account reward/.test(r)),
    'credits modal: "Epochs offline 3 of 30" + the 0% sentence only for the validator that was offline; no stake / reward rows', { off: mOff.rows, full: mFull.rows });
  const gap = await page.evaluate(({ v, pv }) => { const doc = window.RewardsLedger.doc, keep = doc.pv; doc.pv = pv; const a = window.aprFor(v); doc.pv = keep; return { epochs: a.long.epochs, last: a.long.last, first: a.long.first }; }, { v: CY.full, pv: pvGap });
  check(gap.epochs === 30 && gap.first === ledger.epochs[NE - 31], 'credits: an epoch without a published rate is skipped and the window reaches one epoch further back', gap);

  // Phone: modal hero stacks
  await page.setViewportSize({ width: 375, height: 812 });
  await page.click('#validatorResults .validator-card:nth-of-type(2) .apr-section [data-action="apr-details"]'); await page.waitForTimeout(400);
  const ph = await page.evaluate(() => ({ cols: getComputedStyle(document.querySelector('#aprModal .apm-hero')).gridTemplateColumns.split(' ').length, docW: document.documentElement.scrollWidth }));
  check(ph.cols === 1 && ph.docW === 375, 'phone: hero stacks, no sideways scroll', ph);

  check(pageErrors.length === 0, '0 page errors', pageErrors);
  check(warnings.length === 0, '0 [Actions] warnings', warnings);

  // ── Slow data (2026-11-18): a card rendered BEFORE the ledger arrives must fill in as soon as the
  // ledger is there, even while the delegation snapshot never answers and the RPC never answers the
  // slot-time measurement. The tile used to wait for all three together and stayed on "…".
  slow['/data/rewards.json'] = 2500; slow['/data/delegation.json'] = 'stall';
  const page2 = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  const pageErrors2 = []; page2.on('pageerror', e => pageErrors2.push(e.message));
  await page2.route(/^(?!http:\/\/127\.0\.0\.1)/, r => { if (/rpc\.mainnet\.x1\.xyz/.test(r.request().url())) return; return r.abort(); });   // RPC: never answered
  await page2.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page2.waitForFunction(() => typeof renderValidatorCard === 'function' && typeof window.aprHydrate === 'function', null, { timeout: 15000 });
  await page2.evaluate((v) => { document.getElementById('disclaimerModal').style.display = 'none'; document.getElementById('resultsSection').style.display = 'block'; document.getElementById('validatorResults').innerHTML = renderValidatorCard(v, true, false); }, mk(VOTE, NAME, STAKE_XNT, 10));
  const tileNow = () => page2.evaluate(() => ({ ledger: !!window.RewardsLedger.doc, value: document.querySelector('#validatorResults .apr-section .stat-value').textContent }));
  const early = await tileNow();
  await page2.waitForFunction(() => !!window.RewardsLedger.doc, null, { timeout: 15000 });
  await page2.waitForTimeout(500);
  const late = await tileNow();
  check(!early.ledger && early.value === '…', 'slow data: the card is on screen before the ledger, tile shows "…"', early);
  check(late.ledger && Math.abs(parseFloat(late.value) - exp30) < 0.006, `slow data: the tile fills (${late.value}) once the ledger is in, with the delegation snapshot and the RPC still unanswered`, late);
  check(pageErrors2.length === 0, 'slow data: 0 page errors', pageErrors2);

  // ── Late script (2026-11-18): a card can be on screen before js/apr.js has run, i.e. before this
  // module's MutationObserver exists. Until that day init() ran at the end of js/modals.js, five
  // scripts earlier; the site now starts from js/start.js, but a visitor with a cached older
  // modals.js still gets the old order. The module must pick up tiles that are already there.
  delete slow['/data/rewards.json']; delete slow['/data/delegation.json']; slow['/js/apr.js'] = 2500;
  const page3 = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  const pageErrors3 = []; page3.on('pageerror', e => pageErrors3.push(e.message));
  await page3.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
  await page3.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'commit' });
  await page3.waitForFunction(() => typeof renderValidatorCard === 'function' && typeof init === 'function' && !!document.getElementById('validatorResults'), null, { timeout: 15000 });
  const before3 = await page3.evaluate((v) => {
    const m = document.getElementById('disclaimerModal'); if (m) m.style.display = 'none';
    document.getElementById('resultsSection').style.display = 'block';
    document.getElementById('validatorResults').innerHTML = renderValidatorCard(v, true, false);
    return { aprLoaded: typeof window.aprHydrate === 'function', value: document.querySelector('#validatorResults .apr-section .stat-value').textContent };
  }, mk(VOTE, NAME, STAKE_XNT, 10));
  await page3.waitForFunction(() => typeof window.aprHydrate === 'function' && !!window.RewardsLedger.doc, null, { timeout: 15000 });
  await page3.waitForTimeout(800);
  const after3 = await page3.evaluate(() => document.querySelector('#validatorResults .apr-section .stat-value').textContent);
  check(!before3.aprLoaded && before3.value === '…', 'late script: the card is on screen before js/apr.js has loaded', before3);
  check(Math.abs(parseFloat(after3) - exp30) < 0.006, `late script: the tile fills (${after3}) once js/apr.js runs`, after3);
  check(pageErrors3.length === 0, 'late script: 0 page errors', pageErrors3);
  if (srv.closeAllConnections) srv.closeAllConnections();
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
