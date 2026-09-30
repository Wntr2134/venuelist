'use strict';

// Regenerates the product screenshots in public/img from a fictional demo venue.
//   node --disable-warning=ExperimentalWarning scripts/capture-screenshots.js
// Needs Playwright (npm i -g playwright) — it's a dev tool, not an app dependency.

const path = require('node:path');
const { execSync } = require('node:child_process');
const { startDemo } = require('./demo-seed');

const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
const OUT = path.join(__dirname, '..', 'public', 'img');

async function main() {
  const { server, base, cookie, ev, tm } = await startDemo();

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
