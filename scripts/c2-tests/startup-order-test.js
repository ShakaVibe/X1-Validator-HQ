// Start-up order (2026-11-18) — js/start.js + startSite() at the end of js/modals.js.
// init() used to run at the end of js/modals.js while seven more scripts were still
// to load (terminal, delegation, alerts, fleet, apr, price-pill, forensics). On a slow
// load the first view was rendered without them: a #/terminal or #/delegation link
// opened nothing, the Fleet Health bar and the Delegator APR tile stayed empty.
// Now the site starts from js/start.js, the last script on the page.
//
// Offline: serves the repo with each late script delayed by 0.4 s (they load one after
// the other, so the page is ready about 3 s late), answers the RPC at
// once (so init() is as fast as it can be) and checks
//   1. nothing of init() runs before the last script has been served, and every late
//      module exists when it does;
//   2. #/terminal and #/delegation deep links open their view on that slow load;
//   3. #/datacenter with a one-validator portfolio shows the Fleet Health bar and a
//      filled Delegator APR tile;
//   4. control: the previous arrangement (init() at the end of modals.js, no start.js)
//      fails 2 on the same slow load — so this test can tell the difference;
//   5. cache skew, both ways (Pages caches each file for 10 minutes): an old index.html
//      with the new modals.js still starts (DOMContentLoaded safety net), and a new
//      index.html with an old modals.js starts exactly once.
//   node scripts/c2-tests/startup-order-test.js /path/to/repo
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.argv[2] || '.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
const LATE = ['/js/terminal.js', '/js/delegation.js', '/js/alerts.js', '/js/fleet.js', '/js/apr.js', '/js/price-pill.js', '/js/forensics.js'];
const DELAY_MS = 400;

// Per-run switches + what the server saw
let cfg = { slow: false, oldModals: false, oldIndex: false };
let seen = { lastScriptAt: 0, startJsAt: 0 };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// The previous arrangement, rebuilt from today's files (no git history needed)
const oldStyleModals = () => { const s = read('js/modals.js'); const i = s.indexOf('// ─── START-UP'); if (i < 0) throw new Error('START-UP block not found in js/modals.js'); return s.slice(0, i) + 'init();\n'; };
const oldStyleIndex = () => { const s = read('index.html'); const t = s.replace(/\s*<!-- Starts the site[^>]*-->\s*<script src="js\/start\.js"><\/script>/, ''); if (t === s) throw new Error('start.js tag not found in index.html'); return t; };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(f);
  if (p === '/js/modals.js' && cfg.oldModals) body = Buffer.from(oldStyleModals());
  if (p === '/index.html' && cfg.oldIndex) body = Buffer.from(oldStyleIndex());
  const send = () => {
    if (LATE.includes(p)) seen.lastScriptAt = Date.now();
    if (p === '/js/start.js') seen.startJsAt = Date.now();
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body);
  };
  if (cfg.slow && LATE.includes(p)) return void setTimeout(send, DELAY_MS);
  send();
});

const terminal = JSON.parse(read('data/terminal.json'));
const ti = Object.fromEntries(terminal.validatorFields.map((f, i) => [f, i]));
const ledger = JSON.parse(read('data/rewards.json'));
// A validator for the portfolio: 10 % commission, a full clean reward history
const row = terminal.validators.filter(r => r[ti.commission] === 10 && !r[ti.delinquent] && ledger.validators[r[ti.votePubkey]] && ledger.validators[r[ti.votePubkey]].v.slice(-30).every(x => x > 0)).sort((a, b) => b[ti.activatedStake] - a[ti.activatedStake])[0];
const VOTE = row[ti.votePubkey], NODE = row[ti.nodePubkey];

let fails = 0;
const check = (ok, label, extra) => { console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok || extra === undefined ? '' : ' — ' + JSON.stringify(extra))); if (!ok) fails++; };

