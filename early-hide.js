// early-hide.js — Runs at document_start to prevent LinkedIn feed flash.
// Injects a temporary style hiding the main feed column on feed pages.
// content.js removes this style once it takes over visibility control.
(function () {
  'use strict';

  var path = location.pathname;
  if (path !== '/' && path !== '/feed' && !path.startsWith('/feed/')) return;

  var style = document.createElement('style');
  style.id = 'met-art-early-hide';
  style.textContent = 'main[aria-label], .scaffold-layout__aside, .scaffold-layout__sidebar, .scaffold-layout__aside--reflow { visibility: hidden !important; }';
  (document.head || document.documentElement).appendChild(style);

  // Safety: remove after 5s if content.js never loads
  setTimeout(function () {
    var el = document.getElementById('met-art-early-hide');
    if (el) el.remove();
  }, 5000);
})();
