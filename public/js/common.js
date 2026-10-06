'use strict';

// Shared helpers for the venue app and the contributor portal.

const NAME_KEY = 'vl.deviceName';

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v; // CSSOM, allowed under our CSP
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// Replace an element's children (arrays are flattened, falsy values skipped).
function put(el, ...children) {
  clear(el);
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function deviceName() {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
}

function setDeviceName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode: name lasts for this page only */
  }
  window.__deviceName = name;
}

function currentName() {
  return deviceName() || window.__deviceName || '';
}

class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// A random id per phone, so wrong-password lockouts hit only the phone that got it wrong.
function deviceKey() {
  let id = '';
  try {
    id = localStorage.getItem('vl.deviceId') || '';
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      const bytes = new Uint8Array(12);
      crypto.getRandomValues(bytes);
      id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('vl.deviceId', id);
    }
  } catch {
    id = window.__deviceKey || (window.__deviceKey = `tmp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
  }
  return id;
}

// Today's date on this phone (not UTC), as YYYY-MM-DD.
function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function api(method, url, body) {
  const headers = { 'X-Actor': encodeURIComponent(currentName()), 'X-Device': deviceKey() };
  if (body !== undefined || method !== 'GET') headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
    });
  } catch {
    throw new ApiError(0, 'You’re offline — no connection to the server.', 'offline');
  }
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`, data && data.code);
  return data;
}

// ---------- toast ----------

function toast(message, kind = 'info', ms = 3200) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const t = h('div', { class: `toast toast-${kind}` }, message);
  box.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

// ---------- modal ----------