(async () => {
  await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const browser = await chromium.launch();

  // One page load. Returns the page plus what the RPC mock saw.
  async function load(hash, opts) {
    cfg = Object.assign({ slow: false, oldModals: false, oldIndex: false }, opts || {});
    seen = { lastScriptAt: 0, startJsAt: 0 };
    const rpc = { initAt: 0, methods: {} };
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    if (opts && opts.portfolio) await ctx.addInitScript((v) => { try { localStorage.setItem('x1Portfolio', JSON.stringify(v)); } catch (e) {} }, opts.portfolio);
    // Which late modules exist when init() makes its first RPC call (getVoteAccounts, from
    // loadNetworkStats; js/price-pill.js polls the RPC on its own, so "any RPC call" would not do)
    await ctx.addInitScript(() => {
      const f = window.fetch;
      window.fetch = function (u, o) {
        if (!window.__atFirstRpc && /rpc\.mainnet\.x1\.xyz/.test(String(u && u.url || u)) && /"getVoteAccounts"/.test(String(o && o.body || ''))) {
          window.__atFirstRpc = { vtOpen: typeof window.vtOpen, delegOpen: typeof window.delegOpen, fleetRender: typeof window.fleetRender, aprHydrate: typeof window.aprHydrate, readyState: document.readyState };
        }
        return f.apply(this, arguments);
      };
    });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.route(/^(?!http:\/\/127\.0\.0\.1)/, async r => {
      const u = r.request().url();
      if (!/rpc\.mainnet\.x1\.xyz/.test(u) || r.request().method() !== 'POST') return r.abort();
      let body; try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) { body = {}; }
      const one = (q) => {
        rpc.methods[q.method] = (rpc.methods[q.method] || 0) + 1;
        if (q.method === 'getVoteAccounts' && !rpc.initAt) rpc.initAt = Date.now();
        const ok = (result) => ({ jsonrpc: '2.0', id: q.id, result });
        switch (q.method) {
          case 'getVoteAccounts': return ok({ current: [{ votePubkey: VOTE, nodePubkey: NODE, activatedStake: row[ti.activatedStake], commission: 10, epochVoteAccount: true, epochCredits: [[446, 1500000000, 1496600000]], lastVote: 96100000, rootSlot: 96099900 }], delinquent: [] });
          case 'getEpochInfo': return ok({ absoluteSlot: 96100000, blockHeight: 95000000, epoch: 447, slotIndex: 100000, slotsInEpoch: 216000, transactionCount: 1 });
          case 'getSlot': return ok(96100000);
          case 'getBalance': return ok({ context: { slot: 1 }, value: 1238800000 });
          case 'getClusterNodes': return ok([{ pubkey: NODE, version: '4.0.4' }]);
          case 'getSupply': return ok({ context: { slot: 1 }, value: { total: 1079000000000000000, circulating: 1, nonCirculating: 1, nonCirculatingAccounts: [] } });
          case 'getProgramAccounts': return ok([]);
          case 'getRecentPerformanceSamples': return ok(Array.from({ length: (q.params || [1])[0] || 1 }, () => ({ slot: 1, numSlots: 164, numTransactions: 1, numNonVoteTransactions: 1, samplePeriodSecs: 60 })));
          case 'getBlockProduction': return ok({ context: { slot: 1 }, value: { byIdentity: {}, range: { firstSlot: 1, lastSlot: 2 } } });
          case 'getAccountInfo': return ok({ context: { slot: 1 }, value: null });
          case 'getMultipleAccounts': return ok({ context: { slot: 1 }, value: [] });
          case 'getInflationReward': return ok([]);
          case 'getLeaderSchedule': return ok({});
          default: return ok(null);
        }
      };
      const out = Array.isArray(body) ? body.map(one) : one(body);
      r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(out) });
    });
    await page.goto(`http://127.0.0.1:${port}/${hash}`, { waitUntil: 'load' });
    await page.evaluate(() => { const m = document.getElementById('disclaimerModal'); if (m) m.style.display = 'none'; });
    await page.waitForTimeout(2500);                 // init(), the router and the first renders
    return { page, rpc, errs, seen: Object.assign({}, seen), close: () => ctx.close() };
  }
  const terminalOpen = (page) => page.evaluate(() => ({ active: document.body.classList.contains('active-vtterminal'), rows: document.querySelectorAll('#vtContent table.vt-data tbody tr').length }));
  const delegationOpen = (page) => page.evaluate(() => ({ rows: document.querySelectorAll('#delegTable tr').length, shown: getComputedStyle(document.getElementById('delegationTab')).display }));

  // ── 1 + 2. Slow load, the new arrangement ─────────────────────────────────────────────────
  console.log('1. Slow load: init() waits for the last script');
  const a = await load('#/terminal', { slow: true });
  const at = await a.page.evaluate(() => window.__atFirstRpc);
  check(a.rpc.initAt > 0 && a.seen.lastScriptAt > 0 && a.rpc.initAt >= a.seen.lastScriptAt && a.rpc.initAt >= a.seen.startJsAt, `init()'s first RPC call (getVoteAccounts) comes after the last script was served (+${a.rpc.initAt - a.seen.lastScriptAt} ms)`, { rpc: a.rpc.initAt, last: a.seen.lastScriptAt, start: a.seen.startJsAt });
  check(at && at.vtOpen === 'function' && at.delegOpen === 'function' && at.fleetRender === 'function' && at.aprHydrate === 'function', 'terminal, delegation, fleet and APR modules all exist when init() starts', at);
  check(at && at.readyState === 'loading', 'and it does not wait for DOMContentLoaded (deferred Chart.js / web3.js cannot hold it up)', at);
  console.log('2. Deep links on a slow load');
  const ta = await terminalOpen(a.page);
  check(ta.active && ta.rows > 100, `#/terminal opens the Validator Terminal (${ta.rows} rows)`, ta);
  check(a.errs.length === 0, 'page errors: ' + JSON.stringify(a.errs));
  await a.close();
  const b = await load('#/delegation', { slow: true });
  const db = await delegationOpen(b.page);
  check(db.rows > 100 && db.shown !== 'none', `#/delegation opens the Delegation tab (${db.rows} rows)`, db);
  check(b.errs.length === 0, 'page errors: ' + JSON.stringify(b.errs));
  await b.close();

  // ── 3. Data Center deep link with a portfolio ─────────────────────────────────────────────
  console.log('3. #/datacenter with a one-validator portfolio, slow load');
  const c = await load('#/datacenter', { slow: true, portfolio: [VOTE] });
  await c.page.waitForFunction(() => document.querySelector('#portfolioValidatorResults .validator-card'), null, { timeout: 15000 }).catch(() => {});
  await c.page.waitForTimeout(1500);
  const dc = await c.page.evaluate(() => ({ cards: document.querySelectorAll('#portfolioValidatorResults .validator-card').length, fleet: !!document.querySelector('#fleetHealth .fleet-bar'), fleetText: ((document.getElementById('fleetHealth') || {}).innerText || '').replace(/\s+/g, ' ').slice(0, 50), apr: (document.querySelector('#portfolioValidatorResults .apr-section .stat-value') || {}).textContent, portfolio: (typeof myPortfolio !== 'undefined' ? myPortfolio.length : null), tab: ((document.querySelector('.tab.active') || {}).textContent || '').replace(/\s+/g, ' ').trim(), text: ((document.getElementById('portfolioValidatorResults') || {}).innerText || '').replace(/\s+/g, ' ').slice(0, 160) }));
  check(dc.cards === 1, 'the portfolio card renders', dc);
  check(dc.fleet, 'the Fleet Health bar is there', dc);
  check(/%/.test(dc.apr || ''), `the Delegator APR tile is filled (${dc.apr})`, dc);
  check(c.errs.length === 0, 'page errors: ' + JSON.stringify(c.errs));
  await c.close();

  // ── 4. Control: the previous arrangement on the same slow load ────────────────────────────
  console.log('4. Control: init() at the end of modals.js, no start.js');
  const o = await load('#/terminal', { slow: true, oldModals: true, oldIndex: true });
  const to = await terminalOpen(o.page), ato = await o.page.evaluate(() => window.__atFirstRpc);
  check(o.rpc.initAt > 0 && o.rpc.initAt < o.seen.lastScriptAt && ato && ato.vtOpen === 'undefined', 'init() ran before the late scripts existed', { initBeforeLast: o.rpc.initAt < o.seen.lastScriptAt, ato });
  check(to.rows === 0, '#/terminal opened nothing — the bug this change fixes', to);
  await o.close();
  const o2 = await load('#/delegation', { slow: true, oldModals: true, oldIndex: true });
  const do2 = await delegationOpen(o2.page);
  check(do2.rows === 0, '#/delegation showed an empty tab', do2);
  await o2.close();
  const o3 = await load('#/datacenter', { slow: true, oldModals: true, oldIndex: true, portfolio: [VOTE] });
  await o3.page.waitForTimeout(1500);
  const dc3 = await o3.page.evaluate(() => ({ cards: document.querySelectorAll('#portfolioValidatorResults .validator-card').length, fleet: !!document.querySelector('#fleetHealth .fleet-bar') }));
  check(dc3.cards === 1 && !dc3.fleet, '#/datacenter rendered the card without the Fleet Health bar', dc3);
  await o3.close();

  // ── 5. Cache skew ─────────────────────────────────────────────────────────────────────────
  console.log('5. Mixed old and new files (10-minute cache window after a deploy)');
  const n = await load('#/terminal', {});
  const base = n.rpc.methods.getVoteAccounts || 0;
  check(base >= 1, `reference: new files, fast load → getVoteAccounts called ${base}×`, n.rpc.methods);
  await n.close();
  const s1 = await load('#/terminal', { slow: true, oldIndex: true });
  const t1 = await terminalOpen(s1.page);
  check((s1.rpc.methods.getVoteAccounts || 0) === base && t1.rows > 100, 'old index.html (no start.js) + new modals.js: starts once at DOMContentLoaded, #/terminal opens', { calls: s1.rpc.methods.getVoteAccounts, t1 });
  await s1.close();
  const s2 = await load('#/terminal', { oldModals: true });
  const t2 = await terminalOpen(s2.page);
  check((s2.rpc.methods.getVoteAccounts || 0) === base && t2.rows > 100, 'new index.html + old modals.js: start.js does nothing, the site starts exactly once', { calls: s2.rpc.methods.getVoteAccounts, t2 });
  check(s1.errs.length === 0 && s2.errs.length === 0, 'page errors: ' + JSON.stringify(s1.errs.concat(s2.errs)));
  await s2.close();

  // ── 6. Source: one place starts the site ──────────────────────────────────────────────────
  const idx = read('index.html'), tags = [...idx.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
  const direct = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js')).filter(f => /^\s*init\(\);/m.test(read('js/' + f).split('\n').filter(l => !/^\s{2,}init\(\);/.test(l)).join('\n')));
  check(tags[tags.length - 1] === 'js/start.js', 'js/start.js is the last <script> in index.html', tags.slice(-3));
  check(direct.length === 0, 'no file calls init() at its top level any more', direct);

  await browser.close(); if (srv.closeAllConnections) srv.closeAllConnections(); srv.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
