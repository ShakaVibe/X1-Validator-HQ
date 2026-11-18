'use strict';
// Tests for scripts/check-published-data.js (audit 2026-11-17 #7 part 2).
//   node scripts/test-check-published-data.js
// Part 1: every rule on synthetic files — the good file passes, each fault trips exactly the rule
//         meant for it. Part 2: the command itself in a throw-away git repository — a bad file is
//         put back to the published version, good files stay, exit codes, report, the switches.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const G = require('./check-published-data.js');

const NOW = Date.parse('2026-11-18T20:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const clone = (x) => JSON.parse(JSON.stringify(x));
const key = (i) => 'Vote' + String(i).padStart(40, '0');
const rules = (problems) => [...new Set(problems.map(p => p.rule))].sort();
let n = 0;
const ok = (cond, label, extra) => { n++; if (!cond) { console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); process.exitCode = 1; } else console.log('  ✓ ' + label); };
const only = (problems, rule, kind, label) => ok(rules(problems).length === 1 && rules(problems)[0] === rule && problems.every(p => p.kind === kind), label + ' → ' + rule + ' (' + kind + ')', problems);

// ── Synthetic files: 200 validators, shaped like the real ones ──
const N = 200, NE = 36, LAST = 446;
const PV = 5.4e-11;                                    // ≈ 7.4 % a year at full credits
function terminal(at) {
  return { version: 1, generatedAt: iso(at), counts: { validators: N, stakes: 4000 }, truncated: false,
    validatorFields: ['votePubkey', 'nodePubkey', 'name', 'version', 'commission', 'activatedStake', 'delinquent', 'active', 'country', 'x1Labs'],
    validators: Array.from({ length: N }, (_, i) => [key(i), 'Node' + i, 'v' + i, '4.0.4', 10, String(2500000e9 + i * 1e9), false, true, 'DE', false]) };
}
function delegation(at) {
  return { version: 1, generatedAt: iso(at), config: { minSelfStake: 1, maxCommissionPercent: 10, voteCreditsThresholdPct: 97, skipRateTolerancePct: 5 },
    counts: { approved: 180, activeDelegations: 150, total: N },
    validators: Object.fromEntries(Array.from({ length: N }, (_, i) => [key(i), { name: 'v' + i, st: i < 180 ? 'Approved' : 'Rejected' }])) };
}
function scores(at) {
  return { formulaVersion: 2.1, generatedAt: iso(at), epoch: LAST + 1, validatorCount: N,
    validators: Object.fromEntries(Array.from({ length: N }, (_, i) => [key(i), { score: i < 20 ? 30 + i : 90 + (i % 9) }])) };
}
function rewards(at) {
  const full = Math.round(G.MAX_CREDITS * 0.99);
  return { v: 1, generatedAt: iso(at), currentEpoch: LAST + 1, epochs: Array.from({ length: NE }, (_, i) => LAST - NE + 1 + i), pv: new Array(NE).fill(PV),
    validators: Object.fromEntries(Array.from({ length: N }, (_, i) => [key(i), { w: null, self: [],
      v: new Array(NE).fill(i < 180 ? 4e9 + i : null), s: new Array(NE).fill(1e9), st: new Array(NE).fill(500000), c: new Array(NE).fill(i % 10 === 0 ? 0 : 10),
      cr: new Array(NE).fill(i % 25 === 0 ? Math.round(full * 0.9) : full) }])) };
}
const H = 3600e3;
const prevAt = NOW - H, nextAt = NOW - 60e3;

