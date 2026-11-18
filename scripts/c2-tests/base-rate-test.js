// Offline test of the BASE RATE (audit 2026-11-17 #9, js/core.js validatorBaseRatePct /
// networkBaseRatePct, fed by js/apr.js aprGross / aprNetworkGross).
// Stake Details, the staking and compound calculators and Manage Validator used to derive the
// rate 1 XNT earns per year as  past rewards ÷ (today's self-stake + today's delegated stake ×
// commission).  That is wrong whenever stake moved inside the window. The rate now comes from
// the vote credits in data/rewards.json (network rate per credit × credits earned), which needs
// no stake at all. This suite checks:
//   – the helper against a second implementation run in node over the served ledger
//     (7 and 30 epochs, an epoch with 0 credits counts as 0 %),
//   – the network figure (median validator) and its fallbacks (old flat 8 % as the last resort,
//     null for a validator / ledger without credits data so callers keep their own estimate),
//   – the staking calculator: with reward data that implies an absurd rate at today's stake
//     split (the stake-moved case) it still shows the credits-based base rate, and it falls back
//     to the old estimate for a validator without credits data,
//   – the calculators' custom-rate inputs default to the network rate instead of 8,
//   – visible labels say APR, not APY; 0 page errors, 0 [Actions] warnings.
//   node scripts/c2-tests/base-rate-test.js /path/to/repo
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.argv[2] || '.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});

const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/rewards.json')));
const NE = ledger.epochs.length;
const HAS_CREDITS = Array.isArray(ledger.pv) && Object.values(ledger.validators).some(e => Array.isArray(e.cr));

// Second implementation: mean of pv × cr over the newest n epochs that have both, per epoch (not yet annualised)
function grossPerEpoch(e, n, pv) {
  if (!Array.isArray(pv) || !e || !Array.isArray(e.cr)) return null;
  let sum = 0, used = 0;
  for (let i = NE - 1; i >= 0 && used < n; i--) { if (pv[i] == null || e.cr[i] == null) continue; sum += pv[i] * e.cr[i]; used++; }
  return used >= Math.min(3, n) ? sum / used : null;
}
const V_SYN = 'VoteSynSynSynSynSynSynSynSynSynSynSynSynSyn', V_OLD = 'VoteOldOldOldOldOldOldOldOldOldOldOldOldOld', V_OFF = 'VoteOffOffOffOffOffOffOffOffOffOffOffOffOff';

let fails = 0;
const check = (ok, label, extra) => { console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok || extra === undefined ? '' : ' — ' + JSON.stringify(extra))); if (!ok) fails++; };
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= (tol || 1e-9) * Math.max(1, Math.abs(b));

