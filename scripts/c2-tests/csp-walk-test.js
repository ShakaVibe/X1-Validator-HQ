// Offline check of the strict CSP (script-src without 'unsafe-inline'): serve the repo,
// walk every route + the main modals, and record every securitypolicyviolation event,
// every CSP console error and every page error. Also a positive control: an injected
// inline onclick MUST be refused (proves the policy is really in force).
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
const ROUTES = ['#/live', '#/terminal', '#/lookup/5ar5xXjefcD2sXZmhExfg4Sur5CJfBKRCp2LmATvQNac', '#/datacenter',
  '#/leaderboard/performance', '#/leaderboard/efficient', '#/delegation', '#/compare', '#/calculators/staking',
  '#/calculators/compound', '#/calculators/unstaking', '#/calculators/breakeven', '#/globe'];

(async () => {
  await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const pageErrors = [], cspConsole = [], otherErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() !== 'error') return; const t = m.text(); (/Content Security Policy|Refused to/.test(t) ? cspConsole : otherErrors).push(t.slice(0, 220)); });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
  await page.addInitScript(() => {
    window.__cspv = [];
    document.addEventListener('securitypolicyviolation', e => window.__cspv.push({
      directive: e.violatedDirective, blocked: e.blockedURI, file: (e.sourceFile || '').split('/').pop(), line: e.lineNumber, sample: (e.sample || '').slice(0, 80)
    }));
  });
  const violations = [];
  const grab = async (label) => {
    const v = await page.evaluate(() => { const x = window.__cspv.slice(); window.__cspv.length = 0; return x; });
    for (const e of v) violations.push({ at: label, ...e });
  };

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const meta = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.replace(/\s+/g, ' ').trim());
  console.log('CSP script-src:', meta.match(/script-src[^;]*/)[0]);
  // Disclaimer flow through the dispatcher (real clicks)
  const disc = await page.evaluate(() => { const m = document.getElementById('disclaimerModal'); return m ? getComputedStyle(m).display : 'none'; });
  if (disc !== 'none') {
    const cb = await page.$('#disclaimerModal input[type=checkbox]'); if (cb) await cb.click();
    const btn = await page.$('#disclaimerModal button:not([disabled])'); if (btn) await btn.click();
    await page.waitForTimeout(300);
  }
  console.log('disclaimer now:', await page.evaluate(() => { const m = document.getElementById('disclaimerModal'); return m ? getComputedStyle(m).display : 'none'; }));
  await grab('load');

  for (const r of ROUTES) {
    await page.evaluate((h) => { location.hash = h; }, r);
    await page.waitForTimeout(900);
    const active = await page.evaluate(() => (document.querySelector('.tab.active') || {}).dataset?.tab || '(none)');
    await grab(r);
    console.log(`route ${r.padEnd(60)} active tab: ${active}`);
  }

  // Modals + controls that live in index.html markup (all go through data-action now)
  const clicks = [
    ['epoch timeline', '[data-action="call"][data-fn="openEpochTimelineModal"], [data-fn="openEpochTimelineModal"]'],
    ['tps modal', '[data-fn="openTpsModal"]'],
    ['browse validators (+ Add)', '[data-fn="openValidatorList"], [data-fn="showValidatorList"], [data-fn="openBrowseModal"]'],
  ];
  for (const [label, sel] of clicks) {
    const el = await page.$(sel);
    if (!el) { console.log(`click ${label}: selector not found (skipped)`); continue; }
    await page.evaluate((s) => { const e = document.querySelector(s); e.click(); }, sel);
    await page.waitForTimeout(400);
    await grab('click ' + label);
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    console.log(`click ${label}: done`);
  }
  // Positive control: an injected inline handler must be refused and must not run.
  const control = await page.evaluate(async () => {
    window.__ranInline = false;
    const b = document.createElement('button'); b.setAttribute('onclick', 'window.__ranInline = true'); document.body.appendChild(b); b.click();
    const s = document.createElement('script'); s.textContent = 'window.__ranInlineScript = true'; document.body.appendChild(s);
    await new Promise(r => setTimeout(r, 200));
    return { inlineHandlerRan: window.__ranInline, inlineScriptRan: !!window.__ranInlineScript, violations: window.__cspv.map(v => v.directive) };
  });
  console.log('positive control (expect false/false + 2 script-src violations):', JSON.stringify(control));
  await page.evaluate(() => { window.__cspv.length = 0; });

  const scriptViolations = violations.filter(v => /script-src/.test(v.directive));
  const styleViolations = violations.filter(v => !/script-src/.test(v.directive));
  console.log('\n=== RESULT ===');
  console.log('script-src violations during the walk:', scriptViolations.length, JSON.stringify(scriptViolations, null, 1));
  console.log('other-directive violations:', styleViolations.length, JSON.stringify(styleViolations.slice(0, 5)));
  console.log('CSP console errors during the walk:', cspConsole.length, cspConsole.slice(0, 5));
  console.log('page errors:', JSON.stringify(pageErrors.slice(0, 10)));
  console.log('other console errors (network aborts expected):', otherErrors.length, otherErrors.filter(t => !/Failed to load resource|net::ERR|Failed to fetch/.test(t)).slice(0, 8));
  await browser.close(); srv.close();
  process.exit(scriptViolations.length || control.inlineHandlerRan || control.inlineScriptRan ? 1 : 0);
})();
