    // ════════════════════════════════════════════════════════════════
    // XNT PRICE PILL — live price shown in the header (design 2b).
    //
    // SOURCE: XDEX (X1's native DEX) pool list, called DIRECTLY.
    //   Each pool reports a per-token USD price. WXNT (wrapped XNT, 1:1
    //   with native XNT, mint So111…112) appears in many pools, so we take
    //   its price from the deepest-liquidity pool (highest TVL).
    //
    // REQUIRES: XDEX must allowlist this site's origin for CORS. XDEX only
    //   returns Access-Control-Allow-Origin for its own front-ends, so
    //   until x1valhq.xyz is added to that allowlist the browser blocks
    //   the response and the pill stays hidden. The moment the domain is
    //   whitelisted, the price appears on the next refresh — no code change
    //   needed. (api.xdex.xyz is already in the CSP connect-src up top.)
    //
    // SAFETY: if the request is blocked/errors or no usable WXNT price is
    //   found, the pill (and its divider) hide — never a stale/wrong number.
    //
    // 24h change: the pool list carries no price-change field, so no % is
    //   shown. To add it later, pull XDEX's history endpoint.
    // ════════════════════════════════════════════════════════════════
    (function () {
      const PRICE_URL = 'https://api.xdex.xyz/api/xendex/pool/list?network=X1%20Mainnet';
      const XNT_MINT  = 'So11111111111111111111111111111111111111112';
      const XNT_SYMS  = ['WXNT', 'XNT'];
      const REFRESH_MS = 60 * 1000; // re-fetch every 60s

      const slot     = document.getElementById('xntPillSlot');
      const elPrice  = document.getElementById('xntPillPrice');
      const elChange = document.getElementById('xntPillChange');
      if (!elPrice) return;

      // Pull WXNT's USD price out of the pool list, preferring the
      // deepest-liquidity pool it appears in.
      function extractXntPrice(json) {
        const pools = json && Array.isArray(json.data) ? json.data : null;
        if (!pools) return null;
        let best = null; // { price, tvl }
        for (const p of pools) {
          if (!p) continue;
          for (const n of [1, 2]) {
            const sym   = p['token' + n + '_symbol'];
            const addr  = p['token' + n + '_address'];
            const price = Number(p['token' + n + '_price']);
            const isXnt = addr === XNT_MINT ||
                          (sym && XNT_SYMS.indexOf(String(sym).toUpperCase()) !== -1);
            if (isXnt && isFinite(price) && price > 0) {
              const tvl = Number(p.tvl) || 0;
              if (!best || tvl > best.tvl) best = { price: price, tvl: tvl };
            }
          }
        }
        return best ? best.price : null;
      }

      function fmtPrice(p) {
        let dp = 2;
        if (p < 1)    dp = 4;
        if (p < 0.01) dp = 6;
        return '$' + p.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
      }

      async function update() {
        if (typeof PowerSaver !== 'undefined' && !PowerSaver.gate('xnt.price', 10 * 60 * 1000)) return;
        try {
          const r = await fetch(PRICE_URL, { headers: { accept: 'application/json' } });
          if (!r.ok) throw new Error('xdex HTTP ' + r.status);
          const data  = await r.json();
          const price = extractXntPrice(data);
          if (price == null) throw new Error('WXNT price not found in pool list');

          elPrice.textContent = fmtPrice(price);
          if (elChange) { elChange.textContent = ''; elChange.className = 'xnt-pill-change'; }
          // Share the live price with the calculators (they defaulted to $1.00).
          window.xntPriceUsd = price;
          if (typeof window.applyLiveXntPrice === 'function') window.applyLiveXntPrice();

          if (slot) slot.classList.remove('xnt-hidden');
        } catch (e) {
          console.warn('[XNT pill] price unavailable:', (e && e.message) ? e.message : e);
          if (slot) slot.classList.add('xnt-hidden');
        }
      }

      update();
      setInterval(update, REFRESH_MS);
    })();
