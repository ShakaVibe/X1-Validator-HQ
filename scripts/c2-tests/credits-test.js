// Offline smoke of Lifetime Credits (2026-10-27): voteCreditsSummary /
// getVoteCreditsMap (js/core.js), the two new Validator Terminal columns
// (js/terminal.js) and the 🏆 Lifetime Credits leaderboard + rank-by toggle
// (js/leaderboards.js). Serves the repo, aborts external requests, lets the
// served data/scores.json + data/terminal.json load and checks the numbers
// against the same rule run in node over the served JSON; sort by header click;
// toggle; "Where am I"; 375 px layout; 0 inline handlers, 0 page errors.
//   node scripts/c2-tests/credits-test.js /path/to/repo
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.argv[2] || '.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});

const scores = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/scores.json')));
const terminal = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/terminal.json')));
const ti = Object.fromEntries(terminal.validatorFields.map((f, i) => [f, i]));

// Independent re-implementation of the rule (see the comment in js/core.js)
function expected(vote) {
  const e = scores.validators[vote]; if (!e || !e.credits || !e.credits.length) return null;
  const c = e.credits, cur = scores.epoch, first = e.creditsFirstEpoch ?? c[0][0];
  let sum = 0, n = 0;
  for (let ep = cur - 7; ep < cur; ep++) {
    if (ep < first) continue;
    const row = c.find(r => r[0] === ep); sum += row ? row[1] - row[2] : 0; n++;
  }
  return { lifetime: c[c.length - 1][1], avg: n ? sum / n : null };
}

let fails = 0;
const check = (ok, label, extra) => { console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok || extra === undefined ? '' : ' — ' + JSON.stringify(extra))); if (!ok) fails++; };
const num = s => Number(String(s).replace(/[^0-9.]/g, ''));

