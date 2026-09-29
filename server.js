'use strict';

const path = require('node:path');
const { openDb } = require('./src/db');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'venuelist.db');

const db = openDb(DB_FILE);
const server = createApp(db, {
  secureCookies: process.env.SECURE_COOKIES === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
});

server.listen(PORT, HOST, () => {
  console.log(`VenueList running on http://${HOST}:${PORT} (db: ${DB_FILE})`);
});

function shutdown() {
  server.close();
  server.closeAllConnections();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
