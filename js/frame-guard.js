// CLICKJACKING STOPGAP (frame-buster) — moved out of an inline <script> in
// index.html's <head> (2026-09-23) so the CSP can drop 'unsafe-inline'.
// Loaded synchronously at the same spot, so it still runs before anything
// else on the page. See the comment above its <script> tag for why it exists.
(function () {
  try {
    if (window.top !== window.self) {
      // We are framed. Try to escape to the top.
      try {
        window.top.location = window.self.location;
      } catch (e) {
        // Cross-origin parent blocked the redirect — blank the page so
        // there is no clickable UI to hijack.
        document.documentElement.innerHTML = '';
      }
    }
  } catch (e) {
    // Never let this stopgap break normal (unframed) page loads.
  }
})();
