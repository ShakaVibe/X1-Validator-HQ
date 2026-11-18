// CLICKJACKING STOPGAP (frame guard). Loaded synchronously from <head>, before
// anything else on the page (moved out of an inline <script> on 2026-09-23 so
// the CSP could drop 'unsafe-inline').
//
// 2026-11-18 (audit 2026-11-17 #13): the page now refuses to run whenever it
// is framed. The old guard only tried `top.location = self.location` and
// blanked the page if that THREW. Current Chrome does not throw: it silently
// blocks a cross-origin top navigation that has no user gesture, so the site
// stayed fully usable inside a hostile frame (found 2026-09-23).
//
// When framed:
//   1. hide the document at once;
//   2. still try to break out to the top (works where the browser allows it);
//   3. stop the page (window.stop() ends parsing, so no markup and no later
//      <script> of the site is loaded), replace it with a one-line notice and
//      a link that opens the real site at the top level;
//   4. keep it that way: anything that still gets added is removed again.
//
// Limits, unchanged: this is JavaScript, not a header. A parent that frames
// the site with `sandbox` and without `allow-scripts` stops this file too, but
// then none of the site's scripts run either, so there is no working UI to
// hijack. The real fix is a `frame-ancestors 'none'` / `X-Frame-Options: DENY`
// response header from a host that can send headers (audit #26).
(function () {
  var framed;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }
  if (!framed) return;                       // normal, unframed load: do nothing at all

  var root = document.documentElement;
  try { root.style.setProperty('display', 'none', 'important'); } catch (e) {}
  try { window.top.location = window.self.location.href; } catch (e) {}

  var NOTICE_ID = 'x1-frame-guard-notice';
  function blank() {
    try {
      var kids = root.childNodes, i;
      for (i = kids.length - 1; i >= 0; i--) {
        if (kids[i].id !== NOTICE_ID) root.removeChild(kids[i]);
      }
      if (!document.getElementById(NOTICE_ID)) {
        var body = document.createElement('body');
        body.id = NOTICE_ID;
        body.style.cssText = 'margin:0;padding:2rem 1rem;background:#0a0e1a;color:#e2e8f0;font:16px/1.5 system-ui,-apple-system,sans-serif;text-align:center';
        var p = document.createElement('p');
        p.textContent = 'X1 Validator HQ does not run inside another page.';
        var a = document.createElement('a');
        a.href = 'https://x1valhq.xyz/';
        a.target = '_top';
        a.rel = 'noopener noreferrer';
        a.textContent = 'Open x1valhq.xyz';
        a.style.color = '#00d4ff';
        body.appendChild(p);
        body.appendChild(a);
        root.appendChild(body);
      }
      root.style.removeProperty('display');
    } catch (e) {}
  }

  try { window.stop(); } catch (e) {}
  blank();
  // Belt and braces, in case a browser keeps parsing after stop():
  try {
    new MutationObserver(function () {
      var kids = root.childNodes, i;
      for (i = 0; i < kids.length; i++) { if (kids[i].id !== NOTICE_ID) { blank(); return; } }
    }).observe(root, { childList: true });
  } catch (e) {}
  try {
    document.addEventListener('DOMContentLoaded', blank);
    window.addEventListener('load', blank);
  } catch (e) {}
})();
