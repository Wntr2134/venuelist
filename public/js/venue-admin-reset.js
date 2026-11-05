'use strict';

/* global h, put, api, toast, field, formData, doorPage */

// One-time link from Riderly to choose a new venue admin password.

const root = document.getElementById('app');
const token = location.pathname.split('/').filter(Boolean)[2];

function card(...children) {
  put(root, doorPage(children));
}

async function start() {
  let info;
  try {
    info = await api('GET', `/api/venue-admin/reset/${token}`);
  } catch (err) {
    return card(h('h1', null, 'Link not valid'), h('p', null, err.message));
  }
  applyTheme(info.venue.theme);
  const form = h('form', { class: 'stack' },
    field('New venue admin password', h('input', { name: 'password', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' }), 'At least 8 characters. Different from the staff password.'),
    field('Type it again', h('input', { name: 'confirm', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' })),
    h('button', { type: 'submit' }, 'Set password')
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const d = formData(form);
    if (d.password !== d.confirm) return toast('Passwords don’t match', 'error');
    try {
      const r = await api('POST', `/api/venue-admin/reset/${token}`, { password: d.password });
      location.replace(`/v/${r.venue.slug}/admin`);
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  });
  card(
    h('h1', null, info.venue.name),
    h('p', null, 'Choose a new venue admin password. Your current one works until you save this.'),
    form
  );
}

start();
