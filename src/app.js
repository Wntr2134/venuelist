'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getSetting, setSetting, tx, slugify, uniqueSlug } = require('./db');
const auth = require('./auth');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const LIST_TYPES = ['Guest', 'Artist', 'Crew', 'Industry', 'Media', 'Venue', 'Door'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString();
const newToken = () => crypto.randomBytes(18).toString('base64url');

// ---------- validation ----------

function str(v, field, { max = 200, required = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `${field} is invalid`);
  const s = String(v).trim();
  if (required && !s) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return s;
}

function int(v, field, { min = 0, max = 100000, nullable = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (nullable) return null;
    v = 0;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${field} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

function listType(v, fallback = 'Guest') {
  const s = str(v, 'List type', { max: 30 }) || fallback;
  if (!LIST_TYPES.includes(s)) throw new HttpError(400, `List type must be one of: ${LIST_TYPES.join(', ')}`);
  return s;
}

function isoOrNull(v, field) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${field} is not a valid date/time`);
  return d.toISOString();
}

function dateStr(v) {
  const s = str(v, 'Date', { required: true, max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, 'Date must be YYYY-MM-DD');
  return s;
}

function timeStr(v) {
  const s = str(v, 'Doors time', { max: 5 });
  if (s && !/^\d{2}:\d{2}$/.test(s)) throw new HttpError(400, 'Doors time must be HH:MM');
  return s || null;
}

// ---------- serialisers ----------

function eventOut(e) {
  return {
    id: e.id,
    name: e.name,
    date: e.date,
    doorsTime: e.doors_time,
    capacity: e.capacity,
    cutoffAt: e.cutoff_at,
    notes: e.notes,
    archived: !!e.archived,
    createdAt: e.created_at,
    createdBy: e.created_by,
  };
}

function contributorOut(c) {
  return {
    id: c.id,
    eventId: c.event_id,
    name: c.name,
    listType: c.list_type,
    allocation: c.allocation,
    token: c.token,
    active: !!c.active,
    notes: c.notes,
    createdAt: c.created_at,
    createdBy: c.created_by,
  };
}

function guestOut(g) {
  return {
    id: g.id,
    eventId: g.event_id,
    contributorId: g.contributor_id,
    contributorName: g.contributor_name || null,
    name: g.name,
    plusOnes: g.plus_ones,
    party: 1 + g.plus_ones,
    listType: g.list_type,
    vip: !!g.vip,
    notes: g.notes,
    inside: g.inside,
    admitted: g.admitted,
    firstInAt: g.first_in_at,
    lastMoveAt: g.last_move_at,
    addedBy: g.added_by,
    addedVia: g.added_via,
    createdAt: g.created_at,
    updatedAt: g.updated_at,
    updatedBy: g.updated_by,
  };
}

// ---------- queries ----------

function getEvent(db, id) {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!e) throw new HttpError(404, 'Event not found');
  return e;
}

function getGuest(db, id) {
  const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
  if (!g) throw new HttpError(404, 'Guest not found');
  return g;
}

function getContributor(db, id) {
  const c = db.prepare('SELECT * FROM contributors WHERE id = ?').get(id);
  if (!c) throw new HttpError(404, 'Contributor not found');
  return c;
}

function listGuests(db, eventId, contributorId) {
  const sql = `
    SELECT g.*, c.name AS contributor_name
    FROM guests g LEFT JOIN contributors c ON c.id = g.contributor_id
    WHERE g.event_id = ? ${contributorId ? 'AND g.contributor_id = ?' : ''}
    ORDER BY g.name COLLATE NOCASE`;
  const args = contributorId ? [eventId, contributorId] : [eventId];
  return db.prepare(sql).all(...args).map(guestOut);
}

function headsFor(db, contributorId, excludeGuestId = 0) {
  const row = db
    .prepare('SELECT COALESCE(SUM(1 + plus_ones), 0) AS heads FROM guests WHERE contributor_id = ? AND id != ?')
    .get(contributorId, excludeGuestId);
  return row.heads;
}

function eventHeads(db, eventId, excludeGuestId = 0) {
  const row = db
    .prepare('SELECT COALESCE(SUM(1 + plus_ones), 0) AS heads FROM guests WHERE event_id = ? AND id != ?')
    .get(eventId, excludeGuestId);
  return row.heads;
}

function stats(guests) {
  const s = { guests: guests.length, expected: 0, admitted: 0, inside: 0, vip: 0, vipInside: 0 };
  for (const g of guests) {
    s.expected += g.party;
    s.admitted += g.admitted;
    s.inside += g.inside;
    if (g.vip) {
      s.vip += 1;
      if (g.inside) s.vipInside += 1;
    }
  }
  s.noShow = s.expected - s.admitted;
  return s;
}

function log(db, { eventId, guest, action, detail, actor, via }) {
  db.prepare(
    'INSERT INTO activity (event_id, guest_id, guest_name, action, detail, actor, via, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(eventId, guest ? guest.id : null, guest ? guest.name : null, action, detail || null, actor, via, now());
}

function contributorLocked(db, contributor) {
  const e = getEvent(db, contributor.event_id);
  const venue = db.prepare('SELECT active FROM venues WHERE id = ?').get(e.venue_id);
  if (!venue || !venue.active) return 'This venue’s guest list is currently unavailable.';
  if (e.archived) return 'This event has been archived.';
  if (!contributor.active) return 'This link has been disabled by the venue.';
  if (e.cutoff_at && Date.now() > Date.parse(e.cutoff_at)) return 'The guest list cutoff for this event has passed.';
  return null;
}

function checkAllocation(db, contributor, party, excludeGuestId) {
  if (contributor.allocation === null || contributor.allocation === undefined) return;
  const used = headsFor(db, contributor.id, excludeGuestId);
  if (used + party > contributor.allocation) {
    const left = Math.max(0, contributor.allocation - used);
    throw new HttpError(409, `Allocation exceeded — ${left} spot${left === 1 ? '' : 's'} left of ${contributor.allocation}.`);
  }
}

function checkCapacity(db, event, party, excludeGuestId) {
  if (!event.capacity) return;
  const used = eventHeads(db, event.id, excludeGuestId);
  if (used + party > event.capacity) {
    throw new HttpError(409, `Event guest list is full (${used}/${event.capacity} heads).`);
  }
}

// ---------- live updates (Server-Sent Events) ----------

function createHub() {
  const streams = new Map(); // eventId -> Set<res>
  return {
    add(eventId, res) {
      if (!streams.has(eventId)) streams.set(eventId, new Set());
      streams.get(eventId).add(res);
      res.on('close', () => streams.get(eventId)?.delete(res));
    },
    publish(eventId, payload) {
      const set = streams.get(eventId);
      if (!set) return;
      const data = `data: ${JSON.stringify(payload)}\n\n`;
      for (const res of set) res.write(data);
    },
    closeAll() {
      for (const set of streams.values()) for (const res of set) res.end();
      streams.clear();
    },
  };
}

// ---------- HTTP plumbing ----------

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function actorFrom(req) {
  let raw = req.headers['x-actor'] || '';
  try {
    raw = decodeURIComponent(raw);
  } catch {
    raw = '';
  }
  const name = raw.trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'Set your name on this device before making changes.');
  return name;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

function serveStatic(req, res, pathname) {
  let file;
  if (pathname === '/' || pathname === '/index.html') file = 'index.html'; // public landing page
  else if (pathname === '/app' || pathname === '/app/') file = 'app.html'; // venue app
  else if (pathname === '/login' || /^\/v\/[A-Za-z0-9_-]+\/?$/.test(pathname)) file = 'login.html';
  else if (/^\/setup\/[A-Za-z0-9_-]+\/?$/.test(pathname)) file = 'setup.html';
  else if (pathname === '/admin' || pathname === '/admin/') file = 'admin.html';
  else if (pathname === '/guide' || pathname === '/guide/') file = 'guide.html';
  else if (/^\/c\/[A-Za-z0-9_-]+\/?$/.test(pathname)) file = 'contributor.html';
  else file = pathname.replace(/^\/+/, '');

  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=300',
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
}

// CSV times are shown in the venue's local time (Melbourne for now; DISPLAY_TZ overrides).
const localTime = new Intl.DateTimeFormat('en-AU', {
  timeZone: process.env.DISPLAY_TZ || 'Australia/Melbourne',
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});
const csvTime = (iso) => (iso ? localTime.format(new Date(iso)).replace(',', '') : '');

function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // guard against spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Parses pasted lines like "Jane Smith +2, note" or CSV "Jane Smith,2,note".
function parseImport(text) {
  const rows = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\t|,/).map((p) => p.trim());
    let name = parts[0];
    let plus = 0;
    let notes = '';
    const inline = name.match(/^(.*?)\s*\+\s*(\d+)$/);
    if (inline) {
      name = inline[1];
      plus = Number(inline[2]);
      notes = parts.slice(1).join(', ');
    } else if (parts.length > 1 && /^\+?\d+$/.test(parts[1])) {
      plus = Number(parts[1].replace('+', ''));
      notes = parts.slice(2).join(', ');
    } else {
      notes = parts.slice(1).join(', ');
    }
    if (/^name$/i.test(name)) continue; // header row
    if (name) rows.push({ name, plusOnes: plus, notes });
  }
  return rows;
}

// ---------- the app ----------

function createApp(db, options = {}) {
  const secureCookies = !!options.secureCookies;
  const trustProxy = !!options.trustProxy;

  // Behind nginx/Caddy every request comes from 127.0.0.1, so use the client IP the proxy appended.
  function clientIp(req) {
    if (trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (fwd.length) return fwd[fwd.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  }
  const hub = createHub();
  const loginLimiter = createLimiter();
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, ...opts });

  function createLimiter() {
    return auth.createLimiter({ max: 10, windowMs: 10 * 60 * 1000 });
  }

  const SETUP_LINK_DAYS = 7;
  const DUMMY_HASH = auth.hashPassword(crypto.randomBytes(8).toString('hex'));
  const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

  function publish(eventId, type, extra = {}) {
    hub.publish(eventId, { type, at: now(), ...extra });
  }

  function venueOut(v) {
    return { id: v.id, slug: v.slug, name: v.name };
  }

  function password(v, field = 'Password') {
    const p = str(v, field, { required: true, max: 200 });
    if (p.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    return p;
  }

  function limit(req) {
    if (loginLimiter.blocked(clientIp(req))) throw new HttpError(429, 'Too many wrong attempts. Try again in a few minutes.');
  }

  function failed(req) {
    loginLimiter.fail(clientIp(req));
  }

  // The venue for a request's session cookie, or null. Sessions die when the venue's
  // password changes or the owner disables the venue.
  function sessionVenue(req) {
    const s = auth.venueSession(db, req);
    if (!s) return null;
    const v = db.prepare('SELECT * FROM venues WHERE id = ?').get(s.venueId);
    if (!v || !v.active || !v.password_hash || v.password_version !== s.version) return null;
    return v;
  }

  function newSetupLink(venueId) {
    const token = crypto.randomBytes(24).toString('base64url');
    const expires = new Date(Date.now() + SETUP_LINK_DAYS * 86400 * 1000).toISOString();
    db.prepare('UPDATE venues SET setup_token_hash = ?, setup_expires_at = ? WHERE id = ?').run(sha256(token), expires, venueId);
    return { setupPath: `/setup/${token}`, setupExpiresAt: expires };
  }

  function venueBySetupToken(token) {
    const v = db.prepare('SELECT * FROM venues WHERE setup_token_hash = ?').get(sha256(token));
    if (!v || !v.setup_expires_at || Date.parse(v.setup_expires_at) < Date.now()) {
      throw new HttpError(404, 'This setup link has expired or already been used. Ask Riderly for a new one.');
    }
    if (!v.active) throw new HttpError(403, 'This venue has been disabled.');
    return v;
  }

  // ----- public -----

  // Used by deploys and uptime checks. Deliberately reveals nothing else.
  route('GET', /^\/health$/, () => {
    db.prepare('SELECT 1').get();
    return { ok: true };
  }, { auth: 'public' });

  // What the landing page needs. Never lists venues.
  route('GET', /^\/api\/public$/, () => ({
    contactEmail: getSetting(db, 'contact_email') || null,
  }), { auth: 'public' });

  // Usernames are the venue's login and its staff link (/v/<username>).
  const RESERVED = new Set(['admin', 'login', 'app', 'setup', 'guide', 'api', 'health', 'riderly', 'owner', 'venue']);
  function usernameFrom(v, { required = true } = {}) {
    const raw = str(v, 'Username', { required, max: 40 });
    if (!raw) return '';
    const u = slugify(raw);
    if (u.length < 3) throw new HttpError(400, 'Username must be at least 3 letters or numbers');
    if (RESERVED.has(u)) throw new HttpError(409, `Username "${u}" isn’t available`);
    return u;
  }
  function usernameTaken(u, exceptRequestId = 0) {
    return !!(
      db.prepare('SELECT 1 FROM venues WHERE slug = ?').get(u) ||
      db.prepare("SELECT 1 FROM access_requests WHERE slug = ? AND status = 'new' AND id != ?").get(u, exceptRequestId)
    );
  }

  function createVenue({ name, slug, passwordHash }) {
    const t = now();
    const info = db
      .prepare('INSERT INTO venues (slug, name, password_hash, created_at, setup_at) VALUES (?, ?, ?, ?, ?)')
      .run(slug, name, passwordHash || null, t, passwordHash ? t : null);
    return db.prepare('SELECT * FROM venues WHERE id = ?').get(Number(info.lastInsertRowid));
  }

  // Public sign-up on the landing page. Normally lands in the owner's /admin inbox for
  // one-tap approval; with auto-approve on, the venue is live immediately.
  const signupLimiter = auth.createLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
  route('POST', /^\/api\/signup$/, ({ req, body, res }) => {
    const ip = clientIp(req);
    if (signupLimiter.blocked(ip)) throw new HttpError(429, 'Too many sign-ups from here. Try again in an hour.');
    if (body.website) return { status: 'pending' }; // honeypot field: bots fill it, people never see it
    const venueName = str(body.venueName, 'Venue name', { required: true, max: 120 });
    const username = usernameFrom(body.username);
    const email = str(body.email, 'Email', { required: true, max: 120 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'That email address looks wrong');
    const hash = auth.hashPassword(password(body.password));
    if (usernameTaken(username)) throw new HttpError(409, `Username "${username}" is taken — try another.`);
    const pending = db.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE status = 'new'").get().n;
    if (pending >= 200) throw new HttpError(503, 'We’re catching up on sign-ups — please try again later.');
    signupLimiter.fail(ip); // counts every successful submission

    const contact = str(body.name, 'Your name', { required: true, max: 80 });
    const phone = str(body.phone, 'Phone', { max: 40 }) || null;
    const message = str(body.message, 'Message', { max: 1000 }) || null;
    const autoApprove = getSetting(db, 'auto_approve') === '1';
    db.prepare(
      `INSERT INTO access_requests (venue_name, contact_name, email, phone, message, slug, password_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(venueName, contact, email, phone, message, username, autoApprove ? null : hash, autoApprove ? 'done' : 'new', now());
    if (!autoApprove) return { status: 'pending', username };
    const v = createVenue({ name: venueName, slug: username, passwordHash: hash });
    res.setHeader('Set-Cookie', auth.venueCookie(db, v, secureCookies));
    return { status: 'active', venue: venueOut(v) };
  }, { auth: 'public' });

  // ----- venue login -----

  route('GET', /^\/api\/session$/, ({ req }) => {
    const v = sessionVenue(req);
    return { authed: !!v, venue: v ? venueOut(v) : null };
  }, { auth: 'public' });

  route('POST', /^\/api\/login$/, ({ req, body, res }) => {
    limit(req);
    // Accept "brunswick-ballroom", "Brunswick Ballroom" or a pasted /v/brunswick-ballroom link.
    const raw = str(body.venue ?? body.username, 'Username', { required: true, max: 200 }).replace(/^.*\/v\//, '').replace(/[/?#].*$/, '');
    const pw = str(body.password, 'Password', { max: 200 });
    const v = db.prepare('SELECT * FROM venues WHERE slug = ?').get(slugify(raw));
    // Same work whether or not the venue exists, so the response doesn't reveal which venues are real.
    const ok = auth.verifyPassword(pw, (v && v.password_hash) || DUMMY_HASH) && !!v && !!v.password_hash;
    if (!ok) {
      const waiting = db.prepare("SELECT password_hash FROM access_requests WHERE slug = ? AND status = 'new'").get(slugify(raw));
      if (!v && waiting && waiting.password_hash && auth.verifyPassword(pw, waiting.password_hash)) {
        throw new HttpError(403, 'Your sign-up is waiting for approval. We’ll email you as soon as it’s live.');
      }
      failed(req);
      throw new HttpError(401, 'Username or password is wrong.');
    }
    if (!v.active) throw new HttpError(403, 'This venue has been disabled. Contact Riderly.');
    db.prepare('UPDATE venues SET last_login_at = ? WHERE id = ?').run(now(), v.id);
    res.setHeader('Set-Cookie', auth.venueCookie(db, v, secureCookies));
    return { ok: true, venue: venueOut(v) };
  }, { auth: 'public' });

  route('POST', /^\/api\/logout$/, ({ res }) => {
    res.setHeader('Set-Cookie', auth.clearVenueCookie(secureCookies));
    return { ok: true };
  }, { auth: 'public' });

  // ----- venue setup links (sent by the owner) -----

  route('GET', /^\/api\/setup\/([A-Za-z0-9_-]+)$/, ({ params }) => {
    const v = venueBySetupToken(params[0]);
    return { venue: venueOut(v), reset: !!v.password_hash };
  }, { auth: 'public' });

  route('POST', /^\/api\/setup\/([A-Za-z0-9_-]+)$/, ({ req, params, body, res }) => {
    limit(req);
    const v = venueBySetupToken(params[0]);
    const hash = auth.hashPassword(password(body.password));
    const version = v.password_hash ? v.password_version + 1 : v.password_version; // a reset logs out old devices
    const t = now();
    db.prepare(
      `UPDATE venues SET password_hash = ?, password_version = ?, setup_token_hash = NULL, setup_expires_at = NULL,
         setup_at = COALESCE(setup_at, ?), last_login_at = ? WHERE id = ?`
    ).run(hash, version, t, t, v.id);
    const fresh = db.prepare('SELECT * FROM venues WHERE id = ?').get(v.id);
    res.setHeader('Set-Cookie', auth.venueCookie(db, fresh, secureCookies));
    return { ok: true, venue: venueOut(fresh) };
  }, { auth: 'public' });

  // ----- venue settings -----

  route('PUT', /^\/api\/settings$/, ({ venue, body, res }) => {
    if (body.venueName !== undefined) {
      db.prepare('UPDATE venues SET name = ? WHERE id = ?').run(str(body.venueName, 'Venue name', { max: 80, required: true }), venue.id);
    }
    if (body.newPassword) {
      if (!auth.verifyPassword(str(body.currentPassword, 'Current password', { max: 200 }), venue.password_hash)) {
        throw new HttpError(401, 'Current password is wrong');
      }
      db.prepare('UPDATE venues SET password_hash = ?, password_version = password_version + 1 WHERE id = ?').run(
        auth.hashPassword(password(body.newPassword, 'New password')), venue.id
      );
    }
    const fresh = db.prepare('SELECT * FROM venues WHERE id = ?').get(venue.id);
    // Keep this device signed in; every other device must log in again after a password change.
    res.setHeader('Set-Cookie', auth.venueCookie(db, fresh, secureCookies));
    return { ok: true, venue: venueOut(fresh) };
  });

  // ----- owner (Riderly) -----

  const ownerHasPassword = () => !!getSetting(db, 'owner_password_hash');

  route('GET', /^\/api\/owner\/session$/, ({ req }) => ({
    needsSetup: !ownerHasPassword(),
    setupCodeRequired: !ownerHasPassword() && !!options.setupCode,
    authed: auth.isOwner(db, req),
  }), { auth: 'public' });

  route('POST', /^\/api\/owner\/setup$/, ({ req, body, res }) => {
    if (ownerHasPassword()) throw new HttpError(409, 'Already set up');
    limit(req);
    // On a public server, only someone who can read the server log can claim the owner account.
    if (options.setupCode) {
      const given = Buffer.from(str(body.setupCode, 'Setup code', { max: 100 }).toUpperCase());
      const expected = Buffer.from(options.setupCode);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        failed(req);
        throw new HttpError(403, 'Wrong setup code. It is printed in the server log.');
      }
    }
    setSetting(db, 'owner_password_hash', auth.hashPassword(password(body.password)));
    res.setHeader('Set-Cookie', auth.ownerCookie(db, secureCookies));
    return { ok: true };
  }, { auth: 'public' });

  route('POST', /^\/api\/owner\/login$/, ({ req, body, res }) => {
    limit(req);
    const ok = auth.verifyPassword(str(body.password, 'Password', { max: 200 }), getSetting(db, 'owner_password_hash') || DUMMY_HASH);
    if (!ok || !ownerHasPassword()) {
      failed(req);
      throw new HttpError(401, 'Wrong password');
    }
    res.setHeader('Set-Cookie', auth.ownerCookie(db, secureCookies));
    return { ok: true };
  }, { auth: 'public' });

  route('POST', /^\/api\/owner\/logout$/, ({ res }) => {
    res.setHeader('Set-Cookie', auth.clearOwnerCookie(secureCookies));
    return { ok: true };
  }, { auth: 'public' });

  // Owner sees venues and counts only — never guest names.
  route('GET', /^\/api\/owner\/venues$/, () => {
    const rows = db
      .prepare(
        `SELECT v.*,
           (SELECT COUNT(*) FROM events e WHERE e.venue_id = v.id) AS event_count,
           (SELECT COUNT(*) FROM events e WHERE e.venue_id = v.id AND e.archived = 0 AND e.date >= date('now', '-1 day')) AS upcoming,
           (SELECT COUNT(*) FROM guests g JOIN events e ON e.id = g.event_id WHERE e.venue_id = v.id) AS guest_count,
           (SELECT MAX(a.at) FROM activity a JOIN events e ON e.id = a.event_id WHERE e.venue_id = v.id) AS last_activity
         FROM venues v ORDER BY v.name COLLATE NOCASE`
      )
      .all();
    const requests = db
      .prepare("SELECT * FROM access_requests ORDER BY status = 'done', id DESC LIMIT 100")
      .all()
      .map((r) => ({
        id: r.id,
        venueName: r.venue_name,
        name: r.contact_name,
        email: r.email,
        phone: r.phone,
        message: r.message,
        username: r.slug,
        hasPassword: !!r.password_hash,
        status: r.status,
        createdAt: r.created_at,
      }));
    return {
      contactEmail: getSetting(db, 'contact_email') || '',
      autoApprove: getSetting(db, 'auto_approve') === '1',
      requests,
      venues: rows.map((v) => ({
        ...venueOut(v),
        status: !v.active ? 'disabled' : v.password_hash ? 'active' : 'pending',
        setupLinkActive: !!v.setup_expires_at && Date.parse(v.setup_expires_at) > Date.now(),
        setupExpiresAt: v.setup_expires_at,
        createdAt: v.created_at,
        setupAt: v.setup_at,
        lastLoginAt: v.last_login_at,
        lastActivity: v.last_activity,
        eventCount: v.event_count,
        upcoming: v.upcoming,
        guestCount: v.guest_count,
      })),
    };
  }, { auth: 'owner' });

  route('POST', /^\/api\/owner\/venues$/, ({ body }) => {
    const name = str(body.name, 'Venue name', { required: true, max: 80 });
    let slug = usernameFrom(body.username ?? body.slug, { required: false });
    if (slug && usernameTaken(slug)) throw new HttpError(409, `Username "${slug}" is taken.`);
    if (!slug) slug = uniqueSlug(db, name);
    const v = createVenue({ name, slug });
    return { venue: venueOut(v), ...newSetupLink(v.id) };
  }, { auth: 'owner' });

  function ownerVenue(id) {
    const v = db.prepare('SELECT * FROM venues WHERE id = ?').get(id);
    if (!v) throw new HttpError(404, 'Venue not found');
    return v;
  }

  route('POST', /^\/api\/owner\/venues\/(\d+)\/setup-link$/, ({ params }) => {
    const v = ownerVenue(params[0]);
    return { venue: venueOut(v), reset: !!v.password_hash, ...newSetupLink(v.id) };
  }, { auth: 'owner' });

  route('PUT', /^\/api\/owner\/venues\/(\d+)$/, ({ params, body }) => {
    const v = ownerVenue(params[0]);
    const name = body.name !== undefined ? str(body.name, 'Venue name', { required: true, max: 80 }) : v.name;
    const active = body.active !== undefined ? (body.active ? 1 : 0) : v.active;
    db.prepare('UPDATE venues SET name = ?, active = ? WHERE id = ?').run(name, active, v.id);
    return venueOut(ownerVenue(v.id));
  }, { auth: 'owner' });

  route('DELETE', /^\/api\/owner\/venues\/(\d+)$/, ({ params, body }) => {
    const v = ownerVenue(params[0]);
    if (str(body.confirm, 'Confirmation', { max: 80 }) !== v.slug) {
      throw new HttpError(400, `Type the venue ID "${v.slug}" to confirm.`);
    }
    db.prepare('DELETE FROM venues WHERE id = ?').run(v.id); // cascades to events, guests, contributors, activity
    return { ok: true };
  }, { auth: 'owner' });

  route('PUT', /^\/api\/owner\/requests\/(\d+)$/, ({ params, body }) => {
    const status = body.status === 'done' ? 'done' : 'new';
    const r = db.prepare('UPDATE access_requests SET status = ? WHERE id = ?').run(status, params[0]);
    if (status === 'done') db.prepare('UPDATE access_requests SET password_hash = NULL WHERE id = ?').run(params[0]);
    if (!r.changes) throw new HttpError(404, 'Request not found');
    return { ok: true };
  }, { auth: 'owner' });

  // One tap: the venue goes live with the username and password it signed up with.
  // Older requests without a password get a setup link instead.
  route('POST', /^\/api\/owner\/requests\/(\d+)\/approve$/, ({ params }) => {
    const r = db.prepare('SELECT * FROM access_requests WHERE id = ?').get(params[0]);
    if (!r) throw new HttpError(404, 'Request not found');
    if (r.status !== 'new') throw new HttpError(409, 'This request has already been dealt with.');
    let slug = r.slug;
    if (!slug || db.prepare('SELECT 1 FROM venues WHERE slug = ?').get(slug)) slug = uniqueSlug(db, slug || r.venue_name);
    const v = tx(db, () => {
      const created = createVenue({ name: r.venue_name, slug, passwordHash: r.password_hash });
      db.prepare("UPDATE access_requests SET status = 'done', password_hash = NULL WHERE id = ?").run(r.id);
      return created;
    });
    const out = { venue: venueOut(v), request: { name: r.contact_name, email: r.email }, live: !!r.password_hash };
    return r.password_hash ? out : { ...out, ...newSetupLink(v.id) };
  }, { auth: 'owner' });

  route('DELETE', /^\/api\/owner\/requests\/(\d+)$/, ({ params }) => {
    db.prepare('DELETE FROM access_requests WHERE id = ?').run(params[0]);
    return { ok: true };
  }, { auth: 'owner' });

  route('PUT', /^\/api\/owner\/settings$/, ({ body, res }) => {
    if (body.autoApprove !== undefined) setSetting(db, 'auto_approve', body.autoApprove ? '1' : '0');
    if (body.contactEmail !== undefined) {
      const email = str(body.contactEmail, 'Contact email', { max: 120 });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'That email address looks wrong');
      setSetting(db, 'contact_email', email);
    }
    if (body.newPassword) {
      if (!auth.verifyPassword(str(body.currentPassword, 'Current password', { max: 200 }), getSetting(db, 'owner_password_hash'))) {
        throw new HttpError(401, 'Current password is wrong');
      }
      setSetting(db, 'owner_password_hash', auth.hashPassword(password(body.newPassword, 'New password')));
      setSetting(db, 'owner_password_version', String(Number(getSetting(db, 'owner_password_version') || 1) + 1));
      res.setHeader('Set-Cookie', auth.ownerCookie(db, secureCookies));
    }
    return { ok: true };
  }, { auth: 'owner' });

  // Everything below is scoped to the logged-in venue: ids from another venue are "not found".
  function evt(venue, id) {
    const e = getEvent(db, id);
    if (e.venue_id !== venue.id) throw new HttpError(404, 'Event not found');
    return e;
  }

  function gst(venue, id) {
    const g = getGuest(db, id);
    if (getEvent(db, g.event_id).venue_id !== venue.id) throw new HttpError(404, 'Guest not found');
    return g;
  }

  function ctb(venue, id) {
    const c = getContributor(db, id);
    if (getEvent(db, c.event_id).venue_id !== venue.id) throw new HttpError(404, 'Contributor not found');
    return c;
  }

  // ----- events -----

  route('GET', /^\/api\/events$/, ({ venue, query }) => {
    const archived = query.get('archived') === '1' ? 1 : 0;
    const rows = db
      .prepare(
        `SELECT e.*,
           (SELECT COUNT(*) FROM guests g WHERE g.event_id = e.id) AS guest_count,
           (SELECT COALESCE(SUM(1 + plus_ones), 0) FROM guests g WHERE g.event_id = e.id) AS expected,
           (SELECT COALESCE(SUM(admitted), 0) FROM guests g WHERE g.event_id = e.id) AS admitted,
           (SELECT COUNT(*) FROM contributors c WHERE c.event_id = e.id) AS contributor_count
         FROM events e WHERE e.venue_id = ? AND e.archived = ?
         ORDER BY e.date ${archived ? 'DESC' : 'ASC'}, e.id`
      )
      .all(venue.id, archived);
    return rows.map((r) => ({
      ...eventOut(r),
      guestCount: r.guest_count,
      expected: r.expected,
      admitted: r.admitted,
      contributorCount: r.contributor_count,
    }));
  });

  route('POST', /^\/api\/events$/, ({ venue, req, body }) => {
    const actor = actorFrom(req);
    const info = db
      .prepare(
        'INSERT INTO events (venue_id, name, date, doors_time, capacity, cutoff_at, notes, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        venue.id,
        str(body.name, 'Event name', { required: true, max: 120 }),
        dateStr(body.date),
        timeStr(body.doorsTime),
        int(body.capacity, 'Capacity', { min: 1, nullable: true }),
        isoOrNull(body.cutoffAt, 'Cutoff'),
        str(body.notes, 'Notes', { max: 2000 }) || null,
        now(),
        actor
      );
    const id = Number(info.lastInsertRowid);
    log(db, { eventId: id, action: 'event.create', actor, via: 'venue' });
    return eventOut(getEvent(db, id));
  });

  route('GET', /^\/api\/events\/(\d+)$/, ({ venue, params }) => {
    const e = evt(venue, params[0]);
    const contributors = db
      .prepare('SELECT * FROM contributors WHERE event_id = ? ORDER BY name COLLATE NOCASE')
      .all(e.id)
      .map(contributorOut);
    const guests = listGuests(db, e.id);
    for (const c of contributors) {
      const mine = guests.filter((g) => g.contributorId === c.id);
      c.stats = stats(mine);
    }
    return { event: eventOut(e), contributors, guests, stats: stats(guests), listTypes: LIST_TYPES };
  });

  route('PUT', /^\/api\/events\/(\d+)$/, ({ venue, req, params, body }) => {
    const actor = actorFrom(req);
    const e = evt(venue, params[0]);
    const next = {
      name: body.name !== undefined ? str(body.name, 'Event name', { required: true, max: 120 }) : e.name,
      date: body.date !== undefined ? dateStr(body.date) : e.date,
      doors_time: body.doorsTime !== undefined ? timeStr(body.doorsTime) : e.doors_time,
      capacity: body.capacity !== undefined ? int(body.capacity, 'Capacity', { min: 1, nullable: true }) : e.capacity,
      cutoff_at: body.cutoffAt !== undefined ? isoOrNull(body.cutoffAt, 'Cutoff') : e.cutoff_at,
      notes: body.notes !== undefined ? str(body.notes, 'Notes', { max: 2000 }) || null : e.notes,
      archived: body.archived !== undefined ? (body.archived ? 1 : 0) : e.archived,
    };
    db.prepare(
      'UPDATE events SET name = ?, date = ?, doors_time = ?, capacity = ?, cutoff_at = ?, notes = ?, archived = ? WHERE id = ?'
    ).run(next.name, next.date, next.doors_time, next.capacity, next.cutoff_at, next.notes, next.archived, e.id);
    const action = next.archived !== e.archived ? (next.archived ? 'event.archive' : 'event.unarchive') : 'event.update';
    log(db, { eventId: e.id, action, actor, via: 'venue' });
    publish(e.id, 'event');
    return eventOut(getEvent(db, e.id));
  });

  route('DELETE', /^\/api\/events\/(\d+)$/, ({ venue, req, params }) => {
    actorFrom(req);
    const e = evt(venue, params[0]);
    db.prepare('DELETE FROM events WHERE id = ?').run(e.id);
    publish(e.id, 'deleted');
    return { ok: true };
  });

  route('GET', /^\/api\/events\/(\d+)\/activity$/, ({ venue, params, query }) => {
    const e = evt(venue, params[0]);
    const limit = Math.min(Number(query.get('limit')) || 200, 1000);
    return db
      .prepare('SELECT * FROM activity WHERE event_id = ? ORDER BY id DESC LIMIT ?')
      .all(e.id, limit)
      .map((a) => ({
        id: a.id,
        guestId: a.guest_id,
        guestName: a.guest_name,
        action: a.action,
        detail: a.detail,
        actor: a.actor,
        via: a.via,
        at: a.at,
      }));
  });

  route('GET', /^\/api\/events\/(\d+)\/export\.csv$/, ({ venue, params, res }) => {
    const e = evt(venue, params[0]);
    const guests = listGuests(db, e.id);
    const header = [
      'Name', 'Plus ones', 'Party', 'List', 'VIP', 'Contributor', 'Notes',
      'Admitted', 'Inside', 'First in (Melbourne)', 'Added by', 'Added via', 'Added at (Melbourne)',
    ];
    const lines = [header.join(',')];
    for (const g of guests) {
      lines.push(
        [
          g.name, g.plusOnes, g.party, g.listType, g.vip ? 'Yes' : '', g.contributorName || 'Venue', g.notes,
          g.admitted, g.inside, csvTime(g.firstInAt), g.addedBy, g.addedVia, csvTime(g.createdAt),
        ].map(csvCell).join(',')
      );
    }
    const filename = `${e.date}-${e.name}`.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}.csv"`,
      'Cache-Control': 'no-store',
    });
    res.end('﻿' + lines.join('\r\n'));
    return undefined;
  });

  route('GET', /^\/api\/events\/(\d+)\/stream$/, ({ venue, req, params, res }) => {
    const e = evt(venue, params[0]);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
    hub.add(e.id, res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => clearInterval(ping));
    return undefined;
  });

  // ----- contributors (venue side) -----

  route('POST', /^\/api\/events\/(\d+)\/contributors$/, ({ venue, req, params, body }) => {
    const actor = actorFrom(req);
    const e = evt(venue, params[0]);
    const info = db
      .prepare(
        'INSERT INTO contributors (event_id, name, list_type, allocation, token, notes, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        e.id,
        str(body.name, 'Contributor name', { required: true, max: 80 }),
        listType(body.listType),
        int(body.allocation, 'Allocation', { min: 0, nullable: true }),
        newToken(),
        str(body.notes, 'Notes', { max: 500 }) || null,
        now(),
        actor
      );
    const c = getContributor(db, Number(info.lastInsertRowid));
    log(db, { eventId: e.id, action: 'contributor.create', detail: c.name, actor, via: 'venue' });
    publish(e.id, 'contributors');
    return contributorOut(c);
  });

  route('PUT', /^\/api\/contributors\/(\d+)$/, ({ venue, req, params, body }) => {
    const actor = actorFrom(req);
    const c = ctb(venue, params[0]);
    const next = {
      name: body.name !== undefined ? str(body.name, 'Contributor name', { required: true, max: 80 }) : c.name,
      list_type: body.listType !== undefined ? listType(body.listType) : c.list_type,
      allocation:
        body.allocation !== undefined ? int(body.allocation, 'Allocation', { min: 0, nullable: true }) : c.allocation,
      active: body.active !== undefined ? (body.active ? 1 : 0) : c.active,
      notes: body.notes !== undefined ? str(body.notes, 'Notes', { max: 500 }) || null : c.notes,
    };
    db.prepare('UPDATE contributors SET name = ?, list_type = ?, allocation = ?, active = ?, notes = ? WHERE id = ?').run(
      next.name, next.list_type, next.allocation, next.active, next.notes, c.id
    );
    log(db, { eventId: c.event_id, action: 'contributor.update', detail: next.name, actor, via: 'venue' });
    publish(c.event_id, 'contributors');
    return contributorOut(getContributor(db, c.id));
  });

  route('POST', /^\/api\/contributors\/(\d+)\/regenerate$/, ({ venue, req, params }) => {
    const actor = actorFrom(req);
    const c = ctb(venue, params[0]);
    db.prepare('UPDATE contributors SET token = ? WHERE id = ?').run(newToken(), c.id);
    log(db, { eventId: c.event_id, action: 'contributor.relink', detail: c.name, actor, via: 'venue' });
    return contributorOut(getContributor(db, c.id));
  });

  route('DELETE', /^\/api\/contributors\/(\d+)$/, ({ venue, req, params }) => {
    const actor = actorFrom(req);
    const c = ctb(venue, params[0]);
    const n = db.prepare('SELECT COUNT(*) AS n FROM guests WHERE contributor_id = ?').get(c.id).n;
    if (n > 0) throw new HttpError(409, `${c.name} still has ${n} guest(s). Remove them or disable the link instead.`);
    db.prepare('DELETE FROM contributors WHERE id = ?').run(c.id);
    log(db, { eventId: c.event_id, action: 'contributor.delete', detail: c.name, actor, via: 'venue' });
    publish(c.event_id, 'contributors');
    return { ok: true };
  });

  // ----- guests (venue side) -----

  function insertGuest(e, contributor, data, actor, via) {
    const info = db
      .prepare(
        `INSERT INTO guests (event_id, contributor_id, name, plus_ones, list_type, vip, notes,
           added_by, added_via, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        e.id, contributor ? contributor.id : null, data.name, data.plusOnes, data.listType, data.vip ? 1 : 0,
        data.notes || null, actor, via, now(), now(), actor
      );
    return getGuest(db, Number(info.lastInsertRowid));
  }

  function guestInput(body, defaults = {}) {
    return {
      name: str(body.name, 'Guest name', { required: true, max: 120 }),
      plusOnes: int(body.plusOnes, 'Plus ones', { min: 0, max: 50 }),
      listType: listType(body.listType, defaults.listType || 'Guest'),
      vip: !!body.vip,
      notes: str(body.notes, 'Notes', { max: 500 }),
    };
  }

  route('POST', /^\/api\/events\/(\d+)\/guests$/, ({ venue, req, params, body }) => {
    const actor = actorFrom(req);
    const e = evt(venue, params[0]);
    const contributor = body.contributorId ? ctb(venue, body.contributorId) : null;
    if (contributor && contributor.event_id !== e.id) throw new HttpError(400, 'Contributor belongs to another event');
    const data = guestInput(body, { listType: contributor?.list_type });
    const via = body.atDoor ? 'door' : 'venue';
    const g = tx(db, () => {
      if (!body.force) {
        checkCapacity(db, e, 1 + data.plusOnes, 0);
        if (contributor) checkAllocation(db, contributor, 1 + data.plusOnes, 0);
      }
      const g = insertGuest(e, contributor, data, actor, via);
      log(db, { eventId: e.id, guest: g, action: 'guest.add', detail: data.plusOnes ? `+${data.plusOnes}` : null, actor, via });
      return g;
    });
    publish(e.id, 'guests', { actor, guestId: g.id });
    return guestOut(g);
  });

  route('POST', /^\/api\/events\/(\d+)\/guests\/import$/, ({ venue, req, params, body }) => {
    const actor = actorFrom(req);
    const e = evt(venue, params[0]);
    const contributor = body.contributorId ? ctb(venue, body.contributorId) : null;
    if (contributor && contributor.event_id !== e.id) throw new HttpError(400, 'Contributor belongs to another event');
    const rows = parseImport(body.text);
    if (!rows.length) throw new HttpError(400, 'Nothing to import');
    if (rows.length > 2000) throw new HttpError(400, 'Too many rows (max 2000)');
    const lt = listType(body.listType, contributor?.list_type || 'Guest');
    const added = tx(db, () =>
      rows.map((r) => {
        const data = guestInput({ ...r, listType: lt });
        const g = insertGuest(e, contributor, data, actor, 'venue');
        log(db, { eventId: e.id, guest: g, action: 'guest.add', detail: 'import', actor, via: 'venue' });
        return g;
      })
    );
    publish(e.id, 'guests', { actor });
    return { added: added.length };
  });

  route('PUT', /^\/api\/guests\/(\d+)$/, ({ venue, req, params, body }) => {
    const actor = actorFrom(req);
    const g = gst(venue, params[0]);
    const e = getEvent(db, g.event_id);
    const contributor =
      body.contributorId !== undefined
        ? body.contributorId
          ? ctb(venue, body.contributorId)
          : null
        : g.contributor_id
          ? getContributor(db, g.contributor_id)
          : null;
    if (contributor && contributor.event_id !== e.id) throw new HttpError(400, 'Contributor belongs to another event');
    const data = guestInput({
      name: body.name ?? g.name,
      plusOnes: body.plusOnes ?? g.plus_ones,
      listType: body.listType ?? g.list_type,
      vip: body.vip ?? !!g.vip,
      notes: body.notes ?? g.notes ?? '',
    });
    if (1 + data.plusOnes < g.admitted) {
      throw new HttpError(409, `${g.admitted} of this party have already arrived — can't reduce below that.`);
    }
    tx(db, () => {
      if (!body.force) {
        checkCapacity(db, e, 1 + data.plusOnes, g.id);
        if (contributor) checkAllocation(db, contributor, 1 + data.plusOnes, g.id);
      }
      db.prepare(
        `UPDATE guests SET contributor_id = ?, name = ?, plus_ones = ?, list_type = ?, vip = ?, notes = ?,
           updated_at = ?, updated_by = ? WHERE id = ?`
      ).run(contributor ? contributor.id : null, data.name, data.plusOnes, data.listType, data.vip ? 1 : 0,
        data.notes || null, now(), actor, g.id);
      log(db, { eventId: e.id, guest: { id: g.id, name: data.name }, action: 'guest.edit', actor, via: 'venue' });
    });
    publish(e.id, 'guests', { actor, guestId: g.id });
    return guestOut(getGuest(db, g.id));
  });

  route('DELETE', /^\/api\/guests\/(\d+)$/, ({ venue, req, params }) => {
    const actor = actorFrom(req);
    const g = gst(venue, params[0]);
    tx(db, () => {
      db.prepare('DELETE FROM guests WHERE id = ?').run(g.id);
      log(db, { eventId: g.event_id, guest: g, action: 'guest.remove', actor, via: 'venue' });
    });
    publish(g.event_id, 'guests', { actor, guestId: g.id });
    return { ok: true };
  });

  // ----- door: check in / check out -----

  function move(venue, req, params, body, direction) {
    const actor = actorFrom(req);
    const result = tx(db, () => {
      const g = gst(venue, params[0]);
      const party = 1 + g.plus_ones;
      const room = direction === 'in' ? party - g.inside : g.inside;
      if (room <= 0) {
        throw new HttpError(409, direction === 'in' ? `${g.name}'s whole party is already inside.` : `${g.name} is not inside.`);
      }
      const count = body.count === undefined || body.count === 'all' ? room : int(body.count, 'Count', { min: 1, max: 51 });
      if (count > room) {
        throw new HttpError(409, direction === 'in' ? `Only ${room} of the party can still check in.` : `Only ${room} inside.`);
      }
      const inside = direction === 'in' ? g.inside + count : g.inside - count;
      const admitted = Math.max(g.admitted, inside);
      const t = now();
      db.prepare(
        'UPDATE guests SET inside = ?, admitted = ?, first_in_at = COALESCE(first_in_at, ?), last_move_at = ?, updated_at = ?, updated_by = ? WHERE id = ?'
      ).run(inside, admitted, direction === 'in' ? t : null, t, t, actor, g.id);
      log(db, {
        eventId: g.event_id,
        guest: g,
        action: direction === 'in' ? 'guest.checkin' : 'guest.checkout',
        detail: `${count} (${inside}/${party} inside)`,
        actor,
        via: 'door',
      });
      return { g: getGuest(db, g.id), count };
    });
    const out = guestOut(result.g);
    publish(out.eventId, 'guests', {
      actor,
      guestId: out.id,
      move: direction,
      count: result.count,
      vip: out.vip,
      name: out.name,
    });
    return out;
  }

  route('POST', /^\/api\/guests\/(\d+)\/checkin$/, ({ venue, req, params, body }) => move(venue, req, params, body, 'in'));
  route('POST', /^\/api\/guests\/(\d+)\/checkout$/, ({ venue, req, params, body }) => move(venue, req, params, body, 'out'));

  // ----- contributor portal (token links, no login) -----

  function venueOfEvent(eventId) {
    return db.prepare('SELECT v.* FROM venues v JOIN events e ON e.venue_id = v.id WHERE e.id = ?').get(eventId);
  }

  function contributorByToken(token) {
    const c = db.prepare('SELECT * FROM contributors WHERE token = ?').get(token);
    if (!c) throw new HttpError(404, 'This link is not valid. Ask the venue for a new one.');
    return c;
  }

  function portalView(c) {
    const e = getEvent(db, c.event_id);
    const guests = listGuests(db, e.id, c.id).map((g) => ({
      id: g.id,
      name: g.name,
      plusOnes: g.plusOnes,
      party: g.party,
      notes: g.notes,
      admitted: g.admitted,
      addedBy: g.addedBy,
      createdAt: g.createdAt,
    }));
    const used = guests.reduce((n, g) => n + g.party, 0);
    return {
      venueName: venueOfEvent(e.id)?.name || 'Venue',
      event: { name: e.name, date: e.date, doorsTime: e.doors_time, cutoffAt: e.cutoff_at },
      contributor: { name: c.name, listType: c.list_type, allocation: c.allocation },
      used,
      remaining: c.allocation === null ? null : Math.max(0, c.allocation - used),
      locked: contributorLocked(db, c),
      guests,
    };
  }

  route('GET', /^\/api\/c\/([A-Za-z0-9_-]+)$/, ({ params }) => portalView(contributorByToken(params[0])), { auth: 'public' });

  route('POST', /^\/api\/c\/([A-Za-z0-9_-]+)\/guests$/, ({ req, params, body }) => {
    const actor = actorFrom(req);
    const c = contributorByToken(params[0]);
    const locked = contributorLocked(db, c);
    if (locked) throw new HttpError(403, locked);
    const e = getEvent(db, c.event_id);
    const data = guestInput({ name: body.name, plusOnes: body.plusOnes, notes: body.notes, listType: c.list_type });
    const g = tx(db, () => {
      checkAllocation(db, c, 1 + data.plusOnes, 0);
      checkCapacity(db, e, 1 + data.plusOnes, 0);
      const g = insertGuest(e, c, data, actor, 'contributor');
      log(db, { eventId: e.id, guest: g, action: 'guest.add', detail: data.plusOnes ? `+${data.plusOnes}` : null, actor, via: c.name });
      return g;
    });
    publish(e.id, 'guests', { actor, guestId: g.id });
    return portalView(c);
  }, { auth: 'public' });

  function portalGuest(c, gid) {
    const g = getGuest(db, gid);
    if (g.contributor_id !== c.id) throw new HttpError(404, 'Guest not found');
    return g;
  }

  route('PUT', /^\/api\/c\/([A-Za-z0-9_-]+)\/guests\/(\d+)$/, ({ req, params, body }) => {
    const actor = actorFrom(req);
    const c = contributorByToken(params[0]);
    const locked = contributorLocked(db, c);
    if (locked) throw new HttpError(403, locked);
    const g = portalGuest(c, params[1]);
    if (g.admitted > 0) throw new HttpError(409, 'This guest has already arrived and can no longer be edited.');
    const data = guestInput({
      name: body.name ?? g.name,
      plusOnes: body.plusOnes ?? g.plus_ones,
      notes: body.notes ?? g.notes ?? '',
      listType: g.list_type,
    });
    tx(db, () => {
      checkAllocation(db, c, 1 + data.plusOnes, g.id);
      checkCapacity(db, getEvent(db, c.event_id), 1 + data.plusOnes, g.id);
      db.prepare('UPDATE guests SET name = ?, plus_ones = ?, notes = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(
        data.name, data.plusOnes, data.notes || null, now(), actor, g.id
      );
      log(db, { eventId: c.event_id, guest: { id: g.id, name: data.name }, action: 'guest.edit', actor, via: c.name });
    });
    publish(c.event_id, 'guests', { actor, guestId: g.id });
    return portalView(c);
  }, { auth: 'public' });

  route('DELETE', /^\/api\/c\/([A-Za-z0-9_-]+)\/guests\/(\d+)$/, ({ req, params }) => {
    const actor = actorFrom(req);
    const c = contributorByToken(params[0]);
    const locked = contributorLocked(db, c);
    if (locked) throw new HttpError(403, locked);
    const g = portalGuest(c, params[1]);
    if (g.admitted > 0) throw new HttpError(409, 'This guest has already arrived and can no longer be removed.');
    tx(db, () => {
      db.prepare('DELETE FROM guests WHERE id = ?').run(g.id);
      log(db, { eventId: c.event_id, guest: g, action: 'guest.remove', actor, via: c.name });
    });
    publish(c.event_id, 'guests', { actor, guestId: g.id });
    return portalView(c);
  }, { auth: 'public' });

  // ----- dispatcher -----

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/') && pathname !== '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, pathname);
    }

    try {
      const r = routes.find((x) => x.method === req.method && x.pattern.test(pathname));
      if (!r) throw new HttpError(404, 'Not found');
      let venue = null;
      const mode = r.auth || 'venue';
      if (mode === 'venue') {
        venue = sessionVenue(req);
        if (!venue) throw new HttpError(401, 'Please log in');
      } else if (mode === 'owner') {
        if (!auth.isOwner(db, req)) throw new HttpError(401, 'Please log in');
      }
      // Mutations must be JSON: blocks cross-site form posts (CSRF) alongside SameSite cookies.
      if (req.method !== 'GET' && !(req.headers['content-type'] || '').includes('application/json')) {
        throw new HttpError(415, 'Expected application/json');
      }
      const params = pathname.match(r.pattern).slice(1);
      const body = req.method === 'GET' ? {} : await readJson(req);
      const result = await r.handler({ venue, req, res, params, body, query: url.searchParams });
      if (result !== undefined && !res.headersSent) send(res, 200, result);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      if (res.headersSent) return res.end();
      const status = err instanceof HttpError ? err.status : 500;
      send(res, status, { error: status === 500 ? 'Something went wrong' : err.message });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  server.on('close', () => hub.closeAll());
  return server;
}

module.exports = { createApp, parseImport, LIST_TYPES };
