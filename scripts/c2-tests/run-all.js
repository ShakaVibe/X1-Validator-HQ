// One command for every offline browser suite — what CI runs (audit 2026-11-17 #21 / #7).
//
//   node scripts/c2-tests/run-all.js /path/to/repo [--only a,b] [--jobs N] [--update] [--no-retry]
//
// Exits 1 when any suite fails. Three kinds of suite:
//
//   checks   the suite counts its own failures and exits 1 (apr, fleet, credits, …).
//   expected the older C2 suites (cards, manage, modals, batch4, batch5) only PRINT what
//            happened — every spied call with its arguments, inline-handler counts, page
//            errors — and always exit 0; until 2026-11-18 "passing" meant a person read the
//            output. Their output is deterministic, so it is now compared with a stored copy
//            in scripts/c2-tests/expected/<suite>.txt (server port and the console-noise
//            block normalised away). A difference fails the suite and prints the diff.
//            After an INTENDED change: read the diff, then re-run with --update.
//   csp      csp-walk-test prints its verdict; this runner reads the four lines that matter.
//
// Not run here: index-diff-test.js (needs the pre-conversion index.html from git history).
// A failed suite is run once more; "passed on retry" is reported so flaky suites are seen.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const only = flag('--only'), jobs = Math.max(1, parseInt(flag('--jobs') || '3', 10) || 3);
const update = has('--update'), noRetry = has('--no-retry');
const ROOT = path.resolve(args[0] || '.');
const DIR = path.join(ROOT, 'scripts', 'c2-tests'), EXPECTED = path.join(DIR, 'expected');

const SUITES = [
  ['cards-test', 'expected'], ['manage-test', 'expected'], ['modals-test', 'expected'], ['batch4-test', 'expected'], ['batch5-test', 'expected'],
  ['csp-walk-test', 'csp'],
  ['alerts-modal-test', 'checks'], ['fleet-test', 'checks'], ['apr-test', 'checks'], ['credits-test', 'checks'], ['identity-test', 'checks'],
  ['price-pill-test', 'checks'], ['stake-activation-test', 'checks'], ['slot-time-test', 'checks'], ['authority-test', 'checks'],
  ['frame-guard-test', 'checks'], ['startup-order-test', 'checks'], ['base-rate-test', 'checks'],
].filter(([name]) => !only || only.split(',').includes(name) || only.split(',').includes(name.replace(/-test$/, '')));

// Output of an "expected" suite with the parts that legitimately vary removed
function normalise(out) {
  const lines = out.replace(/\r/g, '').split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^console warn\/err:/.test(lines[i])) {                 // cards-test: browser console noise, differs run to run
      if (!/\]\s*$/.test(lines[i])) { while (i < lines.length - 1 && !/^\]\s*$/.test(lines[i])) i++; }
      continue;
    }
    kept.push(lines[i].replace(/(127\.0\.0\.1|localhost):\d+/g, '$1:PORT').replace(/\s+$/, ''));
  }
  return kept.join('\n').replace(/\n+$/, '') + '\n';
}
function shortDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n'), out = [];
  for (let i = 0; i < Math.max(x.length, y.length) && out.length < 24; i++) {
    if (x[i] !== y[i]) { if (x[i] !== undefined) out.push('    expected ' + (i + 1) + ': ' + x[i].slice(0, 160)); if (y[i] !== undefined) out.push('    got      ' + (i + 1) + ': ' + y[i].slice(0, 160)); }
  }
  return out.join('\n');
}

function runOnce(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(DIR, name + '.js'), ROOT], { cwd: ROOT, env: process.env });
    let out = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { out += '\n[run-all] timed out after 240 s\n'; child.kill('SIGKILL'); }, 240000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, ms: Date.now() - started }); });
  });
}

