# X1 Validator HQ — Session Handover

> **How to use this file:** at the start of a new chat, attach this file and say
> "here's the handover, let's continue." Claude reads it, asks you to link the `X1VHQ`
> folder (Add folder → `Desktop/X1VHQ`), runs `git pull`, and picks up from §5.
> At the **end of every session** Claude updates the Session Log, the To-Do list and any
> notes below, so this file is always the single source of truth.

> **Start here next session (as of 2026-09-23):**
> 1. `cd ~/Desktop/X1VHQ && git pull` — bots commit hourly (via the heartbeat; verified 2026-09-16:
>    scores at :04, snapshots at :43, geo every 2 h at :03 — 79 bot commits in 24 h, no gaps).
>    If Shaka's `git add` complains about `index.lock`, `rm -f .git/index.lock .git/objects/maintenance.lock`.
>    Better: grant Claude delete permission on the X1VHQ folder at session start (it asks) — then
>    Claude's own `git pull --rebase` works and leaves no locks (verified 2026-09-17). Claude still
>    can't commit (no git identity in the VM): a local unpushed commit gets replayed as *staged
>    changes* on top of origin/main, so Shaka's normal `git add -A && git commit` picks it up.
> 2. **③ (C2) is IN PROGRESS — 85 of 322 inline handlers converted.** Dispatcher = `Actions` in
>    `js/core.js`; done: cards, delegation tile, manage, modals, card-details, leaderboards (+ the 7
>    category buttons in index.html), skip-monitor, shared copy button — batches 1–4 all live-verified
>    (batch 4 on 2026-09-23). Nothing pending live-verification. Next: continue file by file:
>    compare.js (4) · terminal.js (4) · forensics.js (5) · calculators.js (5) · wallet-tx.js (3) ·
>    network-live.js (3) · app.js (2) · core.js (1) → `index.html` (210, incl. the `[onclick="…"]`
>    selectors still in app.js (calc-nav, tab) and calculators.js) → frame-buster `<script>` → drop
>    `'unsafe-inline'` from `script-src`. Tests: `scripts/c2-tests/` (README there); run them in
>    the cloud clone after every file. Rules and design in the 2026-09-17 session log.
>    Wallet-connected flows are untested by Claude (no wallet) — ask Shaka to try one Manage action,
>    a stake-row click and a Merge checkbox with his wallet connected.
>    Everything from 2026-09-16 (card redesign, split, Router, F15, P2, P9) and the 2026-09-17 card
>    header squeeze fix are live-verified. Other backlog (not taken yet): visual pass (Compare
>    cards, Delegation tab, modals, Data Center summary tiles still old look), F8b rewards CSV
>    export, F11 APR per validator, F4 fleet board.
> 3. Under-the-hood queue: ② **split `index.html` — DONE 2026-09-16** (see §3 for the file map;
>    `node scripts/assemble-monolith.js --check <file>` proves the split is a pure move). Next:
>    ③ replace the 322 inline `on*` handlers with the `data-action` dispatcher (IN PROGRESS, see
>    item 2), then drop `unsafe-inline` from the CSP; ④ single RPC transport. Rule for the split files: load-time
>    code in one file must not call into a later file (they are plain classic scripts run in
>    order; function hoisting no longer crosses file boundaries). Known leftover: the dead
>    `const originalSelectValidatorForSearch` in `js/compare.js` is now always `null` (it was
>    never read) — delete it during ③.
> 4. Useful console diagnostics on the live site: `rpcStats.byMethod` (RPC calls by method since
>    load / `rpcStats.reset()`), `RewardsLedger.doc`, `PowerSaver.forceIdle(true/false)`.
> 5. Shelved — don't re-propose: earnings chart/sparkline on the card ("takes up too much real
>    estate"). Rule: per-validator data goes in the stat grid with a Details link. (The card
>    redesign itself is DONE — see 2026-09-15.)
> 6. Housekeeping: `_to_delete/` (patch scripts) and `Claude outputs/` are gitignored — safe to
>    delete any time.
> 7. **RULE — never write to the site's localStorage in Shaka's real Chrome** (`x1Portfolio`,
>    `x1SelfStakeSelections`, …). Live checks in Chrome are read-only; anything that needs a
>    test portfolio runs in the built-in Claude browser pane or a Playwright/staged copy. See the
>    2026-09-14 session log for why.
> 8. Tooling: Shaka's app could not open hosted artifacts this session ("Open" did nothing) — deliver
>    mockups as files (PNG + standalone HTML via SendUserFile) instead. Playwright smoke of the card
>    works offline: serve the repo on localhost, block external requests, hide `#disclaimerModal`,
>    show `#resultsSection`, call `renderValidatorCard(fakeValidator)` into `#validatorResults`.
> 9. Live-checking right after a push: Pages caches every file for 10 min, so the pane may still run
>    the old `js/*.js`. Do `await fetch('/js/<file>.js', {cache:'reload'})` for each changed file
>    (and `/index.html`), then `location.reload()` — NOT `location.href = …#/route` (a hash-only
>    change never reloads). Pane clicks by ref sometimes miss; `el.click()` via JS works. Console
>    entries accumulate per tab — open a fresh tab for a clean error check.
> 10. Verification workflow that worked all day: edit in the linked folder → `node --check` →
>    offline Playwright in the cloud (stage the changed files, `split/` copy served on localhost,
>    external requests aborted, RPC-dependent globals mocked in `page.evaluate`) → Shaka pushes →
>    live check in a fresh pane tab with the cache trick above → HANDOVER entry.

---

## 1. Project at a glance

| | |
|---|---|
| **Site** | https://x1valhq.xyz (GitHub Pages, custom domain via `CNAME`) |
| **Repo** | https://github.com/ShakaVibe/X1-Validator-HQ (branch `main`) |
| **Local copy** | `~/Desktop/X1VHQ` on Shaka's Mac |
| **What it is** | Single-page dashboard + validator management tool for the X1 blockchain: Network, Validator Terminal, Validator Lookup, My Data Center (portfolio), Leaderboards, Compare, Calculators |
| **Stack** | Static: `index.html` (3.3k lines of HTML) + `css/site.css` + 18 plain `js/*.js` files loaded with `<script src>` in a fixed order (split from one 39k-line file on 2026-09-16, no build step), vendored `@solana/web3.js`, GitHub Actions that commit data files hourly |
| **Owner** | Shaka (ShakaVibe) — (private) |

## 2. Daily workflow

```bash
# Start of session — pull the bot commits first (they land ~every hour)
cd ~/Desktop/X1VHQ && git pull

# End of session — push what we changed
cd ~/Desktop/X1VHQ
git add -A
git commit -m "describe the change"
git pull --rebase      # in case a bot commit landed while we worked
git push
```

