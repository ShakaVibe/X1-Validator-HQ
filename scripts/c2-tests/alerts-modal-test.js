// Offline smoke of the Telegram-alerts entry point (js/alerts.js + #alertsModal):
// serve the repo, abort external requests, open My Data Center with a 2-validator
// portfolio in the page's own localStorage, click "Telegram alerts" through the
// dispatcher, check the rendered command / copy / close paths, then the empty-
// portfolio variant. Also asserts 0 inline handlers and 0 page errors.
//   node scripts/c2-tests/alerts-modal-test.js /path/to/repo
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
const V1 = '5ar5xXjefcD2sXZmhExfg4Sur5CJfBKRCp2LmATvQNac', V2 = 'Vote22222222222222222222222222222222222222';
let fails = 0;
const check = (ok, label, extra) => { console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok || extra === undefined ? '' : ' — ' + JSON.stringify(extra))); if (!ok) fails++; };

(async () => {
  await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const pageErrors = [], warnings = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { const t = m.text(); if (/\[Actions\]/.test(t)) warnings.push(t); });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
  await page.addInitScript(([a, b]) => { try { localStorage.setItem('x1Portfolio', JSON.stringify([a, b])); } catch (e) {} }, [V1, V2]);

  await page.goto(`http://127.0.0.1:${port}/#/datacenter`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { const m = document.getElementById('disclaimerModal'); if (m) m.style.display = 'none'; });

  const btn = await page.$('.portfolio-actions [data-action="alerts-open"]');
  check(!!btn, 'Telegram alerts button present in the Data Center actions row');
  check(await page.evaluate(() => Actions.has('alerts-open') && Actions.has('alerts-close') && Actions.has('alerts-copy') && Actions.has('alerts-overlay')), 'all four actions registered');
  await btn.click();
  await page.waitForTimeout(200);
  const st = await page.evaluate(() => ({
    display: getComputedStyle(document.getElementById('alertsModal')).display,
    cmd: (document.getElementById('tgaCommand') || {}).textContent,
    lead: (document.querySelector('#alertsModalBody .tga-lead') || {}).textContent,
    inline: document.querySelectorAll('#alertsModal [onclick], #alertsModal [onerror], #alertsModal [onchange]').length,
    steps: document.querySelectorAll('#alertsModalBody .tga-steps li').length,
  }));
  check(st.display === 'flex', 'modal opens via the dispatcher', st);
  check(st.cmd === `/watch ${V1} ${V2}`, 'command lists the portfolio vote keys', st.cmd);
  check(/delinquent/.test(st.lead) && /skips leader slots/.test(st.lead), 'lead text names the alert types');
  check(st.steps === 2 && st.inline === 0, '2 steps, 0 inline handlers', st);
  // copy through the dispatcher
  await page.click('#alertsModalBody .tga-copy');
  await page.waitForTimeout(150);
  const copied = await page.evaluate(async () => ({ clip: await navigator.clipboard.readText(), label: document.querySelector('.tga-copy').textContent, cls: document.querySelector('.tga-copy').className }));
  check(copied.clip === `/watch ${V1} ${V2}` && /Copied/.test(copied.label) && /is-copied/.test(copied.cls), 'Copy writes the command to the clipboard and flips the label', copied);
  await page.waitForTimeout(1600);
  check((await page.evaluate(() => document.querySelector('.tga-copy').textContent)) === 'Copy', 'label restores after 1.5 s');
  // close paths: × button, Escape, backdrop (inner click must NOT close)
  await page.click('#alertsModal .modal-close');
  check((await page.evaluate(() => document.getElementById('alertsModal').style.display)) === 'none', '× closes');
  await page.evaluate(() => openAlertsModal());
  await page.keyboard.press('Escape');
  check((await page.evaluate(() => document.getElementById('alertsModal').style.display)) === 'none', 'Escape closes');
  await page.evaluate(() => openAlertsModal());
  await page.click('#alertsModal .modal-body');
  check((await page.evaluate(() => document.getElementById('alertsModal').style.display)) === 'flex', 'inner click keeps it open');
  await page.mouse.click(5, 5);
  check((await page.evaluate(() => document.getElementById('alertsModal').style.display)) === 'none', 'backdrop click closes');

  // empty portfolio variant
  const page2 = await ctx.newPage();
  page2.on('pageerror', e => pageErrors.push(e.message));
  await page2.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
  await page2.addInitScript(() => { try { localStorage.removeItem('x1Portfolio'); } catch (e) {} });
  await page2.goto(`http://127.0.0.1:${port}/#/datacenter`, { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(1000);
  await page2.evaluate(() => { const m = document.getElementById('disclaimerModal'); if (m) m.style.display = 'none'; openAlertsModal(); });
  const e = await page2.evaluate(() => ({ cmd: !!document.getElementById('tgaCommand'), note: (document.querySelector('#alertsModalBody .tga-note') || {}).textContent, copy: !!document.querySelector('.tga-copy') }));
  check(!e.cmd && !e.copy && /Add validators to your Data Center/.test(e.note), 'empty portfolio: no command box, hint instead', e);

  // phone width: command box stacks
  await page2.setViewportSize({ width: 375, height: 700 });
  await page2.evaluate((a) => { myPortfolio.push(a); openAlertsModal(); }, V1);
  const ph = await page2.evaluate(() => { const c = document.querySelector('.tga-cmd'); const r = document.querySelector('#alertsModal .modal').getBoundingClientRect(); return { dir: getComputedStyle(c).flexDirection, overflow: document.documentElement.scrollWidth > window.innerWidth, w: Math.round(r.width) }; });
  check(ph.dir === 'column' && !ph.overflow, 'phone: command stacks, no horizontal overflow', ph);

  console.log('page errors:', pageErrors);
  console.log('[Actions] warnings:', warnings);
  check(pageErrors.length === 0 && warnings.length === 0, 'no page errors, no dispatcher warnings');
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall good');
  process.exit(fails ? 1 : 0);
})();
