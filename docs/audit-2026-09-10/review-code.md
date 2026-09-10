# X1 Validator HQ — Deep Code Review

Scope: `index.html` (37,572 lines / 1.47 MB, ~315 KB gzipped), `scripts/compute-scores.js`, `scripts/build-terminal-snapshot.js`, `generate-geo.js`, `.github/workflows/*.yml`. The Validator Terminal module (lines 34671–35585) was excluded except where it interacts with shared code. Every finding below was verified by reading the cited lines; line numbers refer to `index.html` unless stated otherwise.

Severity legend: **Critical** (exploitable / money-adjacent), **High** (user-visible breakage or serious resource waste), **Medium**, **Low**. Effort: S (< 1 h), M (half day), L (day+).

---

## 3. Security / CSP (listed first — these are the ones to fix today)

The CSP comment (lines 45–49) says the XSS path is "closed upstream by escaping all on-chain data before it reaches the DOM". That is not true. Validator `name`, `iconUrl` and `keybaseUsername` are read raw from the Config program (`fetchValidatorIdentities`, 15777–15852) and flow into the DOM unescaped in several places. Because this page also builds and signs stake/withdraw transactions with the user's wallet, any XSS here is a wallet-drain vector.

**S1. `safeUrl()` never HTML-escapes, so any `https://…"` icon URL breaks out of `src="…"`** — Critical — S — 14775–14784; sinks 17472, 17955, 20002, 20121, 22081, 23196, 31258, and 22350 (no `safeUrl` at all).
`safeUrl` only checks the scheme prefix and returns the string untouched: `if (/^https?:\/\//i.test(v)) return v;`. A validator that publishes `iconUrl = https://x/"><img src=x onerror=…>` executes script in every visitor who renders its card (lookup, portfolio, compare, leader strip). The Terminal and SkipMonitor already do `safeUrl(esc(...))`; the main app does not. Fix: make `safeUrl` return `escHtml(v)` (or `''`) so every existing call site is fixed at once.

**S2. `escAttrJs()` is bypassable with HTML character references** — Critical — S — 14763–14774; sinks 17596, 17626, 17665, 22388, 29270.
It escapes `\ ' " < >` but not `&`. Inside `onclick="fn('${escAttrJs(name)}')"` the HTML parser decodes `&#39;` → `'` before the JS runs, so a name of `x&#39;);alert(1);//` closes the JS string. Fix: `.replace(/&/g,'&amp;')` as the *first* replacement — and longer-term, stop building inline handlers from data (use `data-*` + delegated listeners).

**S3. Raw `iconUrl` inside an `onclick` JS string** — Critical — S — 17626.
`onclick="openManageValidator('${validator.voteAccount}', '${escAttrJs(validator.name)}', …, '${validator.iconUrl || ''}')"` — the last argument is not escaped at all; `iconUrl = x');alert(1);('` runs on click of "Manage Validator". Same fix as S2 (and S1 to sanitise at ingestion).

**S4. Raw validator name inside `onclick` in the Staking calculator** — Critical — S — 20683, 20691.
`onclick="openStakeBreakdown('${validatorSelect.value}', '${validatorName}', …)"` where `validatorName` comes from `validatorInfoCache[...].name` / `allValidators[...].name` (20634–20642). Wrap with `escAttrJs` (after S2) or pass only the vote pubkey and look the name up inside the handler.

**S5. Raw names inserted via `innerHTML`** — Critical — S — 22361, 22726, 23251, 31259, 31263.
`<h4>${validatorName}</h4>` (perf explainer modal), `Loading stake accounts for ${validatorName}…` (stake selection modal), `<h3>${displayName …}</h3>` (stake breakdown modal), and in the *Network* tab's next-leaders strip `title="${fullName}"` / `<span class="leader-next-name">${name}</span>` (31259, 31263) which is re-rendered every 2 s for every viewer — a validator only needs to be in the upcoming leader list, no click required (`" onmouseover="…` in the title attribute). Wrap all with `escHtml`.

