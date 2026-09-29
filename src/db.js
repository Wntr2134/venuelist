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

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
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
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
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

module.exports = { openDb, getSetting, setSetting, tx };
