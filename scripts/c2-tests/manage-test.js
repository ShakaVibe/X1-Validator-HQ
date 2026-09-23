// Offline test of the data-action conversion in js/manage.js (+ getCopyButtonHtml in core.js).
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = process.argv[2];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
(async () => {
  await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors = [], actionsWarn = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/\[Actions\]|\[manage-call\]/.test(m.text())) actionsWarn.push(m.text()); });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
  await page.goto(`http://127.0.0.1:${port}/#/lookup/x`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const result = await page.evaluate(async (port) => {
    const out = {}; const calls = [];
    const spy = (name) => { window[name] = function (...a) { calls.push([name, ...a.map(x => x instanceof Element ? '<' + x.tagName + '>' : (x && x.isTrusted !== undefined ? 'event' : x))]); }; };
    ['addToComparisonFromList', 'addToPortfolioFromList', 'selectValidatorForSearch', 'askClaudeForHelp', 'closeStakeSelection', 'saveStakeSelections',
     'cycleStakeCat', 'connectWallet', 'selectAccount', 'toggleMergeStakeSelection', 'selectRedelegateValidator', 'highlightAccountList', 'copyToClipboard',
     'initiateCreateStake', 'initiateSendToIdentity', 'initiateWithdraw', 'initiateChangeCommission', 'initiateUpdateIdentity', 'initiateChangeAuthority',
     'initiateRedelegate', 'initiateUndelegate', 'initiateSplitStake', 'initiateMergeStakes', 'initiateWithdrawStake', 'initiateCloseStakeAccount',
     'initiateSetStakeAuthority', 'initiateSetWithdrawAuthority'].forEach(spy);
    const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const inline = (el) => (el.innerHTML.match(/(^|[\s"'])on(click|error|change|input)=/g) || []).length;
    const V1 = '5ar5xXjefcD2sXZmhExfg4Sur5CJfBKRCp2LmATvQNac', V2 = 'B'.repeat(44), NAME = 'Evil "<b>&\'name';
    try {
      // 1. Browse-validators list (search mode + compare mode)
      currentValidatorList = [{ votePubkey: V1, name: NAME, rank: 1, totalValidators: 724, iconUrl: `http://127.0.0.1:${port}/nope.png`, activatedStake: 1e15, commission: 5 },
                              { votePubkey: V2, name: 'Second', rank: 2, totalValidators: 724, iconUrl: '', activatedStake: 1e14, commission: 5 }];
      myPortfolio = [V2];
      validatorListMode = 'search'; renderValidatorList();
      const body = document.getElementById('validatorListBody');
      await new Promise(r => setTimeout(r, 300));
      const logo = body.querySelector('.validator-list-item-logo');
      out.listLogoFallback = logo.textContent.trim();
      click(body.querySelector('.validator-list-item-info'));           // list-select
      click(body.querySelector('.validator-list-item-add'));            // list-portfolio-add (V1, not in portfolio)
      out.secondAddDisabled = body.querySelectorAll('.validator-list-item-add')[1].hasAttribute('data-action') === false;
      validatorListMode = 'compare'; renderValidatorList();
      click(body.querySelector('.validator-list-item-add'));            // list-compare-add
      out.listInline = inline(body);
      // 2. Wallet-required popup
      showWalletRequired('test');
      let pop = document.querySelector('.wallet-required-popup');
      click(pop.querySelector('.wallet-required-btn.connect')); out.popupGoneAfterConnect = !document.querySelector('.wallet-required-popup');
      showWalletRequired('test'); pop = document.querySelector('.wallet-required-popup');
      click(pop.querySelector('.wallet-required-btn.cancel')); out.popupGoneAfterCancel = !document.querySelector('.wallet-required-popup');
      // 3. Stake classification modal
      const sbody = document.createElement('div'); document.body.appendChild(sbody);
      const cats = new Map([[V1, 'self'], [V2, 'foundation']]);
      renderStakeSelection(sbody, [{ pubkey: V1, withdrawer: 'W'.repeat(44), delegatedXNT: 10, activeEligible: true, state: 'active' }, { pubkey: V2, withdrawer: 'W'.repeat(44), delegatedXNT: 5, activeEligible: true, state: 'active' }], cats, NAME, V1);
      let outside = 0; document.addEventListener('click', () => outside++);
      let o = outside; click(sbody.querySelector('.stake-cat.self')); out.catCycleStopped = outside === o;
      click(sbody.querySelector('.stake-selection-btn.primary')); click(sbody.querySelector('.stake-selection-btn.secondary'));
      out.stakeSelInline = inline(sbody);
      // 4. Manage Validator action grid + explainer
      currentManageValidator = { voteAccount: V1, name: NAME }; stakeAccounts = []; selectedAccountType = 'vote';
      try { renderActions(); out.renderActions = 'ok'; } catch (e) { out.renderActions = 'threw: ' + e.message; }
      const wg = document.getElementById('walletActionsGrid');
      click(wg.querySelector('.manage-action-btn'));                    // initiateCreateStake
      const vg = document.getElementById('validatorActionsGrid');
      out.validatorBtns = [...vg.querySelectorAll('.manage-action-btn')].map(b => (b.dataset.fn || '-') + (b.classList.contains('disabled') ? '(locked)' : ''));
      click(vg.querySelector('.manage-action-btn'));                    // initiateWithdraw or locked showActionExplainer
      const sg = document.getElementById('stakeActionsGrid');
      out.stakeBtns = [...sg.querySelectorAll('.manage-action-btn')].map(b => (b.dataset.fn || '-') + ':' + (b.dataset.args || ''));
      out.gridInline = inline(wg) + inline(vg) + inline(sg);
      // real explainer modal (locked stake button, no account selected → "Select a Stake Account")
      click(sg.querySelector('.manage-action-btn'));
      const modal = document.getElementById('actionExplainerModal');
      out.explainerOpen = getComputedStyle(modal).display;
      out.explainerBtn = modal.querySelector('.explainer-action-btn') ? modal.querySelector('.explainer-action-btn').outerHTML.slice(0, 160) : 'none';
      click(modal.querySelector('.explainer-action-btn'));
      out.explainerClosedAfterAction = getComputedStyle(modal).display === 'none';
      click(sg.querySelector('.manage-action-btn')); click(modal.querySelector('.explainer-close-btn'));
      out.explainerClosedAfterGotIt = getComputedStyle(modal).display === 'none';
      out.explainerInline = inline(modal);
      // 5. Stake account rows
      stakeAccounts = [{ pubkey: V1, staker: 'S'.repeat(44), withdrawer: 'W'.repeat(44), lamports: 5e9, delegatedLamports: 5e9, state: 'active' },
                       { pubkey: V2, staker: 'S'.repeat(44), withdrawer: 'W'.repeat(44), lamports: 3e9, delegatedLamports: 3e9, state: 'inactive' }];
      try { renderStakeAccounts(); out.renderStakeAccounts = 'ok'; } catch (e) { out.renderStakeAccounts = 'threw: ' + e.message; }
      const rows = [...document.querySelectorAll('.account-row[data-action="select-account"]')];
      out.accountRows = rows.map(r => r.dataset.account);
      click(rows[0].querySelector('.account-address'));                 // child click bubbles to the row
      o = outside; click(rows[0].querySelector('.copy-address-btn')); out.copyStopped = outside === o;   // getCopyButtonHtml (core.js)
      selectedAccountType = 'vote'; try { selectAccount = window.selectAccount; } catch (e) {}
      out.rowsInline = inline(rows[0].parentElement);
      // 6. Redelegate search results
      allValidatorsForRedelegate = [{ voteAccount: V1, name: NAME, nodePubkey: 'n', activatedStake: 1e15, isDelinquent: false }];
      document.getElementById('redelegateValidatorSearch').value = 'evil';
      handleRedelegateSearch();
      const rr = document.getElementById('redelegateSearchResults');
      click(rr.querySelector('.redelegate-search-item .redelegate-search-item-name'));
      out.redelegateInline = inline(rr);
      // 7. Merge stakes list via the real renderMergeStakesList (needs the RPC-shaped stake objects)
      const mk = (pk, state) => ({ pubkey: pk, state, lamports: 5e9, staker: 'S'.repeat(44), withdrawer: 'W'.repeat(44),
        data: { meta: { authorized: { staker: 'S'.repeat(44), withdrawer: 'W'.repeat(44) } }, stake: { delegation: { voter: V1 } } } });
      walletPublicKey = 'S'.repeat(44); stakeAccounts = [mk(V1, 'active'), mk(V2, 'active'), mk('C'.repeat(44), 'activating')];
      try { renderMergeStakesList(); out.renderMerge = 'ok'; } catch (e) { out.renderMerge = 'threw: ' + e.message; }
      const ml = document.getElementById('mergeStakesList');
      out.mergeItems = [...ml.querySelectorAll('.merge-stake-item')].map(i => (i.dataset.action || 'none') + '/' + (i.querySelector('.merge-stake-checkbox').dataset.action || 'none'));
      click(ml.querySelector('.merge-stake-item .merge-stake-address'));            // row → merge-toggle
      o = outside; click(ml.querySelector('.merge-stake-item .merge-stake-checkbox')); out.mergeBoxStopped = outside === o;   // box → merge-toggle-box, stops
      click(ml.querySelector('.merge-stake-item.disabled'));                          // ineligible row → nothing
      out.mergeInline = inline(ml);
    } catch (e) { out.fatal = e.message + '\n' + e.stack; }
    out.calls = calls;
    return out;
  }, port);
  console.log(JSON.stringify(result, null, 1));
  console.log('page errors:', errors, '\n[Actions] warnings:', actionsWarn);
  await browser.close(); srv.close();
})();
