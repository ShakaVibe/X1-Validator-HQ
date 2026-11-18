// Authority-change safety net (audit 2026-11-17 #4) — js/wallet-tx.js + #authorityDangerModal.
// Handing a WITHDRAW authority (of a stake account, or of the vote account) to an
// address nobody holds the key for loses the funds for good. The old flow sent the
// transaction on one click for any valid base58 string.
//
// Offline: serves the repo, mocks the RPC, stubs the signer (nothing is ever sent) and checks
//   1. addresses that cannot be a wallet are refused while typing, with the reason:
//      the stake account itself, the vote account, program / sysvar ids, an address
//      without a private key (PDA), the current authority;
//   2. a good address does NOT send on the first click — the confirmation modal opens
//      with the full address, what is at stake and what the chain knows about it;
//   3. the modal only unlocks on the address's last 6 characters, and then sends
//      exactly one Stake Authorize(Withdrawer) / Vote Authorize(Withdrawer) instruction;
//   4. the on-chain lookup blocks programs and program-owned accounts, warns about
//      never-used addresses, and degrades to a caution when the RPC cannot answer;
//   5. the vote-authority (voter) flow keeps its own typed-phrase modal and gains the
//      address checks.
//   node scripts/c2-tests/authority-test.js /path/to/repo
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

const VOTE = '9RqMzFzi7BDWMTGfCZhiBsXvLQjXK5UacAm6nNsyAfNp', NODE = 'CkMwg4TM6jaSC5rJALQjvLc51XFY5pJ1H9f1Tmu5Qdxs';
const STAKE = 'FpxUC1L1LktZ6DhkhxbReMzTUxRrYLjNJZp6GafyxRiC', WALLET = 'Ge31BtSCzr6UDTgzv9sEFta4RpzAAfKe9rZi1RPe1v63';
const STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111', VOTE_PROGRAM = 'Vote111111111111111111111111111111111111111', SYSTEM = '11111111111111111111111111111111';
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const chain = {};                                   // address → getAccountInfo value | 'error'; anything else → null (no account)

let fails = 0;
const check = (ok, label, extra) => { console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok || extra === undefined ? '' : ' — ' + JSON.stringify(extra))); if (!ok) fails++; };