(async () => {
  await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  const pageErrors = [], warnings = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { const t = m.text(); if (/\[Actions\]/.test(t)) warnings.push(t); });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.evaluate(async () => { const m = document.getElementById('disclaimerModal'); if (m) m.style.display = 'none'; await window.RewardsLedger.load(); });
  await page.waitForTimeout(300);

  check(await page.evaluate(() => typeof validatorBaseRatePct === 'function' && typeof networkBaseRatePct === 'function' && typeof window.aprGross === 'function' && typeof window.aprNetworkGross === 'function'),
    'validatorBaseRatePct / networkBaseRatePct (core) and aprGross / aprNetworkGross (apr) exist');
  const EPY = await page.evaluate(() => epochsPerYear());
  check(EPY > 350 && EPY < 450, 'epochs per year from the page is plausible (' + EPY.toFixed(1) + ')', EPY);

  // ── Synthetic ledger columns so the suite does not depend on what the served ledger carries ──
  // pv: the served one when present, else a flat value (≈ 7.5 % a year at 16 credits per slot)
  const pvSyn = HAS_CREDITS ? ledger.pv.slice() : new Array(NE).fill(0.075 / EPY / (216000 * 16));
  const pvLast = pvSyn.filter(x => x != null).pop();
  const pvFilled = pvSyn.map(x => x == null ? pvLast : x);
  const FULL = 216000 * 16 * 0.97;                                   // a healthy validator's credits per epoch
  const crSyn = new Array(NE).fill(Math.round(FULL));
  const crOff = crSyn.map((c, i) => (i >= NE - 7 && i % 2 === 0) ? 0 : c);   // offline in some of the newest 7 epochs
  await page.evaluate(({ pv, V_SYN, V_OLD, V_OFF, crSyn, crOff }) => {
    const doc = window.RewardsLedger.doc, n = doc.epochs.length;
    doc.pv = pv;
    doc.validators[V_SYN] = { w: null, self: [], v: new Array(n).fill(5e9), c: new Array(n).fill(10), cr: crSyn };
    doc.validators[V_OFF] = { w: null, self: [], v: new Array(n).fill(5e9), c: new Array(n).fill(10), cr: crOff };
    doc.validators[V_OLD] = { w: null, self: [], v: new Array(n).fill(5e9), c: new Array(n).fill(10) };   // no credits data
    doc.generatedAt = doc.generatedAt + ' ';                           // invalidate apr.js's per-document caches
  }, { pv: pvFilled, V_SYN, V_OLD, V_OFF, crSyn, crOff });

  // ── Helper vs second implementation ──
  const got = await page.evaluate(({ V_SYN, V_OLD, V_OFF }) => ({
    syn7: validatorBaseRatePct(V_SYN, 7), syn30: validatorBaseRatePct(V_SYN, 30),
    off7: validatorBaseRatePct(V_OFF, 7), off30: validatorBaseRatePct(V_OFF, 30),
    old7: validatorBaseRatePct(V_OLD, 7), unknown: validatorBaseRatePct('NoSuchVote', 7),
    net: networkBaseRatePct(), netRaw: window.aprNetworkGross(),
  }), { V_SYN, V_OLD, V_OFF });
  const exp = (cr, n) => grossPerEpoch({ cr }, n, pvFilled) * EPY * 100;
  check(near(got.syn7, exp(crSyn, 7), 1e-9) && near(got.syn30, exp(crSyn, 30), 1e-9), `steady validator: 7 ep ${got.syn7 && got.syn7.toFixed(3)} %, 30 ep ${got.syn30 && got.syn30.toFixed(3)} % = pv × credits × epochs/yr`, { got, e7: exp(crSyn, 7), e30: exp(crSyn, 30) });
  check(got.syn7 > 2 && got.syn7 < 25, 'the steady validator\'s rate is in a plausible range', got.syn7);
  check(near(got.off7, exp(crOff, 7), 1e-9) && got.off7 < got.syn7 * 0.75 && near(got.off30, exp(crOff, 30), 1e-9) && got.off30 > got.off7,
    `offline epochs count as 0 %: 7 ep ${got.off7 && got.off7.toFixed(3)} % < 30 ep ${got.off30 && got.off30.toFixed(3)} % < steady`, got);
  check(got.old7 === null && got.unknown === null, 'no credits data / unknown validator → null (caller keeps its own estimate)', got);

  // Real validators of the served ledger (only when it carries credits)
  if (HAS_CREDITS) {
    const votes = Object.keys(ledger.validators).filter(v => Array.isArray(ledger.validators[v].cr)).slice(0, 40);
    const page7 = await page.evaluate((vs) => vs.map(v => validatorBaseRatePct(v, 7)), votes);
    const bad = votes.filter((v, i) => { const e = grossPerEpoch(ledger.validators[v], 7, pvFilled); return e == null ? page7[i] !== null : !near(page7[i], e * EPY * 100, 1e-9); });
    check(bad.length === 0, votes.length + ' real validators of the served ledger match the second implementation', bad.slice(0, 3));
  } else check(true, 'served ledger has no credits columns — real-validator comparison skipped');

  // Network figure: the median over all validators with a positive rate
  const all = Object.entries(Object.assign({}, ledger.validators, { [V_SYN]: { cr: crSyn }, [V_OFF]: { cr: crOff }, [V_OLD]: {} }))
    .map(([, e]) => grossPerEpoch(e, 7, pvFilled)).filter(x => x > 0).map(x => x * EPY * 100).sort((a, b) => a - b);
  const expNet = all.length >= 10 ? all[all.length >> 1] : null;
  if (expNet != null) check(near(got.netRaw, expNet, 1e-9) && near(got.net, expNet, 1e-9) && got.net > 2 && got.net < 25, `network base rate ${got.net.toFixed(3)} % = the median of ${all.length} validators`, { got: got.netRaw, expNet });
  else check(got.netRaw === null && got.net === 8, 'fewer than 10 validators with credits → no network figure, flat 8 % as the last resort', got);
  const fb = await page.evaluate(() => { const keep = window.aprNetworkGross; window.aprNetworkGross = () => null; const a = networkBaseRatePct(); window.aprNetworkGross = () => { throw new Error('x'); }; const b = networkBaseRatePct(); window.aprNetworkGross = keep; return [a, b]; });
  check(fb[0] === 8 && fb[1] === 8, 'network figure unavailable (or throwing) → the old flat 8 %', fb);

  // ── Staking calculator: the stake-moved case ──
  // Reward data says 400 XNT per epoch; today's split is 1,000 self + 0 delegated, so the old
  // formula would call that a base rate of 400 × epochs/yr ÷ 1,000 ≈ 15,900 %.
  const calc = async (vote) => page.evaluate(({ vote }) => {
    const sel = document.getElementById('stakingValidator');
    if (![...sel.options].some(o => o.value === vote)) sel.add(new Option('Synthetic', vote));
    sel.value = vote;
    stakingCalcData = { currentStake: 1000, commission: 10, selfStake: 1000, delegatedStake: 0, hasBreakdown: true, validatorName: 'Synthetic' };
    stakingRealRewardsData = { avgEpoch: 400, totalFetched: 2800, epochs: 7, actualAPY: 400 * epochsPerYear() / 1000 * 100 };
    renderStakingResults();
    const box = document.getElementById('stakingResultsContent');
    const label = [...box.querySelectorAll('.calc-earnings-label')].map(e => e.textContent.trim()).find(t => /From Self-Stake/.test(t)) || '';
    return { label, text: box.textContent.replace(/\s+/g, ' ') };
  }, { vote });
  const cSyn = await calc(V_SYN), cOld = await calc(V_OLD);
  const shown = (l) => { const m = /\(([\d.,]+)% base rate\)/.exec(l); return m ? parseFloat(m[1].replace(/,/g, '')) : null; };
  check(near(shown(cSyn.label), +exp(crSyn, 7).toFixed(2), 1e-9), `staking calculator, stake moved: base rate shown ${shown(cSyn.label)} % = the credits rate, not the ${(400 * EPY / 1000 * 100).toFixed(0)} % that today's stake would imply`, cSyn.label);
  check(shown(cOld.label) > 1000, 'validator without credits data: the calculator keeps the old estimate (' + shown(cOld.label) + ' %)', cOld.label);
  check(/Validator APR/.test(cSyn.text) && !/APY/.test(cSyn.text) && /Rates from on-chain reward data \(last 7 epochs\)/.test(cSyn.text), 'calculator output says APR and "last 7 epochs", never APY', cSyn.text.slice(0, 300));

  // ── Custom-rate inputs default to the network rate instead of a flat 8 ──
  const inputs = await page.evaluate(() => ['stakingApy', 'compoundAPY'].map(id => { const el = document.getElementById(id); return el ? el.value : null; }));
  if (HAS_CREDITS) {
    const served = Object.values(ledger.validators).map(e => grossPerEpoch(e, 7, ledger.pv)).filter(x => x > 0).map(x => x * EPY * 100).sort((a, b) => a - b);
    const want = served[served.length >> 1].toFixed(1);
    check(inputs[0] === want && inputs[1] === want, `custom-rate inputs start at the network rate (${want} %), not 8`, inputs);
    // A visitor who typed a rate before the ledger arrived keeps it: second page, ledger delayed by 1.5 s
    const page2 = await (await browser.newContext()).newPage();
    await page2.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
    await page2.route(/data\/rewards\.json/, async r => { await new Promise(z => setTimeout(z, 1500)); r.continue(); });
    await page2.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page2.waitForTimeout(400);
    const before = await page2.evaluate(() => { const a = document.getElementById('stakingApy'); const v = [a.value, document.getElementById('compoundAPY').value]; a.value = '10'; return v; });
    await page2.waitForTimeout(3000);
    const after = await page2.evaluate(() => [document.getElementById('stakingApy').value, document.getElementById('compoundAPY').value]);
    check(before[0] === '8' && before[1] === '8' && after[0] === '10' && after[1] === want, 'a rate typed before the ledger arrived is kept (10), the untouched input still gets the network rate', { before, after });
    await page2.close();
  } else check(inputs[0] === '8' && inputs[1] === '8', 'no credits in the served ledger → the inputs keep their 8 % default', inputs);

  // ── Labels in the page ──
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const visibleApy = (html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, ' ').match(/[^.\n]{0,40}\bAPY\b[^.\n]{0,40}/g) || []);
  check(visibleApy.length === 0, 'index.html has no visible "APY" text', visibleApy.slice(0, 3));
  const jsApy = ['calculators.js', 'card-details.js', 'manage.js'].flatMap(f => (fs.readFileSync(path.join(ROOT, 'js', f), 'utf8').split('\n')
    .filter(l => !/^\s*\/\//.test(l) && />[^<`]*\bAPY\b[^<`]*</.test(l)).map(l => f + ': ' + l.trim().slice(0, 90))));
  check(jsApy.length === 0, 'no "APY" in text the calculators / Stake Details / Manage Validator render', jsApy.slice(0, 3));

  check(pageErrors.length === 0, '0 page errors', pageErrors);
  check(warnings.length === 0, '0 [Actions] warnings', warnings);
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