**S6. CSP allows the whole `unpkg.com` origin and the CDN scripts have no SRI** — Medium — S — 83, 99, 18364–18366.
`script-src … https://cdnjs.cloudflare.com https://unpkg.com` plus `'unsafe-inline'` means the CSP does nothing against S1–S5 (any inline handler runs) and anyone can host arbitrary code on unpkg. The vendored web3.js has an SRI hash (116) but Chart.js (99) and globe.gl/topojson (18364–18365) do not. Fix: add `integrity=` to the Chart.js tag and to `loadScriptOnce`, or vendor globe.gl/topojson/world-atlas next to web3.js and drop `unpkg.com` from `script-src`/`connect-src`.

**S7. Geo data fetched over plain HTTP in the Action** — Low — S — `generate-geo.js:80`.
`fetch('http://ip-api.com/batch…')` — city/country strings are committed and served to every visitor. They are escaped on render (18779–18782), so the impact is data integrity only; ip-api's free tier is HTTP-only, so either accept it or switch to a provider with HTTPS.

---

## 1. Bugs & correctness

**B1. Corrupted `x1Portfolio` in localStorage kills the entire app** — High — S — 15122.
`let myPortfolio = JSON.parse(localStorage.getItem('x1Portfolio') || '[]');` is an unguarded top-level statement in the 20k-line main script. A single bad value (partial write, extension, manual edit) throws a `SyntaxError` at parse time, no function in that script block is defined, and the site renders as a dead shell. Every other localStorage reader in the file is wrapped in try/catch; this one and `savePortfolio()` (18001–18004, throws on quota/Safari-private) are not. Fix: `try { … } catch { [] }` and validate it is an array of strings.

**B2. Failed / unindexed reward fetches are counted as 0 XNT, understating APY** — High — M — 15397–15404, 20707–20711, 21202–21209.
`fetchTotalValidatorRewards` returns `{ epoch, amount: 0, indexed: false }` for a null result *and* for any fetch error (429, breaker open). Both calculators then do `totalRewardsXNT / rewards.length` over all entries, so one unindexed epoch out of 7 cuts the displayed APY by ~14%, and an RPC hiccup can halve it. Fix: filter to `r.indexed` before averaging (as `fillCardLastEpoch` at 18294 already does) and show "n of 7 epochs".

**B3. `SkipMonitor.start()` races `stop()` and leaks duplicate pollers** — High — S — 33092–33112, 33168–33178.
`start()` sets `running = true`, then `await rebuildSlotMap()` / `await tick()` (several seconds of RPC), then assigns `pollTimer = setInterval(...)`. If the user leaves the Network tab during those awaits, `stop()` runs first (clears the still-null handles), and the intervals are created afterwards. On the next visit `start()` overwrites the handles, so the first set is orphaned forever — each quick tab flip adds another 3 s/30 s/60 s poller set. Fix: re-check `state.running` after every `await` and `stop()` before assigning new timers.

**B4. Per-card reward charts break after any portfolio re-render and leak Chart instances** — Medium — S — 29362, 18162, 18175–18178, 30153–30156.
`loadPortfolio` replaces `portfolioValidatorResults.innerHTML` (the old canvases are detached) but only destroys `combinedChart`. `toggleChart` then sees `chartInstances[chartId]` already set and skips initialisation, so the freshly rendered canvas stays blank; the old Chart (with its ResizeObserver and detached canvas) is never destroyed. Fix: destroy and delete all `chart-*` instances whenever the card container is re-rendered.

**B5. `addToPortfolioFromList` passes an array as the `append` flag** — Medium — S — 22158–22163 vs 22035.
`renderValidatorList(allValidators.filter(...))` — the parameter is `append = false`, an array is truthy, so clicking "+ Add" in the browse modal appends the *next* page of 100 validators instead of re-rendering the current one; the button never flips to "Added". Fix: `filterValidatorList()` (as the compare path does at 22151).

**B6. `addToComparison` duplicate check happens before its awaits** — Medium — S — 20025–20070.
The `some(v => v.votePubkey === votePubkey)` guard (20031) runs before `await getValidatorInfo` + `await fetchTotalValidatorRewards` (~5–15 s with the 3-slot throttle, no spinner). A second click in that window passes the guard and pushes the same validator twice (also exceeds the 4-slot limit). Fix: push a placeholder synchronously, or track in-flight pubkeys.

