'use strict';
const assert = require('assert');
const { buildLedger, base58, pointValueFrom, creditsRow } = require('./build-rewards-ledger.js');

// --- base58 sanity: known vector (all-zero 32 bytes → 32 x '1')
assert.strictEqual(base58(new Uint8Array(32)), '1'.repeat(32));
assert.strictEqual(base58(Uint8Array.from([0, 0, 1])), '112');

// --- deterministic fake chain
const b64 = bytes => Buffer.from(bytes).toString('base64');
function pk(seed) { const b = new Uint8Array(32); b[0] = 1; b[31] = seed; return b; }
const VOTES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(i => ({ pk: pk(i), addr: base58(pk(i)), w: pk(100 + i) }));
// stake accounts: [pubkeyAddr, withdrawerBytes, voterBytes]
let STAKES = [
  ['S1', VOTES[0].w, VOTES[0].pk],   // self of vote1
  ['S2', VOTES[0].w, VOTES[0].pk],   // self of vote1
  ['S3', pk(200), VOTES[0].pk],      // community stake on vote1
  ['S4', VOTES[2].w, VOTES[2].pk],   // self of vote3
  ['S5', pk(201), VOTES[3].pk],
];
let CUR = 100;
let STAKE_LAMPORTS = 859275122394151; // 859,275.122 XNT
let INDEXED_MAX = 99; // newest epoch with rewards computed
const calls = [];
function rewardFor(addr, epoch) {
  if (epoch > INDEXED_MAX) return null;
  if (VOTES.slice(2).some(v => v.addr === addr)) return null; // votes 3..12 never earn (10 of 12 — enough to trip the un-indexed guard, see run 2b)
  let h = 0; for (const c of addr) h = (h * 31 + c.charCodeAt(0)) % 1000;
  return 1000 + h + epoch;
}
// --- vote credits + point value (audit 2026-11-17 #28)
// Credits a validator earned per epoch. vote5 stopped earning after epoch 97 (offline since),
// vote6 only exists from epoch 98, vote12's account cannot be read; the others always vote.
const PV = 5.4e-11, RENT = 2282880;
function creditsFor(i, epoch) {                       // i = index into VOTES
  if (i === 11) return undefined;                     // unreadable account
  if (i === 4 && epoch > 97) return null;             // no entry: offline
  if (i === 5 && epoch < 98) return null;             // not created yet
  return 3000000 + i * 1000 + epoch;
}
function epochCreditsOf(i) {
  if (i === 11) return null;
  const out = []; let total = 0;
  for (let ep = 60; ep < CUR; ep++) { const c = creditsFor(i, ep); if (c == null) continue; out.push({ epoch: ep, credits: String(total + c), previousCredits: String(total) }); total += c; }
  return out;
}
const ownerIndex = (addr) => { const s = STAKES.find(x => x[0] === addr); return s ? VOTES.findIndex(v => v.pk === s[2]) : -1; };
// A stake account's reward, shaped so that amount = PV × stake × credits × (1 − 10 %) holds for the
// stake it had before the reward. S2 also holds 5 % extra undelegated lamports: an honest outlier.
function stakeReward(addr, epoch) {
  const amount = rewardFor(addr, epoch); if (amount == null) return null;
  const cr = creditsFor(ownerIndex(addr), epoch);
  const stake = Math.round(amount / (PV * cr * 0.9));
  return { amount, epoch, commission: 10, postBalance: Math.round(stake * (addr === 'S2' ? 1.05 : 1)) + amount + RENT };
}
async function rpc(method, params) {
  calls.push(method);
  switch (method) {
    case 'getMinimumBalanceForRentExemption': assert.strictEqual(params[0], 200); return RENT;
    case 'getEpochInfo': return { epoch: CUR };
    case 'getVoteAccounts': return { current: VOTES.slice(0, 4).map((v, i) => ({ votePubkey: v.addr, activatedStake: STAKE_LAMPORTS + i, commission: 10 })), delinquent: VOTES.slice(4).map(v => ({ votePubkey: v.addr, activatedStake: 0, commission: 100 })) };
    case 'getMultipleAccounts': {
      const [addrs, cfg] = params;
      if (cfg && cfg.encoding === 'jsonParsed') {
        return { value: addrs.map(a => { const i = VOTES.findIndex(x => x.addr === a); const ec = i < 0 ? null : epochCreditsOf(i); return ec ? { data: { program: 'vote', parsed: { type: 'vote', info: { epochCredits: ec } } } } : null; }) };
      }
      return { value: addrs.map(a => { const v = VOTES.find(x => x.addr === a); return v ? { data: [b64(v.w), 'base64'] } : null; }) };
    }
    case 'getProgramAccounts':
      return STAKES.map(([addr, w, voter]) => {
        const d = new Uint8Array(120); d.set(w, 0); d.set(voter, 80);
        return { pubkey: addr, account: { data: [b64(d), 'base64'] } };
      });
    case 'getInflationReward': {
      const [addrs, { epoch }] = params;
      assert(addrs.length <= 250);
      return addrs.map(a => { if (STAKES.some(x => x[0] === a)) return stakeReward(a, epoch); const amt = rewardFor(a, epoch); return amt == null ? null : { amount: amt, epoch, commission: null, postBalance: 1 }; });
    }
  }
  throw new Error('unexpected ' + method);
}
const quiet = () => {};