(async () => {
  await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [], warnings = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { const t = m.text(); if (/\[Actions\]/.test(t)) warnings.push(t); });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
  await page.goto(`http://127.0.0.1:${port}/#/terminal`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { const m = document.getElementById('disclaimerModal'); if (m) m.style.display = 'none'; });

  // ── core helper ──
  const core = await page.evaluate(() => {
    const m = getVoteCreditsMap();
    // gap rule: entries for 416,418 only, first on record 410 → 417 and 419–422 count as 0
    const gap = voteCreditsSummary([[416, 110, 100], [418, 230, 200], [423, 240, 230]], 423, 410);
    // young account: first epoch 421 → only 421 and 422 count
    const young = voteCreditsSummary([[421, 3000000, 0], [422, 6400000, 3000000], [423, 7000000, 6400000]], 423, 421);
    return { size: m ? m.size : 0, gap, young, none: voteCreditsSummary([], 423) };
  });
  check(core.size === Object.values(scores.validators).filter(e => e.credits && e.credits.length).length, `getVoteCreditsMap has every validator with credits (${core.size})`);
  check(core.gap.lifetime === 240 && Math.abs(core.gap.avg - 40 / 7) < 1e-9 && core.gap.avgEpochs === 7, 'missed epochs count as 0 in the 7-epoch avg', core.gap);
  check(core.young.avgEpochs === 2 && core.young.avg === 3200000, 'epochs before the first on record do not count', core.young);
  check(core.none === null, 'empty history → null');

  // ── Terminal ──
  await page.waitForSelector('#vtTbl tbody tr', { timeout: 15000 });
  const term = await page.evaluate(() => {
    const ths = [...document.querySelectorAll('#vtTbl thead th')].map(t => t.textContent.trim());
    const rows = [...document.querySelectorAll('#vtTbl tbody tr')].map(tr => ({
      vote: tr.children[1].dataset.v, life: tr.children[13].textContent, lifeV: tr.children[13].dataset.v,
      avg: tr.children[14].textContent, avgV: tr.children[14].dataset.v, ver: tr.children[15].dataset.v, cc: tr.children[16].dataset.v, cells: tr.children.length
    }));
    return { ths, rows };
  });
  check(term.ths[13] === 'Life Credits' && term.ths[14] === 'Avg/Epoch' && term.ths[15] === 'Ver' && term.ths[16] === 'CC', 'Terminal headers: … Self % | Life Credits | Avg/Epoch | Ver | CC', term.ths);
  check(term.rows.every(r => r.cells === 17), 'every row has 17 cells');
  let mism = [];
  for (const r of term.rows) {
    const e = expected(r.vote);
    if (!e) { if (r.life !== '—') mism.push(r); continue; }
    if (num(r.life) !== e.lifetime || Math.abs(num(r.avg) - Math.round(e.avg)) > 0) mism.push({ r, e });
  }
  check(mism.length === 0, `Terminal cells match node over scores.json (${term.rows.length} rows, ${term.rows.filter(r => r.life === '—').length} without data)`, mism.slice(0, 3));
  const tv = terminal.validators.find(r => r[ti.votePubkey] === term.rows[0].vote);
  check(term.rows[0].ver === (tv[ti.version] || '') && term.rows[0].cc === (tv[ti.country] || ''), 'Ver / CC columns still carry the right data after the shift');

  // sort by Life Credits (click → desc), then Avg/Epoch
  for (const [col, key] of [[13, 'lifeV'], [14, 'avgV']]) {
    await page.click(`#vtTbl thead th[data-col="${col}"]`);
    const vals = await page.evaluate((c) => [...document.querySelectorAll('#vtTbl tbody tr')].map(tr => parseFloat(tr.children[c].dataset.v)), col);
    const sortedDesc = vals.every((v, i) => i === 0 || vals[i - 1] >= v);
    check(sortedDesc && vals[vals.length - 1] === -1 === term.rows.some(r => r[key] === '-1'), `click "${term.ths[col]}" sorts descending, no-data rows last`, vals.slice(0, 3));
  }
  const topTerm = await page.evaluate(() => document.querySelector('#vtTbl tbody tr').children[14].title);
  check(/last 7 completed epochs · \d+\.\d\d% of the 3,456,000 max/.test(topTerm), 'Avg/Epoch tooltip: window + % of max', topTerm);

  // ── Leaderboard ──
  const nonDust = terminal.validators.filter(r => !(r[ti.delinquent] && r[ti.activatedStake] < 100e9));
  const fake = nonDust.map((r, i) => ({ votePubkey: r[ti.votePubkey], nodePubkey: r[ti.nodePubkey], name: r[ti.name] || r[ti.votePubkey].slice(0, 8), activatedStake: r[ti.activatedStake], commission: r[ti.commission], delinquent: r[ti.delinquent], iconUrl: '', epochCredits: (scores.validators[r[ti.votePubkey]] || {}).credits || [], creditsFirstEpoch: (scores.validators[r[ti.votePubkey]] || {}).creditsFirstEpoch, performanceScore: (scores.validators[r[ti.votePubkey]] || {}).score || 0 }));
  const ranked = fake.filter(v => !v.delinquent).map(v => ({ v, e: expected(v.votePubkey) })).filter(x => x.e && x.e.lifetime > 0);
  const expLife = ranked.slice().sort((a, b) => (b.e.lifetime - a.e.lifetime) || ((b.e.avg ?? -1) - (a.e.avg ?? -1)));
  const expAvg = ranked.filter(x => x.e.avg !== null).sort((a, b) => ((b.e.avg ?? -1) - (a.e.avg ?? -1)) || (b.e.lifetime - a.e.lifetime));
  const mine = expLife[120].v.votePubkey; // outside the top 50 → pinned under "Where am I"
  await page.evaluate(({ fake, mine }) => {
    switchTab('leaderboard');
    leaderboardData = fake;
    allValidators = fake.map(v => ({ ...v }));
    myPortfolio = [mine];
    document.querySelector('#leaderboardLoading').style.display = 'none';
    document.querySelector('#leaderboardContainer').style.display = 'block';
  }, { fake, mine });
  await page.waitForTimeout(300);
  await page.click('.leaderboard-cat-btn[data-category="credits"]');
  await page.waitForTimeout(200);
  const readLb = () => page.evaluate(() => ({
    hash: location.hash,
    title: document.querySelector('#leaderboardHeader h2').textContent,
    controls: getComputedStyle(document.getElementById('creditsControls')).display,
    deleg: getComputedStyle(document.getElementById('delegationsControls')).display,
    active: [...document.querySelectorAll('#creditsControls button')].map(b => b.classList.contains('active')),
    items: [...document.querySelectorAll('#leaderboardList > .leaderboard-item')].filter(it => !it.previousElementSibling || !it.matches('.lb-mine-divider ~ .leaderboard-item')).map(it => ({ vote: it.dataset.vote, stats: [...it.querySelectorAll('.leaderboard-stat')].map(s => ({ v: s.querySelector('.leaderboard-stat-value').textContent.trim(), l: s.querySelector('.leaderboard-stat-label').textContent.trim(), hi: s.querySelector('.leaderboard-stat-value').classList.contains('highlight') })) })),
    pinned: [...document.querySelectorAll('#leaderboardList .lb-mine-divider ~ .leaderboard-item')].map(it => ({ vote: it.dataset.vote, rank: it.querySelector('.leaderboard-rank').textContent.trim() })),
    inline: document.querySelectorAll('#leaderboardTab [onclick], #creditsControls [onclick]').length
  }));
  let lb = await readLb();
  check(lb.hash === '#/leaderboard/credits' && lb.title === '🏆 Lifetime Credits', 'category button → #/leaderboard/credits + header', { hash: lb.hash, title: lb.title });
  check(lb.controls === 'flex' && lb.deleg === 'none' && lb.active[0] && !lb.active[1], 'rank-by toggle visible, "Lifetime total" active, delegations selector hidden', lb);
  check(lb.items.length === 50 && lb.items.every((it, i) => it.vote === expLife[i].v.votePubkey), 'top 50 in lifetime order (node)', lb.items.slice(0, 3).map(i => i.vote));
  const s0 = lb.items[0].stats;
  check(s0.map(s => s.l).join('|') === 'Lifetime Credits|Avg / Epoch|Stake' && s0[0].hi && !s0[1].hi && num(s0[0].v) === expLife[0].e.lifetime && num(s0[1].v) === Math.round(expLife[0].e.avg), 'row stats: Lifetime (highlighted) · Avg / Epoch · Stake, values match', s0);
  check(lb.pinned.length === 1 && lb.pinned[0].vote === mine && lb.pinned[0].rank === '#121', 'Where am I: portfolio validator at #121 pinned', lb.pinned);

  await page.click('#creditsControls button[data-credits-sort="avg"]');
  await page.waitForTimeout(150);
  lb = await readLb();
  check(!lb.active[0] && lb.active[1], 'toggle → "Avg per epoch" active');
  check(lb.items.every((it, i) => it.vote === expAvg[i].v.votePubkey) && lb.items[0].stats[1].hi && !lb.items[0].stats[0].hi, 'avg order (node) + Avg / Epoch highlighted', lb.items.slice(0, 3).map(i => [i.vote, i.stats[1].v]));
  await page.click('#creditsControls button[data-credits-sort="lifetime"]');
  await page.waitForTimeout(150);
  lb = await readLb();
  check(lb.items[0].vote === expLife[0].v.votePubkey && lb.active[0], 'toggle back → lifetime order');
  await page.click('.leaderboard-cat-btn[data-category="stake"]');
  lb = await readLb();
  check(lb.controls === 'none', 'other category hides the toggle');

  // deep link
  await page.evaluate(() => { location.hash = '#/leaderboard/credits'; });
  await page.waitForTimeout(300);
  lb = await readLb();
  check(lb.title === '🏆 Lifetime Credits' && lb.controls === 'flex', 'deep link #/leaderboard/credits opens the board');

  // 375 px: no row wider than the viewport, numbers not clipped
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(300);
  const phone = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const items = [...document.querySelectorAll('#leaderboardList > .leaderboard-item')].slice(0, 5);
    const bad = [];
    for (const it of items) {
      const r = it.getBoundingClientRect(); if (r.right > vw + 0.5 || r.left < -0.5) bad.push(['item', r.left, r.right]);
      for (const v of it.querySelectorAll('.leaderboard-stat-value')) { const b = v.getBoundingClientRect(); if (b.right > r.right + 0.5 || v.scrollWidth > v.clientWidth + 1) bad.push([v.textContent, b.right, r.right]); }
    }
    const t = document.getElementById('creditsControls').getBoundingClientRect();
    return { vw, bad, toggle: [t.left, t.right], docW: document.documentElement.scrollWidth };
  });
  check(phone.bad.length === 0 && phone.docW <= phone.vw && phone.toggle[1] <= phone.vw, '375 px: rows + toggle fit, no clipped numbers, no page scroll', phone);
  await page.evaluate(() => document.getElementById('creditsControls').scrollIntoView());
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || '/tmp', 'credits-lb-375.png') });
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.waitForTimeout(200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.querySelector('.leaderboard-categories').scrollIntoView());
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || '/tmp', 'credits-lb-1300.png') });
  await page.evaluate(() => { location.hash = '#/terminal'; });
  await page.waitForTimeout(500);
  await page.evaluate(() => { const w = document.querySelector('.vt-tbl-wrap'); w.scrollIntoView(); w.scrollLeft = w.scrollWidth; });
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || '/tmp', 'credits-terminal-1300.png') });

  check(lb.inline === 0, '0 inline handlers');
  check(pageErrors.length === 0, 'page errors: ' + JSON.stringify(pageErrors));
  check(warnings.length === 0, '[Actions] warnings: ' + JSON.stringify(warnings));
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
