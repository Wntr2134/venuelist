'use strict';

/* global h, put, api, toast, field, formData, setDeviceName, currentName */

// The link Riderly sends: a new venue picks its username and passwords here; an existing
// venue uses the same kind of link to reset its staff password.

const root = document.getElementById('app');
const token = location.pathname.split('/').filter(Boolean)[1];

function card(...children) {
  put(root, h('main', { class: 'center' }, h('div', { class: 'card narrow stack setup' }, children)));
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied', 'ok');
  } catch {
    toast('Couldn’t copy on this device. Use Share instead.', 'info');
  }
}

const slugify = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');

function step(n, title, hint, ...fields) {
  return h('section', { class: 'setup-step' },
    h('div', { class: 'setup-step-head' }, h('span', { class: 'setup-num' }, String(n)), h('div', null, h('h3', null, title), hint ? h('p', { class: 'small muted' }, hint) : null)),
    fields
  );
}

async function start() {
  let info;
  try {
    info = await api('GET', `/api/setup/${token}`);
  } catch (err) {
    return card(h('h1', null, 'Link not valid'), h('p', null, err.message));
  }
  const { venue, reset, needsAdmin, canChooseUsername } = info;

  const username = h('input', {
    name: 'username', required: true, maxlength: '40', value: venue.slug, autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false',
  });
  username.addEventListener('blur', () => { username.value = slugify(username.value); });

  let n = 0;
  const form = h('form', { class: 'stack' },
    canChooseUsername ? step(++n, 'Your venue’s username', 'Staff type this to log in. Letters, numbers and dashes.',
      field('Username', username)) : null,
    step(++n, reset ? 'New staff password' : 'Staff password', 'One password your whole team shares. At least 8 characters.',
      field('Staff password', h('input', { name: 'password', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' })),
      field('Type it again', h('input', { name: 'confirm', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' }))),
    needsAdmin ? step(++n, 'Your venue admin password', 'Just for you (the GM or owner). It unlocks manager codes and settings. Keep it different from the staff password.',
      field('Venue admin password', h('input', { name: 'adminPassword', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' })),
      field('Type it again', h('input', { name: 'adminConfirm', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' }))) : null,
    step(++n, 'Your name', 'Shown next to everything you do on this phone or computer.',
      field('Your name', h('input', { name: 'name', required: true, maxlength: '60', value: currentName(), placeholder: 'e.g. Sam', autocomplete: 'name' }))),
    h('button', { class: 'btn btn-primary btn-block btn-lg', type: 'submit' }, reset ? 'Set new password' : 'Finish setup')
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (canChooseUsername) username.value = slugify(username.value);
    if (!form.reportValidity()) return;
    const d = formData(form);
    if (d.password !== d.confirm) return toast('Staff passwords don’t match', 'error');
    if (needsAdmin && d.adminPassword !== d.adminConfirm) return toast('Venue admin passwords don’t match', 'error');
    if (needsAdmin && d.adminPassword === d.password) return toast('Use a venue admin password that’s different from the staff password', 'error');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await api('POST', `/api/setup/${token}`, {
        password: d.password,
        adminPassword: needsAdmin ? d.adminPassword : undefined,
        username: canChooseUsername ? d.username : undefined,
      });
      setDeviceName(d.name.trim());
      try {
        localStorage.setItem('vl.lastVenue', r.venue.slug);
      } catch {
        /* ignore */
      }
      done(r.venue, reset);
    } catch (err) {
      btn.disabled = false;
      toast(err.message, 'error', 5000);
    }
  });

  card(
    h('div', { class: 'brand' }, h('span', { class: 'logo big' }, '★'), h('h1', null, venue.name)),
    h('p', { class: 'muted' }, reset
      ? 'Choose a new staff password. Phones using the old one will be asked to log in again.'
      : 'Welcome to Riderly Guest List. Set up your logins and you’re ready for your next show.'),
    form
  );
}

function done(venue, reset) {
  const link = `${location.origin}/v/${venue.slug}`;
  const shareText = `Log in to ${venue.name}’s guest list here. Ask your manager for the staff password.`;
  const canShare = typeof navigator.share === 'function';
  const share = () => navigator.share({ title: `${venue.name} guest list`, text: shareText, url: link }).catch(() => {});

  if (reset) {
    return card(
      h('h1', null, 'Password updated ✓'),
      h('p', { class: 'muted' }, 'Staff log in with the new password. Everyone else has been logged out.'),
      h('a', { class: 'btn btn-primary btn-block btn-lg', href: '/app' }, 'Go to my guest list')
    );
  }
  card(
    h('div', { class: 'setup-done-mark' }, '✓'),
    h('h1', { class: 'center-text' }, 'You’re live'),
    h('p', { class: 'muted center-text' }, `${venue.name} is set up and you’re logged in on this device.`),
    h('div', { class: 'staff-login' },
      h('p', { class: 'eyebrow' }, 'Staff login'),
      h('div', { class: 'staff-login-row' },
        h('div', null, h('span', { class: 'small muted' }, 'Username'), h('strong', null, venue.slug)),
        h('div', null, h('span', { class: 'small muted' }, 'Password'), h('strong', null, 'the one you just set'))
      ),
      h('div', { class: 'row' },
        canShare ? h('button', { class: 'btn btn-primary', onclick: share }, 'Share staff link') : null,
        h('button', { class: canShare ? 'btn' : 'btn btn-primary', onclick: () => copy(link) }, 'Copy staff link')
      ),
      h('p', { class: 'small muted' }, 'The link opens your login with the username filled in. It’s also in ⚙ Settings.')
    ),
    h('ol', { class: 'apply-steps next-steps' },
      h('li', null, h('b', null, 'Add your manager codes'), h('span', null, 'One for each duty manager, so staff can’t break the rules on their own. ', h('a', { href: `/v/${venue.slug}/admin` }, 'Open venue admin'))),
      h('li', null, h('b', null, 'Create your first show'), h('span', null, 'Then add guests, or send contributor links to the artists.')),
      h('li', null, h('b', null, 'Send your team the staff link'), h('span', null, 'Door staff just need a phone.'))
    ),
    h('a', { class: 'btn btn-primary btn-block btn-lg', href: '/app' }, 'Go to my guest list')
  );
}

start();
