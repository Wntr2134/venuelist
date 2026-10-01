'use strict';

/* global h, put, api, toast, modal, confirmDialog, field, formData, fmtDateTime, fmtDate */

// Venue admin portal: /v/<venue>/admin — manager codes, staff access, venue settings, privacy, overrides log.

const root = document.getElementById('app');
const slug = location.pathname.split('/').filter(Boolean)[1];
let venueName = '';

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied', 'ok');
  } catch {
    toast('Select it and copy it manually', 'info');
  }
}

function shell(...children) {
  put(root,
    h('header', { class: 'topbar' },
      h('div', { class: 'topbar-left' },
        h('span', { class: 'logo' }, '★'),
        h('div', { class: 'topbar-title' }, h('strong', null, venueName), h('small', null, 'Venue admin'))
      ),
      h('div', { class: 'topbar-right' },
        h('a', { class: 'btn btn-small', href: '/app' }, 'Guest list'),
        h('button', {
          class: 'btn btn-small',
          onclick: async () => {
            await api('POST', '/api/vadmin/logout').catch(() => {});
            start();
          },
        }, 'Log out')
      )
    ),
    h('main', { class: 'page narrow-block stack admin' }, children)
  );
}

async function start() {
  let s;
  try {
    s = await api('GET', `/api/vadmin/session/${encodeURIComponent(slug)}`);
  } catch (err) {
    return put(root, h('main', { class: 'center' }, h('div', { class: 'card narrow stack' }, h('h1', null, 'Venue not found'), h('p', null, err.message))));
  }
  venueName = s.venue.name;
  document.title = `${venueName} · Venue admin`;
  if (s.authed) return dashboard();
  return s.needsSetup ? firstSetup(s.venue) : login(s.venue);
}

