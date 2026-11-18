// Offline test of SNAPSHOT MODE (audit 2026-11-17 #12, js/core.js "RPC OUTAGE → SNAPSHOT MODE").
// The site has one live source, rpc.mainnet.x1.xyz. When it does not answer, the validator list
// is built from the hourly snapshot the site publishes (data/terminal.json + scores / rewards),
// a banner says so, and the RPC is retried every 45 s. This suite checks, with a switchable RPC:
//   1. RPC down from the start: banner, list = the snapshot minus dust accounts, stats bar,
//      a lookup card with honest tiles ("—" where only the RPC knows, published values where the
//      files have them), no RPC call from the card loader, Data Center, leaderboards.
//   2. The RPC comes back: the site's own retry timer picks it up (nothing is called by the
//      test), the list is live again, the banner offers a reload, the button reloads.
//   3. A refresh fails while a live list exists: the live list stays, the banner says how old.
//   4. No usable snapshot (missing / older than a week): the banner says data is unavailable.
//   5. The RPC hangs instead of failing: the snapshot appears after 12 s ("has not answered yet"),
//      and live data replaces it once the RPC answers.
//   6. RPC fine: no banner, no snapshot flag. 0 inline handlers, 0 page errors, 0 [Actions] warnings.
// The sections run side by side (each in its own browser context) and report in order.
//   node scripts/c2-tests/rpc-outage-test.js /path/to/repo
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

const terminal = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/terminal.json')));
const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/rewards.json')));
const scores = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/scores.json')));
const ti = Object.fromEntries(terminal.validatorFields.map((f, i) => [f, i]));
// Second implementation of the list: every row except delinquent ones under 100 XNT ("dust")
const isDust = (r) => !!r[ti.delinquent] && Number(r[ti.activatedStake]) < 100e9;
const expected = terminal.validators.filter(r => !isDust(r)).sort((a, b) => Number(b[ti.activatedStake]) - Number(a[ti.activatedStake]));
const expDelinquent = expected.filter(r => r[ti.delinquent]).length;
// Subject: the largest non-X1-Labs validator that is voting, has a score, ledger rewards and published skip history
const subject = expected.find(r => !r[ti.x1Labs] && !r[ti.delinquent] && scores.validators[r[ti.votePubkey]] && typeof scores.validators[r[ti.votePubkey]].skipEpochs === 'number' &&
  ledger.validators[r[ti.votePubkey]] && ledger.validators[r[ti.votePubkey]].v[ledger.epochs.length - 1] != null);
const VOTE = subject[ti.votePubkey], NODE = subject[ti.nodePubkey], NAME = subject[ti.name], RANK = expected.indexOf(subject) + 1;
const LE = ledger.epochs.length - 1, le = ledger.validators[VOTE];
const expEarned = ((le.v[LE] || 0) + ((le.s && le.s[LE]) || 0)) / 1e9;
const canon = scores.validators[VOTE];

let fails = 0;
// Each section collects its lines; they are printed in section order at the end.
const section = (title) => { const lines = ['' + title]; const check = (ok, label, extra) => { lines.push((ok ? '  ✓ ' : '  ✗ ') + label + (ok || extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 500))); if (!ok) fails++; }; return { lines, check }; };

