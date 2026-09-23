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

Pass the repo as an absolute path (or `$PWD`) — a bare `.` makes the static server 404 everything.

Pass = every expected call listed once, `inline*: 0` in every container,
`page errors: []`, `[Actions] warnings: []`.
