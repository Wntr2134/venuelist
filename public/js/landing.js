'use strict';

(function () {
  // Returning staff go straight to their own venue's login.
  let last = '';
  try {
    last = localStorage.getItem('vl.lastVenue') || '';
  } catch {
    /* ignore */
  }
  if (last) document.getElementById('nav-login').href = `/v/${encodeURIComponent(last)}`;

  const form = document.getElementById('request-form');
  const status = document.getElementById('request-status');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form).entries());
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    status.textContent = 'Sending…';
    try {
      const res = await fetch('/api/request-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
      form.replaceChildren();
      const done = document.createElement('div');
      done.className = 'request-done';
      const h = document.createElement('h3');
      h.textContent = 'Thanks — request received ✓';
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = `We’ll email ${data.email} with a setup link for ${data.venueName}, usually the same day.`;
      done.append(h, p);
      form.append(done);
    } catch (err) {
      status.textContent = err.message;
      status.classList.add('error-text');
      btn.disabled = false;
    }
  });
})();
