#!/usr/bin/env node
// Rebuilds the pre-split single-file index.html from index.html + css/ + js/.
//
// The 2026-09-16 split moved the site's CSS and JS out of index.html without
// changing a byte of them: css/site.css is the old <style> block, and each run
// of consecutive local <script src="js/..."> tags is one former inline <script>
// (files concatenated in order). This script inverts that, so anyone can check
// that a split-era index.html + files still equals a given monolith:
//
//   node scripts/assemble-monolith.js                 # prints the monolith
//   node scripts/assemble-monolith.js --check FILE    # exit 0 iff identical to FILE
//   git show 0101736:index.html > /tmp/orig.html && node scripts/assemble-monolith.js --check /tmp/orig.html
//
// Once the split files start diverging from the monolith on purpose (they
// will), --check against the old commit stops being meaningful; the script
// stays useful for producing a single-file build (e.g. to grep line numbers
// in old notes) and as the written record of the split rules.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const lines = read('index.html').split('\n');

const CSS_RE = /^(\s*)<link rel="stylesheet" href="css\/site\.css">$/;
const JS_RE = /^(\s*)<script src="js\/([\w.-]+\.js)"><\/script>$/;
const SPLIT_COMMENT_RE = /^\s*<!-- split:/;

const out = [];
let openRun = null; // indent of the <script> block currently being emitted
let inSplitComment = false;

function body(file) {
  const s = read(file);
  if (!s.endsWith('\n')) throw new Error(file + ' must end with a newline');
  return s.slice(0, -1).split('\n');
}

for (const line of lines) {
  if (inSplitComment) { if (line.includes('-->')) inSplitComment = false; continue; }
  if (SPLIT_COMMENT_RE.test(line)) { if (!line.includes('-->')) inSplitComment = true; continue; }
  let m;
  if ((m = line.match(JS_RE))) {
    if (openRun === null) { openRun = m[1]; out.push(m[1] + '<script>'); }
    out.push(...body('js/' + m[2]));
    continue;
  }
  if (openRun !== null) { out.push(openRun + '</script>'); openRun = null; }
  if ((m = line.match(CSS_RE))) {
    out.push(m[1] + '<style>', ...body('css/site.css'), m[1] + '</style>');
    continue;
  }
  out.push(line);
}
if (openRun !== null) out.push(openRun + '</script>');

const monolith = out.join('\n');
const ci = process.argv.indexOf('--check');
if (ci === -1) {
  process.stdout.write(monolith);
} else {
  const ref = fs.readFileSync(path.resolve(process.argv[ci + 1]), 'utf8');
  if (ref === monolith) { console.log('OK: assembled index.html is byte-identical to ' + process.argv[ci + 1]); process.exit(0); }
  const a = ref.split('\n'), b = monolith.split('\n');
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  console.error(`MISMATCH at line ${i + 1} (ref ${a.length} lines, assembled ${b.length} lines)\n  ref: ${JSON.stringify(a[i])}\n  got: ${JSON.stringify(b[i])}`);
  process.exit(1);
}
