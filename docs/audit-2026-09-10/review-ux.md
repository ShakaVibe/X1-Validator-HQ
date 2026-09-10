# X1 Validator HQ — UX / Mobile / Performance / Accessibility Review

Reviewed from source only: `/home/claude/x1vhq/index.html` (37,572 lines, 1,520,846 bytes). Line numbers refer to that file as of 2026-09-10. The live site was not opened, so anything about actual render/paint timings is an estimate derived from byte counts and the startup code path.

## Measurements at a glance

| Item | Value |
|---|---|
| Total `index.html` | 1,520,846 B raw → **~316 KB gzip -6** (GitHub Pages gzips, so this is what ships) |
| Inline CSS (one `<style>`, lines 121–11,7xx) | 300,688 B raw → 42.8 KB gz, ~1,986 rules, 22 `@media` blocks |
| Inline JS (5 `<script>` blocks) | 1,059,529 B raw → ~244 KB gz. Block sizes: 538 B (frame-buster), 903,481 B (main app), 47,187 B, 4,045 B, 104,278 B (Validator Terminal) |
| HTML markup | ~160 KB raw (~29 KB gz) |
| JS that is comments / indentation | ~173 KB line comments + ~192 KB leading whitespace = **~35 % of JS bytes** (mostly recovered by gzip) |
| External scripts in `<head>`, render-blocking | Chart.js 4.4.1 from cdnjs (~205 KB / ~65 KB gz), `vendor/solana-web3.js-1.98.4.iife.min.js` with SRI (~0.9 MB / ~270 KB gz, not staged here — size inferred from the 1.98.x IIFE build) |
| External CSS, render-blocking | Google Fonts: Space Grotesk ×4 weights + JetBrains Mono ×2 weights (`display=swap`) |
| Lazy third-party | globe.gl 2.46.2 (~1.9 MB per comment at line 100) + topojson-client + world-atlas 110m (~110 KB) from unpkg, loaded 500 ms after `init()` because the globe tab is the default view |
| Same-origin data at startup | `data/scores.json` 954,772 B raw / 73 KB gz (line 14886, fetched at script-eval time), `validator-locations.json` (cache-busted with `?t=Date.now()`, line 18935) |
| Large inline data blobs | None significant: ISO map 1.6 KB (line 18383), two base64 webp logos ~3 KB each (lines 27493, 27527) |
| `setInterval` sites | 14 (5 start unconditionally on load) |
| Inline `onclick=` | 254 (45 on `<div>`, 6 on `<span>`); `<button>` 193; `aria-label` 3; `role=` 3; `tabindex` 1 |
| `outline: none` | 13 sites, `:focus-visible` 0, `prefers-reduced-motion` 0, `prefers-color-scheme` 0 |
| `<img>` | 22, 18 with `alt` (the 4 missing are JS-built logos at lines 20002, 20121 and two more) |
| Deep-link support | none (`location.hash`/`pushState` never used; only `?debug=1`, line 14728) |
| OG/Twitter meta, `<meta name="description">`, manifest, `theme-color` | none |
| Design tokens | 3 font families (Space Grotesk, JetBrains Mono, SF Mono), 45 distinct hex colours + 206 distinct `rgba()` literals, 24 distinct `border-radius` values |

---

## Quick wins (under 1 hour each)

1. **Add `defer` to Chart.js and web3.js** (lines 97, 115) — removes ~335 KB gz of render-blocking script from the critical path. Nothing in the first-paint path needs either.
2. **Add `<meta name="description">`, Open Graph and Twitter card tags** so links shared in the X1 Discord/Telegram unfurl with a title, description and image (there are none today — line 93–96).
3. **Add `<meta name="theme-color" content="#0a1020">`** and an `apple-touch-icon` (currently only an SVG data-URI favicon, line 95, which iOS ignores for home-screen icons).
4. **Give the tab bar an active state on first load** — `mapTab` is `active` in HTML (line 12016) but no `.tab` button is, so a new visitor sees seven unselected tabs and a globe with no label.
5. **Add a `:focus-visible` ring for `.tab`, `.leaderboard-cat-btn`, `.calc-nav-btn`, `.modal-close`** — there is currently no visible keyboard focus on any button; add one 6-line rule.
6. **Add `aria-label="Close"` to the 25+ `.modal-close` buttons** that contain only `&times;` (e.g. lines 12880, 12906, 12965).
7. **Remove `?t=Date.now()` cache-busting on `validator-locations.json`** (line 18935) — with GitHub Pages' 10-min max-age you can use `?t=Math.floor(Date.now()/600000)` like `scores.json` already does (line 14868) and get the browser cache back. Also delete `_headers` — GitHub Pages does not read it (it is a Netlify/Cloudflare file).
8. **Wrap `table.vt-data` in an `overflow-x:auto` container** — change `.vt-tbl-wrap { overflow: visible }` (line 11408) to `overflow-x: auto`; the 24-column terminal table is currently clipped by `body { overflow-x: hidden }` (line 148) on any viewport under ~1,600 px.
9. **Make `.vt-tip` fit phones**: `min-width: 460px` (line 11543) → `min-width: min(460px, calc(100vw - 2rem))`.
10. **Bump `.search-input` (line 1105, 0.9 rem) and `.vt-tools input.search` (line 11323, 0.82 rem) to 16 px on touch devices** to stop iOS auto-zoom on focus. One `@media (pointer:coarse)` rule.
11. **Rename the first nav tab from "Network" to "Live"** (or rename the hidden globe view) — "Network" (button, line 11985) opens the *Network Live* skip monitor, while the *X1 Network* globe (`#mapTab`) is only reachable by clicking the logo (`goToHome`, line 21998).
12. **Show an error state instead of the empty state when the portfolio load fails** — `loadPortfolio` catch (line 18181) shows "No validators yet", which tells an operator whose RPC call 429'd that their validators are gone.
13. **Add `@media (prefers-reduced-motion: reduce)`** that sets `autoRotate = false` on the globe (line 18630), stops the 14 keyframe animations and the `transition`s — zero occurrences today.
14. **Add `<meta name="viewport" ... viewport-fit=cover>` + `env(safe-area-inset-*)` padding on `main` and the sticky `.vt-tools`** for notched iPhones (0 `safe-area` uses).

---

## 1. Performance

