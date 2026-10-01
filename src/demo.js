'use strict';

// "Try the demo": each visitor gets their own throwaway venue, "The Velvet Room", full of
// fictional guests, with tonight's show part-way through the door. Demo venues are deleted a
// few hours later (deleteOldDemos), and never appear in the owner's venue list.

const crypto = require('node:crypto');

const DEMO_CODE = '1234'; // the demo's manager code, shown on its banner
const DEMO_HOURS = 3;

const TONIGHT = [
  // [name, plusOnes, contributor index or null, listType, vip, notes, inside heads, checked in by]
  ['Jane Smith', 2, 0, 'Artist', false, 'Drummer’s family', 3, 'Sam (Door 1)'],
  ['Alex Nguyen', 0, 0, 'Artist', false, '', 1, 'Sam (Door 1)'],
  ['Priya Patel', 1, 0, 'Artist', false, 'Photographer', 1, 'Alex (Door 2)'],
  ['Marcus Webb', 1, 0, 'Artist', false, '', 0, null],
  ['Hana Kobayashi', 0, 0, 'Artist', false, 'Label rep', 0, null],
  ['Oliver Grant', 1, 1, 'Artist', false, '', 0, null],
  ['Zoe Martin', 0, 1, 'Artist', false, '', 0, null],
  ['Dev Raman', 3, 2, 'Guest', false, '', 4, 'Alex (Door 2)'],
  ['Lucy Ferreira', 1, 2, 'Guest', false, '', 1, 'Sam (Door 1)'],
  ['Isla Thompson', 2, 2, 'Guest', false, 'Birthday — the +2 are under 21, check ID', 0, null],
  ['Adebayo Okoro', 1, 2, 'Guest', false, '', 0, null],
  ['Janelle Ortiz', 0, 3, 'Media', true, 'Triple R — interview at 9', 0, null],
  ['Theo Lindqvist', 1, 3, 'Media', false, 'Photographer — pit access', 2, 'Sam (Door 1)'],
  ['Cr. Ruth Nakamura', 1, null, 'Industry', true, 'Council — meet at the box office', 2, 'Sam (Door 1)'],
  ['Rosa Delgado', 1, null, 'Industry', true, 'Booking agent', 0, null],
  ['Kai Anderson', 0, null, 'Crew', false, 'Lighting tech', 1, 'Alex (Door 2)'],
  ['Finn O’Brien', 0, null, 'Venue', false, 'Owner’s guest', 0, null],
  ['Chloe Nguyen', 1, null, 'Guest', false, '', 0, null],
  ['Matt Rossi', 0, null, 'Guest', false, '', 0, null],
  ['Emily Walsh', 2, null, 'Guest', false, '', 0, null],
];
const CONTRIBUTORS = [
  ['Midnight Arcade — Tour Manager', 'Artist', 30, 'Tom (TM)'],
  ['Support: Low Tide', 'Artist', 10, 'Nia (Low Tide)'],
  ['Harbour Presents (Promoter)', 'Guest', 40, 'Chris (Harbour)'],
  ['Publicist — Sam Okafor', 'Media', 12, 'Sam (Publicist)'],
];

