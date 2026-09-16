#!/usr/bin/env node
/**
 * build-rewards-ledger.js — per-validator inflation-reward history, precomputed
 *
 * WHY: "Stake Details", the earnings trend, the portfolio "Rewards Last Epoch"
 * tile and the calculators all need N epochs of rewards for a validator. Done
 * in the browser that is one getInflationReward call per epoch for the vote
 * account PLUS one per epoch for its self-stake accounts — 60 round-trips for
 * a 30-epoch APY, through a 3-slot queue, for every card. Visitors saw
 * "analyzing rewards…" for minutes.
 *
 * getInflationReward accepts a LIST of addresses (the X1 RPC takes ~300 per
 * call before the request body limit), so this script fetches a whole epoch
 * for every vote account on the network in 3 calls, and every self-stake
 * account in ~7, and publishes the result as data/rewards.json. The site reads
 * that one file (RewardsLedger in js/core.js) and only goes to the RPC for
 * epochs the ledger does not have yet (normally none, at most the newest one
 * right after an epoch boundary).
 *
 * Incremental: the previous rewards.json is loaded and only missing cells are
 * fetched — a routine hourly run costs ~10 RPC calls once a day when an epoch
 * ends, and ~0 otherwise. A validator whose self-stake account list changed
 * gets its self-stake column rebuilt for the whole window.
 *
 * Self-stake = stake accounts delegated to the vote account whose withdrawer
 * equals the vote account's authorized withdrawer — the same rule
 * fetchTotalValidatorRewards() / classifyStakeSource() use in js/core.js.
 * (Manual per-user classifications live in the browser's localStorage; the
 * site falls back to live RPC for those validators.)
 *
 * Output shape (arrays are aligned to `epochs`, lamports, null = no reward /
 * not indexed):
 *   { v, generatedAt, currentEpoch, epochs: [asc],
 *     counts: { validators, selfAccounts, rpcCalls },
 *     validators: { <vote>: { w: <withdrawer>, self: [<stake pubkey>…],
 *                             v: [vote reward…], s: [self-stake reward sum…] } } }
 *
 * Node 20+, zero dependencies.   Usage: node scripts/build-rewards-ledger.js
 * Env: X1_RPC_URL (default https://rpc.mainnet.x1.xyz)
 *      OUT (default data/rewards.json)
 *      LEDGER_EPOCHS (default 36 — completed epochs kept; the site asks for ≤ 30)
 */
'use strict';

const LEDGER_VERSION = 1;
const DEFAULTS = {
  rpcUrl: 'https://rpc.mainnet.x1.xyz',
  epochs: 36,
  addrBatch: 250,      // getInflationReward addresses per call (413 above ~350)
  gmaBatch: 100,       // getMultipleAccounts addresses per call
  concurrency: 3,      // parallel RPC calls
  retries: 4,
  timeoutMs: 60000,
  recheckNewest: 3,    // re-fetch null cells this many epochs back (late indexing)
  log: (...a) => console.log(new Date().toISOString(), ...a),
};

// ---------------------------------------------------------------- base58 --
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  const digits = [];
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start++;
  for (let k = start; k < bytes.length; k++) {
    let carry = bytes[k];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let s = '';
  for (const b of bytes) { if (b === 0) s += '1'; else break; }
  for (let i = digits.length - 1; i >= 0; i--) s += B58[digits[i]];
  return s;
}
function b64ToBytes(s) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

