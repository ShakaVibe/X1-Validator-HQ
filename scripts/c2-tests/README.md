# Offline browser tests

**Run everything with one command** (this is what CI runs, `.github/workflows/ci.yml`):

    npm i -g playwright            # once (Chromium must be installed for Playwright)
    NODE_PATH=$(npm root -g) node scripts/c2-tests/run-all.js "$PWD"

It runs every suite below (three at a time, about 1½ minutes), prints one line per suite and exits 1
if any failed. `--only apr,fleet` runs a few, `--jobs N` changes the parallelism. A suite that fails
is run once more; "passed on retry" marks a flaky suite.

The five oldest suites (cards, manage, modals, batch4, batch5) only print what happened and always
exit 0. `run-all.js` compares their output with `expected/<suite>.txt`; a difference fails the suite
and shows the differing lines. After an intended change, read the diff, then refresh the stored
output with `run-all.js "$PWD" --only <suite> --update` and commit it. For `csp-walk-test` the runner
reads the verdict lines (0 violations, positive control refused, no page errors).

The node suites need no browser: `node scripts/test-compute-scores.js`,
`node scripts/test-rewards-ledger.js`, `node scripts/test-alerts-bot.js`,
`node scripts/test-check-published-data.js` (the data check that runs before the bots publish).

## The suites

**C2 dispatcher (data-action)** — Playwright checks that every converted `data-action` control still
calls its function exactly once with the original arguments. Each script serves the repo
on localhost, aborts every external request, renders the real markup with mocked
state, replaces the target functions with spies and clicks through.

    node scripts/c2-tests/cards-test.js  /path/to/repo
    node scripts/c2-tests/manage-test.js /path/to/repo
    node scripts/c2-tests/modals-test.js /path/to/repo
    node scripts/c2-tests/batch4-test.js /path/to/repo   # card-details, leaderboards, skip-monitor
    node scripts/c2-tests/batch5-test.js /path/to/repo   # compare, terminal, forensics, calculators, wallet-tx, network-live, tabs
    node scripts/c2-tests/csp-walk-test.js /path/to/repo # strict CSP: walk every route + modals, 0 script-src violations, inline control refused

**index.html (batch 6)** is covered by a differential test instead: the page is loaded with
the pre-conversion index.html and with the converted one, every handler element is fired,
and the spied calls must match one for one:

    git show 03836c7:index.html > /tmp/o.html        # last commit before batch 6
    python3 scripts/c2-tests/convert-index.py /tmp/o.html /tmp/conv.html --instrument
    node scripts/c2-tests/index-diff-test.js "$PWD" /tmp/conv.orig.html /tmp/conv.html

Expected: 196 elements on both sides, 0 inline handlers left in the converted page, and one
known difference (#175 perfExplainerModal: now closed by the overlay rule instead of
`closePerfExplainerModal(event)` — same behaviour, see the 2026-09-23 session log).

Pass the repo as an absolute path (or `$PWD`) — a bare `.` makes the static server 404 everything.

Pass = every expected call listed once, `inline*: 0` in every container,
`page errors: []`, `[Actions] warnings: []`.

**Telegram alerts entry point (F3, 2026-09-28)** — `js/alerts.js` + `#alertsModal`:

    node scripts/c2-tests/alerts-modal-test.js "$PWD"

Opens My Data Center with a 2-validator portfolio, clicks "🔔 Telegram alerts" through the
dispatcher, checks the generated `/watch …` command, Copy (clipboard), ×/Escape/backdrop close,
the empty-portfolio hint and the 375 px layout. The bot itself is tested without a browser:
`node scripts/test-alerts-bot.js`.

**Fleet health (F4, 2026-10-13)** — `js/fleet.js` + `#fleetHealth` in My Data Center:

    node scripts/c2-tests/fleet-test.js "$PWD"

Feeds `fleetRender()` three validators (two real vote keys from `data/delegation.json`, one
invented delinquent node on an old version) and checks the severity sort, the v2 bar (artwork +
vector X1, status / sub lines, ring, Offline / Issues / Epoch), Details open/close + localStorage
memory across a reload, the Offline / Issues filters, row click and
Enter → `lookupValidator`, the all-healthy and empty states, the 375 px card layout, 0 inline
handlers, 0 page errors.

**Delegator APR (F11, 2026-10-13)** — `js/apr.js` + `.apr-section` tile + `#aprModal`:

    node scripts/c2-tests/apr-test.js "$PWD"

