'use strict';

// Regenerates the product screenshots in public/img from a fictional demo venue.
//   node --disable-warning=ExperimentalWarning scripts/capture-screenshots.js
// Needs Playwright (npm i -g playwright) — it's a dev tool, not an app dependency.

const path = require('node:path');
const { execSync } = require('node:child_process');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
const OUT = path.join(__dirname, '..', 'public', 'img');
const today = new Date();
const iso = (d) => new Date(today.getTime() + d * 86400000).toISOString().slice(0, 10);

async function main() {
  const server = createApp(openDb(':memory:'));
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
  await call('POST', '/api/signup', { venueName: 'The Velvet Room', username: 'velvet-room', name: 'Demo', email: 'demo@example.com', password: 'demo-password' });
  await call('POST', '/api/owner/setup', { password: 'owner-password' }).catch(() => {});
  // Approve via the owner session in a separate jar.
  let ownerCookie = '';
  const o = await fetch(base + '/api/owner/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'owner-password' }) });
  ownerCookie = o.headers.getSetCookie()[0].split(';')[0];
  const list = await (await fetch(base + '/api/owner/venues', { headers: { Cookie: ownerCookie } })).json();
  await fetch(base + `/api/owner/requests/${list.requests[0].id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: '{}' });
  await call('POST', '/api/login', { username: 'velvet-room', password: 'demo-password' });

  const ev = await call('POST', '/api/events', {
    name: 'Midnight Arcade — Album Launch', date: iso(0), doorsTime: '19:30',
    notes: 'Artist entry via the laneway door. Photo passes at merch. Wristbands: gold = all areas.',
  });
  for (const [name, date] of [['Low Tide + Paper Moons', iso(2)], ['Sunday Soul Sessions', iso(4)], ['The Hollow Pines (Sold Out)', iso(8)], ['Club Night: HYPERSONIC', iso(10)]]) {
    const e = await call('POST', '/api/events', { name, date, doorsTime: '20:00' });
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

  // ----- screenshots -----
  const browser = await chromium.launch();
  const ctx = async (w, h, dpr) => {
    const c = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, locale: 'en-AU', timezoneId: 'Australia/Melbourne' });
    await c.addCookies([{ name: 'vl_session', value: cookie.split('=')[1], url: base }]);
    await c.addInitScript(() => localStorage.setItem('vl.deviceName', 'Will (Office)'));
    return c;
  };
  const shot = async (page, file, opts = {}) => {
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, file), type: 'jpeg', quality: 82, ...opts });
    console.log('wrote', file);
  };

  const desk = await ctx(1280, 800, 2);
  const d = await desk.newPage();
  await d.goto(`${base}/app#/event/${ev.id}/guests`);
  await d.waitForSelector('.table');
  await shot(d, 'app-guestlist.jpg');
  await d.goto(`${base}/app#/event/${ev.id}/contributors`);
  await d.waitForSelector('.contributor');
  // Show the real domain in the link boxes rather than the local test server.
  await d.evaluate(() => document.querySelectorAll('.linkbox input').forEach((i) => {
    i.value = i.value.replace(location.origin, 'https://guestlist.riderly.com.au');
  }));
  await shot(d, 'app-contributors.jpg');
  await d.goto(`${base}/app#/event/${ev.id}/activity`);
  await d.waitForSelector('.activity li');
  await shot(d, 'app-activity.jpg');
  await d.goto(`${base}/app#/`);
  await d.waitForSelector('.event-card');
  await shot(d, 'app-events.jpg');

  const phone = await ctx(390, 844, 2);
  const p = await phone.newPage();
  await p.addInitScript(() => localStorage.setItem('vl.deviceName', 'Sam'));
  await p.goto(`${base}/app#/door/${ev.id}`);
  await p.waitForSelector('.door-row');
  await shot(p, 'phone-door.jpg');
  await p.fill('.door-search', 'is');
  await shot(p, 'phone-door-search.jpg');

  const c = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'en-AU', timezoneId: 'Australia/Melbourne' })).newPage();
  await c.addInitScript(() => localStorage.setItem('vl.deviceName', 'Tom'));
  await c.goto(`${base}/c/${tm.token}`);
  await c.waitForSelector('.portal-guest');
  await shot(c, 'phone-contributor.jpg');

  await browser.close();
  server.closeAllConnections();
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
