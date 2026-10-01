'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getSetting, setSetting, tx, slugify, uniqueSlug } = require('./db');
const auth = require('./auth');
const { loadMailConfig, sendMail } = require('./mail');
const { backupNow, scheduleBackups } = require('./backup');
const { loadOffsiteConfig, uploadBackup } = require('./offsite');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const LIST_TYPES = ['Guest', 'Artist', 'Crew', 'Industry', 'Media', 'Venue', 'Door'];

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code; // e.g. 'override' → the client asks for the manager PIN
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
    venueCapacity: e.venue_capacity ?? null,
    countGuestlist: !!e.count_guestlist,
    headcount: headcountOut(e),
    ticketsSold: e.tickets_sold ?? null,
    ticketsScanned: e.tickets_scanned ?? null,
    externalId: e.external_id ?? null,
    removedByRiderly: !!e.removed_by_riderly,
    over: showIsOver(e.date),
  };
}

function headcountOut(e) {
  return {
    count: e.head_count || 0,
    capacity: e.venue_capacity ?? null,
    peak: e.head_peak || 0,
    totalIn: e.head_in || 0,
    totalOut: e.head_out || 0,
  };
}

// Moves the shared door count by delta (never below 0) and logs it. Call inside a transaction.
function bumpHeadcount(db, eventId, delta, source, actor) {
  const e = db.prepare('SELECT head_count FROM events WHERE id = ?').get(eventId);
  const after = Math.max(0, (e.head_count || 0) + delta);
  const applied = after - (e.head_count || 0);
  if (!applied) return 0;
  db.prepare(
    `UPDATE events SET head_count = ?, head_peak = MAX(head_peak, ?),
       head_in = head_in + ?, head_out = head_out + ? WHERE id = ?`
  ).run(after, after, Math.max(0, applied), Math.max(0, -applied), eventId);
  db.prepare('INSERT INTO headcount_log (event_id, delta, count_after, source, actor, at) VALUES (?, ?, ?, ?, ?, ?)').run(
    eventId, applied, after, source, actor, new Date().toISOString()
  );
  return applied;
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
    lastInBy: g.last_in_by || null, // who last checked them in at the door, and when
    lastInAt: g.last_in_at || null,
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
    SELECT g.*, c.name AS contributor_name, li.actor AS last_in_by, li.at AS last_in_at
    FROM guests g LEFT JOIN contributors c ON c.id = g.contributor_id
    LEFT JOIN activity li ON li.id = (
      SELECT a.id FROM activity a WHERE a.guest_id = g.id AND a.action = 'guest.checkin' ORDER BY a.id DESC LIMIT 1
    )
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

// The venue's "day": Melbourne date, rolling over at 6am, so tonight's show is still tonight's
// at 1am. A show is over once the venue day is past its date.
const VENUE_TZ = process.env.DISPLAY_TZ || 'Australia/Melbourne';
const venueDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: VENUE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function venueDay(at = Date.now()) {
  return venueDayFmt.format(new Date(at - 6 * 3600 * 1000));
}
const showIsOver = (date, at) => !!date && date < venueDay(at);

function contributorLocked(db, contributor) {
  const e = getEvent(db, contributor.event_id);
  const venue = db.prepare('SELECT active FROM venues WHERE id = ?').get(e.venue_id);
  if (!venue || !venue.active) return 'This venue’s guest list is currently unavailable.';
  if (e.archived) return 'This event has been archived.';
  if (!contributor.active) return 'This link has been disabled by the venue.';
  if (e.cutoff_at && Date.now() > Date.parse(e.cutoff_at)) return 'The guest list cutoff for this event has passed.';
  if (showIsOver(e.date)) return 'This show has finished, so its guest list is closed.';
  return null;
}

function checkAllocation(db, contributor, party, excludeGuestId) {
  if (contributor.allocation === null || contributor.allocation === undefined) return;
  const used = headsFor(db, contributor.id, excludeGuestId);
  if (used + party > contributor.allocation) {
    const left = Math.max(0, contributor.allocation - used);
    throw Object.assign(new HttpError(409, `Allocation exceeded — ${left} spot${left === 1 ? '' : 's'} left of ${contributor.allocation}.`), { rule: true });
  }
}

function checkCapacity(db, event, party, excludeGuestId) {
  if (!event.capacity) return;
  const used = eventHeads(db, event.id, excludeGuestId);
  if (used + party > event.capacity) {
    throw Object.assign(new HttpError(409, `Event guest list is full (${used}/${event.capacity} heads).`), { rule: true });
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
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

// Public marketing pages search engines may index; everything else stays out of Google.
const INDEXABLE = new Set(['index.html', 'guide.html', 'privacy.html', 'terms.html']);
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://guestlist.riderly.com.au').replace(/\/+$/, '');

function serveStatic(req, res, pathname) {
  if (pathname === '/robots.txt') {
    return send(res, 200, [
      'User-agent: *',
      'Allow: /$',
      'Allow: /guide',
      'Allow: /privacy',
      'Allow: /terms',
      'Allow: /img/',
      'Allow: /css/',
      'Disallow: /',
      `Sitemap: ${PUBLIC_URL}/sitemap.xml`,
      '',
    ].join('\n'), { 'Cache-Control': 'public, max-age=3600' });
  }
  if (pathname === '/sitemap.xml') {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${PUBLIC_URL}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${PUBLIC_URL}/guide</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>
  <url><loc>${PUBLIC_URL}/privacy</loc><changefreq>yearly</changefreq><priority>0.3</priority></url>
  <url><loc>${PUBLIC_URL}/terms</loc><changefreq>yearly</changefreq><priority>0.3</priority></url>
</urlset>
`;
    return send(res, 200, xml, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  }
  let file;
  if (pathname === '/' || pathname === '/index.html') file = 'index.html'; // public landing page
  else if (pathname === '/app' || pathname === '/app/') file = 'app.html'; // venue app
  else if (pathname === '/login' || /^\/v\/[A-Za-z0-9_-]+\/?$/.test(pathname)) file = 'login.html';
  else if (/^\/v\/[A-Za-z0-9_-]+\/admin\/?$/.test(pathname)) file = 'venue-admin.html';
  else if (/^\/venue-admin\/reset\/[A-Za-z0-9_-]+\/?$/.test(pathname)) file = 'venue-admin-reset.html';
  else if (/^\/setup\/[A-Za-z0-9_-]+\/?$/.test(pathname)) file = 'setup.html';
  else if (pathname === '/admin' || pathname === '/admin/') file = 'admin.html';
  else if (pathname === '/guide' || pathname === '/guide/') file = 'guide.html';
  else if (pathname === '/privacy' || pathname === '/privacy/') file = 'privacy.html';
  else if (pathname === '/terms' || pathname === '/terms/') file = 'terms.html';
  else if (/^\/c\/[A-Za-z0-9_-]+\/?$/.test(pathname)) file = 'contributor.html';
  else file = pathname.replace(/^\/+/, '');

  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': file.endsWith('.html') || file === 'sw.js' ? 'no-cache' : 'public, max-age=300',
      ...SECURITY_HEADERS,
      ...(file.endsWith('.html') && !INDEXABLE.has(file) ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
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
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, ...opts });


  const SETUP_LINK_DAYS = 7;
  const DUMMY_HASH = auth.hashPassword(crypto.randomBytes(8).toString('hex'));
  const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

  function publish(eventId, type, extra = {}) {
    hub.publish(eventId, { type, at: now(), ...extra });
  }

  // Overrides are protected once a venue has an admin password or any active manager code.
  function canOverride(v) {
    return !!v.admin_password_hash || !!db.prepare('SELECT 1 FROM manager_codes WHERE venue_id = ? AND active = 1').get(v.id);
  }

  function venueOut(v) {
    return {
      id: v.id,
      slug: v.slug,
      name: v.name,
      hasManagerPin: canOverride(v),
      hasAdmin: !!v.admin_password_hash,
      defaults: { capacity: v.default_capacity ?? null, countGuestlist: !!v.default_count_guestlist },
    };
  }

  function password(v, field = 'Password') {
    const p = str(v, field, { required: true, max: 200 });
    if (p.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    return p;
  }

  // ----- email (optional: switched on by a mail.json file on the server) -----

  const mailConfig = () => (options.mailConfigFile ? loadMailConfig(options.mailConfigFile) : null);
  const mailLog = options.mailLog || console;

  // Sends an email if email is set up; never throws. Resolves true when sent.
  async function mail(msg) {
    const cfg = mailConfig();
    if (!cfg || !msg.to) return false;
    try {
      await sendMail(cfg, { ...msg, to: msg.to === 'owner' ? cfg.notify : msg.to });
      return true;
    } catch (err) {
      mailLog.error(`Email to ${msg.to} failed: ${err.message}`);
      return false;
    }
  }

  // ----- backups: nightly local snapshot, plus an encrypted copy off the droplet when backup.json exists -----

  const backupOpts = options.backup || null; // { dir, keepDays, configFile, schedule }
  const offsiteConfig = () => (backupOpts && backupOpts.configFile ? loadOffsiteConfig(backupOpts.configFile) : null);
  let backupRunning = null;

  function runBackup() {
    if (!backupOpts) return Promise.reject(new HttpError(400, 'Backups are switched off on this server.'));
    if (backupRunning) return backupRunning; // a second tap waits for the same run
    backupRunning = (async () => {
      const at = new Date();
      setSetting(db, 'backup_last_attempt_at', at.toISOString());
      const out = { at: at.toISOString(), local: null, offsite: null };
      try {
        const file = backupNow(db, backupOpts.dir, backupOpts.keepDays || 30, at);
        setSetting(db, 'backup_last_ok_at', at.toISOString());
        setSetting(db, 'backup_last_error', '');
        out.local = { ok: true, file: path.basename(file) };
        const cfg = offsiteConfig();
        if (cfg) {
          try {
            const r = await uploadBackup(cfg, file, at);
            setSetting(db, 'offsite_last_ok_at', at.toISOString());
            setSetting(db, 'offsite_last_error', '');
            out.offsite = { ok: true, keys: r.keys, bytes: r.bytes };
          } catch (err) {
            setSetting(db, 'offsite_last_error', `${at.toISOString()} ${err.message}`);
            out.offsite = { ok: false, error: err.message };
            mailLog.error(`Off-site backup failed: ${err.message}`);
          }
        }
      } catch (err) {
        setSetting(db, 'backup_last_error', `${at.toISOString()} ${err.message}`);
        out.local = { ok: false, error: err.message };
        mailLog.error(`Backup failed: ${err.message}`);
      }
      const failed = (out.local && !out.local.ok) || (out.offsite && !out.offsite.ok);
      // Tell the owner, at most once a day, so a broken backup doesn't go unnoticed.
      const lastAlert = Date.parse(getSetting(db, 'backup_alert_at') || '') || 0;
      if (failed && Date.now() - lastAlert > 20 * 3600 * 1000) {
        setSetting(db, 'backup_alert_at', at.toISOString());
        mail({
          to: 'owner',
          subject: 'Riderly Guest List — backup failed',
          text: `Last night's backup didn't fully work.\n\n${out.local && out.local.ok ? '' : `Local copy: ${out.local.error}\n`}${out.offsite && !out.offsite.ok ? `Off-site copy: ${out.offsite.error}\n` : ''}\nIt retries every hour. Check the Backups card: ${PUBLIC_URL}/admin`,
        });
      }
      return out;
    })().finally(() => {
      backupRunning = null;
    });
    return backupRunning;
  }

  // Due when the last try was 23h+ ago, or an hour after a failed try.
  function backupDue() {
    const last = Date.parse(getSetting(db, 'backup_last_attempt_at') || '') || 0;
    const since = Date.now() - last;
    const localOk = !getSetting(db, 'backup_last_error');
    const offsiteOk = !offsiteConfig() || !getSetting(db, 'offsite_last_error');
    return since > 23 * 3600 * 1000 || ((!localOk || !offsiteOk) && since > 3600 * 1000);
  }

  function backupStatus() {
    const cfg = offsiteConfig();
    const err = (k) => {
      const v = getSetting(db, k) || '';
      if (!v) return null;
      const i = v.indexOf(' ');
      return { at: v.slice(0, i), message: v.slice(i + 1) };
    };
    return {
      enabled: !!backupOpts,
      keepDays: backupOpts ? backupOpts.keepDays || 30 : null,
      lastOkAt: getSetting(db, 'backup_last_ok_at') || null,
      lastError: err('backup_last_error'),
      offsite: {
        configured: !!cfg,
        bucket: cfg ? cfg.bucket : null,
        region: cfg ? cfg.region : null,
        lastOkAt: getSetting(db, 'offsite_last_ok_at') || null,
        lastError: err('offsite_last_error'),
      },
    };
  }

  function managerPin(v, field = 'Manager override PIN') {
    const p = str(v, field, { required: true, max: 100 });
    if (p.length < 4) throw new HttpError(400, `${field} must be at least 4 characters`);
    return p;
  }

  // Wrong-attempt limits are per phone (10 per 10 min) with a generous ceiling per network
  // (60 per 10 min), so one person's typos can't lock out a whole venue sharing one Wi-Fi.
  const deviceLimiter = auth.createLimiter({ max: 10, windowMs: 10 * 60 * 1000 });
  const networkLimiter = auth.createLimiter({ max: 60, windowMs: 10 * 60 * 1000 });

  function deviceId(req) {
    const d = String(req.headers['x-device'] || '');
    return /^[A-Za-z0-9_-]{8,64}$/.test(d) ? d : 'none';
  }

  function attemptKeys(req, scope) {
    const ip = clientIp(req);
    return [`${scope}|${ip}|${deviceId(req)}`, `${scope}|${ip}`];
  }

  function tooMany(req, scope) {
    const [dev, net] = attemptKeys(req, scope);
    return deviceLimiter.blocked(dev) || networkLimiter.blocked(net);
  }

  function recordFail(req, scope) {
    const [dev, net] = attemptKeys(req, scope);
    deviceLimiter.fail(dev);
    networkLimiter.fail(net);
  }

  function limit(req) {
    if (tooMany(req, 'login')) throw new HttpError(429, 'Too many wrong attempts on this phone. Try again in a few minutes.');
  }

  function failed(req) {
    recordFail(req, 'login');
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
  const RESERVED = new Set(['admin', 'login', 'app', 'setup', 'guide', 'api', 'health', 'riderly', 'owner', 'venue', 'privacy', 'terms']);
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

  function createVenue({ name, slug, passwordHash, adminHash, email }) {
    const t = now();
    const info = db
      .prepare('INSERT INTO venues (slug, name, password_hash, admin_password_hash, email, created_at, setup_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(slug, name, passwordHash || null, adminHash || null, email || null, t, passwordHash ? t : null);
    return db.prepare('SELECT * FROM venues WHERE id = ?').get(Number(info.lastInsertRowid));
  }

  // Public sign-up on the landing page. Normally lands in the owner's /admin inbox for
  // one-tap approval; with auto-approve on, the venue is live immediately.
  const signupLimiter = auth.createLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
  // Applications from the home page. Riderly is paid, so venues apply and Riderly approves;
  // the approval email carries a setup link where the venue picks its username and passwords.
  const SHOWS_PER_MONTH = ['1–4', '5–10', '11–20', '20+'];
  const TICKETING = ['Moshtix', 'Oztix', 'Humanitix', 'Eventbrite', 'Ticketek', 'Other', 'Door sales only'];

  async function sendSetupEmail(v, contactName, setupPath) {
    return mail({
      to: v.email,
      subject: `Set up ${v.name} on Riderly Guest List`,
      text: [
        `Hi ${String(contactName || '').split(' ')[0] || 'there'},`,
        '',
        `${v.name} is approved for Riderly Guest List. Finish setting up here (about two minutes):`,
        '',
        `${PUBLIC_URL}${setupPath}`,
        '',
        'You’ll choose your venue’s username, a staff password your team shares, and a venue admin password just for you.',
        `The link works once and expires in ${SETUP_LINK_DAYS} days.`,
        '',
        `How it all works: ${PUBLIC_URL}/guide`,
        '',
        '— Riderly',
      ].join('\n'),
    });
  }

  function apply({ req, body }) {
    const ip = clientIp(req);
    if (signupLimiter.blocked(ip)) throw new HttpError(429, 'Too many applications from here. Try again in an hour.');
    if (body.website) return { status: 'pending' }; // honeypot field: bots fill it, people never see it
    const venueName = str(body.venueName, 'Venue name', { required: true, max: 120 });
    const contact = str(body.name, 'Your name', { required: true, max: 80 });
    const email = str(body.email, 'Email', { required: true, max: 120 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'That email address looks wrong');
    const phone = str(body.phone, 'Phone', { max: 40 }) || null;
    const suburb = str(body.suburb, 'Suburb', { max: 80 }) || null;
    const shows = SHOWS_PER_MONTH.includes(body.showsPerMonth) ? body.showsPerMonth : null;
    const capacity = int(body.capacity, 'Capacity', { min: 1, max: 100000, nullable: true });
    const ticketing = TICKETING.includes(body.ticketing) ? body.ticketing : null;
    const message = str(body.message, 'Message', { max: 1000 }) || null;
    const pending = db.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE status = 'new'").get().n;
    if (pending >= 200) throw new HttpError(503, 'We’re catching up on applications. Please try again later.');
    signupLimiter.fail(ip); // counts every successful submission

    const autoApprove = getSetting(db, 'auto_approve') === '1';
    const info = db.prepare(
      `INSERT INTO access_requests (venue_name, contact_name, email, phone, message, suburb, shows_per_month, capacity, ticketing, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`
    ).run(venueName, contact, email, phone, message, suburb, shows, capacity, ticketing, now());
    mail({
      to: 'owner',
      replyTo: email,
      subject: `New application: ${venueName}`,
      text: [
        `${venueName}${suburb ? ` (${suburb})` : ''} applied for Riderly Guest List.`,
        '',
        `Contact:    ${contact}`,
        `Email:      ${email}`,
        phone ? `Phone:      ${phone}` : null,
        shows ? `Shows:      ${shows} a month` : null,
        capacity ? `Capacity:   ${capacity}` : null,
        ticketing ? `Ticketing:  ${ticketing}` : null,
        message ? `\nMessage:\n${message}` : null,
        '',
        autoApprove ? `Auto-approve is on, so they've been sent a setup link: ${PUBLIC_URL}/admin` : `Review it: ${PUBLIC_URL}/admin`,
      ].filter((x) => x !== null).join('\n'),
    });
    if (autoApprove) approveRequest(Number(info.lastInsertRowid)).catch((err) => mailLog.error(`Auto-approve failed: ${err.message}`));
    return { status: 'pending' };
  }
  route('POST', /^\/api\/apply$/, apply, { auth: 'public' });
  route('POST', /^\/api\/signup$/, apply, { auth: 'public' }); // older pages still post here

  // "Forgot password?" — emails a reset link to the venue's contact email (the GM/owner).
  // Always answers the same way so it can't be used to find out which venues exist.
  route('POST', /^\/api\/forgot$/, async ({ req, body }) => {
    if (tooMany(req, 'forgot')) throw new HttpError(429, 'Too many requests. Try again in a few minutes.');
    recordFail(req, 'forgot');
    const kind = body.kind === 'admin' ? 'admin' : 'staff';
    const raw = str(body.username, 'Username', { required: true, max: 200 }).replace(/^.*\/v\//, '').replace(/[/?#].*$/, '');
    const v = db.prepare('SELECT * FROM venues WHERE slug = ?').get(slugify(raw));
    const reply = { ok: true, message: 'If that venue has an email on file, we’ve sent it a reset link.' };
    if (!v || !v.active || !v.email || !v.password_hash || !mailConfig()) return reply;
    if (kind === 'admin') {
      const token = crypto.randomBytes(24).toString('base64url');
      db.prepare('UPDATE venues SET admin_token_hash = ?, admin_token_expires = ? WHERE id = ?').run(
        sha256(token), new Date(Date.now() + 24 * 3600 * 1000).toISOString(), v.id
      );
      await mail({
        to: v.email,
        subject: `Reset your venue admin password — ${v.name}`,
        text: `Someone asked to reset the venue admin password for ${v.name} on Riderly Guest List.\n\nChoose a new one here (works once, for 24 hours):\n${PUBLIC_URL}/venue-admin/reset/${token}\n\nIf that wasn't you, ignore this email — your current password still works.`,
      });
    } else {
      const { setupPath } = newSetupLink(v.id);
      await mail({
        to: v.email,
        subject: `Reset the staff password — ${v.name}`,
        text: `Someone asked to reset the staff password for ${v.name} on Riderly Guest List.\n\nChoose a new staff password here (works once, for 7 days):\n${PUBLIC_URL}${setupPath}\n\nWhen it's used, every staff phone is logged out and needs the new password. If that wasn't your team, ignore this email — nothing changes.`,
      });
    }
    return reply;
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
    return { venue: venueOut(v), reset: !!v.password_hash, needsAdmin: !v.admin_password_hash, canChooseUsername: !v.password_hash };
  }, { auth: 'public' });

  route('POST', /^\/api\/setup\/([A-Za-z0-9_-]+)$/, ({ req, params, body, res }) => {
    limit(req);
    const v = venueBySetupToken(params[0]);
    const staffPw = password(body.password);
    // Whoever sets the venue up also sets the venue admin password, so staff can never claim it first.
    let adminHash = v.admin_password_hash;
    if (!adminHash) {
      const adminPw = password(body.adminPassword, 'Venue admin password');
      if (adminPw === staffPw) throw new HttpError(400, 'The venue admin password must be different from the staff password.');
      adminHash = auth.hashPassword(adminPw);
    }
    // A brand-new venue picks its own username (Riderly suggested one from the venue name).
    let slug = v.slug;
    if (!v.password_hash && body.username !== undefined) {
      slug = usernameFrom(body.username);
      if (slug !== v.slug && usernameTaken(slug)) throw new HttpError(409, `Username "${slug}" is taken. Try another.`);
    }
    const version = v.password_hash ? v.password_version + 1 : v.password_version; // a reset logs out old devices
    const t = now();
    if (slug !== v.slug) db.prepare('UPDATE venues SET slug = ? WHERE id = ?').run(slug, v.id);
    db.prepare(
      `UPDATE venues SET password_hash = ?, password_version = ?, admin_password_hash = ?, setup_token_hash = NULL,
         setup_expires_at = NULL, setup_at = COALESCE(setup_at, ?), last_login_at = ? WHERE id = ?`
    ).run(auth.hashPassword(staffPw), version, adminHash, t, t, v.id);
    const fresh = db.prepare('SELECT * FROM venues WHERE id = ?').get(v.id);
    res.setHeader('Set-Cookie', auth.venueCookie(db, fresh, secureCookies));
    return { ok: true, venue: venueOut(fresh) };
  }, { auth: 'public' });

  // ----- venue admin password reset link (sent by the owner) -----

  function venueByAdminToken(token) {
    const v = db.prepare('SELECT * FROM venues WHERE admin_token_hash = ?').get(sha256(token));
    if (!v || !v.admin_token_expires || Date.parse(v.admin_token_expires) < Date.now()) {
      throw new HttpError(404, 'This reset link has expired or already been used. Ask Riderly for a new one.');
    }
    if (!v.active) throw new HttpError(403, 'This venue has been disabled.');
    return v;
  }

  route('GET', /^\/api\/venue-admin\/reset\/([A-Za-z0-9_-]+)$/, ({ params }) => ({ venue: venueOut(venueByAdminToken(params[0])) }), { auth: 'public' });

  route('POST', /^\/api\/venue-admin\/reset\/([A-Za-z0-9_-]+)$/, ({ req, params, body, res }) => {
    limit(req);
    const v = venueByAdminToken(params[0]);
    const pw = password(body.password, 'Venue admin password');
    db.prepare(
      'UPDATE venues SET admin_password_hash = ?, admin_version = admin_version + 1, admin_token_hash = NULL, admin_token_expires = NULL WHERE id = ?'
    ).run(auth.hashPassword(pw), v.id);
    const fresh = db.prepare('SELECT * FROM venues WHERE id = ?').get(v.id);
    res.setHeader('Set-Cookie', auth.vadminCookie(db, fresh, secureCookies));
    return { ok: true, venue: venueOut(fresh) };
  }, { auth: 'public' });

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
        suburb: r.suburb,
        showsPerMonth: r.shows_per_month,
        capacity: r.capacity,
        ticketing: r.ticketing,
        status: r.status,
        createdAt: r.created_at,
      }));
    return {
      contactEmail: getSetting(db, 'contact_email') || '',
      autoApprove: getSetting(db, 'auto_approve') === '1',
      mail: mailConfig() ? { configured: true, notify: mailConfig().notify } : { configured: false },
      backup: backupStatus(),
      requests,
      venues: rows.map((v) => ({
        ...venueOut(v),
        status: !v.active ? 'disabled' : v.password_hash ? 'active' : 'pending',
        hasManagerPin: canOverride(v),
        hasAdmin: !!v.admin_password_hash,
        riderlyConnected: !!v.api_key_hash,
        email: v.email,
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
    const email = str(body.email, 'Email', { max: 120 });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'That email address looks wrong');
    const v = createVenue({ name, slug, email });
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

  // Owner sets a new staff password directly (e.g. over the phone). Logs out every device.
  route('PUT', /^\/api\/owner\/venues\/(\d+)\/password$/, ({ params, body }) => {
    const v = ownerVenue(params[0]);
    const hash = auth.hashPassword(password(body.password, 'New password'));
    db.prepare(
      `UPDATE venues SET password_hash = ?, password_version = password_version + 1, setup_token_hash = NULL,
         setup_expires_at = NULL, setup_at = COALESCE(setup_at, ?) WHERE id = ?`
    ).run(hash, now(), v.id);
    return { ok: true, venue: venueOut(ownerVenue(v.id)) };
  }, { auth: 'owner' });

  // Owner sets a new venue admin password directly. Logs out the venue admin portal only.
  route('PUT', /^\/api\/owner\/venues\/(\d+)\/admin-password$/, ({ params, body }) => {
    const v = ownerVenue(params[0]);
    db.prepare(
      'UPDATE venues SET admin_password_hash = ?, admin_version = admin_version + 1, admin_token_hash = NULL, admin_token_expires = NULL WHERE id = ?'
    ).run(auth.hashPassword(password(body.password, 'New venue admin password')), v.id);
    return { ok: true, venue: venueOut(ownerVenue(v.id)) };
  }, { auth: 'owner' });

  // Forgotten venue admin password: a one-time link (24 h). The old one keeps working until it's used.
  route('POST', /^\/api\/owner\/venues\/(\d+)\/admin-link$/, ({ params }) => {
    const v = ownerVenue(params[0]);
    const token = crypto.randomBytes(24).toString('base64url');
    const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    db.prepare('UPDATE venues SET admin_token_hash = ?, admin_token_expires = ? WHERE id = ?').run(sha256(token), expires, v.id);
    return { venue: venueOut(v), adminPath: `/venue-admin/reset/${token}`, expiresAt: expires };
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
    if (status === 'done') db.prepare('UPDATE access_requests SET password_hash = NULL, pin_hash = NULL, admin_hash = NULL WHERE id = ?').run(params[0]);
    if (!r.changes) throw new HttpError(404, 'Request not found');
    return { ok: true };
  }, { auth: 'owner' });

  // Approving creates the venue and sends its setup link. (Requests from the old sign-up form
  // already carry a username and passwords, so those go live straight away.)
  async function approveRequest(id) {
    const r = db.prepare('SELECT * FROM access_requests WHERE id = ?').get(id);
    if (!r) throw new HttpError(404, 'Request not found');
    if (r.status !== 'new') throw new HttpError(409, 'This request has already been dealt with.');
    let slug = r.slug;
    if (!slug || db.prepare('SELECT 1 FROM venues WHERE slug = ?').get(slug)) slug = uniqueSlug(db, slug || r.venue_name);
    const v = tx(db, () => {
      const created = createVenue({ name: r.venue_name, slug, passwordHash: r.password_hash, adminHash: r.admin_hash, email: r.email });
      if (r.pin_hash) {
        db.prepare("INSERT INTO manager_codes (venue_id, name, code_hash, created_at) VALUES (?, 'Manager', ?, ?)").run(created.id, r.pin_hash, now());
      }
      if (r.capacity) db.prepare('UPDATE venues SET default_capacity = ? WHERE id = ?').run(r.capacity, created.id);
      db.prepare("UPDATE access_requests SET status = 'done', password_hash = NULL, pin_hash = NULL, admin_hash = NULL WHERE id = ?").run(r.id);
      return created;
    });
    const out = { venue: venueOut(v), request: { name: r.contact_name, email: r.email }, live: !!r.password_hash };
    if (!r.password_hash) {
      const link = newSetupLink(v.id);
      return { ...out, ...link, emailed: await sendSetupEmail(v, r.contact_name, link.setupPath) };
    }
    out.emailed = await mail({
      to: r.email,
      subject: `${v.name} is live on Riderly Guest List`,
      text: [
        `Hi ${r.contact_name.split(' ')[0]},`,
        '',
        `${v.name} is now live on Riderly Guest List. Log in with the username and passwords you chose:`,
        `${PUBLIC_URL}/v/${v.slug}`,
        '',
        `How it all works: ${PUBLIC_URL}/guide`,
        '',
        '— Riderly',
      ].join('\n'),
    });
    return out;
  }

  route('POST', /^\/api\/owner\/requests\/(\d+)\/approve$/, ({ params }) => approveRequest(Number(params[0])), { auth: 'owner' });

  route('DELETE', /^\/api\/owner\/requests\/(\d+)$/, ({ params }) => {
    db.prepare('DELETE FROM access_requests WHERE id = ?').run(params[0]);
    return { ok: true };
  }, { auth: 'owner' });

  route('POST', /^\/api\/owner\/test-email$/, async () => {
    const cfg = mailConfig();
    if (!cfg) throw new HttpError(400, 'Email isn’t set up on the server yet.');
    try {
      await sendMail(cfg, {
        to: cfg.notify,
        subject: 'Riderly Guest List — test email',
        text: `Email is working. Sign-up alerts will come to this address.\n\n${PUBLIC_URL}/admin`,
      });
    } catch (err) {
      throw new HttpError(502, err.message);
    }
    return { ok: true, to: cfg.notify };
  }, { auth: 'owner' });

  route('POST', /^\/api\/owner\/backup-now$/, async () => {
    const out = await runBackup();
    return { ...out, backup: backupStatus() };
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

  // ----- manager override -----
  // Breaking a rule (over capacity, over an allocation) or changing one needs the venue's
  // manager PIN. Before a venue has set a PIN: breaking a rule needs an explicit "are you
  // sure" (force), and changing rules is allowed (soft).
  // Which manager (or the venue admin) this code belongs to, or null.
  function matchOverride(venue, given) {
    if (!given) return null;
    const code = given.slice(0, 100);
    if (venue.admin_password_hash && auth.verifyPassword(code, venue.admin_password_hash)) return 'Venue admin';
    for (const c of db.prepare('SELECT id, name, code_hash FROM manager_codes WHERE venue_id = ? AND active = 1').all(venue.id)) {
      if (auth.verifyPassword(code, c.code_hash)) {
        db.prepare('UPDATE manager_codes SET last_used_at = ? WHERE id = ?').run(now(), c.id);
        return c.name;
      }
    }
    return null;
  }

  // Returns the approver's name (or null when no approval was needed).
  function override(venue, req, body, reason, { eventId, actor, soft = false } = {}) {
    if (!canOverride(venue)) {
      if (soft) return null;
      if (!body.force) throw new HttpError(409, reason, 'confirm');
      if (eventId) log(db, { eventId, action: 'override', detail: `${reason} (confirmed — no manager codes set)`, actor, via: 'venue' });
      return null;
    }
    const given = body.overridePin === undefined || body.overridePin === null ? '' : String(body.overridePin);
    if (!given) throw new HttpError(403, reason, 'override');
    if (tooMany(req, `pin:${venue.id}`)) throw new HttpError(429, 'Too many wrong codes on this phone. Try again in a few minutes.');
    const approver = matchOverride(venue, given);
    if (!approver) {
      recordFail(req, `pin:${venue.id}`);
      throw new HttpError(403, `Wrong manager code. ${reason}`, 'override');
    }
    if (eventId) log(db, { eventId, action: 'override', detail: `${reason} — approved by ${approver}`, actor, via: 'manager code' });
    return approver;
  }

  // Runs a rule check; if it fails, the manager override decides.
  function ruled(venue, req, body, ctx, check) {
    try {
      check();
    } catch (err) {
      if (!(err instanceof HttpError && err.rule)) throw err;
      override(venue, req, body, err.message, ctx);
    }
  }

  function checkVenueCapacity(e, adding) {
    if (!e.venue_capacity || adding <= 0) return;
    const after = (e.head_count || 0) + adding;
    if (after > e.venue_capacity) {
      throw Object.assign(new HttpError(409, `Over venue capacity: ${after} / ${e.venue_capacity}.`), { rule: true });
    }
  }

  // ----- events -----

  // Lists: upcoming (default: tonight and later), past (finished, not archived), archived, or all.
  route('GET', /^\/api\/events$/, ({ venue, query }) => {
    const view = query.get('archived') === '1' ? 'archived' : ['past', 'all'].includes(query.get('view')) ? query.get('view') : 'upcoming';
    const archived = view === 'archived' ? 1 : 0;
    const today = venueDay();
    const when = view === 'upcoming' ? 'AND e.date >= ?' : view === 'past' ? 'AND e.date < ?' : '';
    const desc = view === 'archived' || view === 'past';
    const rows = db
      .prepare(
        `SELECT e.*,
           (SELECT COUNT(*) FROM guests g WHERE g.event_id = e.id) AS guest_count,
           (SELECT COALESCE(SUM(1 + plus_ones), 0) FROM guests g WHERE g.event_id = e.id) AS expected,
           (SELECT COALESCE(SUM(admitted), 0) FROM guests g WHERE g.event_id = e.id) AS admitted,
           (SELECT COUNT(*) FROM contributors c WHERE c.event_id = e.id) AS contributor_count
         FROM events e WHERE e.venue_id = ? ${view === 'all' ? '' : 'AND e.archived = ?'} ${when}
         ORDER BY e.date ${desc ? 'DESC' : 'ASC'}, e.id`
      )
      .all(...[venue.id, ...(view === 'all' ? [] : [archived]), ...(when ? [today] : [])]);
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
    // Validate first, so a typo doesn't cost the manager a PIN entry.
    const values = [
      venue.id,
      str(body.name, 'Event name', { required: true, max: 120 }),
      dateStr(body.date),
      timeStr(body.doorsTime),
      int(body.capacity, 'Capacity', { min: 1, nullable: true }),
      isoOrNull(body.cutoffAt, 'Cutoff'),
      str(body.notes, 'Notes', { max: 2000 }) || null,
      now(),
      actor,
      body.venueCapacity === undefined
        ? venue.default_capacity ?? null
        : int(body.venueCapacity, 'Venue capacity', { min: 1, max: 100000, nullable: true }),
      (body.countGuestlist === undefined ? venue.default_count_guestlist : body.countGuestlist) ? 1 : 0,
    ];
    // New shows need a manager's say-so once the venue has manager codes.
    const approver = override(venue, req, body, 'Creating an event needs a manager.', { soft: true });
    const info = db
      .prepare(
        'INSERT INTO events (venue_id, name, date, doors_time, capacity, cutoff_at, notes, created_at, created_by, venue_capacity, count_guestlist) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(...values);
    const id = Number(info.lastInsertRowid);
    log(db, { eventId: id, action: 'event.create', detail: approver ? `approved by ${approver}` : null, actor, via: 'venue' });
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
      venue_capacity: body.venueCapacity !== undefined
        ? int(body.venueCapacity, 'Venue capacity', { min: 1, max: 100000, nullable: true })
        : e.venue_capacity,
      count_guestlist: body.countGuestlist !== undefined ? (body.countGuestlist ? 1 : 0) : e.count_guestlist,
      tickets_sold: body.ticketsSold !== undefined ? int(body.ticketsSold, 'Tickets sold', { min: 0, max: 1000000, nullable: true }) : e.tickets_sold,
      tickets_scanned: body.ticketsScanned !== undefined ? int(body.ticketsScanned, 'Tickets scanned', { min: 0, max: 1000000, nullable: true }) : e.tickets_scanned,
    };
    if (next.venue_capacity !== e.venue_capacity || next.capacity !== e.capacity || next.count_guestlist !== e.count_guestlist) {
      override(venue, req, body, 'Changing capacity or guest list limits needs a manager.', { eventId: e.id, actor, soft: true });
    }
    db.prepare(
      `UPDATE events SET name = ?, date = ?, doors_time = ?, capacity = ?, cutoff_at = ?, notes = ?, archived = ?,
         venue_capacity = ?, count_guestlist = ?, tickets_sold = ?, tickets_scanned = ?,
         removed_by_riderly = CASE WHEN ? = 0 THEN 0 ELSE removed_by_riderly END WHERE id = ?`
    ).run(next.name, next.date, next.doors_time, next.capacity, next.cutoff_at, next.notes, next.archived,
      next.venue_capacity, next.count_guestlist, next.tickets_sold, next.tickets_scanned, next.archived, e.id);
    if (next.venue_capacity !== e.venue_capacity) {
      publish(e.id, 'count', { headcount: headcountOut(getEvent(db, e.id)), actor });
    }
    const action = next.archived !== e.archived ? (next.archived ? 'event.archive' : 'event.unarchive') : 'event.update';
    const ticketNote = next.tickets_sold !== e.tickets_sold || next.tickets_scanned !== e.tickets_scanned
      ? `tickets: ${next.tickets_sold ?? '—'} sold, ${next.tickets_scanned ?? '—'} scanned` : null;
    log(db, { eventId: e.id, action, detail: ticketNote, actor, via: 'venue' });
    publish(e.id, 'event');
    return eventOut(getEvent(db, e.id));
  });

  route('DELETE', /^\/api\/events\/(\d+)$/, ({ venue, req, params, body }) => {
    actorFrom(req);
    const e = evt(venue, params[0]);
    override(venue, req, body, 'Deleting an event needs a manager.', { soft: true });
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

  // ----- door capacity counter (shared clicker) -----

  route('POST', /^\/api\/events\/(\d+)\/count$/, ({ venue, req, params, body }) => {
    const actor = actorFrom(req);
    const delta = int(body.delta, 'Delta', { min: -50, max: 50 });
    const e = evt(venue, params[0]);
    tx(db, () => {
      ruled(venue, req, body, { eventId: e.id, actor }, () => checkVenueCapacity(getEvent(db, e.id), delta));
      bumpHeadcount(db, e.id, delta, 'clicker', actor);
    });
    const headcount = headcountOut(getEvent(db, e.id));
    publish(e.id, 'count', { headcount, actor });
    return headcount;
  }, { idempotent: true });

  // Manual correction ("we counted 312") or reset to 0.
  route('PUT', /^\/api\/events\/(\d+)\/count$/, ({ venue, req, params, body }) => {
    const actor = actorFrom(req);
    const e = evt(venue, params[0]);
    const target = int(body.count, 'Count', { min: 0, max: 100000 });
    override(venue, req, body, 'Correcting or resetting the door count needs a manager.', { soft: true });
    tx(db, () => {
      const cur = getEvent(db, e.id).head_count || 0;
      if (target === cur) return;
      db.prepare('UPDATE events SET head_count = ?, head_peak = MAX(head_peak, ?) WHERE id = ?').run(target, target, e.id);
      db.prepare('INSERT INTO headcount_log (event_id, delta, count_after, source, actor, at) VALUES (?, ?, ?, ?, ?, ?)').run(
        e.id, target - cur, target, 'set', actor, now()
      );
      if (body.resetStats) db.prepare('UPDATE events SET head_peak = ?, head_in = 0, head_out = 0 WHERE id = ?').run(target, e.id);
      log(db, { eventId: e.id, action: 'count.set', detail: `${cur} → ${target}`, actor, via: 'door' });
    });
    const headcount = headcountOut(getEvent(db, e.id));
    publish(e.id, 'count', { headcount, actor });
    return headcount;
  });

  route('GET', /^\/api\/events\/(\d+)\/count\/log$/, ({ venue, params }) => {
    const e = evt(venue, params[0]);
    return db
      .prepare('SELECT delta, count_after, source, actor, at FROM headcount_log WHERE event_id = ? ORDER BY id DESC LIMIT 200')
      .all(e.id)
      .map((r) => ({ delta: r.delta, countAfter: r.count_after, source: r.source, actor: r.actor, at: r.at }));
  });

  // ----- copy contributors from another show ("same as last Friday") -----

  route('POST', /^\/api\/events\/(\d+)\/contributors\/copy$/, ({ venue, req, params, body }) => {
    const actor = actorFrom(req);
    const e = evt(venue, params[0]);
    const from = evt(venue, int(body.fromEventId, 'Show to copy from', { min: 1, max: 1e9 }));
    if (from.id === e.id) throw new HttpError(400, 'Pick a different show to copy from.');
    const have = new Set(db.prepare('SELECT name FROM contributors WHERE event_id = ?').all(e.id).map((c) => c.name.toLowerCase()));
    const source = db.prepare('SELECT * FROM contributors WHERE event_id = ? ORDER BY id').all(from.id);
    let added = 0;
    tx(db, () => {
      for (const c of source) {
        if (have.has(c.name.toLowerCase())) continue;
        db.prepare(
          'INSERT INTO contributors (event_id, name, list_type, allocation, token, notes, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(e.id, c.name, c.list_type, c.allocation, newToken(), c.notes, now(), actor);
        added += 1;
      }
      if (added) log(db, { eventId: e.id, action: 'contributor.copy', detail: `${added} from ${from.name}`, actor, via: 'venue' });
    });
    publish(e.id, 'contributors');
    return { added, skipped: source.length - added };
  });

  // ----- night report -----

  function reportFor(e) {
    const guests = listGuests(db, e.id);
    const contributors = db.prepare('SELECT * FROM contributors WHERE event_id = ? ORDER BY name COLLATE NOCASE').all(e.id);
    const row = (list) => {
      const st = stats(list);
      return { entries: st.guests, heads: st.expected, arrived: st.admitted, noShow: st.noShow };
    };
    const byContributor = contributors.map((c) => ({
      name: c.name, listType: c.list_type, allocation: c.allocation, ...row(guests.filter((g) => g.contributorId === c.id)),
    }));
    const direct = guests.filter((g) => !g.contributorId);
    if (direct.length) byContributor.push({ name: 'Venue / door (no contributor)', listType: '—', allocation: null, ...row(direct) });
    const lists = [...new Set(guests.map((g) => g.listType))].sort();
    const byList = lists.map((t) => ({ listType: t, ...row(guests.filter((g) => g.listType === t)) }));
    const act = (sql) => db.prepare(sql).all(e.id);
    const checkins = act("SELECT at, detail FROM activity WHERE event_id = ? AND action = 'guest.checkin' ORDER BY id")
      .map((a) => ({ at: a.at, count: Number((a.detail || '').match(/^(\d+)/)?.[1] || 1) }));
    const doorIn = act("SELECT at, delta FROM headcount_log WHERE event_id = ? AND source IN ('clicker', 'guestlist') AND delta > 0 ORDER BY id")
      .map((r) => ({ at: r.at, count: r.delta }));
    const overrides = act("SELECT at, actor, detail FROM activity WHERE event_id = ? AND action = 'override' ORDER BY id")
      .map((a) => ({ at: a.at, actor: a.actor, detail: a.detail }));
    const st = stats(guests);
    return {
      event: eventOut(e),
      venueName: venue_name_of(e),
      door: headcountOut(e),
      tickets: ticketsFor(e, st),
      guestlist: { entries: st.guests, heads: st.expected, arrived: st.admitted, noShow: st.noShow, vip: st.vip },
      byContributor,
      byList,
      arrivals: { checkins, doorIn },
      firstIn: [checkins[0]?.at, doorIn[0]?.at].filter(Boolean).sort()[0] || null,
      overrides,
      purged: !!e.purged_at,
    };
  }

  // Tickets vs door: scanned tickets + guest list arrivals is who should have come through the door.
  // The clicker's "total in" also counts re-entries, so it normally runs a little higher.
  function ticketsFor(e, st) {
    const sold = e.tickets_sold ?? null;
    const scanned = e.tickets_scanned ?? null;
    const expected = scanned == null ? null : scanned + st.admitted;
    const doorIn = e.head_in || 0;
    return {
      sold,
      scanned,
      noShow: sold != null && scanned != null ? Math.max(0, sold - scanned) : null,
      expectedIn: expected,
      doorIn,
      difference: expected != null && doorIn > 0 ? doorIn - expected : null,
    };
  }

  function venue_name_of(e) {
    return db.prepare('SELECT name FROM venues WHERE id = ?').get(e.venue_id)?.name || '';
  }

  route('GET', /^\/api\/events\/(\d+)\/report$/, ({ venue, params }) => {
    const r = reportFor(evt(venue, params[0]));
    r.canEmail = !!(venue.email && mailConfig());
    r.emailTo = venue.email || null;
    return r;
  });

  route('POST', /^\/api\/events\/(\d+)\/report\/email$/, async ({ venue, req, params }) => {
    actorFrom(req);
    const e = evt(venue, params[0]);
    if (!venue.email) throw new HttpError(400, 'Add a contact email in the venue admin page first.');
    if (!mailConfig()) throw new HttpError(400, 'Email isn’t set up on the server yet.');
    const r = reportFor(e);
    const pad = (s, n) => String(s).padEnd(n);
    const lines = [
      `${r.venueName} — ${e.name}`,
      `${e.date}${e.doors_time ? ` · doors ${e.doors_time}` : ''}`,
      '',
      'DOOR COUNT',
      `  Capacity: ${r.door.capacity ?? 'not set'}   Peak: ${r.door.peak}   In: ${r.door.totalIn}   Out: ${r.door.totalOut}   At close: ${r.door.count}`,
      '',
      ...(r.tickets.sold != null || r.tickets.scanned != null ? [
        'TICKETS',
        `  Sold: ${r.tickets.sold ?? '—'}   Scanned: ${r.tickets.scanned ?? '—'}${r.tickets.noShow != null ? `   Ticket no-shows: ${r.tickets.noShow}` : ''}`,
        ...(r.tickets.difference != null ? [`  Scanned + guest list arrived: ${r.tickets.expectedIn}   Door clicker in: ${r.tickets.doorIn}   Difference: ${r.tickets.difference > 0 ? '+' : ''}${r.tickets.difference}`] : []),
        '',
      ] : []),
      'GUEST LIST',
      `  ${r.guestlist.heads} on the list (${r.guestlist.entries} entries) · ${r.guestlist.arrived} arrived · ${r.guestlist.noShow} no-shows · ${r.guestlist.vip} VIP`,
      '',
      'BY CONTRIBUTOR (heads / arrived / no-shows)',
      ...r.byContributor.map((c) => `  ${pad(c.name, 34)} ${pad(`${c.heads}${c.allocation != null ? `/${c.allocation}` : ''}`, 8)} ${pad(c.arrived, 6)} ${c.noShow}`),
      '',
      `OVERRIDES (${r.overrides.length})`,
      ...(r.overrides.length ? r.overrides.map((o) => `  ${o.actor}: ${o.detail}`) : ['  None']),
      '',
      `Full report: ${PUBLIC_URL}/app#/event/${e.id}/report`,
    ];
    const sent = await mail({ to: venue.email, subject: `Night report — ${e.name} (${e.date})`, text: lines.join('\n') });
    if (!sent) throw new HttpError(502, 'The email couldn’t be sent. Check the email setup.');
    return { ok: true, to: venue.email };
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
    if (next.allocation !== c.allocation) {
      override(venue, req, body, `Changing ${c.name}’s allocation needs a manager.`, { eventId: c.event_id, actor, soft: true });
    }
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
      const ctx = { eventId: e.id, actor };
      ruled(venue, req, body, ctx, () => checkCapacity(db, e, 1 + data.plusOnes, 0));
      if (contributor) ruled(venue, req, body, ctx, () => checkAllocation(db, contributor, 1 + data.plusOnes, 0));
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
    const heads = rows.reduce((n, r) => n + 1 + Math.min(50, Math.max(0, Number(r.plusOnes) || 0)), 0);
    const added = tx(db, () => {
      const ctx = { eventId: e.id, actor };
      ruled(venue, req, body, ctx, () => checkCapacity(db, e, heads, 0));
      if (contributor) ruled(venue, req, body, ctx, () => checkAllocation(db, contributor, heads, 0));
      return rows.map((r) => {
        const data = guestInput({ ...r, listType: lt });
        const g = insertGuest(e, contributor, data, actor, 'venue');
        log(db, { eventId: e.id, guest: g, action: 'guest.add', detail: 'import', actor, via: 'venue' });
        return g;
      });
    });
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
      const ctx = { eventId: e.id, actor };
      ruled(venue, req, body, ctx, () => checkCapacity(db, e, 1 + data.plusOnes, g.id));
      if (contributor) ruled(venue, req, body, ctx, () => checkAllocation(db, contributor, 1 + data.plusOnes, g.id));
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

  route('DELETE', /^\/api\/guests\/(\d+)$/, ({ venue, req, params, body }) => {
    const actor = actorFrom(req);
    const g = gst(venue, params[0]);
    if (g.admitted > 0) {
      override(venue, req, body, `${g.name} has already checked in — removing them needs a manager.`, { eventId: g.event_id, actor });
    }
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
      const ev = getEvent(db, g.event_id);
      if (ev.count_guestlist) {
        if (direction === 'in') ruled(venue, req, body, { eventId: ev.id, actor }, () => checkVenueCapacity(ev, count));
        bumpHeadcount(db, g.event_id, direction === 'in' ? count : -count, 'guestlist', actor);
      }
      log(db, {
        eventId: g.event_id,
        guest: g,
        action: direction === 'in' ? 'guest.checkin' : 'guest.checkout',
        detail: `${count} (${inside}/${party} inside)${req.headers['x-op-at'] ? ' — tapped while offline' : ''}`,
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

  route('POST', /^\/api\/guests\/(\d+)\/checkin$/, ({ venue, req, params, body }) => move(venue, req, params, body, 'in'), { idempotent: true });
  route('POST', /^\/api\/guests\/(\d+)\/checkout$/, ({ venue, req, params, body }) => move(venue, req, params, body, 'out'), { idempotent: true });

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

  // ----- venue admin portal (/v/<venue>/admin) -----

  function sessionVadmin(req) {
    const s = auth.vadminSession(db, req);
    if (!s) return null;
    const v = db.prepare('SELECT * FROM venues WHERE id = ?').get(s.venueId);
    if (!v || !v.active || !v.admin_password_hash || (v.admin_version || 1) !== s.version) return null;
    return v;
  }

  function venueBySlug(slug) {
    const v = db.prepare('SELECT * FROM venues WHERE slug = ?').get(slugify(slug));
    if (!v || !v.active) throw new HttpError(404, 'Venue not found');
    return v;
  }

  route('GET', /^\/api\/vadmin\/session\/([A-Za-z0-9_-]+)$/, ({ req, params }) => {
    const v = venueBySlug(params[0]);
    const me = sessionVadmin(req);
    return { venue: { name: v.name, slug: v.slug }, authed: !!me && me.id === v.id, needsSetup: !v.admin_password_hash };
  }, { auth: 'public' });

  route('POST', /^\/api\/vadmin\/login\/([A-Za-z0-9_-]+)$/, ({ req, params, body, res }) => {
    limit(req);
    const v = venueBySlug(params[0]);
    let ok;
    if (!v.admin_password_hash) {
      // First time for an older venue: prove you're a manager with an existing code, then choose the admin password.
      const approver = matchOverride(v, String(body.managerCode || ''));
      if (!approver) {
        failed(req);
        throw new HttpError(401, 'That manager code is wrong. Ask Riderly for a venue admin setup link if you’re stuck.');
      }
      db.prepare('UPDATE venues SET admin_password_hash = ?, admin_version = admin_version + 1 WHERE id = ?').run(
        auth.hashPassword(password(body.newPassword, 'Venue admin password')), v.id
      );
      ok = true;
    } else {
      ok = auth.verifyPassword(str(body.password, 'Password', { max: 200 }), v.admin_password_hash);
    }
    if (!ok) {
      failed(req);
      throw new HttpError(401, 'Wrong venue admin password.');
    }
    const fresh = db.prepare('SELECT * FROM venues WHERE id = ?').get(v.id);
    res.setHeader('Set-Cookie', auth.vadminCookie(db, fresh, secureCookies));
    return { ok: true };
  }, { auth: 'public' });

  route('POST', /^\/api\/vadmin\/logout$/, ({ res }) => {
    res.setHeader('Set-Cookie', auth.clearVadminCookie(secureCookies));
    return { ok: true };
  }, { auth: 'public' });

  function codeOut(c) {
    return { id: c.id, name: c.name, active: !!c.active, createdAt: c.created_at, lastUsedAt: c.last_used_at };
  }

  route('GET', /^\/api\/vadmin\/overview$/, ({ venue }) => {
    const codes = db.prepare('SELECT * FROM manager_codes WHERE venue_id = ? ORDER BY active DESC, name COLLATE NOCASE').all(venue.id).map(codeOut);
    const overrides = db
      .prepare(
        `SELECT a.at, a.actor, a.detail, a.via, e.name AS event_name, e.date AS event_date
         FROM activity a JOIN events e ON e.id = a.event_id
         WHERE e.venue_id = ? AND a.action = 'override' ORDER BY a.id DESC LIMIT 200`
      )
      .all(venue.id)
      .map((r) => ({ at: r.at, actor: r.actor, detail: r.detail, via: r.via, eventName: r.event_name, eventDate: r.event_date }));
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM events WHERE venue_id = ?) AS events,
                (SELECT COUNT(*) FROM guests g JOIN events e ON e.id = g.event_id WHERE e.venue_id = ?) AS guests`
      )
      .get(venue.id, venue.id);
    return {
      venue: {
        name: venue.name,
        slug: venue.slug,
        email: venue.email,
        defaultCapacity: venue.default_capacity,
        defaultCountGuestlist: !!venue.default_count_guestlist,
        retentionDays: venue.retention_days,
        staffLastLogin: venue.last_login_at,
      },
      codes,
      overrides,
      counts,
      apiKey: apiKeyOut(venue),
    };
  }, { auth: 'vadmin' });

  route('POST', /^\/api\/vadmin\/codes$/, ({ venue, body }) => {
    const name = str(body.name, 'Manager name', { required: true, max: 40 });
    const code = managerPin(body.code, 'Manager code');
    if (venue.admin_password_hash && auth.verifyPassword(code, venue.admin_password_hash)) {
      throw new HttpError(400, 'Use a code that’s different from the venue admin password.');
    }
    const n = db.prepare('SELECT COUNT(*) AS n FROM manager_codes WHERE venue_id = ? AND active = 1').get(venue.id).n;
    if (n >= 25) throw new HttpError(409, 'That’s the maximum of 25 active manager codes. Revoke one first.');
    if (matchOverride(venue, code)) throw new HttpError(409, 'Another manager already uses that code — pick a different one.');
    const info = db.prepare('INSERT INTO manager_codes (venue_id, name, code_hash, created_at) VALUES (?, ?, ?, ?)').run(
      venue.id, name, auth.hashPassword(code), now()
    );
    return codeOut(db.prepare('SELECT * FROM manager_codes WHERE id = ?').get(Number(info.lastInsertRowid)));
  }, { auth: 'vadmin' });

  function venueCode(venue, id) {
    const c = db.prepare('SELECT * FROM manager_codes WHERE id = ? AND venue_id = ?').get(id, venue.id);
    if (!c) throw new HttpError(404, 'Manager code not found');
    return c;
  }

  route('PUT', /^\/api\/vadmin\/codes\/(\d+)$/, ({ venue, params, body }) => {
    const c = venueCode(venue, params[0]);
    const name = body.name !== undefined ? str(body.name, 'Manager name', { required: true, max: 40 }) : c.name;
    let hash = c.code_hash;
    if (body.code !== undefined) {
      const code = managerPin(body.code, 'New manager code');
      const clash = matchOverride({ ...venue, admin_password_hash: venue.admin_password_hash }, code);
      if (clash && clash !== c.name) throw new HttpError(409, 'Another manager already uses that code — pick a different one.');
      hash = auth.hashPassword(code);
    }
    const active = body.active !== undefined ? (body.active ? 1 : 0) : c.active;
    db.prepare('UPDATE manager_codes SET name = ?, code_hash = ?, active = ? WHERE id = ?').run(name, hash, active, c.id);
    return codeOut(db.prepare('SELECT * FROM manager_codes WHERE id = ?').get(c.id));
  }, { auth: 'vadmin' });

  route('DELETE', /^\/api\/vadmin\/codes\/(\d+)$/, ({ venue, params }) => {
    const c = venueCode(venue, params[0]);
    db.prepare('DELETE FROM manager_codes WHERE id = ?').run(c.id);
    return { ok: true };
  }, { auth: 'vadmin' });

  route('PUT', /^\/api\/vadmin\/staff-password$/, ({ venue, body }) => {
    const pw = password(body.password, 'New staff password');
    if (auth.verifyPassword(pw, venue.admin_password_hash)) throw new HttpError(400, 'Use a staff password that’s different from the venue admin password.');
    db.prepare('UPDATE venues SET password_hash = ?, password_version = password_version + 1 WHERE id = ?').run(auth.hashPassword(pw), venue.id);
    return { ok: true };
  }, { auth: 'vadmin' });

  // Logs every staff phone out without changing the password (e.g. a lost phone).
  route('POST', /^\/api\/vadmin\/logout-devices$/, ({ venue }) => {
    db.prepare('UPDATE venues SET password_version = password_version + 1 WHERE id = ?').run(venue.id);
    return { ok: true };
  }, { auth: 'vadmin' });

  route('PUT', /^\/api\/vadmin\/venue$/, ({ venue, body }) => {
    const next = {
      name: body.name !== undefined ? str(body.name, 'Venue name', { required: true, max: 80 }) : venue.name,
      email: body.email !== undefined ? str(body.email, 'Email', { max: 120 }) || null : venue.email,
      default_capacity: body.defaultCapacity !== undefined
        ? int(body.defaultCapacity, 'Default capacity', { min: 1, max: 100000, nullable: true })
        : venue.default_capacity,
      default_count_guestlist: body.defaultCountGuestlist !== undefined ? (body.defaultCountGuestlist ? 1 : 0) : venue.default_count_guestlist,
      retention_days: body.retentionDays !== undefined
        ? int(body.retentionDays, 'Keep guest details for', { min: 7, max: 3650, nullable: true })
        : venue.retention_days,
    };
    if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) throw new HttpError(400, 'That email address looks wrong');
    db.prepare(
      'UPDATE venues SET name = ?, email = ?, default_capacity = ?, default_count_guestlist = ?, retention_days = ? WHERE id = ?'
    ).run(next.name, next.email, next.default_capacity, next.default_count_guestlist, next.retention_days, venue.id);
    return { ok: true };
  }, { auth: 'vadmin' });

  route('PUT', /^\/api\/vadmin\/admin-password$/, ({ venue, req, body, res }) => {
    if (!auth.verifyPassword(str(body.currentPassword, 'Current password', { max: 200 }), venue.admin_password_hash)) {
      failed(req);
      throw new HttpError(401, 'Current venue admin password is wrong.');
    }
    db.prepare('UPDATE venues SET admin_password_hash = ?, admin_version = admin_version + 1 WHERE id = ?').run(
      auth.hashPassword(password(body.newPassword, 'New venue admin password')), venue.id
    );
    const fresh = db.prepare('SELECT * FROM venues WHERE id = ?').get(venue.id);
    res.setHeader('Set-Cookie', auth.vadminCookie(db, fresh, secureCookies));
    return { ok: true };
  }, { auth: 'vadmin' });

  // ----- privacy: remove guest details N days after a show (per venue setting) -----

  function purgeExpired(at = new Date()) {
    let purged = 0;
    db.prepare('DELETE FROM applied_ops WHERE created_at < ?').run(new Date(at.getTime() - 7 * 86400000).toISOString());
    const venues = db.prepare('SELECT id, retention_days FROM venues WHERE retention_days IS NOT NULL').all();
    for (const v of venues) {
      const cutoff = new Date(at.getTime() - v.retention_days * 86400000).toISOString().slice(0, 10);
      const events = db.prepare('SELECT id FROM events WHERE venue_id = ? AND date < ? AND purged_at IS NULL').all(v.id, cutoff);
      for (const e of events) {
        tx(db, () => {
          // Counts stay for reporting; names and notes go.
          db.prepare("UPDATE guests SET name = 'Guest (removed)', notes = NULL WHERE event_id = ?").run(e.id);
          db.prepare('UPDATE activity SET guest_name = NULL WHERE event_id = ?').run(e.id);
          db.prepare('UPDATE events SET purged_at = ? WHERE id = ?').run(at.toISOString(), e.id);
          log(db, { eventId: e.id, action: 'event.purge', detail: `guest details removed after ${v.retention_days} days`, actor: 'Riderly', via: 'venue' });
        });
        purged += 1;
      }
    }
    return purged;
  }

  // ----- Riderly connection (API v1) -----
  // The Riderly venue manager calls these server-to-server with the venue's API key:
  //   Authorization: Bearer rgl_…   (made in the venue admin portal, shown once, revocable)
  // It can push shows in and read counts back. It never sees guest names.

  const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

  // All venues' calls come from the one Riderly server, so a dead key must never block the others:
  // bad attempts are counted per key, with only a high ceiling per address (keys are 192-bit random,
  // so guessing isn't practical anyway).
  const apiKeyLimiter = auth.createLimiter({ max: 20, windowMs: 10 * 60 * 1000 });
  const apiNetLimiter = auth.createLimiter({ max: 1000, windowMs: 10 * 60 * 1000 });

  function apiVenue(req) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(rgl_[A-Za-z0-9_-]{20,80})$/);
    const hash = m ? hashKey(m[1]) : 'none';
    const keyScope = `api|${clientIp(req)}|${hash.slice(0, 16)}`;
    const netScope = `api|${clientIp(req)}`;
    if (apiNetLimiter.blocked(netScope)) throw new HttpError(429, 'Too many bad API keys from this address. Try again in a few minutes.');
    const v = m ? db.prepare('SELECT * FROM venues WHERE api_key_hash = ?').get(hash) : null;
    if (!v || !v.active || !v.password_hash) {
      if (apiKeyLimiter.blocked(keyScope)) throw new HttpError(429, 'This API key keeps failing. Stop retrying it and reconnect the venue.');
      apiKeyLimiter.fail(keyScope);
      apiNetLimiter.fail(netScope);
      throw new HttpError(401, 'Invalid API key');
    }
    const last = Date.parse(v.api_key_last_used_at || '') || 0;
    if (Date.now() - last > 60 * 1000) db.prepare('UPDATE venues SET api_key_last_used_at = ? WHERE id = ?').run(now(), v.id);
    return v;
  }

  function externalId(v) {
    const s = str(v, 'External ID', { required: true, max: 100 });
    if (!/^[A-Za-z0-9_.:-]+$/.test(s)) throw new HttpError(400, 'External ID may only use letters, numbers and _ . : -');
    return s;
  }

  function apiEvent(venue, ref) {
    const e = /^\d+$/.test(ref)
      ? db.prepare('SELECT * FROM events WHERE id = ? AND venue_id = ?').get(Number(ref), venue.id)
      : db.prepare('SELECT * FROM events WHERE external_id = ? AND venue_id = ?').get(externalId(decodeURIComponent(ref.replace(/^ext:/, ''))), venue.id);
    if (!e) throw new HttpError(404, 'Show not found');
    return e;
  }

  function apiEventOut(e) {
    const st = stats(listGuests(db, e.id));
    const { headcount, ...rest } = eventOut(e);
    return {
      ...rest,
      door: headcount,
      guestlist: { entries: st.guests, heads: st.expected, arrived: st.admitted, inside: st.inside, noShow: st.noShow, vip: st.vip },
      tickets: ticketsFor(e, st),
      links: { app: `${PUBLIC_URL}/app#/event/${e.id}`, report: `${PUBLIC_URL}/app#/event/${e.id}/report` },
    };
  }

  route('GET', /^\/api\/v1\/venue$/, ({ venue }) => ({
    name: venue.name,
    username: venue.slug,
    links: {
      staffLogin: `${PUBLIC_URL}/v/${venue.slug}`,
      venueAdmin: `${PUBLIC_URL}/v/${venue.slug}/admin`,
      app: `${PUBLIC_URL}/app`,
      guide: `${PUBLIC_URL}/guide`,
    },
  }), { auth: 'api' });

  route('GET', /^\/api\/v1\/events$/, ({ venue, query }) => {
    const from = query.get('from') ? dateStr(query.get('from')) : '0000-01-01';
    const to = query.get('to') ? dateStr(query.get('to')) : '9999-12-31';
    const rows = db
      .prepare(`SELECT * FROM events WHERE venue_id = ? AND date BETWEEN ? AND ? ${query.get('archived') === '1' ? '' : 'AND archived = 0'} ORDER BY date, id LIMIT 500`)
      .all(venue.id, from, to);
    return { events: rows.map(apiEventOut) };
  }, { auth: 'api' });

  route('GET', /^\/api\/v1\/events\/([^/]+)$/, ({ venue, params }) => apiEventOut(apiEvent(venue, params[0])), { auth: 'api' });

  // Creates the show the first time, then keeps it in step. Only the fields sent are changed.
  route('PUT', /^\/api\/v1\/events\/ext:([^/]+)$/, ({ venue, params, body }) => {
    const ext = externalId(decodeURIComponent(params[0]));
    const e = db.prepare('SELECT * FROM events WHERE external_id = ? AND venue_id = ?').get(ext, venue.id);
    const has = (k) => body[k] !== undefined;
    const fields = {
      name: has('name') ? str(body.name, 'Event name', { required: true, max: 120 }) : undefined,
      date: has('date') ? dateStr(body.date) : undefined,
      doors_time: has('doorsTime') ? timeStr(body.doorsTime) : undefined,
      notes: has('notes') ? str(body.notes, 'Notes', { max: 2000 }) || null : undefined,
      capacity: has('guestListCap') ? int(body.guestListCap, 'Guest list cap', { min: 1, nullable: true }) : undefined,
      venue_capacity: has('venueCapacity') ? int(body.venueCapacity, 'Venue capacity', { min: 1, max: 100000, nullable: true }) : undefined,
      tickets_sold: has('ticketsSold') ? int(body.ticketsSold, 'Tickets sold', { min: 0, max: 1000000, nullable: true }) : undefined,
      tickets_scanned: has('ticketsScanned') ? int(body.ticketsScanned, 'Tickets scanned', { min: 0, max: 1000000, nullable: true }) : undefined,
      archived: has('archived') ? (body.archived ? 1 : 0) : undefined,
    };
    const set = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (!e) {
      if (!fields.name || !fields.date) throw new HttpError(400, 'A new show needs a name and a date');
      const info = db
        .prepare(`INSERT INTO events (venue_id, name, date, created_at, created_by, venue_capacity, count_guestlist, external_id)
                  VALUES (?, ?, ?, ?, 'Riderly', ?, ?, ?)`)
        .run(venue.id, fields.name, fields.date, now(), venue.default_capacity ?? null, venue.default_count_guestlist ? 1 : 0, ext);
      const id = Number(info.lastInsertRowid);
      const rest = set.filter(([k]) => k !== 'name' && k !== 'date');
      if (rest.length) db.prepare(`UPDATE events SET ${rest.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...rest.map(([, v]) => v), id);
      log(db, { eventId: id, action: 'event.create', detail: 'from Riderly', actor: 'Riderly', via: 'venue' });
      return { created: true, event: apiEventOut(getEvent(db, id)) };
    }
    // Back in the Riderly schedule after Riderly removed it: restore it (unless this call archives it).
    if (e.removed_by_riderly && fields.archived === undefined) {
      db.prepare('UPDATE events SET archived = 0, removed_by_riderly = 0 WHERE id = ?').run(e.id);
      log(db, { eventId: e.id, action: 'event.unarchive', detail: 'back in the Riderly schedule', actor: 'Riderly', via: 'venue' });
      e.archived = 0;
      publish(e.id, 'event');
    }
    const changed = set.filter(([k, v]) => e[k] !== v);
    if (changed.length) {
      db.prepare(`UPDATE events SET ${changed.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...changed.map(([, v]) => v), e.id);
      log(db, { eventId: e.id, action: 'event.update', detail: `from Riderly: ${changed.map(([k]) => k.replace(/_/g, ' ')).join(', ')}`, actor: 'Riderly', via: 'venue' });
      if (changed.some(([k]) => k === 'venue_capacity')) publish(e.id, 'count', { headcount: headcountOut(getEvent(db, e.id)), actor: 'Riderly' });
      publish(e.id, 'event');
    }
    return { created: false, event: apiEventOut(getEvent(db, e.id)) };
  }, { auth: 'api' });

  // A cancelled show: deleted if nobody is on its list yet, otherwise archived so no names are lost.
  route('DELETE', /^\/api\/v1\/events\/([^/]+)$/, ({ venue, params }) => {
    const e = apiEvent(venue, params[0]);
    const guests = db.prepare('SELECT COUNT(*) AS n FROM guests WHERE event_id = ?').get(e.id).n;
    const contributors = db.prepare('SELECT COUNT(*) AS n FROM contributors WHERE event_id = ?').get(e.id).n;
    if (guests === 0 && contributors === 0 && !e.head_in) {
      db.prepare('DELETE FROM events WHERE id = ?').run(e.id);
      publish(e.id, 'deleted');
      return { deleted: true, archived: false };
    }
    if (e.archived && !e.removed_by_riderly) return { deleted: false, archived: true }; // the venue archived it already
    db.prepare('UPDATE events SET archived = 1, removed_by_riderly = 1 WHERE id = ?').run(e.id);
    log(db, { eventId: e.id, action: 'event.archive', detail: 'removed from the Riderly schedule (kept: it has guests or contributor links)', actor: 'Riderly', via: 'venue' });
    publish(e.id, 'event');
    return { deleted: false, archived: true };
  }, { auth: 'api' });

  route('GET', /^\/api\/v1\/events\/([^/]+)\/report$/, ({ venue, params }) => {
    const r = reportFor(apiEvent(venue, params[0]));
    // Totals only: no staff names, override notes or guest details leave the app.
    return {
      event: apiEventOut(getEvent(db, r.event.id)),
      door: r.door,
      tickets: r.tickets,
      guestlist: r.guestlist,
      byContributor: r.byContributor,
      byList: r.byList,
      firstIn: r.firstIn,
      overrideCount: r.overrides.length,
    };
  }, { auth: 'api' });

  // Venue admin: make, see and revoke the key.
  function apiKeyOut(venue) {
    return {
      connected: !!venue.api_key_hash,
      hint: venue.api_key_hint || null,
      createdAt: venue.api_key_created_at || null,
      lastUsedAt: venue.api_key_last_used_at || null,
    };
  }

  route('POST', /^\/api\/vadmin\/api-key$/, ({ venue }) => {
    const key = `rgl_${crypto.randomBytes(24).toString('base64url')}`;
    db.prepare('UPDATE venues SET api_key_hash = ?, api_key_hint = ?, api_key_created_at = ?, api_key_last_used_at = NULL WHERE id = ?')
      .run(hashKey(key), key.slice(-4), now(), venue.id);
    return { key, ...apiKeyOut(db.prepare('SELECT * FROM venues WHERE id = ?').get(venue.id)) };
  }, { auth: 'vadmin' });

  route('DELETE', /^\/api\/vadmin\/api-key$/, ({ venue }) => {
    db.prepare('UPDATE venues SET api_key_hash = NULL, api_key_hint = NULL, api_key_created_at = NULL, api_key_last_used_at = NULL WHERE id = ?').run(venue.id);
    return { connected: false };
  }, { auth: 'vadmin' });

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
      } else if (mode === 'vadmin') {
        venue = sessionVadmin(req);
        if (!venue) throw new HttpError(401, 'Please log in');
      } else if (mode === 'api') {
        venue = apiVenue(req);
      }
      // Mutations must be JSON: blocks cross-site form posts (CSRF) alongside SameSite cookies.
      // (API-key calls carry no cookies, so they can't be forged cross-site.)
      if (mode !== 'api' && req.method !== 'GET' && !(req.headers['content-type'] || '').includes('application/json')) {
        throw new HttpError(415, 'Expected application/json');
      }
      const params = pathname.match(r.pattern).slice(1);
      const body = req.method === 'GET' ? {} : await readJson(req);
      // Door taps synced from an offline phone may arrive twice; apply each one only once.
      const opId = r.idempotent && venue ? String(req.headers['x-op-id'] || '') : '';
      if (opId && !/^[A-Za-z0-9_-]{8,64}$/.test(opId)) throw new HttpError(400, 'Bad operation id');
      if (opId) {
        const seen = db.prepare('SELECT response FROM applied_ops WHERE id = ? AND venue_id = ?').get(opId, venue.id);
        if (seen) return send(res, 200, JSON.parse(seen.response));
      }
      const result = await r.handler({ venue, req, res, params, body, query: url.searchParams });
      if (opId && result !== undefined) {
        db.prepare('INSERT OR IGNORE INTO applied_ops (id, venue_id, response, created_at) VALUES (?, ?, ?, ?)').run(
          opId, venue.id, JSON.stringify(result), now()
        );
      }
      if (result !== undefined && !res.headersSent) send(res, 200, result);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      if (res.headersSent) return res.end();
      const status = err instanceof HttpError ? err.status : 500;
      send(res, status, { error: status === 500 ? 'Something went wrong' : err.message, ...(err.code ? { code: err.code } : {}) });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  server.on('close', () => hub.closeAll());
  server.purgeExpired = purgeExpired;
  server.runBackup = runBackup;
  if (backupOpts && backupOpts.schedule !== false) {
    server.on('close', scheduleBackups(runBackup, backupDue, { log: mailLog }));
  }
  if (options.purgeTimer !== false) {
    const first = setTimeout(() => purgeExpired(), 30 * 1000);
    const daily = setInterval(() => purgeExpired(), 24 * 3600 * 1000);
    first.unref();
    daily.unref();
    server.on('close', () => {
      clearTimeout(first);
      clearInterval(daily);
    });
  }
  return server;
}

module.exports = { createApp, parseImport, LIST_TYPES };
