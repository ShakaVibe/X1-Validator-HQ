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

**index.html (batch 6)** is covered by a differential test instead: the page is loaded with
the pre-conversion index.html and with the converted one, every handler element is fired,
and the spied calls must match one for one:

    git show 02bbad2:index.html > /tmp/o.html        # last commit before batch 6
    python3 scripts/c2-tests/convert-index.py /tmp/o.html /tmp/conv.html --instrument
    node scripts/c2-tests/index-diff-test.js "$PWD" /tmp/conv.orig.html /tmp/conv.html

Expected: 196 elements on both sides, 0 inline handlers left in the converted page, and one
known difference (#175 perfExplainerModal: now closed by the overlay rule instead of
`closePerfExplainerModal(event)` — same behaviour, see the 2026-09-23 session log).

Pass the repo as an absolute path (or `$PWD`) — a bare `.` makes the static server 404 everything.

Pass = every expected call listed once, `inline*: 0` in every container,
`page errors: []`, `[Actions] warnings: []`.