**B7. `calculatorsInitialized` is never reset, so dropdowns go stale** — Medium — S — 20492, 20557.
Validators added to My Data Center after the first Calculators visit never appear in the "Select from your Data Center" selects; if the tab is entered twice before the first `await loadNetworkStats()` resolves, the `change` listener at 20552 is attached twice. Fix: rebuild the `<option>`s on every entry (cheap) and bind the listener once.

**B8. Batch JSON-RPC responses are mapped by array position, not `id`** — Medium — S — 17257–17276 (`fetchAllExtendedEpochCreditsBatch`).
`batchData.forEach((res, idx) => chunk[idx])` assumes the server preserves order; JSON-RPC 2.0 explicitly allows any order (and `fetchProducedSlots` at 15738–15742 correctly maps by `resp.id`). A reordered response silently assigns one validator's credit history to another and mis-scores the fallback leaderboard. Fix: map by `res.id`.

**B9. `activatedStake` means lamports in one object shape and XNT in another** — Medium — M — 16052, 20046, 20220–20232, 16856–16860.
`allValidators[].activatedStake` is lamports; `getValidatorInfo()` returns XNT under the same key; `addToComparison` merges both (`{...validator, ...detailedInfo}`), and downstream code guesses with different thresholds (`> 1e9` in compare, `> 1e12` in scoring). A stake under 1 XNT (5e8 lamports) shows as "500M XNT" in Compare. Fix: keep lamports everywhere and convert only at render time (or rename to `activatedStakeXnt`).

**B10. `refreshValidatorStakes` marks the identity list as fresh** — Low — S — 18066 vs 20398–20405, 17869–17876.
It only refreshes stake/delinquency but sets `allValidatorsFetchedAt = Date.now()`, which the Lookup tab uses to decide whether new validators need a refetch. After a portfolio visit, a validator that joined since page load is invisible in search for another 5 minutes. Fix: use a separate timestamp.

**B11. `validatorInfoCache` has no TTL** — Low — S — 15995–15997, 16073.
Lookup / Compare / Calculators reuse the first `getValidatorInfo()` result for the whole session (balance, stake, skip rate, rank), only `lookupValidator()` (17801) and `refreshPortfolio()` evict. Fix: store `fetchedAt` and treat > 5 min as a miss.

**B12. Skip-rate history caches total failures for 5 minutes** — Low — S — 16281–16333, 17196–17240.
When all 7 `getBlockProduction` range calls fail (breaker open, 429), `validResults` is `[]` and it is still cached with `timestamp: Date.now()`, so cards show "Awaiting" for 5 min after the RPC recovers. Fix: don't cache when `epochCount === 0`.

**B13. Latest-version detection: GitHub fetch blocks the header, floor is stale, fallback is dead** — Medium — S — 15877–15912, 15650–15653.
`await fetch('https://api.github.com/…/releases')` (15878) sits *before* the DOM writes at 15924, so header stats wait on GitHub (60 req/h unauthenticated per IP; VPN/office NATs hit it). When it fails, `MINIMUM_KNOWN_VERSION = '2.2.20'` (15895) becomes "latest" while the network runs 3.1.14, so nobody is flagged outdated; the "derive from cluster peers" block at 15903–15912 can never run because 15896–15898 always sets a value. Fix: use `canonicalScores.latestVersion` (already computed server-side), do the GitHub call after rendering, and delete the dead block.

**B14. `Math.floor(amount * 1e9)` loses a lamport on many decimal inputs** — Low — S — 26486, 26970, 27870.
`4.35 * 1e9 === 4349999999.999999` → floors to one lamport less than typed. Use `Math.round`, or parse the decimal string into integer lamports.

**B15. "Newest Validators" is capped by the 64-entry `epochCredits` ring** — Low — S — 19576–19578.
`firstEpoch = epochCredits[0][0]` — the vote account keeps at most 64 epochs, so every validator older than 64 epochs reports the same "first epoch" and `epochsActive` saturates at 64 (the Age info row in `scores.json` shows the same "64 epochs"). Fine for the top-50-newest list, wrong for the "epochs ago" labels; cap the label at "64+".

