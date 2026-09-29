'use strict';

/* global h, put, api, toast, field, formData */

const root = document.getElementById('app');
const fromLink = (location.pathname.match(/^\/v\/([A-Za-z0-9_-]+)/) || [])[1] || '';

function remember(slug) {
  try {
    localStorage.setItem('vl.lastVenue', slug);
  } catch {
    /* private mode */
  }
}

function lastVenue() {
  try {
    return localStorage.getItem('vl.lastVenue') || '';
  } catch {
    return '';
  }
}

async function start() {
  try {
    const s = await api('GET', '/api/session');
    if (s.authed) return location.replace('/app');
  } catch {
    /* show the form anyway */
  }
  draw();
}

function draw() {
  const venue = fromLink || lastVenue();
  const venueInput = h('input', {
    name: 'venue',
    required: true,
    value: venue,
    autocomplete: 'username',
    autocapitalize: 'none',
    spellcheck: 'false',
    placeholder: 'e.g. corner-hotel',
  });
  const pw = h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' });
  const form = h('form', { class: 'card narrow stack' },
    h('a', { class: 'brand', href: '/' }, h('span', { class: 'logo big' }, '★'), h('h1', null, 'Guest List')),
    h('p', { class: 'muted' }, 'Log in with your venue’s username and password.'),
    fromLink
      ? h('div', { class: 'venue-pill' }, h('span', { class: 'muted small' }, 'Username'), h('strong', null, fromLink),
        h('input', { type: 'hidden', name: 'venue', value: fromLink }))
      : field('Username', venueInput),
    field('Password', pw),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Log in'),
    fromLink ? h('a', { class: 'small center-text', href: '/login' }, 'Not your venue?') : null,
    h('p', { class: 'small muted center-text' }, 'No account yet? ', h('a', { href: '/#signup' }, 'Sign up your venue'))
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    try {
      const r = await api('POST', '/api/login', d);
      remember(r.venue.slug);
      location.replace('/app');
    } catch (err) {
      toast(err.message, 'error', 5000);
      pw.select();
    }
  });
  put(root, h('main', { class: 'center' }, form));
  (fromLink || venue ? pw : venueInput).focus();
}

start();