### 1.1 ~1.2 MB of render-blocking script in `<head>` for a page whose first view needs none of it — **High / S**
Evidence: lines 97 and 115 load Chart.js (cdnjs) and `vendor/solana-web3.js-1.98.4.iife.min.js` as plain `<script src>` in `<head>`, before the 300 KB `<style>` and 1 MB inline JS. web3.js (`solanaWeb3`) is referenced only inside wallet/transaction code (`new Connection(...)` at lines 25055, 25276, 25476, 25874, 26197; `solanaWeb3.PublicKey` at 14800 for address validation). Chart.js is first used when a validator card's chart is expanded, the Compound calculator, or the portfolio charts — never on the globe home view.
Impact: the browser cannot start parsing the body until ~335 KB gz (~1.1 MB raw) has downloaded, parsed and executed; on a mid-range Android over 4G that is roughly 1–2 s of blank dark page before the header appears.
Recommendation: add `defer` to both now (quick win). Then lazy-load web3.js via the existing `loadScriptOnce()` helper (line 18395) the first time `connectWallet()`/a stake action is invoked, keeping the SRI hash on the dynamically-created `<script>`; replace the one non-wallet use (`new solanaWeb3.PublicKey` at 14800) with a base58 regex/length check. Lazy-load Chart.js the same way from a `ensureChartJs()` wrapper. Estimated saving: ~330 KB gz off the critical path, first paint several hundred ms earlier on desktop and 1 s+ on mobile.

### 1.2 One 903 KB inline script (block 2) must be fully parsed before anything is interactive — **High / L**
Evidence: `<script>` block sizes 538 B / 903,481 B / 47,187 B / 4,045 B / 104,278 B; `init()` is called at the very end of the main block (line 34610). ~365 KB of the main block is comments and indentation (measured), which gzip mostly absorbs but the parser still has to scan.
Impact: ~200 KB gz JS download + parse/compile of 1 MB of source on every visit; no code-splitting means the Validator Terminal (104 KB), the stake-management modals (~150 KB of code between lines 22,000–27,500), calculators and the skip monitor are all paid for by a user who only wants to look up one validator.
Recommendation (staged): (a) move the Validator Terminal IIFE (line 34670+) and the wallet/stake-management section into separate same-origin files loaded on first tab open with `loadScriptOnce()` — no build step needed, just `<script src="js/terminal.js">` created on demand; (b) longer term, a 30-line `esbuild` script (`esbuild src/*.js --bundle --minify --outdir=dist`) run locally before commit would cut raw JS ~40 % and keep GitHub Pages as-is.

### 1.3 Startup fires ~12 RPC/HTTP requests and 5 timers before the user does anything — **Med / M**
Evidence, from `init()` (line 31521) and top-level code:
- `loadCanonicalScores()` at script-eval (line 14886) → `data/scores.json` (955 KB raw / 73 KB gz)
- `loadNetworkStats()` (line 15855): `Promise.all` of `getVoteAccounts`, `getEpochInfo`, `getSlot`, `getProgramAccounts(Config…)` (validator identities — a full account scan), `getClusterNodes`, `getSupply`, then `api.github.com/repos/x1-labs/tachyon/releases` (line 15878) and `fetchAllSkipRates()` → `getBlockProduction` (line 15984, can be >1 MB per the comment at line 31572)
- `loadLeaderSchedule()`: `getEpochInfo` + `getLeaderSchedule` (line 30703/30712) — the leader schedule for the whole epoch, hundreds of KB
- `loadTpsSamples()`: `getRecentPerformanceSamples(720)` (line 30986) — 12 h of samples on first load
- `initializeMap()` after 500 ms: globe.gl (~1.9 MB), topojson, world-atlas, `validator-locations.json`, plus an `ipwho.is/8.8.8.8` probe (line 18998)
- XNT price from `api.xdex.xyz` (line 35610)
- Timers: `renderEpochBar` 1 s (31508), `resyncEpochBaseline` 90 s (31511), leader poll 2 s gated on the skip-monitor tab (31548), `loadTpsSamples` 60 s (31557), `LeaderCountdown` tick 1 s + sync 12 s gated on chips (30693–4), XNT price `REFRESH_MS` (35669).
Impact: the RPC throttle (line 14949) allows 3 in flight, so the six-way `Promise.all` plus `getLeaderSchedule`/`getBlockProduction`/`getRecentPerformanceSamples` queue behind each other; the stats bar shows `--` until `getVoteAccounts` + `getProgramAccounts` both finish. On the rate-limited public RPC this is the most likely source of the "Failed to fetch" reports in HANDOVER.md.
Recommendation: (1) Split `loadNetworkStats` into a fast path (`getEpochInfo`, `getSlot`, `getVoteAccounts`) that paints the stats bar, and a deferred path (`getProgramAccounts`, `getClusterNodes`, `getSupply`, GitHub releases, `getBlockProduction`) run after first paint or on first Lookup. (2) Cache the deferred results in `sessionStorage`/`localStorage` with a 5–10 min TTL (identities already use `validatorIdentitiesCache`; do the same for versions, supply and skip rates). (3) Defer `getLeaderSchedule` and the 720-sample TPS backfill until the Network Live tab is opened — today they run for every visitor of every tab. Estimated effect: ~4 fewer RPC calls and ~1.5 MB less transfer on a typical visit; stats bar populated ~1 round-trip sooner.

### 1.4 Data for hidden tabs is fetched eagerly — **Med / S**
Evidence: `data/scores.json` (line 14886) is fetched at script evaluation for every visitor although scores only appear on validator cards/leaderboards; `getLeaderSchedule` + `getRecentPerformanceSamples(720)` are needed only by Network Live / the TPS strip; the GitHub releases call is only used for the "latest version" badge on cards. The Validator Terminal and Leaderboards correctly load on tab entry (`switchTab`, lines 20418, 20443).
Recommendation: turn `canonicalScoresPromise` into a lazy getter (`getCanonicalScores()` that starts the fetch on first call — `ensureCanonicalScores` at line 19373 already exists); gate leader schedule/TPS on their tabs. Saves ~75 KB gz + 3 RPC calls for anyone who never opens Network Live.