function seedDemo(db, { hashPassword, venueDay }) {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const day = (n) => {
    const [y, m, d] = venueDay(now).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  };
  const slug = `demo-${crypto.randomBytes(5).toString('hex')}`;
  const t = iso(0);
  const v = db.prepare(
    `INSERT INTO venues (slug, name, password_hash, created_at, setup_at, demo, default_capacity) VALUES (?, ?, ?, ?, ?, 1, 450)`
  ).run(slug, 'The Velvet Room', hashPassword(crypto.randomBytes(18).toString('hex')), t, t);
  const venueId = Number(v.lastInsertRowid);
  db.prepare("INSERT INTO manager_codes (venue_id, name, code_hash, created_at) VALUES (?, 'Demo manager', ?, ?)")
    .run(venueId, hashPassword(DEMO_CODE), t);

  const event = (name, date, doors, extra = {}) => Number(db.prepare(
    `INSERT INTO events (venue_id, name, date, doors_time, notes, created_at, created_by, venue_capacity, tickets_sold, tickets_scanned)
     VALUES (?, ?, ?, ?, ?, ?, 'Will (Office)', 450, ?, ?)`
  ).run(venueId, name, date, doors, extra.notes || null, t, extra.sold ?? null, extra.scanned ?? null).lastInsertRowid);
  const contributor = (eventId, [name, listType, allocation, by]) => Number(db.prepare(
    'INSERT INTO contributors (event_id, name, list_type, allocation, token, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(eventId, name, listType, allocation, crypto.randomBytes(18).toString('base64url'), t, by).lastInsertRowid);
  const activity = (eventId, guestId, guestName, action, detail, actor, via, at) => db.prepare(
    'INSERT INTO activity (event_id, guest_id, guest_name, action, detail, actor, via, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(eventId, guestId, guestName, action, detail, actor, via, at);
  const guest = (eventId, cId, [name, plus, , listType, vip, notes], by, via, at) => Number(db.prepare(
    `INSERT INTO guests (event_id, contributor_id, name, plus_ones, list_type, vip, notes, added_by, added_via, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(eventId, cId, name, plus, listType, vip ? 1 : 0, notes || null, by, via, at, at, by).lastInsertRowid);

  // Tonight: doors open, part-way through.
  const tonight = event('Midnight Arcade — Album Launch', day(0), '19:30', {
    notes: 'Artist entry via the laneway door. Photo passes at merch. Wristbands: gold = all areas.', sold: 380,
  });
  const cIds = CONTRIBUTORS.map((c) => contributor(tonight, c));
  activity(tonight, null, null, 'event.create', null, 'Will (Office)', 'venue', iso(6 * 86400000));
  let minutesAgo = 95;
  TONIGHT.forEach((row, i) => {
    const cIdx = row[2];
    const by = cIdx === null ? 'Will (Office)' : CONTRIBUTORS[cIdx][3];
    const addedAt = iso((5 * 86400000) - i * 3600000);
    const id = guest(tonight, cIdx === null ? null : cIds[cIdx], row, by, cIdx === null ? 'venue' : 'contributor', addedAt);
    activity(tonight, id, row[0], 'guest.add', row[1] ? `+${row[1]}` : null, by, cIdx === null ? 'venue' : 'contributor', addedAt);
    const inside = row[6];
    if (inside) {
      const at = iso(minutesAgo * 60000);
      minutesAgo -= 6;
      db.prepare('UPDATE guests SET inside = ?, admitted = ?, first_in_at = ?, last_move_at = ?, updated_by = ? WHERE id = ?')
        .run(inside, inside, at, at, row[7], id);
      activity(tonight, id, row[0], 'guest.checkin', `${inside} of ${1 + row[1]} in`, row[7], 'door', at);
    }
  });
  // The door clicker: a steady stream since doors.
  let count = 0;
  let peak = 0;
  let totalIn = 0;
  let totalOut = 0;
  for (let m = 100; m >= 2; m -= 2) {
    const delta = m % 14 === 0 ? -1 : (m > 40 ? 3 : 2);
    count = Math.max(0, count + delta);
    peak = Math.max(peak, count);
    if (delta > 0) totalIn += delta; else totalOut -= delta;
    db.prepare("INSERT INTO headcount_log (event_id, delta, count_after, source, actor, at) VALUES (?, ?, ?, 'clicker', ?, ?)")
      .run(tonight, delta, count, m % 4 ? 'Sam (Door 1)' : 'Alex (Door 2)', iso(m * 60000));
  }
  db.prepare('UPDATE events SET head_count = ?, head_peak = ?, head_in = ?, head_out = ? WHERE id = ?').run(count, peak, totalIn, totalOut, tonight);

  // Coming up, and one from last week with its report.
  for (const [name, n] of [['Low Tide + Paper Moons', 2], ['Sunday Soul Sessions', 4], ['The Hollow Pines (Sold Out)', 8]]) {
    const id = event(name, day(n), '20:00');
    const c = contributor(id, ['Headliner — TM', 'Artist', 12, 'Tom (TM)']);
    for (const [g, plus] of [['Rory Quinn', 1], ['Maya Chen', 0], ['Leo Barros', 2], ['Asha Patel', 0]]) {
      guest(id, c, [g, plus, null, 'Artist', false, ''], 'Tom (TM)', 'contributor', t);
    }
  }
  const last = event('Club Night: HYPERSONIC', day(-6), '21:00', { sold: 410, scanned: 362 });
  const lc = contributor(last, ['DJ crew', 'Artist', 15, 'Ky (DJ)']);
  for (const [g, plus, inside] of [['Ari Stone', 1, 2], ['Bea Kim', 0, 1], ['Cal Rhodes', 2, 0], ['Dana Fox', 0, 1]]) {
    const id = guest(last, lc, [g, plus, null, 'Artist', false, ''], 'Ky (DJ)', 'contributor', iso(8 * 86400000));
    if (inside) db.prepare('UPDATE guests SET admitted = ?, first_in_at = ? WHERE id = ?').run(inside, iso(6 * 86400000), id);
  }
  db.prepare('UPDATE events SET head_peak = 388, head_in = 371, head_out = 371 WHERE id = ?').run(last);
  return db.prepare('SELECT * FROM venues WHERE id = ?').get(venueId);
}

function deleteOldDemos(db, at = Date.now()) {
  const cutoff = new Date(at - DEMO_HOURS * 3600 * 1000).toISOString();
  return db.prepare('DELETE FROM venues WHERE demo = 1 AND created_at < ?').run(cutoff).changes;
}

module.exports = { seedDemo, deleteOldDemos, DEMO_CODE, DEMO_HOURS };
