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

  // Mirrors the server's username rules.
  const slug = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');

  const form = document.getElementById('signup-form');
  const status = document.getElementById('signup-status');
  const venue = form.elements.venueName;
  const user = form.elements.username;
  const echo = document.getElementById('slug-echo');
  let userTouched = false;

  venue.addEventListener('input', () => {
    if (!userTouched) user.value = slug(venue.value);
    echo.textContent = user.value || 'your-username';
  });
  user.addEventListener('input', () => {
    userTouched = true;
    echo.textContent = slug(user.value) || 'your-username';
  });
  user.addEventListener('blur', () => {
    user.value = slug(user.value);
  });

  function say(msg, isError) {
    status.textContent = msg;
    status.classList.toggle('error-text', !!isError);
  }

  function done(title, text) {
    form.replaceChildren();
    const box = document.createElement('div');
    box.className = 'request-done';
    const h = document.createElement('h3');
    h.textContent = title;
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = text;
    box.append(h, p);
    form.append(box);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    user.value = slug(user.value);
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form).entries());
    if (data.password !== data.confirm) return say('Passwords don’t match.', true);
    delete data.confirm;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    say('Sending…');
    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
      try {
        localStorage.setItem('vl.lastVenue', data.username);
      } catch {
        /* ignore */
      }
      if (body.status === 'active') {
        location.href = '/app';
        return;
      }
      done('Thanks — you’re signed up ✓',
        `We’ll email ${data.email} as soon as ${data.venueName} is approved. Then log in with username “${data.username}” and the password you just chose.`);
    } catch (err) {
      say(err.message, true);
      btn.disabled = false;
    }
  });
})();
