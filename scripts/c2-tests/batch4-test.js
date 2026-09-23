// Offline test of C2 batch 4: js/card-details.js, js/leaderboards.js (+ the
// leaderboard category buttons in index.html and the Router selector in app.js),
// js/skip-monitor.js. Same harness as the other c2-tests.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.argv[2] || '.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(f);
  // Test seam: expose SkipMonitor's private state/renderers (served copy only).
  if (p === '/js/skip-monitor.js') {
    const s = body.toString();
    const ret = 'return { start, stop, setScope, renderAll,';
    if (!s.includes(ret)) { res.writeHead(500); return res.end('seam not found'); }
    body = s.replace(ret, 'return { __t: { setState: (x) => { state = x; }, getState: () => state, freshState, recordSlot }, start, stop, setScope, renderAll,');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(body);
});
(async () => {
  await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors = [], warns = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/\[Actions\]/.test(m.text())) warns.push(m.type() + ': ' + m.text()); });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
  await page.goto(`http://127.0.0.1:${port}/#/live`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const result = await page.evaluate(async (port) => {
    const out = {}; const calls = [];
    const argOf = (x) => x instanceof Element ? '<' + x.tagName + '>' : x;
    const spy = (name) => { const orig = window[name]; window[name] = function (...a) { calls.push([name, ...a.map(argOf)]); }; return orig; };
    const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const inline = (el) => (el.innerHTML.match(/(^|[\s"'`])on(click|error|change|input|mousedown|mouseenter|mouseleave|load)=/g) || []).length;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const NAME = 'Evil "<b>&\'name', V1 = '5ar5xXjefcD2sXZmhExfg4Sur5CJfBKRCp2LmATvQNac';
    let outside = 0; document.addEventListener('click', () => outside++);
    const dm = document.getElementById('disclaimerModal'); if (dm) dm.style.display = 'none';
    try {
      out.registered = ['stake-cancel', 'stake-retry', 'stake-accounts-toggle', 'stake-apy-period', 'stake-manage-classification',
        'lb-category', 'lb-lookup', 'skipmon-jump', 'skipmon-scrub', 'skipmon-toggle-top', 'skipmon-portfolio-modal',
        'skipmon-lookup-pick', 'img-remove'].filter(n => !Actions.has(n));   // [] = all registered

      // ── 1. card-details: two cards for the same validator (Lookup + Data Center) ──
      const cardHtml = (tag) => `<div class="validator-card" data-t="${tag}">
          <button class="validator-expand-btn stake-details-btn">Stake details</button>
          <div class="validator-stake-section" id="stake-${V1}-section"></div></div>`;
      const host = document.createElement('div'); host.innerHTML = cardHtml('lk') + cardHtml('dc'); document.body.appendChild(host);
      const [lk, dc] = host.querySelectorAll('.validator-card');
      const data = { selfStake: 5000, delegatedStake: 995000, accountCount: 3, detectionMethod: 'withdrawer-match',
        selfStakeAccounts: [{ pubkey: 'SelfAcct1111111111111111111111111111111111', amount: 5000 }],
        delegators: [{ pubkey: 'DelAcct11111111111111111111111111111111111', amount: 900000 }, { pubkey: 'DelAcct22222222222222222222222222222222222', amount: 95000 }],
        historicalAPY: { days7: { validatorAPY: 11.11, earnings: 1.5 }, days30: { validatorAPY: 33.33, earnings: 9.75 } } };
      renderInlineStakeBreakdown(lk.querySelector('.validator-stake-section'), data, NAME, 1e6, 5, V1);
      renderInlineStakeBreakdown(dc.querySelector('.validator-stake-section'), data, NAME, 1e6, 5, V1);
      out.cdInline = inline(host);
      // accounts toggle on the DC card opens the DC list only
      click(dc.querySelector('.stake-accounts-toggle .stake-inline-stat-label'));   // child click bubbles to the tile
      out.accountsDcOpen = dc.querySelector('.stake-accounts-list').classList.contains('expanded');
      out.accountsLkClosed = !lk.querySelector('.stake-accounts-list').classList.contains('expanded');
      // APY period select on the DC card updates the DC card only
      const sel = dc.querySelector('select.stake-apy-period-select');
      sel.value = '30'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      out.apyDc = dc.querySelector('.stake-inline-apy-value').textContent.trim();
      out.apyLk = lk.querySelector('.stake-inline-apy-value').textContent.trim();
      // Manage classification: calls openStakeSelection(vote, name) and stops propagation
      spy('openStakeSelection');
      let o = outside; click(dc.querySelector('.stake-manage-btn')); out.manageStopped = outside === o;
      // Slow-load path: hang every fetch, wait for the 5 s "Still loading…" Cancel button
      const realFetch = window.fetch; window.fetch = () => new Promise(() => {});
      window.stakeBreakdownCache && delete window.stakeBreakdownCache[V1];
      const lk2 = document.createElement('div'); lk2.innerHTML = cardHtml('slow'); document.body.appendChild(lk2);
      const slowCard = lk2.firstElementChild, slowBtn = slowCard.querySelector('.stake-details-btn');
      toggleStakeDetails(V1, NAME, 1e6, 5, slowBtn);
      await sleep(5400);
      const cancelBtn = slowCard.querySelector('button[data-action="stake-cancel"]');
      out.cancelBtn = cancelBtn ? cancelBtn.getAttribute('data-vote') === V1 : 'none';
      click(cancelBtn);   // real cancelStakeLoad → "Loading cancelled" + Retry
      out.cancelled = slowCard.querySelector('.validator-stake-section').dataset.loaded === 'cancelled';
      out.slowInline = inline(slowCard);
      spy('retryStakeLoad'); click(slowCard.querySelector('button[data-action="stake-retry"]'));
      window.fetch = realFetch;

      // ── 2. leaderboards ──
      const mkV = (i) => ({ name: i === 0 ? NAME : 'Val ' + i, votePubkey: 'Vote' + String(i).padStart(40, 'x'), nodePubkey: 'Node' + String(i).padStart(40, 'y'),
        iconUrl: i % 2 ? `http://127.0.0.1:${port}/missing-${i}.png` : '', performanceScore: 90 - i * 0.1, activatedStake: (1e6 - i) * 1e9, commission: i % 10,
        delinquent: false, skipRate: 0.5, uptime: 99, epochCredits: [[380, 5000, 0], [381, 10000, 5000], [382, 15000, 10000]], firstEpoch: 380 - (i % 3),
        creditsFirstEpoch: 380 - (i % 3), creditsEpochs: 3, score: 90 - i * 0.1 });
      window.loadLeaderboard = async () => {};   // keep switchTab from re-fetching (and overwriting) the data
      switchTab('leaderboard'); await sleep(200);
      leaderboardData = Array.from({ length: 60 }, (_, i) => mkV(i));
      allValidators = leaderboardData.map(v => ({ ...v }));
      const realSwitch = spy('switchLeaderboard');
      click(document.querySelector('.leaderboard-cat-btn[data-category="stake"]'));
      window.switchLeaderboard = realSwitch;
      const btns = [...document.querySelectorAll('.leaderboard-cat-btn')];
      out.catInline = inline(document.querySelector('.leaderboard-categories') || btns[0].parentElement);
      out.catBtns = btns.map(b => b.dataset.category).join(',');
      out.lbErrors = [];
      for (const cat of ['stake', 'newest']) {
        try { renderLeaderboard(cat); } catch (e) { out.lbErrors.push(cat + ': ' + e.message); }
        await sleep(300);
        const list = document.getElementById('leaderboardList');
        out['rows_' + cat] = list.querySelectorAll('.leaderboard-item[data-action="lb-lookup"]').length;
        out['inline_' + cat] = inline(list);
        out['imgFallback_' + cat] = [...list.querySelectorAll('img.leaderboard-logo')].filter(img => img.style.display === 'none'
          && img.nextElementSibling && img.nextElementSibling.style.display === '').length;
      }
      spy('lookupValidator');
      click(document.querySelector('#leaderboardList .leaderboard-item .leaderboard-name'));
      // delegations board rows
      delegationsData = { x1Labs: { byVoter: { [leaderboardData[0].votePubkey]: 5e14, [leaderboardData[1].votePubkey]: 1e14 } }, ripper: { byVoter: {} } };
      allValidators = leaderboardData.map(v => ({ ...v }));
      try { renderDelegationsLeaderboard(); } catch (e) { out.lbErrors.push('delegations: ' + e.message); }
      await sleep(300);
      const dl = document.getElementById('leaderboardList');
      out.rows_delegations = dl.querySelectorAll('.leaderboard-item[data-action="lb-lookup"]').length;
      out.inline_delegations = inline(dl);
      click(dl.querySelector('.leaderboard-item'));

      // ── 3. skip monitor ──
      const T = SkipMonitor.__t;
      const st = T.freshState('network'); st.running = true; st.epoch = 382; st.epochStartAbsoluteSlot = 1000;
      T.setState(st);
      const nodes = allValidators.slice(0, 5).map(v => v.nodePubkey);
      for (let s = 1000; s < 1120; s++) { st.slotToLeader[s] = nodes[Math.floor(s / 4) % 5]; if (s < 1100) T.recordSlot(s, st.slotToLeader[s], s % 7 !== 0); }
      st.lastProcessedSlot = 1099; st.lastSeenHead = 1099; st.lastTickTs = Date.now();
      st.epochProd = { byIdentity: Object.fromEntries(allValidators.slice(0, 8).map((v, i) => [v.nodePubkey, [40, 40 - (i + 1)]])), ts: Date.now(), epoch: 382 };
      // renderTimeline's #skipmonTimelineTrack is no longer in index.html (dead path) — add one to cover it.
      if (!document.getElementById('skipmonTimelineTrack')) { const tt = document.createElement('div'); tt.id = 'skipmonTimelineTrack'; document.body.appendChild(tt); }
      SkipMonitor.renderAll();
      out.avatarImgsBefore = document.querySelectorAll('#skipmonFeed img[data-onerror="img-remove"], #skipmonTopWrap img[data-onerror="img-remove"]').length;
      const smIds = ['skipmonGrid', 'skipmonFeed', 'skipmonTopWrap', 'skipmonTimelineTrack', 'skipmonScrubber'];
      out.smCounts = smIds.map(id => { const el = document.getElementById(id); return id + ':' + (el ? el.querySelectorAll('[data-action]').length + '/' + inline(el) : 'missing'); });
      spy('skipmonJumpToValidator'); spy('skipmonScrubberJump'); spy('skipmonToggleTop');
      click(document.querySelector('#skipmonGrid .skipmon-cell'));
      click(document.querySelector('#skipmonFeed .skipmon-feed-body'));   // child of the feed item
      click(document.querySelector('#skipmonTopWrap tr[data-action]'));
      click(document.querySelector('#skipmonTimelineTrack [data-action="skipmon-jump"]'));
      click(document.querySelectorAll('[data-action="skipmon-scrub"]')[3]);
      click(document.querySelector('.skipmon-top-expand-btn'));
      // avatar img-remove: a broken icon disappears, the initial stays
      allValidators[1].iconUrl = `http://127.0.0.1:${port}/broken-avatar.png`;
      SkipMonitor.renderAll(); await sleep(400);
      out.avatarImgsLeft = document.querySelectorAll('#skipmonFeed img[data-onerror="img-remove"], #skipmonTopWrap img[data-onerror="img-remove"]').length;
      // portfolio card head (scorecard html) → skipmonOpenPortfolioModal
      const sc = document.createElement('div'); sc.innerHTML = SkipMonitor.getScorecardHtml(allValidators[0].votePubkey) || ''; document.body.appendChild(sc);
      out.scorecardInline = inline(sc);
      spy('skipmonOpenPortfolioModal'); click(sc.querySelector('[data-action="skipmon-portfolio-modal"] .skipmon-pv-logo') || sc.querySelector('[data-action="skipmon-portfolio-modal"]'));
      // lookup dropdown: mousedown picks
      const inp = document.getElementById('skipmonLookupInput');
      if (inp) {
        inp.value = 'Val 1'; SkipMonitor.handleLookupInput();
        const res = document.getElementById('skipmonLookupResults');
        out.lookupInline = inline(res);
        spy('skipmonLookupPick');
        const item = res.querySelector('[data-mousedown="skipmon-lookup-pick"] .skipmon-lookup-result-name');
        item && item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      } else out.lookupInline = 'no input';
    } catch (e) { out.fatal = e.message + '\n' + e.stack; }
    out.calls = calls;
    return out;
  }, port);

  // Router: #/leaderboard/efficient must mark that button active through the new selector.
  await page.evaluate(() => { location.hash = '#/leaderboard/efficient'; });
  await page.waitForTimeout(600);
  result.routerActive = await page.evaluate(() => (document.querySelector('.leaderboard-cat-btn.active') || {}).dataset?.category);
  await page.evaluate(() => document.querySelector('.leaderboard-cat-btn[data-category="reliable"]').click());
  result.clickActive = await page.evaluate(() => (document.querySelector('.leaderboard-cat-btn.active') || {}).dataset?.category + ' ' + location.hash);

  const calls = result.calls; delete result.calls;
  console.log(JSON.stringify(result, null, 1));
  console.log('calls:'); calls.forEach(c => console.log('  ' + JSON.stringify(c)));
  console.log('page errors:', errors, '\n[Actions] warnings:', warns);
  await browser.close(); srv.close();
})();
