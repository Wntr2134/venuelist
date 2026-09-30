'use strict';

/* global h, clear, put, api, ApiError, toast, modal, confirmDialog, promptDeviceName, currentName,
   fmtDate, fmtDateTime, fmtTime, toLocalInput, fromLocalInput, field, formData, norm */

const app = document.getElementById('app');
const state = { venueName: 'Venue', venueSlug: '', stream: null, cleanup: [] };
const LIST_TYPES = ['Guest', 'Artist', 'Crew', 'Industry', 'Media', 'Venue', 'Door'];

// ---------- boot & routing ----------

async function boot() {
  let session;
  try {
    session = await api('GET', '/api/session');
  } catch (err) {
    return renderFatal(err.message);
  }
  if (!session.authed) return toLogin();
  state.venueName = session.venue.name;
  state.venueSlug = session.venue.slug;
  state.hasManagerPin = session.venue.hasManagerPin;
  state.defaults = session.venue.defaults || {};
  document.title = `${session.venue.name} · Guest List`;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
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
    return toLogin();
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
    if (onMessage && onMessage(msg) === true) return; // handled without a reload
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

function toLogin() {
  teardown();
  let last = '';
  try {
    last = localStorage.getItem('vl.lastVenue') || '';
  } catch {
    /* ignore */
  }
  location.replace(last ? `/v/${encodeURIComponent(last)}` : '/login');
}

// ---------- events list ----------

async function renderEvents(archived) {
  const events = await api('GET', `/api/events${archived ? '?archived=1' : ''}`).catch(handleError);
  if (!events) return;
  const today = localDate();

  const list = events.length
    ? h('div', { class: 'event-grid' }, events.map((e) => eventCard(e, today)))
    : h('div', { class: 'empty' }, archived ? 'No archived events.' : 'No upcoming events yet. Create your first one.');

  put(app, 
    topbar({
      right: h('a', { class: 'icon-btn', href: '#/settings', title: 'Venue settings', 'aria-label': 'Settings' }, '⚙'),
    }),
    h('main', { class: 'page' },
      state.hasManagerPin ? null : h('a', { class: 'pin-banner', href: `/v/${state.venueSlug}/admin` },
        h('strong', null, '🔒 No manager codes yet'),
        h('span', null, ' — until your venue admin adds them, staff can go over capacity and guest list limits with just a tap. Open venue admin →')),
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
  const d0 = state.defaults || {};
  const e = existing || { venueCapacity: d0.capacity ?? null, countGuestlist: !!d0.countGuestlist };
  const form = h('form', { class: 'stack' },
    field('Event name', h('input', { name: 'name', required: true, maxlength: '120', value: e.name || '', placeholder: 'Artist / show name' })),
    h('div', { class: 'grid-2' },
      field('Date', h('input', { name: 'date', type: 'date', required: true, value: e.date || localDate() })),
      field('Doors', h('input', { name: 'doorsTime', type: 'time', value: e.doorsTime || '' }))
    ),
    h('div', { class: 'grid-2' },
      field('Guest list cutoff', h('input', { name: 'cutoffAt', type: 'datetime-local', value: toLocalInput(e.cutoffAt) }), 'Contributor links lock after this.'),
      field('Guest list cap (heads)', h('input', { name: 'capacity', type: 'number', min: '1', value: e.capacity ?? '' }), 'Optional total across all lists.')
    ),
    h('div', { class: 'grid-2' },
      field('Venue capacity (door counter)', h('input', { name: 'venueCapacity', type: 'number', min: '1', value: e.venueCapacity ?? '', placeholder: 'e.g. 500' }), 'For the + / − counter in door mode.'),
      h('label', { class: 'check check-top' }, h('input', { type: 'checkbox', name: 'countGuestlist', checked: !!e.countGuestlist }),
        h('span', null, 'Guest list check-ins also add to the door count', h('small', { class: 'muted block' }, 'Leave off if someone’s clicking everyone through the door.')))
    ),
    field('Notes for door staff', h('textarea', { name: 'notes', rows: '3', maxlength: '2000' }, e.notes || ''))
  );
  const submit = async (ev) => {
    if (ev) ev.preventDefault();
    if (!form.reportValidity()) return;
    const d = formData(form);
    const body = { ...d, cutoffAt: fromLocalInput(d.cutoffAt), capacity: d.capacity || null, venueCapacity: d.venueCapacity || null };
    try {
      const saved = await withOverride((extra) => existing
        ? api('PUT', `/api/events/${e.id}`, { ...body, ...extra })
        : api('POST', '/api/events', { ...body, ...extra }));
      if (!saved) return;
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

  const statsBox = h('div', { class: 'stats event-stats' });
  const tabBody = h('div', { class: 'tab-body' });
  const tabs = ['guests', 'contributors', 'report', 'activity', 'settings'];
  const tabLabels = { guests: 'Guest list', contributors: 'Contributors', report: 'Report', activity: 'Activity', settings: 'Event settings' };
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
    else if (tab === 'report') tabBody.append(reportTab(id));
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
        h('table', { class: 'table guest-table' },
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
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn', onclick: () => copyContributors(data, load) }, 'Copy from another show'),
          h('button', { class: 'btn btn-primary', onclick: () => contributorForm(data, null, load) }, '+ Add contributor')
        )
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
          h('dt', null, 'Venue capacity'), h('dd', null, e.venueCapacity ? `${e.venueCapacity} (door counter)` : 'Not set'),
          h('dt', null, 'Door count'), h('dd', null, e.countGuestlist ? 'Clicker + guest list check-ins' : 'Clicker only'),
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
                const done = await withOverride((extra) => api('DELETE', `/api/events/${id}`, extra));
                if (!done) return;
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
    case 'event.create': return a.detail ? `created the event (${a.detail})` : 'created the event';
    case 'contributor.copy': return `copied contributors — ${a.detail}`;
    case 'event.purge': return `privacy clean-up — ${a.detail}`;
    case 'override': return `override: ${a.detail}`;
    case 'count.set': return `set the door count ${a.detail}`;
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

  const submit = async (ev) => {
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
    };
    try {
      const saved = await withOverride((extra) => editing
        ? api('PUT', `/api/guests/${g.id}`, { ...body, ...extra })
        : api('POST', `/api/events/${data.event.id}/guests`, { ...body, ...extra }));
      if (!saved) return;
      m.close();
      toast(editing ? 'Guest saved' : `${body.name} added`, 'ok');
      onDone();
    } catch (err) {
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
      const r = await withOverride((extra) => api('POST', `/api/events/${data.event.id}/guests/import`, {
        text: d.text,
        contributorId: d.contributorId ? Number(d.contributorId) : null,
        listType: d.listType,
        ...extra,
      }));
      if (!r) return;
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
  const warn = g.admitted ? ` ${g.admitted} of this party already checked in, so a manager code will be needed. Their door history stays in the activity log.` : '';
  const ok = await confirmDialog('Remove guest?', `Remove ${g.name}${g.plusOnes ? ` +${g.plusOnes}` : ''} from the list?${warn}`, { confirmText: 'Remove', danger: true });
  if (!ok) return;
  try {
    const r = await withOverride((extra) => api('DELETE', `/api/guests/${g.id}`, extra));
    if (!r) return;
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
      const saved = await withOverride((extra) => c
        ? api('PUT', `/api/contributors/${c.id}`, { ...body, ...extra })
        : api('POST', `/api/events/${data.event.id}/contributors`, body));
      if (!saved) return;
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

async function copyContributors(data, onDone) {
  let events;
  try {
    const [live, archived] = await Promise.all([api('GET', '/api/events'), api('GET', '/api/events?archived=1')]);
    events = [...live, ...archived].filter((e) => e.id !== data.event.id && e.contributorCount > 0)
      .sort((a, b) => b.date.localeCompare(a.date));
  } catch (err) {
    return handleError(err);
  }
  if (!events.length) return toast('No other shows with contributors yet.', 'info');
  const sel = h('select', null, events.map((e) => h('option', { value: String(e.id) }, `${fmtDate(e.date)} — ${e.name} (${e.contributorCount})`)));
  const submit = async () => {
    try {
      const r = await api('POST', `/api/events/${data.event.id}/contributors/copy`, { fromEventId: Number(sel.value) });
      m.close();
      toast(`Copied ${r.added} contributor${r.added === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} already here)` : ''} — each has a new link to send`, 'ok', 5000);
      onDone();
    } catch (err) {
      handleError(err);
    }
  };
  const m = modal('Copy contributors', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Copies names, lists and allocations — “same as last Friday”. Guests aren’t copied, and each contributor gets a fresh link to send.'),
    field('From', sel)
  ), {
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', onclick: submit }, 'Copy')],
  });
}

// ---------- night report ----------

function reportTab(id) {
  const box = h('div', { class: 'stack report' }, h('div', { class: 'muted' }, 'Loading…'));
  api('GET', `/api/events/${id}/report`).then((r) => put(box, reportView(id, r))).catch(handleError);
  return box;
}

// Arrivals per 15 minutes, in this phone's local time.
function arrivalsChart(points, title) {
  if (!points.length) return h('div', { class: 'empty' }, 'No arrivals recorded yet.');
  const slot = 15 * 60 * 1000;
  const start = Math.floor(Date.parse(points[0].at) / slot) * slot;
  const end = Math.floor(Date.parse(points[points.length - 1].at) / slot) * slot;
  const buckets = [];
  for (let t = start; t <= end && buckets.length < 96; t += slot) buckets.push({ t, n: 0 });
  for (const p of points) {
    const i = Math.floor((Math.floor(Date.parse(p.at) / slot) * slot - start) / slot);
    if (buckets[i]) buckets[i].n += p.count;
  }
  const max = Math.max(...buckets.map((b) => b.n), 1);
  const peak = buckets.reduce((a, b) => (b.n > a.n ? b : a), buckets[0]);
  const label = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const tip = h('div', { class: 'chart-tip', role: 'status' });
  const bars = buckets.map((b) => h('div', {
    class: 'chart-col',
    tabindex: '0',
    'aria-label': `${label(b.t)}: ${b.n} in`,
    onmouseenter: (e) => showTip(e.currentTarget, b),
    onfocus: (e) => showTip(e.currentTarget, b),
    onmouseleave: () => tip.classList.remove('show'),
    onblur: () => tip.classList.remove('show'),
  },
    h('div', { class: 'chart-bar', style: `height:${b.n ? Math.max(3, (b.n / max) * 100) : 0}%` }),
    new Date(b.t).getMinutes() === 0 ? h('span', { class: 'chart-x' }, label(b.t)) : null
  ));
  function showTip(el, b) {
    tip.textContent = `${label(b.t)}–${label(b.t + slot)} · ${b.n} in`;
    const r = el.getBoundingClientRect();
    const pr = el.parentElement.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(r.left - pr.left + r.width / 2, 60), pr.width - 60)}px`;
    tip.classList.add('show');
  }
  return h('div', { class: 'chart' },
    h('div', { class: 'chart-head' },
      h('strong', null, title),
      h('span', { class: 'muted small' }, `Busiest: ${label(peak.t)} (${peak.n} in 15 min)`)
    ),
    h('div', { class: 'chart-plot' },
      h('div', { class: 'chart-y small muted' }, h('span', null, String(max)), h('span', null, '0')),
      h('div', { class: 'chart-cols' }, bars, tip)
    ),
    h('details', { class: 'chart-table small' },
      h('summary', null, 'Show as a table'),
      h('table', { class: 'table mini-table' },
        h('thead', null, h('tr', null, h('th', null, 'Time'), h('th', null, 'In'))),
        h('tbody', null, buckets.filter((b) => b.n).map((b) => h('tr', null, h('td', null, `${label(b.t)}–${label(b.t + slot)}`), h('td', null, b.n))))
      )
    )
  );
}

function reportView(id, r) {
  const e = r.event;
  const tile = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label), sub ? h('div', { class: 'stat-sub' }, sub) : null);
  const door = r.door;
  const useDoor = r.arrivals.doorIn.length > 0;
  const table = (cols, rows) => h('div', { class: 'table-wrap' }, h('table', { class: 'table report-table' },
    h('thead', null, h('tr', null, cols.map((c) => h('th', null, c)))),
    h('tbody', null, rows)
  ));
  return [
    h('div', { class: 'report-head' },
      h('div', null,
        h('div', { class: 'muted small' }, r.venueName),
        h('h2', null, `Night report — ${e.name}`),
        h('div', { class: 'muted small' }, `${fmtDate(e.date)}${e.doorsTime ? ` · doors ${e.doorsTime}` : ''}${r.firstIn ? ` · first in ${fmtTime(r.firstIn)}` : ''}`)
      ),
      h('div', { class: 'row wrap no-print' },
        h('button', { class: 'btn', onclick: () => window.print() }, 'Print / save PDF'),
        r.canEmail ? h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            try {
              const x = await api('POST', `/api/events/${id}/report/email`);
              toast(`Report emailed to ${x.to}`, 'ok', 4000);
            } catch (err) {
              handleError(err);
            }
          },
        }, `Email to ${r.emailTo}`) : null
      )
    ),
    r.purged ? h('p', { class: 'muted small' }, 'Guest names were removed after the venue’s privacy period — counts are kept.') : null,
    h('h3', null, 'Door count'),
    h('div', { class: 'stats' },
      tile('Peak inside', door.peak, door.capacity ? `capacity ${door.capacity}` : 'no capacity set'),
      tile('Total in', door.totalIn),
      tile('Total out', door.totalOut),
      tile('At close', door.count)
    ),
    ticketsSection(id, r),
    h('h3', null, 'Guest list'),
    h('div', { class: 'stats' },
      tile('On the list', r.guestlist.heads, `${r.guestlist.entries} entries`),
      tile('Arrived', r.guestlist.arrived, r.guestlist.heads ? `${Math.round((r.guestlist.arrived / r.guestlist.heads) * 100)}%` : ''),
      tile('No-shows', r.guestlist.noShow),
      tile('VIP', r.guestlist.vip)
    ),
    arrivalsChart(useDoor ? r.arrivals.doorIn : r.arrivals.checkins, useDoor ? 'People in — door count, per 15 minutes' : 'Guest list arrivals, per 15 minutes'),
    h('h3', null, 'By contributor'),
    r.byContributor.length ? table(['Contributor', 'List', 'Heads', 'Arrived', 'No-shows'], r.byContributor.map((c) => h('tr', null,
      h('td', null, c.name), h('td', null, c.listType),
      h('td', null, c.allocation != null ? `${c.heads} / ${c.allocation}` : c.heads), h('td', null, c.arrived), h('td', null, c.noShow)
    ))) : h('p', { class: 'muted' }, 'No guests on the list.'),
    r.byList.length ? h('h3', null, 'By list') : null,
    r.byList.length ? table(['List', 'Heads', 'Arrived', 'No-shows'], r.byList.map((l) => h('tr', null,
      h('td', null, l.listType), h('td', null, l.heads), h('td', null, l.arrived), h('td', null, l.noShow)
    ))) : null,
    h('h3', null, `Overrides (${r.overrides.length})`),
    r.overrides.length
      ? h('ul', { class: 'activity' }, r.overrides.map((o) => h('li', null, h('span', { class: 'time' }, fmtDateTime(o.at)), h('span', { class: 'who' }, o.actor), h('span', { class: 'what' }, o.detail))))
      : h('p', { class: 'muted' }, 'None — no rules were broken or changed.'),
  ];
}

// Moshtix (or any ticketing) totals, typed in after the night, compared with the door count.
function ticketsSection(id, r) {
  const t = r.tickets;
  const num = (name, value, label) => field(label, h('input', { name, type: 'number', min: '0', max: '1000000', inputmode: 'numeric', value: value ?? '' }));
  const form = h('form', { class: 'ticket-form no-print' },
    num('ticketsSold', t.sold, 'Tickets sold'),
    num('ticketsScanned', t.scanned, 'Tickets scanned'),
    h('button', { class: 'btn', type: 'submit' }, 'Save')
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const d = formData(form);
    const val = (v) => (v === '' || v == null ? null : Number(v));
    try {
      await api('PUT', `/api/events/${id}`, { ticketsSold: val(d.ticketsSold), ticketsScanned: val(d.ticketsScanned) });
      const fresh = await api('GET', `/api/events/${id}/report`);
      const box = form.closest('.report');
      if (box) put(box, reportView(id, fresh));
      toast('Ticket numbers saved', 'ok');
    } catch (err) {
      handleError(err);
    }
  });
  const has = t.sold != null || t.scanned != null;
  const tile = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label), sub ? h('div', { class: 'stat-sub' }, sub) : null);
  let verdict = null;
  if (t.difference != null) {
    const d = t.difference;
    verdict = h('p', { class: 'small ticket-verdict' }, d === 0
      ? 'The door clicker matches scanned tickets plus guest list exactly.'
      : d > 0
        ? `The clicker counted ${d} more than scanned tickets plus guest list. Usually re-entries, door sales not scanned, or extra clicks. A big gap is worth asking the door team about.`
        : `The clicker counted ${-d} fewer than scanned tickets plus guest list. Usually missed clicks at a busy door.`);
  }
  return h('div', { class: 'stack ticket-section' },
    h('h3', null, 'Tickets'),
    has ? h('div', { class: 'stats' },
      tile('Sold', t.sold ?? '—'),
      tile('Scanned', t.scanned ?? '—', t.noShow != null ? `${t.noShow} didn’t come` : ''),
      t.expectedIn != null ? tile('Scanned + guest list', t.expectedIn, 'should have come in') : null,
      t.difference != null ? tile('Door clicker in', t.doorIn, `${t.difference > 0 ? '+' : ''}${t.difference} vs expected`) : null
    ) : h('p', { class: 'muted small' }, 'Type in the totals from Moshtix (or your ticketing) to compare them with the door count.'),
    verdict,
    form
  );
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
  const capBar = h('div');
  const netBar = h('div');
  // Shared clicker: taps show instantly, the server's number wins once no taps are in flight.
  const cap = { server: null, shown: 0, pending: 0, full: null };

  // Taps saved on this phone while offline, for this event.
  const queued = () => queueList().filter((op) => op.eventId === id);
  // Door-count change still waiting to sync: clicker taps, plus guest check-ins when this show counts them.
  const queuedDelta = () => queued().reduce((n, op) => {
    if (op.kind === 'count') return n + op.body.delta;
    if (op.kind === 'move' && data && data.event.countGuestlist) return n + (op.dir === 'in' ? op.body.count : -op.body.count);
    return n;
  }, 0);
  const settledCount = () => Math.max(0, (cap.server ? cap.server.count : 0) + queuedDelta());

  // Re-applies offline check-ins to freshly loaded data, so the list matches what the door did.
  function applyQueued(d) {
    for (const op of queued()) {
      if (op.kind !== 'move') continue;
      const g = d.guests.find((x) => x.id === op.guestId);
      if (!g) continue;
      g.inside = Math.max(0, Math.min(g.party, g.inside + (op.dir === 'in' ? op.body.count : -op.body.count)));
      g.admitted = Math.max(g.admitted, g.inside);
    }
  }

  function drawNet() {
    const n = queued().length;
    const probs = offline.problems;
    if (!n && !probs.length && navigator.onLine) return put(netBar);
    put(netBar, h('div', { class: `net-bar${n ? ' waiting' : ''}` },
      h('strong', null, !navigator.onLine ? '📴 Offline' : n ? (offline.flushing ? '🔄 Syncing…' : '⏳ Waiting to sync') : '⚠️ Sync issues'),
      n ? h('span', null, ` — ${n} tap${n === 1 ? '' : 's'} saved on this phone. They’ll send automatically when the connection’s back.`) : null,
      !n && !navigator.onLine ? h('span', null, ' — you can keep checking people in and counting. Everything saves on this phone.') : null,
      probs.length ? h('div', { class: 'net-probs' },
        h('div', null, `${probs.length} offline tap${probs.length === 1 ? '' : 's'} couldn’t be applied:`),
        h('ul', null, probs.slice(-5).map((p) => h('li', null, `${p.label} — ${p.error}`))),
        h('button', { class: 'linklike', onclick: () => { offline.problems = []; drawNet(); } }, 'Dismiss')
      ) : null
    ));
  }
  const onQueue = () => {
    drawNet();
    if (!queued().length && !offline.flushing) load();
  };
  const onNet = () => drawNet();
  document.addEventListener('vl:queue', onQueue);
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);
  state.cleanup.push(() => {
    document.removeEventListener('vl:queue', onQueue);
    window.removeEventListener('online', onNet);
    window.removeEventListener('offline', onNet);
  });
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
      if (err.code === 'offline') return drawNet();
      return handleError(err);
    }
    applyQueued(data);
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
    if (!cap.pending) {
      cap.server = e.headcount;
      cap.shown = settledCount();
    }
    drawCap();
    drawNet();
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
      let updated;
      try {
        updated = await withOverride((extra) => api('POST', `/api/guests/${g.id}/${dir === 'in' ? 'checkin' : 'checkout'}`, { count, ...extra }));
      } catch (err) {
        if (err.code !== 'offline') throw err;
        const ev = data.event;
        if (dir === 'in' && ev.countGuestlist && cap.server && cap.server.capacity && settledCount() + count > cap.server.capacity) {
          toast('Offline: going over capacity needs a manager code, which needs a connection. Wait for signal.', 'error', 6000);
          return;
        }
        queueAdd({
          kind: 'move', url: `/api/guests/${g.id}/${dir === 'in' ? 'checkin' : 'checkout'}`, body: { count },
          eventId: id, guestId: g.id, dir, label: `${dir === 'in' ? 'In' : 'Out'}: ${g.name}${count > 1 ? ` ×${count}` : ''}`,
        });
        g.inside = Math.max(0, Math.min(g.party, g.inside + (dir === 'in' ? count : -count)));
        g.admitted = Math.max(g.admitted, g.inside);
        toast(`📴 Saved offline — ${dir === 'in' ? 'In' : 'Out'}: ${g.name}`, 'info', 2200);
        drawList();
        drawNet();
        return;
      }
      if (!updated) return;
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

  // ----- door counter -----

  function capLevel(count, capacity) {
    if (!capacity) return 'none';
    const pct = count / capacity;
    if (pct > 1) return 'over';
    if (pct >= 0.95) return 'full';
    if (pct >= 0.8) return 'warn';
    return 'ok';
  }

  function capView(big) {
    const hc = cap.server || { capacity: null, peak: 0, totalIn: 0, totalOut: 0 };
    const count = cap.shown;
    const capacity = hc.capacity;
    const level = capLevel(count, capacity);
    const pct = capacity ? Math.min(100, Math.round((count / capacity) * 100)) : 0;
    const label = !capacity ? 'Door count'
      : level === 'over' ? `OVER CAPACITY by ${count - capacity}`
        : level === 'full' ? (count >= capacity ? 'AT CAPACITY' : `${capacity - count} left`)
          : `${capacity - count} spaces left`;
    return h('div', { class: `capbar lvl-${level}${big ? ' capbar-big' : ''}` },
      h('button', { class: 'cap-btn cap-minus', 'aria-label': 'Count one out', onclick: () => tap(-1) }, '−'),
      h('button', { class: 'cap-mid', onclick: () => capSheet(), title: 'Door count settings' },
        h('div', { class: 'cap-num' }, h('b', null, String(count)), capacity ? h('span', null, ` / ${capacity}`) : null),
        capacity ? h('div', { class: 'cap-track' }, h('div', { class: 'cap-fill', style: `width:${pct}%` })) : null,
        h('div', { class: 'cap-label' }, capacity ? label : h('span', null, 'Door count · ', h('u', null, 'set capacity')))
      ),
      h('button', { class: 'cap-btn cap-plus', 'aria-label': 'Count one in', onclick: () => tap(1) }, '+')
    );
  }

  function drawCap() {
    put(capBar,
      capView(false),
      h('div', { class: 'cap-tools small muted' },
        h('span', null, `Peak ${cap.server ? cap.server.peak : 0} · In ${cap.server ? cap.server.totalIn : 0} · Out ${cap.server ? cap.server.totalOut : 0}`),
        h('span', { class: 'row' },
          h('button', { class: 'linklike', onclick: () => capSheet() }, '⚙ Settings'),
          h('button', { class: 'linklike', onclick: () => openClicker() }, '⤢ Full screen')
        )
      )
    );
    if (cap.full) put(cap.full.body, capView(true), fullStats());
  }

  function fullStats() {
    const hc = cap.server || { peak: 0, totalIn: 0, totalOut: 0 };
    return h('div', { class: 'clicker-stats' },
      h('span', null, h('b', null, hc.peak), ' peak'),
      h('span', null, h('b', null, hc.totalIn), ' in'),
      h('span', null, h('b', null, hc.totalOut), ' out'),
      h('span', null, h('b', null, data ? data.stats.inside : 0), ' guest list inside')
    );
  }

  async function tap(delta) {
    if (delta < 0 && cap.shown <= 0) return;
    cap.pending += 1;
    cap.shown = Math.max(0, cap.shown + delta);
    drawCap();
    if (navigator.vibrate) navigator.vibrate(delta > 0 ? 12 : [8, 40, 8]);
    try {
      const r = await withOverride((extra) => api('POST', `/api/events/${id}/count`, { delta, ...extra }));
      if (r) cap.server = r;
    } catch (err) {
      if (err.code !== 'offline') handleError(err);
      else {
        const capacity = cap.server && cap.server.capacity;
        if (delta > 0 && capacity && settledCount() + delta > capacity) {
          toast('Offline: going over capacity needs a manager code, which needs a connection. Wait for signal.', 'error', 6000);
        } else {
          queueAdd({ kind: 'count', url: `/api/events/${id}/count`, body: { delta }, eventId: id, label: `Door count ${delta > 0 ? '+' : '−'}${Math.abs(delta)}` });
        }
      }
    } finally {
      cap.pending -= 1;
      if (!cap.pending && cap.server) cap.shown = settledCount();
      drawCap();
      drawNet();
    }
  }

  function openClicker() {
    const body = h('div', { class: 'clicker-body' });
    const shell = h('div', { class: 'clicker', role: 'dialog', 'aria-label': 'Door counter' },
      h('div', { class: 'clicker-head' },
        h('div', null, h('strong', null, data ? data.event.name : ''), h('div', { class: 'small muted' }, `Counting as ${currentName()}`)),
        h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => closeClicker() }, '✕')
      ),
      body
    );
    const onKey = (e) => {
      if (e.key === 'Escape') closeClicker();
      if (e.key === '+' || e.key === '=' || e.key === 'ArrowUp') tap(1);
      if (e.key === '-' || e.key === 'ArrowDown') tap(-1);
    };
    document.addEventListener('keydown', onKey);
    cap.full = { shell, body, onKey };
    document.body.append(shell);
    // Keep the screen awake while counting, where supported.
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then((l) => { if (cap.full) cap.full.lock = l; }).catch(() => {});
    drawCap();
  }

  function closeClicker() {
    if (!cap.full) return;
    document.removeEventListener('keydown', cap.full.onKey);
    if (cap.full.lock) cap.full.lock.release().catch(() => {});
    cap.full.shell.remove();
    cap.full = null;
  }
  state.cleanup.push(closeClicker);

  function capSheet() {
    const e = data.event;
    const hc = cap.server || e.headcount;
    const capInput = h('input', { type: 'number', min: '1', value: hc.capacity ?? '', placeholder: 'e.g. 500', inputmode: 'numeric' });
    const countInput = h('input', { type: 'number', min: '0', value: String(cap.shown), inputmode: 'numeric' });
    const gl = h('input', { type: 'checkbox', checked: !!e.countGuestlist });
    const save = async (body, msg) => {
      try {
        const r = await withOverride((extra) => api('PUT', `/api/events/${id}`, { ...body, ...extra }));
        if (!r) return false;
        toast(msg, 'ok');
        load();
        return true;
      } catch (err) {
        handleError(err);
        return false;
      }
    };
    const setCount = async (count, resetStats) => {
      try {
        const r = await withOverride((extra) => api('PUT', `/api/events/${id}/count`, { count, resetStats, ...extra }));
        if (!r) return;
        cap.server = r;
        cap.shown = r.count;
        drawCap();
        m.close();
        toast(resetStats ? 'Counter reset' : `Count set to ${r.count}`, 'ok');
      } catch (err) {
        handleError(err);
      }
    };
    const m = modal('Door count', h('div', { class: 'stack' },
      h('div', { class: 'cap-stats' },
        h('div', null, h('b', null, cap.shown), h('span', null, 'now')),
        h('div', null, h('b', null, hc.peak), h('span', null, 'peak')),
        h('div', null, h('b', null, hc.totalIn), h('span', null, 'in')),
        h('div', null, h('b', null, hc.totalOut), h('span', null, 'out'))
      ),
      h('div', { class: 'card stack' },
        field('Venue capacity', capInput, 'The + button asks for a manager code past this.'),
        h('button', { class: 'btn btn-primary', onclick: async () => { if (await save({ venueCapacity: capInput.value || null }, 'Capacity saved')) m.close(); } }, 'Save capacity')
      ),
      h('label', { class: 'check' }, gl, h('span', null, 'Guest list check-ins also add to the door count')),
      h('div', { class: 'card stack' },
        field('Correct the count', countInput, 'e.g. after a manual head count.'),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn', onclick: () => setCount(Number(countInput.value) || 0, false) }, 'Set count'),
          h('button', {
            class: 'btn btn-ghost-danger',
            onclick: async () => {
              const ok = await confirmDialog('Reset the counter?', 'Sets the count to 0 and clears peak, in and out for this show.', { confirmText: 'Reset', danger: true });
              if (ok) setCount(0, true);
            },
          }, 'Reset to 0')
        )
      ),
      h('p', { class: 'small muted' }, 'Changes here may need a manager code.')
    ));
    gl.addEventListener('change', async () => {
      if (!(await save({ countGuestlist: gl.checked }, gl.checked ? 'Guest list check-ins now count' : 'Guest list check-ins no longer count'))) gl.checked = !gl.checked;
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
    if (msg.type === 'count') {
      cap.server = msg.headcount;
      if (!cap.pending) cap.shown = settledCount();
      drawCap();
      return true;
    }
    if (msg.move === 'in' && msg.vip && msg.actor !== currentName()) {
      toast(`★ VIP arrived: ${msg.name} (checked in by ${msg.actor})`, 'vip', 6000);
    }
    return false;
  }

  drawFilters();
  put(app, 
    header,
    h('main', { class: 'door' },
      netBar,
      notesBar,
      capBar,
      h('div', { class: 'door-section-label small muted' }, 'Guest list'),
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
  const staffLink = `${location.origin}/v/${state.venueSlug}`;
  const access = h('div', { class: 'card stack' },
    h('h3', null, 'Staff login'),
    h('p', { class: 'muted' }, 'Staff log in with your username and password. This link fills in the username, so they only type the password.'),
    h('div', { class: 'linkbox' },
      h('input', { readonly: true, value: staffLink, onclick: (e) => e.target.select() }),
      h('button', { class: 'btn btn-small btn-primary', onclick: () => copy(staffLink) }, 'Copy')
    ),
    h('p', { class: 'small muted' }, 'Username: ', h('strong', null, state.venueSlug))
  );

  const device = h('div', { class: 'card stack' },
    h('h3', null, 'This device'),
    h('p', null, 'Signed in as ', h('strong', null, currentName()), '. Changes made here are logged under this name.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => promptDeviceName({ force: true }) }, 'Change name'),
      h('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          const waiting = queueList().length;
          if (waiting) {
            const ok = await confirmDialog('Taps still waiting to sync', `${waiting} door tap${waiting === 1 ? ' is' : 's are'} saved on this phone and haven’t reached the server yet. Logging out now will lose them.`, { confirmText: 'Log out anyway', danger: true });
            if (!ok) return;
            queueSave([]);
          }
          await api('POST', '/api/logout').catch(() => {});
          if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage('clear');
          toLogin();
        },
      }, 'Log out this device')
    )
  );

  const adminLink = `${location.origin}/v/${state.venueSlug}/admin`;
  const vadmin = h('div', { class: 'card stack' },
    h('h3', null, '👤 Venue admin'),
    h('p', { class: 'muted' }, 'Manager codes, the staff password, venue name, defaults and privacy are managed by your GM or owner in the venue admin page (it has its own password).'),
    h('div', { class: 'row wrap' }, h('a', { class: 'btn', href: adminLink }, 'Open venue admin →'))
  );

  put(app,
    topbar({ back: '#/', title: 'Settings' }),
    h('main', { class: 'page narrow-block stack' }, access, device, vadmin)
  );
}

boot();