**B16. Canonical scores are fetched once and never re-validated** — Low — S — 14865–14886, 19372–19373.
A tab left open for a day keeps showing the first `scores.json` as "📡 Official … same for all viewers" (the 3 h staleness check only runs at load; `loadLeaderboard` only re-fetches when `canonicalScores` is null). Fix: re-fetch when `generatedAt` is older than ~65 min.

**B17. Score script: zero-credit validators get Consistency = 100** — Low — S — `scripts/compute-scores.js:494–497`.
`const cv = avg > 0 ? … : 0;` → `scoreConsistency(0) = 100` for a validator that earned 0 credits in every window epoch (10% of the score). Return the floor (15) or "n/a" when `avg === 0`.

---

## 2. Reliability under RPC failure / rate limiting

**R1. No timeout anywhere in the RPC layer — three hung requests freeze the whole app** — High — S — 15697–15711 (`rpcCall`), 15042–15111 (throttle), 44 raw `fetch(RPC_URL…)` sites.
Only three places use `AbortController` (19073, 28780, 34752). The throttle holds one of its 3 slots for the entire retry loop (up to 5×8 s backoff on 429), and a request that never returns holds it forever; `waiters` then grows without bound. Fix: add `AbortSignal.timeout(15000)` (or a per-call default) inside `throttledFetch` and reject with a clear error.

**R2. The circuit breaker trips on rate limiting and on caller timeouts — the opposite of its design** — Medium — S — 15067–15104, 28780–28790.
The comment at 14953–14957 itself says a 429 arrives without CORS headers and surfaces as `TypeError: Failed to fetch`, so it lands in the `catch` branch: counted toward the breaker and retried only once (`MAX_RETRIES_NET = 1`), not 5× — the whole 429 branch (15067–15089) is effectively dead in browsers. Caller `AbortError`s (the 15 s stake-account timeout) also count and are retried with an already-aborted signal, so each timeout = 2 failures; three timeouts open the breaker for 30 s and every feature — including web3's `Connection` used for signing/confirming transactions, which goes through the patched `window.fetch` — rejects with "RPC paused by circuit breaker". Fix: `if (e.name === 'AbortError') throw e;` before counting, and treat a `TypeError` that follows a burst as pushback (short pause, no breaker).

**R3. Four independent `getEpochInfo` pollers on the Network tab (~55/min) and 22 uncached call sites** — Medium — M — 31548–31552 (2 s), 31572/32000 (3 s), 30693–30694 (12 s), 31511 (90 s); `getEpochInfoCached` (15268) used by only 3 callers.
Steady-state Network tab traffic ≈ 80 RPC calls/min per viewer: `updateCurrentLeader` 30/min, `SkipMonitor.tick` 20/min + 20/min `getBlocks`, `pollHour` 4/min, `pollEpoch` 1/min (full-epoch `getBlockProduction`), `LeaderCountdown` 5/min, TPS 1/min. All four clocks want the same number. Fix: one shared slot clock (`getEpochInfoCached(2000)`) that the others read; route the remaining 22 `rpcCall('getEpochInfo')` sites through it.

**R4. `updateCurrentLeader` rebuilds a ~209k-entry slot→leader map every 2 seconds** — Medium — S — 31126–31131.
`for (const [leader, slots] of Object.entries(leaderScheduleCache)) for (const slot of slots) slotToLeader[slot] = leader;` on every tick, on every device, while `SkipMonitor.state.slotToLeader` already holds the same map (31715–31722). Fix: build once per epoch and share.

**R5. `getLeaderSchedule` (multi-MB) is downloaded by every visitor at page load** — Medium — S — 31539, 30712.
`init()` calls `loadLeaderSchedule()` unconditionally even though the landing tab is the globe and the schedule is only used by the Network tab / next-leader chips. `loadPrevEpochLeaderSchedule` (31750) pulls a second full schedule. Fix: load lazily from `SkipMonitor.start()` / `LeaderCountdown.sync()`.