(async () => {
  // Run 1: full build, window 4 epochs (96..99), all indexed
  let L = await buildLedger(null, { rpc, epochs: 4, log: quiet, pvMinAccounts: 3 });
  assert.deepStrictEqual(L.epochs, [96, 97, 98, 99]);
  assert.strictEqual(Object.keys(L.validators).length, 12);
  const v1 = L.validators[VOTES[0].addr];
  assert.deepStrictEqual(v1.self, ['S1', 'S2']);
  assert.deepStrictEqual(v1.v, [96, 97, 98, 99].map(e => rewardFor(VOTES[0].addr, e)));
  assert.deepStrictEqual(v1.s, [96, 97, 98, 99].map(e => rewardFor('S1', e) + rewardFor('S2', e)));
  assert.strictEqual(L.validators[VOTES[1].addr].s, undefined, 'no self → no s array');
  assert.deepStrictEqual(L.validators[VOTES[4].addr].v, [null, null, null, null]);
  // F11: stake (XNT, 3 dp) + commission recorded against every fetched cell
  assert.deepStrictEqual(v1.st, [859275.122, 859275.122, 859275.122, 859275.122]);
  assert.deepStrictEqual(v1.c, [10, 10, 10, 10]);
  assert.deepStrictEqual(L.validators[VOTES[4].addr].st, [0, 0, 0, 0]);
  // #28: credits per epoch and the point value
  const near = (a, b) => Math.abs(a / b - 1) < 1e-6;
  assert.deepStrictEqual(v1.cr, [96, 97, 98, 99].map(e => creditsFor(0, e)), 'credits earned per epoch');
  assert.deepStrictEqual(L.validators[VOTES[4].addr].cr, [creditsFor(4, 96), creditsFor(4, 97), 0, 0], 'no entry after the first on record → 0 (offline all epoch)');
  assert.deepStrictEqual(L.validators[VOTES[5].addr].cr, [null, null, creditsFor(5, 98), creditsFor(5, 99)], 'before the first epoch on record → null');
  assert.deepStrictEqual(L.validators[VOTES[11].addr].cr, [null, null, null, null], 'unreadable vote account → null');
  assert.strictEqual(L.pv.length, 4);
  assert.ok(L.pv.every(x => near(x, PV)), 'point value read from the self-stake rewards, the outlier account does not move the median: ' + L.pv);
  console.log('run 1 ok — calls:', calls.length);

  // Run 2: epoch advanced but newest epoch not indexed yet → dropped, older reused
  CUR = 101; INDEXED_MAX = 99; calls.length = 0;
  const prev = JSON.parse(JSON.stringify(L));
  L = await buildLedger(prev, { rpc, epochs: 4, log: quiet, pvMinAccounts: 3 });
  assert.deepStrictEqual(L.epochs, [97, 98, 99], 'epoch 100 dropped (unindexed)');
  assert.deepStrictEqual(L.validators[VOTES[0].addr].v, [97, 98, 99].map(e => rewardFor(VOTES[0].addr, e)));
  assert.deepStrictEqual(L.pv, prev.pv.slice(1), 'point values carried over, aligned to the new window (epoch 100 dropped)');
  assert.deepStrictEqual(L.validators[VOTES[0].addr].cr, [97, 98, 99].map(e => creditsFor(0, e)));
  const rewardCalls2 = calls.filter(c => c === 'getInflationReward').length;
  // recheckNewest=3 → epochs ≥ 98 get null cells re-fetched: vote5 (98,99) and the new epoch 100 (v + s)
  console.log('run 2 ok — getInflationReward calls:', rewardCalls2);
  assert(rewardCalls2 <= 6, 'incremental run should be cheap');

  // Run 2b: same state, no new epoch. 10 never-earning validators get their
  // null cells re-checked for the 3 newest epochs — that must NOT be mistaken
  // for "epoch not indexed" (the bug the live run exposed).
  calls.length = 0;
  const L2b = await buildLedger(JSON.parse(JSON.stringify(L)), { rpc, epochs: 4, log: quiet, pvMinAccounts: 3 });
  assert.deepStrictEqual(L2b.epochs, [97, 98, 99], 'indexed epochs must survive a null-only recheck');
  console.log('run 2b ok — recheck of never-earning validators keeps the epoch');

  // Run 3: epoch 100 now indexed; vote1 gained a self-stake account → its s column rebuilt.
  // Stake also grew: the new epoch's cell must carry the NEW stake, older cells keep the stake they were fetched with.
  INDEXED_MAX = 100; calls.length = 0; STAKE_LAMPORTS = 900000000000000;
  STAKES.push(['S6', VOTES[0].w, VOTES[0].pk]);
  L = await buildLedger(JSON.parse(JSON.stringify(L)), { rpc, epochs: 4, log: quiet, pvMinAccounts: 3 });
  assert.deepStrictEqual(L.epochs, [97, 98, 99, 100]);
  const v1c = L.validators[VOTES[0].addr];
  assert.deepStrictEqual(v1c.self, ['S1', 'S2', 'S6']);
  assert.deepStrictEqual(v1c.s, [97, 98, 99, 100].map(e => rewardFor('S1', e) + rewardFor('S2', e) + rewardFor('S6', e)));
  // vote3's self column untouched (reused) for 97..99
  assert.deepStrictEqual(L.validators[VOTES[2].addr].s, [97, 98, 99, 100].map(e => rewardFor('S4', e)));
  assert.deepStrictEqual(v1c.st, [859275.122, 859275.122, 859275.122, 900000], 'per-epoch stake: old cells carried, new cell current');
  assert.strictEqual(L.pv.length, 4); assert.ok(L.pv.every(x => near(x, PV)), 'new epoch 100 got its point value: ' + L.pv);
  assert.deepStrictEqual(v1c.cr, [97, 98, 99, 100].map(e => creditsFor(0, e)));
  assert.deepStrictEqual(L.validators[VOTES[4].addr].cr, [creditsFor(4, 97), 0, 0, 0]);
  // a ledger written before pv existed → the whole window's point values are read once
  const noPv = JSON.parse(JSON.stringify(L)); delete noPv.pv; for (const e of Object.values(noPv.validators)) delete e.cr;
  const L3pv = await buildLedger(noPv, { rpc, epochs: 4, log: quiet, pvMinAccounts: 3 });
  assert.ok(L3pv.pv.length === 4 && L3pv.pv.every(x => near(x, PV)), 'backfill of pv for a pre-#28 ledger');
  assert.deepStrictEqual(L3pv.validators[VOTES[0].addr].cr, v1c.cr);
  assert.deepStrictEqual(L3pv.validators[VOTES[0].addr].v, v1c.v, 'reward cells untouched by the backfill');
  // too few accounts, or accounts that disagree → no point value is published for that epoch
  const few = await buildLedger(noPv, { rpc, epochs: 4, log: quiet, pvMinAccounts: 20 });
  assert.deepStrictEqual(few.pv, [null, null, null, null], 'fewer self-stake accounts than pvMinAccounts → null');
  const crOf = { A: { earned: new Map([[7, 1000]]), first: 1 } }, own = { a: 'A', b: 'A', c: 'A', d: 'A' };
  const det = (stake, amount) => ({ amount, commission: 0, postBalance: stake + amount + RENT });
  const o = { pvMinAccounts: 3, pvMinAgree: 0.5 };
  assert.ok(near(pointValueFrom({ a: det(1e12, 50000), b: det(1e12, 50000), c: det(1e12, 50000), d: det(5e12, 50000) }, own, crOf, 7, RENT, o).pv, 5e-11), 'three agree, one outlier → median');
  assert.strictEqual(pointValueFrom({ a: det(1e12, 50000), b: det(2e12, 50000), c: det(3e12, 50000), d: det(5e12, 50000) }, own, crOf, 7, RENT, o).pv, null, 'no agreement → null');
  assert.strictEqual(pointValueFrom({ a: det(1e12, 50000), b: null, c: { amount: 5, commission: 100, postBalance: 9e9 } }, own, crOf, 7, RENT, o).pv, null, 'nothing usable → null');
  assert.deepStrictEqual(creditsRow({ earned: new Map([[5, 10], [7, 30]]), first: 5 }, [4, 5, 6, 7, 8]), [null, 10, 0, 30, 0]);
  assert.deepStrictEqual(creditsRow(undefined, [4, 5]), [null, null]);
  // a ledger written before st/c existed → carried cells are null, fetched ones filled
  const legacy = JSON.parse(JSON.stringify(L)); for (const e of Object.values(legacy.validators)) { delete e.st; delete e.c; }
  const L3b = await buildLedger(legacy, { rpc, epochs: 4, log: quiet, pvMinAccounts: 3 });
  assert.deepStrictEqual(L3b.validators[VOTES[0].addr].st, [null, null, null, null], 'reused pre-F11 cells → null stake (never back-filled with today\'s stake)');
  const st5 = L3b.validators[VOTES[4].addr].st; // never earns → its 3 newest null cells are re-fetched → stake recorded
  assert.strictEqual(st5[0], null); assert.strictEqual(st5[3], 0, 're-fetched cell → stake filled');
  console.log('run 3 ok — getInflationReward calls:', calls.filter(c => c === 'getInflationReward').length);

  // Run 4: nothing changed → zero reward calls except recheck of null cells
  calls.length = 0;
  L = await buildLedger(JSON.parse(JSON.stringify(L)), { rpc, epochs: 4, log: quiet, pvMinAccounts: 3 });
  const rc4 = calls.filter(c => c === 'getInflationReward').length;
  console.log('run 4 ok — getInflationReward calls:', rc4);
  assert(rc4 <= 3);
  assert.ok(L.pv.every(x => near(x, PV)) && !calls.includes('getMinimumBalanceForRentExemption'), 'known point values are reused: no rent lookup, no extra reward calls');
  console.log('ALL OK');
})().catch(e => { console.error(e); process.exit(1); });
