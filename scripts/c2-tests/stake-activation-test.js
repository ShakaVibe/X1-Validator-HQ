// Offline check of the stake cooldown math + its consumers (Manage Validator stake list,
// Stake Account Details, Withdraw-from-stake modal, Stake classification modal).
// getStakeActivation is gone from X1 4.0.x RPCs; StakeActivation (js/core.js) replays the stake
// program's Delegation::stake_activating_and_deactivating over the StakeHistory sysvar instead.
// Fixture = the real sysvar rows for epochs 395–424 and three real stake accounts of validator
// 9RqMzFzi… captured 2026-10-29 (epoch 425). Oracle: on that day a mainnet simulateTransaction
// accepted a withdraw of exactly 1,774.532777416 XNT from FpxUC1L1… and refused one lamport more,
// i.e. 233.357177042 XNT of its 2,007.89 were still cooling (deactivated in 424; 101.4 M XNT was
// deactivating cluster-wide vs the 9 % cap of 89.6 M).
//   node scripts/c2-tests/stake-activation-test.js /path/to/repo
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.argv[2] || '.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
let fails = 0;
const check = (ok, label, extra) => { console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok || extra === undefined ? '' : ' — ' + JSON.stringify(extra))); if (!ok) fails++; };

const VOTE = '9RqMzFzi7BDWMTGfCZhiBsXvLQjXK5UacAm6nNsyAfNp', NODE = '5NfpgFCwrYzcgJkda9bRJvccycLUo3dvVQsVAK2W43Um';
const WITHDRAWER = 'Ge31BtSCzr6UDTgzv9sEFta4RpzAAfKe9rZi1RPe1v63';
const COOLING = 'FpxUC1L1LktZ6DhkhxbReMzTUxRrYLjNJZp6GafyxRiC';   // deactivated in 424
const DEACT   = '8GHgze7FwSw7hsxQgqcGrQopboVKX5K19NY31GDVvHtP';   // deactivated in 425 (= current)
const ACTIVE  = '45zP7xJptQUgawsJt6dTMaHQhPZHkKoVUFm3CKaZyj3g';
const WARMING = 'WarmUpTestAccount1111111111111111111111111111';
const SYSVAR  = 'SysvarStakeHistory1111111111111111111111111';
const U64MAX  = '18446744073709551615';
const RENT = 2282880;
const HISTORY = [{"epoch":424,"stakeHistory":{"activating":9598265444340503,"deactivating":101414552318800641,"effective":995868251296349863}},{"epoch":423,"stakeHistory":{"activating":41054122391012659,"deactivating":7679225039102461,"effective":962312499656226180}},{"epoch":422,"stakeHistory":{"activating":12389074436048480,"deactivating":40623085561922460,"effective":990371553301384398}},{"epoch":421,"stakeHistory":{"activating":11257368260915744,"deactivating":16387741457099730,"effective":995322992408011886}},{"epoch":420,"stakeHistory":{"activating":10847968479211587,"deactivating":11217829821991302,"effective":995512416993002340}},{"epoch":419,"stakeHistory":{"activating":1724604161131216,"deactivating":10656714015716319,"effective":1004264371824687479}},{"epoch":418,"stakeHistory":{"activating":1725284974135358,"deactivating":871007261091385,"effective":1003228483848343685}},{"epoch":417,"stakeHistory":{"activating":4652549919693742,"deactivating":2493453858537371,"effective":1000887991426949567}},{"epoch":416,"stakeHistory":{"activating":1584888016233894,"deactivating":5325803867141816,"effective":1004447742729634811}},{"epoch":415,"stakeHistory":{"activating":2559115940017757,"deactivating":892674592191812,"effective":1002599534361284793}},{"epoch":414,"stakeHistory":{"activating":2812714289937677,"deactivating":520989597132127,"effective":1000125931831446178}},{"epoch":413,"stakeHistory":{"activating":3983515396143738,"deactivating":3721134523545433,"effective":999681674757294745}},{"epoch":412,"stakeHistory":{"activating":9688906817223521,"deactivating":1876761592221717,"effective":991687660140316854}},{"epoch":411,"stakeHistory":{"activating":9194522429432677,"deactivating":3089298460965590,"effective":985400614423347472}},{"epoch":410,"stakeHistory":{"activating":10408745361414015,"deactivating":1694105460652272,"effective":976503802889617671}},{"epoch":409,"stakeHistory":{"activating":6425261944579186,"deactivating":5853219001476885,"effective":975750111341076982}},{"epoch":408,"stakeHistory":{"activating":5972953025021912,"deactivating":2268637421684891,"effective":971863507110028953}},{"epoch":407,"stakeHistory":{"activating":4545951666420425,"deactivating":33151072027214116,"effective":1000291832603370747}},{"epoch":406,"stakeHistory":{"activating":6217270233780257,"deactivating":476222981999846,"effective":994368451225634299}},{"epoch":405,"stakeHistory":{"activating":35437483584432304,"deactivating":5077220680755405,"effective":963826136420435231}},{"epoch":404,"stakeHistory":{"activating":10378212783604552,"deactivating":25720788806444498,"effective":978990316225663898}},{"epoch":403,"stakeHistory":{"activating":8795970275903695,"deactivating":3693316568672270,"effective":973705337549964225}},{"epoch":402,"stakeHistory":{"activating":7731402288571093,"deactivating":25846281890185499,"effective":991641880833831260}},{"epoch":401,"stakeHistory":{"activating":37031755266176116,"deactivating":43150417082724902,"effective":997585269390250149}},{"epoch":400,"stakeHistory":{"activating":2275576525716282,"deactivating":2104114215352129,"effective":997231506968831382}},{"epoch":399,"stakeHistory":{"activating":119120348750319,"deactivating":309503242426508,"effective":997239235373715645}},{"epoch":398,"stakeHistory":{"activating":235708166541837,"deactivating":114479884193949,"effective":996935270363640793}},{"epoch":397,"stakeHistory":{"activating":1164105859000409,"deactivating":231438907412628,"effective":995819833979719882}},{"epoch":396,"stakeHistory":{"activating":5634525654663287,"deactivating":15537849767722748,"effective":1005542871180472489}},{"epoch":395,"stakeHistory":{"activating":1914846261826826,"deactivating":13918849294299376,"effective":1017366538817635554}}];
const ACCOUNTS = [{"pubkey":"FpxUC1L1LktZ6DhkhxbReMzTUxRrYLjNJZp6GafyxRiC","account":{"lamports":2007892237338,"owner":"Stake11111111111111111111111111111111111111","executable":false,"rentEpoch":0,"space":200,"data":{"parsed":{"info":{"meta":{"authorized":{"staker":"Ge31BtSCzr6UDTgzv9sEFta4RpzAAfKe9rZi1RPe1v63","withdrawer":"Ge31BtSCzr6UDTgzv9sEFta4RpzAAfKe9rZi1RPe1v63"},"lockup":{"custodian":"11111111111111111111111111111111","epoch":0,"unixTimestamp":0},"rentExemptReserve":"2282880"},"stake":{"creditsObserved":1390949466,"delegation":{"activationEpoch":"401","deactivationEpoch":"424","stake":"2007889954458","voter":"9RqMzFzi7BDWMTGfCZhiBsXvLQjXK5UacAm6nNsyAfNp","warmupCooldownRate":0.25}}},"type":"delegated"},"program":"stake","space":200}}},{"pubkey":"8GHgze7FwSw7hsxQgqcGrQopboVKX5K19NY31GDVvHtP","account":{"lamports":4611594273928,"owner":"Stake11111111111111111111111111111111111111","executable":false,"rentEpoch":0,"space":200,"data":{"parsed":{"info":{"meta":{"authorized":{"staker":"AZhRy4DQJ9TsMiWA6NuZzFa1MWDmmgKQn6L5St7tPWBk","withdrawer":"AZhRy4DQJ9TsMiWA6NuZzFa1MWDmmgKQn6L5St7tPWBk"},"lockup":{"custodian":"11111111111111111111111111111111","epoch":0,"unixTimestamp":0},"rentExemptReserve":"2282880"},"stake":{"creditsObserved":1390949466,"delegation":{"activationEpoch":"399","deactivationEpoch":"425","stake":"4611591991048","voter":"9RqMzFzi7BDWMTGfCZhiBsXvLQjXK5UacAm6nNsyAfNp","warmupCooldownRate":0.25}}},"type":"delegated"},"program":"stake","space":200}}},{"pubkey":"45zP7xJptQUgawsJt6dTMaHQhPZHkKoVUFm3CKaZyj3g","account":{"lamports":3011837214582,"owner":"Stake11111111111111111111111111111111111111","executable":false,"rentEpoch":0,"space":200,"data":{"parsed":{"info":{"meta":{"authorized":{"staker":"Ge31BtSCzr6UDTgzv9sEFta4RpzAAfKe9rZi1RPe1v63","withdrawer":"Ge31BtSCzr6UDTgzv9sEFta4RpzAAfKe9rZi1RPe1v63"},"lockup":{"custodian":"11111111111111111111111111111111","epoch":0,"unixTimestamp":0},"rentExemptReserve":"2282880"},"stake":{"creditsObserved":1390949466,"delegation":{"activationEpoch":"401","deactivationEpoch":"18446744073709551615","stake":"3011834931702","voter":"9RqMzFzi7BDWMTGfCZhiBsXvLQjXK5UacAm6nNsyAfNp","warmupCooldownRate":0.25}}},"type":"delegated"},"program":"stake","space":200}}}];
ACCOUNTS.push({ pubkey: WARMING, account: { lamports: 1000e9 + RENT, owner: 'Stake11111111111111111111111111111111111111', executable: false, rentEpoch: 0, space: 200,
  data: { program: 'stake', space: 200, parsed: { type: 'delegated', info: { meta: { authorized: { staker: WITHDRAWER, withdrawer: WITHDRAWER }, lockup: { custodian: '11111111111111111111111111111111', epoch: 0, unixTimestamp: 0 }, rentExemptReserve: String(RENT) },
    stake: { creditsObserved: 1, delegation: { activationEpoch: '425', deactivationEpoch: U64MAX, stake: String(1000e9), voter: VOTE, warmupCooldownRate: 0.25 } } } } } } });
