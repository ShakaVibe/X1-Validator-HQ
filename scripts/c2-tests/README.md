# C2 offline tests (data-action dispatcher)

Playwright checks that every converted `data-action` control still calls its
function exactly once with the original arguments. Each script serves the repo
on localhost, aborts every external request, renders the real markup with mocked
state, replaces the target functions with spies and clicks through.

    npm i -g playwright            # once (Chromium must be installed for Playwright)
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
Withdraw instruction's lamports decoded. 58 checks, 0 page errors.
