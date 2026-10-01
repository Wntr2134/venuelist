'use strict';

// Checks every page at phone, iPad and desktop sizes, and saves screenshots to look at.
//   node --disable-warning=ExperimentalWarning scripts/check-layout.js [outDir]
// Needs Playwright (npm i -g playwright): a dev tool, not an app dependency.
//
// Flags, per page and screen:
//   overflow  the page scrolls sideways (never OK)
//   targets   buttons/fields a finger can't hit reliably (< 44px tall) on touch screens
//   zoom      text fields under 16px, which make iPhones zoom in when tapped
//   tiny      text under 12px

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { startDemo } = require('./demo-seed');

const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
const OUT = process.argv[2] || path.join(require('node:os').tmpdir(), 'vl-layout');

const DEVICES = [
  { id: 'phone-360', width: 360, height: 740, touch: true },
  { id: 'iphone-390', width: 390, height: 844, touch: true },
  { id: 'iphone-430', width: 430, height: 932, touch: true },
  { id: 'ipad-mini-744', width: 744, height: 1133, touch: true },
  { id: 'ipad-820', width: 820, height: 1180, touch: true },
  { id: 'ipad-pro-1024', width: 1024, height: 1366, touch: true },
  { id: 'ipad-land-1180', width: 1180, height: 820, touch: true },
  { id: 'ipad-pro-land-1366', width: 1366, height: 1024, touch: true },
  { id: 'desktop-1440', width: 1440, height: 900, touch: false },
];

function pages(demo) {
  const e = demo.ev.id;
  return [
    { id: 'home', url: '/' },
    { id: 'guide', url: '/guide' },
    { id: 'privacy', url: '/privacy' },
    { id: 'login', url: '/login' },
    { id: 'setup', url: demo.setupPath },
    { id: 'contributor', url: `/c/${demo.tm.token}` },
    { id: 'events', url: '/app#/', as: 'staff' },
    { id: 'comps', url: '/app#/comps/year', as: 'staff' },
    { id: 'guests', url: `/app#/event/${e}/guests`, as: 'staff' },
    { id: 'add-guest', url: `/app#/event/${e}/guests`, as: 'staff', click: 'text=+ Add guest' },
    { id: 'contributors', url: `/app#/event/${e}/contributors`, as: 'staff' },
    { id: 'report', url: `/app#/event/${e}/report`, as: 'staff' },
    { id: 'activity', url: `/app#/event/${e}/activity`, as: 'staff' },
    { id: 'event-settings', url: `/app#/event/${e}/settings`, as: 'staff' },
    { id: 'door', url: `/app#/door/${e}`, as: 'staff' },
    { id: 'screen', url: `/app#/screen/${e}`, as: 'staff' },
    { id: 'clicker', url: `/app#/door/${e}`, as: 'staff', click: 'text=Full screen' },
    { id: 'owner-admin', url: '/admin', as: 'owner' },
    { id: 'venue-admin', url: '/v/velvet-room/admin', as: 'vadmin' },
  ];
}

// Runs in the page: returns the problems it can see.
function inspect(touch) {
  const vw = document.documentElement.clientWidth;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  // Inside something that scrolls or clips sideways on purpose (tab rows, tables, marquees)?
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
    }
    return false;
  };
  const label = (el) => {
    const t = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    return `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}${t ? ` "${t}"` : ''}`;
  };

  const overflow = [];
  if (document.documentElement.scrollWidth > vw + 1) {
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && visible(el) && !clipped(el)) overflow.push(`${label(el)} → ${Math.round(r.right)}px`);
      if (overflow.length >= 6) break;
    }
    if (!overflow.length) overflow.push(`page is ${document.documentElement.scrollWidth}px wide`);
  }

  const targets = [];
  const zoom = [];
  if (touch) {
    const sel = 'button, a.btn, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea, summary, [role=button], .tab, .chip';
    for (const el of document.querySelectorAll(sel)) {
      if (!visible(el) || el.closest('.hp, [aria-hidden=true], .phone, .device, .browser, .demo')) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 43.5) targets.push(`${label(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
      if (el.matches('input, select, textarea') && parseFloat(getComputedStyle(el).fontSize) < 16) zoom.push(`${label(el)} ${getComputedStyle(el).fontSize}`);
    }
  }

  const tiny = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.textContent.trim() || !visible(el) || el.closest('.phone, .device, .browser, .demo, [aria-hidden=true]')) continue;
    seen.add(el);
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 12) tiny.push(`${label(el)} ${fs}px`);
  }
  return { overflow, targets: [...new Set(targets)], zoom: [...new Set(zoom)], tiny: [...new Set(tiny)].slice(0, 12), coarse: matchMedia('(pointer: coarse)').matches };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const demo = await startDemo();
  // A venue that's been approved but not set up yet, for the setup (onboarding) page.
  const added = await (await fetch(`${demo.base}/api/owner/venues`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: demo.ownerCookie }, body: JSON.stringify({ name: 'The Corner Hotel' }),
  })).json();
  demo.setupPath = added.setupPath;
  const browser = await chromium.launch();
  const cookies = {
    staff: { name: 'vl_session', value: demo.cookie.split('=')[1] },
    owner: { name: 'vl_owner', value: demo.ownerCookie.split('=')[1] },
    vadmin: { name: 'vl_vadmin', value: demo.vadminCookie.split('=')[1] },
  };
  const report = [];
  for (const d of DEVICES) {
    for (const pg of pages(demo)) {
      const ctx = await browser.newContext({
        viewport: { width: d.width, height: d.height }, deviceScaleFactor: 1, isMobile: d.touch && d.width < 1025, hasTouch: d.touch,
        locale: 'en-AU', timezoneId: 'Australia/Melbourne', reducedMotion: 'reduce',
      });
      if (pg.as) await ctx.addCookies([{ ...cookies[pg.as], url: demo.base }]);
      await ctx.addInitScript(() => localStorage.setItem('vl.deviceName', 'Will (Office)'));
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      // Not 'networkidle': the live-update stream keeps a connection open.
      await page.goto(demo.base + pg.url, { waitUntil: 'load' });
      await page.waitForTimeout(900);
      if (pg.click) {
        await page.click(pg.click, { timeout: 5000 }).catch((e) => errors.push(`click: ${e.message.split('\n')[0]}`));
        await page.waitForTimeout(400);
      }
      const r = await page.evaluate(inspect, d.touch);
      await page.screenshot({ path: path.join(OUT, `${pg.id}--${d.id}.png`), fullPage: false });
      report.push({ page: pg.id, device: d.id, ...r, errors });
      await ctx.close();
    }
  }
  await browser.close();
  demo.server.close();

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const bad = report.filter((r) => r.overflow.length || r.targets.length || r.zoom.length || r.errors.length);
  for (const r of report) {
    const n = (k) => (r[k].length ? `${k} ${r[k].length}` : '');
    const line = [n('overflow'), n('targets'), n('zoom'), n('tiny'), n('errors')].filter(Boolean).join(', ');
    console.log(`${r.page.padEnd(15)} ${r.device.padEnd(19)} ${line || 'ok'}`);
  }
  console.log(`\n${bad.length} of ${report.length} page/screen combinations need work. Screenshots and details: ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
