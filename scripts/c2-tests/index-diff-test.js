// Differential test for the index.html conversion (C2 batch 6).
//
// Loads the page twice — once with the ORIGINAL index.html (inline on* handlers)
// and once with the CONVERTED one (data-action dispatcher) — both instrumented
// with the same data-h="k" on every element that carried an inline handler.
// Every function the handlers can reach is replaced by a spy, then every
// handler element gets its events fired (click on the element and on its first
// child, input, change, error, focus, blur). For each element the two pages
// must produce the same spy calls (same functions, same arguments — elements
// compared by data-h), the same defaultPrevented and the same "did the event
// reach document" (stopPropagation). Disabled controls are enabled first so
// they are covered too.
//
//   git show <commit-before-batch-6>:index.html > /tmp/o.html
//   python3 scripts/c2-tests/convert-index.py /tmp/o.html /tmp/conv.html --instrument   # also writes /tmp/conv.orig.html
//   node scripts/c2-tests/index-diff-test.js "$PWD" /tmp/conv.orig.html /tmp/conv.html
// Expected: 0 differences except #175 perfExplainerModal (see the 2026-09-23 session log).
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const [ROOT, ORIG, CONV] = process.argv.slice(2).map(p => path.resolve(p));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  const m = p.match(/^\/(o|n)(\/.*)$/); if (!m) { res.writeHead(404); return res.end(); }
  p = m[2]; if (p === '/') p = '/index.html';
  let f = p === '/index.html' ? (m[1] === 'o' ? ORIG : CONV) : path.join(ROOT, p);
  if (!f.startsWith(ROOT) && f !== ORIG && f !== CONV) { res.writeHead(404); return res.end(); }
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});

// Names of every function the original handlers mention (identifier followed by "(").
const origHtml = fs.readFileSync(ORIG, 'utf8');
const handlerTexts = [...origHtml.matchAll(/\son[a-z]+="([^"]*)"/g)].map(m => m[1]);
const FN_NAMES = [...new Set(handlerTexts.flatMap(t => [...t.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1])))]
  .filter(n => !['if', 'typeof'].includes(n));

async function run(browser, which) {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors = [], warns = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/\[Actions\]/.test(m.text())) warns.push(m.text()); });
  // Google Fonts CSS answered locally (so the async-css switch can be observed); everything else external aborted.
  await page.route(/fonts\.googleapis\.com\/css2/, r => r.fulfill({ status: 200, contentType: 'text/css', body: 'body{}', headers: { 'access-control-allow-origin': '*' } }));
  await page.route(/^(?!http:\/\/127\.0\.0\.1)(?!https:\/\/fonts\.googleapis\.com\/css2)/, r => r.abort());
  await page.goto(`http://127.0.0.1:${srv.address().port}/${which}/#/live`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const out = await page.evaluate((FN_NAMES) => {
    const res = { perEl: {}, missingFns: [], fontMedia: null };
    const fontLink = [...document.querySelectorAll('link[rel="stylesheet"]')].find(l => /fonts\.googleapis/.test(l.href));
    res.fontMedia = fontLink ? fontLink.media : 'none';
    let log = [];
    const ser = (x) => x instanceof Element ? 'H' + (x.dataset.h || '?' + x.tagName) : (x instanceof Event ? 'E:' + x.type : x);
    for (const n of FN_NAMES) {
      if (typeof window[n] !== 'function') { res.missingFns.push(n); }
      window[n] = function (...a) { log.push(n + '(' + JSON.stringify(a.map(ser)) + ')'); };
    }
    // Everything below is synchronous, so no timer can call a spy in between.
    let reached = 0; document.addEventListener('click', () => reached++);
    ['input', 'change'].forEach(t => document.addEventListener(t, () => reached++));
    const els = [...document.querySelectorAll('[data-h]')];
    res.count = els.length;
    const origAttrs = (el) => el.getAttributeNames().filter(a => /^on[a-z]+$/.test(a));
    for (const el of els) {
      const k = el.dataset.h;
      const wasDisabled = el.disabled; if (wasDisabled) el.disabled = false;
      const trials = {};
      const fire = (label, target, ev) => {
        log = []; const r0 = reached; target.dispatchEvent(ev);
        trials[label] = { calls: log.slice(), prevented: ev.defaultPrevented, reachedDoc: reached > r0, userSet: el.dataset.userSet || null };
        delete el.dataset.userSet;
      };
      // Which events to fire: the ORIGINAL page tells us via its on* attributes; the converted page reads the same list from window.__evmap.
      const evs = window.__evmap ? window.__evmap[k] : origAttrs(el);
      for (const a of evs) {
        if (a === 'onclick') {
          fire('click', el, new MouseEvent('click', { bubbles: true, cancelable: true }));
          const child = el.firstElementChild; if (child) fire('click-child', child, new MouseEvent('click', { bubbles: true, cancelable: true }));
        } else if (a === 'oninput') fire('input', el, new Event('input', { bubbles: true }));
        else if (a === 'onchange') fire('change', el, new Event('change', { bubbles: true }));
        else if (a === 'onerror') fire('error', el, new Event('error'));
        else if (a === 'onfocus') { log = []; el.dispatchEvent(new FocusEvent('focus')); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); trials.focus = { calls: log.slice() }; }
        else if (a === 'onblur') { log = []; el.dispatchEvent(new FocusEvent('blur')); el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); trials.blur = { calls: log.slice() }; }
        else trials[a] = 'not fired';
      }
      if (wasDisabled) el.disabled = true;
      res.perEl[k] = { tag: el.tagName, id: el.id, evs, trials };
    }
    res.inlineLeft = document.querySelectorAll('*').length && [...document.querySelectorAll('*')].filter(e => e.getAttributeNames().some(a => /^on[a-z]+$/.test(a))).length;
    return res;
  }, FN_NAMES);
  return { out, errors, warns, page };
}

