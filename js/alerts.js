    // ═══════════════════════════════════════════════════════════════════════
    // TELEGRAM ALERTS — entry point for the F3 alerts bot
    // (scripts/alerts-bot.js, run by .github/workflows/alerts.yml).
    // The site does nothing itself: it opens the bot and hands the visitor a
    // ready-made "/watch <vote> …" command built from My Data Center.
    // Globals used: Actions, escHtml, myPortfolio (js/core.js).
    // ═══════════════════════════════════════════════════════════════════════
    (function () {
      const BOT_USERNAME = 'x1valhq_bot';        // Telegram username of the bot, without '@' (set after BotFather)
      const MODAL_ID = 'alertsModal';

      function botLink(label) {
        if (!BOT_USERNAME) return escHtml(label || 'the X1 Validator HQ bot');
        return '<a href="https://t.me/' + encodeURIComponent(BOT_USERNAME) + '" target="_blank" rel="noopener noreferrer">' + escHtml(label || ('@' + BOT_USERNAME)) + '</a>';
      }
      function portfolioVotes() {
        return (typeof myPortfolio !== 'undefined' && Array.isArray(myPortfolio)) ? myPortfolio.filter(v => typeof v === 'string' && v.length > 0) : [];
      }
      function watchCommand() {
        const votes = portfolioVotes();
        return votes.length ? '/watch ' + votes.join(' ') : '';
      }
      function render() {
        const body = document.getElementById('alertsModalBody');
        if (!body) return;
        const cmd = watchCommand();
        const n = portfolioVotes().length;
        const step2 = cmd
          ? '<li>Send this command — it watches ' + (n === 1 ? 'the validator' : 'all ' + n + ' validators') + ' in your Data Center:' +
            '<div class="tga-cmd"><code id="tgaCommand">' + escHtml(cmd) + '</code>' +
            '<button type="button" class="tga-copy" data-action="alerts-copy">Copy</button></div>' +
            '<div class="tga-note">Any validator works too: <code>/watch &lt;name or vote account&gt;</code></div></li>'
          : '<li>Send <code>/watch &lt;name or vote account&gt;</code> for each validator you want to follow.' +
            '<div class="tga-note">Add validators to your Data Center and this step turns into a one-line command you can copy.</div></li>';
        body.innerHTML =
          '<p class="tga-lead">Get a Telegram message when a validator goes <b>delinquent</b> (and when it is voting again), ' +
          '<b>skips leader slots</b>, changes <b>Delegation Program</b> status or runs a version <b>below the Foundation minimum</b>. ' +
          'Checks run every 5 minutes; Delegation Program data hourly.</p>' +
          '<ol class="tga-steps">' +
          '<li>Open ' + botLink() + ' in Telegram and press <b>Start</b>.</li>' +
          step2 +
          '</ol>' +
          '<div class="dm-foot">The bot keeps only the chat ↔ validator pairing, encrypted; <code>/unwatch all</code> removes it. ' +
          '<code>/status</code> gives a live check any time. Works in group chats as well.</div>';
      }
      function open() {
        const m = document.getElementById(MODAL_ID);
        if (!m) return;
        render();
        m.style.display = 'flex';
      }
      function close() {
        const m = document.getElementById(MODAL_ID);
        if (m) m.style.display = 'none';
      }
      function copy(btn) {
        const cmd = watchCommand();
        if (!cmd || !navigator.clipboard) return;
        navigator.clipboard.writeText(cmd).then(() => {
          const old = btn.textContent;
          btn.textContent = 'Copied ✓';
          btn.classList.add('is-copied');
          setTimeout(() => { btn.textContent = old; btn.classList.remove('is-copied'); }, 1500);
        }).catch(() => {});
      }
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

      Actions.register({
        'alerts-open':    () => open(),
        'alerts-close':   () => close(),
        'alerts-overlay': (el, e) => { if (e.target === el) close(); },
        'alerts-copy':  (el) => copy(el),
      });
      window.openAlertsModal = open;
      window.closeAlertsModal = close;
    })();
