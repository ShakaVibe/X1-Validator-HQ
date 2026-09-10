#!/usr/bin/env node
/**
 * build-terminal-snapshot.js — pre-digest api.x1.xyz for the Validator Terminal
 *
 * WHY: the Validator Terminal tab needs every stake account on the network.
 * api.x1.xyz serves that list UNCOMPRESSED (~11 MB for ~7.4k rows, each row
 * embedding its full validator + stake-pool objects) plus ~2 MB of validators.
 * Downloading 13 MB in the browser is slow on desktop and fails outright on
 * many phone / VPN / hotel-wifi connections ("Failed to fetch").
 *
 * This script runs in a GitHub Action every hour, fetches the same three
 * endpoints once, keeps only the fields the terminal actually renders, and
 * writes data/terminal.json (~0.6 MB raw, gzipped by GitHub Pages on the way
 * out). The site loads that first and only falls back to the live API if the
 * snapshot is missing or stale. See HANDOVER.md §4 and the VALIDATOR TERMINAL
 * module in index.html (fetchSnapshot / inflateSnapshot).
 *
 * Node 20+, zero dependencies.   Usage: node scripts/build-terminal-snapshot.js
 * Env: X1_API_URL (default https://api.x1.xyz), OUT (default data/terminal.json)
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const API        = (process.env.X1_API_URL || 'https://api.x1.xyz').replace(/\/$/, '');
const OUT        = process.env.OUT || path.join(__dirname, '..', 'data', 'terminal.json');
const PAGE       = 10000;   // API max page size
const MAX_OFFSET = 5000;    // API rejects offset > 5000
const RETRIES    = 4;
const TIMEOUT_MS = 120000;

// Fields the terminal reads from a validator (compute() + render() + tooltip).
// Keep in sync with VALIDATOR_FIELDS / inflateSnapshot() in index.html.
const VALIDATOR_FIELDS = [
  'votePubkey', 'nodePubkey', 'name', 'version', 'commission',
  'activatedStake', 'delinquent', 'active', 'country', 'x1Labs',
];
// Per stake account: [stakePubkey, amount, delegatedStake, status, isPool]
const STAKE_FIELDS = ['stakePubkey', 'amount', 'delegatedStake', 'status', 'stakePool'];

const SNAPSHOT_VERSION = 1;

function log(...a) { console.log(new Date().toISOString(), ...a); }

async function apiGet(p, q = {}) {
  const u = new URL(API + p);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v));
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(u, { signal: ctrl.signal, headers: { 'accept': 'application/json' } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.fatal = true; throw e; }
      const text = await r.text();
      log(`GET ${u.pathname}${u.search}  ${(text.length / 1048576).toFixed(2)} MB`);
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      if (attempt < RETRIES) {
        const delay = 2000 * attempt;
        log(`  ${u.pathname} failed (${e.message}); retry ${attempt + 1}/${RETRIES} in ${delay}ms`);
        await new Promise(res => setTimeout(res, delay));
      }
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error(`${p}: ${lastErr && lastErr.message}`);
}

async function getAll(p, q = {}) {
  const first = await apiGet(p, { ...q, limit: PAGE, offset: 0 });
  if (!Array.isArray(first)) throw new Error(`${p} did not return an array`);
  if (first.length < PAGE) return { rows: first, truncated: false };
  const second = await apiGet(p, { ...q, limit: PAGE, offset: MAX_OFFSET });
  const keyOf = x => x.stakePubkey || x.votePubkey || JSON.stringify(x);
  const seen = new Set(first.map(keyOf));
  const rows = first.slice();
  for (const x of second) if (!seen.has(keyOf(x))) { seen.add(keyOf(x)); rows.push(x); }
  return { rows, truncated: second.length >= PAGE };
}

function pick(obj, fields) {
  return fields.map(f => {
    const v = obj[f];
    if (f === 'stakePool') return v ? 1 : 0;
    return v === undefined ? null : v;
  });
}

async function main() {
  log(`Building terminal snapshot from ${API}`);
  const [cluster, vRes, sRes] = await Promise.all([
    apiGet('/v1/cluster'),
    getAll('/v1/validators'),
    getAll('/v1/stakes', { includeInactive: true }),
  ]);

  const validators = vRes.rows
    .filter(v => v && v.votePubkey)
    .map(v => pick(v, VALIDATOR_FIELDS));

  // Group stake accounts by vote pubkey so the (incompressible) 44-char vote
  // key is written once per validator instead of once per stake account.
  // Stake accounts that are not delegated to any validator go under the ""
  // key: the terminal ignores them for the table but counts them in the
  // "N stake accounts" header, so the snapshot and live figures match.
  const stakes = {};
  let stakeCount = 0;
  for (const s of sRes.rows) {
    if (!s || !s.stakePubkey) continue;
    (stakes[s.votePubkey || ''] ||= []).push(pick(s, STAKE_FIELDS));
    stakeCount++;
  }

  const doc = {
    version: SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    source: API,
    counts: { validators: validators.length, stakes: stakeCount },
    truncated: !!(vRes.truncated || sRes.truncated),
    cluster,
    validatorFields: VALIDATOR_FIELDS,
    stakeFields: STAKE_FIELDS,
    validators,
    stakes,
  };

  // Serialize with one validator / one vote-key group per line so hourly git
  // diffs stay small and reviewable, while the file itself stays compact.
  const head = Object.assign({}, doc, { validators: undefined, stakes: undefined });
  let out = JSON.stringify(head).replace(/}$/, '');
  out += ',"validators":[\n' + validators.map(v => JSON.stringify(v)).join(',\n') + '\n]';
  const keys = Object.keys(stakes).sort();
  out += ',"stakes":{\n' + keys.map(k => JSON.stringify(k) + ':' + JSON.stringify(stakes[k])).join(',\n') + '\n}}\n';

  JSON.parse(out); // sanity: must round-trip
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);
  log(`Wrote ${OUT}: ${validators.length} validators, ${stakeCount} stake accounts, ` +
      `${(out.length / 1048576).toFixed(2)} MB` + (doc.truncated ? '  (TRUNCATED — API offset cap)' : ''));
  if (doc.truncated) process.exitCode = 0; // still publish; the site shows a warning
}

main().catch(e => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
