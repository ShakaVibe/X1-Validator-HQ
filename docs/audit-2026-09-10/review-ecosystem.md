# X1 Validator Ecosystem Review — competitors, gaps, and opportunities for X1 Validator HQ

*Researched 2026-09-10 (web only: WebSearch + WebFetch). Complements `review-features.md` (internal feature inventory). Everything below is cited; where a page was client-rendered and its body could not be read, that is stated rather than guessed.*

---

## 0. TL;DR

- The X1 validator-tool landscape is small: **one official explorer**, **one official delegation portal**, **one long-standing community leaderboard (x1val.online)**, **one CLI manager (X1 Console)**, and a handful of newer analytics sites (x1.ninja / Capy-Mon, x1watch, X1 Galaxy, FortiBlox). No Grafana dashboard, no public Discord bot, and only one (tiny, 0-star) Telegram alert repo were found.
- **x1valhq.xyz is already the most feature-rich site in the category** and is cited by the ecosystem's news site as the "percentile, self-stake and delegation status terminal" ([x1report.com/x1-validators](https://x1report.com/x1-validators)). Nobody else has: a 7-component transparent score, a live leader/skip monitor, portfolio ("My Data Center"), compare, four calculators, a hardware/fleet forensics tool, and full on-chain stake/vote management in one place.
- The biggest gaps versus others: **no delegation-program eligibility view** (x1.ninja Capy-Mon and the Foundation portal have it), **no per-validator history graphs / ISP column** (x1val.online), **no alerts** (X1 Console has a Telegram bot; nobody has hosted alerts), **no public per-validator URL**, and **no Foundation delegation amount shown per validator**.
- The Foundation delegation criteria are **not in the public docs**. The portal ([delegation.x1.xyz](https://delegation.x1.xyz/)) has an Info/FAQ page that is client-rendered and unreadable here. Best available secondary sources: x1report (June 2026) says six hard requirements incl. **3,000 XNT min self-stake, commission ≤10%, P85 performance percentile, version currency, liveness**; x1.ninja's release notes (Aug 15 2026) say the Foundation's live `/v1/config` now reports **5,000 XNT** min self-stake and exposes a `failingCriteria` array per validator via a delegation API. Confirm the endpoint with X1 Labs before building the eligibility checker (§6).

---

## 1. X1 network state (what the dashboard should track)

| Item | Value | Source |
|---|---|---|
| Mainnet launch | 6 Oct 2025 ("already has over 1,000 validators participating" — docs claim; live counts are lower) | [docs.x1.xyz](https://docs.x1.xyz/) |
| Mainnet reboot | "Buenos Aires" reboot: ledger backtraced to epoch 10 (= new genesis point); stakes delegated after epoch 11 had to be re-delegated; validators told to confirm they appear on x1val.online / FortiBlox explorer | [docs.x1.xyz/validating/mainnet-buenos-aires-reboot](https://docs.x1.xyz/validating/mainnet-buenos-aires-reboot.md) |
| Client | **Tachyon** (`tachyon-validator`, repo `x1-labs/tachyon`, Solana/Agave fork). Testnet-era name was **Xolana** (`FairCrypto/agave-xolana`, `jacklevin74/xolana`). No GitHub Releases are published — "There aren't any releases here" — so version detection must come from gossip (`getClusterNodes`) not GitHub. | [github.com/x1-labs/tachyon/releases](https://github.com/x1-labs/tachyon/releases), [github.com/x1-labs](https://github.com/x1-labs) |
| Current mainnet version | **v3.1.14** (stability release: accounts index fully in memory / on-disk index deprecated, hardened shred insertion, IPv6 filtering + CRDS pruning, `getProgramAccounts` rejects malformed filters, three deprecated startup flags must be removed; upgrade asked "once delinquent stake is below 5%"). Article lastmod 2026-07-09. | [x1report tachyon v3.1.14](https://x1report.com/article/tachyon-v3-1-14-validator-upgrade-x1-mainnet), [x1report validators page](https://x1report.com/x1-validators) |
| Next: **v4.0** | "Twelve feature gates, activated roughly one per epoch" (Nick Pettas roadmap, 1 Sep 2026): p-token (token transfer CU 4,645 → 76), **stake program v5 with 1 XNT minimum stake** ("would have blocked 43% of X1's existing stake accounts"), BLS12-381 / BN254 syscalls (Alpenglow-class consensus groundwork). | [x1report v4.0 feature gates](https://x1report.com/article/x1-v4-feature-gates-simd-p-token-stake-v5) |
| Live cluster numbers (api.x1.xyz `/v1/cluster`, 2026-09-10) | epoch **372**, slot 77.9 M, **588 current / 137 delinquent validators**, 612 gossip nodes, 343 block producers this epoch, activated stake ≈ 1.008 B XNT (lamports 1007920405787998500), total supply ≈ 1.072 B XNT, `epochDuration` ≈ 79,509 s (~22 h), 2.72 slots/s, TPS 1,601, epoch skip rate 0.004 %, all-time skip 0.57 %, avg vote latency 0.28 slots | [api.x1.xyz/v1/cluster](https://api.x1.xyz/v1/cluster) |
| Independent view | "588 active validators voting this epoch, 664 independent community operators, 10 Foundation-run nodes, 992.57 M XNT active stake (92.55 % of supply), 0.00 % delinquent stake, 10 % median commission" | [x1report.com/x1-validators](https://x1report.com/x1-validators) |
| Economics | Inflation starts 8 %, −15 %/yr toward 1.5 %; validators do not pay for votes ("zero-cost votes"); ~5 USD/day running cost claim; four revenue streams: voting rewards, commission, block rewards (leader must get >2/3 stake-weighted confirmation), bootstrap bonus | [docs validator-rewards](https://docs.x1.xyz/validating/validator-rewards), [docs zero-cost-votes](https://docs.x1.xyz/technicals/zero-cost-votes.md) |
| Stake cool-down | x1.ninja: "at each epoch boundary, ~9% of the cluster's effective stake gets distributed proportionally among all stake accounts that are cooling down" (our Unstaking calculator says 25 % max — worth reconciling against on-chain `getStakeActivation`) | [x1.ninja/staking](https://x1.ninja/staking) |
| Liquid staking | Foundation stake pool = **pXNT** (via delegation.x1.xyz "Stake" tab, x1report guide); community pool **X1 Ripper Pool = rXNT** ([x1ripper.xyz](https://x1ripper.xyz/), @x1riperpool). Ripper Pool applies a "dynamic filtering" threshold (3,976.68 XNT at the time of the Capybara article). | [x1report guide](https://x1report.com/article/how-to-stake-xnt-get-liquid-pxnt), [Capybara article](https://x1report.com/article/project-capybara-x1-foundation-delegation-p85-threshold-3000-xnt) |
| Official endpoints | RPC `https://rpc.mainnet.x1.xyz`; entrypoints `entrypoint0..4.mainnet.x1.xyz:8001`; six known-validator pubkeys listed | [docs connect-validator](https://docs.x1.xyz/validating/connect-validator-to-x1-mainnet.md) |
| Community | Docs "Community" page lists 8 Telegram invite links (no names); x1report names **X1 Validators Army** (`https://t.me/+yT0VAcNPFqM3OGQ0`) as where upgrade notices land first, plus X1 World and Cyberdyne (builders). No Discord server surfaced in any search. | [docs community](https://docs.x1.xyz/validating/community), [x1report](https://x1report.com/x1-validators) |

**Implications for the dashboard:** track version adoption (3.1.14 vs older) from gossip rather than GitHub releases; add a v4.0 feature-gate tracker (one gate per epoch is a natural "what changed this epoch" feed); flag stake accounts < 1 XNT ahead of stake-v5; show delinquent count (137 is 19 % of the set — many are dead identities, worth separating "delinquent with stake" from "abandoned"); and surface the Foundation-vs-community stake split (10 Foundation nodes hold a large share).

---

## 2. Official X1 Foundation / X1 Labs tools

### 2.1 X1 Explorer — `explorer.x1.xyz` → `explorer.mainnet.x1.xyz`
- **Runs:** X1 Labs. Fork of the Solana Foundation explorer (`x1-labs/x1-explorer`, Next.js, 2,487 commits, last update Jan 2026 per org page). ([github](https://github.com/x1-labs/x1-explorer))
- **Shows:** blocks, transactions, accounts, a "Validators Overview" page (`/validators`) — standard Solana-explorer vote-account table (stake, commission, credits, version, delinquency). Page body is client-rendered; could not be read here beyond the title "Validators Overview | X1 Network". ([explorer.mainnet.x1.xyz/validators](https://explorer.mainnet.x1.xyz/validators))
- **Better than a typical dashboard:** canonical, official, deep-links every account/tx; x1report describes it as "Raw vote accounts, blocks and transactions".
- **Lacks:** history, scoring, portfolio, delegation-program info, geo, alerts.
- **Activity:** live (redirect target is `explorer.mainnet.x1.xyz`; repo updated Jan 2026).

### 2.2 X1 Foundation Stake Delegation Program portal — `delegation.x1.xyz` / `delegation.mainnet.x1.xyz`
- **Runs:** X1 Foundation ("© 2026 X1 Foundation"). Title "X1 Stake Pool"; meta "Apply to become a validator in the X1 Delegation Program".
- **Shows:** Home / **Stake** (Stake XNT / Unstake / Portfolio, wallet connect — this is the pXNT stake-pool UI) / **Info** / **FAQ** (categories: General, Technical, Rewards & Staking, Requirements). `delegation.mainnet.x1.xyz/?search=…` implies a searchable validator list. x1report describes the portal as showing "P85 threshold, rewards and program status". ([delegation.x1.xyz](https://delegation.x1.xyz/), [/faq](https://delegation.x1.xyz/faq), [/stake](https://delegation.x1.xyz/stake))
- **Known API surface (indirect):** x1.ninja's changelog says Capy-Mon "reads the official min self-stake from Foundation `/v1/config`" and "Eligibility uses `failingCriteria` from the delegation API". I probed `delegation.mainnet.x1.xyz/v1/config`, `/api/validators`, `api.x1.xyz/v1/config`, `/v1/delegations` etc. — all 404. **The exact host/path is unconfirmed**; ask TreeCityWes or X1 Labs. ([x1.ninja/release-notes](https://x1.ninja/release-notes))
- **Better:** it is the source of truth for eligibility; a validator's failing criteria are computed there.
- **Lacks:** anything beyond the program (no performance history, no comparison); FAQ/Info bodies are JS-rendered (not indexable, not linkable per question).
- **Activity:** live, 2026 copyright.

### 2.3 X1 Docs — `docs.x1.xyz`
- Validating section: create node, connect to mainnet, network upgrades (Tachyon 2.0 pages only — no page for 3.x), performance (hardware, ping, health check, IOPS, bandwidth), rewards (validator rewards, incentivized testnet rewards, **bootstrap bonus**), HW-wallet guides, cluster, community, misc commands. Full index: [docs.x1.xyz/llms.txt](https://docs.x1.xyz/llms.txt).
- **No delegation-program page exists in the docs.** The "Cluster" page embeds an "Active validators on X1 Blockchain" widget (likely x1val.online). ([cluster.md](https://docs.x1.xyz/validating/cluster.md))

### 2.4 Public REST API — `api.x1.xyz`
- Undocumented (root page is a bare title; `/docs`, `/openapi.json` 404), but used by x1valhq's Terminal and by x1.ninja. Confirmed endpoints and fields (2026-09-10):
  - `/v1/cluster` — epoch, slot, current/delinquent validators, gossipNodes, activated/delinquent stake, selfStake (current/prev/last10), supply, TPS, epochDuration, block production + skip rate (epoch & all-time), vote credits, blockRewards, avgVoteLatency. ([api.x1.xyz/v1/cluster](https://api.x1.xyz/v1/cluster))
  - `/v1/validators?limit=` — per validator: `nodePubkey`, `votePubkey`, `gossip`, `rpc`, `version`, `activatedStake(+Percentage)`, `stakeDelegations`, `selfStakeCurrentEpoch`, **`verifiedSelfStakeCurrentEpoch`**, `voteLatency`, `avgVoteLatency{Current,Previous,Last10}Epochs`, `skipRate{Current,Previous,Last10}Epochs`, `blocksProducedCurrentEpoch`, `skippedSlotsCurrentEpoch`, `region/country/city`, `active`, `delinquent`. ([api.x1.xyz/v1/validators?limit=2](https://api.x1.xyz/v1/validators?limit=2))
  - `/v1/stakes?limit=` — `votePubkey`, `stakePubkey`, `staker`, `withdrawer`, `amount`, `delegatedStake`, `activationEpoch`, `status`, **`stakePool` (object|null)**, embedded `validator`. ([api.x1.xyz/v1/stakes?limit=2](https://api.x1.xyz/v1/stakes?limit=2))
  - No `/v1/validators/{pubkey}` detail route (404). No delegation/eligibility fields in these responses.

---

## 3. Community tools (validator-facing)

### 3.1 x1val.online — "X1 SVM Mainnet Validators" (the de-facto community leaderboard)
- **URL:** [x1val.online](https://x1val.online/) (+ per-validator graph page `graphval.php?id=`; returned "Pinger Not Running!" with all-zero stats when fetched — that sub-tool looks broken/idle).
- **Runs:** community (the x1-wiki lists it as "XOLANA X1 Validator Leaderboard" from testnet days; operator not named on the page). It is the site the **official docs and X1 Console reference** for confirming your node is visible and for custom name/icon ("Validator customization … linked webpage for x1val.online display"). ([docs reboot page](https://docs.x1.xyz/validating/mainnet-buenos-aires-reboot.md), [x1console](https://github.com/BlackBeard085/x1console))
- **Shows:** header: Total Nodes 612, Block Producers 587, Network Ping 650 ms, "Last 6 hours (25 epochs)" window. Table: name/pubkey/website/socials, **credits (epoch + all-time)**, active stake (self-stake current & previous epoch, total), commission, **ISP**, version (mostly 3.1.14), **country flag**, per-epoch assigned slots / skipped / skip-rate for current and previous epoch. Sorted by stake; X1 Labs nodes top the list.
- **Better:** ISP column and all-time credits; lightweight, fast, familiar to every operator since testnet; validators can self-brand.
- **Lacks:** no scoring, no percentiles, no delegation-program status, no portfolio, no history charts that work, no eligibility, no share links, no mobile polish.
- **Activity:** live and current (epoch/version data fresh on 2026-09-10).

### 3.2 x1.ninja (TreeCityWes) — "Capy-Mon · Project Capybara — Validator Health Explorer" + Staking
- **URLs:** [x1.ninja](https://x1.ninja/), [x1.ninja/capy-mon](https://x1.ninja/capy-mon), [x1.ninja/staking](https://x1.ninja/staking), [x1.ninja/release-notes](https://x1.ninja/release-notes) (`tools.x1.ninja` redirects here).
- **Runs:** community — TreeCityWes (@TreeRootDev; Telegram t.me/TreeCityTrading). Data pipeline: [github.com/TreeCityWes/x1-val-stats](https://github.com/TreeCityWes/x1-val-stats) (Python + Solana CLI, GitHub Action every 6 h, `validators.json`, 18k commits, 0 stars).
- **Shows (Capy-Mon):** per-validator "health" against the Foundation program: self-stake vs network median, lifetime vote credits, skip rate, multi-node clustering, commission, version compliance; **official eligibility checks** ("Min self-stake and the rest of the eligibility list come from the live program config, not a snapshot"; eligibility = no `failingCriteria`); displays the official allocation rule **"30% base + 70% self-stake match, cap 100,000 XNT"**; an unofficial score `0.50 × Self-Stake vs Median + 0.50 × Lifetime Vote Credits − 0.20 × Multi-Node Dock × Performance Gate (skipRate)`. Staking page: stake/deactivate/withdraw to any validator, live "Available now / Still cooling" split per stake account, validator picker filtered to eligible validators.
- **Better:** the only community tool wired to the **Foundation's live program config and per-validator failing criteria**; the only place explaining the cool-down distribution mechanic; very active changelog (v0.5.0 Jan 24 2026 → v0.28.0 Sep 2 2026, ~60 releases).
- **Lacks:** validator focus is a side feature of a DEX/token screener; no leader/skip live view, no portfolio of validators, no calculators, no management of vote accounts, no geo, no per-epoch history charts per validator, heuristic score is opaque-ish.
- **Activity:** very high (release every 1–2 weeks; Capy-Mon updated Aug 15 2026).

### 3.3 X1 Console (BlackBeard085) — CLI validator manager
- **URL:** [github.com/BlackBeard085/x1console](https://github.com/BlackBeard085/x1console) (16 stars, 6 forks, 333 commits; shell + Node).
- **Runs:** community (BlackBeard, @BlackBeard_X1).
- **Shows/does:** install/start/restart, health check with auto-fix, balance & transfer for id/identity/vote/stake wallets, stake create/merge/split/activate/deactivate/withdraw, **Autopilot** (checks every 30 min, auto-restarts delinquent validators, 48 h counter), Auto-Pinger, Auto-Staker, **Auto-Updater** (updates within 48 h of bootstrap node releases, randomized timing), slot-leader tracking, vote success, latency, epoch time remaining, **Telegram bot notifications** for autopilot/autostaker, SSH/server hardening, authority manager (HW wallet), ledger backup, commission change ("first half of epoch only"), name/icon publishing to x1val.online, log rotation, reboot scheduling.
- **Better:** the only tool with node-side automation and a Telegram alert path; the on-ramp for "zero coding experience" validators (BlackBeard's tweet: "313 validators… set up with X1 Console"). ([tweet](https://x.com/BlackBeard_X1/status/1909522512498573709), [Telegram bot tweet](https://x.com/BlackBeard_X1/status/1929676480063127762))
- **Lacks:** no web UI, no network-wide view, no scoring, no delegation-program view.
- **Activity:** active ("Recent").

### 3.4 x1watch — `x1watch.xyz`
- **URL:** [x1watch.xyz](https://x1watch.xyz/). Meta: "x1watch — X1 Validator Dashboard … real-time monitoring of X1 network validators and miners: epochs, stake, delinquency and node health." Mobile-web-app capable, dark theme.
- **Runs:** unknown (no operator, GitHub or Telegram link in the fetched markup); body is client-rendered so columns could not be verified.
- **Better/lacks:** unknown beyond the meta description; "miners" suggests it also covers XenBlocks miners.
- **Activity:** domain resolves and serves an app in 2026; freshness unverified.

### 3.5 X1 Galaxy — `x1galaxy.io`
- **URL:** [x1galaxy.io](https://x1galaxy.io/) (store at store.x1galaxy.io sells Xenobi merch, so likely the **Xenobi** community; the old wiki lists `xenobi-x.one` as "X1 Validator Dashboard by xenobi", which no longer resolves).
- **Shows:** self-described "meta-X1 Staking Platform"; x1report calls it "Validator explorer and staking dashboard". Body is JS-only; features unverified.
- **Activity:** live domain; unknown freshness.

### 3.6 FortiBlox — explorer + services
- **URLs:** [explorer.fortiblox.com](https://explorer.fortiblox.com/) ("Comprehensive blockchain explorer for the X1 ecosystem … transactions, blocks, validators, and network performance"), [x1validator.com/validators](https://www.x1validator.com/validators) (services page: explorer + "Honey Badger" Telegram trading bot; "99.9% uptime target, 24/7 monitoring, documented APIs"), app.fortiblox.com (FortiSwap; `/validators` 404).
- **Runs:** FortiBlox ("day-one member of the Xen community"), community/commercial.
- **Better:** second independent explorer (named in the docs' reboot checklist alongside x1val.online); has an API offering.
- **Lacks:** validator page content could not be read (client-rendered); no scoring/eligibility known.
- **Activity:** live; FortiSwap article Aug 31 2026.

### 3.7 X1 Validator Management — `validator.x1.wiki` (xen_artist)
- **URL:** [validator.x1.wiki](https://validator.x1.wiki/). "Maintained by xen_artist". Mainnet/testnet/custom RPC; X1 Wallet + Backpack; generate/import identity, vote and stake accounts (seed or JSON keypair); validator search by name or address; delegate/merge/withdraw stake; set commission; init vote account with withdraw authority.
- **Better:** browser-based account *creation* (keypair gen with seed verification), which x1valhq does not do.
- **Lacks:** no monitoring, no metrics.
- **Activity:** live; author also maintains the (testnet-era) x1-wiki.

### 3.8 X1 Report — `x1report.com` (news + validator reference)
- **URLs:** [x1report.com/x1-validators](https://x1report.com/x1-validators), delegation guide (lastmod 2026-06-27), Project Capybara article (2026-06-24), Tachyon 3.1.14 (2026-07-09), v4.0 (2026-09-01), explorer comparison guide, RSS at `/rss.xml`.
- **Shows:** live header stats (588 active, 664 operators, 10 Foundation nodes, 992.57 M XNT staked, 0 % delinquent stake, 10 % median commission), Tachyon release notes, delegation criteria summary, 14-question validator FAQ, and a **tool table**: X1VAL ("Performance monitoring and uptime tracking"), **X1 Validator HQ ("Percentile, self-stake and delegation status terminal")**, X1 Galaxy ("Validator explorer and staking dashboard"), Foundation Delegation Portal ("P85 threshold, rewards and program status"), X1 Console ("Open-source validator management CLI"), X1 Explorer ("Raw vote accounts, blocks and transactions"). Its explorer guide compares X1 Prism, Validator HQ, X1SCR, Fortiblox, X1 Space, official explorer, X1 Ninja.
- **Activity:** daily (latest article 2026-09-10).

### 3.9 Smaller / dormant / dead
| Tool | Status | Source |
|---|---|---|
| `mattkrupnik/status` — "X1 Validator Status Checker": Node app, `/status` HTTP endpoint, Telegram alerts for healthy / lagging / offline, slot metrics. 14 commits, 0 stars. | Exists, minimal adoption | [github](https://github.com/mattkrupnik/status) |
| `JozefJarosciak/X1-validator-installer` — one-command installer | Testnet-era; still referenced | [github](https://github.com/JozefJarosciak/X1-validator-installer) |
| `TreeCityWes/Xolana-Scripts` | Testnet-era scripts | [github](https://github.com/TreeCityWes/Xolana-Scripts) |
| `mardzinex.link/X1_beta_validators` — "X1 Mainnet-beta Validators" | DNS does not resolve | search result only |
| `x1node.com` ("Validator dashboard; stake XNT") | TLS/unreachable | [x1-wiki](https://github.com/xenartist/x1-wiki/blob/main/X1.Wiki%20-%20A%20Simple%20Wiki%20Page%20of%20X1%20Blockchain%20XEN%20Crypto%20Ecosystem.md) |
| `xenobi-x.one` ("X1 Validator Dashboard by xenobi") | DNS does not resolve (successor appears to be x1galaxy.io) | x1-wiki |
| `explorer.xolana.xen.network`, `xolana.hashhead.io`, `xen.pub/xblocks-nodes.php` (nodes map) | Testnet-era explorers / XenBlocks map | x1-wiki |
| `x1prism.com` — portfolio tracker "without connecting your wallet" | Live, wallet/asset focus, no validator features found | [x1prism.com](https://x1prism.com/) |
| `x1blockchainguide.com` — step-by-step validator guide | Static guide | [site](https://www.x1blockchainguide.com/) |
| Grafana dashboards for X1/Tachyon | **None found** (only generic Solana dashboards, e.g. grafana.com 14625) | searches |
| Discord bots / X1 Discord server | **None found** | searches |
| "X1 Space" (named in x1report's explorer guide) | URL not found in any search | — |

---

## 4. Delegation-program criteria (what could be verified)

**Primary source status:** the Foundation portal's Info/FAQ ([delegation.x1.xyz/info](https://delegation.x1.xyz/info), [/faq](https://delegation.x1.xyz/faq)) is client-rendered — only the category headers (General / Technical / Rewards & Staking / Requirements) and "Everything you need to know about the X1 Foundation Stake Delegation Program" were retrievable. **docs.x1.xyz has no delegation-program page.** Treat the following as secondary-sourced and confirm before hard-coding.

### 4.1 Foundation Stake Delegation Program (secondary sources)
From [x1report.com/x1-validators](https://x1report.com/x1-validators) (page dated 2026-09-10; guide lastmod 2026-06-27):
> "Six hard requirements reset at each epoch boundary." Two named in full: **"3,000 XNT minimum self-stake" per Project Capybara (includes community delegations already received)** and **"Commission at or below 10%" checked every epoch**. "The remaining criteria cover performance percentile (P85 threshold), version currency and liveness." "Failure triggers immediate delegation removal with no grace period." Checks are "automated epoch-boundary checks against six criteria".

From the Capybara article meta ([x1report](https://x1report.com/article/project-capybara-x1-foundation-delegation-p85-threshold-3000-xnt), lastmod 2026-06-24):
> "X1 Foundation delegation now requires 3,000 XNT minimum self-stake. New formula rewards self-stake above the network average, with dynamic Ripper Pool filtering currently at 3,976.68 XNT."

From x1.ninja release notes ([x1.ninja/release-notes](https://x1.ninja/release-notes)):
> v0.12.0 (May 3 2026): "The X1 Foundation replaced the previous 1,000 XNT floor plus dynamic top-85% self-stake cutoff with a flat 3,000 XNT minimum."
> v0.20.1 (Aug 15 2026): "Capy-Mon now reads the official min self-stake from Foundation /v1/config (**currently 5,000 XNT** — not the old 3,000 snapshot, and not empirical p85). Eligibility uses **failingCriteria** from the delegation API."

From Capy-Mon ([x1.ninja/capy-mon](https://x1.ninja/capy-mon)): official allocation **"30% base + 70% self-stake match, cap 100,000 XNT"**; criteria categories it checks: minimum self-stake, commission cap, skip-rate limit, client version, multi-node clustering, delinquency.

**Reconciled best-guess rule set (label as "unofficial, confirm with Foundation"):**
1. Self-stake ≥ program minimum (**5,000 XNT as of Aug 2026**; was 3,000 from ~May/June 2026; before that 1,000 XNT + top-85 % cutoff). Self-stake definition appears to include community delegations received (x1report) — api.x1.xyz exposes both `selfStakeCurrentEpoch` and `verifiedSelfStakeCurrentEpoch`.
2. Commission ≤ 10 %.
3. Performance percentile ("P85") — metric not published; likely vote credits and/or skip rate relative to the set.
4. Running the current Tachyon release (3.1.14 today).
5. Liveness: not delinquent.
6. Sixth criterion unspecified in public sources; Capy-Mon's "multi-node clustering" check suggests an anti-Sybil/one-operator rule (the Bootstrap Bonus rule is ≤10 validators per entity).
- Allocation: 30 % base + 70 % match of self-stake, capped at 100,000 XNT per validator; re-evaluated every epoch (~22 h); removal is immediate.

### 4.2 Bootstrap Bonus (official, docs)
Source: [docs.x1.xyz/validating/validator-rewards/bootstrap-bonus](https://docs.x1.xyz/validating/validator-rewards/bootstrap-bonus)
- Base reward "distributed proportionally based on credits earned"; **+16 % performance bonus** for validators meeting all criteria.
- Self-stake **min 1,000 XNT**, bonus applies only to the **first 10,000 XNT**.
- Active validator; **commission ≤ 10 %**; **vote credits ≥ 97 % of network average**; **skip rate ≤ 10 % above network average**; "dynamic majority-version rule" compliance.
- **Max 10 validators per individual/entity**; Sybil → disqualification. Status "active until further notice"; activation "pending X1's initial launch configuration".
These five checks are fully computable today from `getVoteAccounts` + `getBlockProduction` + `getClusterNodes` and are a safe first eligibility checker while the Foundation criteria are confirmed.

### 4.3 Incentivized testnet rewards (official, historical)
50,000 credits = 1 XNT; 10 % claimable at genesis, 90 % vests over 365 days proportional to uptime; unvested forfeited after 365 days (i.e. ~Oct 2026 — worth a countdown for testnet-era operators). ([docs](https://docs.x1.xyz/validating/validator-rewards/incentivized-testnet-rewards.md))

---

## 5. Comparison

### 5.1 Features others have that x1valhq.xyz lacks
| Feature | Who has it | Notes |
|---|---|---|
| **Delegation-program eligibility per validator** (official failing criteria, live min self-stake) | x1.ninja Capy-Mon; Foundation portal | Highest-value gap. x1report already credits us with "delegation status" — the Terminal shows Foundation XNT per validator but not pass/fail or "how far from eligible". |
| **Foundation delegation amount & allocation math** ("30 % base + 70 % match, cap 100k") | Capy-Mon, portal | We show foundation stake held; we do not show entitlement or headroom. |
| **ISP / hosting-provider column** and ASN concentration | x1val.online | Cheap from gossip IP → ipwho.is (already used for geo). |
| **All-time credits** and previous-epoch self-stake | x1val.online | `cumulativeVoteCredits` is in `/v1/cluster`; per-validator all-time credits via `getVoteAccounts.epochCredits` history. |
| **Node-side alerts (Telegram)** on delinquency / restart | X1 Console, mattkrupnik/status | Nobody offers hosted, no-install alerts — open lane. |
| **Auto-update / auto-restart** | X1 Console | Out of scope for a web app; but we could show "N validators still on old version" + link to Console. |
| **Account creation** (identity/vote/stake keypair generation in browser) | validator.x1.wiki | Our Manage suite starts from an existing vote account. |
| **Stake cool-down "Available now / Still cooling" per stake account** | x1.ninja/staking | We compute cooldown inside Manage; not surfaced in the Data Center. |
| **Liquid-staking pool views** (pXNT / rXNT: which validators the pools delegate to and how much) | Foundation portal (own pool), Ripper Pool site | `/v1/stakes.stakePool` already gives the pool tag. |
| **Release notes / changelog & version pages** | x1.ninja, x1report | Operators trust tools that publish what changed. |
| **News/upgrade notices** (Tachyon releases, v4 feature gates) | x1report | An RSS pull from x1report.com/rss.xml is a 20-line feature. |
| **Official explorer deep-links** | everyone | Every pubkey on our site should link to `explorer.mainnet.x1.xyz/address/<pk>`. |

### 5.2 Differentiators only x1valhq.xyz has (double down)
1. **Transparent 7-component canonical score** with published weights and hourly server-side computation — no other X1 tool has a documented score (Capy-Mon's is a 4-term heuristic).
2. **Live Network / leader-slot / skip monitor** (3-s polling, recent-slots grid, live skip feed, top skippers, per-validator scorecards, Slot Explorer) — nothing comparable exists on X1.
3. **Validator Terminal** — self-stake vs Foundation vs community breakdown for all ~724 validators with percentile row (P50–P99) — this is literally what x1report cites us for.
4. **My Data Center portfolio** with combined rewards, earnings trend, reward breakdown (commission / self-stake / Foundation / community).
5. **Compare (4-way)** and **7 leaderboards**.
6. **Four calculators** (rewards, compound, unstaking timeline, break-even) — unique on X1.
7. **Fleet / hardware forensics** (co-location, jitter, farmer-risk) — unique anywhere in the XEN ecosystem; relevant to the Foundation's multi-node criterion.
8. **Full on-chain management** (commission, identity, authorities, create/split/merge/redelegate/withdraw stake) with wallet — the only web tool that does both monitoring *and* management.
9. **3-D globe** with country filter.

### 5.3 What competitors do better in execution (worth copying)
- x1val.online: **instant load, one dense table, per-operator branding** (validators upload icons there). Our Terminal downloads 0.7 MB snapshot (fine) but Live is 13 MB.
- x1.ninja: **ships a dated changelog**, reads the Foundation config live rather than hard-coding thresholds, and explains mechanics in plain language on the page.
- x1report: **stable, linkable reference pages** (`/x1-validators`) that rank in search; we have no deep links or OpenGraph.

---

## 6. Ranked ideas (expected impact for validator operators)

| # | Idea | Why it wins | What to build | Sources / data | Effort |
|---|---|---|---|---|---|
| 1 | **Delegation Eligibility Checker** (per validator + portfolio) | It is *the* income lever; only Capy-Mon has it and it is buried in a DEX site. x1report already calls us the "delegation status terminal" — finish the job. | Card + Terminal column: pass/fail per criterion with the number (self-stake vs min, commission, percentile rank, version, delinquent, multi-node flag), "eligible / failing: X" badge, **headroom** ("add 1,240 XNT to qualify"), and estimated allocation (`30 % base + 70 % match, cap 100k`). Store criteria in a versioned `data/delegation-criteria.json` with source + date so they can change without code; poll the Foundation `/v1/config` once the endpoint is confirmed. Ship the **Bootstrap Bonus** checker (official, fully specified) in the same UI. | §4; api.x1.xyz `verifiedSelfStakeCurrentEpoch`, `/v1/stakes.stakePool`; `scores.json` | M |
| 2 | **Hosted alerts (Telegram bot first, Discord webhook second)** for delinquency, version lag, commission change, skip spike, stake drop, **eligibility loss** | No hosted alerting exists on X1; X1 Console's bot requires running its scripts on the node. Retention driver #1. | `/watch <vote>` Telegram bot; hourly Action already computes everything; add a 5-min heartbeat job on `getVoteAccounts`. | review-features.md B.1 #1 | L (M Telegram-only) |
| 3 | **Per-validator history charts** (stake, credits, skip, latency, score, commission, Foundation stake) over epochs | x1val's graph page is broken ("Pinger Not Running"); nobody has working history. | Extend hourly Action to append per-epoch rows; Chart.js already loaded; api.x1.xyz `*Last10Epochs` fields give an instant backfill. | `/v1/validators` | M |
| 4 | **Public validator profile URLs + OpenGraph share cards + embeddable badge** | Nothing on X1 is linkable per validator except the raw explorer; operators need something to show delegators and the Foundation. | Hash router `#/v/<vote>` + Action-generated static `/v/<vote>.html` with OG image; link every pubkey to `explorer.mainnet.x1.xyz`. | scores.json | M |
| 5 | **Version & upgrade tracker + v4.0 feature-gate feed** | Version is a delegation criterion and a score component; Tachyon has no GitHub releases, so operators rely on Telegram. | % validators / % stake per version from gossip, laggard list, "you are N behind"; "feature gate activated this epoch" panel; pull x1report RSS for upgrade notices. | `getClusterNodes`, x1report rss.xml | S |
| 6 | **ISP / ASN + co-location column and concentration view** | x1val has ISP; the Foundation's multi-node criterion and decentralization narrative make ASN/IP clustering valuable; our forensics already computes shared-IP. | Add ISP/ASN to `validator-locations.json` (ipwho.is returns `connection.isp/asn`); Terminal column; globe layer "by ISP"; surface forensics' co-location as a plain badge. | generate-geo.js | S |
| 7 | **Fleet health board in My Data Center** ("issues first" one-row-per-validator) | 10–20-validator operators (X1 Console users) cannot scan 20 tall cards; X1 Console users have no web view of their fleet. | Dense table: status, version vs latest, commission Δ, stake Δ, skip, latency, root distance, score/rank Δ, eligibility, next leader slot, last reward. | scores.json + getVoteAccounts | S–M |
| 8 | **Stake-pool & Foundation flow views** (pXNT / rXNT / Foundation: which validators, how much, added/removed per epoch) | Explains *why* stake moved; nobody visualizes pool delegation flows; Ripper Pool's dynamic threshold is a second "eligibility" operators care about. | Diff `/v1/stakes` snapshots by `stakePool` + withdrawer; "Delegations" leaderboard → add inflow/outflow columns; events feed. | data/terminal.json history | M |
| 9 | **Score coach ("+N points if…")** using the published anchor tables | Only we have a formal score; turning it into advice is a unique differentiator competitors cannot copy without a score. | Per component: current value, next anchor, point gain, concrete action; rank-impact preview. | scores.json | S–M |
| 10 | **Public data API + status page + changelog** | x1.ninja and x1-val-stats republish data; x1report scrapes; being the canonical, documented JSON source makes us the reference (and lets bots/Foundation consume the score). | Document `data/*.json`, add `data/status.json`, a `/changelog` page like x1.ninja's. | existing Actions | S |
| 11 | **Stake-v5 readiness & cool-down tracker** | v4.0's 1 XNT minimum "would have blocked 43 % of stake accounts"; stake-v5 arrives one gate per epoch. | Data Center: list stake accounts < 1 XNT per validator; surface `getStakeActivation` cooldown ETA per account (reuse Manage's `getStakeCooldownInfo`); reconcile our "25 %/epoch" text with x1.ninja's "~9 %" claim using observed data. | RPC | S |
| 12 | **Testnet-vesting countdown & Bootstrap Bonus panel** | 90 % of testnet rewards vest over 365 days from mainnet (≈ Oct 2026) and are forfeited after — a one-time but high-attention feature; Bootstrap Bonus criteria are official and computable. | Countdown + "criteria met?" panel on the card; links to docs. | docs | S |

Not recommended: a Grafana/Prometheus offering (none exists, but it is node-side and X1 Console covers that audience); building a DEX/token screener (x1.ninja owns it).

---

## 7. Source index
- Official: [x1.xyz](https://x1.xyz/) · [docs.x1.xyz](https://docs.x1.xyz/) · [docs llms.txt](https://docs.x1.xyz/llms.txt) · [validator-rewards](https://docs.x1.xyz/validating/validator-rewards) · [bootstrap-bonus](https://docs.x1.xyz/validating/validator-rewards/bootstrap-bonus) · [incentivized-testnet-rewards](https://docs.x1.xyz/validating/validator-rewards/incentivized-testnet-rewards.md) · [connect-validator-to-x1-mainnet](https://docs.x1.xyz/validating/connect-validator-to-x1-mainnet.md) · [mainnet-buenos-aires-reboot](https://docs.x1.xyz/validating/mainnet-buenos-aires-reboot.md) · [community](https://docs.x1.xyz/validating/community) · [explorer.mainnet.x1.xyz/validators](https://explorer.mainnet.x1.xyz/validators) · [delegation.x1.xyz](https://delegation.x1.xyz/) ([info](https://delegation.x1.xyz/info), [faq](https://delegation.x1.xyz/faq), [stake](https://delegation.x1.xyz/stake)) · [delegation.mainnet.x1.xyz](https://delegation.mainnet.x1.xyz/?search=ai) · [api.x1.xyz/v1/cluster](https://api.x1.xyz/v1/cluster) · [api.x1.xyz/v1/validators](https://api.x1.xyz/v1/validators?limit=2) · [api.x1.xyz/v1/stakes](https://api.x1.xyz/v1/stakes?limit=2) · [github.com/x1-labs](https://github.com/x1-labs) · [x1-labs/tachyon releases](https://github.com/x1-labs/tachyon/releases) · [x1-labs/x1-explorer](https://github.com/x1-labs/x1-explorer)
- Community: [x1val.online](https://x1val.online/) · [x1.ninja](https://x1.ninja/) · [x1.ninja/capy-mon](https://x1.ninja/capy-mon) · [x1.ninja/staking](https://x1.ninja/staking) · [x1.ninja/release-notes](https://x1.ninja/release-notes) · [TreeCityWes/x1-val-stats](https://github.com/TreeCityWes/x1-val-stats) · [BlackBeard085/x1console](https://github.com/BlackBeard085/x1console) · [x1watch.xyz](https://x1watch.xyz/) · [x1galaxy.io](https://x1galaxy.io/) · [explorer.fortiblox.com](https://explorer.fortiblox.com/) · [x1validator.com/validators](https://www.x1validator.com/validators) · [validator.x1.wiki](https://validator.x1.wiki/) · [x1ripper.xyz](https://x1ripper.xyz/) · [x1prism.com](https://x1prism.com/) · [mattkrupnik/status](https://github.com/mattkrupnik/status) · [JozefJarosciak/X1-validator-installer](https://github.com/JozefJarosciak/X1-validator-installer) · [xenartist/x1-wiki](https://github.com/xenartist/x1-wiki/blob/main/X1.Wiki%20-%20A%20Simple%20Wiki%20Page%20of%20X1%20Blockchain%20XEN%20Crypto%20Ecosystem.md)
- News/reference: [x1report.com/x1-validators](https://x1report.com/x1-validators) · [delegation guide](https://x1report.com/article/x1-foundation-stake-delegation-program-validator-guide) · [Project Capybara](https://x1report.com/article/project-capybara-x1-foundation-delegation-p85-threshold-3000-xnt) · [Tachyon 3.1.14](https://x1report.com/article/tachyon-v3-1-14-validator-upgrade-x1-mainnet) · [v4.0 feature gates](https://x1report.com/article/x1-v4-feature-gates-simd-p-token-stake-v5) · [explorer guide](https://x1report.com/article/x1-blockchain-explorer-guide-best-x1-explorers) · [rss](https://x1report.com/rss.xml) · [sitemap](https://x1report.com/sitemap.xml)
- Ours: [x1valhq.xyz](https://x1valhq.xyz/) · [ShakaVibe/X1-Validator-HQ](https://github.com/ShakaVibe/X1-Validator-HQ)
