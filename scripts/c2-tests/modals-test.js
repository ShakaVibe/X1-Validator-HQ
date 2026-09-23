// Offline test of the data-action conversion in js/modals.js (+ hover pair in the dispatcher).
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
  const errors = [], actionsWarn = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/\[Actions\]/.test(m.text())) actionsWarn.push(m.text()); });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
  await page.goto(`http://127.0.0.1:${port}/#/live`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const result = await page.evaluate(async (port) => {
    const out = {}; const calls = [];
    const spy = (name) => { window[name] = function (...a) { calls.push([name, ...a.map(x => x instanceof Element ? '<' + x.tagName + '>' : x)]); }; };
    const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const hover = (el, type, related) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: related || null }));
    const inline = (el) => (el.innerHTML.match(/(^|[\s"'])on(click|error|change|input|mouseenter|mouseleave)=/g) || []).length;
    const NAME = 'Evil "<b>&\'name', V1 = '5ar5xXjefcD2sXZmhExfg4Sur5CJfBKRCp2LmATvQNac';
    try {
      // 1. Reward breakdown error path → Retry (data-action="reward-breakdown", registered in modals.js now)
      window.computeRewardBreakdown = async () => { throw new Error('boom <x>'); };
      await openRewardBreakdown(V1, NAME, 7);
      const rbBody = document.getElementById('rewardBreakdownBody');
      out.rbRetry = rbBody.querySelector('button[data-action="reward-breakdown"]') ? rbBody.querySelector('button').outerHTML.slice(0, 200) : 'none';
      spy('openRewardBreakdown'); let outside = 0; document.addEventListener('click', () => outside++);
      let o = outside; click(rbBody.querySelector('button')); out.rbRetryStopped = outside === o;
      out.rbInline = inline(rbBody);
      out.registered = ['rb-close', 'rb-portfolio-retry', 'tps-pin-close', 'tps-fetch-txs', 'tps-copy-tx', 'tps-bar', 'slot-tl-toggle', 'sm-refresh', 'reward-breakdown'].map(n => n + ':' + Actions.has(n));
      // 2. TPS modal chart: hover pair + click pin + fetch + close + copy
      tpsSamplesCache = Array.from({ length: 120 }, (_, i) => 500 + 300 * Math.sin(i / 7));
      renderTpsModal();
      const chart = document.getElementById('tpsModalChart'), host = document.getElementById('tpsModalTooltipHost');
      const zones = [...chart.querySelectorAll('rect[data-enter="tps-bar"]')];
      out.zones = zones.length; out.chartInline = inline(chart);
      hover(zones[5], 'mouseover', document.body); out.tooltipOnEnter = host.innerHTML.length > 0 && _tpsHoveredBucket === 5;
      hover(zones[5], 'mouseout', zones[6]); out.tooltipOnLeave = host.innerHTML.length === 0 && _tpsHoveredBucket === null;
      _tpsBucketMeta[5].startSlot = 1000; _tpsBucketMeta[5].endSlot = 1999;
      click(zones[5]); out.pinned = _tpsPinnedBucket === 5 && !!host.querySelector('.tps-tooltip-pinned');
      out.tooltipInline = inline(host);
      const fetchBtn = host.querySelector('.tps-tooltip-fetch-btn');
      out.fetchBtn = fetchBtn ? fetchBtn.outerHTML.slice(0, 140) : 'none';
      spy('_fetchTxsForTpsBucket'); click(fetchBtn);
      o = outside; click(host.querySelector('.tps-tooltip')); out.tooltipClickStopped = outside === o;   // data-action="stop" on the tooltip
      click(host.querySelector('.tps-tooltip-close')); out.unpinned = _tpsPinnedBucket === null;
      const rowHost = document.createElement('div'); document.body.appendChild(rowHost);
      rowHost.innerHTML = _renderTxRow('First', 'sig"<b>123', 42);
      spy('_copyTpsTx'); click(rowHost.querySelector('.tps-tx-copy')); out.rowInline = inline(rowHost);
      // 3. Slot timeline toggle
      const pips = Array.from({ length: 400 }, (_, i) => ({ red: i % 50 === 0, html: '<i class="pip"></i>' }));
      const tl = document.createElement('div'); document.body.appendChild(tl);
      tl.innerHTML = assembleSlotTimeline(pips, 'sm-grid', 400);
      const tbtn = tl.querySelector('.slot-tl-toggle'); out.tlBtn = tbtn ? tbtn.outerHTML.slice(0, 120) : 'none';
      spy('toggleSlotTimeline'); click(tbtn); out.tlInline = inline(tl);
      // 4. Slot modal logo fallback
      allValidators = [{ nodePubkey: 'nodeX', voteAccount: V1, name: NAME, iconUrl: `http://127.0.0.1:${port}/nope.png` }];
      window.smLoadAndRender = async () => {};
      await openSlotModal('nodeX', NAME, V1);
      await new Promise(r => setTimeout(r, 400));
      const logo = document.getElementById('slotModalLogo');
      const img = logo.querySelector('img'), ph = logo.querySelector('.slot-modal-logo-ph');
      out.slotLogo = { imgHidden: img && img.style.display === 'none', phShown: ph && getComputedStyle(ph).display, phText: ph && ph.textContent, inline: inline(logo) };
      closeSlotModal();
    } catch (e) { out.fatal = e.message + '\n' + e.stack; }
    out.calls = calls;
    return out;
  }, port);
  console.log(JSON.stringify(result, null, 1));
  console.log('page errors:', errors, '\n[Actions] warnings:', actionsWarn);
  await browser.close(); srv.close();
})();
