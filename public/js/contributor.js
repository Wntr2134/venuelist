'use strict';

/* global h, clear, put, api, toast, modal, confirmDialog, promptDeviceName, currentName, fmtDate, fmtDateTime, field, formData */

const root = document.getElementById('app');
const token = location.pathname.split('/').filter(Boolean)[1];
const base = `/api/c/${token}`;
let view = null;

async function load() {
  try {
    view = await api('GET', base);
  } catch (err) {
    put(root, h('main', { class: 'center' }, h('div', { class: 'card narrow' }, h('h1', null, 'Link not available'), h('p', null, err.message))));
    return;
  }
  applyTheme(view.theme);
  document.title = `${view.event.name} · Guest list`;
  draw();
}

function draw() {
  const v = view;
  const locked = v.locked;
  const alloc = v.contributor.allocation;

  const form = h('form', { class: 'card stack add-form' },
    h('h3', null, 'Add a guest'),
    h('div', { class: 'grid-2-1' },
      field('Full name', h('input', { name: 'name', required: true, maxlength: '120', autocomplete: 'off', placeholder: 'As it appears on their ID' })),
      field('Plus ones', h('input', { name: 'plusOnes', type: 'number', min: '0', max: '50', value: '0', inputmode: 'numeric' }))
    ),
    field('Note for the door (optional)', h('input', { name: 'notes', maxlength: '500', placeholder: 'e.g. Photographer, bandmate’s partner' })),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Add to list')
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const d = formData(form);
    try {
      view = await api('POST', `${base}/guests`, { name: d.name, plusOnes: Number(d.plusOnes) || 0, notes: d.notes });
      toast(`${d.name} added`, 'ok');
      draw();
      const again = root.querySelector('.add-form input[name="name"]');
      if (again) again.focus();
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  });

  const rows = v.guests.map((g) =>
    h('li', { class: 'portal-guest' },
      h('div', null,
        h('div', { class: 'guest-name' }, g.name, g.plusOnes ? h('span', { class: 'plus' }, `+${g.plusOnes}`) : null),
        g.notes ? h('div', { class: 'muted small' }, g.notes) : null,
        h('div', { class: 'muted small' }, `Added by ${g.addedBy} · ${fmtDateTime(g.createdAt)}`)
      ),
      g.admitted
        ? h('span', { class: 'status status-in' }, 'Arrived')
        : locked
          ? null
          : h('div', { class: 'row' },
            h('button', { class: 'btn btn-small', onclick: () => edit(g) }, 'Edit'),
            h('button', { class: 'btn btn-small btn-ghost-danger', onclick: () => remove(g) }, 'Remove')
          )
    )
  );

  put(root, 
    h('header', { class: 'topbar' },
      h('div', { class: 'topbar-left' },
        h('span', { class: 'logo' }, '★'),
        h('div', { class: 'topbar-title' }, h('strong', null, v.venueName), h('small', null, 'Guest list'))
      ),
      h('div', { class: 'topbar-right' },
        h('button', { class: 'chip chip-user', onclick: () => promptDeviceName({ force: true }) }, '👤 ', currentName())
      )
    ),
    h('main', { class: 'page portal' },
      h('div', { class: 'card portal-head' },
        h('div', { class: 'event-date' }, fmtDate(v.event.date), v.event.doorsTime ? ` · Doors ${v.event.doorsTime}` : ''),
        h('h1', null, v.event.name),
        h('p', null, 'Guest list for ', h('strong', null, v.contributor.name), ' · ', v.contributor.listType),
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, v.used), h('div', { class: 'stat-label' }, 'heads on your list')),
          h('div', { class: 'stat stat-accent' }, h('div', { class: 'stat-value' }, alloc === null ? '∞' : v.remaining), h('div', { class: 'stat-label' }, alloc === null ? 'no limit' : `left of ${alloc}`))
        ),
        v.event.cutoffAt && !locked ? h('p', { class: 'muted small' }, `List closes ${fmtDateTime(v.event.cutoffAt)}.`) : null
      ),
      locked ? h('div', { class: 'notice' }, '🔒 ', locked, ' Contact the venue if you need changes.') : form,
      h('div', { class: 'card' },
        h('h3', null, `Your guests (${v.guests.length})`),
        rows.length ? h('ul', { class: 'portal-list' }, rows) : h('p', { class: 'muted' }, 'No one yet.')
      ),
      h('p', { class: 'muted small center-text' }, 'Every change is recorded with the name on this device.')
    )
  );
}

function edit(g) {
  const form = h('form', { class: 'stack' },
    h('div', { class: 'grid-2-1' },
      field('Full name', h('input', { name: 'name', required: true, maxlength: '120', value: g.name })),
      field('Plus ones', h('input', { name: 'plusOnes', type: 'number', min: '0', max: '50', value: g.plusOnes }))
    ),
    field('Note for the door', h('input', { name: 'notes', maxlength: '500', value: g.notes || '' }))
  );
  const submit = async (e) => {
    if (e) e.preventDefault();
    if (!form.reportValidity()) return;
    const d = formData(form);
    try {
      view = await api('PUT', `${base}/guests/${g.id}`, { name: d.name, plusOnes: Number(d.plusOnes) || 0, notes: d.notes });
      m.close();
      toast('Saved', 'ok');
      draw();
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  };
  form.addEventListener('submit', submit);
  const m = modal('Edit guest', form, {
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', onclick: submit }, 'Save')],
  });
}

async function remove(g) {
  const ok = await confirmDialog('Remove guest?', `Take ${g.name} off your list?`, { confirmText: 'Remove', danger: true });
  if (!ok) return;
  try {
    view = await api('DELETE', `${base}/guests/${g.id}`);
    toast('Removed', 'ok');
    draw();
  } catch (err) {
    toast(err.message, 'error', 5000);
  }
}

(async () => {
  await load();
  if (!view) return;
  await promptDeviceName({ context: 'Add your name so the venue knows who put each guest on the list. You only need to do this once on this device.' });
  draw();
  document.addEventListener('vl:name', draw);
  // Keep counts fresh if several people share this link.
  setInterval(() => {
    if (!document.querySelector('.modal-backdrop') && !root.querySelector('.add-form input:focus')) load();
  }, 30000);
})();
