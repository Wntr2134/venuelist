'use strict';

// Service worker: keeps the door app usable when the venue Wi-Fi drops.
// Network first (so updates always win), falling back to the last copy saved on this phone.

const CACHE = 'vl-door-v4';
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

// VIP alerts. The push itself is empty; the phone asks the server (with its own login) what's new.
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    // Remember the last alert shown, so each one buzzes once.
    const store = await caches.open('vl-push');
    const lastRes = await store.match('/__last-alert');
    const last = lastRes ? Number(await lastRes.text()) || 0 : 0;
    let alerts = null;
    try {
      const res = await fetch(`/api/push/latest?after=${last}`, { credentials: 'same-origin', cache: 'no-store' });
      if (res.ok) alerts = await res.json();
    } catch {
      /* offline: fall through to the general alert */
    }
    if (alerts && !alerts.length) return; // already shown (browsers allow the odd quiet push)
    if (!alerts) alerts = [{ id: 'vip', title: '★ VIP arrived', body: 'Open door mode to see who.', url: '/app' }];
    const newest = Math.max(last, ...alerts.map((a) => Number(a.id) || 0));
    await store.put('/__last-alert', new Response(String(newest)));
    await Promise.all(alerts.slice(0, 3).map((a) => self.registration.showNotification(a.title, {
      body: a.body, tag: `vip-${a.id}`, data: { url: a.url }, icon: '/icon-192.png', badge: '/icon-192.png',
    })));
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((w) => new URL(w.url).pathname === '/app');
    if (open) {
      await open.focus();
      return open.navigate(url);
    }
    return self.clients.openWindow(url);
  })());
});
