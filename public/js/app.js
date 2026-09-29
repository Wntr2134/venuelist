'use strict';

/* global h, clear, put, api, ApiError, toast, modal, confirmDialog, promptDeviceName, currentName,
   fmtDate, fmtDateTime, fmtTime, toLocalInput, fromLocalInput, field, formData, norm */

const app = document.getElementById('app');
const state = { venueName: 'Venue', stream: null, cleanup: [] };
const LIST_TYPES = ['Guest', 'Artist', 'Crew', 'Industry', 'Media', 'Venue', 'Door'];

// ---------- boot & routing ----------

async function boot() {
  let session;
  try {
    session = await api('GET', '/api/session');
  } catch (err) {
    return renderFatal(err.message);
  }
  state.venueName = session.venueName;
  document.title = `${session.venueName} · Guest List`;
  if (session.needsSetup) return renderSetup(session.setupCodeRequired);
  if (!session.authed) return renderLogin();
  await promptDeviceName();
  window.addEventListener('hashchange', route);
  document.addEventListener('vl:name', () => route());
  route();
}

function teardown() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  for (const fn of state.cleanup) fn();
  state.cleanup = [];
}

function route() {
  teardown();
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);
  try {
    if (parts[0] === 'event' && parts[1]) return renderEvent(Number(parts[1]), parts[2] || 'guests');
    if (parts[0] === 'door' && parts[1]) return renderDoor(Number(parts[1]));
    if (parts[0] === 'settings') return renderSettings();
    if (parts[0] === 'archive') return renderEvents(true);
    return renderEvents(false);
  } catch (err) {
    handleError(err);
  }
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function handleError(err) {
  if (err instanceof ApiError && err.status === 401) {
    teardown();
    return renderLogin();
  }
  toast(err.message || 'Something went wrong', 'error', 5000);
}

// Subscribe to live changes for an event; calls onChange (debounced) whenever another device edits.
function live(eventId, onChange, onMessage) {
  let timer = null;
  const es = new EventSource(`/api/events/${eventId}/stream`);
  es.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'hello') return;
    if (onMessage) onMessage(msg);
    clearTimeout(timer);
    timer = setTimeout(onChange, 150);
  };
  es.onerror = () => setLiveStatus(false);
  es.onopen = () => setLiveStatus(true);
  state.stream = es;
  // Safety net in case the stream is silently dropped by a proxy.
  const poll = setInterval(onChange, 30000);
  state.cleanup.push(() => {
    clearInterval(poll);
    clearTimeout(timer);
  });
}

function setLiveStatus(ok) {
  const dot = document.getElementById('live-dot');
  if (dot) {
    dot.classList.toggle('offline', !ok);
    dot.title = ok ? 'Live — syncing with other devices' : 'Reconnecting…';
  }
}

// ---------- chrome ----------

function topbar({ back, title, sub, right } = {}) {
  return h('header', { class: 'topbar' },
    h('div', { class: 'topbar-left' },
      back ? h('a', { class: 'icon-btn', href: back, 'aria-label': 'Back' }, '←') : h('span', { class: 'logo' }, '★'),
      h('div', { class: 'topbar-title' },
        h('strong', null, title || state.venueName),
        sub ? h('small', null, sub) : null
      )
    ),
    h('div', { class: 'topbar-right' },
      right || null,
      h('button', {
        class: 'chip chip-user',
        title: 'Change who is using this device',
        onclick: () => promptDeviceName({ force: true }),
      }, '👤 ', currentName())
    )
  );
}

function renderFatal(msg) {
  put(app, h('main', { class: 'center' }, h('div', { class: 'card narrow' }, h('h1', null, 'Can’t reach the server'), h('p', null, msg))));
}

// ---------- setup / login ----------