**R6. Per-slot `getBlock` fan-out on the Network tab has no cap and refreshes every 60 s** — High — S — 32771–32800 (current epoch), 32822–32845 (previous epoch), vs `PER_SLOT_FETCH_CAP = 3000` at 34267.
In portfolio/lookup scope `fetchProducedSlots(pastSlots)` batches 50 `getBlock` calls per request over *every* past leader slot of the epoch, re-runs whenever `Date.now() - fetchedAt > 60000` (or the skip count changes), and the "frozen" previous epoch is re-fetched every 5 min anyway. A validator with 2,000 leader slots so far costs 40 batched `getBlock` requests per minute, per portfolio validator, per viewer. Fix: apply the same 3,000-slot cap as the Slot Explorer, fetch only the *new* slots since the last fetch, and never re-fetch the previous epoch once loaded.

**R7. Reward fetching is 2N+2 RPC calls per validator and duplicated in 8 places** — Medium — M — 15362–15563; `getInflationReward` loops at 15300–15334, 15382–15405, 15492–15517; `getProgramAccounts(Stake, memcmp 124)` at 15429, 20740, 22478, 22738, 23408, 28799, 29741, 33459.
`fetchTotalValidatorRewards(…, 30)` = 30 vote-reward calls + `getAccountInfo` + `getProgramAccounts` (every stake account delegated to the validator, no `dataSize` filter) + 30 self-stake reward calls = 62 requests; the portfolio page does this for every validator (6 epochs → 14 calls each) on every visit. The identical stake-account query appears in 8 functions with no shared cache. Fix: one `getStakeAccountsForVote(vote)` with a 5-min cache, and one `getRewardsForEpochs(addresses, epochs)`; consider moving 30-epoch reward history into the hourly Action (it already has `getInflationReward` chunking logic at 33493–33500).

**R8. `loadLeaderboard` refetches ~3 MB on every tab entry and has no single-flight guard** — Medium — S — 19322–19458, 17249–17290.
`fetchAllExtendedEpochCreditsBatch()` (8 batched `getAccountInfo` × 100 vote accounts, jsonParsed) runs every time the tab is opened; rapid switching runs it concurrently. Fix: cache `extendedCreditsMap` per epoch and keep a `leaderboardLoading` promise.

**R9. `loadNetworkStats()` has no single-flight guard** — Low — S — 15855; callers 17843, 17872, 19353, 20402, 20496, 22026, 31443.
Search + tab switch + epoch rollover can start 2–3 overlapping runs (each 6 parallel RPCs + `getBlockProduction` + GitHub), and the last to finish wins `allValidators` regardless of order. Fix: memoise the in-flight promise.

**R10. `LeaderCountdown` polls for chips in hidden tabs** — Low — S — 30624, 30644–30647.
`document.querySelectorAll('.vh-next-leader')` matches chips inside inactive `.tab-content` panels, so once any card has been rendered, `getEpochInfo` fires every 12 s on every tab for the rest of the session. Fix: scope the query to the active tab.

**R11. The XNT price pill is a known-broken feature that fails every 60 s** — Low — S — 35650–35669.
The comment (35596–35601) documents that XDEX has not allow-listed the origin; every visitor still makes a blocked cross-origin request per minute and logs a `console.warn`. Fix: gate behind a flag until CORS is enabled, or proxy the price through the hourly Action.

**R12. Poller inventory at page load (for reference)** — Info.
Always running: `renderEpochBar` 1 s (no RPC), `resyncEpochBaseline` 90 s, `loadTpsSamples` 60 s (720 samples ≈ 60 KB), XNT pill 60 s, `LeaderCountdown` 1 s tick + 12 s sync (conditional), `visibilitychange` resync. Network tab adds: 2 s leader card, 3 s tick, 1 s UI, 30 s hour, 60 s epoch, 15 min timeline; these are cleared on tab switch except for B3. Terminal adds a 1 h auto-refresh (cleared on `vtClose`). Nothing else is leaked on tab switch.

---

## 4. Dead code, duplication, maintainability

