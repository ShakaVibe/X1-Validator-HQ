// Frame guard (audit 2026-11-17 #13) — js/frame-guard.js.
// The site signs wallet transactions, so it must not be usable inside another
// page's <iframe> (clickjacking). GitHub Pages cannot send a frame-ancestors
// header; until a host that can is in front of it, the guard refuses to run
// when framed: the page is stopped and replaced by a notice.
//
// Offline: the repo is served on 127.0.0.1 and a "hostile" page on localhost
// (a different origin) frames it. Checks
//   1. unframed: the site loads normally, the guard does nothing;
//   2. cross-origin frame: none of the site's markup, none of its scripts, only
//      the notice + a link that opens the site at the top level;
//   3. same result inside sandbox="allow-scripts allow-same-origin" and for a
//      same-origin parent;
//   4. the old guard (git history) is still usable in a frame — proof that the
//      test can tell the difference (skipped when git is not available).
//   node scripts/c2-tests/frame-guard-test.js /path/to/repo
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(process.argv[2] || '.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let oldGuard = null;                                  // when set, /js/frame-guard.js is answered with this source
const site = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  if (p === '/framed-by-self.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>same origin</title><iframe id="f" src="/" width="1000" height="700"></iframe>'); }
  if (p === '/js/frame-guard.js' && oldGuard) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(oldGuard); }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
let sitePort = 0;
const hostile = http.createServer((req, res) => {
  const sandbox = /sandbox/.test(req.url) ? ' sandbox="allow-scripts allow-same-origin"' : '';
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>hostile</title><h1 id="bait">Win a prize, click here</h1><iframe id="f"${sandbox} src="http://127.0.0.1:${sitePort}/" width="1000" height="700"></iframe>`);
});

let fails = 0;
const check = (ok, label, extra) => { console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok || extra === undefined ? '' : ' — ' + JSON.stringify(extra))); if (!ok) fails++; };
// What is inside the frame (or the page): the site's UI, its scripts, or only the notice?
const probe = (frame) => frame.evaluate(() => ({
  tabs: document.querySelectorAll('.tab').length, modals: document.querySelectorAll('.modal-overlay').length, scripts: document.querySelectorAll('script').length,
  siteJs: typeof switchTab === 'function' || typeof Actions !== 'undefined' || typeof rpcCall === 'function',
  text: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 120), link: (() => { const a = document.querySelector('a'); return a ? { href: a.href, target: a.target } : null; })(),
  children: [...document.documentElement.children].map(e => e.tagName + (e.id ? '#' + e.id : '')), display: getComputedStyle(document.documentElement).display,
}));

(async () => {
  await new Promise(r => site.listen(0, '127.0.0.1', r)); sitePort = site.address().port;
  await new Promise(r => hostile.listen(0, '127.0.0.1', r)); const hostilePort = hostile.address().port;
  const browser = await chromium.launch();
  const newPage = async () => {
    const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost))/, r => r.abort());
    return { page, errs };
  };
  const framedProbe = async (url) => {
    const { page, errs } = await newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);                  // long enough for every site script to have loaded if it were going to
    const frame = page.frames().find(f => f !== page.mainFrame());
    const out = { top: page.url(), frame: frame ? await probe(frame) : null, errs };
    await page.close();
    return out;
  };
  const blanked = (r) => r.frame && r.frame.tabs === 0 && r.frame.modals === 0 && r.frame.scripts === 0 && !r.frame.siteJs && /does not run inside another page/.test(r.frame.text) &&
    r.frame.children.length === 1 && r.frame.children[0] === 'BODY#x1-frame-guard-notice' && r.frame.display !== 'none' && r.frame.link && r.frame.link.href === 'https://x1valhq.xyz/' && r.frame.link.target === '_top';

  console.log('1. Unframed');
  const a = await newPage();
  await a.page.goto(`http://127.0.0.1:${sitePort}/`, { waitUntil: 'domcontentloaded' });
  await a.page.waitForFunction(() => typeof switchTab === 'function' && document.querySelectorAll('.tab').length >= 7, null, { timeout: 15000 }).catch(() => {});
  const un = await probe(a.page.mainFrame());
  check(un.tabs >= 7 && un.siteJs && un.modals > 10 && un.display !== 'none' && !/does not run inside/.test(un.text), `the site loads normally (${un.tabs} tabs, ${un.modals} modals, scripts running)`, un);
  check(a.errs.length === 0, 'page errors: ' + JSON.stringify(a.errs));
  await a.page.close();

  console.log('2. Framed by another origin');
  const x = await framedProbe(`http://localhost:${hostilePort}/`);
  check(blanked(x), 'no site markup, no site scripts: only the notice and a top-level link to https://x1valhq.xyz/', x.frame);
  check(/^http:\/\/localhost:/.test(x.top), 'the hostile page itself is left alone (the browser blocks the break-out without a user gesture)', x.top);
  check(x.errs.length === 0, 'page errors: ' + JSON.stringify(x.errs));

  console.log('3. Sandboxed frame, same-origin parent');
  const sb = await framedProbe(`http://localhost:${hostilePort}/sandbox`);
  check(blanked(sb), 'sandbox="allow-scripts allow-same-origin": blanked the same way', sb.frame);
  const so = await framedProbe(`http://127.0.0.1:${sitePort}/framed-by-self.html`);
  check(blanked(so) || /^http:\/\/127\.0\.0\.1:\d+\/$/.test(so.top), 'same-origin parent: blanked, or broken out to the top (both leave no framed UI)', { top: so.top, frame: so.frame });

  console.log('4. Control: the previous guard');
  try { oldGuard = cp.execSync('git show f52cd9f0:js/frame-guard.js', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch (e) { oldGuard = null; }
  if (oldGuard) {
    const old = await framedProbe(`http://localhost:${hostilePort}/`);
    check(old.frame && old.frame.tabs >= 7 && old.frame.siteJs, `with the old guard the framed site is fully usable (${old.frame && old.frame.tabs} tabs, scripts running), so this test tells them apart`, old.frame);
    oldGuard = null;
  } else {
    console.log('  – skipped (git history not available here)');
  }

  await browser.close(); site.close(); hostile.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
