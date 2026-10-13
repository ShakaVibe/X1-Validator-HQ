// Offline smoke of the F11 Delegator APR tile + modal (js/apr.js, #aprModal):
// serve the repo, abort external requests, render real validator cards with
// renderValidatorCard(), let the ledger (data/rewards.json, same-origin) load
// and check: the card layout (4 + 4, APR in Earnings, Foundation delegation in
// Health, no Commission tile), the tile value against the same formula run in
// node over the served JSON, the 7-epoch trend pill, the Details modal (hero,
// network comparison, rows, close paths), the 100 % and 0 % commission paths,
// 0 inline handlers, 0 page errors, 0 [Actions] warnings.
//   node scripts/c2-tests/apr-test.js /path/to/repo
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
const terminal = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/terminal.json')));
const ti = Object.fromEntries(terminal.validatorFields.map((f, i) => [f, i]));
// Subject: the largest non-X1 validator at 10 % commission with 30 indexed epochs
const subject = terminal.validators
  .filter(r => !r[ti.x1Labs] && r[ti.commission] === 10 && ledger.validators[r[ti.votePubkey]] && ledger.validators[r[ti.votePubkey]].v.slice(-30).every(x => x != null))
  .sort((a, b) => b[ti.activatedStake] - a[ti.activatedStake])[0];
const VOTE = subject[ti.votePubkey], STAKE_XNT = subject[ti.activatedStake] / 1e9, NAME = subject[ti.name];
// Expected APR with the page's offline constants (216,000 slots × 0.368 s; no `st`/`c` in the ledger yet → current stake/commission)
const EPY = 365.25 * 86400 / (216000 * 0.368);
function expectedNet(n) {
  const e = ledger.validators[VOTE]; const rows = [];
  for (let i = ledger.epochs.length - 1; i >= 0 && rows.length < n; i--) { const v = e.v[i]; if (v == null) continue; const c = (e.c && e.c[i] != null) ? e.c[i] : 10; const st = (e.st && e.st[i] != null) ? e.st[i] : STAKE_XNT; rows.push((v / (c / 100)) / (st * 1e9) * (1 - c / 100)); }
  return rows.reduce((a, b) => a + b, 0) / rows.length * EPY * 100;
}
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
  const exp30 = expectedNet(30), exp7 = expectedNet(7);
  check(Math.abs(shown - exp30) < 0.006, `tile value ${card.value} matches the formula over the served ledger (${exp30.toFixed(2)}%)`, { shown, exp30 });
  check(/^30 ep · net of 10% fee$/.test(card.sub) && card.details, 'subtext: 30 ep · net of 10% fee + Details', card.sub);
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
  check(/reward ÷ 10%/.test(modal.foot) && /today's active stake/.test(modal.foot), 'footnote explains the method and the current-stake caveat', modal.foot);
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

  // Phone: modal hero stacks
  await page.setViewportSize({ width: 375, height: 812 });
  await page.click('#validatorResults .validator-card:nth-of-type(2) .apr-section [data-action="apr-details"]'); await page.waitForTimeout(400);
  const ph = await page.evaluate(() => ({ cols: getComputedStyle(document.querySelector('#aprModal .apm-hero')).gridTemplateColumns.split(' ').length, docW: document.documentElement.scrollWidth }));
  check(ph.cols === 1 && ph.docW === 375, 'phone: hero stacks, no sideways scroll', ph);

  check(pageErrors.length === 0, '0 page errors', pageErrors);
  check(warnings.length === 0, '0 [Actions] warnings', warnings);
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
