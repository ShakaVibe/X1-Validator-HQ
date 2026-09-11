# X1 Validator HQ — Session Handover

> **How to use this file:** at the start of a new chat, attach this file and say
> "here's the handover, let's continue." Claude reads it, asks you to link the `X1VHQ`
> folder (Add folder → `Desktop/X1VHQ`), runs `git pull`, and picks up from §5.
> At the **end of every session** Claude updates the Session Log, the To-Do list and any
> notes below, so this file is always the single source of truth.

> **Start here next session (as of 2026-09-11 evening):**
> 1. `cd ~/Desktop/X1VHQ && git pull` — three bots commit hourly.
> 2. Verify the power-saver push on the live site: open the console, run
>    `PowerSaver.forceIdle(true)` → amber "Live updates paused" pill appears, globe stops,
>    Network-tab RPC drops to ~1/min; `PowerSaver.forceIdle(false)` restores. Also confirm the
>    globe rests ~60 s after load and wakes on drag.
> 3. Next build, in Shaka's priority order: **Fleet health board (F4)** → **History charts (F2)**
>    → **Alerts (F3, design first)**. Roadmap artifact: "X1 Validator HQ Roadmap".
> 4. Card redesign is shelved; Shaka liked the "as Apple would" mockup on the site palette
>    (light-weight tiles + settings-style chevron list + segmented control) — revisit only with
>    his go-ahead. Rule: per-validator data goes in the stat grid with a Details link.
> 5. Housekeeping: `_to_delete/` (patch scripts) and `Claude outputs/` (mockup PNGs) are
>    gitignored folders in the repo dir — safe to delete.

---

## 1. Project at a glance

| | |
|---|---|
| **Site** | https://x1valhq.xyz (GitHub Pages, custom domain via `CNAME`) |
| **Repo** | https://github.com/ShakaVibe/X1-Validator-HQ (branch `main`) |
| **Local copy** | `~/Desktop/X1VHQ` on Joseph's Mac Studio |
| **What it is** | Single-page dashboard + validator management tool for the X1 blockchain: Network, Validator Terminal, Validator Lookup, My Data Center (portfolio), Leaderboards, Compare, Calculators |
| **Stack** | One big `index.html` (~37k lines, HTML+CSS+JS, no build step), vendored `@solana/web3.js`, two GitHub Actions that commit data files hourly |
| **Owner** | Shaka (ShakaVibe) — josephbmuench@gmail.com |

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
index.html                    the whole site (all tabs, all JS)
data/scores.json              canonical validator scores — written hourly by Action
data/history.json             7-day rolling history behind the scores
validator-locations.json      geo data — written every 2h by Action
data/terminal.json            Validator Terminal snapshot — written hourly by Action (added 2026-09-10)
data/delegation.json          Delegation Program snapshot — same Action, same commit (added 2026-09-10)
scripts/build-delegation-snapshot.js  builds data/delegation.json from api.delegation.mainnet.x1.xyz
scripts/build-terminal-snapshot.js  builds data/terminal.json from api.x1.xyz
scripts/compute-scores.js     score generator (Node 20, zero deps)
scripts/test-compute-scores.js  mock-RPC tests for the above
generate-geo.js               geo updater run by the Action
.github/workflows/update-scores.yml     hourly, minute :07  (commits data/*.json)
.github/workflows/update-geo-data.yml   every 2h, minute :21 (commits validator-locations.json)
.github/workflows/update-terminal-snapshot.yml  hourly, minute :37 (commits data/terminal.json)
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
  `api.github.com`. CSP `connect-src` in `index.html` (~line 87) must list any new host.
- **RPC throttle + circuit breaker** (`installRpcThrottle`, ~line 14949): wraps `window.fetch`
  for the RPC URL only — max 3 in flight, retry on 429, breaker trips after 6 network failures
  for 30s. The public RPC returns 429 *without CORS headers*, which the browser reports as a
  bare "Failed to fetch".
- **api.x1.xyz payloads are uncompressed and large** (measured 2026-09-10):
  `/v1/stakes?includeInactive=true` ≈ 11 MB (7,406 rows), `/v1/validators` ≈ 2 MB (724 rows).
  No `Content-Encoding`, no `Cache-Control`. `offset` is capped at 5000 (400 above that).
  The API allowed 8 parallel `/v1/cluster` calls with no 429.
- **Validator Terminal module** starts at the `// VALIDATOR TERMINAL — client-side module`
  banner (~line 34670). It is an IIFE exposing `window.vtOpen / vtClose / vtRetry / vtRefreshLive`.
  Data source order: `data/terminal.json` snapshot (hourly, same origin) → live api.x1.xyz.
- **Scores** are canonical (computed server-side by the Action) with an in-browser fallback if
  `data/scores.json` is missing or >3h stale — see `SCORING-DEPLOYMENT.md`.

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
- [x] **P2** partial 2026-09-10 — leader schedule lazy (R6), TPS light poll (P8), fonts non-blocking (P4). Still open: sessionStorage cache for identities/supply, fast-path stats bar.

### Phase 2 — weeks 5–8 (memory + push)
- [ ] **F2** per-validator history charts (`history.json` + api.x1.xyz `*Last10Epochs`)
- [ ] **F3** Telegram alerts (5-min heartbeat workflow + `/watch <vote>` bot), then Discord webhook
- [ ] **F6** score coach ("+3.0 if you upgrade"); publish `interp()` anchors in scores.json
- [ ] **F5** public profile pages + OG share cards generated by the Action
- [ ] **F8** rewards ledger + CSV; **F9** change feeds; **F11** APR per validator

### Phase 3 — ongoing (platform)
- [ ] **C1** split `index.html` (css + core + per-tab files, plain `<script src>`)
- [ ] **C2** replace 254 inline `onclick` with delegated listeners → drop `unsafe-inline`
- [ ] **C3/C4** single RPC transport; normalise records at ingestion
- [ ] **P6/D5** PWA shell, light theme; **C8** public changelog

### Open small items
- [ ] `_to_delete/` in the repo folder holds the Python patch scripts from session 1 (gitignored);
      Shaka can delete the folder any time.
- [ ] Ask people who reported the terminal error which device/network they were on.

### Done
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
    "Where am I" rank for validators outside the top 50 still open.
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
