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
let appDb;

// Each client has its own cookie jar, like a separate browser.
function client(url = () => base) {
  const jar = {};
  const device = `test${Math.random().toString(36).slice(2, 12)}`;
  async function call(method, p, body, { actor = 'Tester', headers = {} } = {}) {
    const h = { 'Content-Type': 'application/json', 'X-Device': device, ...headers };
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

// Creates a venue as the owner, completes its setup link (staff + venue admin password), then the
// venue admin adds a manager code named "Manager". Returns logged-in staff and venue-admin clients.
async function onboard(name, pw = 'venuepass1', pin = '2468') {
  const r = await owner.call('POST', '/api/owner/venues', { name });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const token = r.data.setupPath.split('/').pop();
  const v = client();
  const adminPw = `admin-${pin}-pass`;
  const s = await v.call('POST', `/api/setup/${token}`, { password: pw, adminPassword: adminPw });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const admin = client();
  const slug = r.data.venue.slug;
  assert.equal((await admin.call('POST', `/api/vadmin/login/${slug}`, { password: adminPw })).status, 200);
  assert.equal((await admin.call('POST', '/api/vadmin/codes', { name: 'Manager', code: pin })).status, 200);
  return { c: v, venue: r.data.venue, token, admin, adminPw };
}

before(async () => {
  appDb = openDb(':memory:');
  server = createApp(appDb, { setupCode: SETUP_CODE });
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

  assert.equal(info.data.needsAdmin, true);
  assert.equal((await v.call('POST', `/api/setup/${token}`, { password: 'short', adminPassword: 'ballroom-admin' })).status, 400);
  assert.equal((await v.call('POST', `/api/setup/${token}`, { password: 'ballroom1' })).status, 400, 'venue admin password required at setup');
  assert.equal((await v.call('POST', `/api/setup/${token}`, { password: 'ballroom1', adminPassword: 'ballroom1' })).status, 400, 'must differ');
  assert.equal((await v.call('POST', `/api/setup/${token}`, { password: 'ballroom1', adminPassword: 'ballroom-admin' })).status, 200);
  assert.equal((await v.call('GET', '/api/session')).data.venue.hasManagerPin, true);
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
  assert.equal((await c.call('POST', '/api/login', { venue: 'brunswick-ballroom', password: 'wrong' })).data.error, 'Username or password is wrong.');
  assert.equal((await c.call('POST', '/api/login', { venue: 'no-such-venue', password: 'ballroom1' })).data.error, 'Username or password is wrong.');
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

  const ev = (await a.c.call('POST', '/api/events', { name: 'A show', date: '2026-10-10', overridePin: '2468' })).data;
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
  const bEv = (await b.c.call('POST', '/api/events', { name: 'B show', date: '2026-10-10', overridePin: '2468' })).data;
  const r = await b.c.call('POST', `/api/events/${bEv.id}/guests`, { name: 'X', contributorId: contrib.id });
  assert.equal(r.status, 404);

  const still = await a.c.call('GET', `/api/events/${ev.id}`);
  assert.equal(still.data.event.name, 'A show');
  assert.equal(still.data.guests.length, 1);
  assert.equal(still.data.guests[0].name, 'Secret Guest');
});

test('full flow: contributor link, allocations, door check in/out, attribution', async () => {
  const { c } = await onboard('Flow Hall');
  let r = await c.call('POST', '/api/events', { name: 'Big Band', date: '2026-10-10', doorsTime: '19:30', overridePin: '2468' }, { actor: 'Will' });
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
  assert.equal(r.data.code, 'override', 'over allocation needs the manager PIN');
  r = await c.call('POST', `/api/events/${eventId}/guests`, { name: 'Extra', plusOnes: 3, contributorId: contributor.id, overridePin: '2468' }, { actor: 'Will' });
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
  // The guest list shows who added each guest and who last checked them in.
  const listed = (await c.call('GET', `/api/events/${eventId}`)).data.guests.find((g) => g.id === jane.id);
  assert.equal(listed.lastInBy, 'Alex (Door 2)');
  assert.ok(listed.lastInAt);
  assert.ok(listed.addedBy);
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
  let r = await c.call('POST', '/api/events', { name: 'Past cutoff', date: '2026-10-11', cutoffAt: new Date(Date.now() - 60000).toISOString(), overridePin: '2468' });
  const token = (await c.call('POST', `/api/events/${r.data.id}/contributors`, { name: 'Promoter' })).data.token;
  assert.match((await client().call('GET', `/api/c/${token}`)).data.locked, /cutoff/);

  r = await c.call('POST', '/api/events', { name: 'Small', date: '2026-10-12', capacity: 2, overridePin: '2468' });
  assert.equal((await c.call('POST', `/api/events/${r.data.id}/guests`, { name: 'A', plusOnes: 1 })).status, 200);
  assert.equal((await c.call('POST', `/api/events/${r.data.id}/guests`, { name: 'B' })).data.code, 'override');

  assert.deepEqual(parseImport('Name,Plus\nJane Smith +2\nAlex, 1, photographer\nSam Lee, bring ID\n\n'), [
    { name: 'Jane Smith', plusOnes: 2, notes: '' },
    { name: 'Alex', plusOnes: 1, notes: 'photographer' },
    { name: 'Sam Lee', plusOnes: 0, notes: 'bring ID' },
  ]);
  r = await c.call('POST', '/api/events', { name: 'Import', date: '2026-10-13', overridePin: '2468' });
  assert.equal((await c.call('POST', `/api/events/${r.data.id}/guests/import`, { text: 'A +1\nB\nC, 2', listType: 'Media' })).data.added, 3);

  await c.call('POST', `/api/events/${r.data.id}/guests`, { name: '=HYPERLINK("x")' });
  assert.match((await c.call('GET', `/api/events/${r.data.id}/export.csv`)).data, /"'=HYPERLINK\(""x""\)"/);
});

test('staff can’t change the staff password or venue name; the venue admin can', async () => {
  const a = await onboard('Password Hall', 'firstpass1');
  const other = client();
  await other.call('POST', '/api/login', { venue: 'password-hall', password: 'firstpass1' });
  const b = await onboard('Bystander Hall');

  assert.equal((await a.c.call('PUT', '/api/settings', { newPassword: 'hacked123' })).status, 404, 'no staff route for it any more');
  assert.equal((await a.c.call('PUT', '/api/vadmin/staff-password', { password: 'hacked123' })).status, 401, 'staff login is not venue admin');

  assert.equal((await a.admin.call('PUT', '/api/vadmin/staff-password', { password: a.adminPw })).status, 400, 'must differ from admin password');
  assert.equal((await a.admin.call('PUT', '/api/vadmin/staff-password', { password: 'secondpass1' })).status, 200);
  assert.equal((await a.admin.call('PUT', '/api/vadmin/venue', { name: 'Password Hall 2' })).status, 200);
  assert.equal((await a.c.call('GET', '/api/events')).status, 401, 'staff devices logged out');
  assert.equal((await other.call('GET', '/api/events')).status, 401);
  assert.equal((await b.c.call('GET', '/api/events')).status, 200, 'other venues unaffected');
  const again = client();
  assert.equal((await again.call('POST', '/api/login', { venue: 'password-hall', password: 'secondpass1' })).status, 200);
  assert.equal((await again.call('GET', '/api/session')).data.venue.name, 'Password Hall 2');

  // Log out every phone without changing the password.
  assert.equal((await a.admin.call('POST', '/api/vadmin/logout-devices')).status, 200);
  assert.equal((await again.call('GET', '/api/events')).status, 401);
  assert.equal((await client().call('POST', '/api/login', { venue: 'password-hall', password: 'secondpass1' })).status, 200, 'same password still works');
});
test('owner reset link: old password works until used, then all devices are logged out', async () => {
  const { c, venue } = await onboard('Reset Hall', 'oldpass123');
  const r = await owner.call('POST', `/api/owner/venues/${venue.id}/setup-link`);
  assert.equal(r.data.reset, true);
  assert.equal((await c.call('GET', '/api/events')).status, 200, 'still logged in before link is used');
  const token = r.data.setupPath.split('/').pop();
  const m = client();
  assert.equal((await m.call('GET', `/api/setup/${token}`)).data.reset, true);
  assert.equal((await m.call('GET', `/api/setup/${token}`)).data.needsAdmin, false, 'reset keeps the venue admin password');
  assert.equal((await m.call('POST', `/api/setup/${token}`, { password: 'newpass123' })).status, 200);
  assert.equal((await c.call('GET', '/api/events')).status, 401, 'old devices logged out');
  assert.equal((await client().call('POST', '/api/login', { venue: 'reset-hall', password: 'oldpass123' })).status, 401);
  assert.equal((await m.call('GET', '/api/events')).status, 200);
});

test('disabling a venue locks staff and contributor links; enabling restores', async () => {
  const { c, venue } = await onboard('Disable Hall');
  const ev = (await c.call('POST', '/api/events', { name: 'Show', date: '2026-10-20', overridePin: '2468' })).data;
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
  const ev = (await c.call('POST', '/api/events', { name: 'Show', date: '2026-10-20', overridePin: '2468' })).data;
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

test('applications: approving sends a setup link where the venue picks its username and passwords', async () => {
  const pub = client();
  const form = { venueName: 'The Corner', suburb: 'Richmond', name: 'Alex Rivers', email: 'alex@corner.com', phone: '0400 000 000', showsPerMonth: '11–20', capacity: 800, ticketing: 'Moshtix', message: 'Start in March' };
  assert.equal((await pub.call('POST', '/api/apply', { ...form, email: 'nope' })).status, 400);
  assert.equal((await pub.call('POST', '/api/apply', { ...form, name: '' })).status, 400);
  assert.equal((await pub.call('POST', '/api/apply', { ...form, venueName: 'Bot Bar', website: 'http://spam' })).status, 200);
  const r = await pub.call('POST', '/api/apply', form);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { status: 'pending' });
  assert.equal((await client().call('POST', '/api/signup', { venueName: 'Old Form Bar', name: 'Old', email: 'old@form.com', password: 'ignored1', username: 'ignored' })).status, 200, 'the old address still works; logins are ignored');

  let list = await owner.call('GET', '/api/owner/venues');
  const req = list.data.requests.find((x) => x.venueName === 'The Corner');
  assert.equal(req.suburb, 'Richmond');
  assert.equal(req.showsPerMonth, '11–20');
  assert.equal(req.capacity, 800);
  assert.equal(req.ticketing, 'Moshtix');
  assert.equal(req.username, null);
  assert.ok(!list.data.requests.some((x) => x.venueName === 'Bot Bar'), 'honeypot submission not stored');

  const { c } = await onboard('Nosy Venue');
  assert.equal((await c.call('POST', `/api/owner/requests/${req.id}/approve`)).status, 401, 'venues cannot approve');

  const ok = await owner.call('POST', `/api/owner/requests/${req.id}/approve`);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.live, false);
  assert.equal(ok.data.venue.slug, 'the-corner', 'suggested from the venue name');
  assert.equal(ok.data.emailed, false, 'no email set up in these tests');
  assert.equal((await owner.call('POST', `/api/owner/requests/${req.id}/approve`)).status, 409, 'only once');
  const token = ok.data.setupPath.split('/').pop();

  const v = client();
  const info = (await v.call('GET', `/api/setup/${token}`)).data;
  assert.equal(info.canChooseUsername, true);
  assert.equal(info.needsAdmin, true);
  const setup = { username: 'Corner Hotel', password: 'cornerpass1', adminPassword: 'corner-admin-1' };
  assert.equal((await v.call('POST', `/api/setup/${token}`, { ...setup, username: 'admin' })).status, 409, 'reserved');
  assert.equal((await v.call('POST', `/api/setup/${token}`, { ...setup, username: 'nosy-venue' })).status, 409, 'taken');
  assert.equal((await v.call('POST', `/api/setup/${token}`, { ...setup, adminPassword: 'cornerpass1' })).status, 400, 'passwords must differ');
  const done = await v.call('POST', `/api/setup/${token}`, setup);
  assert.equal(done.status, 200);
  assert.equal(done.data.venue.slug, 'corner-hotel');
  assert.equal((await v.call('GET', '/api/session')).data.venue.name, 'The Corner', 'logged in straight away');

  const staff = client();
  assert.equal((await staff.call('POST', '/api/login', { username: 'corner-hotel', password: 'cornerpass1' })).status, 200);
  assert.equal((await client().call('POST', '/api/vadmin/login/corner-hotel', { password: 'corner-admin-1' })).status, 200);
  const adm = client();
  await adm.call('POST', '/api/vadmin/login/corner-hotel', { password: 'corner-admin-1' });
  assert.equal((await adm.call('GET', '/api/vadmin/overview')).data.venue.defaultCapacity, 800, 'capacity from the application');
  assert.equal((await client().call('POST', `/api/setup/${token}`, setup)).status, 404, 'setup link works once');
  list = await owner.call('GET', '/api/owner/venues');
  assert.equal(list.data.venues.find((x) => x.slug === 'corner-hotel').status, 'active');
});

test('auto-approve: every application is sent a setup link straight away', async () => {
  await owner.call('PUT', '/api/owner/settings', { autoApprove: true });
  const r = await client().call('POST', '/api/apply', { venueName: 'Instant Bar', name: 'Kim', email: 'kim@instant.com' });
  assert.equal(r.data.status, 'pending', 'nobody is logged in from the home page');
  let venue;
  for (let i = 0; i < 20 && !venue; i++) {
    await new Promise((res) => setTimeout(res, 20));
    venue = (await owner.call('GET', '/api/owner/venues')).data.venues.find((x) => x.name === 'Instant Bar');
  }
  assert.ok(venue, 'venue created');
  assert.equal(venue.status, 'pending', 'waiting for them to open the setup link');
  assert.equal(venue.setupLinkActive, true);
  await owner.call('PUT', '/api/owner/settings', { autoApprove: false });
  await client().call('POST', '/api/apply', { venueName: 'Later Bar', name: 'Lee', email: 'lee@later.com' });
  const later = (await owner.call('GET', '/api/owner/venues')).data.requests.find((x) => x.venueName === 'Later Bar');
  assert.equal(later.status, 'new');
});

test('owner can choose a username when adding a venue', async () => {
  const r = await owner.call('POST', '/api/owner/venues', { name: 'Some Long Venue Name', username: 'SLVN' });
  assert.equal(r.data.venue.slug, 'slvn');
  assert.equal((await owner.call('POST', '/api/owner/venues', { name: 'Again', username: 'slvn' })).status, 409);
});

test('door counter: shared +/−, never below zero, peak and totals', async () => {
  const { c } = await onboard('Counter Hall');
  const ev = (await c.call('POST', '/api/events', { name: 'Gig', date: '2026-10-30', venueCapacity: 3, overridePin: '2468' })).data;
  assert.equal(ev.headcount.capacity, 3);
  let r = await c.call('POST', `/api/events/${ev.id}/count`, { delta: 1 }, { actor: 'Sam' });
  r = await c.call('POST', `/api/events/${ev.id}/count`, { delta: 2 }, { actor: 'Alex' });
  assert.equal(r.data.count, 3);
  r = await c.call('POST', `/api/events/${ev.id}/count`, { delta: -1 }, { actor: 'Sam' });
  assert.deepEqual(r.data, { count: 2, capacity: 3, peak: 3, totalIn: 3, totalOut: 1 });
  r = await c.call('POST', `/api/events/${ev.id}/count`, { delta: -5 }, { actor: 'Sam' });
  assert.equal(r.data.count, 0, 'never below zero');
  assert.equal(r.data.totalOut, 3);
  const logRows = (await c.call('GET', `/api/events/${ev.id}/count/log`)).data;
  assert.equal(logRows[0].actor, 'Sam');
  const other = await onboard('Counter Other');
  assert.equal((await other.c.call('POST', `/api/events/${ev.id}/count`, { delta: 1 })).status, 404, 'other venues cannot touch it');
});

test('manager override: confirm before any codes exist, a named code after', async () => {
  const { c, venue, admin } = await onboard('Override Hall');
  // An older venue with no admin password or codes yet.
  const saved = appDb.prepare('SELECT admin_password_hash FROM venues WHERE id = ?').get(venue.id).admin_password_hash;
  appDb.prepare('UPDATE venues SET admin_password_hash = NULL WHERE id = ?').run(venue.id);
  appDb.prepare('DELETE FROM manager_codes WHERE venue_id = ?').run(venue.id);
  const ev = (await c.call('POST', '/api/events', { name: 'Full', date: '2026-10-31', venueCapacity: 2 })).data;
  await c.call('POST', `/api/events/${ev.id}/count`, { delta: 2 });
  let r = await c.call('POST', `/api/events/${ev.id}/count`, { delta: 1 });
  assert.equal(r.data.code, 'confirm');
  r = await c.call('POST', `/api/events/${ev.id}/count`, { delta: 1, force: true }, { actor: 'Sam' });
  assert.equal(r.data.count, 3);

  // Venue admin comes back and adds named manager codes.
  appDb.prepare('UPDATE venues SET admin_password_hash = ? WHERE id = ?').run(saved, venue.id);
  assert.equal((await admin.call('POST', '/api/vadmin/codes', { name: 'JT', code: '12' })).status, 400);
  const jt = (await admin.call('POST', '/api/vadmin/codes', { name: 'JT', code: '4821' })).data;
  const nick = (await admin.call('POST', '/api/vadmin/codes', { name: 'Nick', code: '7300' })).data;
  assert.equal((await admin.call('POST', '/api/vadmin/codes', { name: 'Dup', code: '4821' })).status, 409, 'codes must be unique');
  assert.equal((await c.call('GET', '/api/session')).data.venue.hasManagerPin, true);

  r = await c.call('POST', `/api/events/${ev.id}/count`, { delta: 1, force: true });
  assert.equal(r.data.code, 'override', 'force alone no longer works');
  r = await c.call('POST', `/api/events/${ev.id}/count`, { delta: 1, overridePin: '0000' });
  assert.match(r.data.error, /Wrong manager code/);
  r = await c.call('POST', `/api/events/${ev.id}/count`, { delta: 1, overridePin: '4821' }, { actor: 'Sam' });
  assert.equal(r.data.count, 4);
  r = await c.call('POST', `/api/events/${ev.id}/count`, { delta: 1, overridePin: '7300' }, { actor: 'Alex' });
  assert.equal(r.data.count, 5);
  r = await c.call('POST', `/api/events/${ev.id}/count`, { delta: 1, overridePin: 'admin-2468-pass' }, { actor: 'Kim' });
  assert.equal(r.data.count, 6, 'the venue admin password works as an override too');
  assert.equal((await c.call('POST', `/api/events/${ev.id}/count`, { delta: -1 })).status, 200, 'going down never needs a code');

  // Rule changes need a code; other edits don't.
  assert.equal((await c.call('PUT', `/api/events/${ev.id}`, { venueCapacity: 900 })).data.code, 'override');
  assert.equal((await c.call('PUT', `/api/events/${ev.id}`, { venueCapacity: 900, overridePin: '4821' })).status, 200);
  assert.equal((await c.call('PUT', `/api/events/${ev.id}/count`, { count: 0 })).data.code, 'override');
  assert.equal((await c.call('PUT', `/api/events/${ev.id}`, { name: 'Renamed' })).status, 200);
  const ct = (await c.call('POST', `/api/events/${ev.id}/contributors`, { name: 'TM', allocation: 1 })).data;
  assert.equal((await c.call('POST', `/api/events/${ev.id}/guests`, { name: 'A', plusOnes: 1, contributorId: ct.id, force: true })).data.code, 'override');
  assert.equal((await c.call('PUT', `/api/contributors/${ct.id}`, { allocation: 50 })).data.code, 'override');
  assert.equal((await c.call('DELETE', `/api/events/${ev.id}`)).data.code, 'override');

  // The log says which manager approved each override.
  const act = (await c.call('GET', `/api/events/${ev.id}/activity`)).data.filter((a) => a.action === 'override');
  assert.ok(act.some((a) => a.actor === 'Sam' && /approved by JT$/.test(a.detail)));
  assert.ok(act.some((a) => a.actor === 'Alex' && /approved by Nick$/.test(a.detail)));
  assert.ok(act.some((a) => a.actor === 'Kim' && /approved by Venue admin$/.test(a.detail)));
  assert.ok(act.some((a) => /confirmed — no manager codes set/.test(a.detail)));
  const overview = (await admin.call('GET', '/api/vadmin/overview')).data;
  assert.ok(overview.overrides.length >= 4, 'overrides log in the venue admin portal');
  assert.ok(overview.codes.find((x) => x.name === 'JT').lastUsedAt);

  // Revoke Nick: his code stops working; JT's still works. Reset JT's code.
  assert.equal((await admin.call('PUT', `/api/vadmin/codes/${nick.id}`, { active: false })).status, 200);
  assert.equal((await c.call('PUT', `/api/events/${ev.id}/count`, { count: 1, overridePin: '7300' })).status, 403);
  assert.equal((await admin.call('PUT', `/api/vadmin/codes/${jt.id}`, { code: '9999' })).status, 200);
  assert.equal((await c.call('PUT', `/api/events/${ev.id}/count`, { count: 1, overridePin: '4821' })).status, 403, 'old code dead');
  assert.equal((await c.call('PUT', `/api/events/${ev.id}/count`, { count: 1, overridePin: '9999' })).status, 200);
  assert.equal((await admin.call('DELETE', `/api/vadmin/codes/${nick.id}`)).status, 200);
});
test('guest list check-ins count toward capacity only when switched on', async () => {
  const { c } = await onboard('Combined Hall');
  const ev = (await c.call('POST', '/api/events', { name: 'Show', date: '2026-11-01', venueCapacity: 2, overridePin: '2468' })).data;
  const g = (await c.call('POST', `/api/events/${ev.id}/guests`, { name: 'Pat', plusOnes: 2 })).data;
  let r = await c.call('POST', `/api/guests/${g.id}/checkin`, { count: 1 });
  assert.equal((await c.call('GET', `/api/events/${ev.id}`)).data.event.headcount.count, 0, 'off by default');
  await c.call('PUT', `/api/events/${ev.id}`, { countGuestlist: true, overridePin: '2468' });
  r = await c.call('POST', `/api/guests/${g.id}/checkin`, { count: 1 });
  assert.equal((await c.call('GET', `/api/events/${ev.id}`)).data.event.headcount.count, 1);
  r = await c.call('POST', `/api/guests/${g.id}/checkout`, { count: 2 });
  assert.equal((await c.call('GET', `/api/events/${ev.id}`)).data.event.headcount.count, 0);
  await c.call('POST', `/api/events/${ev.id}/count`, { delta: 2 });
  r = await c.call('POST', `/api/guests/${g.id}/checkin`, { count: 1 });
  assert.equal(r.data.code, 'override', 'check-in over capacity needs the manager PIN');
  r = await c.call('POST', `/api/guests/${g.id}/checkin`, { count: 1, overridePin: '2468' });
  assert.equal(r.status, 200);
});

test('owner can reset the staff password or the venue admin password — separately', async () => {
  const { c, venue, admin } = await onboard('Direct Hall', 'oldpass123', '1111');
  const staff = client();
  await staff.call('POST', '/api/login', { username: 'direct-hall', password: 'oldpass123' });
  assert.equal((await c.call('PUT', `/api/owner/venues/${venue.id}/password`, { password: 'hacked123' })).status, 401, 'venues cannot use it');

  // Admin password set directly: portal logs out, staff unaffected.
  assert.equal((await owner.call('PUT', `/api/owner/venues/${venue.id}/admin-password`, { password: 'short' })).status, 400);
  assert.equal((await owner.call('PUT', `/api/owner/venues/${venue.id}/admin-password`, { password: 'new-admin-pass' })).status, 200);
  assert.equal((await admin.call('GET', '/api/vadmin/overview')).status, 401, 'old portal session ended');
  assert.equal((await staff.call('GET', '/api/events')).status, 200, 'staff not logged out');
  const a2 = client();
  assert.equal((await a2.call('POST', '/api/vadmin/login/direct-hall', { password: 'admin-1111-pass' })).status, 401);
  assert.equal((await a2.call('POST', '/api/vadmin/login/direct-hall', { password: 'new-admin-pass' })).status, 200);

  // Admin reset link: 24h, single use, venue admin chooses the new one.
  const link = await owner.call('POST', `/api/owner/venues/${venue.id}/admin-link`);
  assert.match(link.data.adminPath, /^\/venue-admin\/reset\/[A-Za-z0-9_-]{30,}$/);
  assert.equal((await c.call('POST', `/api/owner/venues/${venue.id}/admin-link`)).status, 401, 'staff cannot make admin links');
  const token = link.data.adminPath.split('/').pop();
  const m = client();
  assert.equal((await m.call('GET', `/api/venue-admin/reset/${token}`)).data.venue.slug, 'direct-hall');
  assert.equal((await a2.call('GET', '/api/vadmin/overview')).status, 200, 'current admin password works until the link is used');
  assert.equal((await m.call('POST', `/api/venue-admin/reset/${token}`, { password: 'linked-admin-pw' })).status, 200);
  assert.equal((await m.call('POST', `/api/venue-admin/reset/${token}`, { password: 'again-admin-pw' })).status, 404, 'single use');
  assert.equal((await m.call('GET', '/api/vadmin/overview')).status, 200, 'logged in to the portal by the link');
  assert.equal((await a2.call('GET', '/api/vadmin/overview')).status, 401);

  // Staff password set directly: every staff device logged out, admin password and codes unchanged.
  assert.equal((await owner.call('PUT', `/api/owner/venues/${venue.id}/password`, { password: 'newpass456' })).status, 200);
  assert.equal((await staff.call('GET', '/api/events')).status, 401);
  const again = client();
  assert.equal((await again.call('POST', '/api/login', { username: 'direct-hall', password: 'newpass456' })).status, 200);
  const ev = (await again.call('POST', '/api/events', { name: 'X', date: '2026-11-02', overridePin: '1111' })).data;
  assert.ok(ev.id, 'manager code survives a password reset');
});
test('creating an event needs the manager PIN once the venue has one', async () => {
  const { c, venue } = await onboard('Create Hall', 'venuepass1', '5151');
  let r = await c.call('POST', '/api/events', { name: 'Unapproved', date: '2026-11-05' });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'override');
  assert.equal((await c.call('POST', '/api/events', { name: 'Bad', date: '2026-11-05', overridePin: '0000' })).status, 403);
  r = await c.call('POST', '/api/events', { name: '', date: '2026-11-05' });
  assert.equal(r.status, 400, 'bad input is rejected before asking for the PIN');
  r = await c.call('POST', '/api/events', { name: 'Approved', date: '2026-11-05', overridePin: '5151' }, { actor: 'Sam' });
  assert.equal(r.status, 200);
  const act = (await c.call('GET', `/api/events/${r.data.id}/activity`)).data;
  assert.ok(act.some((a) => a.action === 'event.create' && a.actor === 'Sam' && a.detail === 'approved by Manager'));
  assert.equal((await c.call('GET', '/api/events')).data.length, 1, 'only the approved event exists');

  // A venue with no admin password or codes yet can still create events.
  appDb.prepare('UPDATE venues SET admin_password_hash = NULL WHERE id = ?').run(venue.id);
  appDb.prepare('DELETE FROM manager_codes WHERE venue_id = ?').run(venue.id);
  assert.equal((await c.call('POST', '/api/events', { name: 'No PIN yet', date: '2026-11-06' })).status, 200);
});

test('removing a guest who has already arrived needs a manager', async () => {
  const { c } = await onboard('Remove Hall');
  const ev = (await c.call('POST', '/api/events', { name: 'Show', date: '2026-11-10', overridePin: '2468' })).data;
  const waiting = (await c.call('POST', `/api/events/${ev.id}/guests`, { name: 'Not Here Yet' })).data;
  const arrived = (await c.call('POST', `/api/events/${ev.id}/guests`, { name: 'Already In' })).data;
  await c.call('POST', `/api/guests/${arrived.id}/checkin`, {});
  assert.equal((await c.call('DELETE', `/api/guests/${waiting.id}`)).status, 200, 'not arrived: no PIN needed');
  assert.equal((await c.call('DELETE', `/api/guests/${arrived.id}`)).data.code, 'override');
  assert.equal((await c.call('DELETE', `/api/guests/${arrived.id}`, { overridePin: '2468' }, { actor: 'Sam' })).status, 200);
  const act = (await c.call('GET', `/api/events/${ev.id}/activity`)).data;
  assert.ok(act.some((a) => a.action === 'override' && a.actor === 'Sam' && /already checked in/.test(a.detail)));
});

test('wrong attempts lock out one phone, not the whole venue Wi-Fi', async () => {
  const app = createApp(openDb(':memory:'), { trustProxy: true });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.address().port}`;
  const login = (device, ip = '9.9.9.9') => fetch(url + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, 'X-Device': device },
    body: JSON.stringify({ username: 'nobody', password: 'wrong' }),
  });
  try {
    for (let i = 0; i < 10; i++) await login('phone-aaaaaaaa');
    assert.equal((await login('phone-aaaaaaaa')).status, 429, 'the guessing phone is locked out');
    assert.equal((await login('phone-bbbbbbbb')).status, 401, 'another phone on the same Wi-Fi still gets to try');
    // A per-network ceiling still stops someone rotating device ids.
    let last;
    for (let i = 0; i < 60; i++) last = await login(`rotating-${String(i).padStart(4, '0')}`);
    assert.equal(last.status, 429);
    assert.equal((await login('phone-cccccccc', '8.8.8.8')).status, 401, 'other networks unaffected');
  } finally {
    app.closeAllConnections();
    app.close();
  }
});

test('only the public pages are indexable; robots.txt and sitemap', async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.headers.get('x-robots-tag'), null);
  for (const p of ['/guide', '/privacy', '/terms']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('x-robots-tag'), null, p);
  }
  for (const p of ['/app', '/admin', '/login', '/c/x', '/setup/x', '/v/x', '/v/x/admin', '/venue-admin/reset/x']) {
    assert.match((await fetch(base + p)).headers.get('x-robots-tag') || '', /noindex/, p);
  }
  const robots = await (await fetch(`${base}/robots.txt`)).text();
  assert.match(robots, /Disallow: \//);
  assert.match(robots, /Sitemap: https:\/\/guestlist\.riderly\.com\.au\/sitemap\.xml/);
  const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
  assert.match(sitemap, /<loc>https:\/\/guestlist\.riderly\.com\.au\/guide<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/guestlist\.riderly\.com\.au\/privacy<\/loc>/);
  assert.match(robots, /Allow: \/terms/);
});

test('owner password can be recovered from the server', async () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-owner-'));
  const file = path.join(dir, 'v.db');
  const db = openDb(file);
  const app = createApp(db);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.address().port}`;
  try {
    const o = client(() => url);
    await o.call('POST', '/api/owner/setup', { password: 'forgotten-one' });
    assert.equal((await o.call('GET', '/api/owner/venues')).status, 200);
    const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'reset-owner-password.js')], {
      env: { ...process.env, DB_FILE: file },
    }).toString();
    const pw = out.match(/New owner password:\s+(\S+)/)[1];
    assert.match(pw, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    assert.equal((await o.call('GET', '/api/owner/venues')).status, 401, 'old sessions logged out');
    assert.equal((await client(() => url).call('POST', '/api/owner/login', { password: 'forgotten-one' })).status, 401);
    assert.equal((await client(() => url).call('POST', '/api/owner/login', { password: pw })).status, 200);
  } finally {
    app.closeAllConnections();
    app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('venue admin portal: login, isolation between venues, defaults', async () => {
  const a = await onboard('Portal A');
  const b = await onboard('Portal B', 'venuepass1', '5757');
  // A's admin session can't be used against B, and a wrong password is refused.
  assert.equal((await client().call('POST', '/api/vadmin/login/portal-b', { password: a.adminPw })).status, 401);
  assert.equal((await client().call('POST', '/api/vadmin/login/portal-b', { password: 'admin-5757-pass' })).status, 200, 'B has its own');
  const bCode = (await b.admin.call('GET', '/api/vadmin/overview')).data.codes[0];
  assert.equal((await a.admin.call('PUT', `/api/vadmin/codes/${bCode.id}`, { active: false })).status, 404, 'cannot touch another venue’s codes');
  assert.equal((await a.admin.call('DELETE', `/api/vadmin/codes/${bCode.id}`)).status, 404);
  assert.equal((await a.c.call('GET', '/api/vadmin/overview')).status, 401, 'staff login is not venue admin');
  assert.equal((await owner.call('GET', '/api/vadmin/overview')).status, 401);
  const sess = await a.admin.call('GET', '/api/vadmin/session/portal-a');
  assert.equal(sess.data.authed, true);
  assert.equal((await a.admin.call('GET', '/api/vadmin/session/portal-b')).data.authed, false);

  // Defaults apply to new events unless the event says otherwise.
  assert.equal((await a.admin.call('PUT', '/api/vadmin/venue', { defaultCapacity: 450, defaultCountGuestlist: true, email: 'gm@portal-a.com' })).status, 200);
  assert.equal((await a.admin.call('PUT', '/api/vadmin/venue', { email: 'nope' })).status, 400);
  const d = (await a.c.call('GET', '/api/session')).data.venue.defaults;
  assert.deepEqual(d, { capacity: 450, countGuestlist: true });
  let ev = (await a.c.call('POST', '/api/events', { name: 'Default', date: '2026-12-01', overridePin: '2468' })).data;
  assert.equal(ev.venueCapacity, 450);
  assert.equal(ev.countGuestlist, true);
  ev = (await a.c.call('POST', '/api/events', { name: 'Custom', date: '2026-12-02', venueCapacity: 120, countGuestlist: false, overridePin: '2468' })).data;
  assert.equal(ev.venueCapacity, 120);
  assert.equal(ev.countGuestlist, false);

  // Changing the admin password needs the current one and keeps this session.
  assert.equal((await a.admin.call('PUT', '/api/vadmin/admin-password', { currentPassword: 'wrong-pass', newPassword: 'newadminpw1' })).status, 401);
  assert.equal((await a.admin.call('PUT', '/api/vadmin/admin-password', { currentPassword: a.adminPw, newPassword: 'newadminpw1' })).status, 200);
  assert.equal((await a.admin.call('GET', '/api/vadmin/overview')).status, 200);
});

test('older venue with only a manager code can set up its admin password', async () => {
  const { venue } = await onboard('Legacy Admin Hall', 'venuepass1', '3131');
  appDb.prepare('UPDATE venues SET admin_password_hash = NULL WHERE id = ?').run(venue.id);
  const a = client();
  assert.equal((await a.call('GET', '/api/vadmin/session/legacy-admin-hall')).data.needsSetup, true);
  assert.equal((await a.call('POST', '/api/vadmin/login/legacy-admin-hall', { managerCode: '0000', newPassword: 'fresh-admin-1' })).status, 401);
  assert.equal((await a.call('POST', '/api/vadmin/login/legacy-admin-hall', { managerCode: '3131', newPassword: 'fresh-admin-1' })).status, 200);
  assert.equal((await a.call('GET', '/api/vadmin/overview')).status, 200);
  assert.equal((await client().call('POST', '/api/vadmin/login/legacy-admin-hall', { password: 'fresh-admin-1' })).status, 200);
});

test('guest details are removed after the venue’s retention period; counts stay', async () => {
  const { c, admin } = await onboard('Retention Hall');
  const old = (await c.call('POST', '/api/events', { name: 'Old show', date: '2026-01-10', overridePin: '2468' })).data;
  const recent = (await c.call('POST', '/api/events', { name: 'Recent show', date: '2026-09-20', overridePin: '2468' })).data;
  const g = (await c.call('POST', `/api/events/${old.id}/guests`, { name: 'Private Person', plusOnes: 1, notes: 'phone 0400' })).data;
  await c.call('POST', `/api/guests/${g.id}/checkin`, {});
  await c.call('POST', `/api/events/${recent.id}/guests`, { name: 'Still Here' });
  assert.equal((await admin.call('PUT', '/api/vadmin/venue', { retentionDays: 3 })).status, 400, 'at least a week');
  assert.equal((await admin.call('PUT', '/api/vadmin/venue', { retentionDays: 90 })).status, 200);
  const n = server.purgeExpired(new Date('2026-09-29T12:00:00Z'));
  assert.ok(n >= 1);
  const o = (await c.call('GET', `/api/events/${old.id}`)).data;
  assert.equal(o.guests[0].name, 'Guest (removed)');
  assert.equal(o.guests[0].notes, null);
  assert.equal(o.stats.admitted, 2, 'counts kept for reports');
  const act = (await c.call('GET', `/api/events/${old.id}/activity`)).data;
  assert.ok(!JSON.stringify(act).includes('Private Person'), 'name gone from the activity log too');
  assert.equal((await c.call('GET', `/api/events/${recent.id}`)).data.guests[0].name, 'Still Here');
  assert.equal(server.purgeExpired(new Date('2026-09-29T12:00:00Z')), 0, 'runs once per event');
});

test('an older single manager PIN becomes a manager code called "Manager"', () => {
  const db = openDb(':memory:');
  const { hashPassword } = require('../src/auth');
  db.prepare("INSERT INTO venues (slug, name, created_at) VALUES ('pin-venue', 'PIN Venue', '2026-01-01')").run();
  db.prepare("UPDATE venues SET manager_pin_hash = ? WHERE slug = 'pin-venue'").run(hashPassword('8080'));
  db.close;
  // Re-running migrations (as on the next start) moves it across.
  const { migrate } = require('../src/db');
  (migrate || (() => {}))(db);
  const codes = db.prepare('SELECT name FROM manager_codes').all();
  assert.deepEqual(codes.map((c) => c.name), ['Manager']);
  assert.equal(db.prepare("SELECT manager_pin_hash FROM venues WHERE slug = 'pin-venue'").get().manager_pin_hash, null);
});

test('offline taps: a retried sync with the same op id is applied only once', async () => {
  const { c } = await onboard('Offline Hall');
  const ev = (await c.call('POST', '/api/events', { name: 'Show', date: '2026-11-20', overridePin: '2468' })).data;
  const g = (await c.call('POST', `/api/events/${ev.id}/guests`, { name: 'Pat', plusOnes: 3 })).data;
  const h1 = { headers: { 'X-Op-Id': 'op-aaaaaaaaaaaa', 'X-Op-At': '2026-11-20T10:00:00Z' } };
  const first = await c.call('POST', `/api/guests/${g.id}/checkin`, { count: 2 }, h1);
  const again = await c.call('POST', `/api/guests/${g.id}/checkin`, { count: 2 }, h1);
  assert.equal(first.data.inside, 2);
  assert.equal(again.data.inside, 2, 'replayed, not re-applied');
  const h2 = { headers: { 'X-Op-Id': 'op-bbbbbbbbbbbb' } };
  await c.call('POST', `/api/events/${ev.id}/count`, { delta: 1 }, h2);
  const r = await c.call('POST', `/api/events/${ev.id}/count`, { delta: 1 }, h2);
  assert.equal(r.data.count, 1);
  assert.equal((await c.call('POST', `/api/events/${ev.id}/count`, { delta: 1 }, { headers: { 'X-Op-Id': 'bad id!' } })).status, 400);
  const act = (await c.call('GET', `/api/events/${ev.id}/activity`)).data;
  assert.ok(act.some((a) => /tapped while offline/.test(a.detail || '')));
  // Another venue can't replay (or read) this venue's op ids.
  const other = await onboard('Offline Other');
  const ev2 = (await other.c.call('POST', '/api/events', { name: 'X', date: '2026-11-20', overridePin: '2468' })).data;
  const o = await other.c.call('POST', `/api/events/${ev2.id}/count`, { delta: 1 }, h2);
  assert.equal(o.data.count, 1);
});

// A tiny fake SMTP server that records what it's sent.
function fakeSmtp() {
  const net = require('node:net');
  const sent = [];
  const srv = net.createServer((sock) => {
    let state = 'cmd';
    let data = '';
    let msg = {};
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (state === 'data') {
        data += text;
        if (data.endsWith('\r\n.\r\n')) {
          const [head, body] = data.split('\r\n\r\n');
          msg.subject = (head.match(/^Subject: (.*)$/m) || [])[1];
          msg.text = Buffer.from(body.replace(/\r\n\.\r\n$/, '').replace(/\r\n/g, ''), 'base64').toString('utf8');
          sent.push(msg);
          msg = {};
          data = '';
          state = 'cmd';
          sock.write('250 queued\r\n');
        }
        return;
      }
      for (const line of text.split('\r\n').filter(Boolean)) {
        if (/^EHLO/.test(line)) sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
        else if (line === 'AUTH LOGIN') { state = 'user'; sock.write('334 VXNlcm5hbWU6\r\n'); }
        else if (state === 'user') { msg.user = Buffer.from(line, 'base64').toString(); state = 'pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); }
        else if (state === 'pass') { msg.pass = Buffer.from(line, 'base64').toString(); state = 'cmd'; sock.write(msg.pass === 'goodpass' ? '235 ok\r\n' : '535 bad credentials\r\n'); }
        else if (/^MAIL FROM/.test(line)) sock.write('250 ok\r\n');
        else if (/^RCPT TO:<(.*)>/.test(line)) { msg.to = line.match(/<(.*)>/)[1]; sock.write('250 ok\r\n'); }
        else if (line === 'DATA') { state = 'data'; sock.write('354 go\r\n'); }
        else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      }
    });
  });
  return { srv, sent };
}

