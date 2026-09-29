'use strict';

// Renders the PNG app icons (iPhone home screen, Android) from the star logo.
//   node scripts/make-icons.js   (needs Playwright — a dev tool, not an app dependency)

const path = require('node:path');
const { execSync } = require('node:child_process');
const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));

const OUT = path.join(__dirname, '..', 'public');
// Full-bleed square (iOS rounds the corners itself); star kept inside the safe zone for Android masks.
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <defs><radialGradient id="g" cx="0.75" cy="0.15" r="0.9"><stop offset="0" stop-color="#2a1f5c"/><stop offset="1" stop-color="#0d0d12"/></radialGradient></defs>
  <rect width="64" height="64" fill="url(#g)"/>
  <path d="M32 14l5.3 11.4 12.4 1.5-9.1 8.5 2.3 12.3L32 41.6l-10.9 6.1 2.3-12.3-9.1-8.5 12.4-1.5z" fill="#f5c542"/>
</svg>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [file, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<body style="margin:0">${svg(size)}</body>`);
    await page.screenshot({ path: path.join(OUT, file), omitBackground: false });
    console.log('wrote', file);
  }
  await browser.close();
})();
