/* Agrinesia B2B — Service Worker. Naikkan VERSION tiap rilis agar cache lama dibuang. */
const VERSION = 'v1-1791326048';
const CACHE = 'agrinesia-' + VERSION;
const SHELL = ['./','index.html','css/style.css','js/app.js','api-bridge.js','manifest.json','icon-192.png','icon-512.png'];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){
    return Promise.all(SHELL.map(function(u){ return c.add(u).catch(function(){}); }));
  }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k.indexOf('agrinesia-')===0 && k!==CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
// Network-first (selalu dapat versi terbaru), fallback ke cache saat offline.
// Request ke Apps Script (lintas-origin) TIDAK disentuh sama sekali.
self.addEventListener('fetch', function(e){
  var req = e.request;
  if(req.method !== 'GET') return;
  var url = new URL(req.url);
  if(url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(function(res){
      if(res && res.ok){ var copy = res.clone(); caches.open(CACHE).then(function(c){ c.put(req, copy); }); }
      return res;
    }).catch(function(){
      return caches.match(req, {ignoreSearch:true}).then(function(hit){
        return hit || (req.mode==='navigate' ? caches.match('index.html') : Response.error());
      });
    })
  );
});
