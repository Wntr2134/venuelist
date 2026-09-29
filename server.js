'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { openDb, getSetting } = require('./src/db');
const { createApp } = require('./src/app');
const { scheduleBackups } = require('./src/backup');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'venuelist.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups');
const BACKUP_KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS) || 30;

const db = openDb(DB_FILE);

// Until a venue password exists, claiming the venue needs a one-time code that
// only someone with access to the server log can see.
let setupCode = null;
if (!getSetting(db, 'password_hash') && process.env.SETUP_CODE_DISABLED !== '1') {
  setupCode = crypto.randomBytes(5).toString('hex').toUpperCase();
  console.log(`First-time setup code: ${setupCode}  (enter it on the setup screen)`);
}

const server = createApp(db, {
  secureCookies: process.env.SECURE_COOKIES === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
  setupCode,
});

if (process.env.BACKUPS !== '0') scheduleBackups(db, BACKUP_DIR, { keepDays: BACKUP_KEEP_DAYS });

server.listen(PORT, HOST, () => {
  console.log(`VenueList running on http://${HOST}:${PORT} (db: ${DB_FILE}, backups: ${BACKUP_DIR})`);
});

function shutdown() {
  server.close();
  server.closeAllConnections();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