**D1. Eleven top-level functions are never referenced** — Low — S — `classifyStakeAccount` 14939, `cacheSelfStakePubkeys` 15240, `getCachedSelfStakePubkeys` 15252, `getCachedInflationRewards` 15353, `getValidatorUptimeHistory` 16401, `calculatePerformanceScore_LEGACY` 16832–17042 (~210 lines), `refreshGeoDataInBackground` 19059, `formatBreakevenInput` 21771, `fetchConnectedWalletBalance` 24428, `toggleDisclaimerCheckbox` 31311, `toggleNetwork` 31348 (plus the whole Solana-toggle block 31339–31401 and `.solana-modal-*` CSS from ~700 — no `#solanaModal` / `#networkToggle` element exists in the HTML).

**D2. Rewards-tracker API is permanently off, leaving dead paths** — Low — S — 14904 (`REWARDS_API_URL = null`), 15752–15774, 17496–17502 (`chartType = 'xnt'` branch), `init()` awaiting `fetchRewardsHistory()` at 31523.

**D3. `fetchValidatorIdentitiesForRedelegate` reads a cache nothing writes** — Low — S — 25760–25773.
`localStorage.getItem('validatorIdentitiesCache')` is the only reference to that key in the file, so the function always returns `{}`; `window.validatorIdentities` (15946) already holds the data.

**D4. Slot time is hard-coded eight times with two different values** — Medium — S — 400 ms at 15133, 21544, 21627, 23708, 31426; 420 ms at 30599, 32765, 34163 (and the Terminal).
With ~209k slots/epoch the two constants disagree by ~1 h per epoch, so the epoch bar, unstaking dates, APY annualisation (`epochsPerYear`, 15134) and the leader countdown drift apart. `getRecentPerformanceSamples` already provides `numSlots / samplePeriodSecs` (30989–30997) — derive one live `SLOT_MS` from the TPS cache and export it.

**D5. Two RPC transports and five wrappers around the same call** — Medium — M — `rpcCall` (15697) vs 44 hand-rolled `fetch(RPC_URL, …)` with `id: 1`; `getBlockProduction` wrappers at 16172, 16209, 17120, 17159, 30748; batch helpers at 15719 and 17249.
Only `rpcCall` throws on JSON-RPC `error`; the raw sites mostly `return null` and lose the reason. Consolidate into `rpc(method, params, {timeout})` + `rpcBatch(requests)` (mapped by id), and one `getBlockProduction(range?, identity?)`.

**D6. Stale comments that mislead the next maintainer** — Low — S — 20373 ("skipmonitor has no visible button" — it is the *Network* button at 11985), 18103 and 33125 ("4-slot queue" — it is 3, 14967), 31540–31541 ("subsequent polls only pull 1 sample" — it always pulls 720, 30976–30986), 15129 ("X1 epochs are ~2 days" — ~1 day from `slot/epoch` in `scores.json`).

**D7. The globe (`mapTab`) is the landing page but has no nav button** — Low — S — 12016 (`active` by default), 11985–12012, 22004 (`goToHome`).
Only the logo click returns to it; the "Network" button goes to `skipmonitor`. Either add a Globe button or make `skipmonitor` the landing tab so the leader-schedule/globe downloads match what users actually see.

**D8. `website` is fetched and stored but never rendered** — Low — S — 15835, 15954, 16154. Drop it, or render it (through `safeUrl` + `escHtml`, with `rel="noopener noreferrer"`).

**D9. `_headers` is a Netlify/Cloudflare convention that GitHub Pages ignores** — Low — S — `_headers:1–4`, comment at 74–78.
The `Cache-Control` for `validator-locations.json` never applies; the `?t=` cache-busters (14868, 18935) are what actually works. Remove the file or move to a host that honours it (which would also allow a real `frame-ancestors` header).

---

## 5. Data pipeline / GitHub Actions

**A1. Geo workflow pushes without rebase or concurrency group — fails whenever the scores bot lands first** — Medium — S — `update-geo-data.yml` (no `concurrency:`, commit step does `git commit && git push`).
Scheduled runs are routinely delayed 10–30 min, so the :07 scores commit often lands between the geo checkout and its push → non-fast-forward → the run fails silently and the map data waits 2 h. Copy the `git pull --rebase` + retry loop used by the terminal workflow (HANDOVER §6), and add `concurrency: { group: update-geo }`.

