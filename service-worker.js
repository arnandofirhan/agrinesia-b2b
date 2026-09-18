/*************************************************************
 * SERVICE WORKER — Agrinesia B2B (versi GitHub Pages)
 * -----------------------------------------------------------
 * STRATEGI: cache APP SHELL saja (HTML/CSS/JS/icon statis) untuk
 * "Add to Home Screen" + load lebih cepat pada kunjungan berikutnya.
 *
 * PENTING — TIDAK PERNAH cache request ke domain GAS (script.google.com /
 * script.googleusercontent.com): field agent butuh data PO/order/komisi
 * yang selalu fresh, bukan snapshot lama dari cache. Semua request RPC
 * (lewat api-bridge.js) SELALU tembus ke network, tidak pernah diintersep
 * SW ini — lihat filter origin di fetch handler bawah.
 *
 * CACHE_VERSION: naikkan angka ini SETIAP kali app-shell (index.html,
 * app.js, stylesheet.css) berubah, supaya device lama otomatis ambil
 * versi baru alih-alih terjebak di cache lama — sama prinsipnya dengan
 * CACHE_VERSION di versi GAS-hybrid sebelumnya (lihat overview.md).
 *************************************************************/
var CACHE_VERSION = 'agri-b2b-shell-v1';

var SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './stylesheet.css',
  './api-bridge.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(SHELL_FILES);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE_VERSION; })
          .map(function (key) { return caches.delete(key); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  // JANGAN PERNAH intersep request ke GAS (RPC data) — selalu network langsung,
  // tanpa cache, apa pun kondisinya. Ini yang menjaga data field agent tetap fresh.
  if (url.hostname.indexOf('script.google.com') !== -1 ||
      url.hostname.indexOf('script.googleusercontent.com') !== -1) {
    return; // biarkan browser handle seperti biasa (tidak ada respondWith)
  }

  // Hanya intersep GET (app shell); method lain (POST RPC, dll) lewat apa adanya.
  if (event.request.method !== 'GET') return;

  // Cache-first untuk app shell: cepat dan tetap jalan offline; balik ke network
  // kalau belum ada di cache (mis. file baru yang belum sempat di-precache).
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      return cached || fetch(event.request);
    })
  );
});