console.log('Part 1 — rules');
// good files pass, with and without a published version
for (const [name, mk] of [['terminal', terminal], ['delegation', delegation], ['scores', scores], ['rewards', rewards]]) {
  const f = G.FILES[name];
  ok(f.check(mk(nextAt), mk(prevAt), NOW).length === 0 && f.check(mk(nextAt), null, NOW).length === 0, name + ': a good file passes (with and without a published one)', f.check(mk(nextAt), mk(prevAt), NOW));
}
const T = (mut, prevMut) => { const a = terminal(nextAt), p = terminal(prevAt); mut(a); if (prevMut) prevMut(p); return G.checkTerminal(a, p, NOW); };
only(T(d => { delete d.validators; }), 'terminal.shape', 'absolute', 'terminal without the validator list');
only(T(d => { d.validatorFields = d.validatorFields.filter(f => f !== 'activatedStake'); d.validators.forEach(r => r.splice(5, 1)); }), 'terminal.shape', 'absolute', 'terminal without the stake column');
only(T(d => { d.validators = d.validators.slice(0, 60); }, p => { p.validators = p.validators.slice(0, 60); }), 'terminal.count-floor', 'absolute', 'terminal with 60 validators (published one had 60 too)');
{ const pr = T(d => { d.validators = d.validators.slice(0, 150); }); ok(rules(pr).join() === 'terminal.count-change,terminal.stake-change' && pr.every(p => p.kind === 'relative'), 'terminal lost 25 % of its validators → count-change and stake-change (relative)', pr); }
only(T(d => { d.validators.forEach(r => { r[5] = String(Number(r[5]) / 2); }); }), 'terminal.stake-change', 'relative', 'total stake halved');
only(T(d => { d.validators[3][5] = 'abc'; d.validators[4][0] = d.validators[5][0]; }), 'terminal.rows', 'absolute', 'a non-numeric stake and a duplicate vote key');
only(T(d => { d.counts.stakes = 1000; }), 'terminal.stake-accounts-change', 'relative', 'stake accounts −75 %');
only(T(d => { d.generatedAt = iso(NOW - 5 * H); }, p => { p.generatedAt = iso(NOW - 6 * H); }), 'terminal.fresh', 'absolute', 'generatedAt 5 h old');
only(T(d => { d.generatedAt = iso(NOW - 2 * H); }), 'terminal.fresh', 'absolute', 'generatedAt older than the published file');
ok(T(d => { d.validators = d.validators.slice(0, 190); }).length === 0, 'terminal −5 % validators is normal movement');

const D = (mut) => { const a = delegation(nextAt); mut(a); return G.checkDelegation(a, delegation(prevAt), NOW); };
only(D(d => { delete d.config; }), 'delegation.shape', 'absolute', 'delegation without the criteria block');
only(D(d => { delete d.config.minSelfStake; }), 'delegation.config', 'absolute', 'a criterion missing');
only(D(d => { Object.values(d.validators).slice(0, 5).forEach(e => { delete e.st; }); }), 'delegation.rows', 'absolute', 'validators without a status');
only(D(d => { d.counts.approved = 90; }), 'delegation.status-change', 'relative', 'approved count halved');
only(D(d => { d.validators = Object.fromEntries(Object.entries(d.validators).slice(0, 120)); }), 'delegation.count-change', 'relative', 'delegation lost 40 % of its validators');

const S = (mut, prevMut) => { const a = scores(nextAt), p = scores(prevAt); mut(a); if (prevMut) prevMut(p); return G.checkScores(a, p, NOW); };
only(S(d => { delete d.formulaVersion; }), 'scores.shape', 'absolute', 'scores without a formula version');
only(S(d => { d.validators[key(50)].score = 140; d.validators[key(51)].score = null; }), 'scores.range', 'absolute', 'a score of 140 and a missing score');
only(S(d => { Object.values(d.validators).forEach(v => { v.score = Math.max(0, v.score - 8); }); }), 'scores.median-change', 'relative', 'every score down 8 points');
only(S(d => { Object.values(d.validators).slice(100, 140).forEach(v => { v.score -= 30; }); }), 'scores.mass-move', 'relative', '20 % of the validators down 30 points');
only(S(d => { d.epoch = LAST - 3; }), 'scores.epoch-back', 'relative', 'epoch went backwards');
ok(S(d => { d.formulaVersion = 2.2; Object.values(d.validators).forEach(v => { v.score = Math.max(0, v.score - 8); }); }).length === 0, 'a new formula version may move the scores');
ok(S(d => { Object.values(d.validators).slice(0, 4).forEach(v => { v.score = 5; }); }).length === 0, 'four validators collapsing is normal movement');

