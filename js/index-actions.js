    // ─────────────────────────────────────────────────────────────────────
    // index.html → data-action handlers (C2, 2026-09-23)
    //
    // Replaces every inline on* attribute that used to live in index.html's
    // static markup, so the CSP can drop 'unsafe-inline' from script-src.
    // Loaded right after js/core.js (needs Actions); everything below is
    // resolved at event time, so functions from later files work.
    //
    // Markup forms (written by the one-off conversion; see the session log):
    //   data-action="call"        data-fn="name" [data-args='[json]']        click
    //   data-input="call-input"   data-input-fn  [data-input-args]          input
    //   data-change="call-change" data-change-fn [data-change-args]         change
    //   data-onerror="call-error" data-error-fn                             <img> error
    //   data-focus-fn / data-blur-fn                                        focus / blur
    //   data-action="overlay-close" data-fn="closeX"   = if (event.target === this) closeX()
    //   data-async-css (on a <link media="print">)     = onload="this.media='all'"
    // In data-args, {"$":"el"} stands for `this` and {"$":"event"} for `event`.
    // ─────────────────────────────────────────────────────────────────────
    (function () {
      // Every function index.html may call, by name — a fixed allow-list, never window[name].
      const CALLS = {
        acceptDisclaimer:               (...a) => acceptDisclaimer(...a),
        calculateBreakeven:             (...a) => calculateBreakeven(...a),
        calculateCompoundGrowth:        (...a) => calculateCompoundGrowth(...a),
        calculateUnstakingTimeline:     (...a) => calculateUnstakingTimeline(...a),
        clearComparison:                (...a) => clearComparison(...a),
        clearPortfolio:                 (...a) => clearPortfolio(...a),
        clearRedelegateSelection:       (...a) => clearRedelegateSelection(...a),
        closeActionExplainerModal:      (...a) => closeActionExplainerModal(...a),
        closeChangeVoteAuthorityModal:  (...a) => closeChangeVoteAuthorityModal(...a),
        closeCommissionModal:           (...a) => closeCommissionModal(...a),
        closeCreateStakeModal:          (...a) => closeCreateStakeModal(...a),
        closeDelegationModal:           (...a) => closeDelegationModal(...a),
        closeEpochTimelineModal:        (...a) => closeEpochTimelineModal(...a),
        closeIdentityModal:             (...a) => closeIdentityModal(...a),
        closeManageValidator:           (...a) => closeManageValidator(...a),
        closeMergeStakesModal:          (...a) => closeMergeStakesModal(...a),
        closePerfExplainerModal:        (...a) => closePerfExplainerModal(...a),
        closeRedelegateStakeModal:      (...a) => closeRedelegateStakeModal(...a),
        closeRewardBreakdown:           (...a) => closeRewardBreakdown(...a),
        closeSendXntModal:              (...a) => closeSendXntModal(...a),
        closeSetStakeAuthorityModal:    (...a) => closeSetStakeAuthorityModal(...a),
        closeSetWithdrawAuthorityModal: (...a) => closeSetWithdrawAuthorityModal(...a),
        closeSkipmonScorecard:          (...a) => closeSkipmonScorecard(...a),
        closeSlotModal:                 (...a) => closeSlotModal(...a),
        closeSolanaModal:               (...a) => closeSolanaModal(...a),
        closeSplitStakeModal:           (...a) => closeSplitStakeModal(...a),
        closeStakeBreakdown:            (...a) => closeStakeBreakdown(...a),
        closeStakeSelection:            (...a) => closeStakeSelection(...a),
        closeTpsModal:                  (...a) => closeTpsModal(...a),
        closeUndelegateStakeModal:      (...a) => closeUndelegateStakeModal(...a),
        closeValidatorList:             (...a) => closeValidatorList(...a),
        closeVoteAuthorityDangerModal:  (...a) => closeVoteAuthorityDangerModal(...a),
        closeWithdrawStakeModal:        (...a) => closeWithdrawStakeModal(...a),
        closeWithdrawXntModal:          (...a) => closeWithdrawXntModal(...a),
        connectWallet:                  (...a) => connectWallet(...a),
        copyValidatorAddress:           (...a) => copyValidatorAddress(...a),
        disconnectWallet:               (...a) => disconnectWallet(...a),
        filterValidatorList:            (...a) => filterValidatorList(...a),
        handleCompareSearch:            (...a) => handleCompareSearch(...a),
        handleRedelegateSearch:         (...a) => handleRedelegateSearch(...a),
        handleSearchInput:              (...a) => handleSearchInput(...a),
        hideIconPreview:                (...a) => hideIconPreview(...a),
        loadMoreValidators:             (...a) => loadMoreValidators(...a),
        onAuthorityBadgeClick:          (...a) => onAuthorityBadgeClick(...a),
        onBreakevenValidatorChange:     (...a) => onBreakevenValidatorChange(...a),
        onCompoundValidatorChange:      (...a) => onCompoundValidatorChange(...a),
        onStakingValidatorChange:       (...a) => onStakingValidatorChange(...a),
        onUnstakingRateChange:          (...a) => onUnstakingRateChange(...a),
        openCompareValidatorList:       (...a) => openCompareValidatorList(...a),
        openEpochTimelineModal:         (...a) => openEpochTimelineModal(...a),
        openTpsModal:                   (...a) => openTpsModal(...a),
        openValidatorList:              (...a) => openValidatorList(...a),
        performSearch:                  (...a) => performSearch(...a),
        proceedWithVoteAuthorityChange: (...a) => proceedWithVoteAuthorityChange(...a),
        refreshEpochInfo:               (...a) => refreshEpochInfo(...a),
        refreshPortfolio:               (...a) => refreshPortfolio(...a),
        refreshStakeAccounts:           (...a) => refreshStakeAccounts(...a),
        renderStakingResults:           (...a) => renderStakingResults(...a),
        selectAccount:                  (...a) => selectAccount(...a),
        selectVoteAuthorityType:        (...a) => selectVoteAuthorityType(...a),
        setCreateStakeAmount:           (...a) => setCreateStakeAmount(...a),
        setDelegationsSource:           (...a) => setDelegationsSource(...a),
        setSendAmount:                  (...a) => setSendAmount(...a),
        setSkipMonitorScope:            (...a) => setSkipMonitorScope(...a),
        setSplitStakeAmount:            (...a) => setSplitStakeAmount(...a),
        setUnstakingRatePreset:         (...a) => setUnstakingRatePreset(...a),
        setWithdrawAmount:              (...a) => setWithdrawAmount(...a),
        setWithdrawStakeAmount:         (...a) => setWithdrawStakeAmount(...a),
        skipmonLookupInputBlurred:      (...a) => skipmonLookupInputBlurred(...a),
        skipmonLookupInputChanged:      (...a) => skipmonLookupInputChanged(...a),
        smSwitchEpoch:                  (...a) => smSwitchEpoch(...a),
        switchCombinedChartType:        (...a) => switchCombinedChartType(...a),
        toggleAuthorityLegend:          (...a) => toggleAuthorityLegend(...a),
        toggleBreakevenView:            (...a) => toggleBreakevenView(...a),
        toggleCloseStakeAccount:        (...a) => toggleCloseStakeAccount(...a),
        toggleCombinedChart:            (...a) => toggleCombinedChart(...a),
        toggleCombinedStakeDetails:     (...a) => toggleCombinedStakeDetails(...a),
        toggleGlobeRotation:            (...a) => toggleGlobeRotation(...a),
        toggleStakingCurrency:          (...a) => toggleStakingCurrency(...a),
        updateDisclaimerButton:         (...a) => updateDisclaimerButton(...a),
        updateSplitStakeSummary:        (...a) => updateSplitStakeSummary(...a),
        useWalletForVoteAuthority:      (...a) => useWalletForVoteAuthority(...a),
        validateVoteAuthorityConfirm:   (...a) => validateVoteAuthorityConfirm(...a),
        validateVoteAuthorityInput:     (...a) => validateVoteAuthorityInput(...a),
        vpCloseProbe:                   (...a) => vpCloseProbe(...a),
        vpDeepScan:                     (...a) => vpDeepScan(...a),
        vpDownloadCsv:                  (...a) => vpDownloadCsv(...a),
        vpLeaderBench:                  (...a) => vpLeaderBench(...a),
        vpMinStakeChange:               (...a) => vpMinStakeChange(...a),
        vpRenderTable:                  (...a) => vpRenderTable(...a),
        vpRunProbe:                     (...a) => vpRunProbe(...a),
        vpToggleDelinq:                 (...a) => vpToggleDelinq(...a),
        vpToggleLag:                    (...a) => vpToggleLag(...a),
      };

      function args(raw, el, e) {
        if (!raw) return [];
        return JSON.parse(raw).map(a =>
          (a && typeof a === 'object' && '$' in a) ? (a.$ === 'el' ? el : a.$ === 'event' ? e : undefined) : a);
      }
      function call(name, raw, el, e) {
        const fn = CALLS[name];
        if (!fn) { console.warn('[Actions] index.html: no function "' + name + '" in the allow-list'); return; }
        fn(...args(raw, el, e));
      }

      Actions.register({
        'call':        (el, e, d) => call(d.fn, d.args, el, e),
        'call-input':  (el, e, d) => call(d.inputFn, d.inputArgs, el, e),
        'call-change': (el, e, d) => call(d.changeFn, d.changeArgs, el, e),
        'call-error':  (el, e, d) => call(d.errorFn, d.errorArgs, el, e),
        // Modal backdrops: close only when the backdrop itself was clicked.
        'overlay-close': (el, e, d) => { if (e.target === el) call(d.fn, d.args, el, e); },
        // The few handlers that were more than one call:
        'go-home':         (el, e) => { e.preventDefault(); goToHome(); },            // was "goToHome(); return false;"
        'show-disclaimer': (el, e) => { e.preventDefault(); showDisclaimerModal(); }, // was "showDisclaimerModal(); return false;"
        'deleg-tile':      () => { switchTab('delegation'); if (typeof delegFilterMine === 'function') delegFilterMine(); },
        'staking-input':        (el) => { formatStakingInput(el); renderStakingResults(); },
        'staking-price-input':  (el) => { el.dataset.userSet = '1'; renderStakingResults(); },
        'compound-input':       (el) => { formatCompoundInput(el); calculateCompoundGrowth(); },
        'breakeven-price-input': (el) => { el.dataset.userSet = '1'; calculateBreakeven(); },
      });

      // focus/blur don't bubble; focusin/focusout do. Fire only for the element
      // itself (not for focus moving inside it), like the old onfocus/onblur.
      function focusHandler(attr) {
        return (e) => {
          const el = e.target instanceof Element ? e.target : null;
          if (el && el.hasAttribute(attr)) call(el.getAttribute(attr), null, el, e);
        };
      }
      document.addEventListener('focusin', focusHandler('data-focus-fn'));
      document.addEventListener('focusout', focusHandler('data-blur-fn'));

      // Elements whose .onclick js REASSIGNS later (confirm buttons become "Close"
      // after a transaction; compare slots switch between focusCompareSearch and
      // null). They keep property semantics — a data-action would fire in addition
      // to the reassigned handler (e.g. re-submit a transaction).
      const INITIAL_ONCLICK = {
        compareSlot0:            () => { focusCompareSearch(); },
        compareSlot1:            () => { focusCompareSearch(); },
        compareSlot2:            () => { focusCompareSearch(); },
        compareSlot3:            () => { focusCompareSearch(); },
        sendConfirmBtn:          () => { confirmSendXnt(); },
        withdrawConfirmBtn:      () => { confirmWithdrawXnt(); },
        commissionConfirmBtn:    () => { confirmChangeCommission(); },
        identityConfirmBtn:      () => { confirmUpdateIdentity(); },
        createStakeConfirmBtn:   () => { confirmCreateStake(); },
        changeVoteAuthorityBtn:  () => { confirmChangeVoteAuthority(); },
        setWithdrawAuthorityBtn: () => { confirmSetWithdrawAuthority(); },
        setStakeAuthorityBtn:    () => { confirmSetStakeAuthority(); },
        undelegateConfirmBtn:    () => { confirmUndelegateStake(); },
        redelegateConfirmBtn:    () => { confirmRedelegateStake(); },
        withdrawStakeConfirmBtn: () => { confirmWithdrawFromStake(); },
        mergeStakesConfirmBtn:   () => { confirmMergeStakes(); },
        splitStakeConfirmBtn:    () => { confirmSplitStake(); },
      };
      for (const id in INITIAL_ONCLICK) {
        const el = document.getElementById(id);
        if (el) el.onclick = INITIAL_ONCLICK[id];
      }

      // Non-blocking Google Fonts: the <link> starts as media="print" and is
      // switched to "all" once loaded (was onload="this.media='all'").
      document.querySelectorAll('link[data-async-css]').forEach(link => {
        const apply = () => { link.media = 'all'; };
        if (link.sheet) apply(); else link.addEventListener('load', apply, { once: true });
      });
    })();