test('email: sign-up alert, approval email, forgot password links, test email', async () => {
  const smtp = fakeSmtp();
  await new Promise((r) => smtp.srv.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-mail-'));
  const cfgFile = path.join(dir, 'mail.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ host: '127.0.0.1', port: smtp.srv.address().port, secure: false, user: 'me@gmail.com', pass: 'good pass', from: 'Riderly <me@gmail.com>', notify: 'will@example.com' }));
  const errors = [];
  const app = createApp(openDb(':memory:'), { mailConfigFile: cfgFile, mailLog: { error: (m) => errors.push(m) }, purgeTimer: false });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.address().port}`;
  const waitFor = async (n) => { for (let i = 0; i < 50 && smtp.sent.length < n; i++) await new Promise((r) => setTimeout(r, 40)); };
  try {
    const o = client(() => url);
    await o.call('POST', '/api/owner/setup', { password: 'ownerpass1' });
    assert.equal((await o.call('GET', '/api/owner/venues')).data.mail.configured, true);
    assert.equal((await o.call('POST', '/api/owner/test-email')).data.to, 'will@example.com');
    assert.equal(smtp.sent[0].user, 'me@gmail.com');
    assert.equal(smtp.sent[0].pass, 'goodpass', 'spaces in Gmail app passwords are removed');

    await client(() => url).call('POST', '/api/apply', { venueName: 'Mail Bar', name: 'Alex Rivers', email: 'alex@mailbar.com', showsPerMonth: '5–10', ticketing: 'Oztix' });
    await waitFor(2);
    assert.equal(smtp.sent[1].to, 'will@example.com');
    assert.match(smtp.sent[1].subject, /New application: Mail Bar/);
    assert.match(smtp.sent[1].text, /alex@mailbar\.com/);
    assert.match(smtp.sent[1].text, /5–10 a month/);

    const req = (await o.call('GET', '/api/owner/venues')).data.requests[0];
    const ap = await o.call('POST', `/api/owner/requests/${req.id}/approve`);
    assert.equal(ap.data.emailed, true);
    assert.equal(smtp.sent[2].to, 'alex@mailbar.com');
    assert.match(smtp.sent[2].subject, /Set up Mail Bar/);
    const setupToken = smtp.sent[2].text.match(/\/setup\/([A-Za-z0-9_-]+)/)[1];
    assert.equal((await client(() => url).call('POST', `/api/setup/${setupToken}`, { username: 'mail-bar', password: 'staffpass1', adminPassword: 'adminpass1' })).status, 200);

    // Forgot password: same answer for real and made-up venues; link goes to the venue's email.
    const pub = client(() => url);
    const fake = await pub.call('POST', '/api/forgot', { username: 'no-such-venue', kind: 'staff' });
    const real = await pub.call('POST', '/api/forgot', { username: 'mail-bar', kind: 'staff' });
    assert.deepEqual(fake.data, real.data);
    assert.equal(smtp.sent[3].to, 'alex@mailbar.com');
    const staffLink = smtp.sent[3].text.match(/\/setup\/([A-Za-z0-9_-]+)/)[1];
    assert.equal((await pub.call('GET', `/api/setup/${staffLink}`)).data.reset, true);

    await pub.call('POST', '/api/forgot', { username: 'mail-bar', kind: 'admin' });
    const adminLink = smtp.sent[4].text.match(/\/venue-admin\/reset\/([A-Za-z0-9_-]+)/)[1];
    assert.equal((await pub.call('POST', `/api/venue-admin/reset/${adminLink}`, { password: 'brand-new-admin' })).status, 200);

    // A broken mail setup never breaks the app: it just logs.
    fs.writeFileSync(cfgFile, JSON.stringify({ host: '127.0.0.1', port: smtp.srv.address().port, secure: false, user: 'me@gmail.com', pass: 'wrong' }));
    const r = await client(() => url).call('POST', '/api/apply', { venueName: 'Broken Mail', name: 'B', email: 'b@b.com' });
    assert.equal(r.status, 200);
    for (let i = 0; i < 50 && !errors.length; i++) await new Promise((res) => setTimeout(res, 40));
    assert.match(errors[0], /bad credentials/);
    assert.equal((await o.call('POST', '/api/owner/test-email')).status, 502);
  } finally {
    app.closeAllConnections();
    app.close();
    smtp.srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('copy contributors from another show; night report', async () => {
  const { c } = await onboard('Report Hall');
  const last = (await c.call('POST', '/api/events', { name: 'Last Friday', date: '2026-10-02', overridePin: '2468' })).data;
  const tonight = (await c.call('POST', '/api/events', { name: 'Tonight', date: '2026-10-09', venueCapacity: 100, overridePin: '2468' })).data;
  await c.call('POST', `/api/events/${last.id}/contributors`, { name: 'Headliner TM', listType: 'Artist', allocation: 20 });
  await c.call('POST', `/api/events/${last.id}/contributors`, { name: 'Promoter Jess', allocation: 10 });
  await c.call('POST', `/api/events/${tonight.id}/contributors`, { name: 'promoter jess' });
  const r = await c.call('POST', `/api/events/${tonight.id}/contributors/copy`, { fromEventId: last.id });
  assert.deepEqual(r.data, { added: 1, skipped: 1 });
  const ev = (await c.call('GET', `/api/events/${tonight.id}`)).data;
  const tm = ev.contributors.find((x) => x.name === 'Headliner TM');
  assert.equal(tm.allocation, 20);
  const lastTm = (await c.call('GET', `/api/events/${last.id}`)).data.contributors.find((x) => x.name === 'Headliner TM');
  assert.notEqual(tm.token, lastTm.token, 'copies get their own new links');
  assert.equal((await c.call('POST', `/api/events/${tonight.id}/contributors/copy`, { fromEventId: tonight.id })).status, 400);
  const other = await onboard('Report Other');
  assert.equal((await other.c.call('POST', `/api/events/${tonight.id}/contributors/copy`, { fromEventId: last.id })).status, 404);

  // Night report
  const g1 = (await c.call('POST', `/api/events/${tonight.id}/guests`, { name: 'A', plusOnes: 2, contributorId: tm.id })).data;
  await c.call('POST', `/api/events/${tonight.id}/guests`, { name: 'B', vip: true });
  await c.call('POST', `/api/guests/${g1.id}/checkin`, { count: 2 });
  await c.call('POST', `/api/events/${tonight.id}/count`, { delta: 5 });
  await c.call('POST', `/api/events/${tonight.id}/count`, { delta: -1 });
  const rep = (await c.call('GET', `/api/events/${tonight.id}/report`)).data;
  assert.deepEqual(rep.door, { count: 4, capacity: 100, peak: 5, totalIn: 5, totalOut: 1 });
  assert.equal(rep.guestlist.heads, 4);
  assert.equal(rep.guestlist.arrived, 2);
  assert.equal(rep.guestlist.noShow, 2);
  assert.equal(rep.byContributor.find((x) => x.name === 'Headliner TM').arrived, 2);
  assert.equal(rep.arrivals.checkins[0].count, 2);
  assert.equal(rep.arrivals.doorIn[0].count, 5);
  assert.equal(rep.canEmail, false, 'no email set up in tests');
  assert.equal((await other.c.call('GET', `/api/events/${tonight.id}/report`)).status, 404);
  assert.equal(rep.tickets.scanned, null);

  // Moshtix totals typed in after the night, compared with the door.
  const put = await c.call('PUT', `/api/events/${tonight.id}`, { ticketsSold: 10, ticketsScanned: 2 });
  assert.equal(put.status, 200, 'no manager code needed for ticket totals');
  const rep2 = (await c.call('GET', `/api/events/${tonight.id}/report`)).data;
  assert.deepEqual(rep2.tickets, { sold: 10, scanned: 2, noShow: 8, expectedIn: 4, doorIn: 5, difference: 1 });
  assert.equal((await c.call('PUT', `/api/events/${tonight.id}`, { ticketsScanned: -1 })).status, 400);
  assert.equal((await c.call('PUT', `/api/events/${tonight.id}`, { ticketsSold: null })).data.ticketsSold, null);
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
  const sw = await fetch(`${base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.equal(sw.headers.get('cache-control'), 'no-cache', 'service worker updates are picked up straight away');
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

test('SigV4 signing matches the AWS published S3 examples', () => {
  const { sign } = require('../src/offsite');
  const creds = { region: 'us-east-1', key: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', amzDate: '20130524T000000Z' };
  // GET Object example
  let r = sign({
    ...creds, method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt',
    headers: { range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
  assert.equal(r.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  // PUT Object example (checks path encoding of "$")
  r = sign({
    ...creds, method: 'PUT', host: 'examplebucket.s3.amazonaws.com', path: '/test$file.text',
    headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
    payloadHash: require('node:crypto').createHash('sha256').update('Welcome to Amazon S3.').digest('hex'),
  });
  assert.match(r.authorization, /Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/);
});

test('backup files are encrypted and only open with the passphrase', () => {
  const { encrypt, decrypt } = require('../src/offsite');
  const data = Buffer.from('SQLite format 3\0 pretend database');
  const enc = encrypt(data, 'correct horse battery staple');
  assert.equal(enc.subarray(0, 4).toString(), 'VLB1');
  assert.equal(enc.includes(Buffer.from('pretend')), false);
  assert.deepEqual(decrypt(enc, 'correct horse battery staple'), data);
  assert.throws(() => decrypt(enc, 'wrong passphrase'));
  const tampered = Buffer.from(enc);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decrypt(tampered, 'correct horse battery staple'));
});

test('Back up now saves locally, uploads an encrypted copy, and reports failures', async () => {
  const { sign, decrypt } = require('../src/offsite');
  const cfg = { region: 'syd1', bucket: 'riderly-backups', key: 'DO00TESTKEY', secret: 'test-secret', passphrase: 'long random words here', prefix: 'guestlist/' };
  const puts = [];
  let failNext = false;
  const s3 = require('node:http').createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (failNext) {
        res.writeHead(403);
        return res.end('<Error><Code>InvalidAccessKeyId</Code></Error>');
      }
      // Re-sign what arrived: proves the signed headers match what was actually sent.
      const names = req.headers.authorization.match(/SignedHeaders=([^,]+)/)[1].split(';');
      const headers = Object.fromEntries(names.filter((n) => !['host', 'x-amz-date', 'x-amz-content-sha256'].includes(n)).map((n) => [n, req.headers[n]]));
      const expected = sign({ method: 'PUT', host: req.headers.host, path: req.url, headers, payloadHash: req.headers['x-amz-content-sha256'], region: cfg.region, key: cfg.key, secret: cfg.secret, amzDate: req.headers['x-amz-date'] });
      assert.equal(req.headers.authorization, expected.authorization);
      assert.equal(req.headers['x-amz-content-sha256'], require('node:crypto').createHash('sha256').update(body).digest('hex'));
      puts.push({ url: req.url, body });
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise((r) => s3.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-offsite-'));
  const cfgFile = path.join(dir, 'backup.json');
  const errors = [];
  const db = openDb(':memory:');
  db.prepare("INSERT INTO settings (key, value) VALUES ('marker', 'offsite-test')").run();
  const app = createApp(db, { purgeTimer: false, mailLog: { error: (m) => errors.push(m) }, backup: { dir: path.join(dir, 'backups'), keepDays: 30, configFile: cfgFile, schedule: false } });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.address().port}`;
  try {
    const o = client(() => url);
    assert.equal((await client(() => url).call('POST', '/api/owner/backup-now')).status, 401);
    await o.call('POST', '/api/owner/setup', { password: 'ownerpass1' });

    // Without backup.json: droplet copy only.
    let r = await o.call('POST', '/api/owner/backup-now');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.local.ok, true);
    assert.equal(r.data.offsite, null);
    assert.equal(r.data.backup.offsite.configured, false);

    // With backup.json: uploads daily (+ monthly on the 1st) copies that decrypt to the database.
    fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, endpoint: `http://127.0.0.1:${s3.address().port}` }));
    r = await o.call('POST', '/api/owner/backup-now');
    assert.equal(r.data.offsite.ok, true, JSON.stringify(r.data));
    // One daily copy, plus the monthly one when this runs on the 1st (UTC).
    assert.equal(puts.length, new Date().getUTCDate() === 1 ? 2 : 1);
    assert.match(puts[0].url, /^\/riderly-backups\/guestlist\/daily-(sun|mon|tue|wed|thu|fri|sat)\.vlb$/);
    const restoredFile = path.join(dir, 'restored.db');
    fs.writeFileSync(restoredFile, decrypt(puts[0].body, cfg.passphrase));
    const restored = openDb(restoredFile);
    assert.equal(restored.prepare("SELECT value FROM settings WHERE key = 'marker'").get().value, 'offsite-test');
    restored.close();
    const status = (await o.call('GET', '/api/owner/venues')).data.backup;
    assert.equal(status.offsite.configured, true);
    assert.equal(status.offsite.bucket, 'riderly-backups');
    assert.ok(status.offsite.lastOkAt);
    assert.equal(JSON.stringify(status).includes('test-secret'), false, 'secrets never leave the server');

    // A failed upload is reported, logged, and the local copy still exists.
    failNext = true;
    r = await o.call('POST', '/api/owner/backup-now');
    assert.equal(r.data.local.ok, true);
    assert.equal(r.data.offsite.ok, false);
    assert.match(r.data.offsite.error, /InvalidAccessKeyId/);
    assert.match(r.data.backup.offsite.lastError.message, /InvalidAccessKeyId/);
    assert.ok(errors.some((e) => /Off-site backup failed/.test(e)));
  } finally {
    app.closeAllConnections();
    app.close();
    s3.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the monthly copy is added on the 1st and rotates yearly', async () => {
  const { uploadBackup } = require('../src/offsite');
  const urls = [];
  const s3 = require('node:http').createServer((req, res) => {
    urls.push(req.url);
    req.resume().on('end', () => res.end());
  });
  await new Promise((r) => s3.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-monthly-'));
  const file = path.join(dir, 'x.db');
  fs.writeFileSync(file, 'data');
  try {
    const cfg = { endpoint: `http://127.0.0.1:${s3.address().port}`, region: 'syd1', bucket: 'b', key: 'k', secret: 's', passphrase: 'p', prefix: 'guestlist/' };
    const r = await uploadBackup(cfg, file, new Date('2026-10-01T03:00:00Z'));
    assert.deepEqual(r.keys, ['guestlist/daily-thu.vlb', 'guestlist/monthly-10.vlb']);
    assert.deepEqual(urls, ['/b/guestlist/daily-thu.vlb', '/b/guestlist/monthly-10.vlb']);
  } finally {
    s3.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Riderly connection: API key, show sync and totals without guest names', async () => {
  const { c, admin, venue } = await onboard('Sync Hall');
  const other = await onboard('Sync Other');
  const call = (key, method, p, body) => client().call(method, p, body, { actor: null, headers: key ? { Authorization: `Bearer ${key}` } : {} });

  assert.equal((await call(null, 'GET', '/api/v1/venue')).status, 401);
  assert.equal((await call('rgl_notarealkeynotarealkey123', 'GET', '/api/v1/venue')).status, 401);
  assert.equal((await client().call('POST', '/api/vadmin/api-key')).status, 401, 'only the venue admin makes keys');
  assert.equal((await c.call('POST', '/api/vadmin/api-key')).status, 401, 'staff login is not enough');

  const made = await admin.call('POST', '/api/vadmin/api-key');
  assert.equal(made.status, 200);
  const key = made.data.key;
  assert.match(key, /^rgl_/);
  assert.equal(made.data.hint, key.slice(-4));
  assert.equal(appDb.prepare('SELECT api_key_hash FROM venues WHERE id = ?').get(venue.id).api_key_hash.includes(key), false, 'only a hash is stored');
  const ov = (await admin.call('GET', '/api/vadmin/overview')).data.apiKey;
  assert.equal(ov.connected, true);
  assert.equal(ov.key, undefined, 'the key is never shown again');

  const me = await call(key, 'GET', '/api/v1/venue');
  assert.equal(me.data.username, venue.slug);
  assert.match(me.data.links.venueAdmin, /\/v\/sync-hall\/admin$/);

  // Push a show in, then update it; unknown shows need a name and date.
  assert.equal((await call(key, 'PUT', '/api/v1/events/ext:show-1', { name: 'No date' })).status, 400);
  let r = await call(key, 'PUT', '/api/v1/events/ext:show-1', { name: 'Riderly Night', date: '2026-11-06', doorsTime: '19:30', venueCapacity: 300 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.created, true);
  const id = r.data.event.id;
  r = await call(key, 'PUT', '/api/v1/events/ext:show-1', { ticketsSold: 250, ticketsScanned: 3, name: 'Riderly Night (moved)' });
  assert.equal(r.data.created, false);
  assert.equal(r.data.event.id, id, 'same show updated, not duplicated');
  assert.equal(r.data.event.name, 'Riderly Night (moved)');
  assert.equal(r.data.event.doorsTime, '19:30', 'fields not sent stay as they were');
  assert.equal(r.data.event.door.capacity, 300);

  // Staff see it and run the night as normal.
  const ev = (await c.call('GET', `/api/events/${id}`)).data;
  assert.equal(ev.event.externalId, 'show-1');
  const g = (await c.call('POST', `/api/events/${id}/guests`, { name: 'Secret Guestname', plusOnes: 1 })).data;
  await c.call('POST', `/api/guests/${g.id}/checkin`, { count: 2 });
  await c.call('POST', `/api/events/${id}/count`, { delta: 6 });

  // Totals come back; guest names never do.
  const list = await call(key, 'GET', '/api/v1/events?from=2026-11-01&to=2026-11-30');
  assert.equal(list.data.events.length, 1);
  assert.equal(list.data.events[0].guestlist.arrived, 2);
  const rep = await call(key, 'GET', '/api/v1/events/ext:show-1/report');
  assert.equal(rep.status, 200);
  assert.equal(rep.data.tickets.expectedIn, 5);
  assert.equal(rep.data.tickets.difference, 1);
  assert.equal(JSON.stringify(rep.data).includes('Secret Guestname'), false);
  assert.equal(JSON.stringify(list.data).includes('Secret Guestname'), false);
  assert.equal((await call(key, 'GET', `/api/v1/events/${id}/report`)).status, 200, 'numeric id works too');

  // Another venue's key can't see or touch this show.
  const otherKey = (await other.admin.call('POST', '/api/vadmin/api-key')).data.key;
  assert.equal((await call(otherKey, 'GET', `/api/v1/events/${id}`)).status, 404);
  assert.equal((await call(otherKey, 'GET', '/api/v1/events/ext:show-1')).status, 404);
  assert.equal((await call(otherKey, 'DELETE', `/api/v1/events/${id}`)).status, 404);

  // Cancelling: a show with guests is archived, an empty one is deleted.
  r = await call(key, 'DELETE', '/api/v1/events/ext:show-1');
  assert.deepEqual(r.data, { deleted: false, archived: true });
  assert.equal((await c.call('GET', `/api/events/${id}`)).data.event.archived, true);
  await call(key, 'PUT', '/api/v1/events/ext:show-2', { name: 'Empty', date: '2026-11-07' });
  assert.deepEqual((await call(key, 'DELETE', '/api/v1/events/ext:show-2')).data, { deleted: true, archived: false });

  // A new key replaces the old one; disconnecting stops it.
  const key2 = (await admin.call('POST', '/api/vadmin/api-key')).data.key;
  assert.equal((await call(key, 'GET', '/api/v1/venue')).status, 401);
  assert.equal((await call(key2, 'GET', '/api/v1/venue')).status, 200);
  await admin.call('DELETE', '/api/vadmin/api-key');
  assert.equal((await call(key2, 'GET', '/api/v1/venue')).status, 401);

  // One venue's dead key being retried from the Riderly server never blocks another venue.
  for (let i = 0; i < 25; i++) await call(key2, 'GET', '/api/v1/venue');
  assert.equal((await call(key2, 'GET', '/api/v1/venue')).status, 429, 'the dead key itself is slowed down');
  assert.equal((await call(otherKey, 'GET', '/api/v1/venue')).status, 200, 'other venues keep syncing');
  const owned = (await owner.call('GET', '/api/owner/venues')).data.venues.find((v) => v.slug === venue.slug);
  assert.equal(owned.riderlyConnected, false);
});

test('past shows move to Past and close their contributor links; Riderly removals archive and restore', async () => {
  const { c, admin } = await onboard('Timeline Hall');
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const past = (await c.call('POST', '/api/events', { name: 'Last Week', date: day(-7), overridePin: '2468' })).data;
  const next = (await c.call('POST', '/api/events', { name: 'Next Week', date: day(7), overridePin: '2468' })).data;
  const names = (r) => r.data.map((e) => e.name);
  assert.deepEqual(names(await c.call('GET', '/api/events')), ['Next Week'], 'upcoming only by default');
  assert.deepEqual(names(await c.call('GET', '/api/events?view=past')), ['Last Week']);
  assert.deepEqual(names(await c.call('GET', '/api/events?view=all')).sort(), ['Last Week', 'Next Week']);
  assert.equal((await c.call('GET', `/api/events/${past.id}`)).data.event.over, true);
  assert.equal((await c.call('GET', `/api/events/${next.id}`)).data.event.over, false);

  // A finished show's contributor link stops taking guests.
  const tm = (await c.call('POST', `/api/events/${past.id}/contributors`, { name: 'TM' })).data;
  const late = await client().call('POST', `/api/c/${tm.token}/guests`, { name: 'Too Late' });
  assert.ok(late.status >= 400, 'locked');
  assert.match(late.data.error, /finished/);

  // Riderly: removing a show with contributors keeps it (archived), and sending it again restores it.
  const key = (await admin.call('POST', '/api/vadmin/api-key')).data.key;
  const api = (m, p, b) => client().call(m, p, b, { actor: null, headers: { Authorization: `Bearer ${key}` } });
  const made = (await api('PUT', '/api/v1/events/ext:vmt-1', { name: 'Synced Show', date: day(10) })).data.event;
  await c.call('POST', `/api/events/${made.id}/contributors`, { name: 'Promoter' });
  assert.deepEqual((await api('DELETE', '/api/v1/events/ext:vmt-1')).data, { deleted: false, archived: true });
  let ev = (await c.call('GET', `/api/events/${made.id}`)).data.event;
  assert.equal(ev.archived, true);
  assert.equal(ev.removedByRiderly, true);
  assert.ok((await c.call('GET', '/api/events?archived=1')).data.some((e) => e.id === made.id));
  await api('PUT', '/api/v1/events/ext:vmt-1', { name: 'Synced Show', date: day(10) });
  ev = (await c.call('GET', `/api/events/${made.id}`)).data.event;
  assert.equal(ev.archived, false, 'back in the schedule, back in the list');
  assert.equal(ev.removedByRiderly, false);

  // A show the venue archived itself is not un-archived by a sync.
  await c.call('PUT', `/api/events/${made.id}`, { archived: true });
  await api('PUT', '/api/v1/events/ext:vmt-1', { name: 'Synced Show (renamed)', date: day(10) });
  ev = (await c.call('GET', `/api/events/${made.id}`)).data.event;
  assert.equal(ev.archived, true);
  assert.equal(ev.name, 'Synced Show (renamed)');

  // An untouched show is deleted outright.
  await api('PUT', '/api/v1/events/ext:vmt-2', { name: 'Empty Show', date: day(11) });
  assert.deepEqual((await api('DELETE', '/api/v1/events/ext:vmt-2')).data, { deleted: true, archived: false });
});