const acct = (k) => ACCOUNTS.find(a => a.pubkey === k).account;
const fmt4 = (l) => (l / 1e9).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

// Mutable mock state
let EPOCH = 425, history = HISTORY.slice(), sysvarBroken = false;

(async () => {
  await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  const pageErrors = [], warnings = [], consoleWarn = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { const t = m.text(); if (t.includes('[Actions]')) warnings.push(t); if (m.type() === 'warning') consoleWarn.push(t); });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, async r => {
    const u = r.request().url();
    if (!/rpc\.mainnet\.x1\.xyz/.test(u) || r.request().method() !== 'POST') return r.abort();
    let body; try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) { body = {}; }
    const one = (q) => {
      const ok = (result) => ({ jsonrpc: '2.0', id: q.id, result });
      const p = q.params || [];
      switch (q.method) {
        case 'getEpochInfo': return ok({ absoluteSlot: 89426725, blockHeight: 88920562, epoch: EPOCH, slotIndex: 172966, slotsInEpoch: 216000, transactionCount: 1 });
        case 'getAccountInfo':
          if (p[0] === SYSVAR) {
            if (sysvarBroken) return { jsonrpc: '2.0', id: q.id, error: { code: -32603, message: 'mock: sysvar unavailable' } };
            return ok({ context: { slot: 1 }, value: { lamports: 1, owner: 'Sysvar1111111111111111111111111111111111111', executable: false, rentEpoch: 0, space: 16392, data: { program: 'sysvar', space: 16392, parsed: { type: 'stakeHistory', info: history } } } });
          }
          if (p[0] === VOTE) return ok({ context: { slot: 1 }, value: { lamports: 1238800000, owner: 'Vote111111111111111111111111111111111111111', executable: false, rentEpoch: 0, space: 3762, data: { program: 'vote', space: 3762, parsed: { type: 'vote', info: { authorizedWithdrawer: WITHDRAWER, authorizedVoters: [{ authorizedVoter: NODE, epoch: EPOCH }], commission: 10, epochCredits: [{ epoch: String(EPOCH - 1), credits: '1393691034', previousCredits: '1390000000' }], nodePubkey: NODE, rootSlot: 1, votes: [] } } } } });
          if (ACCOUNTS.some(a => a.pubkey === p[0])) return ok({ context: { slot: 1 }, value: acct(p[0]) });
          return ok({ context: { slot: 1 }, value: null });
        case 'getProgramAccounts': {
          const f = ((p[1] && p[1].filters) || []).find(x => x.memcmp && x.memcmp.offset === 124);
          return ok(f && f.memcmp.bytes === VOTE ? ACCOUNTS : []);
        }
        case 'getVoteAccounts': return ok({ current: [{ votePubkey: VOTE, nodePubkey: NODE, activatedStake: 1087270092473100, commission: 10, epochVoteAccount: true, epochCredits: [[EPOCH - 1, 1393691034, 1390000000]], lastVote: 89426700, rootSlot: 89426600 }], delinquent: [] });
        case 'getBalance': return ok({ context: { slot: 1 }, value: 3937000000 });
        case 'getRecentPerformanceSamples': return ok([]);
        case 'getStakeActivation': return { jsonrpc: '2.0', id: q.id, error: { code: -32601, message: 'Method not found' } };
        default: return ok(null);
      }
    };
    const out = Array.isArray(body) ? body.map(one) : one(body);
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(out) });
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof StakeActivation !== 'undefined' && typeof openManageValidator === 'function', null, { timeout: 15000 });
  await page.evaluate(() => { const m = document.getElementById('disclaimerModal'); if (m) m.style.display = 'none'; });

  // ── 1. the math, against the chain-verified numbers ───────────────────────────────────────
  console.log('1. StakeActivation.compute @ epoch 425');
  const m = await page.evaluate(async ({ COOLING, DEACT, ACTIVE, WARMING, U64MAX, VOTE, RENT, ACCOUNTS }) => {
    const h = await StakeActivation.fetchHistory(425);
    const acc = (k) => ACCOUNTS.find(a => a.pubkey === k).account;
    const c = (k, e) => StakeActivation.compute(acc(k).data.parsed.info, acc(k).lamports, e === undefined ? 425 : e, h);
    const synth = (act, deact, stake, lam) => StakeActivation.compute({ meta: { rentExemptReserve: String(RENT) }, stake: { delegation: { activationEpoch: act, deactivationEpoch: deact, stake: String(stake), voter: VOTE } } }, lam, 425, h);
    return {
      size: h.size, cool: c(COOLING), deact: c(DEACT), active: c(ACTIVE), warm: c(WARMING),
      cool426noRow: c(COOLING, 426),                               // no 425 row yet → loop stops, remainder carried
      sameEpoch: synth('424', '424', 5e9, 5e9 + RENT),             // activated and deactivated in one epoch → nothing staked
      bootstrap: synth(U64MAX, U64MAX, 5e9, 5e9 + RENT),           // genesis stake → fully effective
      ancient: synth('100', '101', 5e9, 5e9 + RENT),               // dropped out of history → fully deactivated
      noHistory: StakeActivation.compute(acc(COOLING).data.parsed.info, acc(COOLING).lamports, 425, new Map()),
      frac: StakeActivation.lastCooldownFraction(h)
    };
  }, { COOLING, DEACT, ACTIVE, WARMING, U64MAX, VOTE, RENT, ACCOUNTS }).catch(e => ({ err: e.message }));
  check(!m.err, 'compute ran', m.err);
  if (!m.err) {
    check(m.size === 30, 'history map has the 30 fixture epochs', m.size);
    check(m.cool.state === 'deactivating' && m.cool.active === 233357177042 && m.cool.inactive === 1774532777416, 'FpxU…: 233.357177042 XNT still cooling, 1,774.532777416 withdrawable (= mainnet simulateTransaction boundary)', m.cool);
    check(m.deact.state === 'deactivating' && m.deact.active === 4611591991048 && m.deact.inactive === 0, '8GHg… (deactivated this epoch): everything still active, nothing withdrawable', m.deact);
    check(m.active.state === 'active' && m.active.active === 3011834931702, 'active account: state active, effective = delegation', m.active);
    check(m.warm.state === 'activating' && m.warm.active === 0 && m.warm.activating === 1000e9, 'activating account: state activating', m.warm);
    check(m.cool426noRow.state === 'deactivating' && m.cool426noRow.active === 233357177042, 'target 426 without a 425 history row keeps the carried remainder', m.cool426noRow);
    check(m.sameEpoch.state === 'inactive' && m.sameEpoch.active === 0 && m.sameEpoch.inactive === 5e9, 'activate+deactivate in the same epoch → inactive, all withdrawable', m.sameEpoch);
    check(m.bootstrap.state === 'active' && m.bootstrap.active === 5e9, 'bootstrap (u64::MAX activation) → fully active', m.bootstrap);
    check(m.ancient.state === 'inactive' && m.ancient.active === 0, 'deactivation epoch outside the history → fully deactivated', m.ancient);
    check(m.noHistory.state === 'inactive' && m.noHistory.active === 0, 'empty history → fully deactivated (program semantics)', m.noHistory);
    check(Math.abs(m.frac - 0.8838) < 0.001, 'lastCooldownFraction(424) ≈ 0.884', m.frac);
  }

  // ── 2. Manage Validator stake list ─────────────────────────────────────────────────────────
  console.log('2. Manage Validator → stake list (epoch 425)');
  await page.evaluate(({ VOTE, NODE }) => openManageValidator(VOTE, 'OWL', 1.2388, 10, NODE, ''), { VOTE, NODE });
  await page.waitForFunction(() => Array.isArray(stakeAccounts) && stakeAccounts.length === 4 && stakeAccounts.every(s => s.activationDataLoaded), null, { timeout: 15000 });
  const rows = await page.evaluate(() => {
    const texts = [...document.querySelectorAll('#stakeAccountsContainer .account-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim());
    return { order: stakeAccounts.map(s => [s.pubkey.slice(0, 4), s.state, s.activeLamports, s.inactiveLamports]), texts,
             inline: document.querySelectorAll('#stakeAccountsContainer [onclick],#stakeAccountsContainer [onerror]').length };
  });
  const rowText = (k) => rows.texts.find(t => t.includes(k.slice(0, 4)) && t.includes(k.slice(-4))) || '';
  const rec = (k) => rows.order.find(o => o[0] === k.slice(0, 4));
  check(rec(COOLING)[1] === 'deactivating' && rec(COOLING)[2] === 233357177042 && rec(COOLING)[3] === 1774532777416, 'FpxU… record: deactivating, active/inactive split from the sysvar', rec(COOLING));
  check(/COOLING/.test(rowText(COOLING)) && /88% cooled/.test(rowText(COOLING)), 'FpxU… row badge COOLING + "88% cooled"', rowText(COOLING));
  check(/DEACTIVATING/.test(rowText(DEACT)) && !/cooled/.test(rowText(DEACT)), '8GHg… row badge DEACTIVATING', rowText(DEACT));
  check(/ACTIVATING/.test(rowText(WARMING)), 'warming account badge ACTIVATING', rowText(WARMING));
  check(rec(ACTIVE)[1] === 'active' && rec(ACTIVE)[2] === 3011834931702 && rec(ACTIVE)[3] === 0, 'active account: whole delegation locked, nothing withdrawable', rec(ACTIVE));
  check(rec(WARMING)[1] === 'activating' && rec(WARMING)[2] === 1000e9 && rec(WARMING)[3] === 0, 'activating account: whole delegation locked', rec(WARMING));
  check(rows.inline === 0, '0 inline handlers in the stake list', rows.inline);

  // ── 3. Stake Account Details for the cooling account ───────────────────────────────────────
  console.log('3. Stake Account Details');
  const idx = await page.evaluate((k) => stakeAccounts.findIndex(s => s.pubkey === k), COOLING);
  await page.evaluate((i) => selectAccount('stake-' + i), idx);
  const det = await page.evaluate(() => ({
    staked: selectedStakedBalance.textContent, liquid: selectedLiquidBalance.textContent,
    pct: cooldownProgressPct.textContent, cooled: cooldownProgressCooled.textContent, cooling: cooldownProgressCooling.textContent, total: cooldownProgressTotal.textContent,
    summary: cooldownProgressSummary.textContent.replace(/\s+/g, ' ').trim(), boxShown: cooldownProgressBox.style.display
  }));
  check(det.staked === '233.3572' && det.liquid === '1,774.5328', 'Staked 233.3572 / Liquid 1,774.5328', det);
  check(det.pct === '88.4%' && det.cooled === '1,774.5328 XNT' && det.cooling === '233.3572 XNT' && det.total === '2,007.8900 XNT', 'cooldown card 88.4 % · 1,774.5328 cooled · 233.3572 cooling · 2,007.8900 total', det);
  check(/fully cooled at end of epoch 425/.test(det.summary) && /estimated rate/.test(det.summary) && det.boxShown === 'block', 'summary projects completion at the end of epoch 425 (estimate)', det.summary);

  // ── 4. Withdraw-from-stake modal ───────────────────────────────────────────────────────────
  console.log('4. Withdraw from stake (wallet = withdrawer)');
  await page.evaluate((w) => { walletPublicKey = w; initiateWithdrawStake(); }, WITHDRAWER);
  const wd = await page.evaluate(() => ({
    status: withdrawStakeStatus.textContent, note: withdrawStakeStatusNote.textContent, avail: withdrawStakeAvailableBalance.textContent, locked: withdrawStakeLockedBalance.textContent, total: withdrawStakeTotalBalance.textContent,
    cooldownRow: withdrawStakeCooldownRow.style.display, cooldownText: withdrawStakeCooldownText.textContent, close: withdrawStakeCloseSection.style.display, availLamports: withdrawStakeAvailableLamports,
    btnDisabled: withdrawStakeConfirmBtn.disabled, noBalance: withdrawStakeNoBalanceWarning.style.display, shown: withdrawStakeModal.style.display
  }));
  check(wd.shown === 'flex' && wd.status === 'Cooling Down', 'modal open, status "Cooling Down"', wd);
  check(wd.note.includes('1,774.5328 XNT ready, 233.3572 XNT still cooling'), 'note: 1,774.5328 ready / 233.3572 still cooling', wd.note);
  check(wd.avail === '1,774.5328 XNT' && wd.locked === '233.3572 XNT' && wd.total === '2,007.8922 XNT' && wd.availLamports === 1774532777416, 'available 1,774.5328 · locked 233.3572 · total 2,007.8922', wd);
  check(wd.cooldownRow === 'block' && /88\.4%/.test(wd.cooldownText), 'cooldown progress row 88.4 %', wd.cooldownText);
  check(wd.close === 'none' && !wd.btnDisabled && wd.noBalance === 'none', '"Close account" hidden (still cooling), withdraw enabled', wd);
  const max = await page.evaluate(() => { setWithdrawStakeAmount(100); return { input: withdrawStakeAmountInput.value, sum: withdrawStakeSummaryAmount.textContent }; });
  check(max.input === '1774.5328' && max.sum === '1,774.5328 XNT', 'MAX fills 1774.5328 (what the chain accepts)', max);
  await page.evaluate(() => closeWithdrawStakeModal());

  // ── 5. Stake classification modal ─────────────────────────────────────────────────────────
  console.log('5. Stake classification modal');
  await page.evaluate(({ VOTE }) => openStakeSelection(VOTE, 'OWL'), { VOTE });
  await page.waitForFunction(() => document.querySelector('.stake-selection-list .stake-selection-item'), null, { timeout: 15000 });
  const cls = await page.evaluate((k) => {
    const item = document.querySelector(`.stake-selection-item[data-pubkey="${k}"]`);
    const body = document.querySelector('.stake-selection-list').parentElement.textContent.replace(/\s+/g, ' ');
    return { item: item ? item.textContent.replace(/\s+/g, ' ').trim() : null, dim: item ? item.getAttribute('style') : null, body };
  }, COOLING);
  check(cls.item && /cooling down · 1,774\.53 XNT withdrawable now, 233\.36 XNT next epoch/.test(cls.item), 'FpxU… note: cooling down · 1,774.53 withdrawable now, 233.36 next epoch', cls.item);
  check(cls.dim === '' || cls.dim === null, 'cooling row not dimmed (still active-eligible)', cls.dim);
  check(/Inactive \(cooled down\)[^0-9]*1,774\.53 XNT/.test(cls.body), 'banner: Inactive (cooled down) = 1,774.53 XNT', cls.body.match(/Inactive \(cooled down\).{0,60}/)?.[0]);
  check(/Total delegated[^0-9]*10,631\.32 XNT/.test(cls.body), 'banner: Total delegated = 10,631.32 XNT (sum of all four)', cls.body.match(/Total delegated.{0,40}/)?.[0]);
  await page.evaluate(() => { const m = document.getElementById('stakeSelectionModal'); if (m) m.style.display = 'none'; });

  // ── 6. Next epoch: fully cooled → INACTIVE, close allowed ──────────────────────────────────
  console.log('6. Epoch 426 with a quiet 425 (little deactivating) → fully cooled');
  EPOCH = 426; history = [{ epoch: 425, stakeHistory: { effective: 995000000000000000, activating: 5000000000000000, deactivating: 16000000000000000 } }].concat(HISTORY);
  await page.evaluate(() => { _epochInfoData = null; });   // drop the 10-s getEpochInfo cache
  await page.evaluate(({ VOTE }) => fetchStakeAccounts(VOTE), { VOTE });
  await page.waitForFunction(() => stakeAccounts.length === 4 && stakeAccounts.every(s => s.activationDataLoaded) && stakeAccounts.find(s => s.pubkey.startsWith('FpxU')).state === 'inactive', null, { timeout: 15000 }).catch(() => {});
  const e426 = await page.evaluate(() => stakeAccounts.map(s => [s.pubkey.slice(0, 4), s.state, s.activeLamports, s.inactiveLamports]));
  const r426 = (k) => e426.find(o => o[0] === k.slice(0, 4));
  check(r426(COOLING)[1] === 'inactive' && r426(COOLING)[2] === 0 && r426(COOLING)[3] === 2007892237338 - RENT, 'FpxU… @426: inactive, all but rent withdrawable', r426(COOLING));
  check(r426(DEACT)[1] === 'inactive' && r426(DEACT)[2] === 0, '8GHg… @426: inactive too (cap not hit in 425)', r426(DEACT));
  check(r426(WARMING)[1] === 'active' && r426(WARMING)[2] === 1000e9, 'warming account @426: active', r426(WARMING));
  const idx2 = await page.evaluate((k) => stakeAccounts.findIndex(s => s.pubkey === k), COOLING);
  await page.evaluate((i) => { selectAccount('stake-' + i); initiateWithdrawStake(); }, idx2);
  const wd2 = await page.evaluate(() => ({ status: withdrawStakeStatus.textContent, avail: withdrawStakeAvailableBalance.textContent, close: withdrawStakeCloseSection.style.display, pct: cooldownProgressPct.textContent, summary: cooldownProgressSummary.textContent.trim() }));
  check(wd2.status === 'Inactive' && wd2.avail === '2,007.8900 XNT' && wd2.close === 'block', '@426 modal: Inactive, 2,007.8900 available, "Close account" offered', wd2);
  check(wd2.pct === '100.0%' && /Fully cooled/.test(wd2.summary), '@426 details card: 100 % / Fully cooled', wd2);
  await page.evaluate(() => closeWithdrawStakeModal());

  // ── 7. Epoch 426 with a congested 425 → both still partly cooling ──────────────────────────
  console.log('7. Epoch 426 with a congested 425 (300 M XNT deactivating) → partial again');
  history = [{ epoch: 425, stakeHistory: { effective: 995000000000000000, activating: 5000000000000000, deactivating: 300000000000000000 } }].concat(HISTORY);
  await page.evaluate(() => { _epochInfoData = null; _stakeHistory = null; _stakeHistoryEpoch = null; });
  await page.evaluate(({ VOTE }) => fetchStakeAccounts(VOTE), { VOTE });
  await page.waitForFunction(() => stakeAccounts.length === 4 && stakeAccounts.find(s => s.pubkey.startsWith('8GHg')).state === 'deactivating' && stakeAccounts.find(s => s.pubkey.startsWith('8GHg')).inactiveLamports > 0, null, { timeout: 15000 }).catch(() => {});
  const e426b = await page.evaluate(() => stakeAccounts.map(s => [s.pubkey.slice(0, 4), s.state, s.activeLamports, s.inactiveLamports]));
  const rb = (k) => e426b.find(o => o[0] === k.slice(0, 4));
  // reference: fraction released at the 425→426 boundary = 0.09 × 995 M / 300 M = 0.2985
  const frac = 0.09 * 995000000000000000 / 300000000000000000;
  const expDeactActive = 4611591991048 - Math.max(Math.floor((4611591991048 / 300000000000000000) * (995000000000000000 * 0.09)), 1);
  const expCoolActive = 233357177042 - Math.max(Math.floor((233357177042 / 300000000000000000) * (995000000000000000 * 0.09)), 1);
  check(rb(DEACT)[1] === 'deactivating' && rb(DEACT)[2] === expDeactActive && rb(DEACT)[3] === 4611594273928 - expDeactActive - RENT, `8GHg… @426: ~${(frac * 100).toFixed(1)} % cooled, rest still active`, rb(DEACT));
  check(rb(COOLING)[1] === 'deactivating' && rb(COOLING)[2] === expCoolActive, 'FpxU… @426: remainder cools at the same cluster share', rb(COOLING));

  // ── 8. Sysvar unreadable → epoch-math fallback, no crash ───────────────────────────────────
  console.log('8. Sysvar read fails → fallback');
  sysvarBroken = true; EPOCH = 425; history = HISTORY.slice();
  await page.evaluate(() => { _epochInfoData = null; _stakeHistory = null; _stakeHistoryEpoch = null; });
  await page.evaluate(({ VOTE }) => fetchStakeAccounts(VOTE), { VOTE });
  await page.waitForFunction(() => stakeAccounts.length === 4 && stakeAccounts.every(s => s.activationDataLoaded === false || s.state === 'active' || s.state === 'activating'), null, { timeout: 15000 }).catch(() => {});
  const fb = await page.evaluate(() => stakeAccounts.map(s => [s.pubkey.slice(0, 4), s.state, s.activeLamports, s.inactiveLamports, s.activationDataLoaded]));
  const rf = (k) => fb.find(o => o[0] === k.slice(0, 4));
  check(rf(COOLING)[1] === 'inactive' && rf(COOLING)[4] === false && rf(DEACT)[1] === 'deactivating' && rf(DEACT)[2] === 4611591991048, 'fallback: epoch math (FpxU inactive/unverified, 8GHg deactivating), flagged activationDataLoaded=false', fb);
  check(consoleWarn.some(w => /stake history sysvar unavailable/.test(w)), 'console.warn names the sysvar failure', consoleWarn.slice(-2));
  sysvarBroken = false;

  // ── 9. Unstaking calculator: "observed" preset follows the sysvar ─────────────────────────
  console.log('9. Unstaking calculator observed-rate preset');
  await page.evaluate(() => { _epochInfoData = null; _stakeHistory = null; _stakeHistoryEpoch = null; });
  await page.evaluate(() => { const m = document.getElementById('manageValidatorModal'); if (m) m.style.display = 'none'; location.hash = '#/calculators/unstaking'; });
  await page.evaluate(() => refreshEpochInfo());
  await page.waitForFunction(() => /Observed last epoch/.test(document.querySelector('.unstaking-rate-preset[data-observed]').textContent) && document.getElementById('unstakingRate').value === '90', null, { timeout: 15000 }).catch(() => {});
  const calc = await page.evaluate(() => { const b = document.querySelector('.unstaking-rate-preset[data-observed]'); return { btn: b.textContent, rate: b.dataset.rate, args: b.dataset.args, slider: unstakingRate.value, label: unstakingRateValue.textContent, active: [...document.querySelectorAll('.unstaking-rate-preset.active')].map(x => x.dataset.rate), epochs: document.querySelectorAll('#unstakingTimeline .timeline-item, #unstakingTimeline .unstaking-epoch-row').length }; });
  check(calc.btn === '90% — Observed last epoch' && calc.rate === '90' && calc.args === '[90]', 'preset relabelled 90 % — Observed last epoch (0.884 → nearest 5 %)', calc);
  check(calc.slider === '90' && calc.label === '90%' && calc.active.join() === '90', 'slider defaulted to 90 % (untouched) and the preset is highlighted', calc);
  const touched = await page.evaluate(async () => { setUnstakingRatePreset(25); _stakeHistory = null; _stakeHistoryEpoch = null; await applyObservedCooldownRate(425); return unstakingRate.value; });
  check(touched === '25', 'a user-chosen rate is not overridden by a later sysvar read', touched);

  check(pageErrors.length === 0, 'page errors: ' + JSON.stringify(pageErrors));
  check(warnings.length === 0, '[Actions] warnings: ' + JSON.stringify(warnings));
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