function judge(name, kind, r) {
  if (r.code !== 0) return { ok: false, why: 'exit code ' + r.code, detail: r.out.split('\n').filter(l => /✗|Error|FAILED|timed out/.test(l)).slice(0, 12).join('\n') };
  if (kind === 'checks') {
    const passed = (r.out.match(/✓/g) || []).length, failed = (r.out.match(/✗/g) || []).length;
    if (failed || !passed) return { ok: false, why: failed + ' failed check(s), ' + passed + ' passed', detail: r.out.split('\n').filter(l => /✗/.test(l)).slice(0, 12).join('\n') };
    return { ok: true, note: passed + ' checks' };
  }
  if (kind === 'csp') {
    const o = r.out;
    const control = /positive control[^\n]*"inlineHandlerRan":false,"inlineScriptRan":false,"violations":\["script-src-attr","script-src-elem"\]/.test(o);
    const walk = /script-src violations during the walk: 0 \[\]/.test(o), other = /other-directive violations: 0 \[\]/.test(o), errs = /^page errors: \[\]\s*$/m.test(o);
    if (control && walk && other && errs) return { ok: true, note: '0 violations, control refused' };
    return { ok: false, why: 'CSP walk: ' + [!control && 'positive control not refused', !walk && 'script-src violations', !other && 'other-directive violations', !errs && 'page errors'].filter(Boolean).join(', '),
             detail: o.split('\n').filter(l => /violations|page errors|positive control/.test(l)).join('\n') };
  }
  // expected
  const got = normalise(r.out), file = path.join(EXPECTED, name + '.txt');
  if (!/^page errors: \[\]\s*$/m.test(got)) return { ok: false, why: 'page errors', detail: got.split('\n').filter(l => /page errors/.test(l)).join('\n') };
  if (/\[Actions\] warnings:/.test(got) && !/\[Actions\] warnings: \[\]/.test(got)) return { ok: false, why: '[Actions] warnings', detail: got.split('\n').filter(l => /Actions/.test(l)).join('\n') };
  if (update) { fs.mkdirSync(EXPECTED, { recursive: true }); fs.writeFileSync(file, got); return { ok: true, note: 'expected output written (' + got.split('\n').length + ' lines)' }; }
  if (!fs.existsSync(file)) return { ok: false, why: 'no expected output stored (run with --update once, after reading the output)' };
  const want = fs.readFileSync(file, 'utf8');
  if (want === got) return { ok: true, note: 'output matches expected (' + (got.split('\n').length - 1) + ' lines)' };
  return { ok: false, why: 'output differs from scripts/c2-tests/expected/' + name + '.txt', detail: shortDiff(want, got) };
}

(async () => {
  try { require.resolve('playwright'); } catch (e) { console.error('playwright is not installed (npm i -g playwright, or NODE_PATH=$(npm root -g))'); process.exit(2); }
  console.log(`${SUITES.length} suite(s), ${jobs} at a time, repo ${ROOT}${update ? '  [--update: rewriting expected outputs]' : ''}\n`);
  const results = [], queue = SUITES.slice();
  async function worker() {
    for (;;) {
      const next = queue.shift(); if (!next) return;
      const [name, kind] = next;
      let r = await runOnce(name), v = judge(name, kind, r), retried = false;
      if (!v.ok && !noRetry && !update) { const r2 = await runOnce(name), v2 = judge(name, kind, r2); retried = true; if (v2.ok) { r = r2; v = Object.assign(v2, { firstFailure: v.why }); } }
      results.push({ name, kind, v, ms: r.ms, retried });
      console.log((v.ok ? (v.firstFailure ? '  ~ ' : '  ✓ ') : '  ✗ ') + name.padEnd(24) + (r.ms / 1000).toFixed(1).padStart(6) + ' s  ' + (v.ok ? v.note + (v.firstFailure ? '  — PASSED ON RETRY (first run: ' + v.firstFailure + ')' : '') : v.why));
      if (!v.ok && v.detail) console.log(v.detail);
    }
  }
  await Promise.all(Array.from({ length: jobs }, worker));
  const failed = results.filter(r => !r.v.ok), flaky = results.filter(r => r.v.ok && r.v.firstFailure);
  console.log(`\n${results.length - failed.length} of ${results.length} suites passed` + (flaky.length ? `, ${flaky.length} only on retry (${flaky.map(r => r.name).join(', ')})` : '') + (failed.length ? `; FAILED: ${failed.map(r => r.name).join(', ')}` : ''));
  process.exit(failed.length ? 1 : 0);
})();
