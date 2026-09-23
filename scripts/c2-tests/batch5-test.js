// Offline test of C2 batch 5: the last inline handlers in js/*.js (compare, terminal,
// forensics, calculators, wallet-tx, network-live) plus the main tab buttons and the
// calculator nav buttons in index.html (and the Router/switchTab/switchCalculator
// selectors that used to match their onclick text).
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.argv[2] || '.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
let block404 = new Set();
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (block404.has(p) || !f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(f);
  // Test seam: expose Forensics' private state and renderers (served copy only).
  if (p === '/js/forensics.js') {
    const s = body.toString(), hook = 'window.vpRenderTable = renderTable;';
    if (!s.includes(hook)) { res.writeHead(500); return res.end('seam not found'); }
    body = s.replace(hook, hook + ' window.__vp = { S, recomputeAndRender, renderCharts, renderTable };');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(body);
});
const INLINE = /(^|[\s"'`])on(click|error|change|input|mousedown|mouseenter|mouseleave|load)=/g;

async function newPage(browser, errors, warns) {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/\[Actions\]/.test(m.text())) warns.push(m.type() + ': ' + m.text()); });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
  return page;
}

(async () => {
  await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const browser = await chromium.launch();
  const errors = [], warns = [];
  const page = await newPage(browser, errors, warns);
  await page.goto(`http://127.0.0.1:${port}/#/live`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const result = await page.evaluate(async (port) => {
    const out = {}; const calls = [];
    const argOf = (x) => x instanceof Element ? '<' + x.tagName + '>' : x;
    const spy = (name) => { const orig = window[name]; window[name] = function (...a) { calls.push([name, ...a.map(argOf)]); }; return orig; };
    const click = (el) => { if (!el) { calls.push(['MISSING ELEMENT']); return; } el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); };
    const inline = (el) => el ? (el.innerHTML.match(/(^|[\s"'`])on(click|error|change|input|mousedown|mouseenter|mouseleave|load)=/g) || []).length : 'missing';
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const NAME = 'Evil "<b>&\'name', V1 = '5ar5xXjefcD2sXZmhExfg4Sur5CJfBKRCp2LmATvQNac', BROKEN = `http://127.0.0.1:${port}/broken.png`;
    const dm = document.getElementById('disclaimerModal'); if (dm) dm.style.display = 'none';
    try {
      out.unregistered = ['tab', 'calc-nav', 'compare-add', 'compare-remove', 'vt-refresh-live', 'vt-retry', 'vp-open-probe', 'vp-filter-to',
        'vp-sort', 'vp-copy', 'calc-open-breakdown', 'calc-fetch-breakdown', 'calc-period', 'wallet-install-close', 'wallet-select',
        'wallet-select-close', 'leader-lookup'].filter(n => !Actions.has(n));
      const mkV = (i) => ({ name: i === 0 ? NAME : 'Val ' + i, votePubkey: i === 0 ? V1 : 'Vote' + String(i).padStart(40, 'x'), nodePubkey: 'Node' + String(i).padStart(40, 'y'),
        iconUrl: i % 2 ? BROKEN : '', performanceScore: 90 - i, activatedStake: (1e6 - i) * 1e9, commission: 5, delinquent: false, skipRate: 0.5 });
      allValidators = Array.from({ length: 12 }, (_, i) => mkV(i));

      // ── 1. main tabs + calculator nav (index.html) ──
      out.tabInline = inline(document.querySelector('.tabs'));
      out.tabs = [...document.querySelectorAll('.tab[data-action="tab"]')].map(b => b.dataset.tab).join(',');
      window.loadLeaderboard = async () => {};
      click(document.querySelector('.tab[data-tab="leaderboard"] .tab-label'));   // child click bubbles to the button
      out.tabActive = (document.querySelector('.tab.active') || {}).dataset?.tab + ' / ' + (document.querySelector('.tab-content.active') || {}).id;
      click(document.querySelector('.tab[data-tab="calculators"]'));
      out.calcNavInline = inline(document.querySelector('.calc-nav-btn').parentElement);
      click(document.querySelector('.calc-nav-btn[data-calc="breakeven"]'));
      out.calcActive = (document.querySelector('.calc-nav-btn.active') || {}).dataset?.calc + ' ' + location.hash;

      // ── 2. compare ──
      switchTab('compare');
      const cin = document.getElementById('compareSearchInput');
      cin.value = 'Val'; handleCompareSearch();
      const cres = document.getElementById('compareSearchResults');
      compareValidators = [allValidators[0], allValidators[1]]; renderComparison();
      out.compareSlotsInline = [0, 1, 2, 3].map(i => inline(document.getElementById('compareSlot' + i))).reduce((a, b) => a + b, 0);   // slot contents only (the slots' own onclick is static index.html)
      await sleep(400);
      out.compareFallback = [...document.querySelectorAll('#compareSlot1 img, #compareSearchResults img')].filter(i => i.style.display === 'none' && i.nextElementSibling.style.display === '').length;
      out.compareResults = cres.querySelectorAll('[data-action="compare-add"]').length; out.compareSearchInline = inline(cres);
      spy('addToComparison'); spy('removeFromComparison');
      click(cres.querySelector('[data-action="compare-add"] .compare-search-result-name'));
      click(document.querySelector('#compareSlot0 .compare-slot-remove'));

      // ── 3. calculators: staking breakdown links + projection toggle ──
      switchTab('calculators'); switchCalculator('staking');
      const sel = document.getElementById('stakingValidator');
      const opt = document.createElement('option'); opt.value = V1; opt.textContent = 'x'; sel.appendChild(opt); sel.value = V1;
      window.fetchTotalValidatorRewards = async () => Array.from({ length: 7 }, (_, i) => ({ epoch: 380 + i, amount: 50e9 }));
      window.stakeBreakdownData = { [V1]: { selfStake: 5000, delegatedStake: 995000 } };
      await onStakingValidatorChange();
      const cs = document.getElementById('stakingCurrentStake');
      out.calcBreakdownLink = cs.querySelector('[data-action="calc-open-breakdown"]') ? 'ok' : cs.innerHTML.slice(0, 120);
      out.calcCsInline = inline(cs);
      spy('openStakeBreakdown'); click(cs.querySelector('[data-action="calc-open-breakdown"]'));
      window.stakeBreakdownData = {}; window.fetchStakeBreakdownForCalc = async () => null;
      await onStakingValidatorChange();
      spy('fetchAndShowBreakdown'); click(cs.querySelector('[data-action="calc-fetch-breakdown"]'));
      document.querySelectorAll('#stakingSimInputs input').forEach(i => { i.value = '1000'; });
      renderStakingResults();
      const rc = document.getElementById('stakingResultsContent');
      out.calcPeriodBtns = rc.querySelectorAll('[data-action="calc-period"]').length; out.calcResultsInline = inline(rc);
      click(rc.querySelector('[data-action="calc-period"][data-period="monthly"]'));
      out.periodAfterClick = stakingProjectionPeriod + ' / monthly btn active: ' + !!document.querySelector('#stakingResultsContent .calc-toggle-btn.active[data-period="monthly"]');

      // ── 4. wallet modals ──
      showWalletSelectModal([{ name: 'Backpack', icon: '🎒' }, { name: 'X1 Wallet', icon: 'x1-logo' }]);
      const wsm = document.getElementById('walletSelectModal'); out.walletSelectInline = inline(wsm);
      spy('selectWallet'); click(wsm.querySelector('[data-action="wallet-select"][data-wallet="X1 Wallet"] span'));
      click(wsm.querySelector('[data-action="wallet-select-close"]')); out.walletSelectClosed = !document.getElementById('walletSelectModal');
      if (typeof showWalletModal === 'function') {
        showWalletModal(); const wim = document.getElementById('walletInstallModal'); out.walletInstallInline = inline(wim);
        click(wim.querySelector('[data-action="wallet-install-close"]')); out.walletInstallClosed = !document.getElementById('walletInstallModal');
      } else out.walletInstallInline = 'no showWalletModal';

      // ── 5. network-live: current leader + next leaders strip ──
      leaderScheduleEpoch = 387;
      leaderScheduleCache = Object.fromEntries(allValidators.slice(0, 6).map((v, i) => [v.nodePubkey, [100 + i * 4, 101 + i * 4, 102 + i * 4, 103 + i * 4]]));
      const realRpc = window.rpcCall;
      window.rpcCall = async (m) => m === 'getEpochInfo' ? { slotIndex: 101, epoch: 387, slotsInEpoch: 216000, absoluteSlot: 81000101 } : realRpc(m);
      await updateCurrentLeader(); await sleep(400);
      window.rpcCall = realRpc;
      const nl = document.getElementById('nextLeadersList'), logo = document.getElementById('currentLeaderLogo');
      out.nextLeaders = nl.querySelectorAll('[data-action="leader-lookup"]').length; out.nextLeadersInline = inline(nl); out.currentLogoInline = inline(logo);
      out.leaderImgFallback = [...nl.querySelectorAll('.leader-next-logo')].map(x => x.textContent.trim()).join('');   // broken icons → initials
      spy('lookupValidator'); click(nl.querySelector('[data-action="leader-lookup"] .leader-next-name'));

      // ── 6. forensics: suspects list, sortable header, copy ──
      window.Chart = class { constructor() {} destroy() {} update() {} };   // Chart.js is blocked offline
      const VP = window.__vp;
      VP.S.rows = allValidators.map((v, i) => ({ votePubkey: v.votePubkey, nodePubkey: v.nodePubkey, name: v.name, iconUrl: v.iconUrl, delinquent: false,
        selfStake: 10000, stake: v.activatedStake / 1e9, activatedStake: v.activatedStake / 1e9, worstEff: 0.8, liveEff: 0.9, lagMean: null, vposMean: null, clockDrift: null, benchPace: null, benchFill: null, commission: 5, version: '3.1.14', epochsCounted: 5, meanEff: 0.9 - i * 0.01, sdEff: 0.01 + i * 0.002,
        credits: 1000, skipRate: 0.5, slots: 40 }));
      VP.S.epochsAnalyzed = 5; VP.S.currentEpoch = 387; VP.S.slotsPerEpoch = 216000; VP.S.maxCreditsPerSlot = 16;
      try { VP.recomputeAndRender(); } catch (e) { out.vpRenderErr = e.message; }
      try { VP.renderCharts(); } catch (e) { out.vpChartsErr = e.message; }
      await sleep(400);
      const sus = document.getElementById('vpSuspectList'), thead = document.getElementById('vpTheadRow'), tbody = document.querySelector('#vpTablePanel tbody') || document.getElementById('vpTbody');
      out.vpSuspects = sus.querySelectorAll('[data-action="vp-filter-to"]').length; out.vpSusInline = inline(sus);
      out.vpSortable = thead.querySelectorAll('[data-action="vp-sort"]').length; out.vpTheadInline = inline(thead);
      out.vpCopies = document.querySelectorAll('[data-action="vp-copy"]').length; out.vpBodyInline = inline(tbody);
      // (lazy <img>s in the closed overlay never load, so check the markup rather than the fallback firing)
      out.vpImgsWithFallback = document.querySelectorAll('img.vp-ava[data-onerror="img-fallback"]').length;
      spy('vpFilterTo'); spy('vpSetSort'); spy('vpCopyPk');
      click(sus.querySelector('[data-action="vp-filter-to"] .vp-sus-name'));
      click(thead.querySelector('[data-action="vp-sort"]'));
      click(document.querySelector('[data-action="vp-copy"]'));
    } catch (e) { out.fatal = e.message + '\n' + e.stack; }
    out.calls = calls;
    return out;
  }, port);

  // ── Router deep links use the new selectors ──
  await page.evaluate(() => { location.hash = '#/calculators/compound'; });
  await page.waitForTimeout(500);
  result.routerCalc = await page.evaluate(() => (document.querySelector('.calc-nav-btn.active') || {}).dataset?.calc + ' / tab ' + (document.querySelector('.tab.active') || {}).dataset?.tab);

  // ── 7. terminal: snapshot render (Live button, forensics dot) ──
  const t = await page.evaluate(async () => {
    const out = {}, calls = [];
    switchTab('vtterminal');
    let corner; for (let i = 0; i < 40 && !corner; i++) { await new Promise(r => setTimeout(r, 300)); corner = document.querySelector('[data-action="vt-refresh-live"]'); }
    out.liveBtn = !!corner; out.dot = !!document.querySelector('[data-action="vp-open-probe"]');
    out.vtInline = (document.getElementById('vtContent').innerHTML.match(/(^|[\s"'`])on(click|error|change|input)=/g) || []).length;
    window.vtRefreshLive = () => calls.push('vtRefreshLive'); window.vpOpenProbe = () => calls.push('vpOpenProbe');
    corner && corner.click(); const dot = document.querySelector('[data-action="vp-open-probe"]'); dot && dot.click();
    out.calls = calls; return out;
  });
  result.terminal = t;

  // ── 8. terminal error screen (snapshot 404, API blocked) → Retry ──
  const page2 = await newPage(browser, errors, warns);
  block404 = new Set(['/data/terminal.json']);
  await page2.goto(`http://127.0.0.1:${port}/#/terminal`, { waitUntil: 'domcontentloaded' });
  result.terminalError = await page2.evaluate(async () => {
    let btn; for (let i = 0; i < 100 && !btn; i++) { await new Promise(r => setTimeout(r, 300)); btn = document.querySelector('#vtContent .vt-error [data-action="vt-retry"]'); }
    if (!btn) return 'no error screen: ' + (document.getElementById('vtContent') || {}).innerText?.slice(0, 120);
    let n = 0; window.vtRetry = () => n++; btn.click();
    return 'retry calls: ' + n;
  });
  block404 = new Set();

  const calls = result.calls; delete result.calls;
  console.log(JSON.stringify(result, null, 1));
  console.log('calls:'); (calls || []).forEach(c => console.log('  ' + JSON.stringify(c)));
  console.log('page errors:', errors, '\n[Actions] warnings:', warns);
  await browser.close(); srv.close();
})();