(async () => {
  await new Promise(r => srv.listen(0, r));
  const browser = await chromium.launch();
  const o = await run(browser, 'o');
  // Hand the converted page the original's per-element event list.
  const evmap = Object.fromEntries(Object.entries(o.out.perEl).map(([k, v]) => [k, v.evs]));
  // run() creates its own page; patch newPage once to seed __evmap.
  const origNewPage = browser.newPage.bind(browser);
  browser.newPage = async (opts) => { const p = await origNewPage(opts); await p.addInitScript(m => { window.__evmap = m; }, evmap); return p; };
  const n = await run(browser, 'n');
  browser.newPage = origNewPage;

  const diffs = [];
  let handlersWithCalls = 0, total = 0;
  for (const k of Object.keys(o.out.perEl)) {
    const a = o.out.perEl[k], b = n.out.perEl[k];
    if (!b) { diffs.push(k + ': missing in converted page'); continue; }
    for (const t of Object.keys(a.trials)) {
      total++;
      const A = JSON.stringify(a.trials[t]), B = JSON.stringify(b.trials[t]);
      if (A !== B) diffs.push(`#${k} <${a.tag}${a.id ? '#' + a.id : ''}> ${t}\n    orig: ${A}\n    conv: ${B}`);
      else if (a.trials[t].calls && a.trials[t].calls.length) handlersWithCalls++;
    }
  }
  const silent = Object.entries(o.out.perEl).filter(([k, v]) => !Object.values(v.trials).some(t => t.calls && t.calls.length)).map(([k, v]) => '#' + k + ' ' + v.tag + (v.id ? '#' + v.id : ''));

  // Scenario checks on the converted page only (property-semantics elements).
  const p = await origNewPage({ viewport: { width: 1300, height: 900 } });
  await p.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
  await p.goto(`http://127.0.0.1:${srv.address().port}/n/#/live`, { waitUntil: 'load' });
  await p.waitForTimeout(1200);
  const scen = await p.evaluate(() => {
    const log = []; const out = {};
    ['confirmSendXnt', 'closeSendXntModal', 'focusCompareSearch', 'confirmWithdrawXnt', 'closeWithdrawXntModal'].forEach(nm => { window[nm] = () => log.push(nm); });
    const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const send = document.getElementById('sendConfirmBtn'); send.disabled = false;
    log.length = 0; click(send); out.sendInitial = log.join(',');
    send.onclick = window.closeSendXntModal;            // what manage.js does after a successful send
    log.length = 0; click(send); out.sendAfterSuccess = log.join(',');
    const w = document.getElementById('withdrawConfirmBtn'); w.disabled = false;
    w.onclick = window.closeWithdrawXntModal; log.length = 0; click(w); out.withdrawAfterSuccess = log.join(',');
    const slot = document.getElementById('compareSlot0');
    log.length = 0; click(slot); out.slotEmpty = log.join(',');
    slot.onclick = null; log.length = 0; click(slot); out.slotFilled = log.join(',') || '(nothing)';
    out.anyDataActionOnPropertyEls = ['sendConfirmBtn', 'withdrawConfirmBtn', 'compareSlot0', 'mergeStakesConfirmBtn'].filter(id => document.getElementById(id).hasAttribute('data-action'));
    return out;
  });

  console.log(JSON.stringify({
    handlerElements: { orig: o.out.count, conv: n.out.count },
    trials: total, trialsWithCalls: handlersWithCalls,
    inlineHandlersLeft: { orig: o.out.inlineLeft, conv: n.out.inlineLeft },
    fontMedia: { orig: o.out.fontMedia, conv: n.out.fontMedia },
    functionsNotDefinedAtLoad: { orig: o.out.missingFns, conv: n.out.missingFns },
    elementsWithNoSpiedCall: silent,
    scenarios: scen,
  }, null, 1));
  console.log('DIFFERENCES (' + diffs.length + '):'); diffs.forEach(d => console.log('  ' + d));
  console.log('page errors orig:', o.errors, '\npage errors conv:', n.errors, '\n[Actions] warnings conv:', n.warns);
  await browser.close(); srv.close();
})();
