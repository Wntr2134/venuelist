'use strict';

/* global localDate, h, put, api, toast, modal, confirmDialog, field, formData, fmtDateTime, slugPreview */

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
  let feats;
  try {
    [data, feats] = await Promise.all([api('GET', '/api/owner/venues'), api('GET', '/api/owner/features')]);
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
    featuresCard(feats),
    signupCard(data),
    mailCard(data),
    backupCard(data.backup),
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
    billingBox(v),
    featuresBox(v),
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
    h('h2', null, 'Applications ', open.length ? h('span', { class: 'badge badge-vip' }, `${open.length} new`) : null),
    requests.map((r) =>
      h('div', { class: `request${r.status === 'done' ? ' done' : ''}` },
        h('div', { class: 'request-head' },
          h('strong', null, r.venueName),
          h('span', { class: 'small muted' }, fmtDateTime(r.createdAt))
        ),
        h('div', { class: 'small' }, r.name, ' · ', h('a', { href: `mailto:${r.email}` }, r.email), r.phone ? ` · ${r.phone}` : ''),
        [r.suburb, r.showsPerMonth ? `${r.showsPerMonth} shows a month` : null, r.capacity ? `${r.capacity} capacity` : null, r.ticketing]
          .some(Boolean) ? h('div', { class: 'small muted' }, [r.suburb, r.showsPerMonth ? `${r.showsPerMonth} shows a month` : null, r.capacity ? `${r.capacity} capacity` : null, r.ticketing].filter(Boolean).join(' · ')) : null,
        r.username ? h('div', { class: 'small muted' }, 'Username: ', h('strong', null, r.username), r.hasPassword ? ' · password chosen' : '') : null,
        r.message ? h('p', { class: 'small muted request-msg' }, r.message) : null,
        h('div', { class: 'row wrap' },
          r.status === 'new' ? h('button', { class: 'btn btn-small btn-primary', onclick: () => approve(r) }, 'Approve & send setup link') : null,
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
    else showSetupLink(r, false, req, r.emailed);
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
    r.emailed ? h('div', { class: 'pin-box' }, `✉️ We’ve emailed ${req.email} to say they’re live. Nothing else to do — the message below is just in case.`) : null,
    h('p', null, r.emailed ? 'They can log in now with the username and password they chose.' : 'They can log in now with the username and password they chose. Let them know:'),
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

function showSetupLink(r, reset, request, emailed) {
  const url = `${location.origin}${r.setupPath}`;
  let msg = setupMessage({ ...r, reset });
  if (request) msg = msg.replace(/^Hi!/, `Hi ${request.name.split(' ')[0]}!`);
  const mailto = request
    ? `mailto:${request.email}?subject=${encodeURIComponent(`Your guest list for ${r.venue.name}`)}&body=${encodeURIComponent(msg)}`
    : null;
  const canShare = typeof navigator.share === 'function';
  modal(reset ? 'Staff password reset link' : `${r.venue.name} added`, h('div', { class: 'stack' },
    emailed ? h('div', { class: 'pin-box' }, `✉️ Setup link emailed to ${request.email}. Nothing else to do. The link is below in case they need it again.`) : null,
    h('p', null, emailed ? 'It works once and expires in 7 days.' : 'Send this to the venue manager. It works once and expires in 7 days.'),
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

// ----- new features: off by default; per venue, early access, or everyone -----

function featuresCard(f) {
  const intro = h('p', { class: 'muted' }, 'New features start off for every venue. Venues with Early access get every new one automatically. Switch one on for everyone when it’s ready.');
  if (!f.features.length) {
    return h('div', { class: 'card stack' }, h('h2', null, '🧪 New features'), intro,
      h('div', { class: 'empty' }, 'Nothing new yet. When a feature is added to the app it appears here, off for every venue until you switch it on.'),
      f.earlyAccess.length ? h('p', { class: 'small muted' }, `Early access: ${f.earlyAccess.join(', ')}`) : null);
  }
  return h('div', { class: 'card stack' },
    h('h2', null, '🧪 New features ', h('span', { class: 'badge' }, String(f.features.length))),
    intro,
    f.earlyAccess.length ? h('p', { class: 'small' }, h('strong', null, 'Early access: '), f.earlyAccess.join(', ')) : h('p', { class: 'small muted' }, 'No venues have early access yet. Tick it on a venue below.'),
    h('div', { class: 'stack' }, f.features.map((x) => h('div', { class: 'reset-box' },
      h('div', { class: 'reset-title' }, x.name, x.everyone ? h('span', { class: 'badge s-active' }, 'Everyone') : null),
      h('div', { class: 'small' }, x.what),
      h('div', { class: 'small muted' }, `Added ${fmtDate(x.added)}${x.by ? ` by ${x.by}` : ''} · `,
        x.venuesOn.length ? `on for ${x.venuesOn.join(', ')}` : 'on for no venues yet'),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: x.everyone, onchange: (e) => setEveryone(x, e.target.checked) }),
        h('span', null, 'On for everyone'))
    )))
  );
}

async function setEveryone(x, on) {
  if (on && !(await confirmDialog(`Turn on “${x.name}” for every venue?`, 'Every venue gets it straight away, except any you’ve switched off by hand.', { confirmText: 'Turn on for everyone' }))) return renderDashboard();
  try {
    await api('PUT', `/api/owner/features/${encodeURIComponent(x.key)}`, { everyone: on });
    toast(on ? `${x.name} is on for everyone` : `${x.name} is back to opt-in`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
  renderDashboard();
}

function featuresBox(v) {
  return h('div', { class: 'reset-box' },
    h('div', { class: 'reset-title' }, '🧪 New features ', v.earlyAccess ? h('span', { class: 'badge s-active' }, 'Early access') : null),
    h('div', { class: 'small muted' }, v.earlyAccess ? 'Gets every new feature automatically.' : `${(v.features || []).length} on`),
    h('div', { class: 'row wrap' }, h('button', { class: 'btn btn-small', onclick: () => editFeatures(v) }, 'Choose'))
  );
}

async function editFeatures(v) {
  let f;
  try {
    f = await api('GET', `/api/owner/venues/${v.id}/features`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  const early = h('input', { type: 'checkbox', checked: f.earlyAccess });
  const boxes = f.features.map((x) => ({ x, input: h('input', { type: 'checkbox', checked: x.on }) }));
  const content = h('div', { class: 'stack' },
    h('label', { class: 'check check-top' }, early,
      h('span', null, h('strong', null, 'Early access'), h('br'), h('span', { class: 'small muted' }, 'Gets every new feature automatically, now and in future. Good for a venue helping you test.'))),
    boxes.length
      ? h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'Or pick features one by one. A tick you set here wins over early access and “on for everyone”.'),
        boxes.map(({ x, input }) => h('label', { class: 'check check-top' }, input,
          h('span', null, h('strong', null, x.name), x.override !== null ? h('span', { class: 'small muted' }, ' · set by hand') : null,
            h('br'), h('span', { class: 'small muted' }, x.what)))))
      : h('p', { class: 'small muted' }, 'No new features yet. Early access means this venue will get them as they arrive.')
  );
  const save = async (reset) => {
    const set = {};
    for (const { x, input } of boxes) {
      if (reset) set[x.key] = null;
      else if (input.checked !== x.on) set[x.key] = input.checked;
    }
    try {
      await api('PUT', `/api/owner/venues/${v.id}/features`, { earlyAccess: early.checked, set });
      m.close();
      toast('Saved', 'ok');
      renderDashboard();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const m = modal(`New features — ${v.name}`, content, {
    actions: [
      boxes.some(({ x }) => x.override !== null) ? h('button', { class: 'btn', onclick: () => save(true) }, 'Clear hand-set ticks') : null,
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn btn-primary', onclick: () => save(false) }, 'Save'),
    ].filter(Boolean),
  });
}

// ----- billing: who's paid up (invoices go out from Xero; this is the tracker) -----

function billingBox(v) {
  const b = v.billing || {};
  const bits = [b.plan, b.priceAud != null ? `$${b.priceAud}/month` : null].filter(Boolean).join(' · ');
  return h('div', { class: `reset-box billing-box${b.overdue ? ' overdue' : ''}` },
    h('div', { class: 'reset-title' }, '💳 Billing ',
      b.overdue ? h('span', { class: 'badge badge-warn' }, 'Overdue') : b.paidUntil ? h('span', { class: 'badge s-active' }, 'Paid') : h('span', { class: 'badge' }, 'Not set')),
    h('div', { class: 'small' }, bits || h('span', { class: 'muted' }, 'No plan set'),
      b.paidUntil ? h('span', { class: 'muted' }, ` · paid until ${fmtDate(b.paidUntil)}`) : null),
    b.notes ? h('div', { class: 'small muted' }, b.notes) : null,
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn btn-small', onclick: () => editBilling(v) }, 'Edit'),
      h('button', { class: 'btn btn-small btn-primary', onclick: () => extendPaid(v, 1), title: 'They paid: move "paid until" on a month' }, '+1 month paid')
    )
  );
}

// One month on from whichever is later: the current "paid until", or today.
function addMonth(from) {
  const today = localDate();
  const base = from && from > today ? from : today;
  const [y, m, d] = base.split('-').map(Number);
  const next = new Date(y, m, Math.min(d, new Date(y, m + 1, 0).getDate()));
  return localDate(next);
}

async function extendPaid(v, months) {
  let until = v.billing && v.billing.paidUntil;
  for (let i = 0; i < months; i++) until = addMonth(until);
  try {
    await api('PUT', `/api/owner/venues/${v.id}`, { paidUntil: until });
    toast(`${v.name}: paid until ${fmtDate(until)}`, 'ok');
    renderDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function editBilling(v) {
  const b = v.billing || {};
  const form = h('form', { class: 'stack' },
    h('div', { class: 'grid-2' },
      field('Plan', h('input', { name: 'plan', maxlength: '60', value: b.plan || '', placeholder: 'e.g. Standard' })),
      field('Monthly price (AUD)', h('input', { name: 'priceAud', type: 'number', min: '0', inputmode: 'numeric', value: b.priceAud ?? '' }))
    ),
    field('Paid until', h('input', { name: 'paidUntil', type: 'date', value: b.paidUntil || '' }), 'You get a morning email when it’s 3 days away and when it’s overdue.'),
    field('Notes', h('textarea', { name: 'billingNotes', rows: '2', maxlength: '500' }, b.notes || ''), 'e.g. invoice number, trial until, who to chase.')
  );
  const submit = async (e) => {
    if (e) e.preventDefault();
    const d = formData(form);
    try {
      await api('PUT', `/api/owner/venues/${v.id}`, { plan: d.plan, priceAud: d.priceAud === '' ? null : Number(d.priceAud), paidUntil: d.paidUntil || null, billingNotes: d.billingNotes });
      m.close();
      renderDashboard();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  form.addEventListener('submit', submit);
  const m = modal(`Billing — ${v.name}`, form, {
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', onclick: submit }, 'Save')],
  });
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

function mailCard(data) {
  const on = data.mail && data.mail.configured;
  return h('div', { class: 'card stack' },
    h('h2', null, '✉️ Email ', h('span', { class: `badge ${on ? 's-active' : 's-pending'}` }, on ? 'Connected' : 'Not set up')),
    h('p', { class: 'muted' }, on
      ? `Sign-up alerts go to ${data.mail.notify}. Venues get a “you’re live” email when you approve them, and “Forgot password?” links work.`
      : 'Add mail.json on the server to get sign-up alerts, send “you’re live” emails and switch on “Forgot password?” links.'),
    on ? h('div', { class: 'row' }, h('button', {
      class: 'btn',
      onclick: async () => {
        try {
          const r = await api('POST', '/api/owner/test-email');
          toast(`Test email sent to ${r.to}`, 'ok', 5000);
        } catch (err) {
          toast(err.message, 'error', 6000);
        }
      },
    }, 'Send a test email')) : null
  );
}

function whenText(iso) {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function backupCard(b) {
  if (!b || !b.enabled) {
    return h('div', { class: 'card stack' }, h('h2', null, '💾 Backups ', h('span', { class: 'badge s-disabled' }, 'Off')),
      h('p', { class: 'muted' }, 'Backups are switched off on this server (BACKUPS=0).'));
  }
  const badge = h('span', { class: 'badge' });
  const setBadge = (st) => {
    const o = st.offsite;
    const offBad = o.configured && (!o.lastOkAt || (o.lastError && o.lastError.at > o.lastOkAt));
    const localBad = st.lastError && (!st.lastOkAt || st.lastError.at > st.lastOkAt);
    const [cls, text] = localBad || offBad ? ['s-disabled', 'Problem'] : o.configured ? ['s-active', 'Off-site on'] : ['s-pending', 'Droplet only'];
    badge.className = `badge ${cls}`;
    badge.textContent = text;
  };
  const body = h('div', { class: 'stack' });
  const render = (st) => {
    const o = st.offsite;
    setBadge(st);
    put(body,
      h('p', null, h('strong', null, 'On the droplet: '), `last copy ${whenText(st.lastOkAt)}, keeps ${st.keepDays} days.`),
      st.lastError && (!st.lastOkAt || st.lastError.at > st.lastOkAt) ? h('p', { class: 'error-text' }, `Last try failed: ${st.lastError.message}`) : null,
      o.configured
        ? h('p', null, h('strong', null, 'Off-site (DigitalOcean Spaces): '), `${o.bucket} (${o.region}), last copy ${whenText(o.lastOkAt)}.`)
        : h('p', { class: 'muted' }, 'Off-site copies are not set up yet. If the droplet were lost, the guest lists would go with it. Add backup.json on the server to send an encrypted copy to DigitalOcean Spaces every night.'),
      o.configured && o.lastError && (!o.lastOkAt || o.lastError.at > o.lastOkAt) ? h('p', { class: 'error-text' }, `Last upload failed: ${o.lastError.message}`) : null
    );
  };
  render(b);
  const btn = h('button', {
    class: 'btn',
    onclick: async () => {
      btn.disabled = true;
      btn.textContent = 'Backing up…';
      try {
        const r = await api('POST', '/api/owner/backup-now');
        render(r.backup);
        if (r.local && !r.local.ok) toast(`Backup failed: ${r.local.error}`, 'error', 8000);
        else if (r.offsite && !r.offsite.ok) toast(`Saved on the droplet, but the upload failed: ${r.offsite.error}`, 'error', 8000);
        else toast(r.offsite ? 'Backed up and uploaded to Spaces' : 'Backed up on the droplet', 'ok', 5000);
      } catch (err) {
        toast(err.message, 'error', 6000);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Back up now';
      }
    },
  }, 'Back up now');
  return h('div', { class: 'card stack' }, h('h2', null, '💾 Backups ', badge), body, h('div', { class: 'row' }, btn));
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
    h('h2', null, 'Applications'),
    h('label', { class: 'check' }, box, h('span', null, 'Approve applications automatically')),
    h('p', { class: 'small muted' }, 'Off (recommended for a paid product): applications wait here until you approve them. On: every application is sent a setup link straight away.')
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
