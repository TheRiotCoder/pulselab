// PulseLab service worker: versioned precache, offline-first for app files, no network use for user data.
const VERSION = '1.1.1';
const CACHE = 'pulselab-v' + VERSION;
const ASSETS = ['./', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/util.js', 'js/db.js', 'js/state.js', 'js/fit.js', 'js/import.js', 'js/analysis.js', 'js/insights.js', 'js/charts.js', 'js/demo.js', 'js/views.js', 'js/dataview.js', 'js/version.js',
  'vendor/fflate.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(a => new Request(a, { cache: 'reload' })))));
  // no skipWaiting here: the page offers an "Update available" prompt instead
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('pulselab-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); if (e.data === 'VERSION') e.source && e.source.postMessage({ version: VERSION }); });
self.addEventListener('fetch', e => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { if (r.ok && !r.redirected) { const c = r.clone(); caches.open(CACHE).then(ch => ch.put('./', c)); } return r; }).catch(() => caches.match('./', { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(ch => ch.put(req, c)); } return r; })));
});
