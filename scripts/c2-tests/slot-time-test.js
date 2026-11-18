// One measured slot time for every countdown (audit 2026-11-17 #8).
// The leader band, the epoch bar, the skip monitor and the Slot Explorer used
// fixed 420 / 400 ms slot constants; the chain runs at ~366 ms, so "Next leader
// slot in …" read ~15 % too long. Everything now reads measuredSlotMs()
// (js/core.js), which ensureMeasuredSlotMs() fills from one
// getRecentPerformanceSamples(60) call per session hour.
//
// Offline: serves the repo, mocks the RPC (60 one-minute samples of 164 slots
// → 365.85 ms), aborts every other external request, and checks
//   1. the measurement happens on page load, once, and is shared;
//   2. the card's leader band, the epoch bar and epochs/year use it;
//   3. a reload reuses the session cache (no second measurement);
//   4. an RPC that cannot answer → 368 ms fallback, and no retry storm;
//   5. no fixed slot-time constant is left in js/.
//   node scripts/c2-tests/slot-time-test.js /path/to/repo
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

const VOTE = 'VoteSLoTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', NODE = 'NodeSLoTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const SLOT_INDEX = 100000, SLOTS_IN_EPOCH = 216000, EPOCH = 447;
const NEXT_LEADER_IN = 13200;                       // slots until the validator's next leader slot
const SLOT_MS = 60000 / 164;                        // 365.85 ms — what the mocked samples measure
let perfBroken = false; const perf60 = [];          // calls to getRecentPerformanceSamples(60)

let fails = 0;
const check = (ok, label, extra) => { console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok || extra === undefined ? '' : ' — ' + JSON.stringify(extra))); if (!ok) fails++; };
// the site's own formatters, restated
const fmtLeader = (ms) => { const m = Math.floor(Math.max(0, ms) / 60000); if (m < 1) return '<1m'; if (m < 60) return `~${m}m`; const h = Math.floor(m / 60), r = m % 60; return r > 0 ? `~${h}h ${r}m` : `~${h}h`; };
const fmtEpoch = (sec) => { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h > 0 ? `${h}h ${m}m` : `${m}m`; };

async function newPage(browser) {
  const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, async r => {
    const u = r.request().url();
    if (!/rpc\.mainnet\.x1\.xyz/.test(u) || r.request().method() !== 'POST') return r.abort();
    let body; try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) { body = {}; }
    const one = (q) => {
      const ok = (result) => ({ jsonrpc: '2.0', id: q.id, result });
      const p = q.params || [];
      switch (q.method) {
        case 'getEpochInfo': return ok({ absoluteSlot: 96000000 + SLOT_INDEX, blockHeight: 95000000, epoch: EPOCH, slotIndex: SLOT_INDEX, slotsInEpoch: SLOTS_IN_EPOCH, transactionCount: 1 });
        case 'getRecentPerformanceSamples':
          if (p[0] === 60) {
            perf60.push(Date.now());
            if (perfBroken) return { jsonrpc: '2.0', id: q.id, error: { code: -32603, message: 'mock: samples unavailable' } };
          }
          return ok(Array.from({ length: p[0] || 1 }, (_, i) => ({ slot: 96000000 - i * 164, numSlots: 164, numTransactions: 16400, numNonVoteTransactions: 400, samplePeriodSecs: 60 })));
        case 'getLeaderSchedule': return ok({ [NODE]: [SLOT_INDEX + NEXT_LEADER_IN, SLOT_INDEX + NEXT_LEADER_IN + 1, SLOT_INDEX + NEXT_LEADER_IN + 2, SLOT_INDEX + NEXT_LEADER_IN + 3] });
        case 'getVoteAccounts': return ok({ current: [], delinquent: [] });
        default: return ok(null);
      }
    };
    const out = Array.isArray(body) ? body.map(one) : one(body);
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(out) });
  });
  return { page, pageErrors };
}
const open = async (page, port) => {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof measuredSlotMs === 'function' && typeof ensureMeasuredSlotMs === 'function' && typeof renderValidatorCard === 'function', null, { timeout: 15000 });
  await page.evaluate(() => { const m = document.getElementById('disclaimerModal'); if (m) m.style.display = 'none'; });
};

