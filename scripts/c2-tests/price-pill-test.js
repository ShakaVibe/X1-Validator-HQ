// Offline check of the XNT price pill (js/price-pill.js): the RPC is mocked with a
// getMultipleAccounts answer for the XDEX WXNT/USDC.X pool + its two vaults,
// so the pill must show USDC ÷ WXNT reserves minus the pool's protocol/fund fees (≈ $0.19).
// Then: RPC broken → falls back to the XDEX API price (tooltip says so); both broken → hidden.
//   node scripts/c2-tests/price-pill-test.js /path/to/repo
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.argv[2] || '.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
// Synthetic pool + vaults with the real addresses and the reserves/fees seen on 2026-10-16
// (vault0 23,239.18 WXNT incl. fees, vault1 4,557.4 USDC.X incl. fees) — layout per the pill's header.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58dec(s) { let n = 0n; for (const c of s) n = n * 58n + BigInt(B58.indexOf(c)); const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; } for (const c of s) { if (c !== '1') break; out.unshift(0); } while (out.length < 32) out.unshift(0); return Buffer.from(out); }
const pool = Buffer.alloc(637), v0 = Buffer.alloc(165), v1 = Buffer.alloc(165);
b58dec('8wvV4HKBDFMLEUkVWp1WPNa5ano99XCm3f9t3troyLb').copy(pool, 72);
b58dec('7iw2adw8Af7x3pY7gj5RwczFXuGjCoX92Gfy3avwXQtg').copy(pool, 104);
b58dec('So11111111111111111111111111111111111111112').copy(pool, 168);
b58dec('B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq').copy(pool, 200);
pool[331] = 9; pool[332] = 6;
pool.writeBigUInt64LE(1017018152684n, 341); pool.writeBigUInt64LE(315557991n, 349);
pool.writeBigUInt64LE(187148440326n, 357); pool.writeBigUInt64LE(53988999n, 365);
v0.writeBigUInt64LE(23239183351570n - 2039280n, 64);   // WXNT vault amount
v1.writeBigUInt64LE(4615890000n, 64);                  // USDC.X vault amount
const POOL_B64 = pool.toString('base64'), V0_B64 = v0.toString('base64'), V1_B64 = v1.toString('base64');
const u = (b, o) => Number(b.readBigUInt64LE(o));
const EXPECT = ((u(v1, 64) - u(pool, 349) - u(pool, 365)) / 1e6) / ((u(v0, 64) - u(pool, 341) - u(pool, 357)) / 1e9);
let fails = 0;
const check = (ok, label, extra) => { console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok || extra === undefined ? '' : ' — ' + JSON.stringify(extra))); if (!ok) fails++; };

async function run(browser, port, { rpcOk, apiOk }) {
  const page = await browser.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, async r => {
    const url = r.request().url();
    if (/api\.xdex\.xyz/.test(url)) {
      if (!apiOk) return r.abort();
      return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ data: [{ pool_address: 'CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR', token1_address: 'So11111111111111111111111111111111111111112', token1_price: 0.1814, token2_price: 1 }] }) });
    }
    if (!/rpc\.mainnet\.x1\.xyz/.test(url) || r.request().method() !== 'POST') return r.abort();
    let q; try { q = JSON.parse(r.request().postData()); } catch (e) { q = {}; }
    const one = (q) => (q.method === 'getMultipleAccounts' && rpcOk)
      ? { jsonrpc: '2.0', id: q.id, result: { context: { slot: 1 }, value: [POOL_B64, V0_B64, V1_B64].map(d => ({ data: [d, 'base64'], lamports: 1, owner: 'x', executable: false })) } }
      : { jsonrpc: '2.0', id: q.id, result: null };
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)) });
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const s = await page.evaluate(() => ({ text: document.getElementById('xntPillPrice').textContent, hidden: document.getElementById('xntPillSlot').classList.contains('xnt-hidden'), title: document.getElementById('xntPricePill').title, global: window.xntPriceUsd }));
  await page.close();
  return { ...s, errs };
}

(async () => {
  await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const browser = await chromium.launch();
  const fmt = '$' + EXPECT.toFixed(4);
  let s = await run(browser, port, { rpcOk: true, apiOk: true });
  check(s.text === fmt && !s.hidden && Math.abs(s.global - EXPECT) < 1e-12, 'on-chain reserves → ' + fmt, s);
  check(/read on-chain/.test(s.title) && s.errs.length === 0, 'tooltip names the on-chain source, 0 page errors', s);
  s = await run(browser, port, { rpcOk: false, apiOk: true });
  check(s.text === '$0.1814' && !s.hidden && /XDEX API/.test(s.title), 'RPC broken → XDEX API fallback, tooltip says so', s);
  s = await run(browser, port, { rpcOk: false, apiOk: false });
  check(s.hidden, 'both broken → pill hidden', s);
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
