'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('../src/db');
const { createApp, parseImport } = require('../src/app');

const SETUP_CODE = 'ABC123DEF0';
let server;
let base;

// Each client has its own cookie jar, like a separate browser.
function client(url = () => base) {
  const jar = {};
  async function call(method, p, body, { actor = 'Tester', headers = {} } = {}) {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (actor) h['X-Actor'] = encodeURIComponent(actor);
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.Cookie = cookie;
    const res = await fetch(url() + p, { method, headers: h, body: body ? JSON.stringify(body) : method === 'GET' ? undefined : '{}' });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }
  return { call, jar };
}

const owner = client();

// Creates a venue as the owner and completes its setup link; returns a logged-in client.
async function onboard(name, pw = 'venuepass1') {
  const r = await owner.call('POST', '/api/owner/venues', { name });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const token = r.data.setupPath.split('/').pop();
  const v = client();
  const s = await v.call('POST', `/api/setup/${token}`, { password: pw });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  return { c: v, venue: r.data.venue, token };
}

before(async () => {
  server = createApp(openDb(':memory:'), { setupCode: SETUP_CODE });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test('owner setup needs the setup code, then owner login works', async () => {
  let r = await owner.call('GET', '/api/owner/session');
  assert.equal(r.data.needsSetup, true);
  assert.equal(r.data.setupCodeRequired, true);

  r = await owner.call('GET', '/api/owner/venues');
  assert.equal(r.status, 401);

  r = await owner.call('POST', '/api/owner/setup', { password: 'ownerpass1' });
  assert.equal(r.status, 403);
  r = await owner.call('POST', '/api/owner/setup', { password: 'short', setupCode: SETUP_CODE });
  assert.equal(r.status, 400);
  r = await owner.call('POST', '/api/owner/setup', { password: 'ownerpass1', setupCode: SETUP_CODE.toLowerCase() });
  assert.equal(r.status, 200);
  r = await owner.call('POST', '/api/owner/setup', { password: 'another123', setupCode: SETUP_CODE });
  assert.equal(r.status, 409, 'only once');

  const other = client();
  assert.equal((await other.call('POST', '/api/owner/login', { password: 'nope' })).status, 401);
  assert.equal((await other.call('POST', '/api/owner/login', { password: 'ownerpass1' })).status, 200);
  assert.equal((await other.call('GET', '/api/owner/venues')).status, 200);
});

test('onboarding: owner adds a venue, the venue sets a password via a one-time link', async () => {
  const r = await owner.call('POST', '/api/owner/venues', { name: 'Brunswick Ballroom' });
  assert.equal(r.data.venue.slug, 'brunswick-ballroom');
  assert.match(r.data.setupPath, /^\/setup\/[A-Za-z0-9_-]{30,}$/);
  const token = r.data.setupPath.split('/').pop();

  let list = await owner.call('GET', '/api/owner/venues');
  assert.equal(list.data.venues.find((v) => v.slug === 'brunswick-ballroom').status, 'pending');

  const v = client();
  let info = await v.call('GET', `/api/setup/${token}`);
  assert.equal(info.data.venue.name, 'Brunswick Ballroom');
  assert.equal(info.data.reset, false);

  assert.equal((await v.call('POST', `/api/setup/${token}`, { password: 'short' })).status, 400);
  assert.equal((await v.call('POST', `/api/setup/${token}`, { password: 'ballroom1' })).status, 200);
  const s = await v.call('GET', '/api/session');
  assert.equal(s.data.authed, true);
  assert.equal(s.data.venue.slug, 'brunswick-ballroom');

  info = await client().call('GET', `/api/setup/${token}`);
  assert.equal(info.status, 404, 'setup link is single-use');

  list = await owner.call('GET', '/api/owner/venues');
  assert.equal(list.data.venues.find((x) => x.slug === 'brunswick-ballroom').status, 'active');

  // Same name again gets a unique ID.
  const dup = await owner.call('POST', '/api/owner/venues', { name: 'Brunswick Ballroom' });
  assert.equal(dup.data.venue.slug, 'brunswick-ballroom-2');
  await owner.call('DELETE', `/api/owner/venues/${dup.data.venue.id}`, { confirm: 'brunswick-ballroom-2' });
});

test('venue login by ID, name or pasted link; wrong details give one generic error', async () => {
  const c = client();
  assert.equal((await c.call('POST', '/api/login', { venue: 'brunswick-ballroom', password: 'wrong' })).data.error, 'Venue ID or password is wrong.');
  assert.equal((await c.call('POST', '/api/login', { venue: 'no-such-venue', password: 'ballroom1' })).data.error, 'Venue ID or password is wrong.');
  assert.equal((await c.call('POST', '/api/login', { venue: 'Brunswick Ballroom', password: 'ballroom1' })).status, 200);
  assert.equal((await client().call('POST', '/api/login', { venue: 'https://guestlist.riderly.com.au/v/brunswick-ballroom', password: 'ballroom1' })).status, 200);
  assert.equal((await c.call('GET', '/api/session')).data.venue.name, 'Brunswick Ballroom');
  await c.call('POST', '/api/logout');
  assert.equal((await c.call('GET', '/api/session')).data.authed, false);
});

test('owner and venue sessions cannot use each other’s API', async () => {
  const { c } = await onboard('Owner Check Hall');
  assert.equal((await c.call('GET', '/api/owner/venues')).status, 401);
  assert.equal((await owner.call('GET', '/api/events')).status, 401);
});

test('mutations require a device name and JSON', async () => {
  const { c } = await onboard('Name Check Hall');
  const r = await c.call('POST', '/api/events', { name: 'X', date: '2026-10-01' }, { actor: '' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /name/i);
  const cookie = Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(base + '/api/events', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Actor': 'x' },
    body: 'name=x',
  });
  assert.equal(res.status, 415);
});

test('venues are isolated from each other', async () => {
  const a = await onboard('Isolation A');
  const b = await onboard('Isolation B');

  const ev = (await a.c.call('POST', '/api/events', { name: 'A show', date: '2026-10-10' })).data;
  const contrib = (await a.c.call('POST', `/api/events/${ev.id}/contributors`, { name: 'A promoter' })).data;
  const guest = (await a.c.call('POST', `/api/events/${ev.id}/guests`, { name: 'Secret Guest' })).data;

  assert.deepEqual((await b.c.call('GET', '/api/events')).data, [], 'B sees no events');
  const attempts = [
    ['GET', `/api/events/${ev.id}`],
    ['PUT', `/api/events/${ev.id}`, { name: 'hacked' }],
    ['DELETE', `/api/events/${ev.id}`],
    ['GET', `/api/events/${ev.id}/activity`],
    ['GET', `/api/events/${ev.id}/export.csv`],
    ['GET', `/api/events/${ev.id}/stream`],
    ['POST', `/api/events/${ev.id}/guests`, { name: 'Intruder' }],
    ['POST', `/api/events/${ev.id}/guests/import`, { text: 'Intruder' }],
    ['POST', `/api/events/${ev.id}/contributors`, { name: 'Intruder' }],
    ['PUT', `/api/guests/${guest.id}`, { name: 'hacked' }],
    ['DELETE', `/api/guests/${guest.id}`],
    ['POST', `/api/guests/${guest.id}/checkin`, {}],
    ['POST', `/api/guests/${guest.id}/checkout`, {}],
    ['PUT', `/api/contributors/${contrib.id}`, { name: 'hacked' }],
    ['POST', `/api/contributors/${contrib.id}/regenerate`, {}],
    ['DELETE', `/api/contributors/${contrib.id}`],
  ];
  for (const [method, p, body] of attempts) {
    const r = await b.c.call(method, p, body);
    assert.equal(r.status, 404, `${method} ${p} should be 404 for another venue, got ${r.status}`);
  }

  // B can't attach A's contributor to its own event either.
  const bEv = (await b.c.call('POST', '/api/events', { name: 'B show', date: '2026-10-10' })).data;
  const r = await b.c.call('POST', `/api/events/${bEv.id}/guests`, { name: 'X', contributorId: contrib.id });
  assert.equal(r.status, 404);

  const still = await a.c.call('GET', `/api/events/${ev.id}`);
  assert.equal(still.data.event.name, 'A show');
  assert.equal(still.data.guests.length, 1);
  assert.equal(still.data.guests[0].name, 'Secret Guest');
});

test('full flow: contributor link, allocations, door check in/out, attribution', async () => {
  const { c } = await onboard('Flow Hall');
  let r = await c.call('POST', '/api/events', { name: 'Big Band', date: '2026-10-10', doorsTime: '19:30' }, { actor: 'Will' });
  const eventId = r.data.id;
  assert.equal(r.data.createdBy, 'Will');

  r = await c.call('POST', `/api/events/${eventId}/contributors`, { name: 'Headliner TM', listType: 'Artist', allocation: 4 }, { actor: 'Will' });
  const contributor = r.data;
  const pub = client();

  r = await pub.call('GET', `/api/c/${contributor.token}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.venueName, 'Flow Hall');
  assert.equal(r.data.remaining, 4);
  assert.equal(r.data.contributor.token, undefined, 'token not echoed');

  r = await pub.call('POST', `/api/c/${contributor.token}/guests`, { name: 'Jane Smith', plusOnes: 2 }, { actor: 'Tour Manager Tom' });
  assert.equal(r.data.remaining, 1);
  const jane = r.data.guests[0];
  assert.equal(jane.addedBy, 'Tour Manager Tom');

  r = await pub.call('POST', `/api/c/${contributor.token}/guests`, { name: 'Too Many', plusOnes: 1 }, { actor: 'Tom' });
  assert.equal(r.status, 409, 'allocation enforced');
  assert.equal((await pub.call('GET', '/api/c/badtoken')).status, 404);

  r = await c.call('POST', `/api/events/${eventId}/guests`, { name: 'Mayor', vip: true, listType: 'Industry' }, { actor: 'Will' });
  const mayor = r.data;
  assert.equal(mayor.vip, true);

  r = await c.call('POST', `/api/events/${eventId}/guests`, { name: 'Extra', plusOnes: 3, contributorId: contributor.id }, { actor: 'Will' });
  assert.equal(r.status, 409);
  r = await c.call('POST', `/api/events/${eventId}/guests`, { name: 'Extra', plusOnes: 3, contributorId: contributor.id, force: true }, { actor: 'Will' });
  assert.equal(r.data.listType, 'Artist', 'inherits contributor list type');

  r = await c.call('POST', `/api/guests/${jane.id}/checkin`, { count: 2 }, { actor: 'Sam (Door 1)' });
  assert.equal(r.data.inside, 2);
  assert.equal(r.data.updatedBy, 'Sam (Door 1)');
  assert.equal((await c.call('POST', `/api/guests/${jane.id}/checkin`, { count: 2 }, { actor: 'Sam' })).status, 409);
  r = await c.call('POST', `/api/guests/${jane.id}/checkout`, { count: 1 }, { actor: 'Sam' });
  assert.equal(r.data.inside, 1);
  assert.equal(r.data.admitted, 2);
  r = await c.call('POST', `/api/guests/${jane.id}/checkin`, {}, { actor: 'Alex (Door 2)' });
  assert.equal(r.data.inside, 3);
  assert.equal((await c.call('POST', `/api/guests/${mayor.id}/checkout`, {}, { actor: 'Sam' })).status, 409);

  assert.equal((await pub.call('DELETE', `/api/c/${contributor.token}/guests/${jane.id}`, undefined, { actor: 'Tom' })).status, 409);
  assert.equal((await c.call('PUT', `/api/guests/${jane.id}`, { plusOnes: 0 }, { actor: 'Will' })).status, 409);
  assert.equal((await pub.call('DELETE', `/api/c/${contributor.token}/guests/${mayor.id}`, undefined, { actor: 'Tom' })).status, 404);

  r = await c.call('GET', `/api/events/${eventId}`);
  assert.equal(r.data.stats.expected, 3 + 1 + 4);
  assert.equal(r.data.stats.inside, 3);

  r = await c.call('GET', `/api/events/${eventId}/activity`);
  const actors = new Set(r.data.map((a) => a.actor));
  for (const who of ['Will', 'Tour Manager Tom', 'Sam (Door 1)', 'Alex (Door 2)']) assert.ok(actors.has(who), who);

  const csv = await c.call('GET', `/api/events/${eventId}/export.csv`);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /Jane Smith,2,3,Artist,,Headliner TM/);

  await c.call('PUT', `/api/contributors/${contributor.id}`, { active: false }, { actor: 'Will' });
  assert.equal((await pub.call('POST', `/api/c/${contributor.token}/guests`, { name: 'Late' }, { actor: 'Tom' })).status, 403);
  r = await c.call('POST', `/api/contributors/${contributor.id}/regenerate`, {}, { actor: 'Will' });
  assert.notEqual(r.data.token, contributor.token);
  assert.equal((await pub.call('GET', `/api/c/${contributor.token}`)).status, 404);
  assert.equal((await c.call('DELETE', `/api/contributors/${contributor.id}`, undefined, { actor: 'Will' })).status, 409);
});

test('cutoff, guest-list cap, paste import, CSV formula guard', async () => {
  const { c } = await onboard('Rules Hall');
  let r = await c.call('POST', '/api/events', { name: 'Past cutoff', date: '2026-10-11', cutoffAt: new Date(Date.now() - 60000).toISOString() });
  const token = (await c.call('POST', `/api/events/${r.data.id}/contributors`, { name: 'Promoter' })).data.token;
  assert.match((await client().call('GET', `/api/c/${token}`)).data.locked, /cutoff/);

  r = await c.call('POST', '/api/events', { name: 'Small', date: '2026-10-12', capacity: 2 });
  assert.equal((await c.call('POST', `/api/events/${r.data.id}/guests`, { name: 'A', plusOnes: 1 })).status, 200);
  assert.equal((await c.call('POST', `/api/events/${r.data.id}/guests`, { name: 'B' })).status, 409);

  assert.deepEqual(parseImport('Name,Plus\nJane Smith +2\nAlex, 1, photographer\nSam Lee, bring ID\n\n'), [
    { name: 'Jane Smith', plusOnes: 2, notes: '' },
    { name: 'Alex', plusOnes: 1, notes: 'photographer' },
    { name: 'Sam Lee', plusOnes: 0, notes: 'bring ID' },
  ]);
  r = await c.call('POST', '/api/events', { name: 'Import', date: '2026-10-13' });
  assert.equal((await c.call('POST', `/api/events/${r.data.id}/guests/import`, { text: 'A +1\nB\nC, 2', listType: 'Media' })).data.added, 3);

  await c.call('POST', `/api/events/${r.data.id}/guests`, { name: '=HYPERLINK("x")' });
  assert.match((await c.call('GET', `/api/events/${r.data.id}/export.csv`)).data, /"'=HYPERLINK\(""x""\)"/);
});

test('venue password change logs out its other devices only', async () => {
  const a = await onboard('Password Hall', 'firstpass1');
  const other = client();
  await other.call('POST', '/api/login', { venue: 'password-hall', password: 'firstpass1' });
  const b = await onboard('Bystander Hall');

  let r = await a.c.call('PUT', '/api/settings', { currentPassword: 'wrongwrong', newPassword: 'secondpass1' });
  assert.equal(r.status, 401);
  r = await a.c.call('PUT', '/api/settings', { currentPassword: 'firstpass1', newPassword: 'secondpass1', venueName: 'Password Hall 2' });
  assert.equal(r.status, 200);
  assert.equal(r.data.venue.name, 'Password Hall 2');
  assert.equal((await a.c.call('GET', '/api/events')).status, 200, 'this device stays in');
  assert.equal((await other.call('GET', '/api/events')).status, 401, 'other device logged out');
  assert.equal((await b.c.call('GET', '/api/events')).status, 200, 'other venues unaffected');
  assert.equal((await client().call('POST', '/api/login', { venue: 'password-hall', password: 'secondpass1' })).status, 200);
});

test('owner reset link: old password works until used, then all devices are logged out', async () => {
  const { c, venue } = await onboard('Reset Hall', 'oldpass123');
  const r = await owner.call('POST', `/api/owner/venues/${venue.id}/setup-link`);
  assert.equal(r.data.reset, true);
  assert.equal((await c.call('GET', '/api/events')).status, 200, 'still logged in before link is used');
  const token = r.data.setupPath.split('/').pop();
  const m = client();
  assert.equal((await m.call('GET', `/api/setup/${token}`)).data.reset, true);
  assert.equal((await m.call('POST', `/api/setup/${token}`, { password: 'newpass123' })).status, 200);
  assert.equal((await c.call('GET', '/api/events')).status, 401, 'old devices logged out');
  assert.equal((await client().call('POST', '/api/login', { venue: 'reset-hall', password: 'oldpass123' })).status, 401);
  assert.equal((await m.call('GET', '/api/events')).status, 200);
});

test('disabling a venue locks staff and contributor links; enabling restores', async () => {
  const { c, venue } = await onboard('Disable Hall');
  const ev = (await c.call('POST', '/api/events', { name: 'Show', date: '2026-10-20' })).data;
  const token = (await c.call('POST', `/api/events/${ev.id}/contributors`, { name: 'TM' })).data.token;

  await owner.call('PUT', `/api/owner/venues/${venue.id}`, { active: false });
  assert.equal((await c.call('GET', '/api/events')).status, 401);
  assert.equal((await client().call('POST', '/api/login', { venue: 'disable-hall', password: 'venuepass1' })).status, 403);
  assert.match((await client().call('GET', `/api/c/${token}`)).data.locked, /unavailable/);
  assert.equal((await client().call('POST', `/api/c/${token}/guests`, { name: 'X' }, { actor: 'TM' })).status, 403);

  await owner.call('PUT', `/api/owner/venues/${venue.id}`, { active: true });
  assert.equal((await c.call('GET', '/api/events')).status, 200);
});

test('deleting a venue needs its ID typed and removes all its data', async () => {
  const { c, venue } = await onboard('Delete Hall');
  const ev = (await c.call('POST', '/api/events', { name: 'Show', date: '2026-10-20' })).data;
  const token = (await c.call('POST', `/api/events/${ev.id}/contributors`, { name: 'TM' })).data.token;
  await c.call('POST', `/api/events/${ev.id}/guests`, { name: 'Gone Soon' });

  assert.equal((await owner.call('DELETE', `/api/owner/venues/${venue.id}`, { confirm: 'wrong' })).status, 400);
  assert.equal((await owner.call('DELETE', `/api/owner/venues/${venue.id}`, { confirm: 'delete-hall' })).status, 200);
  assert.equal((await c.call('GET', '/api/events')).status, 401);
  assert.equal((await client().call('GET', `/api/c/${token}`)).status, 404);
  const list = await owner.call('GET', '/api/owner/venues');
  assert.ok(!list.data.venues.some((v) => v.slug === 'delete-hall'));
});

test('owner list shows counts but never guest names', async () => {
  const list = await owner.call('GET', '/api/owner/venues');
  const json = JSON.stringify(list.data);
  assert.ok(!json.includes('Jane Smith') && !json.includes('Secret Guest'));
  const flow = list.data.venues.find((v) => v.slug === 'flow-hall');
  assert.ok(flow.guestCount >= 3 && flow.eventCount === 1);
});

test('request access: saved for the owner only, validated, honeypot drops bots', async () => {
  const pub = client();
  assert.equal((await pub.call('POST', '/api/request-access', { venueName: 'X', name: 'Y', email: 'nope' })).status, 400);
  assert.equal((await pub.call('POST', '/api/request-access', { venueName: 'Bot Bar', name: 'Bot', email: 'bot@x.com', website: 'http://spam' })).status, 200);
  const r = await pub.call('POST', '/api/request-access', { venueName: 'The Corner', name: 'Alex Rivers', email: 'alex@corner.com', phone: '0400 000 000', message: '800 cap' });
  assert.equal(r.status, 200);

  const list = await owner.call('GET', '/api/owner/venues');
  const reqs = list.data.requests;
  assert.ok(reqs.some((x) => x.venueName === 'The Corner' && x.email === 'alex@corner.com' && x.status === 'new'));
  assert.ok(!reqs.some((x) => x.venueName === 'Bot Bar'), 'honeypot submission not stored');

  const { c } = await onboard('Nosy Venue');
  assert.equal((await c.call('GET', '/api/owner/venues')).status, 401, 'venues cannot read requests');

  const id = reqs.find((x) => x.venueName === 'The Corner').id;
  assert.equal((await owner.call('PUT', `/api/owner/requests/${id}`, { status: 'done' })).status, 200);
  const after2 = await owner.call('GET', '/api/owner/venues');
  assert.equal(after2.data.requests.find((x) => x.id === id).status, 'done');
});

test('/health answers ok without login and leaks nothing', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('pages are served at their routes; path traversal is blocked', async () => {
  const expect = {
    '/': 'landing.js',
    '/app': 'app.js',
    '/login': 'login.js',
    '/v/brunswick-ballroom': 'login.js',
    '/setup/sometoken': 'setup.js',
    '/admin': 'admin.js',
    '/c/sometoken': 'contributor.js',
  };
  const guide = await fetch(`${base}/guide`);
  assert.equal(guide.status, 200);
  assert.match(await guide.text(), /Door cheat sheet/);
  for (const [p, script] of Object.entries(expect)) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
    assert.ok((await res.text()).includes(script), `${p} serves ${script}`);
  }
  const res = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.equal(res.status, 404);
});

test('an existing single-venue database is migrated into venue #1 with the same password', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-migrate-'));
  const file = path.join(dir, 'old.db');
  // Build a v1 database: no venues table, no events.venue_id, password in settings.
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, date TEXT NOT NULL, doors_time TEXT,
      capacity INTEGER, cutoff_at TEXT, notes TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, created_by TEXT NOT NULL);
  `);
  const { hashPassword } = require('../src/auth');
  old.prepare("INSERT INTO settings VALUES ('password_hash', ?), ('venue_name', 'Pockets Moorabbin'), ('password_version', '3')").run(hashPassword('legacypass1'));
  old.prepare("INSERT INTO events (name, date, created_at, created_by) VALUES ('Old Show', '2026-10-01', '2026-09-01', 'Will')").run();
  old.close();

  const db = openDb(file);
  const app = createApp(db);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.address().port}`;
  try {
    const c = client(() => url);
    const r = await c.call('POST', '/api/login', { venue: 'pockets-moorabbin', password: 'legacypass1' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const events = await c.call('GET', '/api/events');
    assert.equal(events.data.length, 1);
    assert.equal(events.data[0].name, 'Old Show');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'password_hash'").get().n, 0);
    db.close();
    const again = openDb(file); // running the migration twice is a no-op
    assert.equal(again.prepare('SELECT COUNT(*) AS n FROM venues').get().n, 1);
    again.close();
  } finally {
    app.closeAllConnections();
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('behind a proxy, login lockout is per client not global', async () => {
  const app = createApp(openDb(':memory:'), { trustProxy: true });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.address().port}`;
  const post = (body, ip) =>
    fetch(url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(body) });
  try {
    for (let i = 0; i < 10; i++) await post({ venue: 'x', password: 'bad' }, '6.6.6.6');
    assert.equal((await post({ venue: 'x', password: 'bad' }, '6.6.6.6')).status, 429);
    assert.equal((await post({ venue: 'x', password: 'bad' }, '2.2.2.2')).status, 401, 'other staff unaffected');
  } finally {
    app.closeAllConnections();
    app.close();
  }
});

test('backups snapshot the database and prune old copies', () => {
  const { backupNow } = require('../src/backup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-backup-'));
  const db = openDb(path.join(dir, 'live.db'));
  db.prepare("INSERT INTO settings (key, value) VALUES ('marker', 'backup-test')").run();
  const out = path.join(dir, 'backups');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'venuelist-2020-01-01.db'), 'old');
  const file = backupNow(db, out, 30, new Date('2026-09-29T12:00:00Z'));
  backupNow(db, out, 30, new Date('2026-09-29T13:00:00Z'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(out), ['venuelist-2026-09-29.db']);
  const copy = openDb(file);
  assert.equal(copy.prepare("SELECT value FROM settings WHERE key = 'marker'").get().value, 'backup-test');
  copy.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
