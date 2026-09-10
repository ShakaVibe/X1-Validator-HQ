#!/usr/bin/env node
/**
 * build-delegation-snapshot.js — X1 Foundation Delegation Program snapshot
 *
 * Source: the Foundation's own delegation API (the same feed that powers
 * https://delegation.x1.xyz):
 *   GET https://api.delegation.mainnet.x1.xyz/v1/config        criteria
 *   GET https://api.delegation.mainnet.x1.xyz/v1/validators/   per-validator
 *       status, failingCriteria, self-stake, delegated stake, 3-epoch vote +
 *       block-production metrics, cluster averages (one page, limit 2000)
 *
 * Output: data/delegation.json — one compact record per validator keyed by
 * VOTE account (the site keys everything by vote), plus the criteria and
 * cluster averages needed to show headroom ("880 XNT short", "credits at
 * 89% of network, threshold 92%"). ~200 KB raw. Consumed by the
 * DELEGATION PROGRAM module in index.html.
 *
 * Runs hourly from .github/workflows/update-terminal-snapshot.yml.
 * Node 20+, zero dependencies.
 * Env: X1_DELEGATION_API (default https://api.delegation.mainnet.x1.xyz),
 *      OUT (default data/delegation.json)
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const API     = (process.env.X1_DELEGATION_API || 'https://api.delegation.mainnet.x1.xyz').replace(/\/$/, '');
const OUT     = process.env.OUT || path.join(__dirname, '..', 'data', 'delegation.json');
const RETRIES = 4;
const TIMEOUT_MS = 60000;
const SNAPSHOT_VERSION = 1;

function log(...a) { console.log(new Date().toISOString(), ...a); }

async function apiGet(p) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(API + p, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.fatal = true; throw e; }
      const text = await r.text();
      log(`GET ${p}  ${(text.length / 1024).toFixed(0)} KB`);
      const j = JSON.parse(text);
      if (j && j.success === false) throw new Error(`API returned success=false for ${p}`);
      return j;
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      if (attempt < RETRIES) {
        const delay = 2000 * attempt;
        log(`  ${p} failed (${e.message}); retry ${attempt + 1}/${RETRIES} in ${delay}ms`);
        await new Promise(res => setTimeout(res, delay));
      }
    } finally { clearTimeout(t); }
  }
  throw new Error(`${p}: ${lastErr && lastErr.message}`);
}

async function getAllValidators() {
  // One page today (limit 2000, 703 rows). Follow pagination if it ever grows.
  const out = []; let page = 0; let meta = null; let counts = null; let cluster = null;
  for (;;) {
    const j = await apiGet(`/v1/validators/?page=${page}`);
    const d = j.data || {};
    out.push(...(d.validators || []));
    counts = counts || d.counts || null;
    cluster = cluster || d.clusterMetrics || null;
    meta = meta || j.meta || null;
    if (!j.pagination || !j.pagination.hasNext) break;
    page++;
    if (page > 20) { log('!! pagination runaway, stopping at 20 pages'); break; }
  }
  return { validators: out, counts, cluster, meta };
}

function latest(arr, key) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr.reduce((a, b) => (b.epoch > a.epoch ? b : a));
}

async function main() {
  log(`Building delegation snapshot from ${API}`);
  const [cfgRes, all] = await Promise.all([apiGet('/v1/config'), getAllValidators()]);
  const cfg = (cfgRes && cfgRes.data) || {};

  const clusterVote  = latest(all.cluster && all.cluster.voteMetrics, 'epoch');
  const clusterBlock = latest(all.cluster && all.cluster.blockProductionMetrics, 'epoch');

  const validators = {};
  let n = 0;
  for (const v of all.validators) {
    if (!v || !v.voteAccount) continue;
    const vm = latest(v.voteMetrics, 'epoch');
    const bp = latest(v.blockProductionMetrics, 'epoch');
    const deleg = v.delegation || null;
    validators[v.voteAccount] = {
      id:   v.identity,
      name: (v.metadata && v.metadata.name) || null,
      st:   v.status || null,                                  // Approved | Rejected | Pending
      fc:   Array.isArray(v.failingCriteria) ? v.failingCriteria : [],
      ss:   String(v.selfStake || '0'),                        // lamports
      ds:   String((deleg && deleg.totalStake) || v.delegatedStake || '0'), // lamports delegated by the program
      tr:   String((deleg && deleg.transientStake) || '0'),    // lamports in transit (activating/deactivating)
      cm:   v.commission == null ? null : Number(v.commission),
      ver:  v.version || null,
      dq:   !!v.isDelinquent,
      as:   String(v.activatedStake || '0'),                   // lamports
      np:   v.networkStakePercentage == null ? null : Number(v.networkStakePercentage),
      ep:   vm ? vm.epoch : null,
      vc:   vm ? Number(vm.voteCreditsPercent) : null,         // % of max credits, latest completed epoch
      sk:   bp ? Number(bp.skipRate) : null,                   // %, latest completed epoch
      ls:   bp ? Number(bp.slotsProcessed) : null,             // leader slots that epoch
      rs:   Number(v.removalScore || 0),                       // strikes
      mb:   v.stakeMultiplierBps == null ? null : Number(v.stakeMultiplierBps),
      lc:   v.lastStakeChangeEpoch == null ? null : Number(v.lastStakeChangeEpoch),
    };
    n++;
  }

  const doc = {
    version: SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    source: API,
    sourceUpdatedAt: (all.meta && all.meta.lastUpdated) || null,
    config: {
      minSelfStake:            String(cfg.minSelfStake || '0'),
      maxCommissionPercent:    cfg.maxCommissionPercent,
      maxTotalStake:           String(cfg.maxTotalStake || '0'),
      maxValidatorStakePct:    cfg.maxValidatorStakePct,
      voteCreditsThresholdPct: cfg.voteCreditsThresholdPct,
      skipRateTolerancePct:    cfg.skipRateTolerancePct,
      minValidatorVersion:     cfg.minValidatorVersion,
      reserveStakePct:         cfg.reserveStakePct,
      maxValidators:           cfg.maxValidators,
      emergencyPause:          !!cfg.emergencyPause,
      strikePenaltyBps:        cfg.strikePenaltyBps,
      strikeMinCapBps:         cfg.strikeMinCapBps,
      strikeDecayEpochs:       cfg.strikeDecayEpochs,
      configEpoch:             cfgRes && cfgRes.meta ? cfgRes.meta.lastUpdated : null,
    },
    counts: all.counts || null,
    cluster: {
      epoch:              clusterVote ? clusterVote.epoch : null,
      avgVoteCreditsPct:  clusterVote ? Number(clusterVote.avgVoteCreditsPercentage) : null,
      avgVoteCredits:     clusterVote ? Number(clusterVote.avgVoteCredits) : null,
      skipRatePct:        clusterBlock ? Number(clusterBlock.skipRate) : null,
      totalActivatedStake: all.cluster ? String(all.cluster.totalActivatedStake || '0') : null,
    },
    validatorCount: n,
    validators,
  };

  // One validator per line → small hourly diffs.
  const head = Object.assign({}, doc, { validators: undefined });
  let out = JSON.stringify(head).replace(/}$/, '');
  const keys = Object.keys(validators).sort();
  out += ',"validators":{\n' + keys.map(k => JSON.stringify(k) + ':' + JSON.stringify(validators[k])).join(',\n') + '\n}}\n';
  JSON.parse(out);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);
  log(`Wrote ${OUT}: ${n} validators, ${(out.length / 1024).toFixed(0)} KB; counts=${JSON.stringify(all.counts)}`);
}

main().catch(e => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