(async () => {
  await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const browser = await chromium.launch();

  // ── 1. measured on load, once ─────────────────────────────────────────────────────────────
  console.log('1. Page load measures the slot time once');
  const { page, pageErrors } = await newPage(browser);
  await open(page, port);
  await page.evaluate(() => setEpochBaseline({ epoch: 447, slotIndex: 100000, slotsInEpoch: 216000 }));   // what loadNetworkStats() does with getEpochInfo
  await page.waitForFunction((ms) => Math.abs(measuredSlotMs() - ms) < 0.01, SLOT_MS, { timeout: 10000 }).catch(() => {});
  const m1 = await page.evaluate(async () => ({ ms: measuredSlotMs(), ensured: await ensureMeasuredSlotMs(), again: await ensureMeasuredSlotMs(), cache: JSON.parse(sessionStorage.getItem('x1SlotTimeCache') || 'null'), epy: (currentSlotsInEpoch = 216000, epochsPerYear()), aprEpy: window.aprEpochsPerYear() }));
  check(Math.abs(m1.ms - SLOT_MS) < 0.01 && Math.abs(m1.ensured - SLOT_MS) < 0.01, `measuredSlotMs() = ${m1.ms.toFixed(2)} ms from 60 one-minute samples (164 slots each)`, m1);
  check(perf60.length === 1, 'exactly one getRecentPerformanceSamples(60) call, repeated ensure calls reuse it', perf60.length);
  check(m1.cache && Math.abs(m1.cache.data * 1000 - SLOT_MS) < 0.01, 'cached in sessionStorage.x1SlotTimeCache (seconds)', m1.cache);
  const epyWant = 365.25 * 86400 * 1000 / (SLOTS_IN_EPOCH * SLOT_MS);
  check(Math.abs(m1.epy - epyWant) < 0.01 && m1.aprEpy === m1.epy, `epochs/year = ${m1.epy.toFixed(2)} (core and the APR module agree)`, { m1, epyWant });

  // ── 2. the countdowns use it ──────────────────────────────────────────────────────────────
  console.log('2. Countdowns');
  await page.evaluate(({ VOTE, NODE }) => {
    document.getElementById('resultsSection').style.display = 'block';
    document.getElementById('validatorResults').innerHTML = renderValidatorCard({ voteAccount: VOTE, nodePubkey: NODE, name: 'SlotTime', commission: 10, activatedStake: 50000, rewardsBalance: 1, isDelinquent: false, version: '4.0.4', performanceScore: 97.5, skipRate: 0, epochCredits: 1, epochCreditsHistory: [], iconUrl: '' }, true, false);
  }, { VOTE, NODE });
  await page.waitForFunction(() => { const c = document.querySelector('#validatorResults .vh-next-leader'); return c && /Next leader slot in/.test(c.textContent); }, null, { timeout: 20000 }).catch(() => {});
  const band = await page.evaluate(() => { const c = document.querySelector('#validatorResults .vh-next-leader'); return c ? c.textContent : null; });
  const wantBand = 'Next leader slot in ' + fmtLeader(NEXT_LEADER_IN * SLOT_MS), oldBand = 'Next leader slot in ' + fmtLeader(NEXT_LEADER_IN * 420);
  check(band === wantBand && band !== oldBand, `leader band: "${band}" for a slot ${NEXT_LEADER_IN.toLocaleString()} slots away (the 420 ms constant said "${oldBand}")`, { band, wantBand });
  const bar = await page.evaluate(() => { setEpochBaseline({ epoch: 447, slotIndex: 100000, slotsInEpoch: 216000 }); return { time: document.getElementById('epochTimeRemaining').textContent, pct: document.getElementById('epochPercent').textContent }; });
  const wantBar = fmtEpoch((SLOTS_IN_EPOCH - SLOT_INDEX) * SLOT_MS / 1000), oldBar = fmtEpoch((SLOTS_IN_EPOCH - SLOT_INDEX) * 0.4);
  check(bar.time === wantBar && bar.time !== oldBar && bar.pct === '46.3%', `epoch bar: ${bar.time} left at ${bar.pct} (the 400 ms constant said ${oldBar})`, { bar, wantBar });

  // ── 3. a reload reuses the session cache ──────────────────────────────────────────────────
  console.log('3. Reload');
  await open(page, port);
  await page.evaluate(() => setEpochBaseline({ epoch: 447, slotIndex: 100000, slotsInEpoch: 216000 }));
  await page.waitForTimeout(800);
  const m3 = await page.evaluate(() => measuredSlotMs());
  check(perf60.length === 1 && Math.abs(m3 - SLOT_MS) < 0.01, 'after a reload: same value, no second measurement', { calls: perf60.length, m3 });
  check(pageErrors.length === 0, 'page errors: ' + JSON.stringify(pageErrors));

  // ── 4. RPC cannot answer → fallback, no retry storm ───────────────────────────────────────
  console.log('4. Measurement fails');
  perfBroken = true; perf60.length = 0;
  const b = await newPage(browser);                  // new context = empty sessionStorage
  await open(b.page, port);
  const m4 = await b.page.evaluate(async () => {
    setEpochBaseline({ epoch: 447, slotIndex: 100000, slotsInEpoch: 216000 });
    const a = await ensureMeasuredSlotMs();
    for (let i = 0; i < 5; i++) { setEpochBaseline({ epoch: 447, slotIndex: 100000, slotsInEpoch: 216000 }); await ensureMeasuredSlotMs(); }
    return { a, ms: measuredSlotMs(), time: document.getElementById('epochTimeRemaining').textContent };
  });
  check(m4.ms === 368 && m4.a === 368, 'fallback 368 ms while the RPC cannot answer', m4);
  check(perf60.length === 1, 'one attempt only (a failed measurement is not retried for 5 minutes)', perf60.length);
  check(m4.time === fmtEpoch((SLOTS_IN_EPOCH - SLOT_INDEX) * 0.368), `epoch bar still renders from the fallback (${m4.time})`, m4);
  check(b.pageErrors.length === 0, 'page errors: ' + JSON.stringify(b.pageErrors));

  // ── 5. no fixed slot-time constant left in js/ ────────────────────────────────────────────
  console.log('5. Source');
  const left = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'))) {
    fs.readFileSync(path.join(ROOT, 'js', f), 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/\b(SLOT_MS|SM_SLOT_MS|_EPOCH_SLOT_MS|HOUR_SLOTS)\b/.test(code.replace(/EPOCH_CALC_SLOT_MS/g, '')) || /[*/]\s*0\.42\b/.test(code) || /[*/]\s*420\b/.test(code)) left.push(f + ':' + (i + 1) + ' ' + line.trim().slice(0, 80));
    });
  }
  check(left.length === 0, 'no 420 ms / 0.42 s / 400 ms slot constant in js/*.js', left);

  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