function modal(title, content, { actions = [], onClose, wide = false } = {}) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const box = h(
    'div',
    { class: `modal${wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' },
      h('h2', null, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '✕')
    ),
    h('div', { class: 'modal-body' }, content),
    actions.length ? h('div', { class: 'modal-actions' }, actions) : null
  );
  backdrop.append(box);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  const first = box.querySelector('input, select, textarea');
  if (first) setTimeout(() => {
    if (!box.contains(document.activeElement)) first.focus();
  }, 30);
  return { close, box };
}

function confirmDialog(title, message, { confirmText = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const m = modal(title, h('p', null, message), {
      actions: [
        h('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => finish(true) }, confirmText),
      ],
      onClose: () => finish(false),
    });
  });
}

// Ask who is using this device. Every change is logged against this name.
function promptDeviceName({ force = false, context = '' } = {}) {
  return new Promise((resolve) => {
    const existing = currentName();
    if (existing && !force) return resolve(existing);
    const input = h('input', {
      type: 'text',
      maxlength: '60',
      placeholder: 'e.g. Sam (Door 1)',
      value: existing,
      autocomplete: 'name',
      required: true,
    });
    const save = (e) => {
      if (e) e.preventDefault();
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return;
      }
      setDeviceName(name);
      m.close();
      resolve(name);
      document.dispatchEvent(new CustomEvent('vl:name', { detail: name }));
    };
    const form = h(
      'form',
      { onsubmit: save },
      h('p', { class: 'muted' },
        context || 'Everything you add, edit or check in on this device is recorded under this name.'
      ),
      h('label', { class: 'field' }, h('span', null, 'Your name'), input)
    );
    const m = modal('Who’s on this device?', form, {
      actions: [h('button', { class: 'btn btn-primary', onclick: save }, 'Save')],
      onClose: () => {
        if (!currentName()) setTimeout(() => promptDeviceName({ context }).then(resolve), 0);
        else resolve(currentName());
      },
    });
  });
}

// ---------- formatting ----------

function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// ISO -> value for <input type="datetime-local">
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v) {
  return v ? new Date(v).toISOString() : null;
}

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
}

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value;
  }
  return out;
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// Mirrors the server's slugify() so the admin can preview a venue ID while typing.
function slugPreview(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

// ---------- photos ----------

// Shrinks a photo on the phone before it's sent (max 900px, JPEG), so uploads stay small.
function shrinkPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That photo couldn’t be read. Try taking it again.'));
    };
    img.src = url;
  });
}

// ---------- manager override ----------

function askManagerPin(reason) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const input = h('input', { type: 'password', autocomplete: 'off', maxlength: '100', placeholder: 'Manager code' });
    const form = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); if (input.value) finish(input.value); } },
      h('div', { class: 'override-reason' }, '🔒 ', reason),
      h('p', { class: 'muted small' }, 'A manager needs to enter their code. It’s logged with your name and theirs.'),
      input
    );
    const m = modal('Manager override', form, {
      actions: [
        h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel'),
        h('button', { class: 'btn btn-primary', onclick: () => input.value && finish(input.value) }, 'Override'),
      ],
      onClose: () => finish(null),
    });
  });
}

// Runs call(extra). If the server says a rule is being broken, asks for confirmation
// (venue has no PIN yet) or the manager PIN, then retries. Returns null if cancelled.
async function withOverride(call) {
  try {
    return await call({});
  } catch (err) {
    if (err.code === 'confirm') {
      const ok = await confirmDialog('Go over the limit?', `${err.message} Continue anyway?`, { confirmText: 'Yes, continue' });
      return ok ? call({ force: true }) : null;
    }
    if (err.code !== 'override') throw err;
    let reason = err.message;
    for (;;) {
      const pin = await askManagerPin(reason);
      if (pin === null) return null;
      try {
        return await call({ overridePin: pin });
      } catch (e2) {
        if (e2.code !== 'override') throw e2;
        toast('Wrong manager code', 'error');
        reason = e2.message.replace(/^Wrong manager code\. /, '');
      }
    }
  }
}

// ---------- offline queue (door taps saved on this phone until the connection is back) ----------

const QUEUE_KEY = 'vl.queue';
const offline = { flushing: false, problems: [] };

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function queueList() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

function queueSave(list) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked: taps still show on screen but won't survive a reload */
  }
  document.dispatchEvent(new CustomEvent('vl:queue'));
}

// op: { kind: 'count' | 'move', url, body, eventId, guestId?, dir?, label }
function queueAdd(op) {
  const list = queueList();
  list.push({ ...op, opId: randomId(), at: new Date().toISOString(), actor: currentName() });
  queueSave(list);
  setTimeout(queueFlush, 1500);
}

// Sends saved taps in order. Stops at the first network failure and tries again later.
async function queueFlush() {
  if (offline.flushing) return;
  let list = queueList();
  if (!list.length) return;
  offline.flushing = true;
  document.dispatchEvent(new CustomEvent('vl:queue'));
  try {
    while (list.length) {
      const op = list[0];
      let res;
      try {
        res = await fetch(op.url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'X-Actor': encodeURIComponent(op.actor || currentName()),
            'X-Device': deviceKey(),
            'X-Op-Id': op.opId,
            'X-Op-At': op.at,
          },
          body: JSON.stringify(op.body || {}),
        });
      } catch {
        break; // still offline
      }
      if (res.status === 401) break; // logged out: keep them until someone logs back in
      if (!res.ok) {
        // The server said no (e.g. over capacity now that other doors' taps have landed).
        const data = await res.json().catch(() => ({}));
        offline.problems.push({ label: op.label, error: data.error || `Failed (${res.status})`, at: op.at });
      }
      list = queueList().filter((x) => x.opId !== op.opId);
      queueSave(list);
    }
  } finally {
    offline.flushing = false;
    document.dispatchEvent(new CustomEvent('vl:queue'));
  }
}

window.addEventListener('online', () => queueFlush());
setInterval(() => {
  if (queueList().length) queueFlush();
}, 10000);

// ---------- forgiving name search ----------
// At a busy door a missed search turns a guest away, so the search forgives the usual slips:
// any word (surnames too), O'Brien / Ann-Marie typed without punctuation, common nicknames
// (Jon → Jonathan, Kate → Katherine, Lachie → Lachlan), and a typo or two in longer words.

const NICKNAMES = [
  ['john', 'jon', 'johnny', 'jonny', 'jack'], ['jonathan', 'jon', 'jonny', 'johnny'], ['michael', 'mike', 'mick', 'mikey', 'micky'],
  ['christopher', 'chris', 'kit'], ['christine', 'christina', 'chris', 'chrissy', 'tina'], ['william', 'will', 'bill', 'billy', 'liam', 'willy'],
  ['robert', 'rob', 'bob', 'robbie', 'bobby'], ['richard', 'rich', 'rick', 'richie', 'dick'], ['james', 'jim', 'jimmy', 'jamie'],
  ['joseph', 'joe', 'joey'], ['thomas', 'tom', 'tommy'], ['daniel', 'dan', 'danny'], ['david', 'dave', 'davey'], ['matthew', 'matt'],
  ['nicholas', 'nick', 'nicky'], ['anthony', 'tony', 'ant'], ['andrew', 'andy', 'drew'], ['alexander', 'alexandra', 'alex', 'xander', 'lex', 'sasha'],
  ['benjamin', 'ben', 'benny'], ['samuel', 'samantha', 'sam', 'sammy'], ['edward', 'ed', 'eddie', 'ted', 'ned'],
  ['elizabeth', 'liz', 'lizzie', 'beth', 'eliza', 'betty'], ['katherine', 'catherine', 'kathryn', 'kate', 'katie', 'kat', 'cathy', 'kathy'],
  ['margaret', 'maggie', 'meg', 'peggy'], ['jennifer', 'jen', 'jenny'], ['rebecca', 'becky', 'bec', 'becca'], ['jessica', 'jess', 'jessie'],
  ['victoria', 'vic', 'vicky', 'tori'], ['patrick', 'patricia', 'pat', 'paddy', 'patty'], ['stephen', 'steven', 'steve', 'stevie'],
  ['timothy', 'tim', 'timmy'], ['zachary', 'zac', 'zach', 'zack'], ['nathan', 'nathaniel', 'nate', 'nat'], ['joshua', 'josh'],
  ['gregory', 'greg'], ['jacob', 'jake'], ['charles', 'charlotte', 'charlie', 'chuck', 'chaz', 'lottie'], ['frederick', 'fred', 'freddie'],
  ['henry', 'harry', 'hal'], ['lachlan', 'lachie', 'lachy'], ['isabella', 'isabelle', 'bella', 'izzy', 'issy'], ['abigail', 'abby', 'abbie'],
  ['natalie', 'nat', 'tali'], ['olivia', 'liv', 'livvy'], ['madeleine', 'madeline', 'maddie', 'maddy'], ['emily', 'em', 'emmy'],
  ['gabriel', 'gabrielle', 'gabe', 'gabby'], ['nicole', 'nikki', 'nic'], ['dominic', 'dom'], ['cameron', 'cam'], ['sebastian', 'seb'],
];
const NICK = new Map();
NICKNAMES.forEach((group, i) => group.forEach((n) => NICK.set(n, [...(NICK.get(n) || []), i])));

// Lower case, no accents; apostrophes, full stops and hyphens joined up (O'Brien → obrien).
function searchKey(s) {
  return norm(s).replace(/['’`.\-]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Edit distance, giving up past `max` (a swapped pair of letters counts as one).
function within(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return false;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length] <= max;
}

