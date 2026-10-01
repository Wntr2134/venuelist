'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS venues (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL UNIQUE,     -- the "venue ID" staff type to log in
  name              TEXT NOT NULL,
  password_hash     TEXT,                     -- NULL until the venue finishes setup
  password_version  INTEGER NOT NULL DEFAULT 1,
  setup_token_hash  TEXT,                     -- sha256 of the one-time setup link token
  setup_expires_at  TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  setup_at          TEXT,
  last_login_at     TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id    INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  date        TEXT NOT NULL,            -- YYYY-MM-DD
  doors_time  TEXT,                     -- HH:MM
  capacity    INTEGER,                  -- optional guest-list cap (heads)
  cutoff_at   TEXT,                     -- ISO timestamp; contributors locked after this
  notes       TEXT,
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contributors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  list_type   TEXT NOT NULL DEFAULT 'Guest',
  allocation  INTEGER,                  -- max heads (guest + plus-ones); NULL = unlimited
  token       TEXT NOT NULL UNIQUE,
  active      INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  contributor_id  INTEGER REFERENCES contributors(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  plus_ones       INTEGER NOT NULL DEFAULT 0,
  list_type       TEXT NOT NULL DEFAULT 'Guest',
  vip             INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  inside          INTEGER NOT NULL DEFAULT 0,  -- heads currently inside
  admitted        INTEGER NOT NULL DEFAULT 0,  -- distinct heads that have arrived at least once
  first_in_at     TEXT,
  last_move_at    TEXT,
  added_by        TEXT NOT NULL,
  added_via       TEXT NOT NULL,               -- 'venue' | 'contributor' | 'door'
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  updated_by      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_guests_event ON guests(event_id);
CREATE INDEX IF NOT EXISTS idx_contrib_event ON contributors(event_id);

CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_id    INTEGER,
  guest_name  TEXT,
  action      TEXT NOT NULL,
  detail      TEXT,
  actor       TEXT NOT NULL,
  via         TEXT NOT NULL,
  at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_event ON activity(event_id, id);
CREATE INDEX IF NOT EXISTS idx_activity_guest ON activity(guest_id, action, id);

-- A venue's refused-entry list. Only the venue admin sees it; staff see a warning on a matching
-- guest. Every view and change is logged in banned_log. Entries lapse 30 days after review_at.
CREATE TABLE IF NOT EXISTS banned (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id    INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  reason      TEXT,
  review_at   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_banned_venue ON banned(venue_id);
CREATE TABLE IF NOT EXISTS banned_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id    INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  detail      TEXT,
  actor       TEXT NOT NULL,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_banned_log_venue ON banned_log(venue_id, id);

-- One-click sign-in links from the Riderly venue manager: single use, a minute long.
CREATE TABLE IF NOT EXISTS sso_tokens (
  token_hash  TEXT PRIMARY KEY,
  venue_id    INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  target      TEXT NOT NULL,
  actor       TEXT,
  expires_at  TEXT NOT NULL
);

-- Door clicker: every tap of + / − (or a manual correction), for peak and history.
CREATE TABLE IF NOT EXISTS headcount_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  delta       INTEGER NOT NULL,
  count_after INTEGER NOT NULL,
  source      TEXT NOT NULL,               -- 'clicker' | 'set' | 'guestlist'
  actor       TEXT NOT NULL,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_headcount_event ON headcount_log(event_id, id);

-- Named manager override codes (e.g. "JT", "Nick"), managed in the venue admin portal.
CREATE TABLE IF NOT EXISTS manager_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id    INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_codes_venue ON manager_codes(venue_id);

-- Offline door taps carry an id so a retried sync is only applied once.
CREATE TABLE IF NOT EXISTS applied_ops (
  venue_id    INTEGER NOT NULL,
  id          TEXT NOT NULL,
  response    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (venue_id, id)
);

CREATE TABLE IF NOT EXISTS access_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_name    TEXT NOT NULL,
  contact_name  TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  message       TEXT,
  status        TEXT NOT NULL DEFAULT 'new',   -- 'new' | 'done'
  created_at    TEXT NOT NULL
);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function migrate(db) {
  // v1 databases had no venues: add the column, then adopt the old single venue.
  const cols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  if (!cols.includes('venue_id')) {
    db.exec('ALTER TABLE events ADD COLUMN venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_venue ON events(venue_id)');

  // Manager override PIN (hashed) — needed to break rules like capacity or allocations.
  const venueCols = db.prepare('PRAGMA table_info(venues)').all().map((c) => c.name);
  if (!venueCols.includes('manager_pin_hash')) db.exec('ALTER TABLE venues ADD COLUMN manager_pin_hash TEXT');
  if (!venueCols.includes('pin_token_hash')) db.exec('ALTER TABLE venues ADD COLUMN pin_token_hash TEXT');
  if (!venueCols.includes('pin_token_expires')) db.exec('ALTER TABLE venues ADD COLUMN pin_token_expires TEXT');
  // Venue admin portal (/v/<venue>/admin): its own password, contact email and venue defaults.
  for (const [col, def] of [
    ['admin_password_hash', 'TEXT'],
    ['admin_version', 'INTEGER NOT NULL DEFAULT 1'],
    ['admin_token_hash', 'TEXT'],
    ['admin_token_expires', 'TEXT'],
    ['email', 'TEXT'],
    ['default_capacity', 'INTEGER'],
    ['default_count_guestlist', 'INTEGER NOT NULL DEFAULT 0'],
    ['retention_days', 'INTEGER'],
  ]) {
    if (!venueCols.includes(col)) db.exec(`ALTER TABLE venues ADD COLUMN ${col} ${def}`);
  }

  // Door capacity counter (shared clicker) per event.
  const evCols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  for (const [col, def] of [
    ['venue_capacity', 'INTEGER'],
    ['head_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['head_peak', 'INTEGER NOT NULL DEFAULT 0'],
    ['head_in', 'INTEGER NOT NULL DEFAULT 0'],
    ['head_out', 'INTEGER NOT NULL DEFAULT 0'],
    ['count_guestlist', 'INTEGER NOT NULL DEFAULT 0'],
    ['purged_at', 'TEXT'],
    // Ticketing totals typed in after the night (or sent by Riderly): Moshtix or any other system.
    ['tickets_sold', 'INTEGER'],
    ['tickets_scanned', 'INTEGER'],
    // The show's ID in the Riderly venue manager, so it can update the same show again.
    ['external_id', 'TEXT'],
    // 1 = archived because Riderly took the show out of its schedule; it comes back if the show does.
    ['removed_by_riderly', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    if (!evCols.includes(col)) db.exec(`ALTER TABLE events ADD COLUMN ${col} ${def}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external ON events(venue_id, external_id) WHERE external_id IS NOT NULL');

  // Applications (the home page form): a bit more about the venue, no logins.
  const arCols = db.prepare('PRAGMA table_info(access_requests)').all().map((c) => c.name);
  for (const [col, def] of [['suburb', 'TEXT'], ['shows_per_month', 'TEXT'], ['capacity', 'INTEGER'], ['ticketing', 'TEXT']]) {
    if (!arCols.includes(col)) db.exec(`ALTER TABLE access_requests ADD COLUMN ${col} ${def}`);
  }

  // Riderly connection: one API key per venue, stored as a SHA-256 hash (the key itself is shown once).
  const vCols = db.prepare('PRAGMA table_info(venues)').all().map((c) => c.name);
  for (const [col, def] of [
    ['api_key_hash', 'TEXT'],
    ['api_key_hint', 'TEXT'],
    ['api_key_created_at', 'TEXT'],
    ['api_key_last_used_at', 'TEXT'],
    ['demo', 'INTEGER NOT NULL DEFAULT 0'], // a "Try the demo" sandbox, deleted after a few hours
    // Billing, kept by Riderly (invoices go out from Xero; this just tracks who's paid up).
    ['plan', 'TEXT'],
    ['price_aud', 'INTEGER'],
    ['paid_until', 'TEXT'],
    ['billing_notes', 'TEXT'],
  ]) {
    if (!vCols.includes(col)) db.exec(`ALTER TABLE venues ADD COLUMN ${col} ${def}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_venues_api_key ON venues(api_key_hash) WHERE api_key_hash IS NOT NULL');

  // Sign-ups carry the username and password the venue chose, so approving them is one tap.
  const reqCols = db.prepare('PRAGMA table_info(access_requests)').all().map((c) => c.name);
  if (!reqCols.includes('slug')) db.exec('ALTER TABLE access_requests ADD COLUMN slug TEXT');
  if (!reqCols.includes('password_hash')) db.exec('ALTER TABLE access_requests ADD COLUMN password_hash TEXT');
  if (!reqCols.includes('pin_hash')) db.exec('ALTER TABLE access_requests ADD COLUMN pin_hash TEXT');
  if (!reqCols.includes('admin_hash')) db.exec('ALTER TABLE access_requests ADD COLUMN admin_hash TEXT');

  // The single manager PIN becomes a named manager code called "Manager".
  const withPin = db.prepare('SELECT id, manager_pin_hash FROM venues WHERE manager_pin_hash IS NOT NULL').all();
  for (const v of withPin) {
    db.prepare("INSERT INTO manager_codes (venue_id, name, code_hash, created_at) VALUES (?, 'Manager', ?, ?)").run(
      v.id, v.manager_pin_hash, new Date().toISOString()
    );
    db.prepare('UPDATE venues SET manager_pin_hash = NULL WHERE id = ?').run(v.id);
  }

  const legacyHash = getSetting(db, 'password_hash');
  const venueCount = db.prepare('SELECT COUNT(*) AS n FROM venues').get().n;
  if (legacyHash && venueCount === 0) {
    tx(db, () => {
      const name = getSetting(db, 'venue_name') || 'My venue';
      const t = new Date().toISOString();
      const info = db
        .prepare(
          'INSERT INTO venues (slug, name, password_hash, password_version, created_at, setup_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(uniqueSlug(db, name), name, legacyHash, Number(getSetting(db, 'password_version') || 1), t, t);
      db.prepare('UPDATE events SET venue_id = ? WHERE venue_id IS NULL').run(Number(info.lastInsertRowid));
      db.prepare("DELETE FROM settings WHERE key IN ('password_hash', 'venue_name', 'password_version')").run();
    });
  }
}

function slugify(name) {
  const s = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'venue';
}

function uniqueSlug(db, name) {
  const base = slugify(name);
  let slug = base;
  for (let i = 2; db.prepare('SELECT 1 FROM venues WHERE slug = ?').get(slug); i++) slug = `${base}-${i}`;
  return slug;
}

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, migrate, getSetting, setSetting, tx, slugify, uniqueSlug };
