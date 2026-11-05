'use strict';

// The shared Riderly look on the marketing and sign-in pages, and the door app staying out of it.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

const MARKETING = ['index.html', 'guide.html', 'privacy.html', 'terms.html'];
const DOOR = ['login.html', 'setup.html', 'venue-admin-reset.html'];
const DOOR_APP = ['app.html', 'contributor.html', 'admin.html', 'venue-admin.html'];

let server;
let base;

before(async () => {
  server = createApp(openDb(':memory:'), { purgeTimer: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('every marketing page carries the shell version of its copy of site.css', () => {
  const version = read('static/riderly/site.css').match(/^\/\* riderly-shell: (\d+)\b/)[1];
  for (const f of MARKETING) assert.ok(read(f).includes(`data-riderly-shell="${version}"`), f);
});

test('the home page has what the Riderly drift check reads', () => {
  const home = read('index.html');
  assert.match(home, /data-riderly-shell="\d+"/);
  assert.match(home, /href="https:\/\/riderly\.com\.au\/"/);
});

test('the bar, tabs and footer are the same on every marketing page', () => {
  // What may differ: the page's own id on Sign in, and where "here" links go (in-page on the home).
  const part = (html, re) => html.match(re)[0]
    .replace(/ id="nav-(login|app)"/, '')
    .replace(/href="(\/?#apply)"/g, 'href="APPLY"')
    .replace(/href="(#top|\/)"( aria-current)/g, 'href="HOME"$2')
    .replace(/\s*<p class="rs-foot-note">.*<\/p>/, '');
  for (const re of [/<header class="rs-top"[\s\S]*?<\/header>/, /<nav class="rs-tabs"[\s\S]*?<\/nav>/, /<footer class="rs-foot">[\s\S]*?<\/footer>/]) {
    const first = part(read(MARKETING[0]), re);
    for (const f of MARKETING.slice(1)) assert.equal(part(read(f), re), first, `${f} ${re}`);
  }
  const foot = read('index.html').match(/<footer class="rs-foot">[\s\S]*?<\/footer>/)[0];
  for (const want of ['/privacy', '/terms', '/login', 'https://riderly.com.au/vmt/', 'mailto:wpmixing@gmail.com']) assert.ok(foot.includes(want), want);
});

test('the pages say Sign in, and the theme colour is the shared navy', () => {
  for (const f of [...MARKETING, ...DOOR]) {
    assert.doesNotMatch(read(f), /Log in\b/, f);
    assert.ok(read(f).includes('<meta name="theme-color" content="#0b1220">'), f);
    assert.ok(read(f).includes('/static/riderly/logos/guest-list-icon.svg'), f);
  }
  for (const f of ['js/login.js', 'js/setup.js', 'js/venue-admin-reset.js']) assert.doesNotMatch(read(f), /\b[Ll]og(ged)? (in|out)\b/, f);
});

test('the door app never loads the marketing look', () => {
  for (const f of DOOR_APP) {
    const html = read(f);
    assert.ok(html.includes('/css/styles.css'), f);
    assert.doesNotMatch(html, /site\.css|riderly-pages\.css|rs-page/, f);
  }
  assert.doesNotMatch(read('css/styles.css'), /\.rs-|Prata|Libre Franklin/);
});

test('landing.js still finds everything it hooks into', () => {
  const home = read('index.html');
  const js = read('js/landing.js');
  for (const id of ['nav-login', 'demo', 'd-list', 'd-search', 'd-toast', 'd-inside', 'd-arrived', 'd-vip', 'signup-form', 'signup-status']) {
    assert.ok(home.includes(`id="${id}"`), id);
  }
  assert.ok(js.includes("getElementById('nav-login')"));
  assert.ok(home.includes('data-demo'));
  assert.ok(read('guide.html').includes('id="nav-app"'));
  for (const name of ['venueName', 'suburb', 'name', 'phone', 'email', 'showsPerMonth', 'capacity', 'ticketing', 'message', 'website']) {
    assert.match(home, new RegExp(`<(input|select|textarea) name="${name}"`), name);
  }
});

test('nothing loads from another site, and nothing breaks the content policy', async () => {
  for (const f of [...MARKETING, ...DOOR]) {
    const html = read(f);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${f}: inline script`);
    assert.doesNotMatch(html, /<style\b|\sstyle="/, `${f}: inline style`);
    for (const m of html.matchAll(/<(?:script|img)\b[^>]*\bsrc="([^"]+)"|<link\b[^>]*\bhref="([^"]+)"/g)) {
      const url = m[1] || m[2];
      if (/rel="canonical"/.test(m[0])) continue;
      assert.match(url, /^\/[^/]/, `${f}: ${url}`);
      assert.equal((await fetch(base + url)).status, 200, `${f}: ${url}`);
    }
  }
  for (const f of ['static/riderly/site.css', 'css/riderly-pages.css', 'css/riderly-noscript.css']) {
    for (const m of read(f).matchAll(/url\("?([^")]+)"?\)/g)) {
      assert.match(m[1], /^\/[^/]/, m[1]);
      assert.equal((await fetch(base + m[1])).status, 200, m[1]);
    }
    assert.doesNotMatch(read(f), /@import|https?:\/\//, f);
  }
  const font = await fetch(`${base}/static/riderly/fonts/prata-400-latin.woff2`);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.match(font.headers.get('content-security-policy'), /default-src 'self'/);
});
