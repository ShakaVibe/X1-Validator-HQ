'use strict';
const assert = require('assert');
const { buildLedger, base58 } = require('./build-rewards-ledger.js');

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
let INDEXED_MAX = 99; // newest epoch with rewards computed
const calls = [];
function rewardFor(addr, epoch) {
  if (epoch > INDEXED_MAX) return null;
  if (VOTES.slice(2).some(v => v.addr === addr)) return null; // votes 3..12 never earn (10 of 12 — enough to trip the un-indexed guard, see run 2b)
  let h = 0; for (const c of addr) h = (h * 31 + c.charCodeAt(0)) % 1000;
  return 1000 + h + epoch;
}
async function rpc(method, params) {
  calls.push(method);
  switch (method) {
    case 'getEpochInfo': return { epoch: CUR };
    case 'getVoteAccounts': return { current: VOTES.slice(0, 4).map(v => ({ votePubkey: v.addr })), delinquent: VOTES.slice(4).map(v => ({ votePubkey: v.addr })) };
    case 'getMultipleAccounts': {
      const [addrs] = params;
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
      return addrs.map(a => { const amt = rewardFor(a, epoch); return amt == null ? null : { amount: amt, epoch }; });
    }
  }
  throw new Error('unexpected ' + method);
}
const quiet = () => {};

(async () => {
  // Run 1: full build, window 4 epochs (96..99), all indexed
  let L = await buildLedger(null, { rpc, epochs: 4, log: quiet });
  assert.deepStrictEqual(L.epochs, [96, 97, 98, 99]);
  assert.strictEqual(Object.keys(L.validators).length, 12);
  const v1 = L.validators[VOTES[0].addr];
  assert.deepStrictEqual(v1.self, ['S1', 'S2']);
  assert.deepStrictEqual(v1.v, [96, 97, 98, 99].map(e => rewardFor(VOTES[0].addr, e)));
  assert.deepStrictEqual(v1.s, [96, 97, 98, 99].map(e => rewardFor('S1', e) + rewardFor('S2', e)));
  assert.strictEqual(L.validators[VOTES[1].addr].s, undefined, 'no self → no s array');
  assert.deepStrictEqual(L.validators[VOTES[4].addr].v, [null, null, null, null]);
  console.log('run 1 ok — calls:', calls.length);

  // Run 2: epoch advanced but newest epoch not indexed yet → dropped, older reused
  CUR = 101; INDEXED_MAX = 99; calls.length = 0;
  const prev = JSON.parse(JSON.stringify(L));
  L = await buildLedger(prev, { rpc, epochs: 4, log: quiet });
  assert.deepStrictEqual(L.epochs, [97, 98, 99], 'epoch 100 dropped (unindexed)');
  assert.deepStrictEqual(L.validators[VOTES[0].addr].v, [97, 98, 99].map(e => rewardFor(VOTES[0].addr, e)));
  const rewardCalls2 = calls.filter(c => c === 'getInflationReward').length;
  // recheckNewest=3 → epochs ≥ 98 get null cells re-fetched: vote5 (98,99) and the new epoch 100 (v + s)
  console.log('run 2 ok — getInflationReward calls:', rewardCalls2);
  assert(rewardCalls2 <= 6, 'incremental run should be cheap');

  // Run 2b: same state, no new epoch. 10 never-earning validators get their
  // null cells re-checked for the 3 newest epochs — that must NOT be mistaken
  // for "epoch not indexed" (the bug the live run exposed).
  calls.length = 0;
  const L2b = await buildLedger(JSON.parse(JSON.stringify(L)), { rpc, epochs: 4, log: quiet });
  assert.deepStrictEqual(L2b.epochs, [97, 98, 99], 'indexed epochs must survive a null-only recheck');
  console.log('run 2b ok — recheck of never-earning validators keeps the epoch');

  // Run 3: epoch 100 now indexed; vote1 gained a self-stake account → its s column rebuilt
  INDEXED_MAX = 100; calls.length = 0;
  STAKES.push(['S6', VOTES[0].w, VOTES[0].pk]);
  L = await buildLedger(JSON.parse(JSON.stringify(L)), { rpc, epochs: 4, log: quiet });
  assert.deepStrictEqual(L.epochs, [97, 98, 99, 100]);
  const v1c = L.validators[VOTES[0].addr];
  assert.deepStrictEqual(v1c.self, ['S1', 'S2', 'S6']);
  assert.deepStrictEqual(v1c.s, [97, 98, 99, 100].map(e => rewardFor('S1', e) + rewardFor('S2', e) + rewardFor('S6', e)));
  // vote3's self column untouched (reused) for 97..99
  assert.deepStrictEqual(L.validators[VOTES[2].addr].s, [97, 98, 99, 100].map(e => rewardFor('S4', e)));
  console.log('run 3 ok — getInflationReward calls:', calls.filter(c => c === 'getInflationReward').length);

  // Run 4: nothing changed → zero reward calls except recheck of null cells
  calls.length = 0;
  L = await buildLedger(JSON.parse(JSON.stringify(L)), { rpc, epochs: 4, log: quiet });
  const rc4 = calls.filter(c => c === 'getInflationReward').length;
  console.log('run 4 ok — getInflationReward calls:', rc4);
  assert(rc4 <= 3);
  console.log('ALL OK');
})().catch(e => { console.error(e); process.exit(1); });
