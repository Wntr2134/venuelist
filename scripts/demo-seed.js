'use strict';

// Fills a fresh app with the fictional demo venue "The Velvet Room" (tonight's show, guests,
// contributors, check-ins). Used by capture-screenshots.js and check-layout.js.
//   const { startDemo } = require('./demo-seed');  const demo = await startDemo();

const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

const today = new Date();
const iso = (d) => new Date(today.getTime() + d * 86400000).toISOString().slice(0, 10);

async function startDemo() {
  const server = createApp(openDb(':memory:'), { purgeTimer: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body, actor = 'Will (Office)') => {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor': encodeURIComponent(actor), Cookie: cookie },
      body: body ? JSON.stringify(body) : method === 'GET' ? undefined : '{}',
    });
    const sc = res.headers.getSetCookie().find((c) => c.startsWith('vl_session='));
    if (sc) cookie = sc.split(';')[0];
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${p}: ${JSON.stringify(data)}`);
    return data;
  };

  // ----- demo venue (all names fictional) -----
  await call('POST', '/api/signup', { venueName: 'The Velvet Room', username: 'velvet-room', name: 'Demo', email: 'demo@example.com', password: 'demo-password', adminPassword: 'demo-admin-pass' });
  await call('POST', '/api/owner/setup', { password: 'owner-password' }).catch(() => {});
  // Approve via the owner session in a separate jar.
  let ownerCookie = '';
  const o = await fetch(base + '/api/owner/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'owner-password' }) });
  ownerCookie = o.headers.getSetCookie()[0].split(';')[0];
  const list = await (await fetch(base + '/api/owner/venues', { headers: { Cookie: ownerCookie } })).json();
  await fetch(base + `/api/owner/requests/${list.requests[0].id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: '{}' });
  await call('POST', '/api/login', { username: 'velvet-room', password: 'demo-password' });
  // Demo manager code (the venue admin password also works as a code).
  const vadm = await fetch(base + '/api/vadmin/login/velvet-room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'demo-admin-pass' }) });
  await fetch(base + '/api/vadmin/codes', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: vadm.headers.getSetCookie()[0].split(';')[0] }, body: JSON.stringify({ name: 'Will', code: '975310' }) });

  const ev = await call('POST', '/api/events', {
    overridePin: '975310',
    name: 'Midnight Arcade — Album Launch', date: iso(0), doorsTime: '19:30',
    notes: 'Artist entry via the laneway door. Photo passes at merch. Wristbands: gold = all areas.',
  });
  for (const [name, date] of [['Low Tide + Paper Moons', iso(2)], ['Sunday Soul Sessions', iso(4)], ['The Hollow Pines (Sold Out)', iso(8)], ['Club Night: HYPERSONIC', iso(10)]]) {
    const e = await call('POST', '/api/events', { name, date, doorsTime: '20:00', overridePin: '975310' });
    await call('POST', `/api/events/${e.id}/contributors`, { name: 'Headliner — TM', listType: 'Artist', allocation: 12 });
    await call('POST', `/api/events/${e.id}/guests/import`, { text: 'Rory Quinn +1\nMaya Chen\nLeo Barros +2\nAsha Patel' });
  }

  const tm = await call('POST', `/api/events/${ev.id}/contributors`, { name: 'Midnight Arcade — Tour Manager', listType: 'Artist', allocation: 30 });
  const sup = await call('POST', `/api/events/${ev.id}/contributors`, { name: 'Support: Low Tide', listType: 'Artist', allocation: 10 });
  const promo = await call('POST', `/api/events/${ev.id}/contributors`, { name: 'Harbour Presents (Promoter)', listType: 'Guest', allocation: 40 });
  const media = await call('POST', `/api/events/${ev.id}/contributors`, { name: 'Publicist — Sam Okafor', listType: 'Media', allocation: 12 });

  const pub = async (c, name, plusOnes, notes, actor) =>
    (await call('POST', `/api/c/${c.token}/guests`, { name, plusOnes, notes }, actor)).guests.find((g) => g.name === name);
  const g = {};
  g.jane = await pub(tm, 'Jane Smith', 2, 'Drummer’s family', 'Tom (TM)');
  g.alex = await pub(tm, 'Alex Nguyen', 0, '', 'Tom (TM)');
  g.priya = await pub(tm, 'Priya Patel', 1, 'Photographer', 'Tom (TM)');
  g.marcus = await pub(tm, 'Marcus Webb', 1, '', 'Tom (TM)');
  g.hana = await pub(tm, 'Hana Kobayashi', 0, 'Label rep', 'Tom (TM)');
  g.oli = await pub(sup, 'Oliver Grant', 1, '', 'Nia (Low Tide)');
  g.zoe = await pub(sup, 'Zoe Martin', 0, '', 'Nia (Low Tide)');
  g.dev = await pub(promo, 'Dev Raman', 3, '', 'Chris (Harbour)');
  g.lucy = await pub(promo, 'Lucy Ferreira', 1, '', 'Chris (Harbour)');
  g.ben = await pub(promo, 'Ben Carter', 0, '', 'Chris (Harbour)');
  g.isla = await pub(promo, 'Isla Thompson', 2, 'Birthday — +2 are under 21, check ID', 'Chris (Harbour)');
  g.ade = await pub(promo, 'Adebayo Okoro', 1, '', 'Chris (Harbour)');
  g.janelle = await pub(media, 'Janelle Ortiz', 0, 'Triple R — interview at 9', 'Sam (Publicist)');
  g.theo = await pub(media, 'Theo Lindqvist', 1, 'Photographer — pit access', 'Sam (Publicist)');
  const direct = async (name, plusOnes, listType, vip, notes, actor = 'Will (Office)') =>
    call('POST', `/api/events/${ev.id}/guests`, { name, plusOnes, listType, vip, notes }, actor);
  g.mayor = await direct('Cr. Ruth Nakamura', 1, 'Industry', true, 'Council — meet at box office');
  g.kai = await direct('Kai Anderson', 0, 'Crew', false, 'Lighting tech');
  g.rosa = await direct('Rosa Delgado', 1, 'Industry', true, 'Booking agent');
  g.finn = await direct('Finn O’Brien', 0, 'Venue', false, 'Owner’s guest');
  await call('PUT', `/api/guests/${g.janelle.id}`, { vip: true });
  await call('POST', `/api/events/${ev.id}/guests/import`, { text: 'Chloe Nguyen +1\nMatt Rossi\nAnika Shah +1\nJordan Blake\nEmily Walsh +2\nNoah Kim', listType: 'Guest' });

  const inn = (x, count, actor) => call('POST', `/api/guests/${x.id}/checkin`, count ? { count } : {}, actor);
  const out = (x, count, actor) => call('POST', `/api/guests/${x.id}/checkout`, count ? { count } : {}, actor);
  await inn(g.jane, 2, 'Sam (Door 1)');
  await inn(g.alex, 0, 'Sam (Door 1)');
  await inn(g.priya, 0, 'Alex (Door 2)');
  await inn(g.dev, 4, 'Alex (Door 2)');
  await inn(g.lucy, 0, 'Sam (Door 1)');
  await out(g.lucy, 1, 'Sam (Door 1)');
  await inn(g.mayor, 0, 'Sam (Door 1)');
  await inn(g.kai, 0, 'Alex (Door 2)');
  await inn(g.theo, 2, 'Sam (Door 1)');
  await inn(g.ben, 0, 'Alex (Door 2)');
  await out(g.ben, 0, 'Alex (Door 2)');

  return { server, base, cookie, ownerCookie, vadminCookie: vadm.headers.getSetCookie()[0].split(';')[0], ev, tm, g };
}

module.exports = { startDemo };
