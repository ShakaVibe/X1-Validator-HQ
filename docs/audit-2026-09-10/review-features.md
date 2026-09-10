# X1 Validator HQ — Feature Inventory & Gap Analysis

*Reviewed 2026-09-10 against `index.html` (37,572 lines), `scripts/compute-scores.js` (formula v2.1), `scripts/build-terminal-snapshot.js`, `generate-geo.js`, `data/scores.json`, HANDOVER.md and SCORING-DEPLOYMENT.md.*

---

## Part A — Feature inventory

### A.0 Site-wide plumbing (applies to every tab)

| Concern | Implementation |
|---|---|
| **Data sources** | JSON-RPC `https://rpc.mainnet.x1.xyz` (+ `wss://` for tx confirmation), REST `https://api.x1.xyz` (Terminal + Forensics only), `api.xdex.xyz` (XNT price pill), `ipwho.is` (browser-side geo fallback), `api.github.com` (`x1-labs/tachyon` releases → "latest version"), `unpkg.com` (globe.gl + world-atlas), `cdnjs` (Chart.js 4.4.1). Self-hosted `vendor/solana-web3.js-1.98.4` with SRI. |
| **RPC methods used** (count of call sites) | getEpochInfo ×26, getAccountInfo ×17, getBlockProduction ×12, getInflationReward ×11, getProgramAccounts ×10, getVoteAccounts ×7, getLeaderSchedule ×6, getBalance ×6, getBlock ×5, getClusterNodes ×3, getBlocks ×3, getRecentPerformanceSamples ×2, getSupply, getStakeActivation, getSlot, getEpochSchedule ×1 each. |
| **Published data files** (GitHub Actions) | `data/scores.json` (hourly :07, canonical scores v2.1 + per-validator raw metrics) · `data/history.json` (7-day rolling uptime/latency/root/commission events — **written but never read by the client**) · `validator-locations.json` (every 2h :21) · `data/terminal.json` (hourly :37 per HANDOVER; workflow file not present in this checkout). |
| **RPC hygiene** | `installRpcThrottle` wraps `window.fetch` for the RPC host: max 3 in flight, 5 retries on 429, 1 retry on network error, circuit breaker (6 failures → 30 s open). |
| **Header** | Logo (→ home/globe), links (X1 site, "Launch My Validator" docs, GitHub), XNT price pill (hidden until XDEX CORS-allowlists the origin; no 24h change). |
| **Shared stats bar** (all tabs) | Validators, Total Stake, Total Supply, Epoch, Slot, TPS, Active, Delinquent — from `loadNetworkStats()` (getVoteAccounts + getEpochInfo + getSlot + getClusterNodes + getSupply + identities) — and an epoch progress bar with drift-corrected time remaining (`setEpochBaseline`/`renderEpochBar`). Loaded once at page load; refreshed only on Lookup-tab entry if >5 min old, or by `refreshValidatorStakes()` when the Data Center opens. |
| **Scoring** | Canonical: `data/scores.json` fetched once per session (5-min cache-bust key); stale >3 h → fallback to in-browser **v1** formula (`calculatePerformanceBreakdown`, different weights: skip 25 %, consistency 20 %, commission 5 %, longevity 5 %, reliability 10 %). Every card/leaderboard/compare cell calls `calculatePerformanceScore` → canonical if present. |
| **localStorage keys** | `x1Portfolio` (array of vote pubkeys) · `x1SelfStakeSelections` (per-validator user classification of stake accounts self/community + `explicit` flag) · `x1SelfStakeAccounts` (legacy 7-day auto-detection cache) · `x1ValidatorPerformanceHistory` and `x1ValidatorUptimeHistory` (still **written** hourly by `recordPerformanceSnapshot`/`updateUptimeTracking`; only read by the v1 fallback formula) · `x1GeoCache` · `vtLastLoadBytes` (Terminal progress estimate) · `x1_validator_hq_disclaimer_accepted` · `x1hq_debug`. **Not persisted:** compare selection, calculator inputs, leaderboard category, active tab, Network Live scope. |
| **Global modals** | Disclaimer/Terms (gated on first visit), Browse Validators (search + paginated list, "+ Compare" / "+ Add" per row), Reward Breakdown, Stake Breakdown, Stake Classification, Performance Explainer, Slot Explorer, Skip-Monitor Scorecard, Epoch Timeline, TPS, Manage Validator (+14 transaction modals), Solana "coming soon" (**dead** — `toggleNetwork()` references `#networkToggle` which no longer exists in the DOM), wallet-install / wallet-select. |
| **Security** | CSP via `<meta>` (`unsafe-inline` required: ~300 inline handlers), frame-busting script, `escHtml/escAttrJs/safeUrl` on all on-chain strings, console silenced in prod (`?debug=1`). |
| **Not present anywhere** | Theme switch (dark only), i18n (`lang="en"`, hard-coded strings), OpenGraph/Twitter meta, deep links / URL routing (no `?validator=` or hash), service worker / push, share buttons, CSV export (except hidden Forensics), any notification channel. |

