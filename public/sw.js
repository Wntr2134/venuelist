'use strict';

// Service worker: keeps the door app usable when the venue Wi-Fi drops.
// Network first (so updates always win), falling back to the last copy saved on this phone.

const CACHE = 'vl-door-v3';
const SHELL = ['/app', '/guide', '/js/guide.js', '/css/styles.css', '/js/common.js', '/js/app.js', '/icon.svg', '/apple-touch-icon.png', '/manifest.webmanifest',
  '/fonts/bigshoulders-var.woff2', '/fonts/instrumentsans-var.woff2', '/fonts/jetbrainsmono-500.woff2'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// What's worth keeping a copy of: the app itself, and the data door mode needs to open offline.
function cacheable(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  if (p === '/app' || p === '/app/' || p === '/guide') return true; // the guide works offline too
  if (/^\/(css|js|fonts)\//.test(p) || /\.(svg|png|webmanifest|woff2)$/.test(p)) return true;
  if (p === '/api/session' || p === '/api/events' || /^\/api\/events\/\d+$/.test(p)) return true;
  return false;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!cacheable(url)) return; // everything else goes straight to the network

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: url.pathname === '/app' }).then((hit) => hit || Response.error()))
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'clear') event.waitUntil(caches.delete(CACHE));
});
