# Canonical Scoring System (Formula v2) — Deployment Guide

## What changed and why

Operators were DMing you because **the score they saw didn't match the score you
saw**. Root cause: scores were computed live in each visitor's browser, and 10%
of the score (Reliability) read uptime history from *that browser's*
localStorage. Session caches and load timing added more drift on top.

Now a GitHub Action computes one canonical score per validator every hour and
publishes it to `data/scores.json`. Every visitor reads the same file →
**everyone sees the same number**, stamped with when it was generated. The old
in-browser scoring survives only as an automatic fallback if the published file
is missing or more than 3 hours stale.

## New formula (v2)

| Component        | Weight | Source |
|------------------|-------:|--------|
| Vote Efficiency  | 30%    | Credits vs network avg, last 7 completed epochs |
| Skip Rate        | 20%    | 7-epoch aggregate, **confidence-weighted** (small samples blend toward the network rate — 1 skip in 2 slots no longer nukes anyone) |
| Vote Latency     | 15%    | **NEW** — avg slots behind tip when votes land, sampled 24/7, 7-day rolling |
| Uptime           | 15%    | **NEW** — % of hourly delinquency checks passed, 7-day rolling, tracked server-side |
| Consistency      | 10%    | CV of per-epoch credits |
| Root Distance    | 5%     | **NEW** — avg slots the finalized root trails the tip (replay health) |
| Software Version | 5%     | vs latest version in real network use |

**Penalty:** raising commission ≥10 points within 7 days → −15 and a visible
"commission rug" flag.

**No longer scored** (shown as info only): commission level, validator age.

## Files in this delivery

- `index.html` — updated site (canonical-first scoring, generic breakdown
  renderers, published-score stamps, plus a fix for the Lowest Commission
  stake filter which compared lamports against a bare `10000`)
- `scripts/compute-scores.js` — the score generator (Node 20+, zero deps)
- `scripts/test-compute-scores.js` — mock-RPC end-to-end tests
  (`LATENCY_SAMPLE_GAP_MS=50 node scripts/test-compute-scores.js`)
- `.github/workflows/update-scores.yml` — hourly runner

## Deploy steps

1. Copy all four files into the repo (keep the paths: `scripts/`,
   `.github/workflows/`, root `index.html`).
2. Commit and push. In the repo settings, make sure
   **Settings → Actions → General → Workflow permissions** is set to
   **Read and write permissions** (the workflow commits `data/*.json`).
3. Trigger the first run manually: **Actions → Update canonical validator
   scores → Run workflow**. It takes ~1–2 minutes and creates
   `data/scores.json` + `data/history.json`.
4. If GitHub Pages deploys from a branch, each hourly commit republishes the
   site automatically (that's how the JSON reaches visitors). If Pages deploys
   from a custom workflow, make sure it triggers on pushes to `data/**`.

## What to expect in the first week

- **Hour 1:** scores go live. Vote Latency, Uptime, and Root Distance show
  "Building history..." / "Active now (building 7d history)" with neutral
  default sub-scores (78 / 88 / 82) until enough samples accumulate.
- **Hours 12+:** Uptime switches from current-status fallback to real observed
  percentages (needs 12 observations).
- **Day 7:** all rolling windows are fully populated; scores are at
  steady-state. Expect most healthy validators to land in the high 80s–90s.
- Commission-rug detection starts working from the second run onward (it needs
  a baseline to compare against).

## Operational notes

- `data/scores.json` is ~1.7 MB raw (~250 KB gzipped — GitHub Pages serves
  gzip). Fetched once per page session with a 5-minute cache-bust key.
- `data/history.json` stays around ~1 MB (7-day rolling windows, auto-pruned).
- The repo gains ~24 small commits/day from the bot. If that bothers you,
  squash periodically or move the data files to a dedicated branch later.
- To change the formula, edit the weights/thresholds in
  `scripts/compute-scores.js` and bump `FORMULA_VERSION`. The site renders
  whatever components the JSON contains — **no client changes needed** for
  future formula tweaks.
- If the Action breaks, the site shows "⚠ Published scores unavailable —
  showing locally computed estimates" and falls back to browser scoring
  (which is now deterministic — the localStorage dependency was removed).

## Answering operator DMs now

When someone disputes their score, the tooltip and score modal both show
"📡 Official published score · updated hourly · identical for all viewers"
plus the exact per-component numbers and the data behind them (raw vs
confidence-adjusted skip rate, sample counts, observation counts). You and the
operator are guaranteed to be looking at the same number — and the breakdown
tells them exactly which component to fix.