**Navigation:** 7 visible tabs. The globe "home" (`#mapTab`) is the default active tab but has **no nav button** — reachable only via the logo (`goToHome()`).

---

### A.1 Home / Globe (`#mapTab`, no nav button)

- **Shows:** 3-D globe (globe.gl, lazy-loaded; 2-D fallback when WebGL unavailable) of validator locations; sidebar "Validators by Country" with counts; "X of Y validators located" chip; rotate/pause button; click-country-to-fly.
- **Data:** `validator-locations.json` (built every 2 h by `generate-geo.js` from getClusterNodes gossip IPs → geo API) with in-browser fallback: getClusterNodes + `ipwho.is` batch geolocation, cached in `x1GeoCache`. Header counts from `loadNetworkStats`.
- **Actions:** rotate toggle, drag/zoom, click country → filter. Tooltip per point (validator name/count).
- **Persisted:** `x1GeoCache`.
- **Notes:** The Leader Schedule section that used to live here moved to Network Live (comment at 12045). Globe is purely informational — no click-through from a point to the validator's lookup card.

---

### A.2 Network Live (`#skipmonitorTab`, nav "Network") — live leader-slot / skip monitor

- **Shows**
  - TPS strip (past 60 min sparkline, current, avg, peak, trend) → expandable **TPS modal** (12 h, axis ticks, current/avg/median/peak/low/total tx cards, hover a bar → fetches that bucket's block signatures via getBlocks/getBlock and lists txs with copy).
  - **Leader schedule bar**: current leader (logo, name, slot, "Block n of 4" dots) + next leaders list; updated every 2 s via getEpochInfo + cached getLeaderSchedule (`updateCurrentLeader`).
  - **Scope switch**: 🌐 Network / 🖥️ My Validators (portfolio) / 🔍 Validator Lookup (typeahead search).
  - Pulse row: clean streak, last skip, live-vs-hour trend.
  - Stat cards: current slot, skip rate live (~10 min rolling), last hour, this epoch vs previous epoch (+ "Past ↗" link → **Epoch Timeline modal**: network skip rate for last 6 completed epochs + current, from getBlockProduction ranges).
  - Network mode: **Recent Slots grid** (last 1,500 slots, produced/skipped cells, hover details, click → validator), 100-bucket **scrubber**, **Live Skip Feed** (last 120 skip events), **Top Skippers · This Epoch** table (expandable).
  - Portfolio/Lookup mode: per-validator **scorecards** with current + previous epoch panels (assigned / produced / skipped / skip-rate, produced-vs-skipped bar, slot strip, "Next leader in" countdown + slot #, elapsed), delinquent badge; card header → **Slot Explorer modal** (Current / Last / Both epochs; per-slot leader-window visualization, getBlockProduction + getLeaderSchedule + getBlocks).
- **Data:** poll every 3 s: getEpochInfo → getBlocks(range, 12-slot confirm lag, ≤500/call) diffed against getLeaderSchedule; hour aggregate every 30 s and epoch aggregate every 60 s via getBlockProduction; per-identity getBlockProduction backfill for portfolio validators when bulk response is truncated (iPad Safari workaround); previous-epoch leader schedule via getLeaderSchedule(slot). Only polls while the tab is active (`SkipMonitor.start/stop`).
- **Actions:** scope buttons, lookup search, scrubber click, grid cell click (→ scorecard modal), top-skippers expand, epoch timeline modal, TPS modal (bar hover/pin, tx copy), Slot Explorer pills.
- **Persisted:** nothing (state kept in memory across tab switches only).
- **Notes:** This is the closest thing to a "health" view. It shows skips but has no thresholds, no alerting, no sound/badge, no history beyond ~10 min of slots + 7 epochs of aggregates. Portfolio scope needs the Data Center list; nothing surfaces delinquency/version/commission changes here.

---

### A.3 Validator Terminal (`#vtterminalTab`)

- **Shows:** Bloomberg-style table of all validators (724) sorted by direct ("self") stake: #, vote, identity, name (+ `X1` tag for `x1Labs` foundation-operated nodes), commission, status (OK/DLQ/INA), activated XNT, Self XNT (bar), #Self accounts, biggest self account, Foundation XNT, #Fnd, Self %, version, country. KPI grid: total activated, foundation-pool stake, self-stake (non-X1), X1 Labs all stakes, mean self-stake, top versions (+ distinct version count). Self-stake percentile row (P50…P99, max). Header shows source (hourly snapshot vs live) and generated time. Shared stats bar is DOM-moved into this tab.
- **Data:** `data/terminal.json` snapshot first (same origin, ~0.7 MB; fields: votePubkey, nodePubkey, name, version, commission, activatedStake, delinquent, active, country, x1Labs + per-stake `[stakePubkey, amount, delegatedStake, status, stakePool]`), else live `api.x1.xyz` `/v1/cluster`, `/v1/validators`, `/v1/stakes?includeInactive=true` (≈13 MB, streamed with progress, stall-abort, 3 retries, offset 0 + 5000 pagination). Auto-refresh hourly; failed refresh keeps table + amber banner.
- **Actions:** text filter (`/` focuses), status segment (ALL / CURRENT / DELINQ / X1 LABS / NON-X1), sortable columns, Reset, **Live** button (forces API fetch), row hover tooltip listing the validator's stake accounts, `Esc` closes. Faint **dot** left of "Generated" opens the hidden **Validator Forensics** tool (see A.9).
- **Persisted:** `vtLastLoadBytes`.
- **Definitions used here:** *foundation* = `stakePool ≠ null`; *self* = **all direct (non-pool) delegations, including third-party direct stakers**. This is a different definition of "self-stake" from the Lookup/Data Center cards (see inconsistencies).
- **Notes:** The API exposes far richer per-validator fields (skipRateLast10Epochs, voteCreditsPreviousEpoch, blockRewardsLast10Epochs, verifiedSelfStake*, avgVoteLatency*, stakeDelegations, geoLocation, iconUrl, website) but the snapshot keeps only 10 of them and the table shows none of the performance/reward fields.

---

### A.4 Validator Lookup (`#lookupTab`)

- **Shows:** Search by name / vote account / identity (typeahead from `allValidators`, scored name matching; pubkey pastes resolve identity→vote; falls back to a "zombie" fetch via getAccountInfo for delinquent zero-stake vote accounts hidden from getVoteAccounts). Results rendered as full **validator cards**:
  - Header: logo, name, stake-tier badge (Top 10/20/30 % by stake), rank "#n of N", vote address + copy, version badge with "⚠️ Update Available", chip strip (**⏱ next-leader countdown** live per second + **🔍 Slot Explorer**), status badge, "+ Add" (to Data Center), **⚙️ Manage Validator**.
  - Stats: Rewards Balance (vote-account balance), **Last Epoch Earned** (vote commission + self-stake inflation rewards, ↑/↓ % vs prior epoch, "Breakdown" link → **Reward Breakdown modal**: voting reward vs self-stake reward vs delegator share for newest indexed epoch), Active Stake (click → **Classify** modal), Epoch Credits (+ **credit-pace badge**: earned-so-far vs network avg at current epoch progress, ≥92 % = ON TRACK), Commission, Skip Rate (7-epoch slot-weighted avg / this epoch / last epoch fallback), **Performance (7D)** score bar (click → **Performance Explainer modal**: per-component breakdown with weights and details, "📡 Official published score" stamp, commission-rug flag, formula documentation, and **"Ask Claude to Help Optimize My Validator"** which opens claude.ai with a prefilled prompt).
  - Expanders: **Stake Details** (getProgramAccounts memcmp offset 124 → self vs delegated pie with min-visual threshold, per-account list with pubkey/amount/type, detection-method note, derived base APY & validator effective APY, historical-APY period selector, cancel/retry on slow RPC) and **View Earnings Trend** (Chart.js; XNT rewards per epoch — up to 30 × getInflationReward per validator — or epoch credits; last/avg/peak).
- **Data:** getVoteAccounts (cached list), getBalance, getAccountInfo(jsonParsed) for extended epochCredits (64 epochs), getBlockProduction (current + 7 past epochs for skip history), getInflationReward, getProgramAccounts(Stake, memcmp 124), getLeaderSchedule (countdown), `data/scores.json`.
- **Persisted:** `x1SelfStakeSelections` (classification), `x1SelfStakeAccounts`, performance/uptime history (written, unused).
- **Manage Validator modal** (wallet-gated; X1 Wallet, Phantom, Solflare, Backpack, generic `window.solana`): account picker (vote account + every stake account delegated to the validator, authority badges legend, refresh), details grid (balance, staked/liquid, **cooldown progress card** with cooled/cooling amounts and per-epoch popover, withdraw/stake/vote authorities, identity balance, commission, credits), and action groups — Wallet: Create & Delegate Stake, Send XNT to ID wallet · Validator: Withdraw XNT, Change Commission, Update Identity (name/website/icon preview), Change Authority (with danger confirm) · Stake: Delegate/Redelegate (validator picker), Undelegate, Split, Merge, Withdraw from Stake, Close Stake Account, Set Stake Authority, Set Withdraw Authority. Each has a modal with balance/fee summary, priority-fee refresh, rebroadcast + WebSocket confirm fallback, explorer link; locked actions open an **Action Explainer**.
- **Notes:** "Ask Claude" is the only "coach" — it's an off-site prompt, not an in-app recommendation. No URL for a card (nothing to share). The `?` performance breakdown reads the live canonical JSON, but the card's Skip Rate cell uses client-side getBlockProduction — two sources for the same number.

---

### A.5 My Data Center (`#portfolioTab`, "Track all your validators in one place")

- **Shows:** Summary: Total Stake, Total Rewards (sum of vote-account balances — label "Total Rewards" is really *withdrawable balance*), Rewards Last Epoch (newest epoch where every validator is indexed, else partial "n/N indexed"), Avg Performance (7D), Active n/N. Buttons: **Combined Stake Details** (four-bucket breakdown per validator and portfolio: foundation / ripper / self / community, portfolio APY, earnings estimate) and **View Combined Earnings Trend** (multi-series Chart.js, XNT rewards or credits, per-validator legend/colour). Then one full validator card per validator (same as Lookup, with "Remove" instead of "+ Add"), sorted alphabetically.
- **Data:** same as Lookup, fanned out in parallel per validator; `refreshValidatorStakes()` (single getVoteAccounts) if list >30 s old.
- **Actions:** + Add Validator (Browse modal), ↻ Refresh (clears cache), Clear All (confirm), per-card Remove, everything from A.4.
- **Persisted:** `x1Portfolio`.
- **Notes:** No grouping/tags, no per-validator notes/labels, no export, no "what changed since last visit", no alerts. Portfolio is device-local — no sync/share/import (a 20-validator operator on two devices maintains two lists). Nothing here shows version lag or commission drift across the fleet at a glance beyond the per-card badges.

---

### A.6 Leaderboards (`#leaderboardTab`)

Loading pipeline: validators → batch getAccountInfo for full epoch credits (`fetchAllExtendedEpochCreditsBatch`) → skip history from `scores.json` (else 7 × getBlockProduction) → score. Each list = **top 50**, click row → Lookup. Header carries the "📡 Official scores · updated hh:mm" stamp.

| Category | Ranking rule | Filters |
|---|---|---|
| ⭐ Top Performance | canonical score desc | score > 0 |
| 💰 Most Stake | activatedStake desc | — |
| 🏷️ Lowest Commission | commission asc | active, stake > 10,000 XNT |
| 🎯 Most Efficient | avg credits (7 completed epochs) per 1 M XNT stake, desc | active, stake > 1,000 XNT |
| 🛡️ Most Reliable | uptimePct (canonical) desc → confidence-adjusted skip rate asc → score | active, has skip data, stake > 10,000 XNT |
| 🆕 Newest | first epoch in credit history desc, grouped This epoch / Last epoch / Recent | active; top 50 |
| 🤝 Delegations | stake delegated by the X1 Labs authority (`uXgz…vM31`) and Ripper Pool (`AZhR…PWBk`), source segment Both / X1 Labs / Ripper Pool; summary totals + per-row X1/Ripper/Total | getProgramAccounts memcmp offset 12 (staker), dataSize 200, excludes deactivating |

- **Persisted:** nothing (category resets to Performance).
- **Notes:** No "where am I" — a portfolio validator isn't highlighted and there is no rank-of-N for validators outside the top 50. No search/filter/pagination, no rank deltas vs last hour/epoch.

---

### A.7 Compare (`#compareTab`)

- **Shows:** up to 4 slots (logo, name, score) and a metric table with best-value highlighting: Performance Score, Commission, Last Epoch Earned, Skip Rate (7d avg), Epoch Credits, Total Stake, Rewards Balance, Status, Version, First Seen.
- **Data:** `getValidatorInfo` + `fetchTotalValidatorRewards(…, 3 epochs)` per validator.
- **Actions:** typeahead search, Browse All (modal in compare mode), remove per slot, Clear All.
- **Persisted:** nothing — selection lost on reload; no shareable URL.
- **Notes:** No radar/visual, no per-component score comparison (the breakdown is available in `scores.json` but not shown), no rewards-history overlay. `Total Stake` guesses units with a `> 1e9 → lamports` heuristic.

---

### A.8 Calculators (`#calculatorsTab`)

| Calculator | Inputs | Data | Output |
|---|---|---|---|
| 💰 **Staking Rewards** | validator from Data Center **or** custom (self-stake, delegated, commission), estimated APY (custom mode), XNT price, "Simulate growth" add self-stake / add delegation | live self vs delegated split via getProgramAccounts (withdrawer match or user classification; uses `account.lamports`, i.e. includes rent/undelegated), real 7-epoch rewards when available, `epochsPerYear()` from live slotsInEpoch | current vs simulated earnings per epoch / month / year, XNT ↔ USD toggle |
| 🔄 **Compound Growth** | validator or custom initial stake + APY, frequency (daily…yearly), 1–20 years | validator's derived APY from rewards | growth table + Chart.js curve |
| ⏱️ **Unstaking Timeline** | amount, when (now / next / specific epoch), observed cooldown rate slider 5–100 % (presets 100/50/25 %) | getEpochInfo (refresh button) | visual timeline, summary, per-epoch breakdown, explainer of the 25 %-of-active-stake network limit |
| 💸 **Break-Even** | validator, operating cost (USD/XNT, monthly/yearly), XNT price | 7-epoch real rewards → real APY | monthly/yearly profit, margin, break-even XNT price |

- **Persisted:** nothing. XNT price defaults to `1.00` and is **not wired to the header price pill**.

---

### A.9 Hidden: Validator Forensics (`#vpOverlay`, opened via the dot in the Terminal footer)

- **Purpose:** "hardware & fleet analysis" — flags VPS farms / sybil fleets. Runs a read-only probe over the last 5–60 completed epochs.
- **Data:** getVoteAccounts, getClusterNodes (IPs → shared IP / /24 / /16 grouping), getAccountInfo epochCredits (vote-efficiency trajectory), getLeaderSchedule + getBlocks + getBlock (leader-window benchmark: slot-1 fumbles, block fill, timing), live lastVote/rootSlot lag sampler (10 s), api.x1.xyz `/v1/stakes` for self-stake, epoch-boundary stress.
- **Output:** verdict text, stat grid, "hardware signal map" scatter (Chart.js), top-suspects list, sortable table with risk pill tooltips (noisy-OR "Farmer risk v4"), filters (hide delinquent, min self-stake, text), **Download CSV**, re-scan / re-bench / live-watch buttons.
- **Notes:** Unlisted, undocumented in HANDOVER, heavy on RPC. Contains the only CSV export in the product and the only live vote-lag sampler in the client.

---

### A.10 Inconsistencies, half-finished and dead items

1. **"Self-stake" has three definitions.** Terminal: all non-pool direct delegations (incl. third-party stakers). Lookup/Data Center/Calculators: stake accounts whose *withdrawer* equals the vote account's withdrawer, or user overrides. Delegations leaderboard: identifies pool stake by *staker* authority at offset 12; `classifyStakeSource` identifies it by *withdrawer*. `api.x1.xyz` also exposes `verifiedSelfStake*` which none of the tabs use.
2. **"X1 Labs" means two things.** Terminal `x1Labs` flag = foundation-*operated* validators (excluded from non-X1 stats). Delegations leaderboard "X1 Labs" = stake *delegated by* the foundation authority to community validators.
3. **"Latest version" computed two ways.** Client: GitHub releases of `x1-labs/tachyon` with hard-coded floor `MINIMUM_KNOWN_VERSION = '2.2.20'` (stale — network is on 3.1.14). Server (`compute-scores.js`): highest semver run by ≥3 nodes. The card badge and the score's Software component can disagree.
4. **Skip rate shown vs scored.** Card cell and Compare use raw 7-epoch avg from client getBlockProduction; canonical score uses confidence-adjusted rate from the Action; Network Live uses a getBlocks diff. Three numbers can be on screen simultaneously.
5. **Fallback formula v1 ≠ published v2.** When `scores.json` is >3 h stale the site silently switches to a formula with different weights (commission/longevity/reliability scored) — the explainer text still describes v2.
6. **localStorage perf/uptime history** is still written every hour (`recordPerformanceSnapshot`, `updateUptimeTracking`) but only the v1 fallback reads it. Dead weight (and grows unbounded except a `cleanupOldHistory` pass).
7. **Dead code:** `toggleNetwork()` / Solana "coming soon" modal have no toggle element in the DOM; `REWARDS_API_URL = null` and `fetchRewardsHistory()` (an external rewards tracker that never shipped); `calculatePerformanceScore_LEGACY`; `fetchLastEpochForCards` superseded by streaming fill.
8. **`data/history.json`** (uptime/latency/root/commission events, 7-day) is produced hourly but nothing on the site reads it — the raw material for per-validator charts and a commission-change feed already exists.
9. **Home tab unreachable from nav.** The globe is default-on-load but disappears from navigation after any tab click; only the logo returns to it.
10. **Data Center "Total Rewards"** label is the vote-account balance sum, not earned rewards.
11. **XNT price** is live in the header but the calculators default to $1.00 with no link.
12. **Workflow drift:** HANDOVER lists three workflows; this checkout has `update-scores.yml` and `update-geo-data.yml` only. `_headers` sets no-cache for `validator-locations.json` only — `data/*.json` rely on the `?t=` key.
13. **`add-stake-btn`** in Manage is `disabled title="Coming soon"`.
14. Terminal snapshot drops `iconUrl`, `website`, `geoLocation`, and all performance/reward fields the API provides.

---

## Part B — Gap analysis for the 1–20-validator operator

Target jobs: (a) know instantly if something is wrong · (b) understand and improve score / ranking / delegation · (c) track rewards and economics · (d) compare against peers · (e) share standing.

What the site does well today: the canonical hourly score with a transparent breakdown, a live skip monitor with portfolio scope, full on-chain management via wallet, honest reward attribution (vote + self-stake), and a solid economics starting point (calculators, breakdowns). What it lacks is *memory* (history), *push* (alerts), *addressability* (URLs, embeds, API), and *guidance* (what to change).

### B.1 Top 10 — must build (priority order)

| # | Capability | Why it matters | Data source | Effort | Type |
|---|---|---|---|---|---|
| **1** | **Alerting: delinquency, skip-rate spike, version lag, commission change, stake drop, score drop** — Telegram bot + Discord webhook, optional browser push / email. Configure per validator (Data Center) with thresholds; server evaluates each hourly run and on a lighter 5-min "heartbeat" job (getVoteAccounts only). | Job (a). Operators currently learn about delinquency from delegators or from opening the site. Every serious Solana tool (validators.app, stakewiz, svt.one) ships alerts; it is table stakes and the #1 retention driver. | Hourly Action already has everything (`compute-scores.js` sees delinquent/version/commission/skip). Add a `data/alerts/` state file + a tiny subscription store (Cloudflare Worker KV or a GitHub-hosted form → issue; simplest: Telegram bot where the operator sends `/watch <vote>`; Discord webhook URL entered in-site and stored… server-side, not localStorage). New 5-min workflow calling only getVoteAccounts + getClusterNodes. | **L** (M if Telegram-only) | Table stakes |
| **2** | **Per-validator history charts (stake, credits, skip rate, vote latency, uptime, score) over epochs/days** in the card and on a profile page. | Job (b),(c),(d). "Is this getting better or worse?" is unanswerable today beyond 7 epochs of credits. `data/history.json` already holds 7-day latency/uptime/root; extend the Action to append a compact per-epoch row (stake, credits, skip, score, commission, version) to `data/history/<vote>.json` or a single columnar `data/epochs.json`. api.x1.xyz `blockRewardsLast10Epochs`, `skipRateLast10Epochs` fill the gap immediately. | Action + `history.json` + api.x1.xyz per-validator arrays; client Chart.js (already loaded). | **M** | Table stakes |
| **3** | **Rewards ledger with CSV export** — per validator and portfolio-wide: epoch, date, vote (commission) reward, self-stake reward, delegator payout, XNT price at epoch end, USD value; cumulative totals; download CSV/JSON. | Job (c). Operators need this for accounting and for break-even. The data is already fetched (`fetchTotalValidatorRewards`) but only charted and never exportable. Price series can be stored hourly by the Action from XDEX. | getInflationReward (client) or precomputed server-side (`data/rewards/<vote>.json`, cheaper than 30 RPCs per card), XDEX price (Action). | **M** | Table stakes |
| **4** | **Score coach: "what to change to gain N points"** — for each component show current value, the anchor to the next tier, the point gain, and a concrete action ("upgrade 3.1.12 → 3.1.14: +3.0 pts", "vote latency 3.4 slots → <2.5: +0.9 pts; check `--use-snapshot-archives-at-startup`, NTP, disk"). Rank impact preview ("would move you from #61 to #44"). | Job (b). The breakdown already exposes each component's raw value and `compute-scores.js` has the exact `interp()` anchor tables — the client can replicate them from `scores.json` alone. Replaces the off-site "Ask Claude" link with something actionable in-app. | `data/scores.json` breakdown + anchor tables (publish them in the JSON so the client never drifts). | **S–M** | Differentiator |
| **5** | **Public validator profile URLs + share card** — `/#/v/<vote>` (hash router in the SPA) and a static `/v/<vote>.html` per validator generated by the Action with OpenGraph tags and an SVG/PNG score card (rank, score, skip, uptime, commission). "Copy link / Share on X" on every card; embeddable badge `<img src="…/badge/<vote>.svg">`. | Job (e) and growth: today nothing on the site is linkable — an operator cannot show delegators their standing. Static generation on GitHub Pages is free. | Action renders from `scores.json` + identities (name, icon). | **M** | Differentiator (table stakes on Solana) |
| **6** | **Delegation-program eligibility checker** — a checklist per validator against the X1 Foundation delegation criteria (self-stake threshold, commission cap, skip/uptime/version, verified self-stake, geographic/ASN concentration if applicable) with pass/fail and "you would receive X" estimate; portfolio view showing which validators currently hold foundation stake and how much. | Job (b): delegation is the main lever for a small operator's income. The Delegations leaderboard shows who *has* it; nobody can see *why* or how to qualify. | api.x1.xyz `/v1/validators` (verifiedSelfStake*, selfStakeCurrentEpoch, avgVoteLatency*), `/v1/stakes` stakePool, `scores.json`. Criteria need confirming with X1 Labs and stored as a versioned JSON so they can change without code. | **M** | Differentiator |
| **7** | **Fleet health board in Data Center** — one dense table row per validator: status, version vs latest, commission (+ change indicator), stake Δ epoch, skip (epoch / 7-epoch), vote lag, root distance, uptime %, score & rank Δ, next leader slot, last reward. Colour thresholds, sortable, "issues first". Complements (not replaces) the cards. | Job (a),(d). A 20-validator operator can't scan 20 tall cards; today no single view answers "is everything OK". All numbers already exist in `scores.json` + getVoteAccounts. | `scores.json`, getVoteAccounts, getLeaderSchedule (cached). | **S–M** | Table stakes |
| **8** | **Version-upgrade tracker + release feed** — % of validators and % of stake on each version, "latest" (GitHub release) with release date and notes link, adoption curve, list of laggards; per-validator "you are N releases behind". Unify the two "latest version" definitions. | Job (a),(b). Version is 5 % of the score and the most common cause of "why did my score drop". Cluster-wide adoption is the signal operators use to decide *when* to upgrade. | getClusterNodes (already), GitHub releases (already), Action stores daily counts for the curve. | **S** | Table stakes |
| **9** | **Change feeds: commission changes, stake flow (gained/lost per epoch, top inflows/outflows, foundation delegations added/removed), new & churned validators, delinquency events** — one "Network Activity" panel with filters and per-validator entries on the profile. | Job (a),(d). `history.json` already records commission events; stake deltas are one subtraction per hourly run. Powers alerts (#1) and the share card. | Action diffing consecutive runs (`getVoteAccounts`, `history.commission`), persisted to `data/events.json` (rolling 30 d). | **M** | Differentiator |
| **10** | **Public JSON API + data status page** — document and stabilise `data/scores.json`, add `data/validators.json` (merged identity + score + api fields), `data/events.json`, per-validator `data/v/<vote>.json`, with schema, version, CORS (Pages already allows) and a `/status` page showing each pipeline's last run, age, row counts, RPC latency, and whether the client is on fallback scoring. | Job (b),(e) and ecosystem: lets other tools, bots and the X1 Foundation consume the canonical score; the status page also answers "is the site's data stale" which today is a console warning. | Existing Actions + a `data/status.json` written by each run. | **S** | Differentiator |

### B.2 Nice to have

| Capability | Why | Data / effort |
|---|---|---|
| **Leader-schedule / upcoming-slots view** for portfolio: timeline of the next N leader windows across all my validators with countdowns and calendar/ICS export; "quiet windows" for maintenance. | Operators time restarts/upgrades between leader slots. The countdown chip exists; a timeline is a rendering change. | getLeaderSchedule (cached) · **S** |
| **RPC / node health check** — paste your own RPC URL (or gossip IP): compare slot height vs public RPC, `getHealth`, version, identity, vote-account match, TPU/gossip reachability (limited by CORS; server-side prober via Action or a small Worker is more reliable). | Job (a): "is *my* node the problem or the network". | getSlot/getHealth/getVersion/getIdentity on user URL · **S** client-only, **M** with server prober |
| **Peer benchmarking on the card** — percentile bands for each score component ("your vote latency is p78 of the network"), and a Compare radar of the 7 components. | Job (d). All raw values are in `scores.json`. | **S** |
| **Rank & score deltas** everywhere (Δ vs last hour / last epoch), "my validators" highlighted in leaderboards, full ranked list with search instead of top-50. | Job (b),(d). | Action keeps previous run's ranks · **S** |
| **Portfolio sync / import / export** — export Data Center as JSON, import, share via URL (`#/portfolio=<votes>`), optional wallet-derived portfolio (validators whose withdraw authority = connected wallet). | Job (a) for multi-device operators; wallet detection also fixes the self-stake ambiguity. | localStorage + URL · **S** |
| **Wire the live XNT price into calculators**; add 24h change from XDEX history; USD in reward summaries. | Job (c). | **S** |
| **Unstake / cooldown tracker** tied to real stake accounts (already computed inside Manage) surfaced in the Data Center summary with ETA per account. | Job (c). | reuse `getStakeCooldownInfo` · **S** |
| **Unify self-stake definition** — adopt api.x1.xyz `verifiedSelfStake*` (or the vote-withdrawer rule) everywhere, label the Terminal column "Direct stake" and show a separate "Verified self" column. | Credibility — currently three tabs give three numbers. | **S** |
| **Light theme + system preference**, and a compact/dense mode. | Broad audience expectation; also needed for embeds/share cards on light backgrounds. | CSS tokens already exist (`:root` vars) · **M** (large CSS surface) |
| **Multi-language** (i18n scaffolding; start with zh, ru, es, de given validator geography from the globe). | Reach. Requires string extraction across ~37k lines. | **L** |
| **Delegator-side view** — enter a wallet, see all its stake accounts, rewards, and the validator's health — reuses Manage's stake fetch. | Grows traffic from delegators, who are the audience for share cards. | getProgramAccounts by staker · **M** |
| **Forensics tool: decide** — either surface it (with a plainer "Fleet & hardware analysis" name, caveats, rate limits) or remove it. Its live lag sampler and CSV export are useful building blocks for #2/#3. | Hidden features are maintenance liabilities. | **S** |
| **Housekeeping** — remove dead Solana toggle, `REWARDS_API_URL`, legacy formula, unused localStorage writers; put the globe back in nav; fix "Total Rewards" label; add OG meta; make `MINIMUM_KNOWN_VERSION` come from data. | Reduces confusion when the above ships. | **S** |
| **PWA / installable + offline shell** with cached last snapshot; badge count of alerts. | Complements #1 on mobile. | **M** |
| **Split index.html into modules and a build step** (or at least separate files served as-is). | Every item above adds to a 1.5 MB single file; alerting and profiles need server-side code anyway. | **L** (pays for itself) |

### B.3 Suggested sequencing

1. **Week 1–2:** #10 status/API skeleton + #8 version tracker + #7 fleet board (all read `scores.json`; establish the `data/` contract).
2. **Week 3–4:** #2 history (extend the Action; add per-epoch rows) + #9 event feeds (same diff pass) → these feed everything else.
3. **Week 5–6:** #1 alerts (Telegram first, Discord webhook second) on top of the event feed.
4. **Week 7–8:** #5 profiles + share cards, #4 score coach, #6 eligibility checker.
5. Then #3 rewards ledger/CSV and the nice-to-haves.