// ------------------------------------------------------------------- rpc --
function makeRpc(opts) {
  let calls = 0;
  async function rpc(method, params = []) {
    let lastErr;
    for (let attempt = 1; attempt <= opts.retries; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opts.timeoutMs);
      try {
        calls++;
        const r = await fetch(opts.rpcUrl, {
          method: 'POST', signal: ctrl.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
        if (!r.ok) { const e = new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`); e.fatal = true; throw e; }
        const j = await r.json();
        if (j.error) {
          const e = new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
          // -32602 invalid params / method not found etc. won't fix themselves
          e.fatal = j.error.code === -32602 || j.error.code === -32601;
          throw e;
        }
        return j.result;
      } catch (e) {
        lastErr = e;
        if (e.fatal) break;
        if (attempt < opts.retries) {
          const delay = 1500 * attempt;
          opts.log(`  ${method} failed (${e.message}); retry ${attempt + 1}/${opts.retries} in ${delay}ms`);
          await new Promise(res => setTimeout(res, delay));
        }
      } finally { clearTimeout(t); }
    }
    throw new Error(`${method}: ${lastErr && lastErr.message}`);
  }
  rpc.calls = () => calls;
  return rpc;
}

// Run async jobs with a concurrency limit; results in order.
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function chunk(arr, n) { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; }
function sameList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const x = [...a].sort(), y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

// ------------------------------------------------------------ discovery --
// Vote accounts → their authorized withdrawer (VoteState: 4-byte version,
// node_pubkey[32] at 4, authorized_withdrawer[32] at 36 — same offset in every
// VoteState version).
async function fetchVoteWithdrawers(rpc, votes, opts) {
  const out = {};
  const batches = chunk(votes, opts.gmaBatch);
  await pooled(batches, opts.concurrency, async (sl) => {
    const res = await rpc('getMultipleAccounts', [sl, { encoding: 'base64', dataSlice: { offset: 36, length: 32 } }]);
    const vals = (res && res.value) || [];
    sl.forEach((vote, i) => {
      const a = vals[i];
      if (a && a.data && a.data[0]) out[vote] = base58(b64ToBytes(a.data[0]));
    });
  });
  return out;
}

// Every stake account on the network in one call, sliced to the 120 bytes we
// need (StakeStateV2, 200 bytes): withdrawer @44, delegation.voter_pubkey @124,
// delegation.stake u64 @156. Returns { vote: [selfStakePubkey…] }.
async function fetchSelfStakeAccounts(rpc, withdrawerOf, opts) {
  const res = await rpc('getProgramAccounts', ['Stake11111111111111111111111111111111111111', {
    encoding: 'base64', dataSlice: { offset: 44, length: 120 }, filters: [{ dataSize: 200 }],
  }]);
  const self = {};
  let total = 0;
  for (const acc of res || []) {
    total++;
    const d = acc.account && acc.account.data && acc.account.data[0];
    if (!d) continue;
    const bytes = b64ToBytes(d);
    if (bytes.length < 112) continue;
    const voter = base58(bytes.subarray(80, 112));
    const w = withdrawerOf[voter];
    if (!w) continue;
    if (base58(bytes.subarray(0, 32)) !== w) continue;
    (self[voter] || (self[voter] = [])).push(acc.pubkey);
  }
  for (const k in self) self[k].sort();
  return { self, totalStakeAccounts: total };
}

// getInflationReward for many addresses in one epoch → { addr: lamports|null }
async function fetchEpochRewards(rpc, addrs, epoch, opts) {
  const out = {};
  const batches = chunk(addrs, opts.addrBatch);
  await pooled(batches, opts.concurrency, async (sl) => {
    const res = await rpc('getInflationReward', [sl, { epoch }]);
    sl.forEach((a, i) => {
      const r = Array.isArray(res) ? res[i] : null;
      out[a] = (r && r.amount != null) ? r.amount : null;
    });
  });
  return out;
}

// ---------------------------------------------------------------- build --
async function buildLedger(prev, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const rpc = opts.rpc || makeRpc(opts);
  const log = opts.log;

  const epochInfo = await rpc('getEpochInfo');
  const cur = epochInfo.epoch;
  const epochs = [];
  for (let e = Math.max(0, cur - opts.epochs); e < cur; e++) epochs.push(e);
  log(`current epoch ${cur}; window ${epochs[0]}..${epochs[epochs.length - 1]} (${epochs.length} epochs)`);

  const va = await rpc('getVoteAccounts');
  const votes = [...(va.current || []), ...(va.delinquent || [])].map(v => v.votePubkey).sort();
  log(`${votes.length} vote accounts (${(va.current || []).length} current, ${(va.delinquent || []).length} delinquent)`);

  const withdrawerOf = await fetchVoteWithdrawers(rpc, votes, opts);
  const { self, totalStakeAccounts } = await fetchSelfStakeAccounts(rpc, withdrawerOf, opts);
  const selfTotal = Object.values(self).reduce((n, l) => n + l.length, 0);
  log(`${totalStakeAccounts} stake accounts; ${selfTotal} self-stake across ${Object.keys(self).length} validators`);

  // Previous ledger → lookup tables (only if same version)
  const prevOk = prev && prev.v === LEDGER_VERSION && Array.isArray(prev.epochs) && prev.validators;
  const prevIdx = prevOk ? new Map(prev.epochs.map((e, i) => [e, i])) : new Map();

  // Decide what to fetch. Per epoch: list of vote addrs needing `v`, list of
  // (vote → self accounts) needing `s`.
  const needV = new Map(); // epoch → [vote]
  const needS = new Map(); // epoch → [vote]
  const knownNonNull = new Map(); // epoch → reused non-null vote cells (proves the epoch is indexed)
  const entries = {};
  let reusedCells = 0;
  for (const vote of votes) {
    const p = prevOk ? prev.validators[vote] : null;
    const selfList = self[vote] || [];
    const selfSame = !!p && sameList(p.self || [], selfList);
    const entry = { w: withdrawerOf[vote] || null, self: selfList, v: new Array(epochs.length).fill(null) };
    if (selfList.length) entry.s = new Array(epochs.length).fill(null);
    epochs.forEach((ep, i) => {
      const pi = prevIdx.get(ep);
      const recheck = ep >= cur - opts.recheckNewest;
      // vote reward
      if (p && pi !== undefined && p.v && p.v[pi] != null) { entry.v[i] = p.v[pi]; reusedCells++; knownNonNull.set(ep, (knownNonNull.get(ep) || 0) + 1); }
      else if (p && pi !== undefined && p.v && !recheck) { entry.v[i] = null; reusedCells++; } // known-null, old
      else { (needV.get(ep) || needV.set(ep, []).get(ep)).push(vote); }
      // self-stake reward
      if (!selfList.length) return;
      if (selfSame && pi !== undefined && p.s && p.s[pi] != null) { entry.s[i] = p.s[pi]; reusedCells++; }
      else if (selfSame && pi !== undefined && p.s && !recheck) { entry.s[i] = null; reusedCells++; }
      else { (needS.get(ep) || needS.set(ep, []).get(ep)).push(vote); }
    });
    entries[vote] = entry;
  }
  const cellsToFetch = [...needV.values()].reduce((n, l) => n + l.length, 0) + [...needS.values()].reduce((n, l) => n + l.length, 0);
  log(`reusing ${reusedCells} cells from previous ledger; fetching ${cellsToFetch} cells over ${new Set([...needV.keys(), ...needS.keys()]).size} epochs`);

  // Fetch, oldest epoch first (the newest may be un-indexed and get dropped).
  const epochsToFetch = [...new Set([...needV.keys(), ...needS.keys()])].sort((a, b) => a - b);
  const unindexed = new Set();
  for (const ep of epochsToFetch) {
    const i = epochs.indexOf(ep);
    const vList = needV.get(ep) || [];
    if (vList.length) {
      const r = await fetchEpochRewards(rpc, vList, ep, opts);
      let nonNull = 0;
      for (const vote of vList) { const a = r[vote]; entries[vote].v[i] = a; if (a != null) nonNull++; }
      // A whole epoch of nulls for every vote account = RPC has not computed
      // the epoch's rewards yet (or it is out of its history). Do not publish
      // it — the site will top it up live and we retry next run. (Not when
      // the previous ledger already holds real values for this epoch: then
      // vList is just the re-check of validators that never earn.)
      if (nonNull === 0 && !(knownNonNull.get(ep) > 0) && vList.length >= Math.min(10, votes.length)) { unindexed.add(ep); log(`epoch ${ep}: no vote rewards indexed yet — skipping`); continue; }
      log(`epoch ${ep}: vote rewards for ${vList.length} validators (${nonNull} non-null)`);
    }
    const sList = needS.get(ep) || [];
    if (sList.length) {
      const addrs = [];
      for (const vote of sList) addrs.push(...entries[vote].self);
      const r = await fetchEpochRewards(rpc, addrs, ep, opts);
      for (const vote of sList) {
        let sum = 0, any = false;
        for (const a of entries[vote].self) { const x = r[a]; if (x != null) { sum += x; any = true; } }
        entries[vote].s[i] = any ? sum : null;
      }
      log(`epoch ${ep}: self-stake rewards for ${sList.length} validators (${addrs.length} accounts)`);
    }
  }

  // Drop un-indexed epochs (only ever the newest one or two) from the window.
  const keep = epochs.map((ep, i) => ({ ep, i })).filter(x => !unindexed.has(x.ep));
  const outEpochs = keep.map(x => x.ep);
  const validators = {};
  for (const vote of votes) {
    const e = entries[vote];
    const o = { w: e.w, self: e.self, v: keep.map(x => e.v[x.i]) };
    if (e.s) o.s = keep.map(x => e.s[x.i]);
    validators[vote] = o;
  }

  return {
    v: LEDGER_VERSION,
    generatedAt: new Date().toISOString(),
    currentEpoch: cur,
    epochs: outEpochs,
    counts: { validators: votes.length, selfAccounts: selfTotal, stakeAccounts: totalStakeAccounts, rpcCalls: rpc.calls ? rpc.calls() : null },
    validators,
  };
}

// ----------------------------------------------------------------- main --
async function main() {
  const fs = require('fs');
  const path = require('path');
  const OUT = process.env.OUT || path.join(__dirname, '..', 'data', 'rewards.json');
  const opts = {
    rpcUrl: process.env.X1_RPC_URL || DEFAULTS.rpcUrl,
    epochs: Number(process.env.LEDGER_EPOCHS) || DEFAULTS.epochs,
  };
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); DEFAULTS.log(`loaded previous ledger: epochs ${prev.epochs[0]}..${prev.epochs[prev.epochs.length - 1]}, ${Object.keys(prev.validators).length} validators`); }
  catch (e) { DEFAULTS.log(`no previous ledger (${e.message}) — full build`); }

  const ledger = await buildLedger(prev, opts);
  const json = JSON.stringify(ledger);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  DEFAULTS.log(`wrote ${OUT}: ${(json.length / 1024).toFixed(0)} KB, epochs ${ledger.epochs[0]}..${ledger.epochs[ledger.epochs.length - 1]}, ${ledger.counts.rpcCalls} RPC calls`);
}

if (typeof module !== 'undefined') {
  module.exports = { buildLedger, makeRpc, base58, LEDGER_VERSION, DEFAULTS };
  if (require.main === module) {
    main().catch(e => { console.error(e); process.exit(1); });
  }
}
