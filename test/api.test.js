'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, parseImport } = require('../src/app');

let server;
let base;
let cookie = '';

async function call(method, path, body, { actor = 'Tester', auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (actor) headers['X-Actor'] = encodeURIComponent(actor);
  if (auth && cookie) headers.Cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : method === 'GET' ? undefined : '{}' });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

before(async () => {
  const db = openDb(':memory:');
  server = createApp(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test('setup, login and auth guard', async () => {
  let r = await call('GET', '/api/session');
  assert.equal(r.data.needsSetup, true);

  r = await call('GET', '/api/events', undefined, { auth: false });
  assert.equal(r.status, 401);

  r = await call('POST', '/api/setup', { password: 'short' });
  assert.equal(r.status, 400);

  r = await call('POST', '/api/setup', { password: 'supersecret', venueName: 'Test Hall' });
  assert.equal(r.status, 200);
  assert.ok(cookie);

  r = await call('POST', '/api/setup', { password: 'another123' });
  assert.equal(r.status, 409, 'setup only runs once');

  const saved = cookie;
  cookie = '';
  r = await call('POST', '/api/login', { password: 'wrong-password' });
  assert.equal(r.status, 401);
  r = await call('POST', '/api/login', { password: 'supersecret' });
  assert.equal(r.status, 200);
  assert.notEqual(cookie, '');
  cookie = saved;

  r = await call('GET', '/api/session');
  assert.equal(r.data.authed, true);
  assert.equal(r.data.venueName, 'Test Hall');
});

test('mutations require a device name', async () => {
  const r = await call('POST', '/api/events', { name: 'X', date: '2026-10-01' }, { actor: '' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /name/i);
});

test('rejects non-JSON mutations (CSRF guard)', async () => {
  const res = await fetch(base + '/api/events', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Actor': 'x' },
    body: 'name=x',
  });
  assert.equal(res.status, 415);
});

test('full flow: event, contributor link, allocations, door check in/out, attribution', async () => {
  let r = await call('POST', '/api/events', { name: 'Big Band', date: '2026-10-10', doorsTime: '19:30' }, { actor: 'Will' });
  assert.equal(r.status, 200);
  const eventId = r.data.id;
  assert.equal(r.data.createdBy, 'Will');

  r = await call('POST', `/api/events/${eventId}/contributors`, { name: 'Headliner TM', listType: 'Artist', allocation: 4 }, { actor: 'Will' });
  assert.equal(r.status, 200);
  const contributor = r.data;
  assert.ok(contributor.token.length > 20);

  // Contributor portal is public (no cookie) but needs a name.
  r = await call('GET', `/api/c/${contributor.token}`, undefined, { auth: false });
  assert.equal(r.status, 200);
  assert.equal(r.data.remaining, 4);
  assert.equal(r.data.contributor.listType, 'Artist');
  assert.equal(r.data.contributor.token, undefined, 'token not echoed');

  r = await call('POST', `/api/c/${contributor.token}/guests`, { name: 'Jane Smith', plusOnes: 2 }, { auth: false, actor: 'Tour Manager Tom' });
  assert.equal(r.status, 200);
  assert.equal(r.data.remaining, 1);
  const jane = r.data.guests[0];
  assert.equal(jane.addedBy, 'Tour Manager Tom');

  r = await call('POST', `/api/c/${contributor.token}/guests`, { name: 'Too Many', plusOnes: 1 }, { auth: false, actor: 'Tom' });
  assert.equal(r.status, 409, 'allocation enforced');

  r = await call('GET', `/api/c/badtoken`, undefined, { auth: false });
  assert.equal(r.status, 404);

  // Venue adds a VIP directly.
  r = await call('POST', `/api/events/${eventId}/guests`, { name: 'Mayor', vip: true, listType: 'Industry' }, { actor: 'Will' });
  assert.equal(r.status, 200);
  const mayor = r.data;
  assert.equal(mayor.vip, true);
  assert.equal(mayor.addedVia, 'venue');

  // Venue override past allocation.
  r = await call('POST', `/api/events/${eventId}/guests`, { name: 'Extra', plusOnes: 3, contributorId: contributor.id }, { actor: 'Will' });
  assert.equal(r.status, 409);
  r = await call('POST', `/api/events/${eventId}/guests`, { name: 'Extra', plusOnes: 3, contributorId: contributor.id, force: true }, { actor: 'Will' });
  assert.equal(r.status, 200);
  assert.equal(r.data.listType, 'Artist', 'inherits contributor list type');

  // Door: partial check-in of Jane's party of 3.
  r = await call('POST', `/api/guests/${jane.id}/checkin`, { count: 2 }, { actor: 'Sam (Door 1)' });
  assert.equal(r.status, 200);
  assert.equal(r.data.inside, 2);
  assert.equal(r.data.admitted, 2);
  assert.equal(r.data.updatedBy, 'Sam (Door 1)');

  r = await call('POST', `/api/guests/${jane.id}/checkin`, { count: 2 }, { actor: 'Sam' });
  assert.equal(r.status, 409, 'cannot exceed party');

  r = await call('POST', `/api/guests/${jane.id}/checkout`, { count: 1 }, { actor: 'Sam' });
  assert.equal(r.data.inside, 1);
  assert.equal(r.data.admitted, 2, 'admitted keeps high-water mark');

  r = await call('POST', `/api/guests/${jane.id}/checkin`, {}, { actor: 'Alex (Door 2)' });
  assert.equal(r.data.inside, 3, 'default checks in rest of party');
  assert.equal(r.data.admitted, 3);

  r = await call('POST', `/api/guests/${mayor.id}/checkout`, {}, { actor: 'Sam' });
  assert.equal(r.status, 409, 'cannot check out someone not inside');

  // Contributor cannot edit/remove an arrived guest, and cannot reduce party below admitted.
  r = await call('DELETE', `/api/c/${contributor.token}/guests/${jane.id}`, undefined, { auth: false, actor: 'Tom' });
  assert.equal(r.status, 409);
  r = await call('PUT', `/api/guests/${jane.id}`, { plusOnes: 0 }, { actor: 'Will' });
  assert.equal(r.status, 409);

  // Contributor can't touch the venue's guests.
  r = await call('DELETE', `/api/c/${contributor.token}/guests/${mayor.id}`, undefined, { auth: false, actor: 'Tom' });
  assert.equal(r.status, 404);

  // Event view & stats.
  r = await call('GET', `/api/events/${eventId}`);
  assert.equal(r.data.stats.expected, 3 + 1 + 4);
  assert.equal(r.data.stats.inside, 3);
  assert.equal(r.data.stats.vip, 1);
  const c = r.data.contributors.find((x) => x.id === contributor.id);
  assert.equal(c.stats.expected, 7);

  // Activity attribution.
  r = await call('GET', `/api/events/${eventId}/activity`);
  const actors = new Set(r.data.map((a) => a.actor));
  for (const who of ['Will', 'Tour Manager Tom', 'Sam (Door 1)', 'Alex (Door 2)']) assert.ok(actors.has(who), who);
  const add = r.data.find((a) => a.action === 'guest.add' && a.guestName === 'Jane Smith');
  assert.equal(add.via, 'Headliner TM');

  // CSV export.
  const res = await fetch(`${base}/api/events/${eventId}/export.csv`, { headers: { Cookie: cookie } });
  const csv = await res.text();
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(csv, /Jane Smith,2,3,Artist,,Headliner TM/);

  // Disabling the link locks the contributor.
  r = await call('PUT', `/api/contributors/${contributor.id}`, { active: false }, { actor: 'Will' });
  r = await call('POST', `/api/c/${contributor.token}/guests`, { name: 'Late' }, { auth: false, actor: 'Tom' });
  assert.equal(r.status, 403);

  // Regenerating the link kills the old one.
  r = await call('POST', `/api/contributors/${contributor.id}/regenerate`, {}, { actor: 'Will' });
  assert.notEqual(r.data.token, contributor.token);
  r = await call('GET', `/api/c/${contributor.token}`, undefined, { auth: false });
  assert.equal(r.status, 404);

  // Can't delete a contributor with guests.
  r = await call('DELETE', `/api/contributors/${contributor.id}`, undefined, { actor: 'Will' });
  assert.equal(r.status, 409);
});

test('cutoff locks contributor links', async () => {
  let r = await call('POST', '/api/events', { name: 'Past cutoff', date: '2026-10-11', cutoffAt: new Date(Date.now() - 60000).toISOString() });
  const eventId = r.data.id;
  r = await call('POST', `/api/events/${eventId}/contributors`, { name: 'Promoter' });
  const token = r.data.token;
  r = await call('GET', `/api/c/${token}`, undefined, { auth: false });
  assert.match(r.data.locked, /cutoff/);
  r = await call('POST', `/api/c/${token}/guests`, { name: 'Nope' }, { auth: false, actor: 'P' });
  assert.equal(r.status, 403);
});

test('event guest-list cap', async () => {
  let r = await call('POST', '/api/events', { name: 'Small', date: '2026-10-12', capacity: 2 });
  const eventId = r.data.id;
  r = await call('POST', `/api/events/${eventId}/guests`, { name: 'A', plusOnes: 1 });
  assert.equal(r.status, 200);
  r = await call('POST', `/api/events/${eventId}/guests`, { name: 'B' });
  assert.equal(r.status, 409);
});

test('paste import', async () => {
  assert.deepEqual(parseImport('Name,Plus\nJane Smith +2\nAlex, 1, photographer\nSam Lee, bring ID\n\n'), [
    { name: 'Jane Smith', plusOnes: 2, notes: '' },
    { name: 'Alex', plusOnes: 1, notes: 'photographer' },
    { name: 'Sam Lee', plusOnes: 0, notes: 'bring ID' },
  ]);
  let r = await call('POST', '/api/events', { name: 'Import', date: '2026-10-13' });
  const eventId = r.data.id;
  r = await call('POST', `/api/events/${eventId}/guests/import`, { text: 'A +1\nB\nC, 2', listType: 'Media' });
  assert.equal(r.data.added, 3);
  r = await call('GET', `/api/events/${eventId}`);
  assert.equal(r.data.stats.expected, 2 + 1 + 3);
  assert.ok(r.data.guests.every((g) => g.listType === 'Media'));
});

test('CSV cells are guarded against formula injection', async () => {
  let r = await call('POST', '/api/events', { name: 'CSV', date: '2026-10-14' });
  const eventId = r.data.id;
  await call('POST', `/api/events/${eventId}/guests`, { name: '=HYPERLINK("x")' });
  const res = await fetch(`${base}/api/events/${eventId}/export.csv`, { headers: { Cookie: cookie } });
  assert.match(await res.text(), /"'=HYPERLINK\(""x""\)"/);
});

test('changing password logs out other sessions', async () => {
  const oldCookie = cookie;
  const r = await call('PUT', '/api/settings', { currentPassword: 'supersecret', newPassword: 'newpassword1' });
  assert.equal(r.status, 200);
  const res = await fetch(`${base}/api/events`, { headers: { Cookie: oldCookie } });
  assert.equal(res.status, 401);
  const ok = await call('GET', '/api/events');
  assert.equal(ok.status, 200, 'current device stays signed in');
});

test('static files and path traversal', async () => {
  let res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  res = await fetch(`${base}/c/sometoken`);
  assert.match(await res.text(), /contributor\.js/);
  res = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.equal(res.status, 404);
});
