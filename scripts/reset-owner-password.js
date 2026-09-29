'use strict';

// Forgot the /admin owner password? Run on the droplet:
//   sudo -u venue node --disable-warning=ExperimentalWarning /srv/guestlist/scripts/reset-owner-password.js
// It sets a new random owner password, prints it once, and logs out every /admin session.
// Change it to your own in /admin afterwards. Venues and their data are not touched.

const path = require('node:path');
const crypto = require('node:crypto');
const { openDb, getSetting, setSetting } = require('../src/db');
const { hashPassword } = require('../src/auth');

const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'venuelist.db');
const db = openDb(file);

// Readable but strong: 4 groups of 4 (e.g. k7m2-9qfx-3hpt-w8cn), no look-alike characters.
const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
const bytes = crypto.randomBytes(16);
const pw = Array.from(bytes, (b) => alphabet[b % alphabet.length])
  .join('')
  .match(/.{4}/g)
  .join('-');

setSetting(db, 'owner_password_hash', hashPassword(pw));
setSetting(db, 'owner_password_version', String(Number(getSetting(db, 'owner_password_version') || 1) + 1));
db.close();

console.log('');
console.log('  New owner password:  ' + pw);
console.log('');
console.log('  Log in at /admin with it, then change it under "Owner password".');
console.log('  Every other /admin session has been logged out.');
console.log('');
