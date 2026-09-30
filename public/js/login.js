'use strict';

/* global h, put, api, toast, modal, field, formData */

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
    h('p', { class: 'small muted center-text' },
      h('button', { type: 'button', class: 'linklike', onclick: () => forgot(fromLink || venueInput.value) }, 'Forgot password?'),
      ' · New venue? ', h('a', { href: '/#apply' }, 'Apply for access'))
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

function forgot(prefill) {
  const input = h('input', { value: prefill || '', required: true, autocapitalize: 'none', spellcheck: 'false', placeholder: 'e.g. corner-hotel' });
  const submit = async (e) => {
    if (e) e.preventDefault();
    if (!input.value.trim()) return input.focus();
    try {
      const r = await api('POST', '/api/forgot', { username: input.value, kind: 'staff' });
      m.close();
      toast(r.message, 'ok', 6000);
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  };
  const m = modal('Forgot the staff password?', h('form', { class: 'stack', onsubmit: submit },
    h('p', { class: 'muted' }, 'We’ll email a reset link to your venue’s manager (the contact email on file). Or ask your manager — they can change it in the venue admin page.'),
    field('Username', input)
  ), {
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', onclick: submit }, 'Email a reset link')],
  });
}

start();
