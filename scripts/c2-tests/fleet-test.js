// Offline smoke of the F4 Fleet Health bar + table (js/fleet.js, #fleetHealth):
// serve the repo, abort external requests, open My Data Center, feed fleetRender()
// three validators (two real vote keys that exist in data/delegation.json, one
// made-up delinquent node on an old version) and check: severity sorting, the
// bar text / chips, Details toggle + localStorage memory, chip filters, row →
// lookupValidator through the dispatcher, the phone layout, 0 inline handlers,
// 0 page errors, 0 [Actions] warnings.
//   node scripts/c2-tests/fleet-test.js /path/to/repo
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

// Two real vote accounts (present in data/delegation.json + data/rewards.json) and one invented.
const deleg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/delegation.json')));
const approved = Object.entries(deleg.validators).filter(([, v]) => v.st === 'Approved' && !(v.fc || []).length && !v.dq && Number(v.ds) > 0 && v.ls > 50).sort((a, b) => Number(b[1].ds) - Number(a[1].ds));
const [V_OK, OK_REC] = approved[0], [V_SKIP, SKIP_REC] = approved[1];
const V_BAD = 'Vote22222222222222222222222222222222222222';
const minVer = deleg.config.minValidatorVersion;
const mk = (vote, name, extra) => Object.assign({ voteAccount: vote, nodePubkey: 'node-' + name, name, commission: 10, activatedStake: 100000, rewardsBalance: 1, isDelinquent: false, version: minVer, performanceScore: 97.5, skipRate: 0, epochCredits: 1, epochCreditsHistory: [], iconUrl: '' }, extra);
const VALIDATORS = [
  mk(V_OK,   'Zed_Healthy', {}),                                                   // z-name: must still sort by severity, not name
  mk(V_BAD,  'Bad_Node',    { isDelinquent: true, version: '3.1.14', performanceScore: 61.4, skipRate: null }),
  mk(V_SKIP, 'Mid_Skipper', { skipRate: Number(deleg.cluster.skipRatePct) + 1.5 }),  // over the cluster rate, under the Program limit
];

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
  // (the init script runs on every load — clear the remembered open state only once, so the reload check below is real)
  await page.addInitScript((votes) => { try { localStorage.setItem('x1Portfolio', JSON.stringify(votes)); if (!sessionStorage.getItem('fleetTestInit')) { localStorage.removeItem('x1FleetOpen'); sessionStorage.setItem('fleetTestInit', '1'); } } catch (e) {} }, VALIDATORS.map(v => v.voteAccount));

  await page.goto(`http://127.0.0.1:${port}/#/datacenter`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { const m = document.getElementById('disclaimerModal'); if (m) m.style.display = 'none'; });

  check(await page.evaluate(() => Actions.has('fleet-toggle') && Actions.has('fleet-filter') && Actions.has('fleet-row')), 'fleet actions registered');
  check(await page.evaluate(() => typeof window.fleetRender === 'function' && typeof window.fleetRefresh === 'function' && typeof window.delegLoad === 'function'), 'fleetRender / fleetRefresh / delegLoad exposed');

  // The RPC is blocked offline, so loadPortfolio() cannot build the validator
  // objects — hand fleetRender() the same shape it would get, after the
  // Delegation Program snapshot (same-origin, served) has loaded.
  await page.evaluate(async (vals) => {
    window.__lookups = []; window.lookupValidator = (v) => window.__lookups.push(v);
    document.getElementById('emptyPortfolio').style.display = 'none';
    document.getElementById('portfolioResults').style.display = 'block';
    try { await window.delegLoad(); } catch (e) {}
    try { await window.RewardsLedger.load(); } catch (e) {}
    window.fleetRender(vals);
  }, VALIDATORS);
  await page.waitForTimeout(200);

  const s1 = await page.evaluate(() => {
    const bar = document.getElementById('fleetBar'), board = document.getElementById('fleetBoard');
    return {
      bar: !!bar, cls: bar && bar.className, text: bar && bar.querySelector('.fleet-bar-text').textContent,
      chips: bar ? [...bar.querySelectorAll('.fleet-chip')].map(c => c.textContent.replace(/\s+/g, ' ').trim()) : [],
      btn: bar && bar.querySelector('.fleet-bar-btn').textContent.trim(),
      hidden: board ? board.hidden : null,
      order: board ? [...board.querySelectorAll('tbody tr')].map(tr => tr.className + ':' + tr.querySelector('.fleet-name-text').firstChild.textContent) : [],
      inline: document.querySelectorAll('#fleetHealth [onclick], #fleetHealth [onerror], #fleetHealth [onchange]').length,
      issues: board ? [...board.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('.fleet-issue')].map(i => i.textContent)) : [],
      deleg: board ? [...board.querySelectorAll('tbody tr td:nth-child(6)')].map(td => td.textContent.trim()) : [],
      earned: board ? [...board.querySelectorAll('tbody tr td:nth-child(8)')].map(td => td.textContent.trim()) : [],
    };
  });
  check(s1.bar && /has-crit/.test(s1.cls), 'bar renders with the critical (red) border', s1.cls);
  check(await page.evaluate(() => document.getElementById('fleetBoard').classList.contains('has-crit') && getComputedStyle(document.getElementById('fleetBar'), '::before').content === 'none'), 'table border follows the bar state; no left edge stripe');
  check(s1.hidden === true && /Details/.test(s1.btn), 'table hidden by default, button says Details', { hidden: s1.hidden, btn: s1.btn });
  check(/Bad_Node is delinquent/.test(s1.text) && /Mid_Skipper skipped/.test(s1.text) && /1 healthy/.test(s1.text), 'bar text names the problems, then the healthy count', s1.text);
  check(s1.chips.join('|') === 'Critical 1|Watch 1|Healthy 1', 'chips: Critical 1 · Watch 1 · Healthy 1', s1.chips);
  check(s1.order.join(',') === 'sev-crit:Bad_Node,sev-warn:Mid_Skipper,sev-ok:Zed_Healthy', 'rows sorted critical → watch → healthy (not by name)', s1.order);
  check(s1.issues[0].some(t => /Delinquent/.test(t)) && s1.issues[0].some(t => new RegExp('3\\.1\\.14.*below the Foundation minimum ' + minVer.replace(/\./g, '\\.')).test(t)), 'critical row lists delinquency + version lines', s1.issues[0]);
  check(s1.issues[1].length === 1 && /Skipped .* this epoch/.test(s1.issues[1][0]) && /cluster/.test(s1.issues[1][0]), 'watch row has exactly the skip line with the cluster rate', s1.issues[1]);
  check(s1.issues[2].length === 1 && /No issues/.test(s1.issues[2][0]), 'healthy row says No issues', s1.issues[2]);
  check(/Approved/.test(s1.deleg[2]) && /XNT delegated/.test(s1.deleg[2]) && /Not enrolled/.test(s1.deleg[0]), 'Delegation column: snapshot status for real keys, Not enrolled for the unknown one', s1.deleg);
  check(/^\d[\d,]*\.\d\d/.test(s1.earned[2]) && /#\d+/.test(s1.earned[2]), 'Earned · epoch filled from the ledger for a real key', s1.earned);
  check(s1.inline === 0, '0 inline handlers in #fleetHealth');

  // Details toggle + memory
  await page.click('#fleetBar .fleet-bar-btn');
  await page.waitForTimeout(100);
  const s2 = await page.evaluate(() => ({ hidden: document.getElementById('fleetBoard').hidden, btn: document.querySelector('#fleetBar .fleet-bar-btn').textContent.trim(), ls: localStorage.getItem('x1FleetOpen'), open: document.getElementById('fleetBar').classList.contains('open') }));
  check(s2.hidden === false && /Hide/.test(s2.btn) && s2.ls === '1' && s2.open, 'Details opens the table, button → Hide, state remembered', s2);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.evaluate(async (vals) => { const m = document.getElementById('disclaimerModal'); if (m) m.style.display = 'none'; window.__lookups = []; window.lookupValidator = (v) => window.__lookups.push(v); document.getElementById('emptyPortfolio').style.display = 'none'; document.getElementById('portfolioResults').style.display = 'block'; try { await window.delegLoad(); } catch (e) {} window.fleetRender(vals); }, VALIDATORS);
  check((await page.evaluate(() => document.getElementById('fleetBoard').hidden)) === false, 'reload keeps the table open');

  // Chip filter: Critical → one row; again → all
  await page.click('#fleetBar .fleet-chip.crit');
  await page.waitForTimeout(100);
  const f1 = await page.evaluate(() => ({ rows: document.querySelectorAll('#fleetBoard tbody tr').length, active: (document.querySelector('#fleetBar .fleet-chip.active') || {}).className }));
  check(f1.rows === 1 && /crit/.test(f1.active), 'Critical chip filters to the one critical row', f1);
  await page.click('#fleetBar .fleet-chip.crit');
  await page.waitForTimeout(100);
  check((await page.evaluate(() => document.querySelectorAll('#fleetBoard tbody tr').length)) === 3, 'clicking the chip again shows all rows');

  // Row click → lookupValidator(vote) through the dispatcher (click lands on a child element)
  await page.click('#fleetBoard tbody tr.sev-warn .fleet-issue');
  await page.waitForTimeout(100);
  check((await page.evaluate(() => window.__lookups)).join() === V_SKIP, 'row click → lookupValidator with that row\'s vote', await page.evaluate(() => window.__lookups));
  // Keyboard: Enter on a focused row
  await page.focus('#fleetBoard tbody tr.sev-crit');
  await page.keyboard.press('Enter');
  check((await page.evaluate(() => window.__lookups)).slice(-1)[0] === V_BAD, 'Enter on a focused row opens it');

  // All-healthy variant: one validator, nothing wrong
  await page.evaluate((v) => window.fleetRender([v]), VALIDATORS[0]);
  const q = await page.evaluate(() => ({ cls: document.getElementById('fleetBar').className, text: document.getElementById('fleetBar').querySelector('.fleet-bar-text').textContent, chips: [...document.querySelectorAll('#fleetBar .fleet-chip')].map(c => c.textContent.replace(/\s+/g, ' ').trim()) }));
  check(!/has-crit|has-warn/.test(q.cls) && /All 1 healthy/.test(q.text) && q.chips.join('|') === 'Healthy 1', 'all-healthy: green border, quiet text, single chip', q);
  // Empty portfolio → nothing rendered
  await page.evaluate(() => window.fleetRender([]));
  check((await page.evaluate(() => document.getElementById('fleetHealth').innerHTML)) === '', 'empty portfolio renders nothing');

  // Phone layout
  await page.evaluate((vals) => window.fleetRender(vals), VALIDATORS);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(200);
  const ph = await page.evaluate(() => {
    const tbl = document.querySelector('#fleetBoard .fleet-tbl-wrap'), cards = document.querySelector('#fleetBoard .fleet-cards');
    return { tbl: getComputedStyle(tbl).display, cards: getComputedStyle(cards).display, n: cards.querySelectorAll('.fleet-card').length, docW: document.documentElement.scrollWidth, barH: document.getElementById('fleetBar').getBoundingClientRect().height };
  });
  check(ph.tbl === 'none' && ph.cards === 'flex' && ph.n === 3 && ph.docW === 375, 'phone: table hidden, 3 stacked cards, no sideways scroll', ph);

  check(pageErrors.length === 0, '0 page errors', pageErrors);
  check(warnings.length === 0, '0 [Actions] warnings', warnings);
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
