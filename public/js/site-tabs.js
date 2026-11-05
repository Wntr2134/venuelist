'use strict';

// On a phone the folder tabs are a sideways row: bring this page's own tab into view (the row
// only, never the page). The same few lines the other Riderly sites keep inline; this site's
// content policy bans inline script, so here they are a file.
(function () {
  const row = document.getElementById('rs-tabs');
  const own = row && row.querySelector('[aria-current]');
  if (own && row.scrollWidth > row.clientWidth) {
    row.scrollLeft = Math.max(0, own.offsetLeft - row.offsetLeft - (row.clientWidth - own.offsetWidth) / 2);
  }
})();
