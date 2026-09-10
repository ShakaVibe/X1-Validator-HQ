# X1 Validator HQ — Session Handover

> **How to use this file:** at the start of a new chat, attach or paste this file and say
> "here's the handover, let's continue." Claude reads it, asks you to link the `X1VHQ`
> folder (Add folder → `Desktop/X1VHQ`), and picks up from the to-do list.
> At the **end of every session** Claude updates the Session Log, the To-Do list and any
> notes below, so this file is always the single source of truth.

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

## 3. Repo map

```
index.html                    the whole site (all tabs, all JS)
data/scores.json              canonical validator scores — written hourly by Action
data/history.json             7-day rolling history behind the scores
validator-locations.json      geo data — written every 2h by Action
data/terminal.json            Validator Terminal snapshot — written hourly by Action (added 2026-09-10)
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

- **Data sources:** `https://rpc.mainnet.x1.xyz` (JSON-RPC, most tabs) and `https://api.x1.xyz`
  (REST, used by the Validator Terminal). Also `api.xdex.xyz` (XNT price), `ipwho.is`,
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

### Open
- [ ] **First run of the snapshot Action:** after pushing, go to GitHub → Actions →
      "Update Validator Terminal snapshot" → Run workflow. Confirm it commits `data/terminal.json`
      (~0.7 MB). Until it exists the site silently falls back to the live API.
- [ ] **Verify on the live site** after Pages redeploys: Validator Terminal should show
      "Hourly snapshot · auto-refresh 1h" in the header corner and load in well under a second;
      click **Live** to confirm the live path still works (progress "x MB of ~13 MB"); no console
      errors.
- [ ] Ask people who reported the error which device/network they were on (mobile? VPN?) — helps
      confirm the diagnosis.

### Ideas / backlog
- [ ] Consider showing a "loading… this tab downloads ~13 MB" hint on the Validator Terminal
      nav button for first-time visitors.
- [ ] The bot adds ~36 commits/day; consider moving data files to a `data` branch someday
      (see SCORING-DEPLOYMENT.md "Operational notes").

### Done
- [x] 2026-09-10 — Local clone set up at `~/Desktop/X1VHQ`, folder linked to Claude.
- [x] 2026-09-10 — Diagnosed + hardened Validator Terminal loading (see Session Log).
- [x] 2026-09-10 — Hourly terminal snapshot Action + snapshot-first loader (see Session Log).

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
- **Not yet pushed** at the time of writing — Shaka to run the push commands in §2, then trigger
  the snapshot workflow once by hand (see To-do).