function termScore(t, words, joined, extra) {
  let best = 0;
  words.forEach((w, i) => {
    if (w.startsWith(t)) best = Math.max(best, i === 0 ? 5 : 4); // a first name or surname starting with it
    const groups = NICK.get(t);
    if (groups && (NICK.get(w) || []).some((g) => groups.includes(g))) best = Math.max(best, 3);
    // Typos: only in longer words, and never the first letter (people rarely miss that one),
    // so "kate" can't wander off to "Patel".
    if (t.length >= 5 && t[0] === w[0]) {
      const max = t.length >= 8 ? 2 : 1;
      if (within(t, w.slice(0, t.length), max) || within(t, w, max)) best = Math.max(best, 1);
    }
  });
  if (!best && joined.includes(t)) best = 2; // inside a name, or typed without spaces
  if (!best && extra.includes(t)) best = 1; // the note, contributor or list
  return best;
}

// 0 = not a match; higher = better. Every word typed has to match something.
function guestScore(query, g) {
  const terms = searchKey(query).split(' ').filter(Boolean);
  if (!terms.length) return 1;
  const words = searchKey(g.name).split(' ').filter(Boolean);
  const joined = words.join('');
  const extra = searchKey(`${g.notes || ''} ${g.contributorName || ''} ${g.listType || ''}`);
  let total = 0;
  for (const t of terms) {
    const s = termScore(t, words, joined, extra);
    if (!s) return 0;
    total += s;
  }
  return total;
}
