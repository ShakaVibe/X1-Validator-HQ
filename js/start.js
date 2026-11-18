// START-UP — this must stay the LAST <script> in index.html.
// Starts the site (init() in js/network-live.js, via startSite() in
// js/modals.js) once every other script has loaded, so the first view can use
// all of them. See the START-UP note at the end of js/modals.js.
// The typeof check covers a visitor holding a cached, older js/modals.js that
// still calls init() itself: then there is nothing left to do here.
if (typeof startSite === 'function') startSite();