(async () => {
  await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const browser = await chromium.launch();
  const pageErrors = [], warnings = [];
  // One context per scenario; `rpc.up` switches the mocked RPC on and off, `rpc.calls` counts methods.
  async function open(hash, rpc, portfolio, snapshotBody) {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    await ctx.addInitScript((pf) => { try { localStorage.setItem('x1_validator_hq_disclaimer_accepted', JSON.stringify({ version: '1.0', acceptedAt: new Date().toISOString() })); if (pf) localStorage.setItem('x1Portfolio', JSON.stringify(pf)); } catch (e) {} }, portfolio || null);
    const page = await ctx.newPage();
    page.on('pageerror', e => pageErrors.push(e.message));
    page.on('console', m => { const t = m.text(); if (/\[Actions\]/.test(t)) warnings.push(t); });
    await page.route(/^(?!http:\/\/127\.0\.0\.1)/, async r => {
      const u = r.request().url();
      if (!/rpc\.mainnet\.x1\.xyz/.test(u) || r.request().method() !== 'POST') return r.abort();
      let body; try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) { body = {}; }
      for (const q of (Array.isArray(body) ? body : [body])) rpc.calls[q.method] = (rpc.calls[q.method] || 0) + 1;
      if (rpc.hang) return;                       // never answered: the page's own 20 s timeout ends it
      if (!rpc.up) return r.abort();
      const one = (q) => {
        const ok = (result) => ({ jsonrpc: '2.0', id: q.id, result });
        switch (q.method) {
          case 'getVoteAccounts': return ok({ current: [{ votePubkey: VOTE, nodePubkey: NODE, activatedStake: Number(subject[ti.activatedStake]), commission: 10, epochVoteAccount: true, epochCredits: [[446, 1500000000, 1496600000], [447, 1501000000, 1500000000]], lastVote: 96100000, rootSlot: 96099900 }], delinquent: [] });
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
      r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) });
    });
    // snapshotBody: 404 or a JSON string served instead of data/terminal.json (this context only)
    if (snapshotBody !== undefined) await page.route(/\/data\/terminal\.json/, r => snapshotBody === 404 ? r.fulfill({ status: 404, body: '' }) : r.fulfill({ status: 200, contentType: 'application/json', body: snapshotBody }));
    await page.goto(`http://127.0.0.1:${port}/${hash}`, { waitUntil: 'domcontentloaded' });
    return { ctx, page };
  }
  const state = (page) => page.evaluate(() => {
    const b = document.getElementById('rpcOutageBanner'), btn = document.getElementById('rpcOutageReload');
    const t = (id) => { const e = document.getElementById(id); return e ? e.textContent.trim() : null; };
    return { banner: b && !b.hidden && getComputedStyle(b).display !== 'none' ? b.innerText.replace(/\s+/g, ' ').trim() : null, ok: !!b && b.classList.contains('rpc-outage-ok'), reload: !!btn && !btn.hidden,
      outage: window.rpcOutage ? { mode: window.rpcOutage.mode, snapshotAt: window.rpcOutage.snapshotAt, epoch: window.rpcOutage.epoch } : null,
      n: allValidators.length, snap: allValidators.filter(v => v.fromSnapshot).length, first: allValidators[0] ? allValidators[0].votePubkey : null,
      stats: { validators: t('totalValidators'), active: t('activeValidators'), delinquent: t('delinquentValidators'), stake: t('totalStake') } };
  });
  const tiles = (page) => page.evaluate(() => { const c = document.querySelector('#validatorResults .validator-card, .validator-card'); if (!c) return null;
    const o = {}; for (const e of c.querySelectorAll('.stat-item')) { const l = (e.querySelector('.stat-label') || {}).textContent; if (l) o[l.trim().replace(/\s+/g, ' ').replace(/ \?$/, '')] = [((e.querySelector('.stat-value') || {}).textContent || '').trim().replace(/\s+/g, ' '), ((e.querySelector('.stat-subtext') || {}).textContent || '').trim().replace(/\s+/g, ' ')]; }
    return { tiles: o, head: c.innerText.replace(/\s+/g, ' ').slice(0, 90), pace: !!c.querySelector('.cred-pct-badge'), inline: [...c.querySelectorAll('*')].filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).length }; });

  // ── 1. RPC down from the start ──
  const run1 = async () => {
  const { lines, check } = section('1. RPC down from the start');
  const rpc1 = { up: false, calls: {} };
  let { ctx, page } = await open('', rpc1);
  await page.waitForFunction(() => window.rpcOutage && allValidators.length > 0, null, { timeout: 30000 }).catch(() => {});
  let s = await state(page);
  check(s.outage && s.outage.mode === 'snapshot' && s.outage.snapshotAt === terminal.generatedAt, 'snapshot mode is on, stamped with the snapshot\'s generatedAt', s.outage);
  check(/The X1 RPC is not answering\. Showing the hourly snapshot from .+ago/.test(s.banner || '') && /Retrying automatically/.test(s.banner || '') && !s.reload && !s.ok, 'banner: RPC not answering, snapshot age, retrying; no reload button yet', s.banner);
  check(s.n === expected.length && s.snap === s.n && s.first === expected[0][ti.votePubkey], `validator list = the snapshot without dust accounts (${expected.length} of ${terminal.validators.length}), largest stake first`, { n: s.n, snap: s.snap });
  check(s.stats.validators === String(expected.length) && s.stats.delinquent === String(expDelinquent) && s.stats.active === String(expected.length - expDelinquent) && /\d/.test(s.stats.stake), 'stats bar: validators / active / delinquent / total stake from the snapshot', s.stats);
  check(s.outage.epoch === ledger.currentEpoch, 'the snapshot epoch comes from the ledger (' + ledger.currentEpoch + ')', s.outage);

  // lookup of the subject: the card loader must not touch the RPC
  await page.waitForTimeout(1500);
  const before = Object.assign({}, rpc1.calls);
  await page.evaluate((v) => { location.hash = '#/lookup/' + v; }, VOTE);
  await page.waitForSelector('#validatorResults .validator-card', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const c = await tiles(page);
  check(c && c.head.includes(NAME) && new RegExp('#' + RANK + ' of ' + expected.length).test(c.head), `lookup card renders: ${NAME}, rank #${RANK} of ${expected.length}`, c && c.head);
  const T = (c && c.tiles) || {};
  check(T['Rewards balance'] && T['Rewards balance'][0] === '—' && /needs the live RPC/.test(T['Rewards balance'][1]), 'Rewards balance: "—", "needs the live RPC" (not 0.00)', T['Rewards balance']);
  check(T['Earned last epoch'] && Math.abs(parseFloat(T['Earned last epoch'][0].replace(/,/g, '')) - expEarned) < 0.006 && new RegExp('#' + ledger.epochs[LE]).test(T['Earned last epoch'][1]), `Earned last epoch from the ledger (${expEarned.toFixed(2)} XNT, epoch ${ledger.epochs[LE]})`, T['Earned last epoch']);
  check(T['Delegator APR'] && /^\d+\.\d\d%$/.test(T['Delegator APR'][0]), 'Delegator APR is filled (ledger)', T['Delegator APR']);
  check(T['Skip rate'] && Math.abs(parseFloat(T['Skip rate'][0]) - canon.skipRate7d) < 0.006 && new RegExp(canon.skipEpochs + '-epoch average').test(T['Skip rate'][1]), `Skip rate from the published scores (${canon.skipRate7d}%, ${canon.skipEpochs} epochs)`, T['Skip rate']);
  check(T['Epoch credits'] && T['Epoch credits'][0] !== '—' && /\d/.test(T['Epoch credits'][0]) && !c.pace, 'Epoch credits: the published lifetime counter, no "pace" badge (this epoch is unknown)', T['Epoch credits']);
  check(T['Performance, 7d'] && Math.abs(parseFloat(T['Performance, 7d'][0]) - canon.score) < 0.006, 'Performance score = the published score (' + canon.score + ')', T['Performance, 7d']);
  const cardCalls = ['getBalance', 'getBlockProduction', 'getAccountInfo', 'getInflationReward', 'getEpochInfo'].filter(m => (rpc1.calls[m] || 0) > (before[m] || 0));
  check(cardCalls.length === 0, 'the card loader made no RPC call (balance, credits, skip rate, rewards, epoch)', cardCalls);
  check(c && c.inline === 0, '0 inline handlers in the card');

  // a validator that is not in the snapshot → the normal "not found", not a hang
  await page.evaluate(() => { location.hash = '#/lookup/So11111111111111111111111111111111111111112'; });
  await page.waitForTimeout(4000);
  const nf = await page.evaluate(() => { const e = document.getElementById('errorMessage'); return e && getComputedStyle(e).display !== 'none' ? e.innerText.replace(/\s+/g, ' ') : null; });
  check(/No validators found/.test(nf || ''), 'an address that is not in the snapshot → "No validators found" (no endless "still loading")', nf);

  // leaderboards and Data Center
  await page.evaluate(() => { location.hash = '#/leaderboard'; });
  await page.waitForFunction(() => document.querySelectorAll('#leaderboardTab tr, .leaderboard-row, .leaderboard-item').length > 10, null, { timeout: 20000 }).catch(() => {});
  const lb = await page.evaluate(() => document.querySelectorAll('#leaderboardTab tr, .leaderboard-row, .leaderboard-item').length);
  check(lb > 10, `leaderboards are filled (${lb} rows)`, lb);
  await ctx.close();
  ({ ctx, page } = await open('#/datacenter', { up: false, calls: {} }, [VOTE]));
  await page.waitForSelector('.validator-card', { timeout: 30000 }).catch(() => {});
  const dc = await tiles(page), sdc = await state(page);
  check(dc && dc.head.includes(NAME) && sdc.banner && sdc.outage.mode === 'snapshot', 'My Data Center shows the portfolio card, with the banner', dc && dc.head);
  await ctx.close();

  return lines; };

  // ── 2. The RPC comes back: the site's own retry finds it ──
  const run2 = async () => {
  const { lines, check } = section('2. Recovery (waits for the 45 s retry timer)');
  let ctx, page, s;
  const rpc2 = { up: false, calls: {} };
  ({ ctx, page } = await open('#/lookup/' + VOTE, rpc2));
  await page.waitForFunction(() => window.rpcOutage && window.rpcOutage.mode === 'snapshot', null, { timeout: 30000 }).catch(() => {});
  await page.waitForSelector('#validatorResults .validator-card', { timeout: 20000 }).catch(() => {});
  rpc2.up = true;
  const t0 = Date.now();
  await page.waitForFunction(() => !window.rpcOutage, null, { timeout: 100000, polling: 500 }).catch(() => {});
  const took = (Date.now() - t0) / 1000;
  s = await state(page);
  check(s.outage === null && s.snap === 0 && s.n === 1 && s.first === VOTE, `the retry timer brought live data back after ${took.toFixed(0)} s (list is live, no snapshot entries)`, s);
  check(took < 95, 'recovery happens within two retry periods', took);
  check(s.banner && /answering again/.test(s.banner) && s.ok && s.reload, 'banner turns green: "answering again" + Reload button', s);
  const cardStill = await tiles(page);
  check(cardStill && cardStill.tiles['Rewards balance'][0] === '—', 'the card on screen is still the snapshot one (that is why the banner offers a reload)');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null), page.click('#rpcOutageReload')]);
  await page.waitForSelector('#validatorResults .validator-card', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const live = await tiles(page), sl = await state(page);
  check(sl.banner === null && sl.outage === null && live && /^1\.24$/.test(live.tiles['Rewards balance'][0]) && live.tiles['Rewards balance'][1] === 'XNT', 'Reload: no banner, the card shows the live balance (1.24 XNT)', { banner: sl.banner, t: live && live.tiles['Rewards balance'] });

  // ── 3. A refresh fails while a live list exists ──
  lines.push('3. A refresh fails later');
  rpc2.up = false;
  await page.evaluate(() => loadNetworkStats());
  s = await state(page);
  check(s.outage && s.outage.mode === 'live-kept' && s.n === 1 && s.snap === 0, 'the live list is kept (it is newer than the snapshot)', s);
  check(/Figures are from the last successful update, .+ago/.test(s.banner || '') && !s.reload && !s.ok, 'banner: figures from the last successful update', s.banner);
  rpc2.up = true;
  // the circuit breaker may be open for up to 30 s; the retry timer runs every 45 s
  await page.waitForFunction(() => !window.rpcOutage, null, { timeout: 100000, polling: 500 }).catch(() => {});
  s = await state(page);
  check(s.outage === null && s.banner === null, 'recovered: the banner disappears without a reload prompt (nothing on screen came from the snapshot)', s);
  await ctx.close();

  return lines; };

  // ── 4. No usable snapshot ──
  const run4 = async () => {
  const { lines, check } = section('4. No usable snapshot');
  let ctx, page, s;
  ({ ctx, page } = await open('#/lookup/' + VOTE, { up: false, calls: {} }, null, 404));
  await page.waitForFunction(() => window.rpcOutage, null, { timeout: 30000 }).catch(() => {});
  s = await state(page);
  check(s.outage && s.outage.mode === 'none' && s.n === 0 && /no snapshot could be loaded/.test(s.banner || ''), 'snapshot missing → banner says validator data is unavailable, list stays empty', s);
  await ctx.close();
  const old = JSON.parse(JSON.stringify(terminal)); old.generatedAt = new Date(Date.now() - 8 * 24 * 3600e3).toISOString();
  ({ ctx, page } = await open('', { up: false, calls: {} }, null, JSON.stringify(old)));
  await page.waitForFunction(() => window.rpcOutage, null, { timeout: 30000 }).catch(() => {});
  s = await state(page);
  check(s.outage && s.outage.mode === 'none' && s.n === 0, 'a snapshot older than a week is not used', s);
  await ctx.close();
  const tiny = JSON.parse(JSON.stringify(terminal)); tiny.generatedAt = new Date().toISOString(); tiny.validators = tiny.validators.slice(0, 20);
  ({ ctx, page } = await open('', { up: false, calls: {} }, null, JSON.stringify(tiny)));
  await page.waitForFunction(() => window.rpcOutage, null, { timeout: 30000 }).catch(() => {});
  s = await state(page);
  check(s.outage && s.outage.mode === 'none' && s.n === 0, 'a snapshot with 20 validators is not used', s);
  await ctx.close();
  return lines; };

  // ── 5. The RPC hangs: requests are accepted and never answered ──
  const run5 = async () => {
  const { lines, check } = section('5. The RPC hangs');
  const rpc5 = { up: true, hang: true, calls: {} };
  const t0 = Date.now();
  const { ctx, page } = await open('#/lookup/' + VOTE, rpc5);
  await page.waitForFunction(() => window.rpcOutage && allValidators.length > 0, null, { timeout: 40000, polling: 250 }).catch(() => {});
  const took = (Date.now() - t0) / 1000;
  let s = await state(page);
  check(s.outage && s.outage.mode === 'snapshot' && s.n === expected.length && took < 18, `no answer → the snapshot is shown after ${took.toFixed(0)} s (limit 12 s + load), not after the 20 s request timeout`, { took, o: s.outage, n: s.n });
  check(/The X1 RPC has not answered yet\. Showing the hourly snapshot/.test(s.banner || ''), 'banner: "has not answered yet"', s.banner);
  await page.waitForSelector('#validatorResults .validator-card', { timeout: 30000 }).catch(() => {});
  const c5 = await tiles(page);
  check(c5 && c5.head.includes(NAME) && c5.tiles['Rewards balance'][0] === '—', 'the deep-linked lookup card appears from the snapshot');
  rpc5.hang = false;
  await page.waitForFunction(() => !window.rpcOutage, null, { timeout: 130000, polling: 500 }).catch(() => {});
  s = await state(page);
  check(s.outage === null && s.snap === 0 && s.n === 1 && s.ok && s.reload, 'the RPC answers → live list, green banner with Reload', s);
  await ctx.close();
  return lines; };

  // ── 6. RPC fine ──
  const run6 = async () => {
  const { lines, check } = section('6. RPC fine');
  let ctx, page, s;
  ({ ctx, page } = await open('#/lookup/' + VOTE, { up: true, calls: {} }));
  await page.waitForSelector('#validatorResults .validator-card', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);
  s = await state(page); const ok = await tiles(page);
  check(s.outage === null && s.banner === null && s.snap === 0 && s.n === 1, 'no banner, no snapshot entries', s);
  check(ok && /^1\.24$/.test(ok.tiles['Rewards balance'][0]) && ok.tiles['Rewards balance'][1] === 'XNT', 'the card shows the live balance', ok && ok.tiles['Rewards balance']);
  const inlineBanner = await page.evaluate(() => [...document.getElementById('rpcOutageBanner').querySelectorAll('*'), document.getElementById('rpcOutageBanner')].filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).length);
  check(inlineBanner === 0 && await page.evaluate(() => Actions.has('rpc-outage-reload')), 'banner markup has no inline handler; its action is registered');
  await ctx.close();
  return lines; };

  const out = await Promise.all([run1(), run2(), run4(), run5(), run6()]);
  const { lines: last, check } = section('All sections');
  check(pageErrors.length === 0, '0 page errors', pageErrors.slice(0, 3));
  check(warnings.length === 0, '0 [Actions] warnings', warnings.slice(0, 3));
  console.log(out.concat([last]).map(l => l.join('\n')).join('\n'));
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
