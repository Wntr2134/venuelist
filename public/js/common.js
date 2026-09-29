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

async function api(method, url, body) {
  const headers = { 'X-Actor': encodeURIComponent(currentName()) };
  if (body !== undefined || method !== 'GET') headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
  });
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
    const input = h('input', { type: 'password', autocomplete: 'off', maxlength: '100', placeholder: 'Manager PIN' });
    const form = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); if (input.value) finish(input.value); } },
      h('div', { class: 'override-reason' }, '🔒 ', reason),
      h('p', { class: 'muted small' }, 'A manager needs to enter the override PIN. It’s logged against your name.'),
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
        toast('Wrong manager PIN', 'error');
        reason = e2.message.replace(/^Wrong manager PIN\. /, '');
      }
    }
  }
}