const R = (mut, prevMut) => { const a = rewards(nextAt), p = rewards(prevAt); mut(a); if (prevMut) prevMut(p); return G.checkRewards(a, p, NOW); };
only(R(d => { d.v = 2; }), 'rewards.shape', 'absolute', 'ledger with an unknown version');
only(R(d => { d.validators[key(7)].cr = d.validators[key(7)].cr.slice(1); }), 'rewards.shape', 'absolute', 'a column shorter than the epoch list');
only(R(d => { d.epochs[10] += 1; }), 'rewards.epochs', 'absolute', 'epoch list with a gap');
only(R(d => { d.validators[key(7)].v[5] = -1; d.validators[key(8)].c[5] = 250; }), 'rewards.cells', 'absolute', 'a negative reward and a commission of 250');
only(R(d => { d.validators[key(7)].cr[30] = G.MAX_CREDITS * 2; }), 'rewards.credits-range', 'absolute', 'more credits than an epoch has');
only(R(d => { d.pv[NE - 1] = PV * 20; }, p => { p.pv[NE - 1] = PV * 20; }), 'rewards.pv-range', 'absolute', 'one network rate 20 × too high');
ok(rules(R(d => { d.pv.fill(PV * 3.9); }, p => { p.pv.fill(PV * 3.9); })).includes('rewards.apr-max') === false, 'a rate of 29 % at full credits is inside the bounds');
ok(rules(R(d => { d.pv.fill(PV * 4.5); }, p => { p.pv.fill(PV * 4.5); })).join() === 'rewards.apr-max,rewards.pv-range', 'every rate 4.5 × too high → pv-range and apr-max');
only(R(d => { Object.values(d.validators).slice(0, 110).forEach(e => { e.cr = e.cr.map(x => Math.round(x * 0.6)); }); }), 'rewards.apr-spread', 'absolute', 'credits of 55 % of the validators recorded 40 % low');
only(R(d => { Object.values(d.validators).slice(0, 120).forEach(e => { e.v[NE - 2] = null; }); }), 'rewards.indexed-share', 'absolute', 'second-newest epoch has rewards for 30 % of the validators');
only(R(d => { Object.values(d.validators).slice(0, 180).forEach(e => { e.v[10] += 5; }); }), 'rewards.history-rewritten', 'relative', 'one old epoch rewritten for every validator');
ok(R(d => { d.validators[key(3)].v[10] += 5; }).length === 0, 'one corrected cell is not a rewrite of history');
only(R(d => { d.pv[10] = PV * 1.01; }), 'rewards.pv-rewritten', 'relative', 'a published network rate changed');
only(R(d => { d.epochs = d.epochs.map(e => e - 2); }), 'rewards.epoch-back', 'relative', 'newest epoch went backwards');
only(R(d => { d.validators = Object.fromEntries(Object.entries(d.validators).slice(0, 150)); }), 'rewards.count-change', 'relative', 'ledger lost 25 % of its validators');
ok(R(d => { d.epochs = d.epochs.map(e => e + 1); for (const e of Object.values(d.validators)) for (const c of ['v', 's', 'st', 'c', 'cr']) { e[c].shift(); e[c].push(c === 'v' ? null : e[c][NE - 2]); } d.pv.shift(); d.pv.push(null); }).length === 0, 'an epoch rollover (new column, not indexed yet, no rate yet) passes');
ok(R(d => { delete d.pv; Object.values(d.validators).forEach(e => { delete e.cr; }); }, p => { delete p.pv; }).length === 0, 'a ledger without the credits columns passes (older builder)');
ok(R(d => { Object.values(d.validators).slice(0, 12).forEach(e => { e.cr = e.cr.map(() => 0); }); }).length === 0, '6 % of the validators offline for the whole window is normal');