function login(venue) {
  const pw = h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' });
  const form = h('form', { class: 'card narrow stack' },
    h('div', { class: 'brand' }, h('span', { class: 'logo big' }, '★'), h('h1', null, venue.name)),
    h('p', { class: 'muted' }, 'Venue admin — for the GM or owner. Staff use the normal guest list login.'),
    field('Venue admin password', pw),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Log in'),
    h('p', { class: 'small muted center-text' }, 'Forgotten it? ',
      h('button', {
        type: 'button',
        class: 'linklike',
        onclick: async () => {
          try {
            const r = await api('POST', '/api/forgot', { username: slug, kind: 'admin' });
            toast(`${r.message} If nothing arrives, ask Riderly.`, 'ok', 7000);
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, 'Email me a reset link'))
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', `/api/vadmin/login/${encodeURIComponent(slug)}`, { password: pw.value });
      dashboard();
    } catch (err) {
      toast(err.message, 'error', 5000);
      pw.select();
    }
  });
  put(root, h('main', { class: 'center' }, form));
  pw.focus();
}

// Older venues: prove you're a manager with an existing code, then choose the admin password.
function firstSetup(venue) {
  const form = h('form', { class: 'card narrow stack' },
    h('div', { class: 'brand' }, h('span', { class: 'logo big' }, '★'), h('h1', null, venue.name)),
    h('p', null, 'Set up the venue admin password. Enter your current manager code to prove it’s you.'),
    field('Current manager code', h('input', { name: 'managerCode', type: 'password', required: true, autocomplete: 'off', inputmode: 'numeric' })),
    field('New venue admin password', h('input', { name: 'newPassword', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' }), 'At least 8 characters. Different from the staff password.'),
    field('Type it again', h('input', { name: 'confirm', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' })),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Set up venue admin')
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const d = formData(form);
    if (d.newPassword !== d.confirm) return toast('Passwords don’t match', 'error');
    try {
      await api('POST', `/api/vadmin/login/${encodeURIComponent(slug)}`, { managerCode: d.managerCode, newPassword: d.newPassword });
      toast('Venue admin set up', 'ok');
      dashboard();
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  });
  put(root, h('main', { class: 'center' }, form));
}

async function dashboard() {
  let data;
  try {
    data = await api('GET', '/api/vadmin/overview');
  } catch (err) {
    if (err.status === 401) return start();
    return toast(err.message, 'error');
  }
  venueName = data.venue.name;
  shell(
    codesCard(data),
    staffCard(data),
    venueCard(data),
    privacyCard(data),
    bannedCard(),
    riderlyCard(data),
    overridesCard(data),
    adminPasswordCard()
  );
}

// ---------- manager codes ----------

function codesCard(data) {
  const name = h('input', { name: 'name', required: true, maxlength: '40', placeholder: 'e.g. JT', autocomplete: 'off' });
  const code = h('input', { name: 'code', type: 'password', required: true, minlength: '4', maxlength: '100', autocomplete: 'off', inputmode: 'numeric' });
  const again = h('input', { name: 'again', type: 'password', required: true, minlength: '4', maxlength: '100', autocomplete: 'off', inputmode: 'numeric' });
  const add = h('form', { class: 'stack add-code' },
    h('div', { class: 'grid-3' }, field('Manager', name), field('Their code', code), field('Again', again)),
    h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'submit' }, '+ Add manager code'))
  );
  add.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!add.reportValidity()) return;
    if (code.value !== again.value) return toast('Codes don’t match', 'error');
    try {
      await api('POST', '/api/vadmin/codes', { name: name.value, code: code.value });
      toast(`Code added for ${name.value}`, 'ok');
      dashboard();
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  });

  const rows = data.codes.map((c) =>
    h('div', { class: `code-row${c.active ? '' : ' revoked'}` },
      h('div', null,
        h('strong', null, c.name, c.active ? null : h('span', { class: 'badge s-disabled' }, 'Revoked')),
        h('div', { class: 'small muted' }, c.lastUsedAt ? `Last used ${fmtDateTime(c.lastUsedAt)}` : 'Not used yet')
      ),
      h('div', { class: 'row wrap' },
        c.active ? h('button', { class: 'btn btn-small', onclick: () => resetCode(c) }, 'New code') : null,
        h('button', { class: 'btn btn-small', onclick: () => toggleCode(c) }, c.active ? 'Revoke' : 'Restore'),
        h('button', { class: 'btn btn-small btn-ghost-danger', onclick: () => deleteCode(c) }, 'Delete')
      )
    )
  );

  return h('div', { class: 'card stack' },
    h('h2', null, '🔒 Manager codes'),
    h('p', { class: 'muted' }, 'Each duty manager gets their own code. Staff need one to create shows, go over capacity or an allocation, or change limits — and the log shows whose code approved it. Your venue admin password also works as a code.'),
    rows.length ? h('div', { class: 'code-list' }, rows) : h('div', { class: 'empty' }, 'No manager codes yet — add one for each duty manager.'),
    add
  );
}

function resetCode(c) {
  const a = h('input', { type: 'password', required: true, minlength: '4', autocomplete: 'off', inputmode: 'numeric' });
  const b = h('input', { type: 'password', required: true, minlength: '4', autocomplete: 'off', inputmode: 'numeric' });
  const form = h('form', { class: 'stack' }, field(`New code for ${c.name}`, a), field('Again', b));
  const submit = async (e) => {
    if (e) e.preventDefault();
    if (!form.reportValidity()) return;
    if (a.value !== b.value) return toast('Codes don’t match', 'error');
    try {
      await api('PUT', `/api/vadmin/codes/${c.id}`, { code: a.value });
      m.close();
      toast(`New code set for ${c.name}`, 'ok');
      dashboard();
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  };
  form.addEventListener('submit', submit);
  const m = modal('New manager code', form, {
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', onclick: submit }, 'Save code')],
  });
}

async function toggleCode(c) {
  if (c.active) {
    const ok = await confirmDialog(`Revoke ${c.name}’s code?`, 'It stops working straight away. You can restore it later.', { confirmText: 'Revoke', danger: true });
    if (!ok) return;
  }
  try {
    await api('PUT', `/api/vadmin/codes/${c.id}`, { active: !c.active });
    dashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteCode(c) {
  const ok = await confirmDialog(`Delete ${c.name}’s code?`, 'Past overrides stay in the log with their name.', { confirmText: 'Delete', danger: true });
  if (!ok) return;
  await api('DELETE', `/api/vadmin/codes/${c.id}`).catch((err) => toast(err.message, 'error'));
  dashboard();
}

// ---------- staff access ----------

function staffCard(data) {
  const link = `${location.origin}/v/${data.venue.slug}`;
  const a = h('input', { type: 'password', required: true, minlength: '8', autocomplete: 'new-password' });
  const b = h('input', { type: 'password', required: true, minlength: '8', autocomplete: 'new-password' });
  const pwForm = h('form', { class: 'stack' },
    h('div', { class: 'grid-2' }, field('New staff password', a), field('Again', b)),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Change staff password'))
  );
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pwForm.reportValidity()) return;
    if (a.value !== b.value) return toast('Passwords don’t match', 'error');
    const ok = await confirmDialog('Change the staff password?', 'Every staff phone is logged out and will need the new password.', { confirmText: 'Change it' });
    if (!ok) return;
    try {
      await api('PUT', '/api/vadmin/staff-password', { password: a.value });
      pwForm.reset();
      toast('Staff password changed — all staff phones logged out', 'ok', 4000);
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  });

  return h('div', { class: 'card stack' },
    h('h2', null, '🔑 Staff access'),
    h('p', { class: 'muted' }, 'Staff log in with username ', h('strong', null, data.venue.slug), ' and the staff password. This link fills in the username for them:'),
    h('div', { class: 'linkbox' },
      h('input', { readonly: true, value: link, onclick: (e) => e.target.select() }),
      h('button', { class: 'btn btn-small btn-primary', onclick: () => copy(link) }, 'Copy')
    ),
    h('p', { class: 'small muted' }, data.venue.staffLastLogin ? `Last staff login ${fmtDateTime(data.venue.staffLastLogin)}.` : 'No staff logins yet.'),
    pwForm,
    h('div', { class: 'row wrap' },
      h('button', {
        class: 'btn btn-ghost-danger',
        onclick: async () => {
          const ok = await confirmDialog('Log out every staff phone?', 'Use this if a phone is lost or someone leaves. The password stays the same — change it too if they know it.', { confirmText: 'Log them all out', danger: true });
          if (!ok) return;
          try {
            await api('POST', '/api/vadmin/logout-devices');
            toast('All staff phones logged out', 'ok');
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, 'Log out all staff phones')
    )
  );
}

// ---------- venue settings & defaults ----------

function venueCard(data) {
  const v = data.venue;
  const form = h('form', { class: 'stack' },
    h('div', { class: 'grid-2' },
      field('Venue name', h('input', { name: 'name', required: true, maxlength: '80', value: v.name })),
      field('Contact email', h('input', { name: 'email', type: 'email', maxlength: '120', value: v.email || '', placeholder: 'gm@yourvenue.com' }), 'For password resets and reports.')
    ),
    h('div', { class: 'grid-2' },
      field('Usual venue capacity', h('input', { name: 'defaultCapacity', type: 'number', min: '1', value: v.defaultCapacity ?? '', placeholder: 'e.g. 500', inputmode: 'numeric' }), 'Filled in on new shows.'),
      h('label', { class: 'check check-top' }, h('input', { type: 'checkbox', name: 'defaultCountGuestlist', checked: v.defaultCountGuestlist }),
        h('span', null, 'Guest list check-ins count at the door by default'))
    ),
    h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'))
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const d = formData(form);
    try {
      await api('PUT', '/api/vadmin/venue', {
        name: d.name,
        email: d.email,
        defaultCapacity: d.defaultCapacity || null,
        defaultCountGuestlist: d.defaultCountGuestlist,
      });
      toast('Saved', 'ok');
      dashboard();
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  });
  return h('div', { class: 'card stack' }, h('h2', null, '🏠 Venue'), form);
}

// ---------- privacy ----------

function privacyCard(data) {
  const sel = h('select', { name: 'retentionDays' },
    [['', 'Keep until I delete them'], ['30', '30 days after the show'], ['90', '90 days after the show'], ['180', '6 months after the show'], ['365', '1 year after the show']]
      .map(([v, label]) => h('option', { value: v }, label))
  );
  sel.value = data.venue.retentionDays ? String(data.venue.retentionDays) : '';
  if (sel.value !== String(data.venue.retentionDays || '')) {
    sel.append(h('option', { value: String(data.venue.retentionDays) }, `${data.venue.retentionDays} days after the show`));
    sel.value = String(data.venue.retentionDays);
  }
  sel.addEventListener('change', async () => {
    try {
      await api('PUT', '/api/vadmin/venue', { retentionDays: sel.value || null });
      toast(sel.value ? 'Guest details will be removed automatically' : 'Guest details kept until deleted', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  return h('div', { class: 'card stack' },
    h('h2', null, '🛡 Privacy'),
    h('p', { class: 'muted' }, 'Guest names and notes are personal information. Choose when they’re removed automatically — head counts, check-in numbers and reports are kept.'),
    field('Remove guest names and notes', sel)
  );
}

// ---------- banned (refused entry) list ----------
// Closed until someone taps Open, because every look is logged. Staff never see this list:
// they get a warning on a guest whose name matches it.

function bannedCard() {
  const body = h('div', { class: 'stack' });
  const intro = h('p', { class: 'muted' }, 'People your venue has refused entry. When someone on a guest list, or a walk-up, matches a name here, door staff see a warning and your reason. They never see the list. Every look and change is logged below. Each name needs a review every 12 months and drops off a month after that unless you renew it.');
  const open = h('button', { class: 'btn', onclick: () => load() }, 'Open banned list');
  put(body, intro, open);

  async function load() {
    let r;
    try {
      r = await api('GET', '/api/vadmin/banned');
    } catch (err) {
      return toast(err.message, 'error');
    }
    const form = h('form', { class: 'stack' },
      h('div', { class: 'grid-2' },
        field('Full name', h('input', { name: 'name', required: true, maxlength: '120', placeholder: 'First name and surname' })),
        field('Reason (staff see this)', h('input', { name: 'reason', maxlength: '200', placeholder: 'e.g. Violence, Feb 2026' }))
      ),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add to banned list')
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      try {
        await api('POST', '/api/vadmin/banned', formData(form));
        toast('Added', 'ok');
        load();
      } catch (err) {
        toast(err.message, 'error', 6000);
      }
    });
    const act = async (method, b, body, msg) => {
      try {
        await api(method, `/api/vadmin/banned/${b.id}`, body);
        toast(msg, 'ok');
        load();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    const rows = r.entries.map((b) => h('li', { class: 'ban-row' },
      h('div', null,
        h('strong', null, b.name), b.reason ? h('span', { class: 'muted' }, ` · ${b.reason}`) : null,
        h('div', { class: 'small muted' }, `Added by ${b.createdBy} · review by ${fmtDate(b.reviewAt)}`, b.reviewDue ? h('span', { class: 'badge badge-warn' }, ' Review due') : null)
      ),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-small', onclick: () => act('PUT', b, { renew: true }, 'Renewed for 12 months') }, 'Renew'),
        h('button', { class: 'btn btn-small btn-ghost-danger', onclick: async () => {
          if (await confirmDialog('Remove from banned list?', `${b.name} will no longer trigger a warning at the door.`, { confirmText: 'Remove', danger: true })) act('DELETE', b, undefined, 'Removed');
        } }, 'Remove')
      )
    ));
    put(body,
      intro,
      form,
      rows.length ? h('ul', { class: 'ban-list' }, rows) : h('div', { class: 'empty' }, 'No one on the list.'),
      h('details', null, h('summary', null, 'Access log'),
        h('ul', { class: 'activity' }, r.log.map((l) => h('li', null,
          h('span', { class: 'time' }, fmtDateTime(l.at)), h('span', { class: 'who' }, l.actor), h('span', { class: 'what' }, `${l.action}${l.detail ? `: ${l.detail}` : ''}`))))),
      h('button', { class: 'btn', onclick: () => put(body, intro, open) }, 'Close list')
    );
  }

  return h('div', { class: 'card stack' }, h('h2', null, '🚫 Banned list'), body);
}

// ---------- Riderly connection ----------

function riderlyCard(data) {
  const body = h('div', { class: 'stack' });
  const render = (k, newKey) => {
    put(body,
      h('p', { class: 'muted' }, 'Connect the Riderly venue manager so your shows appear here automatically, and door counts, guest list and ticket numbers go back to Riderly after the night.'),
      newKey ? h('div', { class: 'callout stack' },
        h('strong', null, 'Your key — copy it now'),
        h('p', { class: 'small' }, 'Paste it into Riderly. It won’t be shown again. Treat it like a password.'),
        h('code', { class: 'key-box' }, newKey),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => copy(newKey) }, 'Copy key'))
      ) : null,
      k.connected
        ? h('p', null, h('span', { class: 'badge s-active' }, 'Connected'), ` Key ending …${k.hint}, made ${fmtDateTime(k.createdAt)}. ${k.lastUsedAt ? `Last used ${fmtDateTime(k.lastUsedAt)}.` : 'Not used yet.'}`)
        : h('p', null, h('span', { class: 'badge s-pending' }, 'Not connected')),
      h('div', { class: 'row wrap' },
        h('button', {
          class: k.connected ? 'btn' : 'btn btn-primary',
          onclick: async () => {
            if (k.connected && !(await confirmDialog('Make a new key?', 'The current key stops working straight away. You’ll need to paste the new one into Riderly.', { confirmText: 'New key' }))) return;
            try {
              const r = await api('POST', '/api/vadmin/api-key');
              render(r, r.key);
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        }, k.connected ? 'Make a new key' : 'Connect to Riderly'),
        k.connected ? h('button', {
          class: 'btn btn-danger',
          onclick: async () => {
            if (!(await confirmDialog('Disconnect Riderly?', 'Riderly will stop syncing shows and counts. Everything already here stays.', { confirmText: 'Disconnect', danger: true }))) return;
            try {
              render(await api('DELETE', '/api/vadmin/api-key'));
              toast('Disconnected', 'ok');
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        }, 'Disconnect') : null
      )
    );
  };
  render(data.apiKey);
  return h('div', { class: 'card stack' }, h('h2', null, '🔗 Riderly venue manager'), body);
}

// ---------- overrides log ----------

function overridesCard(data) {
  const rows = data.overrides.map((o) =>
    h('li', null,
      h('span', { class: 'time' }, fmtDateTime(o.at)),
      h('span', { class: 'who' }, o.actor, h('small', null, ` · ${o.eventName}`)),
      h('span', { class: 'what' }, o.detail)
    )
  );
  return h('div', { class: 'card stack' },
    h('h2', null, '📋 Overrides'),
    h('p', { class: 'muted' }, `Every time a rule was broken or changed, across all shows — who asked, and whose code approved it. ${data.counts.events} shows · ${data.counts.guests} guest entries.`),
    rows.length ? h('ul', { class: 'activity' }, rows) : h('div', { class: 'empty' }, 'No overrides yet.')
  );
}

// ---------- admin password ----------

function adminPasswordCard() {
  const form = h('form', { class: 'stack' },
    field('Current venue admin password', h('input', { name: 'currentPassword', type: 'password', required: true, autocomplete: 'current-password' })),
    h('div', { class: 'grid-2' },
      field('New venue admin password', h('input', { name: 'newPassword', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' })),
      field('Again', h('input', { name: 'confirm', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' }))
    ),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Change venue admin password'))
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const d = formData(form);
    if (d.newPassword !== d.confirm) return toast('Passwords don’t match', 'error');
    try {
      await api('PUT', '/api/vadmin/admin-password', { currentPassword: d.currentPassword, newPassword: d.newPassword });
      form.reset();
      toast('Venue admin password changed', 'ok');
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  });
  return h('div', { class: 'card stack' }, h('h2', null, '👤 Venue admin password'), form);
}

start();
