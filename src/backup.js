'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DAY = 24 * 60 * 60 * 1000;

// Writes a consistent snapshot of the live database to dir/venuelist-YYYY-MM-DD.db.
function backupNow(db, dir, keepDays = 30, date = new Date()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `venuelist-${date.toISOString().slice(0, 10)}.db`);
  if (fs.existsSync(file)) fs.unlinkSync(file); // VACUUM INTO refuses to overwrite
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  fs.chmodSync(file, 0o600);

  const cutoff = date.getTime() - keepDays * DAY;
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/^venuelist-(\d{4}-\d{2}-\d{2})\.db$/);
    if (m && Date.parse(m[1]) < cutoff) fs.unlinkSync(path.join(dir, name));
  }
  return file;
}

// Backs up shortly after start, then once a day while the app runs.
function scheduleBackups(db, dir, { keepDays = 30, log = console } = {}) {
  const run = () => {
    try {
      log.log(`Backup written: ${backupNow(db, dir, keepDays)}`);
    } catch (err) {
      log.error(`Backup failed: ${err.message}`);
    }
  };
  const first = setTimeout(run, 60 * 1000);
  const daily = setInterval(run, DAY);
  first.unref();
  daily.unref();
  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}

module.exports = { backupNow, scheduleBackups };