### 1.5 Google Fonts stylesheet is render-blocking and pulls 6 weights — **Med / S**
Evidence: line 96 `<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`; 192 `font-family` declarations across the CSS.
Impact: an extra cross-origin CSS round trip before first render, then 6 woff2 files (~100–150 KB). `display=swap` avoids invisible text but causes a visible font swap on every cold load.
Recommendation: self-host the two families (`vendor/fonts/*.woff2`) with `<link rel="preload" as="font">` for the two most-used weights (Space Grotesk 500, JetBrains Mono 400), drop 700 (only headings — use 600) and load the stylesheet with `media="print" onload="this.media='all'"`. Alternatively use a system stack for body text and keep only JetBrains Mono for numbers. Removes the fonts.googleapis.com round-trip and ~40 KB.

### 1.6 The globe library (~1.9 MB) is downloaded for every first-time visitor because the globe is the default view — **Med / M**
Evidence: `init()` calls `initializeMap()` after 500 ms (line 31528); `loadGlobeLibrary()` (line 18417) pulls `globe.gl@2.46.2/dist/globe.gl.min.js` from unpkg (comment at line 100: "~1.9MB"), plus topojson-client and world-atlas (line 18364–18366). It is correctly paused when off-screen (`IntersectionObserver`, line 18657) and when the document is hidden (line 18662).
Impact: on mobile data plans this is the single largest resource; unpkg is also a single point of failure (the CSP allows it but the code has a fallback path via `showGlobeFallback`, line 18705). WebGL + three.js on a phone GPU also adds several hundred ms of main-thread work and drains battery while it auto-rotates.
Recommendation: (a) vendor `globe.gl.min.js` alongside web3.js so it is gzipped by Pages and SRI-pinned; (b) on `pointer: coarse` or `navigator.connection.saveData`, or when the viewport is < 768 px, render a static fallback (the country list already exists) with a "Load 3D globe" button instead of auto-loading; (c) consider making Validator Lookup the default landing view (see §4.1), which would make the globe lazy for everyone.

### 1.7 No service worker / app-shell caching — every visit re-downloads 316 KB of HTML — **Med / M**
Evidence: 0 occurrences of `serviceWorker`; no manifest. GitHub Pages sends `Cache-Control: max-age=600`, so returning visitors re-fetch the full document after 10 minutes.
Recommendation: add a tiny `sw.js` (stale-while-revalidate for `index.html`, `vendor/*`, fonts; network-first for `data/*.json` and RPC) plus `manifest.webmanifest`. Repeat visits would load the shell from cache instantly and work offline for the static parts. This also makes the site installable on phones (validator operators do check dashboards from their phone at 3 am).

### 1.8 `getProgramAccounts` on the Config program runs at startup and again on Lookup refresh — **Med / S**
Evidence: `fetchValidatorIdentities()` (line 15781) is part of the startup `Promise.all`; it is one of the heaviest RPC methods and is exactly what public RPCs rate-limit. There is already a `validatorIdentitiesCache` in localStorage.
Recommendation: read the cache first and paint with it, refresh `getProgramAccounts` in the background at most once per hour, or move identity resolution into the hourly `compute-scores.js` Action so it ships inside `scores.json` (names + icon URLs are ~50 KB for 724 validators). Removes the heaviest RPC call from the critical path entirely.

### 1.9 `validator-locations.json` is cache-busted with `Date.now()` — **Low / S**
Evidence: line 18935 `fetch(url + '?t=' + Date.now())`; the file is regenerated every 2 h. `_headers` (root) sets `no-cache` for the same file but GitHub Pages ignores `_headers`.
Recommendation: `?t=${Math.floor(Date.now()/600000)}` (10-min bucket) as `scores.json` does at line 14868, delete `_headers` to avoid confusion.

### 1.10 The 12-hour TPS backfill (720 samples) runs before the user can see the sparkline — **Low / S**
Evidence: `loadTpsSamples()` line 30976 comment "Always fetch the full 720 samples (12h) on every poll", called from `init()` and every 60 s (line 31557). Only the top-bar TPS number is visible on non-Live tabs.
Recommendation: fetch 1 sample for the header pill; backfill 720 only when Network Live or the TPS modal opens; keep the 60 s poll at 1 sample as the comment at line 31530 already intends.

### 1.11 Inline event handlers force `'unsafe-inline'` in the CSP and defeat any future CSP hardening — **Low / L**
Evidence: 254 `onclick=`, plus `oninput`, `onchange`, `onmouseenter` attributes; CSP comment at lines 45–50 acknowledges this. Not a perf issue per se but the same migration (event delegation on `main`) would shrink the HTML and let the CSP drop `'unsafe-inline'`.
Recommendation: a single delegated `click` listener with `data-action="switchTab" data-arg="lookup"` attributes; migrate incrementally (nav tabs and modals first).

---

## 2. Mobile / Responsive

Breakpoints used (22 `@media` blocks, all `max-width`): **1180, 980 (×4), 900 (×5), 768 (×4), 760, 600 (×3), 500 (×2), 480 (×3)** px. There is no `min-width`, `pointer: coarse`, `hover: none`, orientation or `prefers-*` query. Five different "tablet" breakpoints (980/900/768/760) mean components reflow at slightly different widths, which shows as a jittery layout between 760 and 980 px.

### 2.1 The Validator Terminal table is unusable on phones and clipped on laptops — **High / S**
Evidence: `table.vt-data` has 24 columns (`COLS`, line 36830) with `white-space: nowrap` on every cell (line 11441), `font-size: 11px` (line 11412), `.vt-tbl-wrap { overflow: visible }` (line 11408), and `body { overflow-x: hidden }` (line 148). Only 3 `overflow-x: auto` sites exist in the whole CSS (lines 2725, 9077, 11723) and none wraps this table.
Impact: at 390 px the user sees roughly the first 3 columns; the remaining 21 are clipped by the body and cannot be scrolled to. Even at 1,280 px the "lag" columns overflow.
Recommendation: `overflow-x: auto; -webkit-overflow-scrolling: touch` on `.vt-tbl-wrap` with `position: sticky; left: 0` on the first two columns; on `max-width: 768px` hide the `deep`/`lag` column groups by default behind the existing Deep/Lag toggles; consider a card layout per validator below 600 px.

