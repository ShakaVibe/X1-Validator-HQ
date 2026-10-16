// Offline smoke of Manage Validator → Update Identity (js/wallet-tx.js), mock RPC:
//   • identity WITH an info account → form pre-filled from chain, update builds one Config
//     Store ix: [info (writable, not signer), identity (signer)], data = ConfigKeys + u64 + JSON,
//     unknown fields (details) kept, keys sorted like the CLI;
//   • identity WITHOUT one → "will create" note, tx = createAccount(643 B, rent) + Store with the
//     new account as signer, new account partial-signed;
//   • wallet ≠ identity → button locked; validation (long name, bad website).
// The real Config program accepted both shapes in a mainnet simulateTransaction (2026-10-16).
//   node scripts/c2-tests/identity-test.js /path/to/repo
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

let fixture = null;   // { idA, infoA, accountB64 } — set once the page has generated keys
const sent = [];
(async () => {
  await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, async r => {
    const u = r.request().url();
    if (!/rpc\.mainnet\.x1\.xyz/.test(u) || r.request().method() !== 'POST') return r.abort();
    let body; try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) { body = {}; }
    const one = (q) => {
      const ok = (result) => ({ jsonrpc: '2.0', id: q.id, result });
      switch (q.method) {
        case 'getProgramAccounts': {
          const f = (q.params[1] && q.params[1].filters) || [];
          const idF = f.find(x => x.memcmp && x.memcmp.offset === 34);
          if (fixture && idF && idF.memcmp.bytes === fixture.idA) return ok([{ pubkey: fixture.infoA, account: { data: [fixture.accountB64, 'base64'], lamports: 5366160, owner: 'Config1111111111111111111111111111111111111', executable: false, rentEpoch: 0 } }]);
          return ok([]);
        }
        case 'getMinimumBalanceForRentExemption': return ok(5366160);
        case 'getBalance': return ok({ context: { slot: 1 }, value: 1e9 });
        case 'getLatestBlockhash': return ok({ context: { slot: 1 }, value: { blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', lastValidBlockHeight: 1000 } });
        case 'getRecentPrioritizationFees': return ok([]);
        case 'sendTransaction': sent.push(q.params[0]); return ok('5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW');
        case 'getSignatureStatuses': return ok({ context: { slot: 1 }, value: [{ slot: 1, confirmations: null, err: null, confirmationStatus: 'confirmed' }] });
        case 'getBlockHeight': return ok(10);
        default: return ok(null);
      }
    };
    const out = Array.isArray(body) ? body.map(one) : one(body);
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(out) });
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof solanaWeb3 !== 'undefined', null, { timeout: 15000 });
  await page.waitForTimeout(600);

  fixture = await page.evaluate(() => {
    const k = () => solanaWeb3.Keypair.generate().publicKey.toBase58();
    const idA = k(), idB = k(), infoA = k(), vote = k();
    const json = JSON.stringify({ details: 'Run by a test', iconUrl: 'https://example.com/a.png', name: 'Old Name', website: 'https://old.example' });
    const enc = encodeValidatorInfo(new solanaWeb3.PublicKey(idA), json);
    const full = new Uint8Array(643); full.set(enc);
    const m = document.getElementById('disclaimerModal'); if (m) m.style.display = 'none';
    return { idA, idB, infoA, vote, accountB64: btoa(String.fromCharCode(...full)) };
  });

  // decode a captured tx in the page
  const lastTx = () => page.evaluate(() => {
    const tx = window.__signed; if (!tx) return null;
    const CFG = 'Config1111111111111111111111111111111111111';
    const ixs = tx.instructions.map(i => ({ program: i.programId.toBase58(), keys: i.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), data: Array.from(i.data) }));
    const cfg = tx.instructions.find(i => i.programId.toBase58() === CFG);
    let decoded = null;
    if (cfg) {
      const d = cfg.data;
      const len = Number(new DataView(d.buffer, d.byteOffset).getBigUint64(67, true));
      decoded = { n: d[0], k0: new solanaWeb3.PublicKey(d.slice(1, 33)).toBase58(), s0: d[33], k1: new solanaWeb3.PublicKey(d.slice(34, 66)).toBase58(), s1: d[66], json: new TextDecoder().decode(d.slice(75, 75 + len)), total: d.length, len };
    }
    const sys = tx.instructions.find(i => i.programId.toBase58() === '11111111111111111111111111111111');
    let create = null;
    if (sys) { const d = sys.data; const dv = new DataView(d.buffer, d.byteOffset); create = { type: dv.getUint32(0, true), lamports: Number(dv.getBigUint64(4, true)), space: Number(dv.getBigUint64(12, true)), owner: new solanaWeb3.PublicKey(d.slice(20, 52)).toBase58(), newAcct: sys.keys[1].pubkey.toBase58() }; }
    const sigs = tx.signatures.map(s => [s.publicKey.toBase58(), !!s.signature]);
    return { ixs: ixs.map(i => i.program), cfgKeys: cfg && cfg.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), decoded, create, sigs, feePayer: tx.feePayer.toBase58() };
  });
  const waitDone = () => page.waitForFunction(() => /success|error/.test(document.getElementById('identityMessage').className) && !/Preparing|Awaiting|Confirming/.test(document.getElementById('identityConfirmBtn').textContent), null, { timeout: 15000 }).catch(() => {});

  // ── A: identity with an existing info account ──
  await page.evaluate((F) => {
    currentManageValidator = { voteAccount: F.vote, name: 'Old Name', identityPubkey: F.idA, iconUrl: '' };
    walletPublicKey = F.idA;
    connectedWallet = { provider: { signTransaction: async (tx) => { window.__signed = tx; return { serialize: () => tx.serialize({ requireAllSignatures: false, verifySignatures: false }) }; } } };
    initiateUpdateIdentity();
  }, fixture);
  await page.waitForFunction(() => document.getElementById('identityConfirmBtn').textContent.trim() === 'Update Identity', null, { timeout: 5000 }).catch(() => {});
  const a1 = await page.evaluate(() => ({ name: identityNameInput.value, web: identityWebsiteInput.value, icon: identityIconInput.value, dis: identityConfirmBtn.disabled, msg: identityMessage.style.display, warn: identityAuthorityWarning.style.display }));
  check(a1.name === 'Old Name' && a1.web === 'https://old.example' && a1.icon === 'https://example.com/a.png', 'form pre-filled from the on-chain account (incl. website)', a1);
  check(a1.dis === false && a1.warn === 'none' && a1.msg === 'none', 'identity wallet → button enabled, no warning', a1);
  await page.fill('#identityNameInput', 'New Name');
  await page.fill('#identityWebsiteInput', '');
  await page.click('#identityConfirmBtn');
  await waitDone();
  const a2 = await lastTx();
  const a2msg = await page.evaluate(() => ({ cls: identityMessage.className, txt: identityMessage.textContent, btn: identityConfirmBtn.textContent, title: manageValidatorName ? manageValidatorName.textContent : null }));
  check(/success/.test(a2msg.cls) && /updated/.test(a2msg.txt), 'update → success message', a2msg);
  check(a2 && !a2.create && a2.ixs.filter(p => p.startsWith('Config')).length === 1, 'one Config Store ix, no createAccount', a2 && a2.ixs);
  check(a2 && JSON.stringify(a2.cfgKeys) === JSON.stringify([[fixture.infoA, false, true], [fixture.idA, true, false]]), 'accounts: info writable/not signer, identity signer', a2 && a2.cfgKeys);
  const d = a2 && a2.decoded;
  check(d && d.n === 2 && d.k0 === 'Va1idator1nfo111111111111111111111111111111' && d.s0 === 0 && d.k1 === fixture.idA && d.s1 === 1 && d.total === 75 + d.len, 'data = ConfigKeys [Va1idator1nfo, identity*] + u64 length + JSON', d);
  check(d && d.json === '{"details":"Run by a test","iconUrl":"https://example.com/a.png","name":"New Name"}', 'JSON: name changed, website removed, details kept, keys sorted', d && d.json);
  check(a2 && a2.feePayer === fixture.idA, 'identity pays the fee');
  check(sent.length === 1, 'one tx sent', sent.length);

  // ── B: identity without an info account → create ──
  await page.evaluate((F) => {
    window.__signed = null;
    currentManageValidator = { voteAccount: F.vote, name: 'Fresh', identityPubkey: F.idB, iconUrl: '' };
    walletPublicKey = F.idB;
    initiateUpdateIdentity();
  }, fixture);
  await page.waitForFunction(() => document.getElementById('identityConfirmBtn').textContent.trim() === 'Update Identity', null, { timeout: 5000 }).catch(() => {});
  const b1 = await page.evaluate(() => ({ msg: identityMessage.textContent, shown: identityMessage.style.display, web: identityWebsiteInput.value, dis: identityConfirmBtn.disabled }));
  check(b1.shown === 'block' && /saving will create it/.test(b1.msg) && b1.web === '' && !b1.dis, 'no account → "will create" note, empty website, enabled', b1);
  await page.fill('#identityNameInput', 'Fresh Validator');
  await page.fill('#identityIconInput', 'https://example.com/f.png');
  await page.waitForTimeout(700);              // icon preview appears while typing (not on blur), so the button stays put
  await page.click('#identityConfirmBtn');
  await waitDone();
  const b2 = await lastTx();
  const b2msg = await page.evaluate(() => identityMessage.textContent);
  check(/^Validator info published/.test(b2msg), 'create → "published" message', b2msg);
  check(b2 && b2.create && b2.create.type === 0 && b2.create.space === 643 && b2.create.lamports === 5366160 && b2.create.owner === 'Config1111111111111111111111111111111111111', 'createAccount: 643 bytes, rent-exempt lamports, owner = Config', b2 && b2.create);
  const newAcct = b2 && b2.create && b2.create.newAcct;
  check(b2 && JSON.stringify(b2.cfgKeys) === JSON.stringify([[newAcct, true, true], [fixture.idB, true, false]]), 'Store accounts: new info account signer+writable, identity signer', b2 && b2.cfgKeys);
  check(b2 && b2.sigs.some(([k, s]) => k === newAcct && s) && b2.sigs.some(([k, s]) => k === fixture.idB && !s), 'new account partial-signed; identity left for the wallet', b2 && b2.sigs);
  check(b2 && b2.decoded.json === '{"iconUrl":"https://example.com/f.png","name":"Fresh Validator"}', 'create JSON', b2 && b2.decoded.json);

  // ── wallet ≠ identity → locked ──
  await page.evaluate((F) => { walletPublicKey = F.idB; currentManageValidator = { voteAccount: F.vote, name: 'Old Name', identityPubkey: F.idA }; initiateUpdateIdentity(); }, fixture);
  await page.waitForTimeout(400);
  const c1 = await page.evaluate(() => ({ dis: identityConfirmBtn.disabled, warn: identityAuthorityWarning.style.display }));
  check(c1.dis && c1.warn === 'flex', 'other wallet → button locked + warning', c1);

  // ── validation ──
  await page.evaluate((F) => { walletPublicKey = F.idA; initiateUpdateIdentity(); }, fixture);
  await page.waitForFunction(() => !document.getElementById('identityConfirmBtn').disabled, null, { timeout: 5000 }).catch(() => {});
  const before = sent.length;
  await page.fill('#identityNameInput', 'x'.repeat(81));
  await page.click('#identityConfirmBtn');
  check(/too long/.test(await page.textContent('#identityMessage')), 'name > 80 chars refused');
  await page.fill('#identityNameInput', 'Ok');
  await page.fill('#identityWebsiteInput', 'example.com');
  await page.click('#identityConfirmBtn');
  check(/must start with http/.test(await page.textContent('#identityMessage')), 'website without http(s) refused');
  check(sent.length === before, 'nothing sent on validation errors');

  check(pageErrors.length === 0, '0 page errors', pageErrors);
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