(async () => {
  await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  const pageErrors = [], warnings = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { const t = m.text(); if (t.includes('[Actions]')) warnings.push(t); });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, async r => {
    const u = r.request().url();
    if (!/rpc\.mainnet\.x1\.xyz/.test(u) || r.request().method() !== 'POST') return r.abort();
    let body; try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) { body = {}; }
    const one = (q) => {
      const ok = (result) => ({ jsonrpc: '2.0', id: q.id, result });
      const p = q.params || [];
      switch (q.method) {
        case 'getEpochInfo': return ok({ absoluteSlot: 96100000, blockHeight: 95000000, epoch: 447, slotIndex: 100000, slotsInEpoch: 216000, transactionCount: 1 });
        case 'getAccountInfo':
          if (p[0] === VOTE && p[1] && p[1].encoding === 'jsonParsed') return ok({ context: { slot: 1 }, value: { lamports: 1238800000, owner: VOTE_PROGRAM, executable: false, rentEpoch: 0, space: 3762, data: { program: 'vote', space: 3762, parsed: { type: 'vote', info: { authorizedWithdrawer: WALLET, authorizedVoters: [{ authorizedVoter: WALLET, epoch: 447 }], commission: 10, nodePubkey: NODE } } } } });
          if (chain[p[0]] === 'error') return { jsonrpc: '2.0', id: q.id, error: { code: -32603, message: 'mock: lookup unavailable' } };
          return ok({ context: { slot: 1 }, value: chain[p[0]] || null });
        case 'getLatestBlockhash': return ok({ context: { slot: 1 }, value: { blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', lastValidBlockHeight: 1000 } });
        case 'getVoteAccounts': return ok({ current: [], delinquent: [] });
        case 'getProgramAccounts': return ok([]);
        case 'getRecentPerformanceSamples': return ok([]);
        default: return ok(null);
      }
    };
    const out = Array.isArray(body) ? body.map(one) : one(body);
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(out) });
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof solanaWeb3 !== 'undefined' && typeof initiateSetWithdrawAuthority === 'function' && typeof openAuthorityDangerModal === 'function', null, { timeout: 20000 });
  await page.evaluate(() => { const m = document.getElementById('disclaimerModal'); if (m) m.style.display = 'none'; });

  // Addresses: real keypairs generated in the page (on the curve) and one program-derived address (off it)
  const K = await page.evaluate(() => {
    const kp = () => solanaWeb3.Keypair.generate().publicKey.toBase58();
    const [pda] = solanaWeb3.PublicKey.findProgramAddressSync([new TextEncoder().encode('vault')], new solanaWeb3.PublicKey('Stake11111111111111111111111111111111111111'));
    return { good: kp(), fresh: kp(), program: kp(), stakeOwned: kp(), tokenOwned: kp(), rpcDown: kp(), voter: kp(), pda: pda.toBase58(), pdaOnCurve: solanaWeb3.PublicKey.isOnCurve(pda.toBytes()) };
  });
  chain[K.good] = { lamports: 12500000000, owner: SYSTEM, executable: false, rentEpoch: 0, space: 0, data: ['', 'base64'] };
  chain[K.program] = { lamports: 1141440, owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true, rentEpoch: 0, space: 36, data: ['', 'base64'] };
  chain[K.stakeOwned] = { lamports: 5000000000, owner: STAKE_PROGRAM, executable: false, rentEpoch: 0, space: 200, data: ['', 'base64'] };
  chain[K.tokenOwned] = { lamports: 2039280, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', executable: false, rentEpoch: 0, space: 165, data: ['', 'base64'] };
  chain[K.rpcDown] = 'error';

  // Manage Validator state: one stake account whose withdrawer is the connected wallet; signer stubbed
  await page.evaluate(({ VOTE, STAKE, WALLET, SIG }) => {
    walletPublicKey = WALLET; connectedWallet = { provider: {} };
    currentManageValidator = { voteAccount: VOTE, name: 'OWL' };
    stakeAccounts = [{ pubkey: STAKE, lamports: 2007892237338, data: { meta: { authorized: { staker: WALLET, withdrawer: WALLET } }, stake: { delegation: { voter: VOTE } } } }];
    selectedAccountType = 'stake-0';
    window.__sent = [];
    window.signSendTx = async (c, tx) => { window.__sent.push(tx); return SIG; };
    window.confirmWithFallback = async () => true;
    window.fetchStakeAccounts = async () => {};       // the post-success refresh is not under test
  }, { VOTE, STAKE, WALLET, SIG });

  const state = () => page.evaluate(() => ({
    setBtnDisabled: setWithdrawAuthorityBtn.disabled, setMsg: getComputedStyle(setWithdrawAuthorityMessage).display === 'none' ? '' : setWithdrawAuthorityMessage.textContent.trim(),
    danger: authorityDangerModal.style.display, title: authorityDangerTitle.textContent, lead: authorityDangerLead.textContent, accountLabel: authorityDangerAccountLabel.textContent, account: authorityDangerAccount.textContent,
    amount: authorityDangerAmount.textContent, next: authorityDangerNew.textContent, tail: (authorityDangerNew.querySelector('b') || {}).textContent, facts: authorityDangerFacts.textContent,
    inputDisabled: authorityDangerInput.disabled, input: authorityDangerInput.value, proceedDisabled: authorityDangerBtn.disabled, sent: window.__sent.length,
  }));
  const typeNew = (v) => page.evaluate((v) => { setWithdrawNewAuthority.value = v; setWithdrawNewAuthority.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  const typeTail = (v) => page.evaluate((v) => { authorityDangerInput.value = v; authorityDangerInput.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  const factsDone = () => page.waitForFunction(() => !/Looking the address up/.test(authorityDangerFacts.textContent), null, { timeout: 10000 });
  const ixOf = (i) => page.evaluate((i) => {
    const tx = window.__sent[i]; if (!tx) return null; const ix = tx.instructions[0];
    const dv = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    return { n: tx.instructions.length, program: ix.programId.toBase58(), index: dv.getUint32(0, true), newAuthority: new solanaWeb3.PublicKey(ix.data.slice(4, 36)).toBase58(), type: dv.getUint32(36, true), account: ix.keys[0].pubkey.toBase58(), signer: ix.keys.filter(k => k.isSigner).map(k => k.pubkey.toBase58()) };
  }, i);

  // ── 1. Stake withdraw authority: refused addresses ────────────────────────────────────────
  console.log('1. Set Withdraw Authority (stake): addresses that cannot be a wallet');
  await page.evaluate(() => initiateSetWithdrawAuthority());
  const s0 = await state();
  check(s0.setBtnDisabled && s0.danger === 'none', 'modal opens with the button disabled', s0);
  check(K.pdaOnCurve === false, 'test PDA is off the curve');
  const refused = [
    [STAKE, /stake account itself/, 'the stake account itself'],
    [VOTE, /vote account/, "the validator's vote account"],
    [STAKE_PROGRAM, /Stake Program/, 'the Stake Program id'],
    [SYSTEM, /System Program/, 'the System Program id'],
    ['SysvarC1ock11111111111111111111111111111111', /system variable/, 'a sysvar'],
    ['1nc1nerator11111111111111111111111111111111', /incinerator/, 'the incinerator'],
    [K.pda, /no private key/, 'a program-derived address (no private key)'],
    [WALLET, /already the current authority/, 'the current authority'],
  ];
  for (const [addr, re, label] of refused) {
    await typeNew(addr); const s = await state();
    check(s.setBtnDisabled && re.test(s.setMsg), `refused: ${label} → "${s.setMsg.slice(0, 70)}"`, s.setMsg);
  }
  await typeNew('not-an-address'); const sBad = await state();
  check(sBad.setBtnDisabled && sBad.setMsg === '', 'half-typed input: button disabled, no message yet', sBad);
  const direct = await page.evaluate(async ({ pda, STAKE }) => { await executeSetWithdrawAuthority(pda, STAKE); return window.__sent.length; }, { pda: K.pda, STAKE });
  check(direct === 0, 'executeSetWithdrawAuthority() called directly with a refused address sends nothing', direct);

  // ── 2. A good address: confirmation first ─────────────────────────────────────────────────
  console.log('2. A good address does not send on the first click');
  await typeNew(K.good); const s1 = await state();
  check(!s1.setBtnDisabled && s1.setMsg === '', 'a wallet address enables the button, no message', s1);
  await page.evaluate(() => setWithdrawAuthorityBtn.click()); await factsDone();
  const s2 = await state();
  check(s2.danger === 'flex' && s2.sent === 0, 'click → the confirmation modal opens, nothing is sent', { danger: s2.danger, sent: s2.sent });
  check(s2.next === K.good && s2.tail === K.good.slice(-6) && s2.account === STAKE && s2.accountLabel === 'Stake account:' && /2,007\.8922 XNT/.test(s2.amount), 'shows the full new address (last 6 highlighted), the stake account and its 2,007.8922 XNT', s2);
  check(/wallet holding 12\.5000 XNT/.test(s2.facts) && s2.proceedDisabled && !s2.inputDisabled, 'on-chain lookup: "a wallet holding 12.5000 XNT"; proceed still locked', s2);
  await typeTail('zzzzzz'); const s3 = await state();
  await typeTail(K.fresh.slice(-6)); const s3b = await state();
  await typeTail(K.good.slice(-5)); const s3c = await state();
  check(s3.proceedDisabled && s3b.proceedDisabled && s3c.proceedDisabled, 'wrong characters, another address\'s tail, or only 5 of 6 keep it locked');
  await page.mouse.click(5, 5); const sClosed = await state();
  await page.evaluate(() => setWithdrawAuthorityBtn.click()); await factsDone(); const sReopen = await state();
  check(sClosed.danger === 'none' && sClosed.sent === 0 && sReopen.danger === 'flex' && sReopen.input === '' && sReopen.proceedDisabled, 'backdrop click cancels; reopening starts with an empty, locked confirmation', { sClosed: sClosed.danger, reopen: sReopen.input });
  await typeTail(K.good.slice(-6)); const s4 = await state();
  check(!s4.proceedDisabled, 'the last 6 characters unlock it');
  await page.evaluate(() => authorityDangerBtn.click());
  await page.waitForFunction(() => /Withdraw authority updated/.test(setWithdrawAuthorityMessage.textContent), null, { timeout: 10000 }).catch(() => {});
  const s5 = await state(), ix = await ixOf(0);
  check(s5.sent === 1 && s5.danger === 'none' && /Withdraw authority updated/.test(s5.setMsg), 'proceed → exactly one transaction, modal closed, success message', { sent: s5.sent, msg: s5.setMsg });
  check(ix && ix.n === 1 && ix.program === STAKE_PROGRAM && ix.index === 1 && ix.type === 1 && ix.newAuthority === K.good && ix.account === STAKE && ix.signer.length === 1 && ix.signer[0] === WALLET, 'it is Stake Authorize(Withdrawer) on the stake account, new authority = the confirmed address, signed by the wallet', ix);
  await page.evaluate(() => closeSetWithdrawAuthorityModal());

  // ── 3. What the chain says about the address ──────────────────────────────────────────────
  console.log('3. On-chain lookup');
  const openWith = async (addr) => { await page.evaluate(() => { closeAuthorityDangerModal(); initiateSetWithdrawAuthority(); }); await typeNew(addr); await page.evaluate(() => setWithdrawAuthorityBtn.click()); await factsDone(); return state(); };
  const sentBefore = (await state()).sent;
  for (const [addr, re, label] of [[K.program, /is a program/, 'a program (executable)'], [K.stakeOwned, /is a stake account/, 'another stake account'], [K.tokenOwned, /owned by a program/, 'an account owned by a program']]) {
    const s = await openWith(addr);
    await page.evaluate((t) => { authorityDangerInput.value = t; validateAuthorityDangerInput(); }, addr.slice(-6));
    const after = await page.evaluate(async () => { await proceedWithAuthorityChange(); return { proceedDisabled: authorityDangerBtn.disabled, sent: window.__sent.length }; });
    check(re.test(s.facts) && s.inputDisabled && after.proceedDisabled && after.sent === sentBefore, `blocked: ${label} → input disabled, nothing sent even with the right 6 characters`, { facts: s.facts, after });
  }
  const sFresh = await openWith(K.fresh);
  await typeTail(K.fresh.slice(-6)); const sFresh2 = await state();
  check(/never been used on chain/.test(sFresh.facts) && /mistyped address/.test(sFresh.facts) && !sFresh2.proceedDisabled, 'a never-used address: allowed, with the warning that a mistyped address looks the same', sFresh.facts);
  const sDown = await openWith(K.rpcDown);
  await typeTail(K.rpcDown.slice(-6)); const sDown2 = await state();
  check(/Could not look this address up/.test(sDown.facts) && !sDown2.proceedDisabled, 'RPC cannot answer → caution text, the typed confirmation still decides', sDown.facts);
  await page.evaluate(() => { closeAuthorityDangerModal(); closeSetWithdrawAuthorityModal(); });
  check((await state()).sent === sentBefore, 'nothing was sent in this section');

  // ── 4. Vote account: withdraw authority uses the same confirmation ────────────────────────
  console.log('4. Change Authority (vote account)');
  await page.evaluate(() => initiateChangeAuthority());
  await page.waitForFunction(() => voteAccountAuthorities.withdraw, null, { timeout: 10000 });
  const typeVote = (v) => page.evaluate((v) => { newVoteAuthorityInput.value = v; newVoteAuthorityInput.dispatchEvent(new Event('input', { bubbles: true })); return { disabled: changeVoteAuthorityBtn.disabled, msg: getComputedStyle(changeVoteAuthorityMessage).display === 'none' ? '' : changeVoteAuthorityMessage.textContent.trim() }; }, v);
  await page.evaluate(() => selectVoteAuthorityType('withdraw'));
  const v1 = await typeVote(VOTE), v2 = await typeVote(K.pda), v3 = await typeVote(VOTE_PROGRAM), v4 = await typeVote(WALLET);
  check(v1.disabled && /vote account itself/.test(v1.msg) && v2.disabled && /no private key/.test(v2.msg) && v3.disabled && /Vote Program/.test(v3.msg) && v4.disabled && /already the current/.test(v4.msg), 'withdraw authority: the vote account itself, a PDA, a program id and the current authority are refused', { v1, v2, v3, v4 });
  const v5 = await typeVote(K.good);
  await page.evaluate(() => changeVoteAuthorityBtn.click()); await factsDone();
  const sv = await state(); const phrase = await page.evaluate(() => voteAuthorityDangerModal.style.display);
  check(!v5.disabled && sv.danger === 'flex' && phrase === 'none' && sv.sent === sentBefore && sv.account === VOTE && sv.accountLabel === 'Vote account:' && /OWL/.test(sv.amount) && /rewards, its commission/.test(sv.lead), 'a good address → the same confirmation modal (vote account, validator name), nothing sent yet', sv);
  await typeTail(K.good.slice(-6));
  await page.evaluate(() => authorityDangerBtn.click());
  await page.waitForFunction(() => /authority changed successfully/.test(changeVoteAuthorityMessage.textContent), null, { timeout: 10000 }).catch(() => {});
  const svDone = await state(), vix = await ixOf(sentBefore);
  check(svDone.sent === sentBefore + 1 && vix && vix.program === VOTE_PROGRAM && vix.index === 1 && vix.type === 1 && vix.newAuthority === K.good && vix.account === VOTE, 'typed confirmation → one Vote Authorize(Withdrawer) instruction for the confirmed address', vix);
  // the voter flow keeps its own typed-phrase modal, with the address checks added
  await page.evaluate(() => { changeVoteAuthorityBtn.onclick = confirmChangeVoteAuthority; changeVoteAuthorityBtn.textContent = 'Change Authority'; selectVoteAuthorityType('vote'); });
  const w1 = await typeVote(K.pda), w2 = await typeVote(K.voter);
  await page.evaluate(() => changeVoteAuthorityBtn.click());
  const w3 = await page.evaluate(() => ({ phrase: voteAuthorityDangerModal.style.display, generic: authorityDangerModal.style.display, sent: window.__sent.length }));
  check(w1.disabled && /no private key/.test(w1.msg) && !w2.disabled && w3.phrase === 'flex' && w3.generic === 'none' && w3.sent === sentBefore + 1, 'vote (voter) authority: PDA refused; a keypair address opens the existing "CHANGE VOTE AUTHORITY" modal, nothing sent', { w1, w2, w3 });
  await page.evaluate(() => { closeVoteAuthorityDangerModal(); closeChangeVoteAuthorityModal(); });

  // ── 5. Markup hygiene ─────────────────────────────────────────────────────────────────────
  const hyg = await page.evaluate(() => ({ inline: document.querySelectorAll('#authorityDangerModal [onclick], #authorityDangerModal [oninput]').length, has: ['closeAuthorityDangerModal', 'proceedWithAuthorityChange', 'validateAuthorityDangerInput'].every(f => typeof window[f] === 'function'), above: !!(setWithdrawAuthorityModal.compareDocumentPosition(authorityDangerModal) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(changeVoteAuthorityModal.compareDocumentPosition(authorityDangerModal) & Node.DOCUMENT_POSITION_FOLLOWING) }));
  check(hyg.inline === 0 && hyg.has && hyg.above, '0 inline handlers; the confirmation sits after both authority modals in the DOM (drawn on top)', hyg);
  await page.waitForTimeout(2300);                   // let the post-success refresh timers fire
  check(pageErrors.length === 0, 'page errors: ' + JSON.stringify(pageErrors));
  check(warnings.length === 0, '[Actions] warnings: ' + JSON.stringify(warnings));

  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
