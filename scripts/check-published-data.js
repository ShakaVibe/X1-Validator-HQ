#!/usr/bin/env node
/**
 * Data check before publishing (audit 2026-11-17 #7, part 2).
 *
 * The hourly bots build data/*.json and commit whatever came out. Nothing looked at the numbers,
 * so a broken API answer or a bug in a builder went straight to the site. This script runs in the
 * workflow between "build" and "commit":
 *
 *   node scripts/check-published-data.js terminal delegation rewards
 *   node scripts/check-published-data.js scores
 *
 * For every named file it compares the freshly built version with the one that is published
 * (git HEAD). A file that fails is put back to the published version, so the commit step publishes
 * the files that are fine and leaves the bad one as it was. The script then exits 1; the workflow
 * turns that into a failed run after the commit step, which opens the usual "[bot] … is failing"
 * issue with the reasons (GATE_REPORT) in it. The next good run publishes and closes the issue.
 *
 * Two kinds of rules:
 *   absolute  the file is wrong on its own (not JSON, half the fields missing, a score of 140,
 *             an APR of 80 %). Never accepted automatically.
 *   relative  the file differs too much from the published one (validator count −40 % in an hour,
 *             the median score down 12 points, old reward cells rewritten). The limits are 10–50 ×
 *             the largest hourly change seen in 164 consecutive publications (2026-11-12 … 11-18,
 *             see HANDOVER "Data check"). If the network really changed that much, the rule would
 *             block for ever, so relative rules are waived once the published file is older than
 *             DATA_GATE_ACCEPT_AFTER_H hours (default 6): the owner has had the issue for hours by
 *             then, and stale data is the worse problem.
 *
 * Switch rules off without a code change: repository variable DATA_GATE_OFF (Settings → Secrets
 * and variables → Actions → Variables) = "all", a file name ("rewards") or rule ids separated by
 * commas ("scores.median-change,rewards.pv-range").
 *
 * Options: --dry-run (report only, restore nothing), --repo <dir> (default: the repository root).
 * Exit codes: 0 nothing held back · 1 at least one file held back · 2 the script itself failed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── Limits ────────────────────────────────────────────────────────────────────────────────────
// "seen" = the largest value in the 164-publication back-test named above.
const LIMITS = {
  minValidators: 100,          // absolute floor for every list of validators (384–395 seen)
  freshHours: 3,               // generatedAt must be this recent …
  futureMinutes: 10,           // … and not ahead of the runner's clock
  countChange: 0.15,           // validator count vs published            (seen: 1.3 %)
  stakeChange: 0.10,           // total activated stake vs published       (seen: 0.42 %)
  stakeAccountsChange: 0.30,   // number of stake accounts vs published    (seen: 3.6 %)
  delegStatusChange: 0.25,     // approved / active delegations vs published (seen: 2.3 %)
  scoreMedianChange: 5,        // points, median score vs published        (seen: 0.1)
  scoreMoved: 20,              // a validator "moved" when its score changed by more than this …
  scoreMovedShare: 0.10,       // … and at most this share may move        (seen: 0.5 %)
  historyRewritten: 0.01,      // share of old reward cells that changed   (seen: 0)
  indexedShare: 0.5,           // share of validators with a reward in the 2nd-newest epoch (seen: ≥ 0.858)
  pvRateMin: 2, pvRateMax: 30, // % a year at full credits implied by a point value (seen: 7.4–8.3)
  pvRewrite: 1e-6,             // a published point value must not change (relative)
  aprMax: 30,                  // % a year, any validator's delegator APR
  aprSpread: 1.3,              // gross p90 ÷ median over validators        (≈ 1.01 with real data)
};
const SLOTS_PER_EPOCH = 216000, MAX_CREDITS_PER_SLOT = 16;
const MAX_CREDITS = SLOTS_PER_EPOCH * MAX_CREDITS_PER_SLOT;
// Only for the plausibility bounds above (the site measures the slot time; 366 ms on 2026-11-18)
const EPOCHS_PER_YEAR = 365.25 * 86400 / (SLOTS_PER_EPOCH * 0.366);
const APR_EPOCHS = 30;

const FILES = {
  terminal:   { path: 'data/terminal.json',   check: checkTerminal },
  delegation: { path: 'data/delegation.json', check: checkDelegation },
  rewards:    { path: 'data/rewards.json',    check: checkRewards },
  // history.json is the raw material of the scores and is written in the same run: both or neither
  scores:     { path: 'data/scores.json',     check: checkScores, with: ['data/history.json'] },
};

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────
const isNum = (x) => typeof x === 'number' && isFinite(x);
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const pct = (x) => (x * 100).toFixed(1) + ' %';
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const quantile = (xs, q) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
const relChange = (prev, next) => (isNum(prev) && prev > 0 && isNum(next)) ? (next - prev) / prev : null;

function makeReport() {
  const problems = [];
  return {
    problems,
    abs(rule, msg) { problems.push({ rule, kind: 'absolute', msg }); },
    rel(rule, msg) { problems.push({ rule, kind: 'relative', msg }); },
  };
}

// generatedAt: recent, not in the future, not older than the published file's
function checkFresh(name, next, prev, now, r) {
  const t = Date.parse(next && next.generatedAt);
  if (!t) return r.abs(name + '.fresh', 'generatedAt is missing or not a date');
  if (now - t > LIMITS.freshHours * 3600e3) r.abs(name + '.fresh', `generatedAt is ${((now - t) / 3600e3).toFixed(1)} h old (limit ${LIMITS.freshHours} h)`);
  if (t - now > LIMITS.futureMinutes * 60e3) r.abs(name + '.fresh', `generatedAt is ${((t - now) / 60e3).toFixed(0)} min in the future`);
  const p = Date.parse(prev && prev.generatedAt);
  if (p && t < p) r.abs(name + '.fresh', 'generatedAt is older than the published file\'s');
}
function checkCount(name, nNext, nPrev, r, what) {
  if (nNext < LIMITS.minValidators) r.abs(name + '.count-floor', `${nNext} ${what || 'validators'} (at least ${LIMITS.minValidators} expected)`);
  const c = relChange(nPrev, nNext);
  if (c != null && Math.abs(c) > LIMITS.countChange) r.rel(name + '.count-change', `${what || 'validators'}: ${nPrev} → ${nNext} (${c > 0 ? '+' : ''}${pct(c)}, limit ±${pct(LIMITS.countChange)})`);
}

// ── data/terminal.json ────────────────────────────────────────────────────────────────────────
const TERMINAL_FIELDS = ['votePubkey', 'nodePubkey', 'name', 'commission', 'activatedStake', 'delinquent'];
function terminalStats(d) {
  if (!isObj(d) || !Array.isArray(d.validatorFields) || !Array.isArray(d.validators)) return null;
  const ti = Object.fromEntries(d.validatorFields.map((f, i) => [f, i]));
  if (TERMINAL_FIELDS.some(f => ti[f] === undefined)) return null;
  let stake = 0, badRows = 0; const seen = new Set();
  for (const row of d.validators) {
    const vote = Array.isArray(row) ? row[ti.votePubkey] : null, st = Array.isArray(row) ? Number(row[ti.activatedStake]) : NaN, c = Array.isArray(row) ? row[ti.commission] : null;
    if (typeof vote !== 'string' || vote.length < 32 || seen.has(vote) || !isFinite(st) || st < 0 || row.length !== d.validatorFields.length || !(c === null || (isNum(c) && c >= 0 && c <= 100))) { badRows++; continue; }
    seen.add(vote); stake += st / 1e9;
  }
  const stakeAccounts = isObj(d.counts) && isNum(d.counts.stakes) ? d.counts.stakes : null;
  return { n: d.validators.length, stake, badRows, stakeAccounts };
}
function checkTerminal(next, prev, now) {
  const r = makeReport(), s = terminalStats(next), p = prev ? terminalStats(prev) : null;
  if (!s) { r.abs('terminal.shape', 'validatorFields / validators missing, or a required column is gone (' + TERMINAL_FIELDS.join(', ') + ')'); return r.problems; }
  checkFresh('terminal', next, prev, now, r);
  if (s.badRows) r.abs('terminal.rows', `${s.badRows} of ${s.n} validator rows are malformed (vote key, stake, commission or column count)`);
  if (!(s.stake > 0)) r.abs('terminal.stake', 'total activated stake is 0');
  checkCount('terminal', s.n, p && p.n, r);
  if (p) {
    const c = relChange(p.stake, s.stake);
    if (c != null && Math.abs(c) > LIMITS.stakeChange) r.rel('terminal.stake-change', `total activated stake ${Math.round(p.stake).toLocaleString('en-US')} → ${Math.round(s.stake).toLocaleString('en-US')} XNT (${c > 0 ? '+' : ''}${pct(c)}, limit ±${pct(LIMITS.stakeChange)})`);
    const a = relChange(p.stakeAccounts, s.stakeAccounts);
    if (a != null && Math.abs(a) > LIMITS.stakeAccountsChange) r.rel('terminal.stake-accounts-change', `stake accounts ${p.stakeAccounts} → ${s.stakeAccounts} (${a > 0 ? '+' : ''}${pct(a)}, limit ±${pct(LIMITS.stakeAccountsChange)})`);
  }
  return r.problems;
}

// ── data/delegation.json ──────────────────────────────────────────────────────────────────────
const DELEGATION_CONFIG = ['minSelfStake', 'maxCommissionPercent', 'voteCreditsThresholdPct', 'skipRateTolerancePct'];
function checkDelegation(next, prev, now) {
  const r = makeReport();
  if (!isObj(next) || !isObj(next.validators) || !isObj(next.config) || !isObj(next.counts)) { r.abs('delegation.shape', 'validators / config / counts missing'); return r.problems; }
  checkFresh('delegation', next, prev, now, r);
  const missing = DELEGATION_CONFIG.filter(k => next.config[k] === undefined || next.config[k] === null);
  if (missing.length) r.abs('delegation.config', 'program criteria missing: ' + missing.join(', '));
  const entries = Object.values(next.validators);
  const bad = entries.filter(e => !isObj(e) || typeof e.st !== 'string' || !e.st).length;
  if (bad) r.abs('delegation.rows', `${bad} of ${entries.length} validators have no status`);
  const pOk = isObj(prev) && isObj(prev.validators) && isObj(prev.counts);
  checkCount('delegation', entries.length, pOk ? Object.keys(prev.validators).length : null, r);
  if (pOk) for (const k of ['approved', 'activeDelegations']) {
    const c = relChange(prev.counts[k], next.counts[k]);
    if (c != null && Math.abs(c) > LIMITS.delegStatusChange) r.rel('delegation.status-change', `${k}: ${prev.counts[k]} → ${next.counts[k]} (${c > 0 ? '+' : ''}${pct(c)}, limit ±${pct(LIMITS.delegStatusChange)})`);
    else if (isNum(prev.counts[k]) && prev.counts[k] > 20 && !isNum(next.counts[k])) r.rel('delegation.status-change', `${k}: ${prev.counts[k]} → missing`);
  }
  return r.problems;
}

// ── data/scores.json ──────────────────────────────────────────────────────────────────────────
function scoreMap(d) {
  if (!isObj(d) || !isObj(d.validators)) return null;
  const m = new Map(); let bad = 0;
  for (const [k, v] of Object.entries(d.validators)) {
    if (!isObj(v) || !isNum(v.score) || v.score < 0 || v.score > 100) { bad++; continue; }
    m.set(k, v.score);
  }
  return { m, bad, n: Object.keys(d.validators).length };
}
function checkScores(next, prev, now) {
  const r = makeReport(), s = scoreMap(next);
  if (!s || !isNum(next.formulaVersion) || !isNum(next.epoch)) { r.abs('scores.shape', 'validators / formulaVersion / epoch missing'); return r.problems; }
  checkFresh('scores', next, prev, now, r);
  if (s.bad) r.abs('scores.range', `${s.bad} of ${s.n} validators have no score or one outside 0–100`);
  const p = prev ? scoreMap(prev) : null;
  checkCount('scores', s.n, p && p.n, r);
  if (p && isObj(prev)) {
    if (isNum(prev.epoch) && next.epoch < prev.epoch) r.rel('scores.epoch-back', `epoch went backwards: ${prev.epoch} → ${next.epoch}`);
    // A new formula version is a deliberate change: scores may move, the comparison would only cry wolf.
    if (prev.formulaVersion === next.formulaVersion && s.m.size && p.m.size) {
      const a = median([...p.m.values()]), b = median([...s.m.values()]);
      if (Math.abs(b - a) > LIMITS.scoreMedianChange) r.rel('scores.median-change', `median score ${a.toFixed(2)} → ${b.toFixed(2)} (limit ±${LIMITS.scoreMedianChange} points an hour)`);
      let both = 0, moved = 0;
      for (const [k, v] of s.m) { const o = p.m.get(k); if (o === undefined) continue; both++; if (Math.abs(v - o) > LIMITS.scoreMoved) moved++; }
      if (both >= 20 && moved / both > LIMITS.scoreMovedShare) r.rel('scores.mass-move', `${moved} of ${both} validators moved by more than ${LIMITS.scoreMoved} points in one run (${pct(moved / both)}, limit ${pct(LIMITS.scoreMovedShare)})`);
    }
  }
  return r.problems;
}

// ── data/rewards.json ─────────────────────────────────────────────────────────────────────────
// Delegator APR the way js/apr.js computes it (credits method): mean of pv × cr × (1 − c) over the
// newest APR_EPOCHS epochs that have both, an epoch with 0 credits counts.
function creditRates(doc, e) {
  if (!Array.isArray(doc.pv) || !Array.isArray(e.cr)) return null;
  let net = 0, gross = 0, used = 0;
  for (let i = doc.epochs.length - 1; i >= 0 && used < APR_EPOCHS; i--) {
    const pv = doc.pv[i], cr = e.cr[i], c = e.c ? e.c[i] : null;
    if (pv == null || cr == null || c == null || c >= 100) continue;
    gross += pv * cr; net += pv * cr * (1 - c / 100); used++;
  }
  return used >= 3 ? { net: net / used * EPOCHS_PER_YEAR * 100, gross: gross / used * EPOCHS_PER_YEAR * 100 } : null;
}
function checkRewards(next, prev, now) {
  const r = makeReport();
  if (!isObj(next) || next.v !== 1 || !Array.isArray(next.epochs) || !next.epochs.length || !isObj(next.validators)) { r.abs('rewards.shape', 'v / epochs / validators missing'); return r.problems; }
  checkFresh('rewards', next, prev, now, r);
  const NE = next.epochs.length, entries = Object.entries(next.validators);
  if (!next.epochs.every((e, i) => Number.isInteger(e) && (i === 0 || e === next.epochs[i - 1] + 1))) r.abs('rewards.epochs', 'the epoch list is not a run of consecutive epochs');
  // every column of every validator has one cell per epoch, and the cells are sane
  let badLen = 0, badCells = 0, badCredits = 0;
  for (const [, e] of entries) {
    if (!isObj(e) || !Array.isArray(e.v) || e.v.length !== NE) { badLen++; continue; }
    for (const col of ['s', 'st', 'c', 'cr']) if (e[col] !== undefined && (!Array.isArray(e[col]) || e[col].length !== NE)) { badLen++; break; }
    for (let i = 0; i < NE; i++) {
      const v = e.v[i], c = e.c ? e.c[i] : null, cr = e.cr ? e.cr[i] : null;
      if ((v != null && !(isNum(v) && v >= 0)) || (c != null && !(isNum(c) && c >= 0 && c <= 100))) badCells++;
      if (cr != null && !(isNum(cr) && cr >= 0 && cr <= MAX_CREDITS)) badCredits++;
    }
  }
  if (badLen) r.abs('rewards.shape', `${badLen} of ${entries.length} validators have a column that does not match the ${NE} epochs`);
  if (badCells) r.abs('rewards.cells', `${badCells} reward or commission cells are negative, not numbers, or a commission outside 0–100`);
  if (badCredits) r.abs('rewards.credits-range', `${badCredits} vote-credit cells are negative or above the possible ${MAX_CREDITS.toLocaleString('en-US')} per epoch`);
  if (badLen) return r.problems;   // the rules below index the columns

  if (NE >= 2) {
    const have = entries.filter(([, e]) => e.v[NE - 2] != null).length / Math.max(1, entries.length);
    if (have < LIMITS.indexedShare) r.abs('rewards.indexed-share', `only ${pct(have)} of the validators have a reward in epoch ${next.epochs[NE - 2]} (at least ${pct(LIMITS.indexedShare)} expected)`);
  }
  if (Array.isArray(next.pv)) {
    if (next.pv.length !== NE) r.abs('rewards.pv-range', `pv has ${next.pv.length} values for ${NE} epochs`);
    const off = next.pv.map((pv, i) => [pv, i]).filter(([pv]) => pv != null && !(isNum(pv) && pv * MAX_CREDITS * EPOCHS_PER_YEAR * 100 >= LIMITS.pvRateMin && pv * MAX_CREDITS * EPOCHS_PER_YEAR * 100 <= LIMITS.pvRateMax));
    if (off.length) r.abs('rewards.pv-range', `the network rate per credit of epoch ${next.epochs[off[0][1]]} implies ${isNum(off[0][0]) ? (off[0][0] * MAX_CREDITS * EPOCHS_PER_YEAR * 100).toFixed(1) + ' %' : 'no number'} a year at full credits (plausible: ${LIMITS.pvRateMin}–${LIMITS.pvRateMax} %)` + (off.length > 1 ? `, and ${off.length - 1} more epoch(s)` : ''));
    const rates = entries.map(([, e]) => creditRates(next, e)).filter(Boolean);
    const top = rates.reduce((m, x) => Math.max(m, x.net), 0);
    if (top > LIMITS.aprMax) r.abs('rewards.apr-max', `a validator's delegator APR comes out at ${top.toFixed(1)} % (limit ${LIMITS.aprMax} %)`);
    const gross = rates.map(x => x.gross).filter(x => x > 0);
    if (gross.length >= 20) {
      const med = median(gross), p90 = quantile(gross, 0.9);
      if (p90 / med > LIMITS.aprSpread) r.abs('rewards.apr-spread', `gross yield p90 ÷ median = ${(p90 / med).toFixed(2)} (${p90.toFixed(2)} % ÷ ${med.toFixed(2)} %, limit ${LIMITS.aprSpread})`);
    }
  }

  const pOk = isObj(prev) && Array.isArray(prev.epochs) && isObj(prev.validators);
  checkCount('rewards', entries.length, pOk ? Object.keys(prev.validators).length : null, r);
  if (pOk) {
    const pNE = prev.epochs.length;
    if (next.epochs[NE - 1] < prev.epochs[pNE - 1]) r.rel('rewards.epoch-back', `newest epoch went backwards: ${prev.epochs[pNE - 1]} → ${next.epochs[NE - 1]}`);
    const pi = new Map(prev.epochs.map((e, i) => [e, i]));
    // Reward cells older than the two newest epochs are final: the builder never rewrites them
    let cells = 0, changed = 0;
    for (const [vote, e] of entries) {
      const o = prev.validators[vote];
      if (!o || !Array.isArray(o.v)) continue;
      for (let j = 0; j < NE - 2; j++) {
        const i = pi.get(next.epochs[j]);
        if (i === undefined || i >= pNE - 2 || o.v[i] == null) continue;
        cells++; if (e.v[j] !== o.v[i]) changed++;
      }
    }
    if (cells >= 100 && changed / cells > LIMITS.historyRewritten) r.rel('rewards.history-rewritten', `${changed} of ${cells} already published reward cells changed (${pct(changed / cells)}, limit ${pct(LIMITS.historyRewritten)})`);
    if (Array.isArray(next.pv) && Array.isArray(prev.pv)) {
      const moved = [];
      for (let j = 0; j < NE; j++) { const i = pi.get(next.epochs[j]); if (i === undefined || prev.pv[i] == null) continue; if (next.pv[j] == null || Math.abs(next.pv[j] / prev.pv[i] - 1) > LIMITS.pvRewrite) moved.push(next.epochs[j]); }
      if (moved.length) r.rel('rewards.pv-rewritten', `the published network rate per credit changed for epoch(s) ${moved.slice(0, 5).join(', ')}${moved.length > 5 ? ', …' : ''}`);
    }
  }
  return r.problems;
}

// ── Decide what to do with the problems of one file ───────────────────────────────────────────
// → { held: [...], waived: [...], off: [...] }
function decide(name, problems, prev, now, env) {
  const offList = String((env && env.DATA_GATE_OFF) || '').split(',').map(s => s.trim()).filter(Boolean);
  const acceptAfterH = Number((env && env.DATA_GATE_ACCEPT_AFTER_H) || 6);
  const prevAt = Date.parse(prev && prev.generatedAt);
  const prevAgeH = prevAt ? (now - prevAt) / 3600e3 : null;
  const out = { held: [], waived: [], off: [], prevAgeH };
  for (const p of problems) {
    if (offList.includes('all') || offList.includes(name) || offList.includes(p.rule)) out.off.push(p);
    else if (p.kind === 'relative' && prevAgeH != null && prevAgeH > acceptAfterH) out.waived.push(p);
    else out.held.push(p);
  }
  return out;
}

// ── Command line ──────────────────────────────────────────────────────────────────────────────
function main(argv, env) {
  const args = argv.slice(2);
  const dry = args.includes('--dry-run');
  const ri = args.indexOf('--repo');
  const repo = path.resolve(ri >= 0 ? args[ri + 1] : path.join(__dirname, '..'));
  const names = args.filter((a, i) => !a.startsWith('--') && !(ri >= 0 && i === ri + 1));
  if (!names.length || names.some(n => !FILES[n])) { console.error('usage: check-published-data.js [--dry-run] [--repo <dir>] ' + Object.keys(FILES).join('|') + ' …'); return 2; }
  const now = Date.now(), git = (a) => execFileSync('git', a, { cwd: repo, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = []; let heldFiles = 0;
  for (const name of names) {
    const f = FILES[name], abs = path.join(repo, f.path);
    let prevText = null, prev = null;
    try { prevText = git(['show', 'HEAD:' + f.path]).toString('utf8'); prev = JSON.parse(prevText); } catch (e) { /* not published yet, or the published file is unreadable */ }
    if (!fs.existsSync(abs)) { lines.push(`- \`${f.path}\`: not built in this run, the published file stays.`); continue; }
    const nextText = fs.readFileSync(abs, 'utf8');
    if (prevText !== null && nextText === prevText) { lines.push(`- \`${f.path}\`: unchanged in this run.`); continue; }
    let problems;
    try { problems = f.check(JSON.parse(nextText), prev, now); }
    catch (e) { problems = [{ rule: name + '.shape', kind: 'absolute', msg: 'not readable: ' + String(e && e.message || e).slice(0, 120) }]; }
    const d = decide(name, problems, prev, now, env);
    for (const p of d.off) lines.push(`- \`${f.path}\`: rule \`${p.rule}\` is switched off (DATA_GATE_OFF) — ${p.msg}`);
    for (const p of d.waived) lines.push(`- \`${f.path}\`: rule \`${p.rule}\` waived, the published file is ${d.prevAgeH.toFixed(1)} h old — ${p.msg}`);
    if (!d.held.length) { lines.push(`- \`${f.path}\`: ok.`); continue; }
    heldFiles++;
    const all = [f.path].concat(f.with || []);
    lines.push(`- **\`${f.path}\` was NOT published**${f.with ? ' (nor ' + f.with.map(x => '`' + x + '`').join(', ') + ')' : ''}; the site keeps the version of ${prev && prev.generatedAt ? prev.generatedAt : 'the last good run'}.`);
    for (const p of d.held) lines.push(`  - \`${p.rule}\` (${p.kind}): ${p.msg}`);
    if (!dry) for (const p of all) {
      // back to the published version; a file that was never published is removed (fail closed:
      // the commit step then stops on the missing path and nothing is pushed)
      try { git(['checkout', 'HEAD', '--', p]); } catch (e) { try { fs.unlinkSync(path.join(repo, p)); } catch (e2) { /* already gone */ } }
    }
  }
  const head = heldFiles
    ? `Data check: ${heldFiles} file(s) held back at ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC. Relative rules are waived once the published file is older than ${Number((env && env.DATA_GATE_ACCEPT_AFTER_H) || 6)} h; rules can be switched off with the repository variable DATA_GATE_OFF (see scripts/check-published-data.js).`
    : 'Data check: nothing held back.';
  const text = head + '\n\n' + lines.join('\n') + '\n';
  console.log(text);
  for (const k of ['GITHUB_STEP_SUMMARY', 'GATE_REPORT']) if (env && env[k]) { try { fs.appendFileSync(env[k], text + '\n'); } catch (e) { /* the report is a courtesy */ } }
  return heldFiles ? 1 : 0;
}

if (require.main === module) {
  let code = 2;
  try { code = main(process.argv, process.env); } catch (e) { console.error('check-published-data failed:', e && e.stack || e); }
  process.exit(code);
}
module.exports = { LIMITS, FILES, checkTerminal, checkDelegation, checkScores, checkRewards, decide, main, MAX_CREDITS, EPOCHS_PER_YEAR };