**A2. No failure alerting on any bot** — Medium — S — both workflows.
If `compute-scores.js` fails for > 3 h the site silently degrades to "⚠ Published scores unavailable"; nobody is told. Add a final `if: failure()` step (e.g. `peter-evans/create-issue-from-failure`, or a Discord/Telegram webhook), and optionally have the site ping a lightweight "scores older than 2 h" console warning.

**A3. `update-scores.yml` has no push retry either, and `[skip ci]` is applied inconsistently** — Low — S — `update-scores.yml:41–45`, `update-geo-data.yml` (no `[skip ci]`).
One `git pull --rebase && git push`; a second race loses that hour's uptime/latency observation in `history.json`. `[skip ci]` is meaningless here (all workflows are cron/dispatch-only and Pages still deploys — verified by the HANDOVER live checks), so either drop it or apply it uniformly. Long term, moving `data/*.json` to a `data` branch (HANDOVER backlog) removes the three-bot contention entirely.

**A4. Skip-rate history claims 7 epochs but the RPC serves 4** — Low — S — `compute-scores.js:42, 292–303`; `data/scores.json` → `skipEpochsCovered: 4`.
`getBlockProduction` with a range only works for epochs still in the node's leader-schedule cache; the rest log a warning and are dropped. The UI labels ("7-epoch aggregate", `requestedEpochs: 7` at 19392) should read `skipEpochsCovered`, and `SKIP_CONFIDENCE_K` was presumably tuned for 7 epochs of samples.

**A5. `pruneHistory` deletes all rolling history for a validator that drops out of `getVoteAccounts` for one run** — Low — S — `compute-scores.js:104–116`.
A stake-drained "zombie" (the case `fetchZombieValidator` handles client-side) loses 7 days of uptime/latency and returns as "Building history…" with neutral 78/88/82 sub-scores — better than it deserves. Keep entries for `HISTORY_PRUNE_DAYS` regardless of membership.

**A6. `generate-geo.js` RPC calls have no timeout/retry and the reviewed tree is missing files** — Low — S — `generate-geo.js:5–21`; repo.
`rpcCall` there is a bare `fetch` (compare `compute-scores.js:61–78`). Also note: `.github/workflows/update-terminal-snapshot.yml`, `data/history.json`, `validator-locations.json` and `vendor/` are referenced by HANDOVER/`index.html` but absent from the tree that was reviewed — make sure the review copy matches `main` before acting on D9/A3.

---

## Architecture observations

The app is one 1.47 MB HTML file (297 KB CSS, 133 KB markup, ~1 MB JS in four inline blocks) plus ~1 MB of vendored web3.js and a lazily loaded 1.9 MB globe.gl; gzipped transfer is ~315 KB for the document alone, which is acceptable, but the *shape* is the problem: ~400 top-level functions share one global namespace, the same data (`activatedStake`, validator names, epoch info, stake accounts) is fetched and re-shaped in five or six places, and security helpers exist but are applied inconsistently because every render path hand-builds HTML strings. The newer modules (SkipMonitor, LeaderCountdown, Terminal, Forensics) are IIFEs with local `esc()` helpers and explicit start/stop — that pattern works and should be extended backwards.

A modest, no-build-step refactor would buy most of the value: (1) split `index.html` into `app.css` + `core.js` (RPC transport with timeout/retry/breaker, a single slot clock, shared caches with TTLs, `escHtml/escAttr/safeUrl`) + one file per tab, loaded with plain `<script src>` tags — no bundler required, and it makes SRI/CSP tightening trivial; (2) replace inline `onclick="fn('${…}')"` with `data-*` attributes and delegated listeners, which removes the entire S2–S5 class and lets `'unsafe-inline'` go; (3) normalise on-chain records once at ingestion (`{ votePubkey, nodePubkey, name, iconUrl (sanitised), stakeLamports, … }`) so every renderer consumes the same shape; (4) push the expensive per-validator crawls (30-epoch rewards, stake-account classification, per-slot block production) into the hourly Action next to `scores.json`, leaving the browser to do only live, cheap polling. Each of those is a day or two of work and none of them changes what users see — they change how often the public RPC says no.
