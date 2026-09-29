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

  // Sign-ups carry the username and password the venue chose, so approving them is one tap.
  const reqCols = db.prepare('PRAGMA table_info(access_requests)').all().map((c) => c.name);
  if (!reqCols.includes('slug')) db.exec('ALTER TABLE access_requests ADD COLUMN slug TEXT');
  if (!reqCols.includes('password_hash')) db.exec('ALTER TABLE access_requests ADD COLUMN password_hash TEXT');

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

module.exports = { openDb, getSetting, setSetting, tx, slugify, uniqueSlug };