### 2.2 Nav bar: 7 tabs become a horizontal scroller with no affordance — **High / M**
Evidence: `.tabs` is `flex: 1 1 0` seven-up at desktop (line 966); at ≤768 px it becomes `overflow-x: auto` with `flex: 0 0 auto; white-space: nowrap` tabs (lines 9077–9090). Labels are long ("Validator Terminal", "My Data Center", "Leaderboards"). No scroll-snap, fade mask or arrow (0 `scroll-snap`/`mask-image` uses).
Impact: on a 390 px phone roughly 2.5 tabs are visible; "Compare" and "Calculators" are off-screen with nothing suggesting more exist. Because no tab is active on first load (§4.1) there is also no visual anchor.
Recommendation: on ≤768 px switch to a 4+3 or 4+4 icon-over-label grid (the column layout already exists at desktop, line 984), or a bottom tab bar with 5 primary items and a "More" sheet; at minimum add `scroll-snap-type: x mandatory`, a right-edge gradient mask, and `scroll-padding`.

### 2.3 Stats bar with 8 KPIs wraps into 3–4 ragged rows on phones — **Med / S**
Evidence: `.network-stats` is `display:flex; flex-wrap: wrap; justify-content:center` (line 867) with 8 children (lines 11940–11973) each `padding: 0.25rem 1.5rem` and a `border-right`; at ≤768 px padding drops to `0.25rem 0.75rem` (line 9068), at ≤480 px `0.25rem 0.5rem` (line 9177). Values are 1 rem JetBrains Mono.
Impact: "Total Supply 123.4M" and "Delinquent" rows wrap unevenly; the trailing `border-right` on the last item of each row looks like a dangling divider; the `.epoch-progress` bar below has 4 nowrap items (line 906–954) and squeezes the bar to its `min-width: 100px`.
Recommendation: `display:grid; grid-template-columns: repeat(4, 1fr)` at ≤768 px and `repeat(2, 1fr)` at ≤480 px, drop the `border-right` in favour of `gap`, and hide "Slot" and "Total Supply" on phones (they are the least actionable).

### 2.4 Globe canvas height is fixed 450/350 px and the country list is capped at 250 px — **Med / S**
Evidence: `.map-wrapper { height: 450px }` (line 2300), 350 px at ≤900 px (line 2868); `.map-sidebar { max-height: 250px }` (line 2879). The `.map-hint` says "Drag to rotate • Scroll to zoom" — on touch there is no scroll wheel and pinch-zoom is captured by three.js OrbitControls, so the page cannot be pinch-zoomed over the globe.
Recommendation: `height: min(450px, 60vw)`; hide `.map-hint` on `(hover: none)` or reword to "Drag to rotate • Pinch to zoom"; add `touch-action: pan-y` on the wrapper so vertical page scrolling still works when a finger lands on the canvas (0 `touch-action` uses today).

### 2.5 Terminal stake tooltip is `position:fixed; min-width:460px` — wider than a phone — **Med / S**
Evidence: `.vt-tip` lines 11538–11556; positioned in JS from mouse coordinates and shown on `mouseover` of `td.m` (line 35443). Similar hover-positioned popovers: `.perf-tooltip` (line 1497, `:hover` only), `.cred-tooltip` (3187), cooldown popover (23676), TPS bar tooltip (34022 `onmouseenter`).
Impact: 460 px on a 390 px viewport overflows off the right edge; on touch, `mouseover` fires on tap but the `scroll` listener (line 35458) hides it as soon as the user tries to scroll it.
Recommendation: `min-width: min(460px, calc(100vw - 2rem))`, clamp `left` to the viewport in the positioning code, and on `(hover: none)` open the same content as a bottom sheet on tap (the terminal already has a probe drawer, `vpOpenProbe`).

### 2.6 Inputs under 16 px trigger iOS Safari auto-zoom — **Med / S**
Evidence: `.search-input` 0.9 rem (line 1105), `.modal-search input` 0.9 rem (3543), `.redelegate-search-input` 0.9 rem (5874), `.skipmon-lookup-search input` 0.95 rem (9220), `.vt-tools input.search` 0.82 rem (11323), `select` 0.7 rem (line ~1902). Compare/calculator inputs are 1 rem and fine.
Impact: every tap into the main search box zooms the page ~15 % and leaves it zoomed after the keyboard closes; the Validator Terminal also auto-focuses its search 50 ms after render (line 35462), so simply opening the tab on iOS pops the keyboard and zooms.
Recommendation: `@media (pointer: coarse) { input, select, textarea { font-size: 16px } }`; guard the terminal auto-focus with `if (matchMedia('(hover: hover)').matches)`.

### 2.7 Compare table keeps a 120 px label column + 4 data columns at 600 px — **Med / S**
Evidence: `.compare-row { grid-template-columns: 120px repeat(var(--compare-cols,4), 1fr) }` at ≤600 px (line 7349), cell padding 0.75 rem, `.compare-table-container` has no `overflow-x`.
Impact: with 4 validators on a 390 px phone each data column is (390−32−120)/4 ≈ 60 px — numbers like "1,234,567.89 XNT" wrap or overflow.
Recommendation: wrap in `overflow-x:auto` with a sticky first column, or transpose to a stacked "one card per validator with the same metric order" layout under 600 px.

### 2.8 Touch targets below 44 px — **Med / S**
Evidence (computed heights from padding + font): `.copy-address-btn` padding 0.2 rem × 0.35 rem (line 3010, ~24 px); `.vp-copy` 0.05 rem × 0.4 rem, 0.65 rem font (11740, ~16 px); `.globe-btn` 30 × 30 px (2382); `.chart-toggle-btn` 0.5 rem/0.75 rem font (2163, ~28 px); `.calc-nav-btn` at ≤768 px 0.5 rem/0.75 rem (8996, ~30 px); `.leaderboard-cat-btn` at ≤768 px 0.5 rem/0.8 rem (6965, ~32 px); terminal filter buttons and `th` sort headers 10 px padding / 0.7 rem (11419); `.tab` at ≤768 px ~39 px.
Recommendation: add `min-height: 44px` (or a transparent `::before` hit area) on these under `(pointer: coarse)`; the terminal `th` sort targets need `padding: 12px 10px`.

### 2.9 `100vh`/`85vh`/`90vh` modals on mobile Safari — **Low / S**
Evidence: 26 `vh` uses, 0 `dvh`; `.modal { max-height: 85vh }`, `.manage-modal` 90 vh → 95 vh at ≤768 px (line 6612), `.disclaimer-modal` 90 vh (line 546). `body { min-height: 100vh }` (line 147).
Impact: the iOS URL bar makes 100 vh taller than the visible area, so the first-visit disclaimer's "Accept & Continue" button and the manage-modal footer can sit under the browser chrome.
Recommendation: `max-height: 85dvh` with the `vh` value as a fallback line above it; add `env(safe-area-inset-bottom)` padding to modal footers.

