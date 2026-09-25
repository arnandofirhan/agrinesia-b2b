// Service worker Agrinesia B2B (Vercel / GitHub Pages).
// - App shell (index.html, api-bridge.js, manifest): stale-while-revalidate -> buka app INSTAN dari cache,
//   sambil cek versi terbaru di background. Kalau isinya berubah (ETag/Last-Modified beda), kirim pesan
//   'ag-update' ke halaman supaya user tahu ada versi baru (berlaku begitu app dibuka lagi).
// - Icon: cache-first.
// - Request lintas domain (Apps Script /exec, Google Drive, dst.) TIDAK disentuh sama sekali.
var CACHE = 'agrinesia-shell-v2';
var SHELL = ['./', './index.html', './api-bridge.js', './manifest.json',
             './icon-192.png', './icon-512.png', './icon-maskable-192.png', './icon-maskable-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) {
      return fetch(u, { cache: 'reload' }).then(function (r) { if (r.ok) return c.put(u, r); }).catch(function () {});
    }));
  }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function versionOf(res) {
  return (res && (res.headers.get('etag') || res.headers.get('last-modified') || res.headers.get('content-length'))) || '';
}

function notifyUpdate() {
  self.clients.matchAll({ type: 'window' }).then(function (cs) {
    cs.forEach(function (c) { c.postMessage({ type: 'ag-update' }); });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;            // jangan sentuh Google/GAS
  if (url.pathname.endsWith('/sw.js')) return;

  var isShell = req.mode === 'navigate' || /\.(html|js|json)$/.test(url.pathname) || url.pathname.endsWith('/');
  var key = req.mode === 'navigate' ? './index.html' : req;

  if (isShell) {
    e.respondWith(
      caches.open(CACHE).then(function (cache) {
        return cache.match(key).then(function (cached) {
          var network = fetch(req.mode === 'navigate' ? './index.html' : req, { cache: 'no-cache' }).then(function (res) {
            if (res && res.ok) {
              if (cached && versionOf(cached) && versionOf(res) && versionOf(cached) !== versionOf(res)) notifyUpdate();
              cache.put(key, res.clone());
            }
            return res;
          });
          if (cached) { network.catch(function () {}); return cached; }
          return network;
        });
      })
    );
    return;
  }

  // Aset lain (icon dst.): cache-first
  e.respondWith(caches.match(req).then(function (hit) { return hit || fetch(req); }));
});
