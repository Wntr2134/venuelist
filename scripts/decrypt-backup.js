'use strict';

// Turns an off-site backup (.vlb, downloaded from DigitalOcean Spaces) back into a normal database file.
//   node scripts/decrypt-backup.js daily-mon.vlb restored.db
// The passphrase comes from BACKUP_PASSPHRASE, else backup.json next to server.js, else it asks.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { decrypt } = require('../src/offsite');

async function passphrase() {
  if (process.env.BACKUP_PASSPHRASE) return process.env.BACKUP_PASSPHRASE;
  const cfgFile = process.env.BACKUP_CONFIG || path.join(__dirname, '..', 'backup.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    if (cfg.passphrase) return cfg.passphrase;
  } catch {
    // no config here (e.g. restoring on a laptop): ask instead
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question('Backup passphrase: ', (a) => {
    rl.close();
    resolve(a);
  }));
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('Usage: node scripts/decrypt-backup.js <backup.vlb> <restored.db>');
    process.exit(1);
  }
  if (fs.existsSync(output)) {
    console.error(`${output} already exists — pick a new name so nothing gets overwritten.`);
    process.exit(1);
  }
  let db;
  try {
    db = decrypt(fs.readFileSync(input), await passphrase());
  } catch (err) {
    console.error(err.message === 'Not a Riderly backup file' ? err.message : 'Wrong passphrase, or the file is damaged.');
    process.exit(1);
  }
  fs.writeFileSync(output, db, { mode: 0o600 });
  console.log(`Restored ${db.length} bytes to ${output}`);
}

main();
