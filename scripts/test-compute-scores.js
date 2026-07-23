#!/usr/bin/env node
// End-to-end test for compute-scores.js against a mocked RPC.
// Run: node scripts/test-compute-scores.js
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn('node', args, { env, stdio: 'inherit' });
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    p.on('error', reject);
  });
}
const http = require('http');

const DATA_DIR = '/tmp/x1hq-test-data';
fs.rmSync(DATA_DIR, { recursive: true, force: true });

// ---- Synthetic network ----------------------------------------------------
const SLOTS_PER_EPOCH = 43200;
const CURRENT_EPOCH = 800;
let currentSlot = CURRENT_EPOCH * SLOTS_PER_EPOCH + 20000;

// v1: big healthy validator. v2: tiny validator, 1 skip out of 2 leader slots
// (must NOT be nuked thanks to confidence weighting). v3: delinquent laggard.
// v4: commission rugger (raises 5% -> 40% between runs).
const validators = [
  { vote: 'Vote111', node: 'Node111', commission: 5, delinquent: false, lagSlots: 1, version: '2.1.0', creditsPct: 1.02, leader: 2000, skipped: 4 },
  { vote: 'Vote222', node: 'Node222', commission: 0, delinquent: false, lagSlots: 2, version: '2.1.0', creditsPct: 1.00, leader: 2, skipped: 1 },
  { vote: 'Vote333', node: 'Node333', commission: 10, delinquent: true, lagSlots: 400, version: '2.0.0', creditsPct: 0.55, leader: 500, skipped: 200 },
  { vote: 'Vote444', node: 'Node444', commission: 5, delinquent: false, lagSlots: 2, version: '2.1.0', creditsPct: 0.99, leader: 800, skipped: 8 },
];
// Pad with normal validators so network averages are sane
for (let i = 5; i <= 20; i++) {
  validators.push({ vote: `Vote${i}00`, node: `Node${i}00`, commission: 8, delinquent: false, lagSlots: 2, version: '2.1.0', creditsPct: 1.0, leader: 1000, skipped: 2 });
}

let runNumber = 0; // bumped per generator run; run 2 rugs Vote444's commission

function epochCreditsFor(v) {
  // 10 completed epochs of history + current
  const base = 400000;
  const out = [];
  let cum = 0;
  for (let e = CURRENT_EPOCH - 10; e <= CURRENT_EPOCH; e++) {
    const prev = cum;
    cum += Math.round(base * v.creditsPct);
    out.push({ epoch: e, credits: cum, previousCredits: prev });
  }
  return out;
}

function voteAccountEntry(v) {
  const comm = (v.vote === 'Vote444' && runNumber >= 2) ? 40 : v.commission;
  return {
    votePubkey: v.vote,
    nodePubkey: v.node,
    commission: comm,
    activatedStake: 100000 * 1e9,
    lastVote: currentSlot - v.lagSlots,
    rootSlot: currentSlot - v.lagSlots - 32,
    delinquent: v.delinquent,
    epochCredits: epochCreditsFor(v).slice(-5).map(e => [e.epoch, e.credits, e.previousCredits])
  };
}

function handleRpc(body) {
  const { method, params, id } = body;
  const result = (() => {
    switch (method) {
      case 'getEpochInfo':
        return { epoch: CURRENT_EPOCH, slotsInEpoch: SLOTS_PER_EPOCH, absoluteSlot: currentSlot, slotIndex: currentSlot % SLOTS_PER_EPOCH };
      case 'getSlot':
        currentSlot += 3;
        return currentSlot;
      case 'getVoteAccounts': {
        const cur = [], del = [];
        for (const v of validators) (v.delinquent ? del : cur).push(voteAccountEntry(v));
        return { current: cur, delinquent: del };
      }
      case 'getClusterNodes':
        return validators.map(v => ({ pubkey: v.node, version: v.version }));
      case 'getMultipleAccounts': {
        const keys = params[0];
        return {
          value: keys.map(k => {
            const v = validators.find(x => x.vote === k);
            if (!v) return null;
            return { data: { parsed: { info: { epochCredits: epochCreditsFor(v) } } } };
          })
        };
      }
      case 'getBlockProduction': {
        // Split each validator's totals evenly over the 7 requested epochs
        const byIdentity = {};
        for (const v of validators) {
          const leader = Math.round(v.leader / 7);
          const skipped = Math.round(v.skipped / 7 * 10) / 10 >= 0.5 ? Math.ceil(v.skipped / 7) : Math.floor(v.skipped / 7);
          // Ensure Vote222's single skip appears exactly once overall
          if (v.vote === 'Vote222') {
            const range = params[0].range;
            const epochIdx = Math.floor(range.firstSlot / SLOTS_PER_EPOCH);
            if (epochIdx === CURRENT_EPOCH - 1) byIdentity[v.node] = [2, 1];
            continue;
          }
          if (leader > 0) byIdentity[v.node] = [leader, Math.max(0, leader - skipped)];
        }
        return { value: { byIdentity } };
      }
      default:
        throw new Error(`unmocked method ${method}`);
    }
  })();
  return { jsonrpc: '2.0', id, result };
}