Renders real cards offline, lets the served `data/rewards.json` load and checks the 4 + 4 card
layout (APR in Earnings, Foundation delegation in Health, no Commission tile), the tile value
against the same formula run in node over the served ledger, the 7-epoch trend pill, the Details
modal (hero, network median / top 10 %, rows, × / Escape / backdrop), the 100 % and 0 % commission
paths, the no-history path, the 375 px modal, 0 inline handlers, 0 page errors. The ledger
builder's `st` / `c` columns are covered by `node scripts/test-rewards-ledger.js`.
Since 2026-11-18 (audit #1) it also covers the clean-epoch filter: the expected values come from a
second implementation of the rule in the test, and synthetic validators cover a cell recorded as
1 XNT, a stake ramp shifted by one epoch, a re-fetch stamp, a 0 reward at 10 % (all left out), a weak
epoch on a steady stake (kept) and a validator with fewer than 3 clean epochs ("—"); the whole served
ledger must stay under 1.25 × the network rate with top 10 % ≤ 1.3 × median. A last section serves
the ledger 2.5 s late and never answers `data/delegation.json` or the RPC: a card rendered before the
ledger must still fill in once the ledger arrives. A "late script" section serves `js/apr.js` 2.5 s
late and renders the card before it has loaded: the tile must fill once the module runs. 38 checks.

**Update Identity (2026-10-16)** — validator-info publish in `js/wallet-tx.js` (Manage Validator):

    node scripts/c2-tests/identity-test.js "$PWD"

Mocks the RPC and checks: an identity with an info account → form pre-filled from chain, the update
is one Config Store ix (info writable / not signer, identity signer) whose data is ConfigKeys
[Va1idator1nfo, identity*] + u64 length + JSON, unknown fields (`details`) kept, keys sorted; an
identity without one → "will create" note, createAccount (643 B, rent, owner Config) + Store with
the new account partial-signed; other wallet → locked; name > 80 / website without http(s) refused,
nothing sent; a direct click on Update right after typing an icon URL still registers.

**XNT price pill (2026-10-16)** — `js/price-pill.js`:

    node scripts/c2-tests/price-pill-test.js "$PWD"

Mocks `getMultipleAccounts` with a synthetic XDEX WXNT/USDC.X pool (real vault / mint addresses,
fees at their offsets) and checks the pill shows USDC ÷ WXNT reserves net of fees, with the on-chain
tooltip; RPC broken → XDEX API fallback with a "may lag" tooltip; both broken → pill hidden.

**Lifetime Credits (2026-10-27)** — `voteCreditsSummary` / `getVoteCreditsMap` (`js/core.js`), the
Terminal's Life Credits + Avg/Epoch columns, the 🏆 Lifetime Credits leaderboard + toggle:

    node scripts/c2-tests/credits-test.js "$PWD"     # SHOT_DIR=… to keep the screenshots

Checks the helper edge cases (missed epochs = 0, young accounts), every Terminal row against the same
rule run in node over the served `data/scores.json`, header-click sorting, both leaderboard orders,
the "Where am I" pin, the toggle, the deep link, the 375 px layout, 0 inline handlers, 0 page errors.

**Stake cooldown / withdraw (2026-10-29)** — `StakeActivation` in `js/core.js` + the Manage
Validator stake list, Stake Account Details, Withdraw-from-stake modal, Stake classification
modal and the unstaking calculator's "observed" preset:

    node scripts/c2-tests/stake-activation-test.js "$PWD"

`getStakeActivation` no longer exists on X1 4.0.x RPCs, so the active / cooled split is replayed
client-side from the StakeHistory sysvar (the stake program's own math, 9 % cap per epoch). The
fixture is the real sysvar (epochs 395–424) plus three real stake accounts of validator 9RqMzFzi…;
the oracle is a mainnet `simulateTransaction` from that day (withdraw of 1,774.532777416 XNT
accepted, one lamport more refused). Checks the lamport-exact split, badge COOLING + "88% cooled",
details card 88.4 %, withdraw modal "1,774.5328 ready / 233.3572 still cooling" with Close hidden,
the next-epoch (quiet and congested) outcomes, the sysvar-unavailable fallback, and the calculator
preset relabelling to the observed share, and the amount inputs: MAX rounds *down* to 4 dp
(`xntInputFloor4`) and a typed amount within 0.0001 XNT above the limit is clamped to it
(`clampToLimitLamports`) — the send path is exercised with `signSendTx` stubbed and the Stake
Withdraw instruction's lamports decoded. The Manage action grid is checked too: "Withdraw from
Stake" unlocks as soon as any of a deactivating stake has cooled (desc names the cooled amount),
"Close Stake Account" only when fully cooled, and the locked-state explainer describes the 9 % cap.
63 checks, 0 page errors.

**Vote-account Withdraw XNT (audit #5, 2026-11-18)** is section 4b of `stake-activation-test.js`: the
reserve is `getMinimumBalanceForRentExemption(space)` from the RPC (27,074,400 lamports for a
3,762-byte vote account, not the old hard-coded 0.02 XNT), MAX rounds down, the figure shown on the
Available line sends exactly the limit, the rent formula is the fallback when the RPC call fails, and
nothing can be withdrawn before the rent is known.

**One measured slot time (audit #8, 2026-11-18)** — `measuredSlotMs()` / `ensureMeasuredSlotMs()` in `js/core.js`:

    node scripts/c2-tests/slot-time-test.js "$PWD"

Mocks 60 one-minute performance samples (365.85 ms per slot) and checks that the page measures once
on load, that the card's leader band, the epoch bar and epochs/year use the measurement (the 420 /
400 ms constants gave "~1h 32m" and "12h 53m" where the truth is "~1h 20m" and "11h 47m"), that a
reload reuses the session cache, that a failing RPC falls back to 368 ms without a retry storm, and
that no fixed slot-time constant is left in `js/`. 13 checks.

**Authority-change safety net (audit #4, 2026-11-18)** — `js/wallet-tx.js` + `#authorityDangerModal`:

    node scripts/c2-tests/authority-test.js "$PWD"

Signer stubbed, nothing is sent. Stake withdraw authority: the stake account itself, the vote account,
program / sysvar ids, a program-derived address and the current authority are refused with the
reason; a good address opens the confirmation modal instead of sending (full address, amount, what
the chain knows about the address); only its last 6 characters unlock it; then exactly one Stake
Authorize(Withdrawer) instruction. The on-chain lookup blocks programs and program-owned accounts,
warns about never-used addresses and degrades to a caution when the RPC cannot answer. The vote
account's withdraw authority goes through the same modal; the voter authority keeps its typed-phrase
modal and gains the address checks. 34 checks.

**Frame guard (audit #13, 2026-11-18)** — `js/frame-guard.js`:

    node scripts/c2-tests/frame-guard-test.js "$PWD"

Serves the site on 127.0.0.1 and a hostile page on localhost that frames it. Unframed: the site loads
normally. Framed (plain, sandboxed with scripts, same-origin parent): no site markup and no site
scripts, only the notice and a top-level link. Control: the previous guard from git history leaves
the framed site fully usable (skipped where the history is not available). 8 checks. Chromium only.

**Base rate (audit #9, 2026-11-18)** — `validatorBaseRatePct` / `networkBaseRatePct` in `js/core.js`:

    node scripts/c2-tests/base-rate-test.js "$PWD"

The rate 1 XNT earns per year before commission, used by Stake Details, the staking and compound
calculators and Manage Validator, comes from the ledger's vote credits instead of past rewards ÷
today's stake. Compares the helper with a second implementation in node (7 and 30 epochs, offline
epochs as 0 %, 40 real validators), the network median and its fallbacks, the staking calculator
when the reward data would imply ~15,900 % at today's stake, the custom-rate inputs (network rate
instead of 8, a typed value is kept) and that no visible "APY" is left. 18 checks.

**Start-up order (2026-11-18)** — `js/start.js` + `startSite()` at the end of `js/modals.js`:

    node scripts/c2-tests/startup-order-test.js "$PWD"

Serves each of the seven scripts that load after `js/modals.js` 0.4 s late and answers the RPC at
once. `init()` must not touch the network before the last script was served and must not wait for
DOMContentLoaded; `#/terminal` and `#/delegation` deep links open their view; `#/datacenter` with a
one-validator portfolio shows the card, the Fleet Health bar and a filled Delegator APR tile. Control:
the previous arrangement (rebuilt from today's files: `init();` at the end of modals.js, no start.js)
opens nothing for both links and renders the card without the Fleet Health bar. Cache skew both ways:
old index.html + new modals.js starts once at DOMContentLoaded; new index.html + old modals.js starts
exactly once. 21 checks.
