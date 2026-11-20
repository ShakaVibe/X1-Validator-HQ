// Offline test of the Validator Terminal's self-stake percentile section
// (2026-11-20, `pctSectionHtml` in js/terminal.js): the distribution strip,
// the seven value cells, P85 as the highlighted key metric, the Delegation
// Program minimum from data/delegation.json (and its absence), the visitor's
// Data Center diamonds, escaping of validator names, the 375 px layout.
// Values are checked against an independent calculation over the served
// data/terminal.json + data/delegation.json.
//   node scripts/c2-tests/pct-strip-test.js /path/to/repo
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

const terminalRaw = fs.readFileSync(path.join(ROOT, 'data/terminal.json'), 'utf8');
const terminal = JSON.parse(terminalRaw);
const deleg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/delegation.json'), 'utf8'));
const F = Object.fromEntries(terminal.validatorFields.map((f, i) => [f, i]));

// Independent calculation: non-dust, non-X1 validators; self = non-pool stake.
const selfBy = {};
for (const [vote, list] of Object.entries(terminal.stakes)) {
  if (!vote) continue;
  for (const s of list) if (!s[4]) selfBy[vote] = (selfBy[vote] || 0) + Number(s[1] || 0);
}
const vals = terminal.validators.filter(v => !(v[F.delinquent] && Number(v[F.activatedStake] || 0) < 100e9));
const nonX1 = vals.filter(v => !v[F.x1Labs]);
const S = nonX1.map(v => (selfBy[v[F.votePubkey]] || 0) / 1e9).sort((a, b) => a - b);
const pctl = p => { const i = p / 100 * (S.length - 1), lo = Math.floor(i), hi = Math.ceil(i); return S[lo] + (S[hi] - S[lo]) * (i - lo); };
const expectedCells = [50, 75, 85, 90, 95, 99].map(pctl).concat([S[S.length - 1]]).map(v => Math.round(v));
const MIN = Number(deleg.config.minSelfStake) / 1e9;
const nearMin = S.filter(x => x >= MIN && x < MIN + 1000).length, below = S.filter(x => x < MIN).length;
const atOrAboveP85 = S.filter(x => x >= pctl(85) - 1e-6).length;
const withSelf = nonX1.filter(v => (selfBy[v[F.votePubkey]] || 0) > 0).map(v => v[F.votePubkey]);
const x1Vote = vals.find(v => v[F.x1Labs])[F.votePubkey];
const portfolio = [withSelf[0], withSelf[withSelf.length - 1], x1Vote];   // 2 diamonds expected (X1 Labs is not in the strip)

let fails = 0;
const check = (ok, label, extra) => { console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok || extra === undefined ? '' : ' — ' + JSON.stringify(extra))); if (!ok) fails++; };
const num = s => Number(String(s).replace(/[^0-9.]/g, ''));

async function openTerminal(browser, { width, portfolio: pf, routes }) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  if (pf) await ctx.addInitScript(p => localStorage.setItem('x1Portfolio', JSON.stringify(p)), pf);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
  for (const [re, fn] of routes || []) await page.route(re, fn);
  await page.goto(`http://127.0.0.1:${srv.address().port}/#/terminal`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { const m = document.getElementById('disclaimerModal'); if (m) m.style.display = 'none'; });
  await page.waitForSelector('#vtPct .vt-pcell', { timeout: 30000 });
  return { ctx, page, errors };
}

