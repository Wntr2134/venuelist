'use strict';

/* global h, put, api, toast, field, formData, setDeviceName, currentName */

const root = document.getElementById('app');
const token = location.pathname.split('/').filter(Boolean)[1];

function card(...children) {
  put(root, h('main', { class: 'center' }, h('div', { class: 'card narrow stack' }, children)));
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied', 'ok');
  } catch {
    toast('Select it and copy it manually', 'info');
  }
}

async function start() {
  let info;
  try {
    info = await api('GET', `/api/setup/${token}`);
  } catch (err) {
    return card(h('h1', null, 'Link not valid'), h('p', null, err.message));
  }
  const { venue, reset, needsAdmin } = info;

  const pw = h('input', { name: 'password', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' });
  const form = h('form', { class: 'stack' },
    field('Your name', h('input', { name: 'name', required: true, maxlength: '60', value: currentName(), placeholder: 'e.g. Sam', autocomplete: 'name' }),
      'Shown next to everything you do on this device.'),
    field(reset ? 'New staff password' : 'Choose a staff password', pw,
      'Everyone on your staff shares this password. At least 8 characters.'),
    field('Type it again', h('input', { name: 'confirm', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' })),
    needsAdmin ? h('div', { class: 'pin-box stack' },
      h('div', null, h('strong', null, '👤 Venue admin password'),
        h('p', { class: 'small muted' }, 'For the GM or owner only — don’t share it with staff. It opens your venue admin page (manager codes, staff password, settings) and also works as a manager override.')),
      field('Venue admin password', h('input', { name: 'adminPassword', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' }), 'At least 8 characters. Different from the staff password.'),
      field('Type it again', h('input', { name: 'adminConfirm', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' }))
    ) : null,
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, reset ? 'Set new password' : 'Set up my venue')
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    if (d.password !== d.confirm) return toast('Passwords don’t match', 'error');
    if (needsAdmin && d.adminPassword !== d.adminConfirm) return toast('Venue admin passwords don’t match', 'error');
    if (needsAdmin && d.adminPassword === d.password) return toast('Use a venue admin password that’s different from the staff password', 'error');
    try {
      const r = await api('POST', `/api/setup/${token}`, { password: d.password, adminPassword: needsAdmin ? d.adminPassword : undefined });
      setDeviceName(d.name.trim());
      try {
        localStorage.setItem('vl.lastVenue', r.venue.slug);
      } catch {
        /* ignore */
      }
      done(r.venue, reset);
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  });

  card(
    h('div', { class: 'brand' }, h('span', { class: 'logo big' }, '★'), h('h1', null, venue.name)),
    h('p', null, reset
      ? 'Set a new password for your venue. Devices using the old password will be logged out.'
      : 'Welcome! Set a password and you’re in. It takes 30 seconds.'),
    h('div', { class: 'venue-pill' }, h('span', { class: 'muted small' }, 'Your username'), h('strong', null, venue.slug)),
    form
  );
}

function done(venue, reset) {
  const link = `${location.origin}/v/${venue.slug}`;
  card(
    h('h1', null, reset ? 'Password updated' : 'You’re all set ✓'),
    h('p', null, 'Log in with username ', h('strong', null, venue.slug), ' and your password. Send staff this link — it fills in the username for them:'),
    h('div', { class: 'linkbox' },
      h('input', { readonly: true, value: link, onclick: (e) => e.target.select() }),
      h('button', { class: 'btn btn-small btn-primary', onclick: () => copy(link) }, 'Copy')
    ),
    h('p', { class: 'small muted' }, 'You can find this link again any time in Settings.'),
    reset ? null : h('div', { class: 'pin-box' },
      h('strong', null, 'Next: add your manager codes'),
      h('p', { class: 'small muted' }, 'Give each duty manager their own override code in your venue admin page:'),
      h('a', { class: 'btn btn-small', href: `/v/${venue.slug}/admin` }, `Open venue admin →`)),
    h('a', { class: 'btn btn-primary btn-block', href: '/app' }, 'Go to my guest list →')
  );
}

start();