### 2.10 Hover-only interactions with no tap equivalent — **Med / M**
Evidence: `.perf-score-wrapper:hover .perf-tooltip` (line 1514) — the score breakdown that explains *why* a validator scored X is hover-only; `.cred-tooltip` (3187); `table.vt-data thead th` `tip:` strings (line 36830 ff.) are `title` attributes (83 `title=` in total) which never show on touch; leaderboard rows/cards use `:hover` colour changes as the only affordance.
Recommendation: make the perf-score wrapper a `<button aria-expanded>` that toggles the tooltip on click/Enter as well as hover; replace column `title`s with a tappable "ⓘ" that opens the same text in the existing `.vt-tip` container.

### 2.11 Header collapses to a centred stack; XNT pill + 3 links + logo take ~130 px before content — **Low / S**
Evidence: `header { flex-direction: column; gap: 1rem; padding: 1rem }` at ≤768 px (line 9037); logo 2.25 rem (line 236); `.logo-subtitle` hidden; `.header-links` 3 links + `#xntPillSlot`.
Recommendation: single row with the logo left and a compact "menu" (links) right, or move "X1 Website / Launch My Validator / GitHub" to the footer on phones; keep the XNT pill next to the logo.

### 2.12 Five different tablet breakpoints — **Low / M**
Evidence: 980 px (vt, lines 11157/11190/11533), 900 px (map, compare, calc, skipmon: 2863/7329/7426/10939/11712), 768 px (header/tabs/leaderboard/calc/manage: 6610/6965/8996/9037), 760 px (skipmon epochs: 10914), 600/500/480 px assorted.
Recommendation: normalise to three tokens (`--bp-sm: 600px`, `--bp-md: 900px`, `--bp-lg: 1180px`) and make the Validator Terminal use them instead of its own 980.

---

## 3. Accessibility

### 3.1 No visible keyboard focus anywhere except text inputs — **High / S**
Evidence: 13 `outline: none` declarations (lines 1114, 1902, 2326, 3553, 5666, 5888, 6090, 6267, 7036, 7463, 8439, 9233, 11331), 0 `:focus-visible` rules, only `.search-input:focus` / `.stake-apy-period-select:focus` (1117, 1909) add a replacement box-shadow. Buttons (`.tab`, `.leaderboard-cat-btn`, `.calc-nav-btn`, `.modal-close`, `.primary`, terminal filter buttons) rely on the UA outline, but the `* { margin:0; padding:0 }` reset plus custom backgrounds leave many with no visible ring in Chrome/Safari.
Recommendation: one global rule `:where(button, [role=button], a, input, select, [tabindex]):focus-visible { outline: 2px solid var(--accent-cyan); outline-offset: 2px }` and delete the `outline: none` lines that have no replacement.

### 3.2 Clickable `<div>`s with no keyboard access or role — **High / M**
Evidence: 45 `<div … onclick>` in static HTML + JS-rendered `leaderboard-item` rows (lines 19623, 19779, 19953 → `lookupValidator(...)`), `validator-list-item-info` (22070), `compare-slot` (12276–12294), `account-row` (13087), `authority-badge` (13118), `vp-sus-row`, `vp-dot`; `tabindex` appears once in the whole file (country list, line 18776, which is done right: `role="button" tabindex="0"`). The global `[tabindex]` count is 1, `role=` 3.
Impact: keyboard and screen-reader users cannot open a validator from a leaderboard or compare slot at all.
Recommendation: render these as `<button type="button" class="…">` (they already look like cards — set `all: unset; display:block; width:100%` on the button) or add `role="button" tabindex="0"` plus an Enter/Space keydown handler as at line 18776.

### 3.3 Tab bar has no tab semantics or selected state — **Med / S**
Evidence: `.tabs` is a plain `<div>` of `<button class="tab">` (lines 11984–12013); 0 `aria-selected`, 0 `aria-current`, 0 `aria-controls`; the only `role="tablist"` is on the delegations segment (line 12215). The active tab is signalled by colour only.
Recommendation: `role="tablist"` on `.tabs`, `role="tab" aria-selected="true|false" aria-controls="lookupTab"` on the buttons, `role="tabpanel"` on the panels, and arrow-key navigation (10 lines). `switchTab` already has the single place to toggle `aria-selected`.

### 3.4 Modals: no `role="dialog"`, `aria-modal`, focus management or focus trap — **Med / M**
Evidence: ~51 modal containers; 0 `role="dialog"`/`aria-modal`; Escape closes some (9 handlers, e.g. line 34607) but not all (the send/withdraw/commission modals at 13280–13858 close only via overlay click or the × button); no `.focus()` on open except the terminal search (2 `.focus()` calls total); `inert`/focus-trap not used.
Impact: focus stays behind the overlay; screen readers keep reading the page underneath; Tab can leave the dialog.
Recommendation: a single `openModal(el)` helper that sets `role="dialog" aria-modal="true" aria-labelledby`, moves focus to the first control, traps Tab, restores focus on close, and sets `main.inert = true`. All 51 modals already go through a handful of `open…Modal()` functions.

### 3.5 Icon-only buttons have no accessible name — **Med / S**
Evidence: 3 `aria-label`s total (globe pause button line 12026, delegations tablist 12215, and one set dynamically at 18518). `.modal-close` buttons contain only `&times;` (lines 12880, 12906, 12965 …); `.copy-address-btn` (📋), `.vp-copy`, `.sm-refresh-btn` (↻), terminal `⧉` copy glyphs, `.tps-tx-copy`, `.tab-icon` emoji are announced as "clipboard", "black square" etc. The 7 nav tabs have emoji icons without `aria-hidden` (0 hits), so screen readers read "bar chart Validator Terminal".
Recommendation: `aria-label` on every icon-only control; `aria-hidden="true"` on decorative emoji spans; use `<span class="visually-hidden">` for labels where tooltips exist.

