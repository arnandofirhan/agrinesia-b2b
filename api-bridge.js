/* api-bridge.js — shim google.script.run -> POST ke Apps Script /exec (doPost/handleRpc_ di Code.gs).
 * Fitur: chain withSuccessHandler/withFailureHandler/withUserObject, batching, antrian prioritas
 * (window.__BG_LOW_PRIORITY__ = low), retry untuk gagal-jaringan/429/5xx, reset antrian saat logout.
 * PENTING: Content-Type SENGAJA text/plain agar tidak memicu preflight CORS (GAS tak bisa jawab OPTIONS). */
(function(){
  'use strict';
  var BATCH_WINDOW_MS = 25, MAX_BATCH = 8, MAX_HI = 3, MAX_LO = 2, TIMEOUT_MS = 90000, MAX_RETRY = 2;
  var hi = [], lo = [], inHi = 0, inLo = 0, timer = null, gen = 0;

  function url_(){
    var u = String(window.GAS_EXEC_URL || '').trim();
    return (/^https:\/\/script\.google\.com\/.+\/exec/.test(u)) ? u : '';
  }
  function enqueue(fn, args, ok, fail, user, low){
    var job = { fn: fn, args: args, ok: ok, fail: fail, user: user, low: low, tries: 0, gen: gen };
    (low ? lo : hi).push(job);
    schedule();
  }
  function schedule(){ if(!timer){ timer = setTimeout(function(){ timer = null; pump(); }, BATCH_WINDOW_MS); } }
  function pump(){
    var took = true;
    while(took){
      took = false;
      if(hi.length && inHi < MAX_HI){ send(hi.splice(0, MAX_BATCH), false); took = true; }
      else if(!hi.length && lo.length && inLo < MAX_LO){ send(lo.splice(0, MAX_BATCH), true); took = true; }
    }
  }
  function settle(job, good, val){
    var cb = good ? job.ok : job.fail;
    if(job.gen !== gen && (job.ok || job.fail)) return; // sesi lama (setelah logout) -> abaikan
    if(typeof cb !== 'function'){ if(!good) console.error('[api-bridge]', job.fn, val && val.message); return; }
    try{ cb(val, job.user); }catch(e){ console.error('[api-bridge] handler error', job.fn, e); }
  }
  function failAll(batch, msg){ batch.forEach(function(j){ settle(j, false, new Error(msg)); }); }

  function send(batch, low){
    if(low) inLo++; else inHi++;
    var done = function(){ if(low) inLo--; else inHi--; pump(); };
    var u = url_();
    if(!u){ done(); failAll(batch, 'GAS_EXEC_URL belum diisi / tidak valid di index.html'); return; }
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var to = setTimeout(function(){ if(ctl) ctl.abort(); }, TIMEOUT_MS);
    var retry = function(why){
      var again = batch.filter(function(j){ return j.tries < MAX_RETRY; });
      var dead = batch.filter(function(j){ return j.tries >= MAX_RETRY; });
      if(dead.length) failAll(dead, why);
      if(again.length){
        again.forEach(function(j){ j.tries++; });
        setTimeout(function(){ again.forEach(function(j){ (low ? lo : hi).unshift(j); }); schedule(); }, 600 * again[0].tries);
      }
    };
    fetch(u, {
      method: 'POST', redirect: 'follow', credentials: 'omit',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ batch: batch.map(function(j){ return { fn: j.fn, args: j.args }; }) }),
      signal: ctl ? ctl.signal : undefined
    }).then(function(res){
      clearTimeout(to);
      if(res.status === 429 || res.status >= 500){ done(); retry('Server sibuk (' + res.status + ')'); return; }
      return res.text().then(function(t){
        var data; try{ data = JSON.parse(t); }catch(e){ done(); retry('Respons server tidak valid'); return; }
        done();
        if(!data || data.ok === false || !Array.isArray(data.batch)){
          failAll(batch, (data && data.error) || 'Respons server tidak valid'); return;
        }
        batch.forEach(function(j, i){
          var r = data.batch[i];
          if(r && r.ok) settle(j, true, r.result);
          else settle(j, false, new Error((r && r.error) || 'Gagal memproses permintaan'));
        });
      });
    }).catch(function(err){
      clearTimeout(to); done();
      if(err && err.name === 'AbortError'){ failAll(batch, 'Waktu tunggu server habis'); return; } // timeout: jangan retry (cegah duplikasi data)
      retry('Tidak bisa terhubung ke server. Periksa koneksi internet.');
    });
  }

  function runner(ok, fail, user){
    return new Proxy({}, { get: function(_, p){
      if(typeof p !== 'string' || p === 'then') return undefined;
      if(p === 'withSuccessHandler') return function(h){ return runner(h, fail, user); };
      if(p === 'withFailureHandler') return function(h){ return runner(ok, h, user); };
      if(p === 'withUserObject')     return function(o){ return runner(ok, fail, o); };
      return function(){ enqueue(p, Array.prototype.slice.call(arguments), ok, fail, user, !!window.__BG_LOW_PRIORITY__); };
    }});
  }
  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = runner();

  // Dipanggil saat logout: buang antrian bersandi handler; panggilan tanpa handler (mis. logout) tetap dikirim.
  window.__apiBridgeResetQueue__ = function(){
    gen++;
    hi = hi.filter(function(j){ return !(j.ok || j.fail); });
    lo = lo.filter(function(j){ return !(j.ok || j.fail); });
  };
})();
