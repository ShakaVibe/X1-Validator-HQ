// Offline test of the data-action conversion in js/cards.js.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = process.argv[2];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
(async () => {
  await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors = [], warns = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') warns.push(m.type() + ': ' + m.text()); });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
  await page.goto(`http://127.0.0.1:${port}/#/lookup/x`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const result = await page.evaluate(async (port) => {
    const dm = document.getElementById('disclaimerModal'); if (dm) dm.style.display = 'none';
    const rs = document.getElementById('resultsSection'); if (rs) rs.style.display = 'block';
    const calls = [];
    const spy = (name) => { window[name] = function (...a) { calls.push([name, a, this === window ? 'window' : (this && this.tagName)]); }; };
    ['addToPortfolio', 'removeFromPortfolio', 'toggleCredTooltip', 'openSlotModal', 'copyToClipboard', 'shareValidator', 'openManageValidator',
     'openRewardBreakdown', 'openStakeSelection', 'openDelegationModal', 'openPerfExplainerModal', 'toggleStakeDetails', 'toggleChart', 'switchChartType', 'selectLookupValidator'].forEach(spy);
    // Simulated "click outside" closer registered AFTER the dispatcher (like core.js's cred-tooltip closer).
    let outside = 0; document.addEventListener('click', () => outside++);
    window.networkFullEpochCredits = 1000; window.epochProgressRatio = 0.5;
    const name = 'Evil "<b>&\'name';   // hostile name to prove attribute escaping round-trips
    const v = { name, voteAccount: '5ar5xXjefcD2sXZmhExfg4Sur5CJfBKRCp2LmATvQNac', nodePubkey: 'nodeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB',
      rank: 13, totalValidators: 724, commission: 5, activatedStake: 1234567.5, rewardsBalance: 99.25, version: '4.0.3', isDelinquent: false, isZombie: false,
      skipRate: 0.4, epochCredits: 120000, performanceScore: 92, lastEpochEarned: 26.88, iconUrl: `http://127.0.0.1:${port}/does-not-exist.png`, epochCreditsHistory: [[380, 600, 100]] };
    const host = document.getElementById('validatorResults');
    host.innerHTML = renderValidatorCard(v, true, false) + renderValidatorCard(v, true, true) + lookupSlotHtml({ votePubkey: 'VoteXYZ1234567890', name: 'Slot guy', nodePubkey: 'n', activatedStake: 1e12, commission: 1, iconUrl: '' });
    await new Promise(r => setTimeout(r, 400)); // let the broken <img> fire error
    if (typeof delegRefresh === 'function') { try { await delegRefresh(); } catch (e) {} }
    await new Promise(r => setTimeout(r, 300));
    const [lk, dc] = host.querySelectorAll('.validator-card');
    const click = (root, sel) => { const el = root.querySelector(sel); if (!el) return calls.push(['MISSING', sel]); el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); };
    const outsideBefore = () => outside;
    let o;
    o = outside; click(lk, '.copy-address-btn');       const copyStoppedOutside = outside === o;
    o = outside; click(lk, '.share-icon-btn');         const shareReachedOutside = outside === o + 1;
    click(lk, '.add-btn'); click(dc, '.remove-btn'); click(lk, '.manage-validator-btn');
    click(lk, '.cred-pct-badge'); click(lk, '.vh-slot-explorer'); click(lk, '.rb-open-link');
    click(lk, '.stat-item.clickable-stat'); click(lk, '.perf-score-wrapper .stat-label'); // click on a child: must bubble to the tile
    click(lk, '.stake-details-btn'); click(dc, '.stake-details-btn');
    click(lk, '.validator-expand-btn:not(.stake-details-btn)'); click(dc, '.chart-toggle-btn[data-type="credits"]');
    click(host, '.lookup-slot .lookup-slot-main');
    o = outside; click(lk, '.deleg-section .rb-open-link'); const delegStoppedOutside = outside === o;
    const delegLink = lk.querySelector('.deleg-section .rb-open-link') ? lk.querySelector('.deleg-section .rb-open-link').outerHTML : 'none';
    const imgs = [...host.querySelectorAll('img.validator-logo')].map(i => [i.style.display, getComputedStyle(i.nextElementSibling).display]);
    const inlineLeft = host.innerHTML.match(/\son(click|error|change|input)=/g) || [];
    return { delegLink, delegStoppedOutside, calls, copyStoppedOutside, shareReachedOutside, imgs, inlineLeft: inlineLeft.length, nameOk: calls.filter(c => c[1].includes(name)).length };
  }, port);
  console.log(JSON.stringify(result, null, 1));
  console.log('page errors:', errors, '\nconsole warn/err:', warns.filter(w => !/net::ERR|Failed to load resource|ERR_FAILED/.test(w)));
  await browser.close(); srv.close();
})();