### 3.6 `--text-dim` (#5a5f68) fails contrast everywhere it is used — **Med / S**
Evidence (computed WCAG ratios): `--text-dim` on `--bg-primary` 2.95:1, on `--bg-card` 2.63:1, on `--bg-card-hover` 2.40:1 — all below 4.5:1 (AA) and below 3:1 (large text). It is used 174 times, including labels (`.perf-breakdown-label` line 4058), placeholders (1124), the footer disclaimer (12857), `.vp-copy`, and terminal `tr.ina` rows. `--text-secondary` (#8a8f98) passes at 5.2–5.8:1 but drops to 4.75 on hover cards. `--danger` #ff5252 on `--bg-card` is 5.28:1 (OK); `--border` #1e3050 is 1.3:1 so borders are nearly invisible on cards — purely decorative, fine, but also used for the epoch progress bar track.
The code already acknowledges this once (comment at line 6769: "Default --text-dim was too low-contrast").
Recommendation: raise `--text-dim` to `#7d838f` (4.6:1 on `--bg-card`) and keep a separate `--text-faint` for genuinely decorative uses; run the 162 `font-size ≤ 0.7rem` sites (11 px) through the same check — small + dim is the worst combination and it is the default in the terminal (`td.small` 10 px, `th` 0.7 rem, line 11412–11463).

### 3.7 No `prefers-reduced-motion` handling for a page with an always-rotating WebGL globe — **Med / S**
Evidence: 0 matches; globe `autoRotate = true` (line 18630), 14 `@keyframes` (spinners, pulses, `skipmon-pulse`, `slotPulseCurrent`, `accountsListPulse`), 24 `animation:` declarations, transitions on every hover.
Recommendation: `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important } }` plus `if (matchMedia('(prefers-reduced-motion: reduce)').matches) controls.autoRotate = false` — the pause button (`toggleGlobeRotation`) already exists.

### 3.8 Form labels not associated with controls — **Med / S**
Evidence: 25 `<label>` elements, only 2 with `for=` (disclaimer checkbox 11890 and one more); calculator labels like `<label>Select Your Validator</label>` (12337), `<label>Estimated APY (%)</label>` (12345) are siblings of their inputs, not wrappers. Search inputs rely on `placeholder` only (12056, 12268).
Recommendation: add `id`/`for` pairs (mechanical) and `aria-label` on the three search boxes.

### 3.9 Heading structure: the default view has no `<h1>`; emoji in headings — **Low / S**
Evidence: 5 `<h1>` (Network Live, Validator Lookup, My Data Center, Leaderboards, and one rendered by the terminal) but `#mapTab` — the landing view — has none; the Compare tab starts at `<h2>` (12261); Calculators has four `<h2>`s with emoji ("💰 Staking Rewards Calculator"); modal headers are `<h2>`/`<h3>` while the page is at `<h1>`. Only one `<h1>` should be present per view — `switchTab` could toggle a visually-hidden page `<h1>`.
Recommendation: give the globe view an `<h1>X1 Network</h1>` (also fixes §4.1), move emoji into `aria-hidden` spans.

### 3.10 Data tables lack `scope`, `caption`, and sortable headers are not buttons — **Low / M**
Evidence: 4 `<table>`, 26 `<th>`, 0 `scope=`; terminal `th.sortable` (line 11419) uses `cursor:pointer` + click, no `aria-sort`, not focusable. Charts (4 `<canvas>`) have no `aria-label`/text alternative. No `aria-live` region (0) for the live stats/leader feed, so screen readers never hear updates — arguably desirable for the 1 s ticker, but "Last updated" and error banners should announce.
Recommendation: `scope="col"`, `<button>` inside sortable `th` with `aria-sort`, `aria-label` on canvases summarising the series, `aria-live="polite"` on toast/error containers (`.toast-notification`, line 23045).

### 3.11 Missing `alt` on JS-rendered validator logos and no skip link / `<noscript>` — **Low / S**
Evidence: `<img class="compare-search-result-logo" src=…>` (20002), `<img class="compare-slot-logo" …>` (20121) and 2 more have no `alt`; 0 `<noscript>` (the page is blank without JS and the CSP frame-buster wipes the DOM when framed); no skip-to-content link.
Recommendation: `alt=""` for decorative logos (name is adjacent), `<noscript>` message with the GitHub link, and a `.skip-link` to `<main>`.

---

## 4. First-visit UX and information architecture

### 4.1 A first-time visitor lands on an unlabeled globe behind a legal wall, with no active tab — **High / M**
Evidence: `DOMContentLoaded` shows the full-screen Terms modal (line 31339) with a mandatory checkbox + "Accept & Continue" (11889–11895) before anything else; underneath, `#mapTab` is `active` (12016) but no nav `.tab` is, because the globe view has no nav button (the "Network" button opens `skipmonitor`, line 11985; the globe is only reachable via the logo → `goToHome()` → `switchTab('map')`, line 21998). The globe panel has no heading or one-line explanation; the only copy is "Drag to rotate • Scroll to zoom" and "Validators by Country".
Impact: a new operator sees a warning about "permanent, irreversible loss of funds", then a spinning globe, and has to guess that "My Data Center" is where they track their node. Nothing on screen says what the site is for.
Recommendation: (1) Make the disclaimer non-blocking for read-only use: show it as a dismissable banner and require acceptance only when connecting a wallet / signing (the risk it describes only exists there). (2) Give the landing view a hero: `<h1>X1 Validator HQ</h1>` + one sentence ("Track, compare and manage X1 validators — live from rpc.mainnet.x1.xyz") + the search box from the Lookup tab + a "Find my validator" CTA. (3) Add the globe to the nav (or fold it into Network Live as a second panel) so every view has an active tab.

### 4.2 No deep links: tabs, validators, leaderboards and compare sets are not shareable — **High / M**
Evidence: `location.hash`, `pushState`, `replaceState` — 0 occurrences; the only URL parameter read is `?debug=1` (line 14728). `switchTab(tab)` (20346), `lookupValidator(vote)` (used from leaderboards, 19623), `switchLeaderboard(cat)`, `addToCompare`, `vtOpen()` are all in-memory only. There are 10 "copy address" buttons but nothing copies a link.
Impact: for a community tool the primary growth loop is "here's my validator's page" in Discord/Telegram. Today every share is "go to x1valhq.xyz, click Validator Lookup, paste this address". Browser back/forward also does nothing (7 tabs, one history entry).
Recommendation: a ~60-line router: `#/lookup/<votePubkey>`, `#/leaderboard/<category>`, `#/compare/<a>,<b>,<c>`, `#/terminal`, `#/live`, `#/calc/staking`. `switchTab` calls `history.pushState`; `popstate` calls `switchTab` without pushing; on load parse the hash and call the matching loader after `loadNetworkStats()` resolves. Add a "Share" (copy link) button on the validator card and leaderboard header. Combined with §5.4 OG tags this is the single biggest reach improvement available.

### 4.3 The "find my validator → track it" path exists but is not signposted — **Med / S**
Evidence: Lookup tab help text "Browse all validators to find and add to your Data Center" (12068); validator card renders a `+ Add` button (17464); portfolio empty state "No validators yet / Browse Validators" (12112–12117). There is no path from the landing view, and nothing explains that "My Data Center" = "validators I'm watching, saved in this browser" (`localStorage['x1Portfolio']`). No "connect wallet to auto-detect my validator" (wallet connect lives only inside the Manage modal, line 13041).
Recommendation: hero CTA "Find my validator" → Lookup with the search focused; after a successful lookup, a one-time inline hint "Add to My Data Center to see it on every visit"; in the portfolio empty state add "or connect your wallet to find validators you have authority over" using the existing wallet code; note that the list is stored locally (and offer export/import — `exportPortfolio` does not exist today).

### 4.4 Naming: three things called "Network", "Data Center" vs "Portfolio", "Terminal" — **Med / S**
Evidence: nav "Network" (11985) → panel titled "Network Live" (11931); HTML comment "X1 Network Tab" for the globe (12015); `#portfolioTab` / `loadPortfolio` / `portfolioCount` in code vs "My Data Center" in UI (12098) and "Data Center" in help text; "Validator Terminal" (a hardware-quality/farmer-risk analysis table) vs "Validator Lookup" (a per-validator profile) — the word "Terminal" doesn't say what it does; "Skip Monitor" in code vs "Network Live" in UI.
Recommendation: pick one word per concept and use it in code, UI and URL: `Live` (skip monitor), `Globe` or `Map` (mapTab), `Lookup`, `My Validators` (the stake-holder audience says "portfolio", operators say "my validators"; "Data Center" is cute but opaque), `Leaderboards`, `Compare`, `Calculators`, and rename "Validator Terminal" to "Hardware Report" or "Network Health Table" with a one-line subtitle explaining farmer-risk.

### 4.5 Errors are mostly silent or misleading — **Med / S**
Evidence: `loadNetworkStats` catch only `console.error`s (15989) — the stats bar keeps showing `--` forever with no retry; `loadPortfolio` catch shows the empty state (18181–18184, "No validators yet"); `rpcCall` (15697) throws raw RPC messages (`data.error.message`) that reach `showError()`; the throttle/circuit breaker (14949+) has no UI — when it opens for 30 s the user just sees nothing happen. The Validator Terminal is the exception (good stall/retry/banner work from the last session, 35539). There is also no `navigator.onLine` / offline banner (0 hits).
Recommendation: one global status strip under the header (`aria-live="polite"`) driven by the throttle: "RPC busy — retrying in 12 s", "Public RPC rate-limited, some data may be stale", "You're offline". Distinguish "empty" from "failed" states in every tab (portfolio, leaderboards, compare search "Loading validators…" at 19985 should time out to an error). Add a Retry button wherever `--` persists > 10 s.

### 4.6 Number and time formatting is inconsistent — **Med / M**
Evidence: 14 different format helpers (`formatNumber`, `formatCompact`, `formatStake`, `formatXntCompact`, `fmtXNT`, `fmtNum`, `fmtPrice`, `fmt`, `formatDate`…); `formatStake` (15615) gives `1.23M / 12.3K / 123` (0 decimals under 1 K), `fmtXNT` (35347) gives `1,234.56`, calculators use `toFixed(2)`/`toFixed(4)` (71 and 12 sites), rewards use `toFixed(6)` (5 sites); 82 hard-coded `1e9` lamport divisions. Times: "Last updated: HH:MM:SS" via `toLocaleTimeString()` (17857, 18145 — local, no tz label), skip-monitor and TPS in explicit `UTC` (32379, 33808), terminal in ISO `… UTC` (35036), score tooltip via `toLocaleString` (17338).
Impact: the same stake shows as "1.2M", "1,234,567.89" and "1234567.8900 XNT" across tabs; an operator comparing "Last updated 03:12:44" (local) with "Generated 01:12 UTC" has to do timezone maths.
Recommendation: a single `fmt` module: `xnt(lamports, {compact|full})`, `pct(x, 1)`, `int(n)`, `time(date)` that always renders local time with the tz abbreviation ("03:12 PDT") and the relative age ("2 min ago") in a `title`. Replace the 82 `/1e9` with `LAMPORTS_PER_XNT`.

### 4.7 Hidden features are undiscoverable — **Low / S**
Evidence: `/` focuses terminal search, `Esc` closes (only mentioned inside the terminal toolbar, 35169); `?debug=1`; "Click a country to fly there" hidden under 900 px (`.map-hint-long`, 2872); the per-country filter, the Slot Explorer modal, TPS modal (expand icon), epoch timeline ("Past 6 ↗"), reward breakdown, delegations source toggle, and the terminal's Deep/Lag column groups are all reachable only through small icons or hover.
Recommendation: a "?" help popover per tab listing what's clickable; an "About / How scores work" page (SCORING-DEPLOYMENT.md content) linked from the perf-score tooltip and footer.

### 4.8 Portfolio (My Data Center) lives only in one browser's `localStorage` with no warning or export — **Low / S**
Evidence: `x1Portfolio` key; no export/import/share; "Clear All" (12105) has a confirm? (not verified) but no undo.
Recommendation: "Your list is saved in this browser only" note in the empty state; Export/Import JSON buttons (10 lines); a share link (`#/portfolio/<a>,<b>`) once §4.2 exists; `confirm()` + undo toast for Clear All.

---

## 5. Visual design

### 5.1 No Open Graph / Twitter / description meta — links unfurl as a bare URL — **High / S**
Evidence: `<head>` (lines 3–120) has `<title>X1 Validator Headquarters</title>` and a viewport tag; 0 `og:`, 0 `twitter:`, 0 `name="description"`, 0 `canonical`.
Recommendation: add `description`, `og:title/description/image/url/type`, `twitter:card=summary_large_image`, `canonical=https://x1valhq.xyz/`; ship a 1200×630 `og.png` (globe screenshot + logo). Pairs with §4.2 for per-validator previews (needs a static prerender or a tiny Worker — out of scope for Pages alone, but the site-level card is free).

### 5.2 Branding: favicon is a 32 px SVG data-URI with Arial text; no touch icon, manifest or theme colour — **Med / S**
Evidence: line 95; 0 `apple-touch-icon`, 0 `manifest`, 0 `theme-color`. The logo mark used in-page is the two-tone "X1" with `Space Grotesk` (lines 11903–11905) and a webp base64 logo exists at 27527.
Recommendation: export the in-page mark as `favicon.svg` + `icon-192.png`/`icon-512.png`/`apple-touch-icon.png`, add `manifest.webmanifest` (name, `display: standalone`, `background_color: #0a1020`, `theme_color: #0a1020`) — makes the site installable and consistent in tabs/bookmarks.

### 5.3 Colour system: 16 tokens declared, 45 hex + 206 rgba literals actually used — **Med / M**
Evidence: `:root` tokens (lines 122–138) define 2 accents (blue/cyan) + gold + status colours; the CSS then hard-codes Solana purple/green (`#9945ff`, `#14f195` ×5, used for the Solana-network toggle), medal colours (`#ffd700/#c0c0c0/#cd7f32`), amber variants (`#ffc107`, `#ff9800`, `#ffb74d`, `#d97706`, `#f59e0b`), extra cyans (`#00e5ff`, `#03e1ff`, `#00ffa3`), `#dc1fff`, six near-duplicate navy backgrounds (`#0a1628`, `#08101f`, `#0a1525`, `#0a1322`, `#16243d`, `#0d1a2e`), and 206 distinct `rgba()` alphas of the same blues.
Impact: subtle mismatches between tabs (e.g. warning is `#ffab00` in tokens, `#ffc107` in modals, `#f59e0b` in the terminal banner); impossible to theme or fix contrast in one place.
Recommendation: promote the recurring alphas to tokens (`--accent-blue-08`, `--accent-blue-30`, `--surface-1/2/3`), map the Solana palette to `--chain-alt-*`, and delete the one-off hexes. A 30-minute sed pass covers 80 %.

### 5.4 Radii, spacing and card styles vary per tab — **Low / M**
Evidence: 24 distinct `border-radius` values (0–12, 16, 20, 25, 50 %, 999 px, plus 5 asymmetric combos); cards use 8 / 10 / 12 / 16 px depending on tab (`.perf-breakdown-item` 8, `.tab` 10, `.vt-kpi` 12, `.modal` 16); pill buttons are 20 px (`.calc-nav-btn`) vs 999 px (`.vp-copy`) vs 6 px (`.chart-toggle-btn`).
Recommendation: `--r-sm: 6px; --r-md: 10px; --r-lg: 16px; --r-pill: 999px` and a `.card` base class; the Validator Terminal KPI cards (line 11196) and the network stats box (867) are the two best-looking card styles — standardise on one.

### 5.5 The Validator Terminal has a parallel `--vt-*` token layer and its own type scale — **Low / M**
Evidence: `.vt-overlay` (lines 10951–10985) redefines 17 `--vt-*` tokens that alias the site tokens (`--vt-amber: var(--accent-cyan)` — a leftover from an amber Bloomberg theme), sets `font-size: 12px` at the root while the rest of the site uses rem, its own `::selection`, its own breakpoint (980), its own spinner (`vt-spin`), and a 2 rem `<h1>` while other tabs use `.search-section h1`. The `.vt-tip` uses `JetBrains Mono` at 10.5–12.5 px.
Impact: visibly denser and smaller than every other tab; the "moved stats bar" trick (`#vtStatsSlot`, `switchTab` line 20353) is a symptom of the terminal not sharing the page grid.
Recommendation: collapse `--vt-*` to the site tokens (they already alias them), adopt rem sizes with a `--density: compact` modifier class, and use the standard `.search-section` header so the stats bar doesn't need to be re-parented.

### 5.6 Three font families, six weights; SF Mono fallback inconsistently declared — **Low / S**
Evidence: `'Space Grotesk'`, `'JetBrains Mono'`, `'SF Mono'` (one site); 192 `font-family` declarations, many repeating the full stack instead of inheriting. Monospace is used for all numbers (good, with `tabular-nums` in the terminal only — line 11229).
Recommendation: `--font-ui` / `--font-mono` tokens, `font-variant-numeric: tabular-nums` globally on `.network-stat-value`, `.stat-value`, tables; drop weight 700.

### 5.7 Dark-mode only, no light theme or high-contrast variant — **Low / L**
Evidence: 0 `prefers-color-scheme`; the palette is hard-coded dark; `color-scheme` not declared (native `<select>`/scrollbars render light on some platforms — the code styles `::-webkit-scrollbar` at 152 but not Firefox).
Recommendation: not a priority for this audience, but add `<meta name="color-scheme" content="dark">` and `:root { color-scheme: dark }` (1 line) so form controls and scrollbars match; if a light theme is ever wanted, §5.3 tokenisation is the prerequisite.

### 5.8 Decorative background lines and radial gradient on `body` — **Low / S**
Evidence: `.bg-pattern` with three rotated `position: fixed` lines (170–208) and a `radial-gradient` body background (145).
Impact: fixed full-height elements cost a compositor layer each on mobile; harmless on desktop. The header's `z-index: 10` and 51 modals with `z-index` up to 100010 suggest layering has been patched repeatedly.
Recommendation: `will-change: transform` is absent (good); consider hiding `.bg-pattern` under 768 px and defining a z-index scale (`--z-header: 10; --z-tip: 1000; --z-modal: 2000; --z-toast: 3000`).

---

## Suggested order of work

1. Quick wins list (one afternoon): `defer`, meta/OG/manifest, focus ring, tab active state, terminal table overflow, tooltip min-width, iOS input size, reduced-motion, error state for portfolio.
2. Hash router + share links (§4.2) and a landing hero with the search box (§4.1) — the two changes most likely to bring new operators in and keep them.
3. Startup diet (§1.3, §1.4, §1.8): stats bar in one round-trip, everything else deferred/cached; lazy web3.js and Chart.js (§1.1).
4. Mobile nav + stats grid (§2.2, §2.3) and terminal card layout (§2.1).
5. Keyboard/ARIA pass on tabs, modals and clickable divs (§3.2–3.5).
6. Token consolidation (§5.3–5.5) when the next visual change is planned anyway.
