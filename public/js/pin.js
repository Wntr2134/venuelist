'use strict';

/* global h, put, api, toast, field, formData */

const root = document.getElementById('app');
const token = location.pathname.split('/').filter(Boolean)[1];

function card(...children) {
  put(root, h('main', { class: 'center' }, h('div', { class: 'card narrow stack' }, children)));
}

async function start() {
  let info;
  try {
    info = await api('GET', `/api/pin/${token}`);
  } catch (err) {
    return card(h('h1', null, 'Link not valid'), h('p', null, err.message));
  }
  const form = h('form', { class: 'stack' },
    field('New manager PIN', h('input', { name: 'pin', type: 'password', required: true, minlength: '4', autocomplete: 'off', inputmode: 'numeric' }), 'At least 4 characters. 6 digits is a good choice.'),
    field('Type it again', h('input', { name: 'confirm', type: 'password', required: true, minlength: '4', autocomplete: 'off', inputmode: 'numeric' })),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Set new PIN')
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const d = formData(form);
    if (d.pin !== d.confirm) return toast('PINs don’t match', 'error');
    try {
      await api('POST', `/api/pin/${token}`, { pin: d.pin });
      card(
        h('h1', null, 'New PIN set ✓'),
        h('p', null, `The manager override PIN for ${info.venue.name} has changed. The old PIN no longer works.`),
        h('p', { class: 'small muted' }, 'Keep it to managers only — staff shouldn’t know it.'),
        h('a', { class: 'btn btn-primary btn-block', href: '/app' }, 'Go to the guest list →')
      );
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  });
  card(
    h('div', { class: 'brand' }, h('span', { class: 'logo big' }, '🔒'), h('h1', null, 'Manager PIN')),
    h('p', null, 'Choose a new manager override PIN for ', h('strong', null, info.venue.name), '. Your current PIN works until you save a new one.'),
    form
  );
}

start();