function renderSetup(needsCode) {
  const form = h('form', { class: 'card narrow stack' },
    h('h1', null, 'Set up your venue'),
    h('p', { class: 'muted' }, 'One shared account for the whole venue. Staff and door crew all log in with this password, then put their own name on their device.'),
    needsCode
      ? field('Setup code', h('input', { name: 'setupCode', required: true, maxlength: '20', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' }), 'Printed in the server log when the app first starts (journalctl -u guestlist).')
      : null,
    field('Venue name', h('input', { name: 'venueName', required: true, maxlength: '80', placeholder: 'e.g. Brunswick Ballroom' })),
    field('Venue password', h('input', { name: 'password', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' }), 'At least 8 characters.'),
    field('Confirm password', h('input', { name: 'confirm', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' })),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Create venue account')
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    if (d.password !== d.confirm) return toast('Passwords don’t match', 'error');
    try {
      await api('POST', '/api/setup', { venueName: d.venueName, password: d.password, setupCode: d.setupCode });
      location.hash = '';
      boot();
    } catch (err) {
      handleError(err);
    }
  });
  put(app, h('main', { class: 'center' }, form));
}

function renderLogin() {
  const form = h('form', { class: 'card narrow stack' },
    h('div', { class: 'brand' }, h('span', { class: 'logo big' }, '★'), h('h1', null, state.venueName)),
    h('p', { class: 'muted' }, 'Guest list & door'),
    field('Venue password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Log in')
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/login', formData(form));
      boot();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  put(app, h('main', { class: 'center' }, form));
}

// ---------- events list ----------

async function renderEvents(archived) {
  const events = await api('GET', `/api/events${archived ? '?archived=1' : ''}`).catch(handleError);
  if (!events) return;
  const today = new Date().toISOString().slice(0, 10);

  const list = events.length
    ? h('div', { class: 'event-grid' }, events.map((e) => eventCard(e, today)))
    : h('div', { class: 'empty' }, archived ? 'No archived events.' : 'No upcoming events yet. Create your first one.');

  put(app, 
    topbar({
      right: h('a', { class: 'icon-btn', href: '#/settings', title: 'Venue settings', 'aria-label': 'Settings' }, '⚙'),
    }),
    h('main', { class: 'page' },
      h('div', { class: 'page-head' },
        h('h1', null, archived ? 'Archived events' : 'Events'),
        h('div', { class: 'row' },
          h('a', { class: 'btn', href: archived ? '#/' : '#/archive' }, archived ? 'Upcoming' : 'Archive'),
          archived ? null : h('button', { class: 'btn btn-primary', onclick: () => eventForm() }, '+ New event')
        )
      ),
      list
    )
  );
}

function eventCard(e, today) {
  const isToday = e.date === today;
  const past = e.date < today;
  return h('div', { class: `card event-card${isToday ? ' today' : ''}${past ? ' past' : ''}` },
    h('a', { class: 'event-card-main', href: `#/event/${e.id}` },
      h('div', { class: 'event-date' }, isToday ? h('span', { class: 'badge badge-live' }, 'TONIGHT') : null, fmtDate(e.date), e.doorsTime ? ` · Doors ${e.doorsTime}` : ''),
      h('h3', null, e.name),
      h('div', { class: 'event-meta' },
        h('span', null, `${e.expected} on list`),
        h('span', null, `${e.guestCount} entries`),
        h('span', null, `${e.contributorCount} contributor${e.contributorCount === 1 ? '' : 's'}`),
        e.admitted ? h('span', null, `${e.admitted} arrived`) : null
      )
    ),
    h('div', { class: 'event-card-actions' },
      h('a', { class: 'btn btn-small', href: `#/event/${e.id}` }, 'Manage'),
      h('a', { class: 'btn btn-small btn-primary', href: `#/door/${e.id}` }, 'Door mode')
    )
  );
}

function eventForm(existing) {
  const e = existing || {};
  const form = h('form', { class: 'stack' },
    field('Event name', h('input', { name: 'name', required: true, maxlength: '120', value: e.name || '', placeholder: 'Artist / show name' })),
    h('div', { class: 'grid-2' },
      field('Date', h('input', { name: 'date', type: 'date', required: true, value: e.date || new Date().toISOString().slice(0, 10) })),
      field('Doors', h('input', { name: 'doorsTime', type: 'time', value: e.doorsTime || '' }))
    ),
    h('div', { class: 'grid-2' },
      field('Guest list cutoff', h('input', { name: 'cutoffAt', type: 'datetime-local', value: toLocalInput(e.cutoffAt) }), 'Contributor links lock after this.'),
      field('Guest list cap (heads)', h('input', { name: 'capacity', type: 'number', min: '1', value: e.capacity ?? '' }), 'Optional total across all lists.')
    ),
    field('Notes for door staff', h('textarea', { name: 'notes', rows: '3', maxlength: '2000' }, e.notes || ''))
  );
  const submit = async (ev) => {
    if (ev) ev.preventDefault();
    if (!form.reportValidity()) return;
    const d = formData(form);
    const body = { ...d, cutoffAt: fromLocalInput(d.cutoffAt), capacity: d.capacity || null };
    try {
      const saved = existing ? await api('PUT', `/api/events/${e.id}`, body) : await api('POST', '/api/events', body);
      m.close();
      toast(existing ? 'Event saved' : 'Event created', 'ok');
      go(`#/event/${saved.id}/${existing ? 'settings' : 'contributors'}`);
    } catch (err) {
      handleError(err);
    }
  };
  form.addEventListener('submit', submit);
  const m = modal(existing ? 'Edit event' : 'New event', form, {
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', onclick: submit }, existing ? 'Save' : 'Create event')],
  });
}

// ---------- event management ----------

async function renderEvent(id, tab) {
  let data;
  const ui = { search: '', contributor: state.guestFilter && state.guestFilter.eventId === id ? state.guestFilter.contributor : 'all' };

  const statsBox = h('div', { class: 'stats' });
  const tabBody = h('div', { class: 'tab-body' });
  const tabs = ['guests', 'contributors', 'activity', 'settings'];
  const tabLabels = { guests: 'Guest list', contributors: 'Contributors', activity: 'Activity', settings: 'Event settings' };
  const header = h('div');

  async function load() {
    try {
      data = await api('GET', `/api/events/${id}`);
    } catch (err) {
      if (err.status === 404) {
        toast('Event not found', 'error');
        return go('#/');
      }
      return handleError(err);
    }
    draw();
  }

  function draw() {
    const e = data.event;
    put(header, 
      topbar({
        back: e.archived ? '#/archive' : '#/',
        title: e.name,
        sub: `${fmtDate(e.date)}${e.doorsTime ? ` · Doors ${e.doorsTime}` : ''}`,
        right: h('span', { id: 'live-dot', class: 'live-dot', title: 'Live' }),
      })
    );
    put(statsBox, statTiles(data.stats, e));
    const active = document.activeElement;
    const keepFocus = active && active.dataset && active.dataset.keep;
    const caret = keepFocus ? active.selectionStart : null;
    clear(tabBody);
    if (tab === 'guests') tabBody.append(guestsTab());
    else if (tab === 'contributors') tabBody.append(contributorsTab());
    else if (tab === 'activity') tabBody.append(activityTab());
    else tabBody.append(settingsTab());
    if (keepFocus) {
      const again = tabBody.querySelector(`[data-keep="${keepFocus}"]`);
      if (again) {
        again.focus();
        if (caret !== null && again.setSelectionRange) again.setSelectionRange(caret, caret);
      }
    }
  }

  // --- guests tab ---
  function guestsTab() {
    const q = norm(ui.search);
    const rows = data.guests.filter((g) => {
      if (ui.contributor === 'venue' && g.contributorId) return false;
      if (ui.contributor !== 'all' && ui.contributor !== 'venue' && String(g.contributorId) !== ui.contributor) return false;
      if (!q) return true;
      return norm(`${g.name} ${g.notes || ''} ${g.contributorName || ''} ${g.listType}`).includes(q);
    });

    const search = h('input', {
      type: 'search',
      placeholder: 'Search guests…',
      value: ui.search,
      'data-keep': 'guest-search',
      oninput: (ev) => {
        ui.search = ev.target.value;
        draw();
      },
    });
    const filter = h('select', {
      onchange: (ev) => {
        ui.contributor = ev.target.value;
        state.guestFilter = { eventId: id, contributor: ui.contributor };
        draw();
      },
    },
      h('option', { value: 'all' }, 'All contributors'),
      h('option', { value: 'venue' }, 'Venue (direct)'),
      data.contributors.map((c) => h('option', { value: String(c.id) }, c.name))
    );
    filter.value = ui.contributor;

    const table = rows.length
      ? h('div', { class: 'table-wrap' },
        h('table', { class: 'table' },
          h('thead', null, h('tr', null, h('th', null, 'Guest'), h('th', null, 'List'), h('th', null, 'Added by'), h('th', null, 'Door'), h('th', null, ''))),
          h('tbody', null, rows.map((g) =>
            h('tr', { class: g.vip ? 'vip-row' : '' },
              h('td', null,
                h('div', { class: 'guest-name' }, g.vip ? h('span', { class: 'badge badge-vip' }, 'VIP') : null, g.name, g.plusOnes ? h('span', { class: 'plus' }, `+${g.plusOnes}`) : null),
                g.notes ? h('div', { class: 'muted small' }, g.notes) : null
              ),
              h('td', null, h('span', { class: `badge badge-type t-${g.listType.toLowerCase()}` }, g.listType), h('div', { class: 'muted small' }, g.contributorName || 'Venue')),
              h('td', { class: 'small' }, g.addedBy, h('div', { class: 'muted' }, fmtDateTime(g.createdAt))),
              h('td', null, doorStatus(g)),
              h('td', { class: 'actions' },
                h('button', { class: 'btn btn-small', onclick: () => guestForm(data, g, load) }, 'Edit'),
                h('button', { class: 'btn btn-small btn-ghost-danger', onclick: () => removeGuest(g, load) }, 'Remove')
              )
            )
          ))
        )
      )
      : h('div', { class: 'empty' }, data.guests.length ? 'No guests match.' : 'No guests yet. Add some, or share contributor links so artists and promoters can add their own.');

    return h('div', { class: 'stack' },
      h('div', { class: 'toolbar' },
        search,
        filter,
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-primary', onclick: () => guestForm(data, null, load) }, '+ Add guest'),
          h('button', { class: 'btn', onclick: () => importForm(data, load) }, 'Paste list'),
          h('a', { class: 'btn', href: `/api/events/${id}/export.csv` }, 'Export CSV'),
          h('a', { class: 'btn btn-accent', href: `#/door/${id}` }, 'Door mode →')
        )
      ),
      table
    );
  }

  // --- contributors tab ---
  function contributorsTab() {
    const cards = data.contributors.map((c) => {
      const link = `${location.origin}/c/${c.token}`;
      const alloc = c.allocation === null ? '∞' : c.allocation;
      const pct = c.allocation ? Math.min(100, Math.round((c.stats.expected / c.allocation) * 100)) : 0;
      return h('div', { class: `card contributor${c.active ? '' : ' disabled'}` },
        h('div', { class: 'contributor-head' },
          h('div', null,
            h('h3', null, c.name, c.active ? null : h('span', { class: 'badge' }, 'Link disabled')),
            h('span', { class: `badge badge-type t-${c.listType.toLowerCase()}` }, c.listType),
            c.notes ? h('span', { class: 'muted small' }, ` ${c.notes}`) : null
          ),
          h('div', { class: 'alloc' }, h('strong', null, `${c.stats.expected}/${alloc}`), h('small', null, 'heads used'))
        ),
        c.allocation ? h('div', { class: 'bar' }, h('div', { class: 'bar-fill', style: `width:${pct}%` })) : null,
        h('div', { class: 'muted small' }, `${c.stats.guests} entries · ${c.stats.admitted} arrived · ${c.stats.inside} inside`),
        h('div', { class: 'linkbox' },
          h('input', { readonly: true, value: link, onclick: (ev) => ev.target.select() }),
          h('button', { class: 'btn btn-small', onclick: () => copy(link) }, 'Copy link')
        ),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn btn-small', onclick: () => contributorForm(data, c, load) }, 'Edit'),
          h('button', { class: 'btn btn-small', onclick: () => toggleContributor(c, load) }, c.active ? 'Disable link' : 'Enable link'),
          h('button', { class: 'btn btn-small', onclick: () => relink(c, load) }, 'New link'),
          h('button', {
            class: 'btn btn-small',
            onclick: () => {
              state.guestFilter = { eventId: id, contributor: String(c.id) };
              go(`#/event/${id}/guests`);
            },
          }, 'View guests'),
          h('button', { class: 'btn btn-small btn-ghost-danger', onclick: () => deleteContributor(c, load) }, 'Delete')
        )
      );
    });
    return h('div', { class: 'stack' },
      h('div', { class: 'toolbar' },
        h('p', { class: 'muted' }, 'Contributors are artists, tour managers, promoters or staff who can add guests to this show. Each gets a private link — no account needed. Their spots count against their allocation.'),
        h('button', { class: 'btn btn-primary', onclick: () => contributorForm(data, null, load) }, '+ Add contributor')
      ),
      cards.length ? h('div', { class: 'contributor-grid' }, cards) : h('div', { class: 'empty' }, 'No contributors yet.')
    );
  }

  // --- activity tab ---
  function activityTab() {
    const box = h('div', { class: 'stack' }, h('div', { class: 'muted' }, 'Loading…'));
    api('GET', `/api/events/${id}/activity?limit=500`).then((items) => {
      put(box, 
        items.length
          ? h('ul', { class: 'activity' }, items.map((a) => h('li', null,
            h('span', { class: 'time' }, fmtDateTime(a.at)),
            h('span', { class: 'who' }, a.actor, a.via !== 'venue' && a.via !== 'door' ? h('small', null, ` via ${a.via}`) : a.via === 'door' ? h('small', null, ' at door') : null),
            h('span', { class: `what act-${a.action.replace('.', '-')}` }, describe(a))
          )))
          : h('div', { class: 'empty' }, 'Nothing yet.')
      );
    }).catch(handleError);
    return box;
  }

  // --- settings tab ---
  function settingsTab() {
    const e = data.event;
    return h('div', { class: 'stack narrow-block' },
      h('div', { class: 'card stack' },
        h('h3', null, 'Details'),
        h('dl', { class: 'dl' },
          h('dt', null, 'Date'), h('dd', null, fmtDate(e.date)),
          h('dt', null, 'Doors'), h('dd', null, e.doorsTime || '—'),
          h('dt', null, 'Cutoff'), h('dd', null, e.cutoffAt ? fmtDateTime(e.cutoffAt) : 'None — contributors can add until you disable their link'),
          h('dt', null, 'Guest list cap'), h('dd', null, e.capacity ? `${e.capacity} heads` : 'None'),
          h('dt', null, 'Door notes'), h('dd', null, e.notes || '—'),
          h('dt', null, 'Created'), h('dd', null, `${fmtDateTime(e.createdAt)} by ${e.createdBy}`)
        ),
        h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', onclick: () => eventForm(e) }, 'Edit details'))
      ),
      h('div', { class: 'card stack' },
        h('h3', null, e.archived ? 'Archived' : 'Archive'),
        h('p', { class: 'muted' }, e.archived ? 'This event is archived. Contributor links are locked.' : 'Archiving hides the event from the main list and locks contributor links. Everything is kept.'),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn',
            onclick: async () => {
              try {
                await api('PUT', `/api/events/${id}`, { archived: !e.archived });
                toast(e.archived ? 'Restored' : 'Archived', 'ok');
                load();
              } catch (err) {
                handleError(err);
              }
            },
          }, e.archived ? 'Restore event' : 'Archive event'),
          h('button', {
            class: 'btn btn-danger',
            onclick: async () => {
              const ok = await confirmDialog('Delete event?', `This permanently deletes “${e.name}”, all ${data.guests.length} guest entries, contributors and history. This can’t be undone.`, { confirmText: 'Delete forever', danger: true });
              if (!ok) return;
              try {
                await api('DELETE', `/api/events/${id}`);
                toast('Event deleted', 'ok');
                go('#/');
              } catch (err) {
                handleError(err);
              }
            },
          }, 'Delete event')
        )
      )
    );
  }

  put(app, 
    header,
    h('main', { class: 'page' },
      statsBox,
      h('nav', { class: 'tabs' }, tabs.map((t) => h('a', { href: `#/event/${id}/${t}`, class: t === tab ? 'active' : '' }, tabLabels[t]))),
      tabBody
    )
  );
  await load();
  if (data) live(id, load);
}

function statTiles(s, e) {
  const tile = (label, value, sub, cls = '') => h('div', { class: `stat ${cls}` }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label), sub ? h('div', { class: 'stat-sub' }, sub) : null);
  return [
    tile('On the list', s.expected, `${s.guests} entries${e.capacity ? ` · cap ${e.capacity}` : ''}`),
    tile('Arrived', s.admitted, s.expected ? `${Math.round((s.admitted / s.expected) * 100)}%` : ''),
    tile('Inside now', s.inside, null, 'stat-accent'),
    tile('VIP', s.vip, `${s.vipInside} inside`, 'stat-vip'),
  ];
}

function doorStatus(g) {
  if (g.inside > 0) return h('span', { class: 'status status-in' }, `${g.inside}/${g.party} in`);
  if (g.admitted > 0) return h('span', { class: 'status status-out' }, 'Left');
  return h('span', { class: 'status' }, 'Not arrived');
}

function describe(a) {
  const n = a.guestName ? `${a.guestName}` : '';
  switch (a.action) {
    case 'guest.add': return `added ${n}${a.detail && a.detail !== 'import' ? ` ${a.detail}` : ''}${a.detail === 'import' ? ' (import)' : ''}`;
    case 'guest.edit': return `edited ${n}`;
    case 'guest.remove': return `removed ${n}`;
    case 'guest.checkin': return `checked in ${n} — ${a.detail}`;
    case 'guest.checkout': return `checked out ${n} — ${a.detail}`;
    case 'contributor.create': return `added contributor ${a.detail}`;
    case 'contributor.update': return `updated contributor ${a.detail}`;
    case 'contributor.relink': return `issued a new link for ${a.detail}`;
    case 'contributor.delete': return `deleted contributor ${a.detail}`;
    case 'event.create': return 'created the event';
    case 'event.update': return 'updated event details';
    case 'event.archive': return 'archived the event';
    case 'event.unarchive': return 'restored the event';
    default: return a.action;
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied', 'ok');
  } catch {
    toast('Select the link and copy it manually', 'info');
  }
}

// ---------- guest forms ----------

function guestForm(data, g, onDone, { atDoor = false } = {}) {
  const editing = !!g;
  const contribSelect = h('select', { name: 'contributorId' },
    h('option', { value: '' }, `${atDoor ? 'Door' : 'Venue'} (no contributor)`),
    data.contributors.map((c) => h('option', { value: String(c.id) }, `${c.name} — ${c.listType}`))
  );
  contribSelect.value = g && g.contributorId ? String(g.contributorId) : '';
  const typeSelect = h('select', { name: 'listType' }, LIST_TYPES.map((t) => h('option', { value: t }, t)));
  typeSelect.value = g ? g.listType : atDoor ? 'Door' : 'Guest';
  contribSelect.addEventListener('change', () => {
    const c = data.contributors.find((x) => String(x.id) === contribSelect.value);
    if (c) typeSelect.value = c.listType;
  });

  const form = h('form', { class: 'stack' },
    h('div', { class: 'grid-2-1' },
      field('Guest name', h('input', { name: 'name', required: true, maxlength: '120', value: g ? g.name : '', autocomplete: 'off' })),
      field('Plus ones', h('input', { name: 'plusOnes', type: 'number', min: '0', max: '50', value: g ? g.plusOnes : 0, inputmode: 'numeric' }))
    ),
    h('div', { class: 'grid-2' }, field('Contributor', contribSelect), field('List', typeSelect)),
    field('Notes', h('input', { name: 'notes', maxlength: '500', value: g ? g.notes || '' : '', placeholder: 'e.g. Photo pass, +1 is partner, ID check' })),
    h('label', { class: 'check vip-check' }, h('input', { type: 'checkbox', name: 'vip', checked: g ? g.vip : false }), h('span', null, '★ VIP — highlight at the door and alert when they arrive'))
  );

  const submit = async (ev, force = false) => {
    if (ev) ev.preventDefault();
    if (!form.reportValidity()) return;
    const d = formData(form);
    const body = {
      name: d.name,
      plusOnes: Number(d.plusOnes) || 0,
      contributorId: d.contributorId ? Number(d.contributorId) : null,
      listType: d.listType,
      vip: d.vip,
      notes: d.notes,
      atDoor,
      force,
    };
    try {
      if (editing) await api('PUT', `/api/guests/${g.id}`, body);
      else await api('POST', `/api/events/${data.event.id}/guests`, body);
      m.close();
      toast(editing ? 'Guest saved' : `${body.name} added`, 'ok');
      onDone();
    } catch (err) {
      if (err.status === 409 && /Allocation|full/.test(err.message)) {
        const ok = await confirmDialog('Over the limit', `${err.message} Add anyway as venue override?`, { confirmText: 'Override & save' });
        if (ok) return submit(null, true);
        return;
      }
      handleError(err);
    }
  };
  form.addEventListener('submit', submit);
  const m = modal(editing ? 'Edit guest' : atDoor ? 'Add walk-up guest' : 'Add guest', form, {
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', onclick: submit }, editing ? 'Save' : 'Add guest')],
  });
}

function importForm(data, onDone) {
  const contribSelect = h('select', { name: 'contributorId' },
    h('option', { value: '' }, 'Venue (no contributor)'),
    data.contributors.map((c) => h('option', { value: String(c.id) }, c.name))
  );
  const typeSelect = h('select', { name: 'listType' }, LIST_TYPES.map((t) => h('option', { value: t }, t)));
  contribSelect.addEventListener('change', () => {
    const c = data.contributors.find((x) => String(x.id) === contribSelect.value);
    if (c) typeSelect.value = c.listType;
  });
  const form = h('form', { class: 'stack' },
    h('p', { class: 'muted' }, 'One guest per line. Add plus-ones as “+2” or a second column. Anything after a comma becomes a note. Pastes straight from Excel or Google Sheets.'),
    h('textarea', { name: 'text', rows: '10', required: true, placeholder: 'Jane Smith +1\nAlex Nguyen, 2, photographer\nSam Lee' }),
    h('div', { class: 'grid-2' }, field('Contributor', contribSelect), field('List', typeSelect))
  );
  const submit = async (ev) => {
    if (ev) ev.preventDefault();
    const d = formData(form);
    try {
      const r = await api('POST', `/api/events/${data.event.id}/guests/import`, {
        text: d.text,
        contributorId: d.contributorId ? Number(d.contributorId) : null,
        listType: d.listType,
      });
      m.close();
      toast(`Imported ${r.added} guest${r.added === 1 ? '' : 's'}`, 'ok');
      onDone();
    } catch (err) {
      handleError(err);
    }
  };
  form.addEventListener('submit', submit);
  const m = modal('Paste a guest list', form, {
    wide: true,
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', onclick: submit }, 'Import')],
  });
}

async function removeGuest(g, onDone) {
  const warn = g.admitted ? ` ${g.admitted} of this party already checked in — their door history stays in the activity log.` : '';
  const ok = await confirmDialog('Remove guest?', `Remove ${g.name}${g.plusOnes ? ` +${g.plusOnes}` : ''} from the list?${warn}`, { confirmText: 'Remove', danger: true });
  if (!ok) return;
  try {
    await api('DELETE', `/api/guests/${g.id}`);
    toast('Removed', 'ok');
    onDone();
  } catch (err) {
    handleError(err);
  }
}

// ---------- contributor forms ----------

function contributorForm(data, c, onDone) {
  const typeSelect = h('select', { name: 'listType' }, LIST_TYPES.map((t) => h('option', { value: t }, t)));
  typeSelect.value = c ? c.listType : 'Guest';
  const form = h('form', { class: 'stack' },
    field('Name', h('input', { name: 'name', required: true, maxlength: '80', value: c ? c.name : '', placeholder: 'e.g. Headliner — Tour Manager, Promoter (Jess)' })),
    h('div', { class: 'grid-2' },
      field('Their guests go on', typeSelect),
      field('Allocation (heads)', h('input', { name: 'allocation', type: 'number', min: '0', value: c ? c.allocation ?? '' : '', placeholder: 'Unlimited' }), 'Includes plus-ones. Blank = unlimited.')
    ),
    field('Internal note', h('input', { name: 'notes', maxlength: '500', value: c ? c.notes || '' : '', placeholder: 'Only visible to venue staff' }))
  );
  const submit = async (ev) => {
    if (ev) ev.preventDefault();
    if (!form.reportValidity()) return;
    const d = formData(form);
    const body = { ...d, allocation: d.allocation === '' ? null : Number(d.allocation) };
    try {
      const saved = c ? await api('PUT', `/api/contributors/${c.id}`, body) : await api('POST', `/api/events/${data.event.id}/contributors`, body);
      m.close();
      if (!c) {
        const link = `${location.origin}/c/${saved.token}`;
        modal('Contributor link ready', h('div', { class: 'stack' },
          h('p', null, `Send this link to ${saved.name}. Anyone with it can add guests to their allocation until the cutoff.`),
          h('div', { class: 'linkbox' }, h('input', { readonly: true, value: link, onclick: (e) => e.target.select() }), h('button', { class: 'btn btn-small btn-primary', onclick: () => copy(link) }, 'Copy'))
        ));
      } else toast('Saved', 'ok');
      onDone();
    } catch (err) {
      handleError(err);
    }
  };
  form.addEventListener('submit', submit);
  const m = modal(c ? 'Edit contributor' : 'Add contributor', form, {
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', onclick: submit }, c ? 'Save' : 'Create link')],
  });
}

async function toggleContributor(c, onDone) {
  try {
    await api('PUT', `/api/contributors/${c.id}`, { active: !c.active });
    toast(c.active ? 'Link disabled' : 'Link enabled', 'ok');
    onDone();
  } catch (err) {
    handleError(err);
  }
}

async function relink(c, onDone) {
  const ok = await confirmDialog('Issue a new link?', `The old link for ${c.name} will stop working immediately. Their guests stay on the list.`, { confirmText: 'New link' });
  if (!ok) return;
  try {
    await api('POST', `/api/contributors/${c.id}/regenerate`);
    toast('New link created — copy it from the card', 'ok');
    onDone();
  } catch (err) {
    handleError(err);
  }
}

async function deleteContributor(c, onDone) {
  const ok = await confirmDialog('Delete contributor?', `Delete ${c.name}? Only possible when they have no guests.`, { confirmText: 'Delete', danger: true });
  if (!ok) return;
  try {
    await api('DELETE', `/api/contributors/${c.id}`);
    toast('Deleted', 'ok');
    onDone();
  } catch (err) {
    handleError(err);
  }
}

// ---------- door mode ----------

async function renderDoor(id) {
  let data;
  const ui = { search: '', filter: 'all' };
  const counters = h('div', { class: 'door-counters' });
  const list = h('div', { class: 'door-list' });
  const header = h('div');
  const notesBar = h('div');

  const search = h('input', {
    type: 'search',
    class: 'door-search',
    placeholder: 'Search name…',
    autocomplete: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    oninput: (ev) => {
      ui.search = ev.target.value;
      drawList();
    },
  });

  const filters = [
    ['all', 'All'],
    ['waiting', 'Not arrived'],
    ['inside', 'Inside'],
    ['left', 'Left'],
    ['vip', '★ VIP'],
  ];
  const filterBar = h('div', { class: 'chips' });
  function drawFilters() {
    put(filterBar, filters.map(([k, label]) => h('button', {
      class: `chip${ui.filter === k ? ' active' : ''}`,
      onclick: () => {
        ui.filter = k;
        drawFilters();
        drawList();
      },
    }, label)));
  }

  async function load() {
    try {
      data = await api('GET', `/api/events/${id}`);
    } catch (err) {
      return handleError(err);
    }
    draw();
  }

  function draw() {
    const e = data.event;
    put(header, topbar({
      back: `#/event/${id}`,
      title: e.name,
      sub: `Door · ${fmtDate(e.date)}${e.doorsTime ? ` · ${e.doorsTime}` : ''}`,
      right: h('span', { id: 'live-dot', class: 'live-dot', title: 'Live' }),
    }));
    put(notesBar, e.notes ? h('div', { class: 'door-notes' }, '📌 ', e.notes) : '');
    const s = data.stats;
    put(counters, 
      h('div', { class: 'counter counter-main' }, h('b', null, s.inside), h('span', null, 'inside')),
      h('div', { class: 'counter' }, h('b', null, `${s.admitted}/${s.expected}`), h('span', null, 'arrived')),
      h('div', { class: 'counter counter-vip' }, h('b', null, `${s.vipInside}/${s.vip}`), h('span', null, '★ VIP in'))
    );
    drawList();
  }

  function drawList() {
    if (!data) return;
    const q = norm(ui.search.trim());
    const terms = q.split(/\s+/).filter(Boolean);
    let rows = data.guests.filter((g) => {
      if (ui.filter === 'waiting' && g.admitted > 0) return false;
      if (ui.filter === 'inside' && g.inside === 0) return false;
      if (ui.filter === 'left' && !(g.admitted > 0 && g.inside === 0)) return false;
      if (ui.filter === 'vip' && !g.vip) return false;
      if (!terms.length) return true;
      const hay = norm(`${g.name} ${g.notes || ''} ${g.contributorName || ''} ${g.listType}`);
      return terms.every((t) => hay.includes(t));
    });
    // Names starting with the search go first, VIPs next, then alphabetical.
    if (terms.length) {
      rows = rows.sort((a, b) => Number(norm(b.name).startsWith(terms[0])) - Number(norm(a.name).startsWith(terms[0])) || a.name.localeCompare(b.name));
    }
    put(list, 
      rows.length
        ? rows.slice(0, 300).map(doorRow)
        : h('div', { class: 'empty' }, ui.search ? h('div', null, `No one called “${ui.search}”.`, h('div', null, h('button', { class: 'btn btn-primary', onclick: () => walkUp(ui.search) }, `+ Add “${ui.search}” as walk-up`))) : 'No guests here.')
    );
  }

  function doorRow(g) {
    const allIn = g.inside >= g.party;
    return h('div', { class: `door-row${g.vip ? ' vip' : ''}${g.inside ? ' is-in' : ''}${g.admitted && !g.inside ? ' has-left' : ''}` },
      h('div', { class: 'door-info' },
        h('div', { class: 'door-name' },
          g.vip ? h('span', { class: 'badge badge-vip' }, '★ VIP') : null,
          g.name,
          g.plusOnes ? h('span', { class: 'plus' }, `+${g.plusOnes}`) : null
        ),
        h('div', { class: 'door-meta' },
          h('span', { class: `badge badge-type t-${g.listType.toLowerCase()}` }, g.listType),
          h('span', null, g.contributorName || (g.addedVia === 'door' ? 'Door' : 'Venue')),
          g.inside ? h('span', { class: 'status status-in' }, `${g.inside}/${g.party} in`) : g.admitted ? h('span', { class: 'status status-out' }, `Left ${fmtTime(g.lastMoveAt)}`) : null
        ),
        g.notes ? h('div', { class: 'door-note' }, g.notes) : null
      ),
      h('div', { class: 'door-actions' },
        h('button', { class: 'btn btn-out', disabled: g.inside === 0, onclick: () => doMove(g, 'out') }, 'OUT'),
        h('button', { class: 'btn btn-in', disabled: allIn, onclick: () => doMove(g, 'in') }, allIn ? '✓ IN' : 'IN')
      )
    );
  }

  async function doMove(g, dir) {
    const room = dir === 'in' ? g.party - g.inside : g.inside;
    if (room <= 0) return;
    let count = room;
    if (room > 1) {
      count = await pickCount(g, dir, room);
      if (!count) return;
    }
    try {
      const updated = await api('POST', `/api/guests/${g.id}/${dir === 'in' ? 'checkin' : 'checkout'}`, { count });
      Object.assign(g, updated);
      toast(`${dir === 'in' ? '✓ In' : '← Out'}: ${g.name}${count > 1 ? ` ×${count}` : ''}`, dir === 'in' ? 'ok' : 'info', 1800);
      if (dir === 'in' && ui.search) {
        ui.search = '';
        search.value = '';
      }
      load();
      search.focus();
    } catch (err) {
      handleError(err);
      load();
    }
  }

  function pickCount(g, dir, room) {
    return new Promise((resolve) => {
      let done = false;
      const pick = (n) => {
        if (done) return;
        done = true;
        m.close();
        resolve(n);
      };
      const buttons = [];
      for (let n = 1; n <= room; n++) {
        buttons.push(h('button', { class: `btn btn-count ${n === room ? (dir === 'in' ? 'btn-in' : 'btn-out') : ''}`, onclick: () => pick(n) }, n === room ? `All ${n}` : String(n)));
      }
      const m = modal(`${dir === 'in' ? 'Check in' : 'Check out'} — ${g.name}`, h('div', { class: 'stack' },
        h('p', { class: 'muted' }, `Party of ${g.party} · ${g.inside} inside now. How many ${dir === 'in' ? 'are coming in' : 'are leaving'}?`),
        h('div', { class: 'count-grid' }, buttons)
      ), { onClose: () => pick(0) });
    });
  }

  function walkUp(name) {
    guestForm(data, null, load, { atDoor: true });
    setTimeout(() => {
      const input = document.querySelector('.modal input[name="name"]');
      if (input && name) input.value = name;
    }, 40);
  }

  function onMessage(msg) {
    if (msg.move === 'in' && msg.vip && msg.actor !== currentName()) {
      toast(`★ VIP arrived: ${msg.name} (checked in by ${msg.actor})`, 'vip', 6000);
    }
  }

  drawFilters();
  put(app, 
    header,
    h('main', { class: 'door' },
      notesBar,
      counters,
      h('div', { class: 'door-controls' },
        search,
        h('button', { class: 'btn', onclick: () => walkUp('') }, '+ Walk-up')
      ),
      filterBar,
      list
    )
  );
  await load();
  search.focus();
  live(id, load, onMessage);
}

// ---------- venue settings ----------

function renderSettings() {
  const nameForm = h('form', { class: 'card stack' },
    h('h3', null, 'Venue'),
    field('Venue name', h('input', { name: 'venueName', required: true, maxlength: '80', value: state.venueName })),
    h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'))
  );
  nameForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('PUT', '/api/settings', formData(nameForm));
      state.venueName = r.venueName;
      toast('Saved', 'ok');
      route();
    } catch (err) {
      handleError(err);
    }
  });

  const pwForm = h('form', { class: 'card stack' },
    h('h3', null, 'Change venue password'),
    h('p', { class: 'muted' }, 'Every other device will be logged out and need the new password.'),
    field('Current password', h('input', { name: 'currentPassword', type: 'password', required: true, autocomplete: 'current-password' })),
    field('New password', h('input', { name: 'newPassword', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' })),
    h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Change password'))
  );
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/settings', formData(pwForm));
      pwForm.reset();
      toast('Password changed', 'ok');
    } catch (err) {
      handleError(err);
    }
  });

  const device = h('div', { class: 'card stack' },
    h('h3', null, 'This device'),
    h('p', null, 'Signed in as ', h('strong', null, currentName()), '. Changes made here are logged under this name.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => promptDeviceName({ force: true }) }, 'Change name'),
      h('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          await api('POST', '/api/logout').catch(() => {});
          location.hash = '';
          renderLogin();
        },
      }, 'Log out this device')
    )
  );

  put(app, 
    topbar({ back: '#/', title: 'Settings' }),
    h('main', { class: 'page narrow-block stack' }, device, nameForm, pwForm)
  );
}

boot();
