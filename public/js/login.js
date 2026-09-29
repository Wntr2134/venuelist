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
    placeholder: 'e.g. brunswick-ballroom',
  });
  const pw = h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' });
  const form = h('form', { class: 'card narrow stack' },
    h('a', { class: 'brand', href: '/' }, h('span', { class: 'logo big' }, '★'), h('h1', null, 'Guest List')),
    h('p', { class: 'muted' }, 'Log in with your venue’s ID and password.'),
    fromLink
      ? h('div', { class: 'venue-pill' }, h('span', { class: 'muted small' }, 'Venue'), h('strong', null, fromLink),
        h('input', { type: 'hidden', name: 'venue', value: fromLink }))
      : field('Venue ID', venueInput, 'Your manager can find it in Settings.'),
    field('Venue password', pw),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Log in'),
    fromLink ? h('a', { class: 'small center-text', href: '/login' }, 'Not your venue?') : null
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
