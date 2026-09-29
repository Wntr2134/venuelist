'use strict';

/* global h, put, api, toast, modal, confirmDialog, field, formData, fmtDateTime, slugPreview */

const root = document.getElementById('app');

async function start() {
  let s;
  try {
    s = await api('GET', '/api/owner/session');
  } catch (err) {
    return put(root, h('main', { class: 'center' }, h('div', { class: 'card narrow' }, h('p', null, err.message))));
  }
  if (s.needsSetup) return renderSetup(s.setupCodeRequired);
  if (!s.authed) return renderLogin();
  renderDashboard();
}

function shell(...children) {
  put(root,
    h('header', { class: 'topbar' },
      h('div', { class: 'topbar-left' },
        h('span', { class: 'logo' }, '★'),
        h('div', { class: 'topbar-title' }, h('strong', null, 'Riderly Guest List'), h('small', null, 'Owner admin'))
      ),
      h('div', { class: 'topbar-right' },
        h('button', {
          class: 'btn btn-small',
          onclick: async () => {
            await api('POST', '/api/owner/logout').catch(() => {});
            renderLogin();
          },
        }, 'Log out')
      )
    ),
    h('main', { class: 'page narrow-block stack admin' }, children)
  );
}

// ---------- first run & login ----------

function renderSetup(needsCode) {
  const form = h('form', { class: 'card narrow stack' },
    h('div', { class: 'brand' }, h('span', { class: 'logo big' }, '★'), h('h1', null, 'Owner setup')),
    h('p', { class: 'muted' }, 'Create the owner password. This account adds venues — it never sees their guest lists.'),
    needsCode ? field('Setup code', h('input', { name: 'setupCode', required: true, maxlength: '20', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' }),
      'On the droplet: sudo journalctl -u guestlist | grep "Owner setup code" | tail -1') : null,
    field('Owner password', h('input', { name: 'password', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' }), 'At least 8 characters. Keep it separate from any venue password.'),
    field('Type it again', h('input', { name: 'confirm', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' })),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Create owner account')
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    if (d.password !== d.confirm) return toast('Passwords don’t match', 'error');
    try {
      await api('POST', '/api/owner/setup', { setupCode: d.setupCode, password: d.password });
      renderDashboard();
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  });
  put(root, h('main', { class: 'center' }, form));
}

function renderLogin() {
  const form = h('form', { class: 'card narrow stack' },
    h('div', { class: 'brand' }, h('span', { class: 'logo big' }, '★'), h('h1', null, 'Owner admin')),
    field('Owner password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Log in'),
    h('a', { class: 'small center-text', href: '/login' }, 'Looking for your venue login?')
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/owner/login', formData(form));
      renderDashboard();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  put(root, h('main', { class: 'center' }, form));
  form.querySelector('input').focus();
}

// ---------- dashboard ----------

async function renderDashboard() {
  let data;
  try {
    data = await api('GET', '/api/owner/venues');
  } catch (err) {
    if (err.status === 401) return renderLogin();
    return toast(err.message, 'error');
  }

  const nameInput = h('input', { name: 'name', required: true, maxlength: '80', placeholder: 'e.g. The Corner Hotel', autocomplete: 'off' });
  const userInput = h('input', { name: 'username', maxlength: '40', placeholder: 'auto from name', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const emailInput = h('input', { name: 'email', type: 'email', maxlength: '120', placeholder: 'gm@venue.com', autocomplete: 'off' });
  let userTouched = false;
  nameInput.addEventListener('input', () => {
    if (!userTouched) userInput.value = slugPreview(nameInput.value);
  });
  userInput.addEventListener('input', () => {
    userTouched = true;
  });
  const addForm = h('form', { class: 'card stack' },
    h('h2', null, 'Add a venue yourself'),
    h('p', { class: 'muted' }, 'You’ll get a setup link to text or email them. They open it, choose a staff password and a venue admin password, done.'),
    h('div', { class: 'grid-2' }, field('Venue name', nameInput), field('Username', userInput, 'What their staff log in with.')),
    field('GM / owner email (optional)', emailInput, 'Used for reset links and, later, reports.'),
    h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add venue'))
  );
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!nameInput.value.trim()) return nameInput.focus();
    try {
      const r = await api('POST', '/api/owner/venues', { name: nameInput.value, username: slugPreview(userInput.value), email: emailInput.value });
      showSetupLink(r, false);
      renderDashboard();
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  });

  const list = data.venues.length
    ? h('div', { class: 'stack' }, data.venues.map(venueCard))
    : h('div', { class: 'empty' }, 'No venues yet. Add your first one above.');

  shell(
    requestsCard(data.requests || []),
    addForm,
    h('div', { class: 'page-head' }, h('h2', null, `Venues (${data.venues.length})`)),
    list,
    signupCard(data),
    settingsCard()
  );
  if (!document.querySelector('.modal-backdrop')) nameInput.focus();
}

function venueCard(v) {
  const statusLabel = { active: 'Active', pending: 'Waiting for setup', disabled: 'Disabled' }[v.status];
  const loginLink = `${location.origin}/v/${v.slug}`;
  return h('div', { class: `card venue-card status-${v.status}` },
    h('div', { class: 'contributor-head' },
      h('div', null,
        h('h3', null, v.name),
        h('div', { class: 'small muted' }, 'Username: ', h('strong', null, v.slug), v.email ? ` · ${v.email}` : '')
      ),
      h('span', { class: `badge badge-status s-${v.status}` }, statusLabel)
    ),
    v.status === 'pending'
      ? h('p', { class: 'small muted' }, v.setupLinkActive ? `Setup link expires ${fmtDateTime(v.setupExpiresAt)}.` : 'Setup link expired — send a new one.')
      : h('div', { class: 'venue-stats small muted' },
        h('span', null, `${v.upcoming} upcoming`),
        h('span', null, `${v.eventCount} events`),
        h('span', null, `${v.guestCount} guests`),
        h('span', null, v.lastActivity ? `Active ${fmtDateTime(v.lastActivity)}` : 'No activity yet')
      ),
    v.status === 'active'
      ? h('div', { class: 'linkbox' },
        h('input', { readonly: true, value: loginLink, onclick: (e) => e.target.select() }),
        h('button', { class: 'btn btn-small', onclick: () => copy(loginLink) }, 'Copy staff link'))
      : null,
    v.status === 'pending'
      ? h('div', { class: 'row wrap' }, h('button', { class: 'btn btn-small btn-primary', onclick: () => newLink(v) }, 'Get setup link'))
      : h('div', { class: 'reset-grid' },
        h('div', { class: 'reset-box' },
          h('div', { class: 'reset-title' }, '🔑 Staff password'),
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn btn-small', onclick: () => newLink(v) }, 'Send reset link'),
            h('button', { class: 'btn btn-small', onclick: () => setSecret(v, 'password') }, 'Set new password')
          )
        ),
        h('div', { class: 'reset-box' },
          h('div', { class: 'reset-title' }, '👤 Venue admin password ',
            h('span', { class: `badge ${v.hasAdmin ? 's-active' : 's-pending'}` }, v.hasAdmin ? 'Set' : 'Not set')),
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn btn-small', onclick: () => adminLink(v) }, 'Send reset link'),
            h('button', { class: 'btn btn-small', onclick: () => setSecret(v, 'admin') }, 'Set new password'),
            h('a', { class: 'btn btn-small', href: `/v/${v.slug}/admin`, target: '_blank', rel: 'noopener' }, 'Open ↗')
          )
        )
      ),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn btn-small', onclick: () => rename(v) }, 'Rename'),
      h('button', { class: 'btn btn-small', onclick: () => toggle(v) }, v.status === 'disabled' ? 'Enable' : 'Disable'),
      h('button', { class: 'btn btn-small btn-ghost-danger', onclick: () => remove(v) }, 'Delete')
    )
  );
}

// ---------- access requests from the landing page ----------

function requestsCard(requests) {
  const open = requests.filter((r) => r.status === 'new');
  if (!requests.length) return null;
  return h('div', { class: 'card stack requests' },
    h('h2', null, 'Sign-ups ', open.length ? h('span', { class: 'badge badge-vip' }, `${open.length} new`) : null),
    requests.map((r) =>
      h('div', { class: `request${r.status === 'done' ? ' done' : ''}` },
        h('div', { class: 'request-head' },
          h('strong', null, r.venueName),
          h('span', { class: 'small muted' }, fmtDateTime(r.createdAt))
        ),
        h('div', { class: 'small' }, r.name, ' · ', h('a', { href: `mailto:${r.email}` }, r.email), r.phone ? ` · ${r.phone}` : ''),
        r.username ? h('div', { class: 'small muted' }, 'Username: ', h('strong', null, r.username), r.hasPassword ? ' · password chosen' : '') : null,
        r.message ? h('p', { class: 'small muted request-msg' }, r.message) : null,
        h('div', { class: 'row wrap' },
          r.status === 'new' ? h('button', { class: 'btn btn-small btn-primary', onclick: () => approve(r) }, 'Approve') : null,
          h('button', { class: 'btn btn-small', onclick: () => markRequest(r, r.status === 'new' ? 'done' : 'new') }, r.status === 'new' ? 'Mark done' : 'Reopen'),
          h('button', { class: 'btn btn-small btn-ghost-danger', onclick: () => deleteRequest(r) }, 'Delete')
        )
      )
    )
  );
}

async function approve(req) {
  try {
    const r = await api('POST', `/api/owner/requests/${req.id}/approve`);
    if (r.live) showLive(r, req);
    else showSetupLink(r, false, req);
    renderDashboard();
  } catch (err) {
    toast(err.message, 'error', 5000);
  }
}

async function markRequest(r, status) {
  try {
    await api('PUT', `/api/owner/requests/${r.id}`, { status });
    renderDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteRequest(r) {
  const ok = await confirmDialog('Delete request?', `Delete the request from ${r.venueName}?`, { confirmText: 'Delete', danger: true });
  if (!ok) return;
  await api('DELETE', `/api/owner/requests/${r.id}`).catch((err) => toast(err.message, 'error'));
  renderDashboard();
}

// Approved sign-up: they already chose a password, so just tell them they're live.
function showLive(r, req) {
  const login = `${location.origin}/v/${r.venue.slug}`;
  const msg = `Hi ${req.name.split(' ')[0]}! ${r.venue.name} is now live on Riderly Guest List.\n\nLog in: ${login}\nUsername: ${r.venue.slug}\nPassword: the one you chose when you signed up.\n\nSend that link to your staff too — it fills in the username. The guide is here: ${location.origin}/guide`;
  const mailto = `mailto:${req.email}?subject=${encodeURIComponent(`${r.venue.name} is live on Riderly Guest List`)}&body=${encodeURIComponent(msg)}`;
  modal(`${r.venue.name} is live ✓`, h('div', { class: 'stack' },
    h('p', null, 'They can log in now with the username and password they chose. Let them know:'),
    h('textarea', { rows: '7', readonly: true, class: 'message' }, msg),
    h('div', { class: 'row wrap' },
      h('a', { class: 'btn btn-primary', href: mailto }, `Email ${req.email}`),
      h('button', { class: 'btn', onclick: () => copy(msg) }, 'Copy message')
    )
  ));
}

function setupMessage(r) {
  const url = `${location.origin}${r.setupPath}`;
  return r.reset
    ? `Here’s a link to reset the guest list password for ${r.venue.name}: ${url}\n\nIt works once and expires in 7 days.`
    : `Hi! Here’s your link to set up ${r.venue.name} on Riderly Guest List: ${url}\n\nOpen it, choose a password, and you’re in (about 30 seconds). It works once and expires in 7 days.`;
}

function showSetupLink(r, reset, request) {
  const url = `${location.origin}${r.setupPath}`;
  let msg = setupMessage({ ...r, reset });
  if (request) msg = msg.replace(/^Hi!/, `Hi ${request.name.split(' ')[0]}!`);
  const mailto = request
    ? `mailto:${request.email}?subject=${encodeURIComponent(`Your guest list for ${r.venue.name}`)}&body=${encodeURIComponent(msg)}`
    : null;
  const canShare = typeof navigator.share === 'function';
  modal(reset ? 'Staff password reset link' : `${r.venue.name} added`, h('div', { class: 'stack' },
    h('p', null, 'Send this to the venue manager. It works once and expires in 7 days.'),
    h('div', { class: 'linkbox' },
      h('input', { readonly: true, value: url, onclick: (e) => e.target.select() }),
      h('button', { class: 'btn btn-small', onclick: () => copy(url) }, 'Copy link')
    ),
    h('textarea', { rows: '5', readonly: true, class: 'message' }, msg),
    h('div', { class: 'row wrap' },
      mailto ? h('a', { class: 'btn btn-primary', href: mailto }, `Email ${request.email}`) : null,
      h('button', { class: `btn${mailto ? '' : ' btn-primary'}`, onclick: () => copy(msg) }, 'Copy message'),
      canShare ? h('button', { class: 'btn', onclick: () => navigator.share({ text: msg }).catch(() => {}) }, 'Share…') : null
    ),
    reset ? h('p', { class: 'small muted' }, 'Their current password keeps working until the link is used.') : null
  ));
}

// Owner sets a new staff password or venue admin password directly (e.g. while on the phone to them).
function setSecret(v, kind) {
  const isAdmin = kind === 'admin';
  const a = h('input', { type: 'password', required: true, minlength: '8', autocomplete: 'new-password' });
  const b = h('input', { type: 'password', required: true, minlength: '8', autocomplete: 'new-password' });
  const form = h('form', { class: 'stack' },
    h('p', { class: 'muted' }, isAdmin
      ? `Sets a new venue admin password for ${v.name}. Their venue admin page logs out; staff and manager codes aren’t affected. Tell the GM/owner directly — not staff.`
      : `Sets a new staff password for ${v.name}. Every staff phone is logged out. The venue admin password and manager codes don’t change.`),
    field('New password (at least 8 characters)', a),
    field('Type it again', b)
  );
  const submit = async (e) => {
    if (e) e.preventDefault();
    if (!form.reportValidity()) return;
    if (a.value !== b.value) return toast('They don’t match', 'error');
    try {
      await api('PUT', `/api/owner/venues/${v.id}/${isAdmin ? 'admin-password' : 'password'}`, { password: a.value });
      m.close();
      toast(isAdmin ? `New venue admin password set for ${v.name}` : `New staff password set — ${v.name} phones logged out`, 'ok', 4000);
      renderDashboard();
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  };
  form.addEventListener('submit', submit);
  const m = modal(isAdmin ? 'Set new venue admin password' : 'Set new staff password', form, {
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', onclick: submit }, 'Set password')],
  });
}

// One-time link (24 h) the GM/owner uses to choose a new venue admin password themselves.
async function adminLink(v) {
  try {
    const r = await api('POST', `/api/owner/venues/${v.id}/admin-link`);
    const url = `${location.origin}${r.adminPath}`;
    const msg = `Here’s a link to set a new venue admin password for ${v.name} on Riderly Guest List: ${url}\n\nIt works once and expires in 24 hours. Your current password keeps working until you use it. Please don’t share it with staff.`;
    const mailto = v.email ? `mailto:${v.email}?subject=${encodeURIComponent(`Venue admin password reset — ${v.name}`)}&body=${encodeURIComponent(msg)}` : null;
    modal('Venue admin reset link', h('div', { class: 'stack' },
      h('p', null, 'Send this to the GM/owner only — whoever opens it can set the password. Works once, expires in 24 hours.'),
      h('div', { class: 'linkbox' },
        h('input', { readonly: true, value: url, onclick: (e) => e.target.select() }),
        h('button', { class: 'btn btn-small', onclick: () => copy(url) }, 'Copy link')
      ),
      h('textarea', { rows: '5', readonly: true, class: 'message' }, msg),
      h('div', { class: 'row wrap' },
        mailto ? h('a', { class: 'btn btn-primary', href: mailto }, `Email ${v.email}`) : null,
        h('button', { class: `btn${mailto ? '' : ' btn-primary'}`, onclick: () => copy(msg) }, 'Copy message'),
        typeof navigator.share === 'function' ? h('button', { class: 'btn', onclick: () => navigator.share({ text: msg }).catch(() => {}) }, 'Share…') : null
      )
    ));
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function newLink(v) {
  if (v.status === 'active') {
    const ok = await confirmDialog('Staff password reset link?', `This makes a one-time link (7 days) that lets ${v.name} choose a new staff password. When it’s used, every device logged into ${v.name} is logged out. The manager PIN doesn’t change.`, { confirmText: 'Make link' });
    if (!ok) return;
  }
  try {
    const r = await api('POST', `/api/owner/venues/${v.id}/setup-link`);
    showSetupLink(r, r.reset);
    renderDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function rename(v) {
  const input = h('input', { name: 'name', required: true, maxlength: '80', value: v.name });
  const form = h('form', { class: 'stack' }, field('Venue name', input, `The username (${v.slug}) stays the same.`));
  const submit = async (e) => {
    if (e) e.preventDefault();
    try {
      await api('PUT', `/api/owner/venues/${v.id}`, { name: input.value });
      m.close();
      renderDashboard();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  form.addEventListener('submit', submit);
  const m = modal('Rename venue', form, {
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', onclick: submit }, 'Save')],
  });
}

async function toggle(v) {
  const disabling = v.status !== 'disabled';
  if (disabling) {
    const ok = await confirmDialog(`Disable ${v.name}?`, 'Their staff are logged out, they can’t log in, and contributor links stop working. Nothing is deleted — you can enable them again any time.', { confirmText: 'Disable', danger: true });
    if (!ok) return;
  }
  try {
    await api('PUT', `/api/owner/venues/${v.id}`, { active: !disabling });
    toast(disabling ? 'Disabled' : 'Enabled', 'ok');
    renderDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function remove(v) {
  const input = h('input', { autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: v.slug });
  const submit = async () => {
    try {
      await api('DELETE', `/api/owner/venues/${v.id}`, { confirm: input.value.trim() });
      m.close();
      toast(`${v.name} deleted`, 'ok');
      renderDashboard();
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  };
  const m = modal(`Delete ${v.name}?`, h('div', { class: 'stack' },
    h('p', null, `This permanently deletes ${v.name} and all ${v.eventCount} events, ${v.guestCount} guests and history. It can’t be undone (except from a nightly backup).`),
    field(`Type ${v.slug} to confirm`, input)
  ), {
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-danger', onclick: submit }, 'Delete forever')],
  });
}

function signupCard(data) {
  const box = h('input', { type: 'checkbox', checked: data.autoApprove });
  box.addEventListener('change', async () => {
    try {
      await api('PUT', '/api/owner/settings', { autoApprove: box.checked });
      toast(box.checked ? 'New sign-ups go live straight away' : 'New sign-ups wait for your approval', 'ok');
    } catch (err) {
      box.checked = !box.checked;
      toast(err.message, 'error');
    }
  });
  return h('div', { class: 'card stack' },
    h('h2', null, 'Sign-ups'),
    h('label', { class: 'check' }, box, h('span', null, 'Approve new sign-ups automatically')),
    h('p', { class: 'small muted' }, 'Off (recommended): sign-ups from the home page wait here until you tap Approve. On: they can log in the moment they sign up.')
  );
}

function settingsCard() {
  const pwForm = h('form', { class: 'stack' },
    field('Current owner password', h('input', { name: 'currentPassword', type: 'password', required: true, autocomplete: 'current-password' })),
    field('New owner password', h('input', { name: 'newPassword', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' })),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Change password'))
  );
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/owner/settings', formData(pwForm));
      pwForm.reset();
      toast('Password changed', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  return h('div', { class: 'card stack' }, h('h2', null, 'Owner password'), pwForm);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied', 'ok');
  } catch {
    toast('Select it and copy it manually', 'info');
  }
}

start();