const server = http.createServer((req, res) => {
  let buf = '';
  req.on('data', c => buf += c);
  req.on('end', () => {
    try {
      const out = handleRpc(JSON.parse(buf));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: { message: e.message } }));
    }
  });
});

server.listen(18990, async () => {
  const env = {
    ...process.env,
    X1_RPC_URL: 'http://127.0.0.1:18990',
    DATA_DIR
  };
  const script = path.join(__dirname, 'compute-scores.js');

  const fails = [];
  const check = (cond, msg) => {
    console.log(`${cond ? '✅' : '❌'} ${msg}`);
    if (!cond) fails.push(msg);
  };

  try {
    // ---- Run 1 ----
    runNumber = 1;
    await runNode([script], env);
    let doc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'scores.json'), 'utf8'));

    check(doc.formulaVersion === 2, 'formulaVersion is 2');
    check(doc.validatorCount === validators.length, `all ${validators.length} validators scored`);

    const v1 = doc.validators['Vote111'];
    const v2 = doc.validators['Vote222'];
    const v3 = doc.validators['Vote333'];
    check(v1 && v1.score > 85, `healthy validator scores high (${v1 && v1.score})`);
    check(v2 && v2.breakdown.skipRate.score >= 50,
      `1-skip-of-2-slots validator NOT nuked: skip component ${v2 && v2.breakdown.skipRate.score} (raw rate 50%, conf-adj ${v2 && v2.skipRateAdj}%)`);
    check(v2 && v2.skipRate7d === 50, `raw skip rate still reported honestly (${v2 && v2.skipRate7d}%)`);
    check(v3 && v3.score < 50, `delinquent laggard scores low (${v3 && v3.score})`);
    check(v3 && v3.breakdown.uptime.score === 10, 'delinquent validator uptime component = 10');
    check(v1.breakdown.voteLatency.score >= 92, `low-lag validator latency component high (${v1.breakdown.voteLatency.score}, avg ${v1.voteLag} slots)`);
    check(v3.breakdown.voteLatency.score <= 25, `laggard latency component low (${v3.breakdown.voteLatency.score}, avg ${v3.voteLag} slots)`);
    check(v1.breakdown.commissionInfo.weight === 0 && v1.breakdown.ageInfo.weight === 0, 'commission & age are informational (weight 0)');
    const weightSum = Object.values(v1.breakdown).filter(c => c.weight > 0).reduce((a, c) => a + c.weight, 0);
    check(Math.abs(weightSum - 1.0) < 1e-9, `scored weights sum to 100% (${(weightSum * 100).toFixed(0)}%)`);
    check((doc.validators['Vote444'].flags || []).length === 0, 'no rug flag before commission change');
    const scoreBefore = doc.validators['Vote444'].score;

    // ---- Run 2: Vote444 rugs commission 5% -> 40% ----
    runNumber = 2;
    await runNode([script], env);
    doc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'scores.json'), 'utf8'));

    const v4 = doc.validators['Vote444'];
    check(v4.flags.includes('commission_rug'), 'commission rug flagged after 5% -> 40% raise');
    check(v4.score <= scoreBefore - 10, `rug penalty applied (${scoreBefore} -> ${v4.score})`);

    const hist = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'history.json'), 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    check(hist.uptime['Vote111'][today].o === 2, 'uptime observations accumulate across runs (2 runs = 2 obs)');
    check(hist.uptime['Vote333'][today].d === 2, 'delinquency observations recorded');
    check(hist.commission['Vote444'].length === 2, 'commission change history recorded');
    check(hist.latency['Vote111'][today].c === 10, 'latency samples accumulate (5/run × 2 runs)');
    check(doc.validators['Vote111'].uptimeObs === 2, 'uptime obs surfaced in scores.json');
  } finally {
    server.close();
  }

  console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL TESTS PASSED');
  process.exit(fails.length ? 1 : 0);
});