// decide(): waiving and switching off
const rel = [{ rule: 'scores.median-change', kind: 'relative', msg: 'x' }], abs = [{ rule: 'scores.range', kind: 'absolute', msg: 'y' }];
const both = rel.concat(abs);
ok(G.decide('scores', both, { generatedAt: iso(NOW - H) }, NOW, {}).held.length === 2, 'published file 1 h old: relative and absolute problems hold the file back');
{ const d = G.decide('scores', both, { generatedAt: iso(NOW - 7 * H) }, NOW, {}); ok(d.held.length === 1 && d.held[0].rule === 'scores.range' && d.waived.length === 1, 'published file 7 h old: the relative rule is waived, the absolute one never'); }
ok(G.decide('scores', both, { generatedAt: iso(NOW - 7 * H) }, NOW, { DATA_GATE_ACCEPT_AFTER_H: '12' }).held.length === 2, 'DATA_GATE_ACCEPT_AFTER_H moves the waiver');
ok(G.decide('scores', both, null, NOW, {}).held.length === 2, 'no published file: nothing is waived');
ok(G.decide('scores', both, { generatedAt: iso(NOW - H) }, NOW, { DATA_GATE_OFF: 'scores.range' }).held.length === 1, 'DATA_GATE_OFF with a rule id switches off that rule only');
ok(G.decide('scores', both, { generatedAt: iso(NOW - H) }, NOW, { DATA_GATE_OFF: 'terminal, scores' }).held.length === 0 && G.decide('scores', both, null, NOW, { DATA_GATE_OFF: 'all' }).held.length === 0, 'DATA_GATE_OFF with a file name or "all"');

