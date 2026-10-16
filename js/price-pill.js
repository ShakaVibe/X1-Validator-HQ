    // ════════════════════════════════════════════════════════════════
    // XNT PRICE PILL — live price shown in the header (design 2b).
    //
    // SOURCE (2026-10-16): the XDEX WXNT/USDC.X pool, read ON-CHAIN from the
    //   X1 RPC — price = USDC.X reserve ÷ WXNT reserve. One getMultipleAccounts
    //   call per refresh: the pool state + its two token vaults.
    //   Why not XDEX's API any more: its pool list reports a cached
    //   `token_price` that lagged the real pool by ~6 % when checked
    //   ($0.1814 vs $0.1928 on-chain; x1report.com, which also reads this pool
    //   on-chain, showed $0.1928). The API is now only the fallback when the
    //   RPC read fails, and the tooltip says so.
    //
    // Pool layout (Raydium CP-swap, 637 bytes): vault0 @72, vault1 @104,
    //   mint0 @168, mint1 @200, decimals @331/332, protocol fees @341/349,
    //   fund fees @357/365 (u64 LE). Those fees sit in the vaults but are not
    //   pool liquidity, so they are subtracted. SPL token account amount @64.
    //
    // SAFETY: if neither source gives a sane price, the pill hides — never a
    //   made-up number. Calculators read window.xntPriceUsd.
    // ════════════════════════════════════════════════════════════════
    (function () {
      const POOL      = 'CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR';   // XDEX WXNT/USDC.X (deepest USD pool)
      const VAULT0    = '8wvV4HKBDFMLEUkVWp1WPNa5ano99XCm3f9t3troyLb';    // WXNT vault
      const VAULT1    = '7iw2adw8Af7x3pY7gj5RwczFXuGjCoX92Gfy3avwXQtg';   // USDC.X vault
      const XNT_MINT  = 'So11111111111111111111111111111111111111112';
      const USDC_MINT = 'B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq';   // USDC.X
      const API_URL   = 'https://api.xdex.xyz/api/xendex/pool/list?network=X1%20Mainnet';
      const REFRESH_MS = 60 * 1000;

      const slot     = document.getElementById('xntPillSlot');
      const pill     = document.getElementById('xntPricePill');
      const elPrice  = document.getElementById('xntPillPrice');
      const elChange = document.getElementById('xntPillChange');
      if (!elPrice) return;

      const b64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
      const u64 = (d, o) => Number(new DataView(d.buffer, d.byteOffset).getBigUint64(o, true));
      // base58 of 32 bytes at offset o — only used to check the pool still points at our vaults.
      const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      function b58(bytes) {
        let n = 0n; for (const b of bytes) n = (n << 8n) + BigInt(b);
        let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
        for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
        return s;
      }

      async function priceOnChain() {
        const res = await fetch(RPC_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [[POOL, VAULT0, VAULT1], { encoding: 'base64' }] })
        });
        const j = await res.json();
        const v = j && j.result && j.result.value;
        if (!v || !v[0] || !v[1] || !v[2]) throw new Error('pool accounts missing');
        const pool = b64(v[0].data[0]);
        if (pool.length < 373) throw new Error('unexpected pool size');
        if (b58(pool.slice(72, 104)) !== VAULT0 || b58(pool.slice(104, 136)) !== VAULT1 ||
            b58(pool.slice(168, 200)) !== XNT_MINT || b58(pool.slice(200, 232)) !== USDC_MINT) {
          throw new Error('pool layout / vaults changed');
        }
        const dec0 = pool[331], dec1 = pool[332];
        const xnt  = (u64(b64(v[1].data[0]), 64) - u64(pool, 341) - u64(pool, 357)) / 10 ** dec0;
        const usdc = (u64(b64(v[2].data[0]), 64) - u64(pool, 349) - u64(pool, 365)) / 10 ** dec1;
        if (!(xnt > 0) || !(usdc > 0)) throw new Error('empty reserves');
        return usdc / xnt;
      }

      async function priceFromApi() {
        const r = await fetch(API_URL, { headers: { accept: 'application/json' } });
        if (!r.ok) throw new Error('xdex HTTP ' + r.status);
        const j = await r.json();
        const p = j && Array.isArray(j.data) ? j.data.find(x => x && x.pool_address === POOL) : null;
        const price = p ? Number(p.token1_address === XNT_MINT ? p.token1_price : p.token2_price) : NaN;
        if (!(price > 0)) throw new Error('WXNT price not found');
        return price;
      }

      function fmtPrice(p) {
        let dp = 2;
        if (p < 1)    dp = 4;
        if (p < 0.01) dp = 6;
        return '$' + p.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
      }

      async function update() {
        if (typeof PowerSaver !== 'undefined' && !PowerSaver.gate('xnt.price', 10 * 60 * 1000)) return;
        let price = null, source = '';
        try { price = await priceOnChain(); source = 'XDEX WXNT/USDC.X pool, read on-chain'; }
        catch (e) {
          console.warn('[XNT pill] on-chain read failed:', (e && e.message) || e);
          try { price = await priceFromApi(); source = 'XDEX API (on-chain read failed — may lag)'; }
          catch (e2) { console.warn('[XNT pill] price unavailable:', (e2 && e2.message) || e2); }
        }
        if (!(price > 0) || !isFinite(price)) { if (slot) slot.classList.add('xnt-hidden'); return; }
        elPrice.textContent = fmtPrice(price);
        if (elChange) { elChange.textContent = ''; elChange.className = 'xnt-pill-change'; }
        if (pill) pill.title = 'XNT price — ' + source + ' · ' + new Date().toLocaleTimeString();
        window.xntPriceUsd = price;   // calculators default to the live price
        if (typeof window.applyLiveXntPrice === 'function') window.applyLiveXntPrice();
        if (slot) slot.classList.remove('xnt-hidden');
      }

      update();
      setInterval(update, REFRESH_MS);
    })();
