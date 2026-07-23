#!/usr/bin/env node
/**
 * X1 Validator HQ — canonical score generator (formula v2)
 *
 * Runs on a schedule (GitHub Actions, hourly). Fetches network data from the
 * X1 RPC, maintains rolling history (uptime, vote latency, root distance,
 * commission changes) in data/history.json, computes one canonical score per
 * validator, and writes data/scores.json for the site to consume.
 *
 * Every visitor then sees the exact same score — no more per-browser drift.
 *
 * FORMULA v2 (weights sum to 100%):
 *   Vote Efficiency  30%  credits earned vs network avg, last 7 completed epochs
 *   Skip Rate        20%  7-epoch aggregate, CONFIDENCE-WEIGHTED (small samples
 *                         are blended toward the network rate so 1-skip-of-2
 *                         doesn't nuke a small validator)
 *   Vote Latency     15%  avg (slot - lastVote) sampled 24/7, 7-day rolling
 *   Uptime           15%  % of hourly observations non-delinquent, 7-day rolling
 *   Consistency      10%  coefficient of variation of per-epoch credits
 *   Root Distance     5%  avg (slot - rootSlot), 7-day rolling
 *   Software          5%  version currency vs network latest
 *
 * PENALTY: commission rug (raise of >=10 points within trailing 7 days)
 *          subtracts 15 points from the total and sets a visible flag.
 *
 * Commission level and validator age are intentionally NOT scored — they are
 * published as informational fields only. Commission is a pricing choice, and
 * age penalizes new operators for something they can't change.
 *
 * No dependencies. Node 20+ (global fetch).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const RPC_URL = process.env.X1_RPC_URL || 'https://rpc.mainnet.x1.xyz';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FORMULA_VERSION = 2;

const SKIP_EPOCHS = 7;             // completed epochs of skip-rate history
const CREDIT_EPOCHS = 7;           // completed epochs of credit history
const SKIP_CONFIDENCE_K = 100;  // pseudo-slots blended toward network rate
const HISTORY_WINDOW_DAYS = 7;     // rolling window for uptime/latency/root
const HISTORY_PRUNE_DAYS = 9;      // keep a little slack beyond the window
const COMMISSION_RUG_POINTS = 10;  // raise of >= this many points ...
const COMMISSION_RUG_WINDOW_MS = 7 * 24 * 3600 * 1000; // ... within this window
const COMMISSION_RUG_PENALTY = 15;
const MIN_UPTIME_OBSERVATIONS = 12; // below this, fall back to current status
const LATENCY_SAMPLES = 5;          // vote-lag samples per run
const LATENCY_SAMPLE_GAP_MS = Number(process.env.LATENCY_SAMPLE_GAP_MS || 8000);
const VOTE_LAG_CAP = 512;           // slots; delinquent validators pin here
const ROOT_DIST_CAP = 5000;

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

let rpcId = 0;
async function rpc(method, params = [], retries = 3) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(`${method}: ${data.error.message}`);
      return data.result;
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// History persistence (data/history.json)
// ---------------------------------------------------------------------------
// Shape:
// {
//   uptime:  { [votePubkey]: { [YYYY-MM-DD]: { o: obs, d: delinquentObs } } },
//   latency: { [votePubkey]: { [YYYY-MM-DD]: { s: lagSum, r: rootDistSum, c: count } } },
//   commission: { [votePubkey]: [ [tsMs, commission], ... ] }  // change events only
// }

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'history.json'), 'utf8'));
  } catch (e) {
    return { uptime: {}, latency: {}, commission: {} };
  }
}

function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function pruneHistory(history, activeVoteKeys) {
  const cutoff = dayKey(Date.now() - HISTORY_PRUNE_DAYS * 24 * 3600 * 1000);
  const commissionCutoff = Date.now() - 30 * 24 * 3600 * 1000;
  for (const section of ['uptime', 'latency']) {
    const bucket = history[section] || {};
    for (const key of Object.keys(bucket)) {
      if (!activeVoteKeys.has(key)) { delete bucket[key]; continue; }
      for (const day of Object.keys(bucket[key])) {
        if (day < cutoff) delete bucket[key][day];
      }
      if (Object.keys(bucket[key]).length === 0) delete bucket[key];
    }
  }
  const comm = history.commission || {};
  for (const key of Object.keys(comm)) {
    if (!activeVoteKeys.has(key)) { delete comm[key]; continue; }
    // Keep all events inside 30 days, plus the most recent one before that
    // (so we always know the standing commission).
    const events = comm[key];
    let lastOldIdx = -1;
    for (let i = 0; i < events.length; i++) {
      if (events[i][0] < commissionCutoff) lastOldIdx = i;
    }
    if (lastOldIdx > 0) comm[key] = events.slice(lastOldIdx);
  }
}

// ---------------------------------------------------------------------------
// Component scoring
// ---------------------------------------------------------------------------

function scoreVoteEfficiency(pctOfAvg) {
  if (pctOfAvg >= 105) return 100;
  if (pctOfAvg >= 103) return 98;
  if (pctOfAvg >= 101) return 96;
  if (pctOfAvg >= 100) return 93;
  if (pctOfAvg >= 99) return 88;
  if (pctOfAvg >= 98) return 82;
  if (pctOfAvg >= 97) return 75;
  if (pctOfAvg >= 95) return 65;
  if (pctOfAvg >= 93) return 55;
  if (pctOfAvg >= 90) return 45;
  if (pctOfAvg >= 85) return 30;
  if (pctOfAvg >= 80) return 15;
  return 5;
}

function scoreSkipRate(pct) {
  if (pct <= 0.02) return 100;
  if (pct <= 0.1) return 98;
  if (pct <= 0.25) return 95;
  if (pct <= 0.5) return 90;
  if (pct <= 1.0) return 85;
  if (pct <= 2.0) return 70;
  if (pct <= 3.0) return 50;
  if (pct <= 5.0) return 35;
  if (pct <= 10.0) return 20;
  return 10;
}

function scoreConsistency(cv) {
  if (cv <= 0.1) return 100;
  if (cv <= 0.3) return 98;
  if (cv <= 0.5) return 96;
  if (cv <= 1.0) return 92;
  if (cv <= 2.0) return 85;
  if (cv <= 3.0) return 75;
  if (cv <= 5.0) return 60;
  if (cv <= 8.0) return 45;
  if (cv <= 12.0) return 30;
  return 15;
}

function scoreVoteLatency(avgLagSlots) {
  if (avgLagSlots <= 2.0) return 100;
  if (avgLagSlots <= 2.5) return 96;
  if (avgLagSlots <= 3.0) return 92;
  if (avgLagSlots <= 4.0) return 85;
  if (avgLagSlots <= 5.0) return 78;
  if (avgLagSlots <= 7.0) return 68;
  if (avgLagSlots <= 10.0) return 55;
  if (avgLagSlots <= 15.0) return 40;
  if (avgLagSlots <= 30.0) return 25;
  return 10;
}

function scoreRootDistance(avgDistSlots) {
  // A healthy tower roots ~32 slots behind the vote tip, so distance is
  // roughly (lag + 32). Chronic large values indicate replay/hardware issues.
  if (avgDistSlots <= 45) return 100;
  if (avgDistSlots <= 60) return 92;
  if (avgDistSlots <= 80) return 82;
  if (avgDistSlots <= 120) return 70;
  if (avgDistSlots <= 200) return 50;
  if (avgDistSlots <= 400) return 30;
  return 10;
}

function scoreUptime(pct) {
  if (pct >= 100) return 100;
  if (pct >= 99.9) return 98;
  if (pct >= 99.5) return 94;
  if (pct >= 99) return 88;
  if (pct >= 98) return 78;
  if (pct >= 95) return 55;
  if (pct >= 90) return 35;
  return 10;
}

function parseVersion(v) {
  return String(v).split('.').map(n => parseInt(n, 10) || 0);
}
function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function scoreVersion(version, latest) {
  if (!version) return { score: 50, details: 'Unknown version' };
  if (!latest) return { score: 75, details: `v${version}` };
  const cmp = compareVersions(version, latest);
  if (cmp >= 0) return { score: 100, details: `v${version} ✓ latest` };
  const cur = parseVersion(version), top = parseVersion(latest);
  if (cur[0] < top[0]) {
    const majorDiff = top[0] - cur[0];
    if (majorDiff >= 2) return { score: 20, details: `v${version} (very outdated)` };
    return { score: 40, details: `v${version} (major behind)` };
  }
  const minorDiff = (top[1] || 0) - (cur[1] || 0);
  if (minorDiff <= 1) return { score: 85, details: `v${version} (1 behind)` };
  if (minorDiff <= 2) return { score: 60, details: `v${version} (2 behind)` };
  return { score: 30, details: `v${version} (3+ behind)` };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[scores] RPC: ${RPC_URL}`);
  const startedAt = Date.now();

  // --- 1. Epoch + validator set ------------------------------------------
  const epochInfo = await rpc('getEpochInfo');
  const currentEpoch = epochInfo.epoch;
  const slotsPerEpoch = epochInfo.slotsInEpoch;
  const firstSlotOfCurrentEpoch = epochInfo.absoluteSlot - epochInfo.slotIndex;

  const voteAccounts = await rpc('getVoteAccounts', [{ commitment: 'confirmed' }]);
  const validators = [];
  for (const v of voteAccounts.current) validators.push({ ...v, delinquent: false });
  for (const v of voteAccounts.delinquent) validators.push({ ...v, delinquent: true });
  console.log(`[scores] epoch ${currentEpoch}, ${validators.length} validators (${voteAccounts.delinquent.length} delinquent)`);

  const activeVoteKeys = new Set(validators.map(v => v.votePubkey));

  // --- 2. Node versions ----------------------------------------------------
  const clusterNodes = await rpc('getClusterNodes').catch(() => []);
  const versionByNode = {};
  const versionCounts = {};
  for (const n of clusterNodes) {
    if (n.pubkey && n.version) {
      versionByNode[n.pubkey] = n.version;
      versionCounts[n.version] = (versionCounts[n.version] || 0) + 1;
    }
  }
  // "Latest" = highest semver run by at least 3 nodes (ignores one-off test builds)
  let latestVersion = null;
  for (const [ver, count] of Object.entries(versionCounts)) {
    if (count >= 3 && (!latestVersion || compareVersions(ver, latestVersion) > 0)) {
      latestVersion = ver;
    }
  }
  console.log(`[scores] latest version in use: ${latestVersion || 'unknown'}`);

  // --- 3. Extended epoch credits (batched getMultipleAccounts) ------------
  // getVoteAccounts only returns ~5 epochs; the parsed vote account holds up
  // to 64. We need >= 8 (current + 7 completed).
  const creditsByVote = {};
  const votePubkeys = validators.map(v => v.votePubkey);
  for (let off = 0; off < votePubkeys.length; off += 100) {
    const chunk = votePubkeys.slice(off, off + 100);
    try {
      const res = await rpc('getMultipleAccounts', [chunk, { encoding: 'jsonParsed' }]);
      (res.value || []).forEach((acct, i) => {
        const ec = acct?.data?.parsed?.info?.epochCredits;
        if (Array.isArray(ec)) {
          creditsByVote[chunk[i]] = ec.map(e => [
            Number(e.epoch), Number(e.credits), Number(e.previousCredits)
          ]);
        }
      });
    } catch (e) {
      console.warn(`[scores] getMultipleAccounts chunk ${off} failed: ${e.message}`);
    }
  }
  // Fall back to the short history from getVoteAccounts when needed
  for (const v of validators) {
    if (!creditsByVote[v.votePubkey] && Array.isArray(v.epochCredits)) {
      creditsByVote[v.votePubkey] = v.epochCredits.map(e => [e[0], e[1], e[2]]);
    }
  }

  // --- 4. Historical skip rates (one getBlockProduction per past epoch) ---
  const epochProduction = [];
  for (let i = 1; i <= SKIP_EPOCHS; i++) {
    const epochNum = currentEpoch - i;
    if (epochNum < 0) break;
    const firstSlot = firstSlotOfCurrentEpoch - i * slotsPerEpoch;
    const lastSlot = firstSlot + slotsPerEpoch - 1;
    try {
      const res = await rpc('getBlockProduction', [{ range: { firstSlot, lastSlot } }], 2);
      epochProduction.push({ epoch: epochNum, byIdentity: res?.value?.byIdentity || {} });
    } catch (e) {
      console.warn(`[scores] block production for epoch ${epochNum} unavailable: ${e.message}`);
    }
  }
  console.log(`[scores] skip-rate history: ${epochProduction.length}/${SKIP_EPOCHS} epochs`);

  // Aggregate slots per identity across available epochs
  const skipByIdentity = {}; // nodePubkey -> { leader, skipped, epochs }
  let netLeader = 0, netSkipped = 0;
  for (const { byIdentity } of epochProduction) {
    for (const [identity, prod] of Object.entries(byIdentity)) {
      if (!Array.isArray(prod) || prod.length < 2) continue;
      const rec = skipByIdentity[identity] || (skipByIdentity[identity] = { leader: 0, skipped: 0, epochs: 0 });
      rec.leader += prod[0];
      rec.skipped += (prod[0] - prod[1]);
      rec.epochs += 1;
      netLeader += prod[0];
      netSkipped += (prod[0] - prod[1]);
    }
  }
  const networkSkipRate = netLeader > 0 ? (netSkipped / netLeader) * 100 : 0;
  console.log(`[scores] network skip rate (${epochProduction.length}-epoch): ${networkSkipRate.toFixed(3)}%`);

  // --- 5. Vote latency + root distance sampling ----------------------------
  // N samples spread across the run; lag = slot - lastVote, dist = slot - root.
  const lagSum = {}, rootSum = {}, sampleCount = {};
  for (let s = 0; s < LATENCY_SAMPLES; s++) {
    if (s > 0) await sleep(LATENCY_SAMPLE_GAP_MS);
    try {
      const [slot, va] = await Promise.all([
        rpc('getSlot', [{ commitment: 'processed' }]),
        rpc('getVoteAccounts', [{ commitment: 'processed' }])
      ]);
      for (const v of [...va.current, ...va.delinquent]) {
        const key = v.votePubkey;
        const lag = Math.min(Math.max(slot - (v.lastVote || 0), 0), VOTE_LAG_CAP);
        const dist = Math.min(Math.max(slot - (v.rootSlot || 0), 0), ROOT_DIST_CAP);
        lagSum[key] = (lagSum[key] || 0) + lag;
        rootSum[key] = (rootSum[key] || 0) + dist;
        sampleCount[key] = (sampleCount[key] || 0) + 1;
      }
    } catch (e) {
      console.warn(`[scores] latency sample ${s + 1} failed: ${e.message}`);
    }
  }

  // --- 6. Update rolling history -------------------------------------------
  const history = loadHistory();
  history.uptime = history.uptime || {};
  history.latency = history.latency || {};
  history.commission = history.commission || {};
  const today = dayKey();
  const now = Date.now();

  for (const v of validators) {
    const key = v.votePubkey;

    // Uptime observation (one per run)
    const u = history.uptime[key] || (history.uptime[key] = {});
    const ud = u[today] || (u[today] = { o: 0, d: 0 });
    ud.o += 1;
    if (v.delinquent) ud.d += 1;

    // Latency daily bucket
    if (sampleCount[key]) {
      const l = history.latency[key] || (history.latency[key] = {});
      const ld = l[today] || (l[today] = { s: 0, r: 0, c: 0 });
      ld.s += lagSum[key];
      ld.r += rootSum[key];
      ld.c += sampleCount[key];
    }

    // Commission change events
    const events = history.commission[key] || (history.commission[key] = []);
    const lastComm = events.length ? events[events.length - 1][1] : null;
    if (lastComm === null || lastComm !== v.commission) {
      events.push([now, v.commission]);
    }
  }

  pruneHistory(history, activeVoteKeys);

  // --- 7. Network average credits (last 7 completed epochs) ----------------
  const perEpochNetwork = {}; // epoch -> { total, count }
  let netCreditTotal = 0, netCreditCount = 0;
  for (const v of validators) {
    const hist = creditsByVote[v.votePubkey] || [];
    if (hist.length < 2) continue;
    let vTotal = 0, vCount = 0;
    for (let i = 1; i < Math.min(hist.length, CREDIT_EPOCHS + 1); i++) {
      const entry = hist[hist.length - 1 - i];
      if (!entry || entry.length < 3) continue;
      const earned = entry[1] - entry[2];
      vTotal += earned; vCount++;
      const pe = perEpochNetwork[entry[0]] || (perEpochNetwork[entry[0]] = { total: 0, count: 0 });
      pe.total += earned; pe.count++;
    }
    if (vCount > 0 && !v.delinquent) {
      netCreditTotal += vTotal / vCount;
      netCreditCount++;
    }
  }
  const networkAverageCredits = netCreditCount > 0 ? netCreditTotal / netCreditCount : null;
  console.log(`[scores] network avg credits/epoch: ${networkAverageCredits ? networkAverageCredits.toFixed(0) : 'n/a'}`);

  // --- 8. Score every validator --------------------------------------------
  const windowCutoff = dayKey(now - HISTORY_WINDOW_DAYS * 24 * 3600 * 1000);
  const out = {};

  for (const v of validators) {
    const key = v.votePubkey;
    const hist = creditsByVote[key] || [];
    const components = {};
    const flags = [];

    // ---- Vote efficiency (30%) ----
    let effScore = 85, effDetails = 'Building history...';
    if (hist.length >= 2 && networkAverageCredits) {
      let total = 0, count = 0;
      for (let i = 1; i < Math.min(hist.length, CREDIT_EPOCHS + 1); i++) {
        const entry = hist[hist.length - 1 - i];
        if (entry && entry.length >= 3) { total += entry[1] - entry[2]; count++; }
      }
      if (count > 0) {
        const pct = ((total / count) / networkAverageCredits) * 100;
        effScore = scoreVoteEfficiency(pct);
        effDetails = `${pct.toFixed(1)}% of network avg (${count} epochs)`;
      }
    }
    components.voteEfficiency = { label: 'Vote Efficiency', score: effScore, weight: 0.30, details: effDetails };

    // ---- Skip rate (20%), confidence-weighted ----
    const skipRec = skipByIdentity[v.nodePubkey] || { leader: 0, skipped: 0, epochs: 0 };
    const rawRate = skipRec.leader > 0 ? (skipRec.skipped / skipRec.leader) * 100 : null;
    // Blend toward network rate: with few leader slots the network prior
    // dominates; with many, the validator's own record dominates.
    const blended = (skipRec.skipped + SKIP_CONFIDENCE_K * (networkSkipRate / 100)) /
                    (skipRec.leader + SKIP_CONFIDENCE_K) * 100;
    let skipDetails;
    if (skipRec.leader === 0) {
      skipDetails = `No leader slots in ${epochProduction.length} epochs (network prior applied)`;
    } else {
      skipDetails = `${rawRate.toFixed(2)}% raw · ${blended.toFixed(2)}% conf-adj (${skipRec.leader} slots, ${skipRec.epochs} epochs)`;
    }
    components.skipRate = { label: 'Skip Rate', score: scoreSkipRate(blended), weight: 0.20, details: skipDetails };

    // ---- Vote latency (15%), 7-day rolling ----
    let latencyScore = 78, latencyDetails = 'Building history...';
    let avgLag = null, avgRoot = null;
    {
      const l = history.latency[key] || {};
      let s = 0, r = 0, c = 0;
      for (const [day, d] of Object.entries(l)) {
        if (day >= windowCutoff) { s += d.s; r += d.r; c += d.c; }
      }
      if (c > 0) {
        avgLag = s / c;
        avgRoot = r / c;
        latencyScore = scoreVoteLatency(avgLag);
        latencyDetails = `${avgLag.toFixed(1)} slots behind tip (${c} samples, 7d)`;
      }
    }
    components.voteLatency = { label: 'Vote Latency', score: latencyScore, weight: 0.15, details: latencyDetails };

    // ---- Uptime (15%), 7-day rolling observations ----
    let uptimeScore, uptimeDetails, uptimePct = null, uptimeObs = 0, uptimeDel = 0;
    {
      const u = history.uptime[key] || {};
      for (const [day, d] of Object.entries(u)) {
        if (day >= windowCutoff) { uptimeObs += d.o; uptimeDel += d.d; }
      }
      if (uptimeObs >= MIN_UPTIME_OBSERVATIONS) {
        uptimePct = ((uptimeObs - uptimeDel) / uptimeObs) * 100;
        uptimeScore = scoreUptime(uptimePct);
        uptimeDetails = `${uptimePct.toFixed(2)}% of ${uptimeObs} hourly checks (7d)`;
      } else if (!v.delinquent) {
        uptimeScore = 88;
        uptimeDetails = 'Active now (building 7d history)';
      } else {
        uptimeScore = 10;
        uptimeDetails = 'Currently delinquent';
      }
    }
    components.uptime = { label: 'Uptime (7d)', score: uptimeScore, weight: 0.15, details: uptimeDetails };

    // ---- Consistency (10%) ----
    let consScore = 85, consDetails = 'Building history...';
    if (hist.length >= 4) {
      const credits = [];
      for (let i = 1; i < Math.min(hist.length, CREDIT_EPOCHS + 1); i++) {
        const entry = hist[hist.length - 1 - i];
        if (entry && entry.length >= 3) credits.push(entry[1] - entry[2]);
      }
      if (credits.length >= 3) {
        const avg = credits.reduce((a, b) => a + b, 0) / credits.length;
        const variance = credits.reduce((a, c) => a + (c - avg) ** 2, 0) / credits.length;
        const cv = avg > 0 ? (Math.sqrt(variance) / avg) * 100 : 0;
        consScore = scoreConsistency(cv);
        consDetails = `CV ${cv.toFixed(2)}% over ${credits.length} epochs`;
      } else {
        consDetails = 'Need 3+ epochs';
      }
    }
    components.consistency = { label: 'Consistency', score: consScore, weight: 0.10, details: consDetails };

    // ---- Root distance (5%) ----
    let rootScore = 82, rootDetails = 'Building history...';
    if (avgRoot !== null) {
      rootScore = scoreRootDistance(avgRoot);
      rootDetails = `${avgRoot.toFixed(0)} slots behind tip (7d avg)`;
    }
    components.rootDistance = { label: 'Root Distance', score: rootScore, weight: 0.05, details: rootDetails };

    // ---- Software version (5%) ----
    const ver = versionByNode[v.nodePubkey] || null;
    const vs = scoreVersion(ver, latestVersion);
    components.softwareVersion = { label: 'Software', score: vs.score, weight: 0.05, details: vs.details };

    // ---- Commission rug detection (penalty, not weighted) ----
    let rugPenalty = 0;
    {
      const events = history.commission[key] || [];
      for (let i = 1; i < events.length; i++) {
        const [ts, val] = events[i];
        const prev = events[i - 1][1];
        if (ts >= now - COMMISSION_RUG_WINDOW_MS && val - prev >= COMMISSION_RUG_POINTS) {
          rugPenalty = COMMISSION_RUG_PENALTY;
          flags.push('commission_rug');
          break;
        }
      }
    }

    // ---- Informational (unweighted) entries ----
    components.commissionInfo = {
      label: 'Commission', score: null, weight: 0,
      details: `${v.commission}% (informational — not scored)` +
               (rugPenalty ? ` — ⚠ raised ≥${COMMISSION_RUG_POINTS} pts in last 7d, -${COMMISSION_RUG_PENALTY} penalty` : '')
    };
    components.ageInfo = {
      label: 'Age', score: null, weight: 0,
      details: `${hist.length} epochs of history (informational — not scored)`
    };

    // ---- Total ----
    let total = 0;
    for (const c of Object.values(components)) {
      if (c.weight > 0) total += c.score * c.weight;
    }
    total = Math.round(Math.max(0, Math.min(100, total - rugPenalty)) * 100) / 100;

    out[key] = {
      score: total,
      breakdown: components,
      flags,
      nodePubkey: v.nodePubkey,
      commission: v.commission,
      delinquent: v.delinquent,
      version: ver,
      voteLag: avgLag !== null ? Math.round(avgLag * 10) / 10 : null,
      rootDistance: avgRoot !== null ? Math.round(avgRoot) : null,
      uptimePct: uptimePct !== null ? Math.round(uptimePct * 100) / 100 : null,
      uptimeObs,
      skipRate7d: rawRate !== null ? Math.round(rawRate * 100) / 100 : null,
      skipRateAdj: Math.round(blended * 100) / 100,
      leaderSlots7d: skipRec.leader,
      skipEpochs: skipRec.epochs
    };
  }

  // --- 9. Write outputs -----------------------------------------------------
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const scoresDoc = {
    formulaVersion: FORMULA_VERSION,
    generatedAt: new Date().toISOString(),
    epoch: currentEpoch,
    slot: epochInfo.absoluteSlot,
    validatorCount: validators.length,
    networkAverageCredits: networkAverageCredits ? Math.round(networkAverageCredits) : null,
    networkSkipRate: Math.round(networkSkipRate * 1000) / 1000,
    skipEpochsCovered: epochProduction.length,
    latestVersion,
    validators: out
  };

  fs.writeFileSync(path.join(DATA_DIR, 'scores.json'), JSON.stringify(scoresDoc));
  fs.writeFileSync(path.join(DATA_DIR, 'history.json'), JSON.stringify(history));

  const scored = Object.values(out);
  const avg = scored.reduce((a, v) => a + v.score, 0) / scored.length;
  console.log(`[scores] wrote ${scored.length} scores (avg ${avg.toFixed(1)}) in ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
}

main().catch(e => {
  console.error('[scores] FATAL:', e);
  process.exit(1);
});