GitHub Pages redeploys automatically on every push to `main` (takes ~1–2 min).
Claude edits files directly in the linked `X1VHQ` folder; Shaka runs the git commands in Terminal.
Claude's shell can *read* git state (`git status/log/diff/fetch`) but its git leaves stale
`.git/index.lock` / `.git/objects/maintenance.lock` files behind (it can't unlink). If Shaka's
`git add` fails with "index.lock exists", `rm .git/index.lock` — Claude should check and remove
them before handing over the push commands.

## 3. Repo map

```
index.html                    the page: head (CSP, meta), all tab markup + modals, script tags
css/site.css                  all CSS (the old <style> block; "VALIDATOR CARD v2" rules at the end)
js/core.js                    logging gate, XSS helpers (escHtml/escAttrJs/safeUrl), pubkey + u64
                              helpers, canonical scores loader, delegator identities, RPC throttle +
                              circuit breaker + rpcStats, state vars, self-stake selections,
                              RewardsLedger, fetchTotalValidatorRewards(+Live), format helpers,
                              version tracker, rpcCall, network stats, getValidatorInfo, skip rates
js/scoring.js                 performance/uptime tracking (localStorage), scoring v2 + legacy,
                              network averages, bulk fetches, score tooltip + colour helpers
js/cards.js                   CARD_ICONS, tier badge, renderValidatorCard (Lookup + Data Center),
                              search, portfolio add/remove/load, last-epoch fill
js/globe.js                   validator globe (globe.gl), geo data + cache
js/leaderboards.js            leaderboards incl. delegations leaderboard
js/compare.js                 compare tool
js/app.js                     PowerSaver, Router, shareValidator, switchTab
js/calculators.js             staking / compound / unstaking / breakeven calculators
js/manage.js                  goToHome, browse-validators modal, Manage Validator modal, perf
                              explainer, stake breakdown + selection modals, toast, stake accounts
                              list + cooldown popover, merge/split/undelegate/redelegate/withdraw/
                              close/send/create-stake modals
js/wallet-tx.js               priority fee, signSendTx + rebroadcast + confirm, create stake,
                              stake/withdraw authority, wallet connect, withdraw XNT, commission,
                              identity (+ icon preview), vote authority
js/card-details.js            chartInstances, inline Stake details + Earnings trend per card,
                              combined Data Center chart/stake details, Chart.js init
js/network-live.js            TPS, leader schedule, LeaderCountdown, epoch timeline, TPS strip,
                              current leader, disclaimer modal, network toggle, epoch bar, init()
js/skip-monitor.js            SkipMonitor IIFE + its inline-onclick bridges
js/modals.js                  reward breakdown modal, TPS modal, skipmon scorecard, slot explorer,
                              Escape handler, and the final `init();` call
js/terminal.js                Validator Terminal module (IIFE: vtOpen/vtClose/vtRetry/vtRefreshLive)
js/delegation.js              Delegation Program module (IIFE: delegOpen/delegRefresh/delegEvaluate)
js/price-pill.js              XNT price pill (XDEX)
js/forensics.js               Validator Forensics (hidden tool)
scripts/assemble-monolith.js  rebuilds the single-file index.html from the pieces; `--check FILE`
                              exits 0 iff byte-identical (proved against 0101736 on 2026-09-16)
data/scores.json              canonical validator scores — written hourly by Action
data/history.json             7-day rolling history behind the scores
validator-locations.json      geo data — written every 2h by Action
data/terminal.json            Validator Terminal snapshot — written hourly by Action (added 2026-09-10)
data/delegation.json          Delegation Program snapshot — same Action, same commit (added 2026-09-10)
data/rewards.json             per-validator reward ledger, last 36 epochs — same Action (added 2026-09-13)
scripts/build-rewards-ledger.js  builds data/rewards.json from the RPC, incrementally
scripts/test-rewards-ledger.js   mock-RPC tests for the above (`node scripts/test-rewards-ledger.js`)
scripts/build-delegation-snapshot.js  builds data/delegation.json from api.delegation.mainnet.x1.xyz
scripts/build-terminal-snapshot.js  builds data/terminal.json from api.x1.xyz
scripts/compute-scores.js     score generator (Node 20, zero deps)
scripts/test-compute-scores.js  mock-RPC tests for the above
generate-geo.js               geo updater run by the Action
.github/workflows/update-scores.yml     hourly, minute :07  (commits data/*.json)
.github/workflows/update-geo-data.yml   every 2h, minute :21 (commits validator-locations.json)
.github/workflows/update-terminal-snapshot.yml  hourly, minute :37 (commits data/terminal.json, delegation.json, rewards.json)
.github/workflows/heartbeat.yml         self-rescheduling chain that dispatches the three bots hourly (GitHub cron is unreliable)
vendor/solana-web3.js-1.98.4.iife.min.js
SCORING-DEPLOYMENT.md         design doc for the canonical scoring system (formula v2)
CNAME / .nojekyll / _headers  Pages config
```

## 4. Architecture notes worth remembering

- **Data sources:** `https://rpc.mainnet.x1.xyz` (JSON-RPC, most tabs), `https://api.x1.xyz`
  (REST, Validator Terminal) and **`https://api.delegation.mainnet.x1.xyz`** (the X1 Foundation's
  delegation API behind delegation.x1.xyz — `/v1/config`, `/v1/validators/` (one page, limit 2000,
  fields: status, failingCriteria, selfStake, delegation.totalStake, voteMetrics[3 epochs],
  blockProductionMetrics, removalScore, stakeMultiplierBps, metadata.name), `/v1/stake_pool`).
  Read server-side only (Action) — CORS from the browser is unverified. Also `api.xdex.xyz` (XNT price), `ipwho.is`,
  `api.github.com`. CSP `connect-src` in `index.html` (~line 83) must list any new host.
- **RPC throttle + circuit breaker** (`installRpcThrottle` in `js/core.js`): wraps `window.fetch`
  for the RPC URL only — max 3 in flight, retry on 429, breaker trips after 6 network failures
  for 30s. The public RPC returns 429 *without CORS headers*, which the browser reports as a
  bare "Failed to fetch".
- **api.x1.xyz payloads are uncompressed and large** (measured 2026-09-10):
  `/v1/stakes?includeInactive=true` ≈ 11 MB (7,406 rows), `/v1/validators` ≈ 2 MB (724 rows).
  No `Content-Encoding`, no `Cache-Control`. `offset` is capped at 5000 (400 above that).
  The API allowed 8 parallel `/v1/cluster` calls with no 429.
- **Validator Terminal module** starts at the `// VALIDATOR TERMINAL — client-side module`
  banner (`js/terminal.js`). It is an IIFE exposing `window.vtOpen / vtClose / vtRetry / vtRefreshLive`.
  Data source order: `data/terminal.json` snapshot (hourly, same origin) → live api.x1.xyz.
- **Scores** are canonical (computed server-side by the Action) with an in-browser fallback if
  `data/scores.json` is missing or >3h stale — see `SCORING-DEPLOYMENT.md`.
- **Rewards ledger** (`data/rewards.json`, `RewardsLedger` module just above
  `fetchTotalValidatorRewards`, `js/core.js`): every per-validator reward lookup on the site goes
  through `fetchTotalValidatorRewards(vote, commission, n)`. It now takes rows from the ledger
  (vote reward + self-stake reward per completed epoch, lamports, `v`/`s` arrays aligned to
  `doc.epochs`) and only calls the RPC (`fetchTotalValidatorRewardsLive`) for epochs the ledger
  lacks — normally none; the newest epoch for up to an hour after a boundary (2 calls, using the
  ledger's self-stake list so no discovery calls); everything if the file is missing/stale >48 h.
  Visitors who hand-classified a validator's self-stake (localStorage) bypass the ledger.
  RPC facts measured 2026-09-13: `getInflationReward` takes ≤ ~300 addresses per call (413 above
  that), ~250 ms per call, history available back to genesis; `getProgramAccounts` on the Stake
  program with `dataSlice {44,120}` + `dataSize 200` returns all 7.8k stake accounts in ~450 ms /
  3 MB; vote-account withdrawer is at byte offset 36 in every VoteState version. Self-stake =
  stake account withdrawer == vote account withdrawer (1,546 accounts across 578 validators).
  The builder is incremental (loads the previous file, re-fetches only missing cells + null cells
  in the 3 newest epochs) so a routine run is ~15 RPC calls; a full backfill of 36 epochs is ~400
  calls / ~1 min. An epoch whose vote rewards are all null (RPC hasn't computed it yet) is left
  out of the file rather than published as zeros.

## 5. To-do list

The full prioritized backlog (97 items with IDs) lives on the **"X1 Validator HQ Roadmap"** Claude
artifact (claude.ai → artifacts gallery) and in `docs/audit-2026-09-10/`. IDs below match it.

### Phase 0 — this week (safety + quick wins)
- [x] **S1–S6** done 2026-09-10 (session 1, batch 2) — see Session Log
- [x] **B1, R1, R2** done 2026-09-10
- [x] **A1, A2** done 2026-09-10 — failure alerts open/comment a GitHub issue titled
      "[bot] <workflow> is failing"; optional Telegram if repo secrets `TELEGRAM_BOT_TOKEN` +
      `TELEGRAM_CHAT_ID` are set
- [x] **D1** done 2026-09-10 — description/OG/Twitter/canonical/theme-color meta, `og.png`
      (1200×630, generated with PIL — regenerate if branding changes), `apple-touch-icon.png`,
      `icon-512.png`, `manifest.webmanifest`
- [x] **P1** done 2026-09-10 — `defer` on Chart.js and web3.js
- [x] **X1** done 2026-09-10 (session 2) — global `:focus-visible` ring (2 px cyan, offset 2 px),
      `:focus:not(:focus-visible) { outline: none }` so mouse clicks don't ring; inputs keep their
      own :focus styles. **U2** closed: deep links already highlight their tab; home (globe) shows
      no active tab by design.
- [x] **M1/M2/M3/M4** done 2026-09-10 — terminal table scrolls in its own container under
      1500 px with two sticky columns; nav is a 4-col grid on phones; stats bar 4×2 grid; compact
      header; 16 px inputs + 44 px targets under `(pointer: coarse)`; terminal no longer
      auto-focuses search on touch. **U3** closed 2026-09-10 (session 2): Shaka chose no Globe tab,
      "Network" label stays.
- [x] **B10/F7** done 2026-09-10 — `computeLatestVersion()` (highest semver on ≥3 gossip nodes,
      or scores.json's `latestVersion` if newer), `buildVersionStats()` → `window.versionStats`,
      version adoption strip on the Network tab (`#verStrip`, stake-weighted bar + legend, shows
      validators behind and the delegation minimum). GitHub releases call + `MINIMUM_KNOWN_VERSION`
      floor removed; `api.github.com` dropped from CSP. Card badge now says "Update to v3.1.14".

### Phase 1 — weeks 2–4 (addressable + observable) — NEXT: F4, then F2, then F3 design
- [x] **U1** done 2026-09-10 — `Router` (defined just above `switchTab`): `#/lookup/<vote>`
      (alias `#/v/`), `#/leaderboard/<cat>`, `#/compare/a,b,c,d`, `#/calculators/<calc>`,
      `#/live`, `#/terminal`, `#/datacenter`, `#/delegation`, `#/globe`; back/forward work;
      🔗 Share button on every validator card (native share sheet on phones, clipboard on desktop).
      Follow-up: static per-validator pages with OG cards (F5) so shared links unfurl with the
      validator's name/score.
- [ ] **F10** `data/status.json` + `data/events.json`; stable `scores.json` schema; /status page
- [ ] **F4** fleet health board in My Data Center (issues first)
- [x] **F7** version tracker — done (see Phase 0). v4.0 feature-gate feed still open.
- [x] **F1** Delegation Program eligibility checker — done 2026-09-10 (see Session Log). Follow-ups:
      - [ ] Bootstrap Bonus checker (docs.x1.xyz/validating/validator-rewards/bootstrap-bonus)
      - [ ] Data Center summary line ("3 approved · 1 failing") + fleet board column (F4)
      - [ ] Alert on eligibility loss once F3 exists
- [x] **P2** done — 2026-09-10: leader schedule lazy (R6), TPS light poll (P8), fonts non-blocking (P4);
      2026-09-16: sessionStorage cache for identities (1 h) + supply (1 h), stats-bar fast path from
      scores.json + last live stake/supply (`SessionCache`, `paintStatsBarFastPath` in `js/core.js`).

### Phase 2 — weeks 5–8 (memory + push)
- [ ] **F2** per-validator history charts (`history.json` + api.x1.xyz `*Last10Epochs`)
- [ ] **F3** Telegram alerts (5-min heartbeat workflow + `/watch <vote>` bot), then Discord webhook
- [ ] **F6** score coach ("+3.0 if you upgrade"); publish `interp()` anchors in scores.json
- [ ] **F5** public profile pages + OG share cards generated by the Action
- [ ] **F8b** rewards CSV export from the ledger; **F9** change feeds; **F11** APR per validator
      (F8 ledger itself is DONE 2026-09-13 — `data/rewards.json`; F2 history charts can read it)

- [x] **P9** done 2026-09-16 — scores.json now carries `credits` (last 8 epochs), `creditsFirstEpoch`,
      `creditsEpochs` per validator; Leaderboards read them (`publishedCreditsMap`) and only fall back
      to the 724 batched `getAccountInfo` when the file predates this or covers < 90 %.

### Phase 3 — ongoing (platform)
- [x] **C1** split `index.html` — done 2026-09-16 (css + 18 js files, plain `<script src>`)
- [ ] **C2** replace 322 inline `on*` handlers with delegated `data-action` listeners → drop
      `'unsafe-inline'` from `script-src`. Started 2026-09-17: `Actions` dispatcher in `js/core.js`;
      done `js/cards.js` (17), `js/delegation.js` (2), `js/manage.js` (21), `js/modals.js` (15),
      `getCopyButtonHtml` in core.js; 2026-09-23: `js/card-details.js` (6), `js/leaderboards.js` (7)
      + index.html leaderboard buttons (7), `js/skip-monitor.js` (8). Remaining (237): index.html 210 ·
      forensics.js 5 · calculators.js 5 · terminal.js 4 · compare.js 4 · wallet-tx.js 3 ·
      network-live.js 3 · app.js 2 · core.js 1; then the inline frame-buster `<script>` in the head (→ `js/frame-guard.js`
      or a CSP `sha256-` hash), then edit the CSP. The `[onclick="switchTab('…')"]`-style selectors
      in app.js / leaderboards.js / calculators.js must change when index.html is converted.
- [ ] **C3/C4** single RPC transport; normalise records at ingestion
- [ ] **P6/D5** PWA shell, light theme; **C8** public changelog

### Open small items
- [ ] `_to_delete/` in the repo folder holds the Python patch scripts from session 1 (gitignored);
      Shaka can delete the folder any time.
- [ ] Ask people who reported the terminal error which device/network they were on.

### Done
- [x] 2026-09-16 — **F15 "Where am I"** pinned rows on every leaderboard; **P2** session cache +
      stats-bar fast path. See Session Log.
- [x] 2026-09-16 — **C1 split `index.html`** into `css/site.css` + `js/*.js` (pure move, byte-identical
      reassembly proven). See Session Log.
- [x] 2026-09-16 — Card redesign live-verified; duplicate-card id collision fixed (Lookup + Data
      Center holding the same validator); `hideIconPreview` load error fixed. See Session Log.
- [x] 2026-09-15 — **Validator card redesign** (Lookup + My Data Center): see Session Log.
- [x] 2026-09-13 — **F8 rewards ledger**: `scripts/build-rewards-ledger.js` → `data/rewards.json`
      hourly; site reads it first (`RewardsLedger`), RPC only for uncovered epochs.
- [x] 2026-09-10 — Local clone set up at `~/Desktop/X1VHQ`, folder linked to Claude.
- [x] 2026-09-10 — Diagnosed + hardened Validator Terminal loading (see Session Log).
- [x] 2026-09-10 — Hourly terminal snapshot Action + snapshot-first loader (see Session Log).
- [x] 2026-09-10 — Verified on live site: snapshot 911 KB raw / 515 KB gzipped, loads in ~0.25s;
      Live button pulls 13 MB and works; no console errors.
- [x] 2026-09-10 — Deep audit (4 reviews) → Roadmap artifact + `docs/audit-2026-09-10/`.
- [x] 2026-09-10 (session 2) — Live-verified session 1's final push: one Details link on the
      Delegation tile; terminal header shows 7,434 stake accounts on both snapshot and Live.

## 6. Session log

### 2026-09-10 — Session 1
- Cloned `ShakaVibe/X1-Validator-HQ` to `~/Desktop/X1VHQ`; linked the folder; `git pull` clean.
- Created this `HANDOVER.md`.
- **Validator Terminal "Failed to load terminal data / Failed to fetch"** — diagnosed:
  1. The tab downloads ~13 MB uncompressed from api.x1.xyz (stakes 11 MB + validators 2 MB) with
     *no timeout, no retry, no fallback*; one dropped request of the three killed the whole load.
  2. The hourly auto-refresh called the same loader and on any failure **wiped the working table**
     and showed the error screen — so anyone leaving the tab open eventually saw the error.
  3. Latent bug: pagination used `offset += 10000`, but the API rejects offset > 5000, so the
     terminal would have broken outright once stakes passed 10,000 rows (7,406 today).
- Fixed in `index.html` (Validator Terminal module):
  - New `apiGet()` streams each response, shows real download progress ("6.2 MB of ~13 MB"),
    aborts only on a 30s *stall* (slow-but-steady connections are fine), retries 3× with
    backoff on network errors / 429 / 5xx, and produces human-readable error messages.
  - `getAll()` pages as offset 0 + offset 5000 (deduped) — max 15k rows, warns if truncated.
  - A failed **refresh** now keeps the table and shows an amber "Refresh failed — showing data
    from <time>" banner with a Retry button instead of destroying the view.
  - Error screen explains the likely cause (large download / slow connection).
  - Timestamps ("Updated…", "Generated…") now reflect fetch time, not render time.
- Verified: all inline scripts pass `node --check`; mock-fetch test of the new loader confirmed
  retries, dedup pagination (12k rows → 12k unique), progress bytes and error text.
- **Terminal snapshot (root-cause fix), same session:**
  - New `scripts/build-terminal-snapshot.js` (Node 20, zero deps): fetches cluster + validators +
    stakes from api.x1.xyz with retries, keeps only the 10 validator fields and 5 stake fields the
    terminal uses, groups stakes by vote key, writes `data/terminal.json` one record per line
    (small git diffs). Tested against a mock API incl. 503 retry and the 2-page (>10k) path.
  - New `.github/workflows/update-terminal-snapshot.yml`: hourly at :37, commits with
    `[skip ci]`, rebase-and-retry push loop (three bots now push to `main`: :07 scores,
    :21 geo, :37 terminal).
  - `index.html` terminal module: `fetchSnapshot()` / `inflateSnapshot()` / `loadData(preferLive)`.
    Opening the tab and the hourly auto-refresh load the snapshot (same-origin, ~0.7 MB raw,
    gzipped by Pages); snapshot missing or >3h old → live API. New **Live** button in the header
    corner (`vtRefreshLive`) forces a live fetch, falling back to the snapshot if that fails.
    Header + footer now say which source is on screen and when it was generated.
  - Mock-tested all branches: snapshot ok / stale / 404 / live-preferred with API down / up.
- Snapshot format v1 (keep `VALIDATOR_FIELDS` in the script and `inflateSnapshot` in sync):
  `{version, generatedAt, source, counts, truncated, cluster, validatorFields, stakeFields,
  validators: [[...fields]], stakes: {votePubkey: [[stakePubkey, amount, delegatedStake, status, isPool]]}}`
- Pushed; snapshot workflow triggered by hand and committed `data/terminal.json`
  (724 validators, 7,275 delegated stake accounts). Verified live in the browser (see Done).
- Follow-up fix, same session: snapshot now also carries undelegated stake accounts under the
  `""` key so the "N stake accounts" header matches Live (7,406 vs 7,275 before). Pushed at end
  of session; takes effect on the next hourly run.
- Shaka's Chrome lost WebGL (GPU process crash count 5 → globe fallback message). Site was fine;
  `chrome://restart` fixes it. Not a site bug.
- **Deep audit.** Four parallel reviews (code, UX/mobile/perf/a11y, feature inventory + gaps,
  ecosystem research) + live measurements in the desktop-app browser + a direct look at
  x1watch.xyz's data feeds. Output: the **"X1 Validator HQ Roadmap"** artifact (97 findings,
  do-first list, phases, competitor table, official delegation criteria) and the raw reports in
  `docs/audit-2026-09-10/`. §5 above is the prioritized list.
- **Batch 2 — security + reliability (pushed same day):**
  - S1 `safeUrl()` now returns `escHtml(v)`; S2 `escAttrJs()` escapes `&` first; S3/S4 Manage
    Validator + staking-calc `onclick` args escaped and numbers coerced; S5 all raw name/iconUrl
    sinks escaped incl. the 2-second next-leaders strip and every first-letter placeholder;
    S6 Chart.js `<script>` has SRI (`sha512-CQBW…`, verified by hashing the CDN file).
    Helper unit tests pass (breakout, entity bypass, js: scheme).
  - B1 portfolio load/save guarded; R1 20 s per-attempt timeout inside `throttledFetch`
    (combined with caller signals); R2 aborts no longer count toward the circuit breaker —
    timeouts retry once, caller aborts pass straight through. Mock-tested: hang frees its slot,
    429 retry still works, breaker stays closed.
  - A1 geo workflow: `concurrency` group + rebase-and-retry push loop + `[skip ci]`; scores
    workflow gets the same retry loop; A2 all three workflows post to a GitHub issue on failure
    (needs `issues: write`, granted in each workflow) and optionally Telegram.
- **Batch 3 — Delegation Program eligibility checker (F1):**
  - Found the Foundation's real API by reading delegation.x1.xyz's JS bundle:
    `api.delegation.mainnet.x1.xyz`. Config today: minSelfStake 5,000 XNT, maxCommission 10%,
    maxTotalStake 3,000,000 XNT, maxValidatorStakePct 1, voteCreditsThresholdPct 92,
    skipRateTolerancePct 10 (additive pts over network avg), minValidatorVersion 3.1.14,
    strikePenaltyBps 2000, strikeDecayEpochs 4. failingCriteria values seen: minSelfStake (312),
    delinquent (38), maxSkipRate (35), minVoteCredits (25), minValidatorVersion (22),
    noVersionInfo (7). 703 enrolled, 21 not enrolled, 332 receiving stake. Shaka_Vibes_1..5 are
    the top 4 delegations (~980–990k XNT each).
  - `scripts/build-delegation-snapshot.js` → `data/delegation.json` (keyed by vote account, one
    record per line, ~200 KB); added as a `continue-on-error` step to the terminal snapshot
    workflow (same commit). Mock-tested incl. 503 retry.
  - `index.html`: new **DELEGATION PROGRAM** IIFE module after the Terminal module — evaluates
    each validator against the criteria with headroom text ("Short by 880 XNT", "Upgrade to
    3.1.14"), authoritative ✓/✗ from the Foundation's failingCriteria; renders a "Delegation
    Program" box in every validator card (`.deleg-section` placeholder + MutationObserver so
    Lookup / Data Center / Compare cards all get it) and a new **Delegation** nav tab
    (criteria tiles, counts, searchable/sortable/filterable table, "My Data Center" filter,
    click name → Lookup). Globals: `delegOpen`, `delegRefresh`, `delegEvaluate(vote)`.
  - Needs one manual Action run after push to create `data/delegation.json` (Actions → "Update
    Validator Terminal snapshot" → Run workflow); until then cards show nothing and the tab says
    "not available".
- **Batch 4 — mobile + link previews:** see D1 and M1–M4 in §5.
- **Batch 5 — shareable URLs (U1):** hash router + Share button (see §5). Router ignores
  `set()` until `start()` has applied the initial deep link (called from `init()` right after
  `loadNetworkStats()`), so renders during page load can't clobber it. Unit-tested in node.
  Also escaped the card's first-letter placeholder and version badge (leftovers from batch 2).
- **Batch 6 — delegation tile + version tracker + startup diet:** Shaka rejected the first
  delegation card section (4-column text grid, ~180 px) and then the one-line bar; what he
  wanted was **a stat tile like the others** ("Delegation" · value = delegated XNT / Failing /
  Rejected / — · sub "XNT · Approved" or "N unmet" · **Details** link) opening a modal
  (`#delegationModal`, `openDelegationModal(vote)`) with the ✓/✗ criteria list, headroom
  hints, strikes and the Foundation note. Previewed with Playwright before pushing. **Lesson:
  new per-validator data goes in the stat grid with a Details link, like Breakdown/Classify —
  never a new section on the card.**
  Version tracker: see B10/F7 in §5. Startup diet (P1/P4/R6/P8): `defer` on Chart.js + web3.js
  (`isValidPubkey` falls back to a base58 regex until web3 loads), Google Fonts non-blocking,
  leader schedule no longer loaded at page load (on demand by Network tab / chips / Slot
  Explorer), TPS polls 1 sample instead of 720 when the Network tab is not active.
- **Batch 7 — end of day:** live-verified the tile/modal/version-strip push; found and fixed a
  double "Details" link (renderCard ran twice: MutationObserver + post-load hydrate — now
  idempotent). Roadmap artifact updated with done marks. Telegram announcement drafted for the
  Delegation feature (in chat, not saved).
- **Session 1 totals:** 8 pushes. Shipped: Terminal hardening + snapshot; security S1–S6;
  B1/R1/R2; workflow rebase/retry + failure alerts (A1/A2); OG/meta/icons/manifest (D1);
  mobile pass (M1–M4); hash router + Share (U1); Delegation Program checker — tile, modal, tab,
  hourly snapshot (F1); version tracker + adoption strip (F7/B10); startup diet
  (P1/P4/R6/P8); HANDOVER + docs/audit + roadmap artifact.
- Key facts learned: (1) validator names/iconUrls reach the DOM unescaped in ~10 places and
  `safeUrl`/`escAttrJs` are bypassable — Critical because the site signs wallet txs; (2) on a
  375 px phone only 2 of 7 tabs are visible and the Terminal expands the layout viewport to
  1,456 px; (3) x1watch.xyz (ANL Protocol, PL) is the main competitor: Telegram alerts, synced
  watchlist, node agent (disk/slot-lag/auto-restart), Delegation Program page with official
  criteria + per-validator Approved/Rejected/failing_criteria + delegated amount, APR per
  validator, responsive app. It lacks a score, leaderboards, compare, terminal, calculators,
  management. (4) Tachyon has no GitHub releases — version must come from gossip; x1watch reads
  slot_time_ms 370 and epoch_total_slots 216,000 live. (5) `data/history.json` is written hourly
  and read by nothing — it's the raw material for history charts.

### 2026-09-10 — Session 2 (hygiene pass, ~1 hour)
- `git pull` clean (no bot commits had landed since cb48789 — the :07 scores run hadn't fired
  yet; GitHub cron is often late). Cloud sandbox cannot reach x1valhq.xyz (proxy 403), so live
  checks run in the desktop-app browser; Playwright previews use a staged copy of `index.html`.
- **Verified live:** Delegation tile renders exactly one "Details" link
  (`.rb-open-link` → `openDelegationModal`). Terminal header: snapshot 7,434 stake accounts,
  Live (`vtRefreshLive`, 13 MB) 7,434 — the undelegated-`""`-key fix from session 1 works.
- **X1** global `:focus-visible` rule added just above `body {}` in the `<style>` block.
  Playwright-checked: keyboard focus on a nav tab → `solid 2px rgb(0,212,255)`, offset 2 px,
  follows the 10 px radius; mouse click → no outline. The 13 existing `outline: none` rules are
  all on inputs with their own `:focus` border/glow and still win (more specific).
- **U2/U3 decision:** Shaka chose **no Globe tab**. Deep links (`#/lookup/…`, `#/terminal`, …)
  already set `.tab.active` via `switchTab`; the globe home page intentionally highlights nothing.
  "Network" label unchanged. Both items closed.
- Still open from "Open small items": `_to_delete/` cleanup; ask terminal-error reporters about
  device/network.
- One commit to push at end of session (index.html + HANDOVER.md).

### 2026-09-11 — Session 3 (quick fix, ~15 min)
- Shaka reported two Validator Terminal display bugs at ~1000 px window width: the column
  header row floating in the middle of the table, and the self-stake percentile row cut off on
  the right. Both were side effects of session 1's mobile fix (M1): once `.vt-tbl-wrap` became
  a horizontal scroll container (≤1500 px), the `thead th { position: sticky; top: 48px }` rule
  measured `top` from the wrap instead of the page (header sat 48 px into the rows); the
  percentile grid (1 head + 7 values, `1fr` each) overflowed its `overflow: hidden` box below
  ~1380 px.
- Fix: inside the ≤1500 px block, `.vt-overlay table.vt-data thead th { top: 0 }`; new
  `@media (max-width: 1380px)` for `.vt-pctrow` → 4 columns with the head spanning full width.
  Verified by injecting the CSS into the live site at 1010 px: header above row 1, nothing clipped.
- Lesson: when a table wrap becomes a scroll container, re-check every `position: sticky`
  inside it (both `top` and `left` offsets now measure from the wrap).
- **Morning quick wins (same session):**
  - Data Center summary gets a sixth tile, **Foundation Delegation**: total XNT delegated across
    the portfolio, "n/m approved", and "k failing" (hover for names); clicking it opens the
    Delegation tab filtered to My Data Center (`delegFilterMine`). Rendered by
    `renderPortfolioSummary()` in the delegation module, refreshed whenever the portfolio
    summary numbers update.
  - Calculators now default to the **live XNT price** from the header pill (`window.xntPriceUsd`,
    set by the pill's `update()`; `applyLiveXntPrice()` fills `#stakingPrice` / `#breakevenPrice`
    unless the user has typed a value — `data-user-set`). U9 closed.
  - Bug fixes from the audit: **B5** browse-modal "+ Add" re-renders the filtered list
    (`filterValidatorList()`) instead of appending the next page; **B4** `destroyCardCharts()`
    drops stale per-card Chart instances whenever Lookup/Data Center re-render cards (charts
    were blank after a re-render); **B7** calculators rebuild their Data Center dropdowns when
    the portfolio changes (signature check), listeners bound once.
  - **F15 (part):** Data Center validators get a cyan border + "MINE" tag on every leaderboard.
    "Where am I" rank for validators outside the top 50 — done 2026-09-16.
  - Data Center summary: Delegation tile moved before Active (Shaka's request); values use
    `clamp()` font-size so "6,017,816.03" is not clipped; "Total Rewards" relabelled
    "Rewards Balance" (it is the vote-account balance sum — U9 fully closed).
  - Data Center summary grid pinned to 6 equal columns (3 on ≤900 px, 2 on ≤480 px) so the
    six tiles never wrap to a second row; Playwright-verified at 1180/1000 px, full number shown.
- **Card redesign — shelved.** Shaka asked for mockups of a different validator-card layout (no
  code changes). Explored: A ledger strip, B score-first, C health tiles, D fleet rows, then
  Editorial / Bold block (hero numbers), then Ruled grid / Ledger (all metrics equal, no boxes).
  Shaka's feedback: too many equal boxes and a generic look are the complaints, but the score
  should NOT be the focus and all eight metrics should stay equal — none of the above landed.
  PNGs are in the chat; working files not in the repo. Revisit with references from Shaka
  (sites whose look he likes) before drawing again.

### 2026-09-11 — Session 3, afternoon: power saver
- Shaka asked why the page is "one of the biggest drags on a system" when left open. Measured:
  JS heap flat at 60–70 MB (memory is NOT the issue); Network tab fires ~100 RPC calls/min even
  when the tab is hidden; globe renders 60 fps with auto-rotate forever while visible; nothing
  slows down when nobody is there.
- Added **`PowerSaver`** (defined just above `Router`): idle after 3 min without
  pointer/key/wheel/touch/scroll, or when the tab is hidden. `PowerSaver.gate(key, idleEveryMs)`
  is called at the top of every poller — SkipMonitor tick (60 s when idle) / pollHour (5 min) /
  pollEpoch (10 min) / UI ticker (off), current-leader 2 s poller, LeaderCountdown sync, TPS
  (5 min), epoch resync (5 min), epoch bar (off when hidden), XNT pill (10 min). Any activity ends
  idle instantly; fast pollers catch up on their next tick. Amber "⏸ Live updates paused" pill in
  the header while idle. `PowerSaver.forceIdle(true/false)` for testing from the console.
- **Globe:** auto-rotates for 60 s after load (`GLOBE_AUTOROTATE_MS`), then rests; the pause/
  resume button restarts a 60 s spin. Render-on-demand: `globeScheduleLoop()` pauses the
  three.js loop 1.5 s after the last movement and resumes on pointer/wheel/touch or controls
  'change'; idle → rotation off + loop paused. Pixel ratio capped at 1.5. IntersectionObserver
  now defers to `applyRotationState()` instead of unconditionally resuming.
- **B3 fixed:** SkipMonitor.start() re-checks `state.running` after each await and clears any
  existing timer before creating one — quick tab flips no longer leak poller sets.
- Verified with a node harness (idle gating, activity wake, hidden→idle→visible). Live check
  after deploy: `PowerSaver.forceIdle(true)` in the console should show the pill, stop the
  globe, and cut Network-tab RPC to ~1/min.
- **Session 3 totals (2026-09-11):** 4 pushes — terminal header/percentile fix; Data Center
  delegation tile + live XNT price in calculators; audit bugs B4/B5/B7 + MINE tags + summary grid
  fixes; power saver + globe render-on-demand + B3. Card redesign explored and shelved (Apple-style
  on site palette was the one Shaka liked).

### 2026-09-13 — Session 4 (quick fix, ~20 min)
- A community member (X1SCR operator, runs @x1VAL_BOT off his own DB) reported the site being
  slow, especially **Stake Details** ("Found 9 accounts, analyzing rewards…" for minutes).
  Cause (pre-existing, not from our changes): `toggleStakeDetails` called
  `fetchTotalValidatorRewards(vote, commission, 365)` — one `getInflationReward` per epoch for
  the vote account **plus** one per epoch for self-stake = up to **730 RPC calls** through the
  3-slot queue before anything rendered. Every other caller uses ≤ 30 epochs.
- Fix: the stake split (self / delegated / accounts) renders as soon as the two calls it needs
  return; the APY block shows "calculating…" and fills in after a 30-epoch fetch (7-day and
  30-day figures; 90-day/1-year options are gone — they needed 80 % of 365 epochs anyway). Cache
  is written twice (split first, then with APY).
- **Roadmap note from the conversation:** his approach is right for the rest of the slow
  spots — precompute per-validator reward history server-side once per epoch. `getInflationReward`
  takes a *list* of addresses, so the hourly Action can fetch a whole epoch for all 725 vote
  accounts (and all self-stake accounts) in a few batched calls and publish
  `data/rewards.json`; the site then reads one file instead of 30–60 RPC calls per card. This is
  F8 (rewards ledger) — bump its priority; it also unlocks F2 history charts.

### 2026-09-13 — Session 4, continued: rewards ledger (F8), ~2 hours
- Shaka: "lets do the long term fix." Built the server-side rewards ledger.
- **Probed the RPC from the built-in browser first** (cloud sandbox and the Mac VM cannot reach
  it): batch limits, epoch history depth, account layouts — all recorded in §4.
- `scripts/build-rewards-ledger.js` (Node 20, zero deps, `buildLedger(prev, opts)` exported for
  tests): getEpochInfo → getVoteAccounts (725) → vote withdrawers via `getMultipleAccounts`
  dataSlice → all stake accounts via one `getProgramAccounts` dataSlice → self-stake lists →
  per-epoch batched `getInflationReward` (250 addrs/call, 3 in flight) for votes and self
  accounts. Incremental against the previous `data/rewards.json`. Output: `{ v, generatedAt,
  currentEpoch, epochs[], counts, validators: { vote: { w, self[], v[], s[] } } }`.
- `scripts/test-rewards-ledger.js`: mock-RPC tests (full build, new un-indexed epoch dropped,
  null-cell recheck does not drop an indexed epoch, changed self list rebuilds that column,
  no-change run is ~free). The third case came from a real bug the live run exposed.
- **Ran the exact script live in the browser** (base64-loaded): 6-epoch window built in 8 s /
  71 calls / 223 KB; values match the site's old live `fetchTotalValidatorRewards` output
  epoch-for-epoch for a sampled validator. Incremental re-run: 14 calls.
- Workflow `update-terminal-snapshot.yml`: new step "Build rewards ledger" (`continue-on-error`),
  commit step adds `data/rewards.json` when present.
- `index.html`: `RewardsLedger` module (load with 5-min cache-bust, 10-min refresh, >48 h stale
  → ignored, `rows(vote, epochs, commission)`); `fetchTotalValidatorRewards` split into the
  ledger-first wrapper + `fetchTotalValidatorRewardsLive(vote, commission, epochs, knownSelf)`;
  `init()` warms the ledger. Node mock test of the slice: ledger + 1 live epoch → 2 RPC calls
  and no discovery; cache hit → 0; never-earning validator → only the 2 newest epochs
  re-checked; unknown validator → full live path; user classification → live path.
- Expected effect: Stake Details / earnings trend / Data Center "Rewards Last Epoch" / calculator
  APY go from 6–60 RPC calls per validator to zero (one 700 KB file, gzipped by Pages, shared by
  every card). The friend's x1VAL_BOT approach, without the database.
- **Live-verified 15:30 UTC** after Shaka pushed + ran the Action once: `data/rewards.json` = 36
  epochs (339–374), 725 validators, 386 RPC calls for the full backfill, 304 KB gzipped on the
  wire. On the site: 30 epochs for a ledger-covered validator → 0 RPC calls, 0 ms; Stake Details
  opens with the APY already filled in 0.8 s (the 4 remaining RPC calls are the stake-account
  split, not rewards). A validator whose newest epochs are null in the ledger (delinquent /
  never earns) re-checks the 2 newest epochs live: 4–5 calls, <1 s. Real Chrome: no console
  errors on a fresh load. (The built-in Claude browser pane shows "Maximum call stack size
  exceeded" + `hideIconPreview is not defined` on load — pane-only, not reproducible in Chrome.)
- Noticed while verifying: **`data/scores.json` was 3.8 h old** (generated 11:41 UTC, terminal
  snapshot 15:25) — the site fell back to client-side scoring. Check Actions → "Update scores"
  for a failed/skipped run and the "[bot] … is failing" issue.

### 2026-09-13 — Session 4, later: RPC load measurement + the cron discovery (~1 hour)
- Earnings-trend chart on the card (F2): mocked up (sparkline in the Last Epoch Earned tile +
  "Trend" modal, and a strip variant) — **Shaka rejected both: "takes up too much real estate".**
  Don't re-propose card-level charts. `docs/`-less; mockup source in the session only.
- Added `window.rpcStats` (per-method RPC call counter) inside `installRpcThrottle` — in the
  console: `rpcStats.byMethod`, `rpcStats.total`, `rpcStats.reset()`. Keep it; it is how the
  numbers below were measured (real Chrome, 5-validator portfolio, `#/datacenter`).
- **Measured:** empty page = 8 RPC calls; 5-validator Data Center load = **66**, of which
  **41 `getBlockProduction`** — every card ran `fetchHistoricalSkipRates(node, 7)` = 7 full-epoch
  range scans + 1 current-epoch call. Rewards = 0 calls (ledger working). Idle = 0 calls/30 s.
- Fix: `publishedSkipHistory(nodePubkey)` maps `scores.json` (`skipRate7d`, `skipEpochs`,
  `leaderSlots7d`, keyed by node via `doc._byNode`) into the `fetchHistoricalSkipRates` shape;
  that function now tries it first (awaiting `canonicalScoresPromise`), RPC only if unavailable.
  Live-verified: **66 → 26 calls**, `getBlockProduction` 41 → 6; skip tile now shows the same
  7-epoch figure the leaderboard uses (e.g. "0.39% · 4-epoch average" instead of a 3-epoch live
  number).
- **Discovery: GitHub's scheduler runs the "hourly" workflows every 2–5 h.** Scores ran 00:51,
  05:58, 11:40; terminal snapshot 00:13, 05:18, 10:34 (all successful — cron just doesn't fire).
  With the site's old 3 h staleness cutoffs that meant: most of the day, every visitor did the
  client-side scoring crawl AND the Validator Terminal fell back to the 13 MB live download.
  Almost certainly the real cause of the "site is slow" reports.
- Mitigation shipped: `CANONICAL_MAX_AGE_MS` 3 h → **12 h**; skip history accepts scores up to
  **24 h** (`window.canonicalScoresDoc` keeps the file even when too stale for scoring);
  terminal `SNAPSHOT_MAX_AGE_MS` 3 h → **12 h** with an amber "Snapshot · Nh old" label in the
  header corner once older than 2 h (`snapshotAgeLabel()`). Rewards ledger already tolerated 48 h.
- **Decision: (a)** — Shaka: "I don't want anything to have to run on the mac."
  `.github/workflows/heartbeat.yml`: guard (exits if another heartbeat < 55 min old is alive;
  waits 45 s first because the previous run dispatches us as its last step) → `gh workflow run`
  scores + terminal (+ geo on even hours) → sleep until :02 past the next hour → dispatch itself.
  Backup cron `11 */2 * * *` restarts the chain if it ever dies; concurrency group `heartbeat`.
  `permissions: actions: write` is what lets GITHUB_TOKEN dispatch (workflow_dispatch is the
  documented exception to "GITHUB_TOKEN events don't trigger workflows"). Public repo → free
  minutes. To stop it: cancel the run AND disable the workflow, or the cron restarts it.

### 2026-09-13 — Session 4, evening: under-the-hood #1 — stake split RPC diet
- Decision on "stake split from files": **not worth it** as originally framed. Serving the
  self/delegated split from `terminal.json` would mean downloading ~600 KB gz for what is a
  few KB of `getProgramAccounts` per validator; the file only wins on RPC independence. Kept the
  RPC call but stripped everything around it:
  - The three stake-split sites (Stake Selection modal ~23360, `toggleStakeDetails` ~29620,
    Data Center portfolio loop ~30440) each did `getEpochInfo` + `getInflationReward` for every
    stake account (epoch-1, then epoch-2 if empty) + `getAccountInfo` for the vote withdrawer.
    The reward probe fed only a debug `console.log` (`rewardRate` / `hasReward`, leftovers of the
    old reward-rate heuristic) — deleted, 262 lines gone.
  - New `getVoteWithdrawer(vote)` (next to `classifyStakeSource`): reads `w` from the rewards
    ledger, `getAccountInfo` only as fallback. All three sites use it.
  - Net: Stake Details open 4 → **1 RPC call** (the `getProgramAccounts` scan); portfolio loop
    4 → 1 per validator; Stake Selection modal 4 → 1.
- Tooling note: `device_commit_files` re-used a stale staged copy when the same staged filename
  was reused — stage under a NEW filename each time (or write via device_bash heredoc/base64).

### 2026-09-14 — Session 5: "5 random validators in My Data Center" (~30 min)
- Shaka opened My Data Center and found White Eagle, Angry Bird, levykrak test5, Bin Suardi and
  Teddybear instead of Shaka_Vibes_1–5.
- **Not a site bug.** The only writer of `localStorage.x1Portfolio` is `savePortfolio()` (Add /
  Remove / Clear buttons); nothing auto-populates, imports or sorts the list, and `getValidatorInfo`
  looks validators up by the exact vote key. The stored list was *sorted by pubkey* — no sequence
  of button clicks produces that.
- Forensics from Chrome's own `x1ValidatorPerformanceHistory` (written for portfolio validators
  on each Data Center load): Shaka_Vibes_1–5 have snapshots from 09-08 up to **2026-09-13 15:03
  UTC**; the five strangers start at **15:43 UTC** the same day — exactly the window in which
  session 4 was "live-verifying" the rewards ledger in real Chrome via the extension. Conclusion:
  the previous Claude session wrote a 5-validator test list into Shaka's browser storage and
  never restored his. `x1SelfStakeSelections` for Shaka_Vibes_1–5 was untouched.
- Restored (with Shaka's go-ahead) through the site's own handlers: `addToPortfolio()` ×5, then
  `removeFromPortfolio()` ×5 on the strangers. Verified after a reload: `x1Portfolio` = the five
  Shaka_Vibes vote keys, five cards render (#13–#17 of 725), count 5.
- Rule added to the "Start here" list (item 7): live checks in Shaka's Chrome are read-only.
- No code change. `HANDOVER.md` still carries the uncommitted evening-of-09-13 edits plus this
  entry — commit both together. `.git/objects/maintenance.lock` exists (harmless leftover from
  Claude's `git fetch`; `rm` it if git ever complains).
- **Afternoon, Validator Terminal:** pinned columns (#, Vote Account) went see-through on even
  and hovered rows when the table was scrolled sideways (≤1500 px) — the zebra/hover rules
  (`tbody tr:nth-child(even) td { background: rgba(…) }`) out-specified the sticky cells'
  opaque `background: var(--bg-card)` and replaced it. Fix: stripe + hover are now
  `background-image: linear-gradient(...)` overlays and the sticky cells set `background-color`,
  so the two layers stack. Verified live at 1100 px by injecting the CSS: even-row pinned cell
  `rgb(17,29,50)` + overlay, nothing shows through. Lesson (add to the sticky one from 09-11):
  a sticky cell needs an opaque `background-color` that no later `background:` shorthand resets.

### 2026-09-15 — Session 6: validator card redesign (~3 hours)
- Started on ② (split `index.html`); Shaka redirected to **card mockups** ("modern, sexy, easy to
  read, helpful, clean"; refs: Apple/Linear minimal + Phantom glass; palette open). Drew six
  artboards with real Shaka_Vibes_1 data (Current, A Ledger, B Glass, C Obsidian, D Spec, E Aurora)
  as a Claude Design canvas — Shaka's app could not open the hosted artifact, so everything was
  delivered as PNG + a standalone HTML gallery file. Working files: cloud session only
  (`x1-card-looks/*.dc.html`); the final look is what's in `index.html` now.
- Decisions, in order: **B (Glass) layout** → recoloured with site tokens only (B2) → Manage button
  must read "Manage Validator" and be the one lit control (cyan→blue gradient, inner highlight,
  halo, sliders icon in a disc); Share is an icon-only round button; "Top 10%" toned down to a
  thin gold outline chip → **E's Earnings & stake / Health grouping** added (F) → status row
  redone: of four options Shaka chose **#3 "leader band"** (Active folds into the meta line next
  to the version; the next leader slot gets its own amber band with Slot explorer as its button)
  → "Delegation approved" dropped from the header (the tile already says it); tile sub reads
  "XNT · Approved".
- **Implemented in `index.html`** (`renderValidatorCard`, one renderer for Lookup + Data Center):
  - `CARD_ICONS` (inline SVG: star, share, check, plus, sliders, clock, search, arrow, chevron)
    replaces every emoji on the card; `getTierBadge` uses the star.
  - Header: `.validator-identity` column (name + tier chip + rank chip; meta line = address · copy
    · version · `.vh-status` dot "Active"/"Delinquent"); `.validator-actions` = `.share-icon-btn`
    + Add/Remove + `.manage-validator-btn` (label "Manage Validator", `.mv-icon`). The old
    `.status-badge` pill and `.manage-validator-btn-wrapper` are gone from the card.
  - Add button: "Add to Data Center" → disabled "In Data Center" (`.is-added`; `addToPortfolio`
    flips it in place the same way). Data Center cards keep "Remove".
  - `.vh-leader-band` replaces `.vh-chip-strip`: clock icon, `.vh-next-leader` text (still
    `data-node`, still ticked by `LeaderCountdown`), `.vh-band-note` ("12 leader slots this epoch
    · epoch 375", from `leaderScheduleCache[node].length` + `currentEpochNumber`), Slot explorer
    button. `LeaderCountdown.tick` now uses `setChip(chip, text, state, note)` which mirrors
    `is-leader` / `is-none` onto the band (green / muted). Wording: "Next leader slot in ~1h 19m",
    "Leader now", "No upcoming leader slots", "No more leader slots this epoch".
  - Stats: `.stats-grid` now holds two `.stat-group`s with `.stat-group-label` + `.stat-group-grid`
    (4 cols): **Earnings & stake** = Rewards balance, Earned last epoch, Active stake, Foundation
    delegation (the `.deleg-section` tile moved up; `renderCard` in the delegation module is
    untouched); **Health** = Epoch credits, Skip rate, Commission, Performance, 7d. Labels are
    sentence case, single line. Semantic value colours (green/red skip, perf) kept.
  - Footer: Share removed (it's in the header); "Stake details" / "Earnings trend" with SVG
    chevrons; `.expanded` rotation unchanged. `shareValidator` shows a check icon on the icon
    button (`.is-copied`).
  - CSS: one block "VALIDATOR CARD v2" at the end of the `<style>` (~line 12040–12200) overriding
    the older card rules via `.validator-card …` selectors; own media queries at 1100/768/480 px
    (2-col tile grids, header stacks, band note hidden on phones).
- Verified: `node --check` on all 5 inline scripts; Playwright smoke (offline, fake validator) at
  1440 / 1000 / 390 px — no page errors, `LeaderCountdown` ticks the new chip. Not yet live-verified
  (needs the push) — do that first next session.
- Pushed by Shaka during the session (`e7c9f08`/`87ebfa3` card, `51d32c4` first button). Follow-ups
  after seeing it live: stat tiles stayed 4-up down to a ~700px card (container query on
  `.stat-group`, was a 1100px media query); **Manage Validator button** rebuilt after a reference
  Shaka liked (dark fill, thin luminous border, bold uppercase glowing label, icon in a ringed disc,
  a sheen that sweeps across every ~4.8s via `::after` + `@keyframes mvShine`, paused under
  `body.power-idle` and for `prefers-reduced-motion`). Colour went cyan → blue → "too black" → "too
  blue" → settled on **navy with a light blue shade** (`#234d8c→#183868`, label `#bfe0ff`, border
  `--accent-blue`); hover steps up one notch (white label). Accent is `--mv-c` on the button rule.
  Final button state pushed by Shaka at end of session ("Manage Validator button: navy-blue fill").
- Not changed: Compare tool cards, Delegation tab, modals, Data Center summary tiles.
- Still to do first next session: live-verify (band ticks/turns green, delegation tile, sheen,
  Add/Remove flip, phone width) — Shaka's screenshots confirmed the card and band render live.

### 2026-09-16 — Session 7: live-verify + duplicate-card fix (~1 hour)
- `git pull` fast-forwarded 79 bot commits (heartbeat healthy: scores :04, snapshots :43, geo every
  2 h). Monday's HANDOVER edits were still uncommitted locally — committed with this session.
- **Card redesign live-verified** in the built-in browser pane (read-only in Chrome rule respected;
  the pane's own localStorage was used for the Add/Remove test and cleared afterwards):
  1440 px — header/meta line/status dot, icon-only Share, "Manage Validator" with the `mvShine`
  sheen running, leader band ("Next leader slot in ~28m · 276 leader slots this epoch · epoch 379"),
  two stat groups × 4 tiles, delegation tile hydrated with exactly one Details link, no emoji left
  on the card. 375 px — 2-col tiles, band note hidden, no horizontal overflow (card 343/375 px).
  Add → "In Data Center" (disabled) flips in place; Data Center card shows Remove; summary tiles
  fill. RPC on a fresh Lookup load: 17 calls, rewards 0 (ledger 36 epochs, generated :43).
  Not seen: the band's green `is-leader` state (no slot fell inside the session).
- **Bug found while verifying — duplicate card ids.** Lookup and My Data Center render the same
  validator with the same element ids (`lastEpoch-<8>`, `chart-<8>…`, `stake-<vote>-section`), and
  `#validatorResults` comes first in the DOM, so after looking up one of your own validators the
  Data Center card's "Earned last epoch" stays "Loading..." forever and its Stake details /
  Earnings trend buttons expand the *hidden* Lookup card's sections (chart instances and
  `chartDataStore` were shared too). Pre-existing, not from the redesign; Shaka would hit it any
  time he looks up a Shaka_Vibes validator and then opens Data Center.
  Fix in `index.html`: `chartId` = `chart-lk-<8>` / `chart-dc-<8>` (Lookup / Data Center, from the
  `showRemoveBtn` arg of `renderValidatorCard`) so every chart id, `chartInstances` and
  `chartDataStore` key is per card; `fillCardLastEpoch` fills every `[id="lastEpoch-<8>"]`
  (new `fillOneCardLastEpoch`); `toggleStakeDetails` resolves its stake/chart sections from
  `button.closest('.validator-card')` and the async APY completion checks `section.isConnected`
  instead of re-looking-up by id; `cancelStakeLoad`/`retryStakeLoad` take `this` and use
  `stakeSectionFor(vote, el)`. Offline Playwright smoke (both cards rendered for Shaka_Vibes_1):
  ids distinct, last-epoch fills both, DC chart/stake toggles open only DC sections, Lookup card
  independent, no page errors. Note `destroyCardCharts()` still drops all `chart-*` instances when
  either tab re-renders (toggle re-inits them, so harmless).
- **`hideIconPreview is not defined` on load** (pane showed it; Chrome likely too, it was just
  filtered): `<img id="iconPreviewImg" src="">` fires `onerror` at parse time, ~15k lines before
  the script that defines the handler. Removed the empty `src` — `previewIcon()` sets it anyway.
- Pane quirk for future sessions: synthetic `left_click` by ref did not fire the card's Add button
  (element was on top, no overlay); `el.click()` via `javascript_tool` works. Region `zoom` is not
  supported in the pane — use DOM checks instead of screenshots for verification.
- Still to do next: push (Shaka), live-verify the fix, then the visual pass or the
  `index.html` split (③ in the Start-here list).

### 2026-09-16 — Session 7, continued: split `index.html` (C1), ~1.5 hours
- Shaka confirmed the leader band goes green live. Push `0101736` (duplicate-card fix) live-verified:
  Data Center card fills (26.88), its Earnings trend / Stake details open on the DC card only,
  `chart-lk-…` / `chart-dc-…` ids, console clean on a fresh tab (the pane's "Maximum call stack"
  error is gone too).
- **The split is a pure line move.** `index.html` (38,893 lines) → `index.html` (3,275 lines) +
  `css/site.css` (the `<style>` block) + 18 `js/*.js` (the four inline `<script>` blocks; the main
  20k-line one cut into 14 files at its own section banners). Indentation kept as-is (4 spaces) so
  the move is exactly reversible; whitespace-only lines and template literals made a dedent
  non-reversible, so it was not attempted. Layout in §3.
- **Why it is safe:** classic scripts share one global scope, so `function`/`let`/`const` across
  files behave as before *except* that hoisting no longer crosses a file boundary — load-time code
  in file A cannot see declarations in file B. Checked with an acorn pass (scratch tool, not in the
  repo): for every top-level statement that *executes* at load (IIFEs, `const x = f()`, listeners,
  timers) collect the identifiers evaluated immediately and the transitive closure through called
  functions, flag anything declared in a later file. Result: the only immediate cross-file
  reference is `const originalSelectValidatorForSearch = typeof selectValidatorForSearch === …`
  in `js/compare.js` (defined later in `js/manage.js`) — it becomes `null` instead of the function
  and is **never read** (dead code; delete during ③). All IIFEs (logging gate, RPC throttle,
  RewardsLedger, PowerSaver, Router, LeaderCountdown, SkipMonitor) only define and return; all
  DOMContentLoaded/keydown/hashchange listeners fire after every file has run; `init()` is the
  last statement of the last main file. Async continuations that start at load
  (`loadCanonicalScores`, `loadPortfolioSafe`) touch only their own file.
- **Verification:** `node scripts/assemble-monolith.js --check` (new, committed) rebuilds the
  monolith from the pieces and is byte-identical to `git show 0101736:index.html`, both in the
  cloud and on the Mac; `node --check` on all 18 files; offline Playwright parity run — same page
  served as monolith and as split, visiting `#/live #/terminal #/lookup/… #/datacenter
  #/leaderboard/performance #/delegation #/compare #/calculators/staking #/globe`, comparing page
  errors, console errors, active tab, visible sections, 24 globals, stylesheet rule count (2,034)
  — identical except the dead const above. Split run requests 27 files instead of 8.
- Not changed: script order/position (still synchronous, same place in the body, still before the
  `defer`red Chart.js/web3.js), CSP (`script-src 'self'` was already there), workflows (none touch
  index.html). `_headers` is Netlify-style and ignored by Pages — unchanged.
- **Deploy caveat (new):** Pages serves everything with `max-age=600`, so for up to 10 min after a
  push a visitor can hold a cached `index.html` with fresh `js/*.js` (or vice versa). Cross-file
  changes may briefly mismatch for such a visitor; a reload fixes it. Not worth a cache-busting
  scheme without a build step — but keep it in mind when a report says "broke right after deploy".
- Comments in `scripts/build-*.js` still say "in index.html" for RewardsLedger / inflateSnapshot /
  DELEGATION PROGRAM — now `js/core.js`, `js/terminal.js`, `js/delegation.js` (fixed in this commit).
- **Split live-verified** (push `d28aa32`): `css/site.css` + 18 `js/*.js` all 200, 320 KB gzipped
  on the wire, 2,038 CSS rules; walked `#/live #/terminal (723 rows, 7,453 stake accounts)
  #/lookup/… (card, 26.88, delegation tile, band) #/datacenter #/leaderboard (50 rows)
  #/delegation (702 rows) #/compare #/calculators (live price 0.2708) #/globe (canvas)` in a fresh
  pane tab: zero page errors, zero console errors. (The long-lived pane tab from earlier in the
  session shows stale "Maximum call stack" / "Script error." entries — pane artefacts; a fresh
  tab is clean, same as Chrome.)
- **Bug found while walking the tabs — Router double-apply.** A hash navigation (typed URL,
  clicked `#` link, back/forward) fires BOTH `popstate` and `hashchange`; `Router.start()`
  listened to both, so `apply()` ran twice per navigation. Visible effect: `#/compare/<vote>`
  deep links added each validator **twice** ("(4)" for two votes, duplicate cards); every deep
  link also double-switched tabs. Pre-existing since U1 (2026-09-10), not from the split. Fix in
  `js/app.js`: `onNavigate()` applies a route only if it differs from `lastApplied` (which
  `set()` also records). Playwright before/after: `addToComparison` calls 2 → 1, `switchTab`
  2 → 1, back/forward still route. First real edit of a split file; `assemble-monolith.js
  --check` against `0101736` will now (correctly) report a mismatch in the Router.
- Router fix live-verified (`fbe8852`): `#/compare/a,b` → exactly two validators, "(2)", back/
  forward route, no console errors. Note the **cache skew** from the deploy caveat happened for
  real: right after the push the pane ran the cached old `js/app.js` (transfer 0 bytes) while a
  `cache:'no-store'` fetch already returned the new one — `fetch(url, {cache:'reload'})` then a
  reload picks it up. Expect this on any live check inside ~10 min of a push.
- Session 7 totals (2026-09-16): 3 pushes — duplicate-card ids + `hideIconPreview`; the split
  (C1); Router double-apply. All live-verified.
- Next session: start ③ — the `data-action` dispatcher can now be added file by file (start with
  `js/cards.js`, the card is the most-touched surface).

### 2026-09-16 — Session 7, evening: F15 + P2 leftovers (~1 hour)
- **F15 "Where am I"** (`js/leaderboards.js`): the per-row renderer in `renderLeaderboard` and
  `renderDelegationsLeaderboard` is now a reusable `renderItem(v, index)`; after the top-50 rows,
  `whereAmIHtml(sorted, 50, renderItem)` appends a dashed divider "Your validators outside the
  top 50" with every Data Center validator ranked ≥ #51 rendered as a normal row with its real
  rank (e.g. "#622", MINE tag, cyan border), plus a dim "Not ranked in this category: …" line
  for portfolio validators the category's filter excluded (delinquent, < 10k XNT stake, no score,
  no delegation from these pools). Nothing renders when the portfolio is empty or all are in
  the top 50. Newest board unchanged (it groups by epoch, no ranks). CSS: `.lb-mine-divider`,
  `.lb-mine-note` next to `.lb-mine-tag`. Offline Playwright with 724 mocked validators and a
  3-validator portfolio (#13, #137, #700-delinquent): 52 rows on performance/stake, 52 + note on
  commission/reliable/efficient, 50 with an empty portfolio, no errors. Not yet live-verified.
- **P2 leftovers** (`js/core.js`): `SessionCache` (sessionStorage, `{ts, data}`, try/catch
  everywhere). `fetchValidatorIdentities()` returns the cached map for 1 h (skips the ~1 MB
  `getProgramAccounts` on the Config program on every reload); `fetchSupplyCached()` keeps
  `getSupply`'s total for 1 h; `loadNetworkStats` stores the live total stake + supply
  (`x1StatsBarCache`, 24 h). `paintStatsBarFastPath(doc)` runs when `canonicalScoresPromise`
  resolves: fills validators / active / delinquent / epoch / slot from scores.json (only if the
  file is < 3 h old) and stake / supply from the cache — writing only into cells still showing
  `--`, so live RPC values always win. Offline Playwright: first load paints 5 of 7 cells from
  scores.json with the RPC blocked; a reload with the caches paints all 7 and attempts no
  `getProgramAccounts` / `getSupply`; expired caches fall through to the RPC. Trade-off: a
  validator who changes name/icon is seen on reload up to 1 h later in the same tab (new tab =
  fresh). Not yet live-verified.
- **Live-verified** (`502721e`, pane with Shaka_Vibes_1–5 in the pane's own storage, cleared
  after): performance / stake / commission / reliable / delegations show 50 rows and no divider
  (all five are top-50 there); **Most Efficient** shows the divider + 5 pinned rows
  "#360 Shaka_Vibes_5 … #365 Shaka_Vibes_1". Second load: `x1IdentitiesCache`, `x1SupplyCache`,
  `x1StatsBarCache` present; `rpcStats.byMethod` has **no `getProgramAccounts` and no
  `getSupply`**; scores.json (78 KB gz) lands at ~140 ms and the bar is fully painted before the
  RPC set returns.
- **Found while measuring — the Leaderboards tab costs 724 `getAccountInfo` calls** (8 batched
  POSTs of 100, ~3 MB): `loadLeaderboard` → `fetchAllExtendedEpochCreditsBatch()` pulls every
  vote account's full `epochCredits` history (jsonParsed) because Most Efficient averages 7
  completed epochs and Newest needs each validator's first epoch, while `getVoteAccounts` only
  carries the last 5 epochs. Fix belongs server-side: have `compute-scores.js` publish
  `firstEpoch` + the last 8 epochs' credits per validator in scores.json (it already has the
  vote accounts) and make the client use them, RPC only as fallback. Added to §5 as **P9**.

### 2026-09-16 — Session 7, late: P9 leaderboards credits diet (~30 min)
- `scripts/compute-scores.js` already fetched every vote account's full `epochCredits` via
  `getMultipleAccounts` (for scoring); it now also publishes per validator `credits` (last 8
  entries `[epoch, credits, previousCredits]`, newest last), `creditsFirstEpoch` (oldest epoch on
  record — the account keeps ≤ 64, same semantics the client had) and `creditsEpochs`. ~+65 KB
  raw on scores.json. `test-compute-scores.js` checks all three (3 new assertions).
- `js/leaderboards.js`: `loadLeaderboard` awaits the canonical scores first, then
  `publishedCreditsMap()` builds the vote → credits map from scores.json when it covers ≥ 90 % of
  `allValidators` (stamping `creditsFirstEpoch` / `creditsEpochs` on each), else the old
  `fetchAllExtendedEpochCreditsBatch()` RPC path runs. Newest Validators takes `firstEpoch` from
  `creditsFirstEpoch` when present (the merged 8-entry slice's `[0]` is not the first epoch).
  Offline Playwright with 100 mocked validators: map built (8 entries each), old-format or
  < 90 %-coverage file → null → RPC fallback, Newest groups/ranks correct, Most Efficient renders.
- **Live-verified** after Shaka ran the scores workflow by hand (run #719, file generated
  18:54 UTC, 724/724 validators carry `credits`, Shaka_Vibes_1 first seen epoch 316 with 64 on
  record; scores.json now 1.15 MB raw): fresh Leaderboards load → `rpcStats.byMethod` has **no
  `getAccountInfo` at all** (was 724), status "Done!", Performance / Most Efficient / Newest
  render with the same leaders as before (Newest: Digital Stack Systems · Epoch 370 first).
- Session 7 grand total (2026-09-16): 6 pushes — duplicate-card ids + icon preview; the split
  (C1); Router double-apply; F15 + P2; P9. All live-verified. Uncommitted: this HANDOVER edit.

### 2026-09-17 — Session 8: card header squeeze (~30 min)
- Start: local had one unpushed commit (`4832b4c`, HANDOVER only) and was 81 bot commits behind.
  Claude's `git pull --rebase` first failed mid-rebase (can't delete `.git/rebase-merge`); after
  Shaka granted delete permission on the folder the rebase ran, but the VM has no git identity so
  the commit could not be re-created — its HANDOVER change is now a **staged modification** on top
  of `f8975f1`. Heartbeat healthy (scores :03, snapshots :43).
- Shaka: at narrower window widths the Share / Remove / Manage buttons dropped under the identity;
  asked to abbreviate the address so the meta line (copy · version · Active) moves left and the
  buttons fit. Cause: `.validator-header` is `flex-wrap: wrap` and `.validator-info` had
  `flex-basis: auto`, so the wrap decision used the identity's *max-content* width — i.e. the
  full 44-char address line (~470 px) — even though the address could have wrapped.
- Fix (`js/cards.js` + `css/site.css`, VALIDATOR CARD v2 block):
  - `.validator-address` renders `voteAccount.slice(0,8) + '…' + slice(-6)` (Compare-tool style),
    `title` = full address, `white-space: nowrap`, `cursor: help`; the copy button still copies
    the full key.
  - `.validator-card .validator-info { flex: 1 1 0; min-width: 300px }` — the identity column
    shrinks first (tier/rank chips wrap under the name), and the actions only drop to a second
    row once the identity would go under 300 px.
- Offline Playwright (fake validator, Lookup + Data Center variants, 1440/1100/1000/900/820/768/390):
  before, the actions dropped under at card width ≤ ~940 px; after, they stay beside the identity
  down to ~800 px (Remove) / ~850 px ("Add to Data Center" + a long name), no horizontal overflow,
  no page errors, ≤ 768 px column layout unchanged. Contact sheet delivered in chat.
- **Live-verified** (`b1f1406`, pane with emulated viewports): address `5ar5xXje…TvQNac`, computed
  `flex: 1 1 0px` on `.validator-info`; at 1000 px the actions sit beside the identity (before:
  dropped); at 850 px the Lookup card (wider "Add to Data Center") drops them — as designed by the
  300 px floor; a Data Center card (Remove) holds there. No overflow. Band showed "Leader now".
  The pane logs one "Maximum call stack size exceeded" per load even in a fresh tab while the pane
  is *hidden* (innerWidth 0) — not caused by this change (CSS + string slice); Chrome was clean on
  2026-09-16. Worth a look some day: probably a resize/globe loop at 0 px width.
- Push mishap: my earlier `git rebase --quit` left the repo on a **detached HEAD**; Shaka's commit
  landed there. Fixed with `git branch -f main <sha> && git checkout main`, then push. Lesson: after
  any git surgery, check `git status -sb` says `## main…`, not just `--short`.
- Cloud clone of the repo + `smoke.js`/`shot.js` harness live in the session scratchpad only.

### 2026-09-17 — Session 8, continued: C2 started — `data-action` dispatcher (~1 hour)
- Shaka chose ③ after a short cons list (silent breakage risk, no visible change, all-or-nothing
  CSP benefit, big diffs, third-party libs under strict CSP, new-button discipline).
- **Inventory** (b1f1406): 322 inline handlers — 263 `onclick`, 23 `oninput`, 18 `<img onerror>`,
  13 `onchange`, 1 each onmouseenter/onmouseleave/onmousedown/onload/onfocus/onblur; 217 in
  `index.html`, 105 in the js renderers. One inline `<script>` (frame-buster, head line 19).
  `style-src 'unsafe-inline'` (361 `style=` attrs) is out of scope — the goal is `script-src`.
- **Dispatcher** `Actions` in `js/core.js` (right after `safeUrl`, so it exists before any file
  registers): document-level listeners for click→`data-action`, change→`data-change`,
  input→`data-input`, and capture-phase error/load→`data-onerror`/`data-onload` (those don't
  bubble). `Actions.register({ name: (el, event, dataset) => … })` per file, at the end of the
  file. Walks up through every ancestor carrying the attribute (= bubbling); a handler that calls
  `e.stopPropagation()` ends the walk AND the dispatcher calls `stopImmediatePropagation()` so the
  "click outside" closers registered later on document (cred tooltip in core.js, compare search,
  cooldown popover in manage.js) stay silent — exactly what the inline version achieved. Unknown
  name → console.warn `[Actions] no handler registered`; thrown handler → console.error. Shared
  actions: `img-fallback` (hide broken img, show next sibling) and `stop` (bare stopPropagation).
  **Rules:** attribute values via `escHtml()` (never `escAttrJs` — it no longer has a use);
  numbers are strings in `dataset` → `Number(d.x) || 0`; `el` is what `this` used to be.
- **Converted:** `js/cards.js` — all 17 (Add/Remove, share, copy, Manage Validator, cred badge,
  slot explorer, Breakdown, stake-selection tile, perf tile, Stake details, Earnings trend,
  chart type ×2, lookup result row, 2 img fallbacks); `selectLookupValidator` and
  `addToPortfolio` now toggle the `data-action` attribute instead of `el.onclick`.
  `js/delegation.js` — the tile's Details link (`delegation-details`) and the Enrol link (`stop`).
- **Test** (`actions-test.js`, scratchpad; offline Playwright, both card variants + a lookup row,
  hostile name `Evil "<b>&'name`, broken icon URL, a document click listener registered after the
  dispatcher): every control fires its function exactly once with the original argument types
  (numbers as numbers, `el` passed where `this` was, `event` for the perf explainer), the name
  round-trips unescaped, child clicks bubble to the tile, copy/Breakdown/slot-explorer/Details
  suppress the outside listener while Share reaches it, both broken images fall back, 0 inline
  handlers left in the rendered card, 0 page errors, 0 `[Actions]` warnings.
- Not live-verified yet. Next file: `js/manage.js` (21 — Manage Validator modal, where wallet
  signing lives), then `js/modals.js` (15), `js/card-details.js` (6).
- **Batch 1 live-verified** (`219035d`, pane, fresh load): the Lookup card has 0 inline handlers,
  13 `data-action` elements all registered (`Actions.has`), Earnings trend / Breakdown / Delegation
  Details open through the dispatcher, copy fires (clipboard denied only because the pane wasn't
  focused), no `[Actions]` warnings.
- **Batch 2 — `js/manage.js` (21) + `getCopyButtonHtml` (core.js, used in 25 places):**
  - Browse-validators list: `list-select` / `list-portfolio-add` / `list-compare-add` (attribute
    omitted when already added, as the empty onclick was); logos use `img-fallback-text`
    (new shared action: hide img, parent textContent = `data-fallback`).
  - Perf explainer: logo `img-fallback`, `ask-claude` (vote/name/score/details as data attrs).
  - Stake classification modal: `stake-selection-close` / `-save`, `stake-cat-cycle` (stops
    propagation). Wallet-required popup: `wallet-popup-connect` / `-close`.
  - Stake account rows: `select-account` + `data-account="stake-N"`; the
    `[onclick="selectAccount('stake-N')"]` selector in `selectAccount` became
    `[data-action="select-account"][data-account="stake-N"]`.
  - **Manage Validator action grid + action explainer** used *code strings*
    (`createBtn(…, 'initiateRedelegate()')`, `lockedClick: "showActionExplainer('x','y')"`,
    `info.action.onclick`). Now `[fnName, ...args]` arrays (`call:` in the descriptor and explainer
    tables) rendered by `manageCallAttrs()` as `data-action="manage-call" data-fn data-args(JSON)`
    and resolved at click time through the **`MANAGE_CALLS` whitelist** (lazy arrows, so the
    wallet-tx.js functions resolve fine) — never `window[name]`. `data-then-close` closes the
    explainer after the call. Merge list: `merge-toggle` (row, eligible only) / `merge-toggle-box`
    (checkbox, stops). Redelegate search: `redelegate-select`.
  - `copy-address` registration moved from cards.js to core.js (shared).
  - Test `manage-test.js` (scratchpad): real renderers with mocked state — browse list (both
    modes, hostile name, broken icon → letter), wallet popup, classification modal, `renderActions`
    (16 buttons: wallet 2, validator 4, stake 8 locked → explainer), explainer modal (call-to-action
    runs + closes, Got it closes), stake rows (child click bubbles, copy button stops), redelegate
    results, merge list (eligible rows toggle, checkbox stops, ineligible inert). 15 spied calls,
    all once with original args; 0 inline handlers in every rendered container; 0 page errors;
    0 `[Actions]`/`[manage-call]` warnings. Not live-verified yet (needs the push).
- Progress: 42 of 322 handlers converted (core 1 · cards 17 · delegation 2 · manage 21 + the
  shared copy button). Next: `js/modals.js` (15), `js/card-details.js` (6), `js/leaderboards.js` (7).
- **Batch 2 live-verified** (`511cab6`): Manage Validator opens via `card-manage`; 14 action
  buttons carry `data-fn` (6 enabled, 8 locked → explainer opens "No Stake Account Selected" and
  Got it closes it); 9 real stake rows `select-account`; 14 copy buttons via the shared handler;
  no `[Actions]` warnings. The 8 inline handlers left inside the modal are static index.html
  markup (back, copy, connect/disconnect wallet, legend, refresh, vote row, authority badge).
- **Batch 3 — `js/modals.js` (15):** reward-breakdown Retry (reuses `reward-breakdown`, whose
  registration moved from cards.js to modals.js where `openRewardBreakdown` lives), `rb-close`,
  `rb-portfolio-retry`; TPS modal: `tps-pin-close`, `tps-fetch-txs` (idx/start/end as data),
  `tps-copy-tx`, tooltip container `stop`, and the SVG hit-zone rects `data-enter`/`data-leave`/
  `data-action="tps-bar"`; `slot-tl-toggle`; `sm-refresh` ×2; slot-modal logo now renders a
  hidden `.slot-modal-logo-ph` next to the img + `img-fallback` (was an `insertAdjacentHTML`
  onerror). **Dispatcher additions (core.js):** `mouseover`→`data-enter` and `mouseout`→
  `data-leave` with enter/leave semantics (a transition whose relatedTarget is inside the element
  is ignored) because mouseenter/leave don't bubble; `img-fallback` now clears the placeholder's
  inline `display:none` instead of forcing `flex` (every placeholder class is flex in the CSS).
  Test `modals-test.js`: Retry button carries the escaped hostile name and stops propagation;
  60 hit zones, enter → tooltip + `_tpsHoveredBucket`, leave (relatedTarget = neighbour) → cleared,
  click → pinned, fetch button → `_fetchTxsForTpsBucket(5, 1000, 1999)`, tooltip click stopped,
  close → unpinned; tx-row copy → `_copyTpsTx(sig, el)`; timeline toggle → `toggleSlotTimeline(el)`;
  slot-modal broken icon → placeholder "E" shown flex. 0 inline handlers in each container, 0 page
  errors, 0 warnings. Cards + manage tests re-run green after the dispatcher changes.
- Progress: 57 of 322 (core 1 · cards 17 · delegation 2 · manage 21 · modals 15 + shared copy).
  Next: `js/card-details.js` (6), `js/leaderboards.js` (7), `js/skip-monitor.js` (8).
- **Wrap-up:** test harnesses committed as `scripts/c2-tests/` (cards / manage / modals + README) so
  they survive the session — run from the cloud clone with Playwright. Session 8 totals
  (2026-09-17): 4 pushes — card header squeeze; C2 batch 1 (dispatcher + card + delegation tile);
  batch 2 (manage + shared copy); batch 3 (modals + hover pair, **push + live check pending**).

### 2026-09-23 — Session 9: C2 batch 3 shipped + batch 4 (~1 hour)
- Start: 458 bot commits behind (heartbeat healthy). **Batch 3 had never been pushed** on 09-17 —
  modals.js/core.js/cards.js + `scripts/c2-tests/` were still uncommitted. Delete permission granted
  at start; stale `index.lock` / `maintenance.lock` removed; `git pull --rebase --autostash` clean.
  Re-ran the three suites in a cloud clone → green; Shaka pushed `dd3ad2e`.
- **Batch 3 live-verified** (fresh pane tab, cache-reloaded files): TPS modal 60 hit zones, hover →
  tooltip, click → pinned, × → unpinned; card Slot explorer opens (Shaka_Vibes_1, 324/324); console:
  no errors, no `[Actions]` lines.
- **Batch 4 — 28 handlers:**
  - `js/card-details.js` (6): `stake-cancel`, `stake-retry` ×2, `stake-accounts-toggle`,
    `stake-apy-period` (`data-change`), `stake-manage-classification` (stops propagation). Also fixed
    the same Lookup/Data Center id collision as 09-16 for these two: `toggleAccountsList` and
    `updateAPYDisplay` now resolve `accounts-list-<8>` / `apy-value-<8>` inside the clicked card's
    `.validator-stake-section` (before, the DC card's toggle/select changed the hidden Lookup card).
  - `js/leaderboards.js` (7): rows `lb-lookup`, logos `img-fallback`; the 7 category buttons in
    index.html → `data-action="lb-category" data-category="…"`; the `[onclick="switchLeaderboard…"]`
    selectors in `switchLeaderboard` and the Router (`js/app.js`) now use `[data-category=CSS.escape(…)]`.
  - `js/skip-monitor.js` (8): `skipmon-jump` (grid cell, feed item, top-skippers row, timeline cell),
    `skipmon-scrub` (reads the existing `data-idx`), `skipmon-toggle-top`, `skipmon-portfolio-modal`,
    `skipmon-lookup-pick`. These used `esc()` (HTML-escape) inside a JS string, so a validator name
    containing `'` broke out of the onclick — gone with the conversion.
  - Dispatcher (core.js): new `mousedown` → `data-mousedown` (the lookup pick must fire before the
    input's blur hides the list); new shared `img-remove` (skip-monitor avatars).
- Test `scripts/c2-tests/batch4-test.js` (serves skip-monitor.js with a test seam exposing its
  private state): 2 cards for one validator (toggle/select affect only their own card), 5 s slow-load
  Cancel → Retry, manage stops propagation, leaderboards stake/newest/delegations rows (0 inline,
  broken logos fall back), Router `#/leaderboard/efficient` + click highlight, skip-monitor grid/feed/
  top/timeline/scrubber/expand/scorecard head/lookup mousedown — every spy called once with the
  original args (hostile name round-trips), 0 page errors, 0 `[Actions]` warnings. Old suites re-run
  green. README: pass the repo as an absolute path — `.` made the static server 404 everything.
- Noticed: `renderTimeline()` in skip-monitor.js targets `#skipmonTimelineTrack`, which no longer
  exists in index.html — dead path (kept, converted anyway). Candidate for removal.
- **Batch 4 live-verified** (`f686736`, fresh pane tab): `#/leaderboard/efficient` highlights that
  button, category click → `#/leaderboard/stake`, 50 rows, broken logos fall back, row click → Lookup
  (#1 of 723); Stake details → accounts toggle opens/closes, APY 7 → 30-day select updates (6.86 % →
  6.88 %); Network tab: 500 grid cells, cell click opens `skipmonScorecardModal`, scrubber clicks; no
  console errors, no `[Actions]` lines. (The 10 inline `onerror`s left in that area are the
  current-leader strip in `js/network-live.js`, not converted yet.)
- **Terminal header overlap** (Shaka's screenshot, ~776 px window): under 980 px `.vt-head` goes to
  one column and puts the title and `.vt-refresh-corner` in column 1, but both still had
  `grid-row: 1`, so "Hourly snapshot · Updated … · LIVE" was drawn on top of "VALIDATOR TERMINAL"
  (phones too). Fix in `css/site.css`: inside that media query `.meta` → row 2, corner → row 3.
  Pane check at 760 and 375 px: corner now below the subtitle, no overlap, no horizontal overflow;
  > 980 px untouched. Live-verified (`418436e`, live CSS, no injected style): corner below the
  subtitle at 760 px.
- Data note: the terminal showed 146 delinquent of 723 right after the epoch 387 boundary (usually
  ~40). Probably a network event, not a site bug — worth a glance next session.
