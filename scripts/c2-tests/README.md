# C2 offline tests (data-action dispatcher)

Playwright checks that every converted `data-action` control still calls its
function exactly once with the original arguments. Each script serves the repo
on localhost, aborts every external request, renders the real markup with mocked
state, replaces the target functions with spies and clicks through.

    npm i -g playwright            # once (Chromium must be installed for Playwright)
    node scripts/c2-tests/cards-test.js  /path/to/repo
    node scripts/c2-tests/manage-test.js /path/to/repo
    node scripts/c2-tests/modals-test.js /path/to/repo

Pass = every expected call listed once, `inline*: 0` in every container,
`page errors: []`, `[Actions] warnings: []`.