(async () => {
  await new Promise(r => srv.listen(0, r));
  const browser = await chromium.launch();

  // ── 1. Served data, Data Center list in this test browser only ──
  console.log('Served data, 1300 px');
  {
    const { ctx, page, errors } = await openTerminal(browser, { width: 1300, portfolio });
    await page.waitForFunction(() => !!document.querySelector('#vtPct .vt-smin'), null, { timeout: 20000 }).catch(() => {});
    const r = await page.evaluate(() => {
      const s = document.getElementById('vtPct');
      const pos = el => parseFloat(el.style.left);
      return {
        cells: [...s.querySelectorAll('.vt-pcell')].map(c => ({ k: c.querySelector('.vt-ppill').textContent, v: c.querySelector('.v').firstChild.textContent, key: c.classList.contains('is-key'), title: c.title })),
        keySub: (s.querySelector('.vt-pcell.is-key .sub') || {}).textContent || '',
        dots: s.querySelectorAll('.vt-sdot').length, low: s.querySelectorAll('.vt-sdot.low').length,
        marks: [...s.querySelectorAll('.vt-smark')].map(m => ({ k: m.textContent, key: m.classList.contains('is-key'), up: m.classList.contains('up') })),
        keyLines: s.querySelectorAll('.vt-sline.is-key').length, lines: s.querySelectorAll('.vt-sline').length,
        minLeft: s.querySelector('.vt-smin') ? pos(s.querySelector('.vt-smin')) : null,
        maxLeft: pos([...s.querySelectorAll('.vt-sline')].pop()),
        facts: s.querySelector('.vt-facts').textContent,
        me: s.querySelectorAll('.vt-sme').length, legend: s.querySelector('.vt-slegend').textContent,
        inline: [...s.querySelectorAll('*')].filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).length,
        cut: [...s.querySelectorAll('.vt-pcell .v')].filter(e => e.scrollWidth > e.clientWidth + 1).length,
      };
    });
    check(r.cells.length === 7 && r.cells.map(c => c.k).join() === 'P50,P75,P85,P90,P95,P99,MAX', '7 cells P50 … MAX', r.cells.map(c => c.k));
    check(JSON.stringify(r.cells.map(c => num(c.v))) === JSON.stringify(expectedCells), 'cell values = independent percentiles (whole XNT)', { got: r.cells.map(c => num(c.v)), want: expectedCells });
    check(r.cells.filter(c => c.key).map(c => c.k).join() === 'P85', 'P85 is the only key cell');
    check(/^P85 · [\d,]+\.?\d* XNT$/.test(r.cells[2].title), 'key cell title carries the exact value', r.cells[2].title);
    check(r.keySub.includes(atOrAboveP85 + ' of ' + S.length), 'key cell: "N of M validators at or above"', { got: r.keySub, want: atOrAboveP85 });
    check(r.dots === S.length, 'one dot per non-X1 validator', { got: r.dots, want: S.length });
    check(r.low === below, 'dots below the minimum are muted', { got: r.low, want: below });
    const km = r.marks.find(m => m.k === 'P85');
    check(km && km.key && !km.up && r.marks.filter(m => m.key).length === 1, 'P85 marker solid, on the lower row');
    check(r.lines === 7 && r.keyLines === 1, '7 marker lines, one key line');
    check(Math.abs(r.minLeft - MIN / (S[S.length - 1] * 1.02) * 100) < 0.01, 'minimum line at minSelfStake (lamports → XNT)', r.minLeft);
    check(Math.abs(r.maxLeft - 100 / 1.02) < 0.01, 'MAX line at max / (max × 1.02)', r.maxLeft);
    check(r.facts.includes(S.length + ' validators') && r.facts.includes(nearMin + ' at') && r.facts.includes(below + ' below'), 'header facts', { got: r.facts, want: [S.length, nearMin, below] });
    check(r.me === 2 && r.legend.includes('your validators'), 'diamonds for the 2 non-X1 Data Center validators (X1 Labs one left out)', r.me);
    check(r.inline === 0, '0 inline handlers in the section');
    check(r.cut === 0, 'no value cut off');
    check(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  }

  // ── 2. No delegation snapshot + a hostile validator name ──
  console.log('No delegation.json, hostile name');
  {
    const t = JSON.parse(terminalRaw);
    const victim = t.validators.find(v => !v[F.x1Labs] && (selfBy[v[F.votePubkey]] || 0) > 0);
    victim[F.name] = `Evil "<b id=pwn>x</b>&'name`;
    const { ctx, page, errors } = await openTerminal(browser, { width: 1300, routes: [
      [/\/data\/delegation\.json/, r => r.fulfill({ status: 404, body: '' })],
      [/\/data\/terminal\.json/, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(t) })],
    ] });
    await page.waitForTimeout(1500);
    const r = await page.evaluate(v => {
      const s = document.getElementById('vtPct');
      const dot = [...s.querySelectorAll('.vt-sdot')].find(d => d.title.startsWith('Evil'));
      return { min: s.querySelectorAll('.vt-smin, .vt-sminlbl').length, gold: s.querySelectorAll('.vt-fact.gold').length,
        legend: s.querySelector('.vt-slegend').textContent, cells: s.querySelectorAll('.vt-pcell').length,
        pwn: !!document.getElementById('pwn'), title: dot ? dot.title : null, low: s.querySelectorAll('.vt-sdot.low').length };
    });
    check(r.min === 0 && r.gold === 0 && !/minimum/.test(r.legend) && r.low === 0, 'no minimum line, fact or legend without the snapshot');
    check(r.cells === 7, 'cells still drawn');
    check(!r.pwn && r.title && r.title.startsWith(`Evil "<b id=pwn>x</b>&'name · `), 'name stays text (title attribute, nothing injected)', r.title);
    check(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  }

  // ── 2b. Delegation snapshot arrives after the Terminal has drawn ──
  console.log('Late delegation.json');
  {
    const { ctx, page, errors } = await openTerminal(browser, { width: 1300, routes: [
      [/\/data\/delegation\.json/, async r => { await new Promise(z => setTimeout(z, 4000)); r.continue(); }],
    ] });
    const before = await page.evaluate(() => ({ min: document.querySelectorAll('#vtPct .vt-smin').length, cfg: !!window.delegationConfig }));
    await page.waitForFunction(() => !!document.querySelector('#vtPct .vt-smin'), null, { timeout: 15000 }).catch(() => {});
    const after = await page.evaluate(() => ({ min: document.querySelectorAll('#vtPct .vt-smin').length, sections: document.querySelectorAll('#vtPct').length,
      table: document.querySelectorAll('#vtTbl tbody tr').length }));
    check(!before.cfg && before.min === 0, 'first draw has no minimum line', before);
    check(after.min === 1 && after.sections === 1 && after.table > 0, 'section redrawn with the line once the snapshot arrives; table untouched', after);
    check(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  }

  // ── 3. Phone ──
  console.log('375 px');
  {
    const { ctx, page, errors } = await openTerminal(browser, { width: 375 });
    await page.waitForFunction(() => !!document.querySelector('#vtPct .vt-smin'), null, { timeout: 20000 }).catch(() => {});
    const r = await page.evaluate(() => {
      const s = document.getElementById('vtPct'), box = s.getBoundingClientRect();
      const lbl = s.querySelector('.vt-sunder .vt-sminlbl').getBoundingClientRect();
      const cols = getComputedStyle(s.querySelector('.vt-pcells')).gridTemplateColumns.split(' ').length;
      return { docW: document.documentElement.scrollWidth, marks: [...s.querySelectorAll('.vt-smark')].filter(m => getComputedStyle(m).display !== 'none').length,
        cols, lblIn: lbl.left >= box.left && lbl.right <= box.right,
        cut: [...s.querySelectorAll('.vt-pcell .v')].filter(e => e.scrollWidth > e.clientWidth + 1).length };
    });
    check(r.docW <= 375, 'no horizontal overflow', r.docW);
    check(r.marks === 0 && r.cols === 2, 'pills hidden, cells in 2 columns', r);
    check(r.lblIn, 'minimum label inside the card');
    check(r.cut === 0, 'no value cut off');
    check(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  }

  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
