'use strict';

// Someone already logged in (e.g. opened the guide from ⚙ Settings) gets a way straight back.
fetch('/api/session', { credentials: 'same-origin' })
  .then((r) => (r.ok ? r.json() : null))
  .then((s) => {
    const btn = document.getElementById('nav-app');
    if (!btn || !s || !s.venue) return;
    btn.textContent = '← Back to guest list';
    btn.href = '/app#/settings';
  })
  .catch(() => {});