// ── Part 2: the command in a throw-away repository ──
console.log('Part 2 — the command');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-'));
const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const write = (f, d) => fs.writeFileSync(path.join(dir, 'data', f), typeof d === 'string' ? d : JSON.stringify(d));
const read = (f) => fs.readFileSync(path.join(dir, 'data', f), 'utf8');
const run = (args, env) => { const out = []; const log = console.log, err = console.error; console.log = (s) => out.push(String(s)); console.error = (s) => out.push(String(s)); let code; try { code = G.main(['node', 'x', '--repo', dir].concat(args), env || {}); } finally { console.log = log; console.error = err; } return { code, out: out.join('\n') }; };
try {
  fs.mkdirSync(path.join(dir, 'data'));
  git('init', '-q'); git('config', 'user.name', 't'); git('config', 'user.email', 't@example.invalid'); git('config', 'commit.gpgsign', 'false');
  const now = Date.now();
  const pub = { 'terminal.json': terminal(now - H), 'delegation.json': delegation(now - H), 'scores.json': scores(now - H), 'rewards.json': rewards(now - H), 'history.json': { uptime: { a: 1 } } };
  for (const [f, d] of Object.entries(pub)) write(f, d);
  git('add', '-A'); git('commit', '-qm', 'published');
  const published = Object.fromEntries(Object.keys(pub).map(f => [f, read(f)]));

  // 1. a normal run: everything new and fine
  write('terminal.json', terminal(now)); write('delegation.json', delegation(now)); write('rewards.json', rewards(now));
  let r = run(['terminal', 'delegation', 'rewards']);
  ok(r.code === 0 && /nothing held back/.test(r.out) && read('terminal.json') !== published['terminal.json'], 'good files: exit 0, files stay as built', r);

  // 2. bad ledger next to a good terminal; delegation not rebuilt
  const badLedger = rewards(now); badLedger.pv[NE - 1] = PV * 100;
  write('rewards.json', badLedger); fs.copyFileSync(path.join(dir, 'data', 'delegation.json'), path.join(dir, 'data', 'delegation.keep')); write('delegation.json', published['delegation.json']);
  const report = path.join(dir, 'report.md');
  r = run(['terminal', 'delegation', 'rewards'], { GATE_REPORT: report });
  ok(r.code === 1, 'bad ledger: exit 1', r.code);
  ok(read('rewards.json') === published['rewards.json'], 'the ledger is back to the published version');
  ok(read('terminal.json') !== published['terminal.json'] && JSON.parse(read('terminal.json')).generatedAt === iso(now), 'the good terminal file stays as built');
  ok(/delegation\.json`: unchanged in this run/.test(r.out), 'an unchanged file is reported as unchanged, not checked');
  ok(/rewards\.json` was NOT published/.test(r.out) && /`rewards\.pv-range` \(absolute\)/.test(r.out) && fs.readFileSync(report, 'utf8').includes('rewards.pv-range'), 'the report names the file and the rule, on stdout and in GATE_REPORT');
  ok(git('status', '--porcelain', 'data/rewards.json').trim() === '', 'git sees no change in the ledger: the commit step will not publish it');

  // 3. bad scores: scores.json AND history.json go back together
  const badScores = scores(now); Object.values(badScores.validators).forEach(v => { v.score = Math.max(0, v.score - 8); });
  write('scores.json', badScores); write('history.json', { uptime: { a: 2 } });
  r = run(['scores']);
  ok(r.code === 1 && read('scores.json') === published['scores.json'] && read('history.json') === published['history.json'], 'bad scores: scores.json and history.json are both put back', r.code);

  // 4. --dry-run restores nothing
  write('scores.json', badScores);
  r = run(['--dry-run', 'scores']);
  ok(r.code === 1 && JSON.parse(read('scores.json')).generatedAt === iso(now), '--dry-run reports and exits 1 but leaves the file');

  // 5. DATA_GATE_OFF lets it through and says so
  r = run(['scores'], { DATA_GATE_OFF: 'scores.median-change' });
  ok(r.code === 0 && /switched off \(DATA_GATE_OFF\)/.test(r.out) && JSON.parse(read('scores.json')).generatedAt === iso(now), 'DATA_GATE_OFF: published, with a line in the report');

  // 6. the published file is old: a relative problem is waived, an absolute one is not
  git('checkout', 'HEAD', '--', 'data');
  const old = scores(now - 8 * H); write('scores.json', old); git('add', '-A'); git('commit', '-qm', 'old scores');
  write('scores.json', badScores);
  r = run(['scores']);
  ok(r.code === 0 && /waived, the published file is 8\.0 h old/.test(r.out), 'published scores 8 h old: the median rule is waived, exit 0', r);
  const worse = clone(badScores); worse.validators[key(1)].score = 500; write('scores.json', worse);
  r = run(['scores']);
  ok(r.code === 1 && /scores\.range/.test(r.out) && JSON.parse(read('scores.json')).generatedAt === old.generatedAt, '… but a score of 500 is still held back');

  // 7. not JSON at all; a file that was never published; bad arguments
  write('terminal.json', '{"version":1,"validators":[');
  r = run(['terminal']);
  ok(r.code === 1 && /terminal\.shape/.test(r.out) && read('terminal.json') === published['terminal.json'], 'a truncated file is held back and replaced by the published one');
  git('rm', '-q', '--cached', 'data/delegation.json'); git('commit', '-qm', 'forget delegation');
  const badDeleg = delegation(now); delete badDeleg.config; write('delegation.json', badDeleg);
  r = run(['delegation']);
  ok(r.code === 1 && !fs.existsSync(path.join(dir, 'data', 'delegation.json')), 'a bad file that was never published is removed (nothing to fall back to)');
  write('delegation.json', delegation(now));
  r = run(['delegation']);
  ok(r.code === 0, 'a good file that was never published passes on the absolute rules alone', r);
  ok(run([]).code === 2 && run(['nonsense']).code === 2, 'no file name / an unknown one → exit 2 (usage)');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

console.log(process.exitCode ? '\nFAILED' : `\n${n} passed`);
