'use strict';

// Renders the PNG app icons (iPhone home screen, Android) from the Guest List mark.
//   node scripts/make-icons.js   (needs Playwright — a dev tool, not an app dependency)

const path = require('node:path');
const { execSync } = require('node:child_process');
const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));

const OUT = path.join(__dirname, '..', 'public');
// Full-bleed square (iOS rounds the corners itself). The mark's furthest corner sits 39.6% of the
// width from the centre, just inside the 40% circle Android masks keep. The committed PNGs come
// straight from the Riderly logo package; this draws the same shapes.
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#0b1220"/>
  <circle cx="50" cy="40" r="22" fill="#3fb8a6"/>
  <rect x="22" y="70" width="56" height="8" fill="#3fb8a6"/>
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
