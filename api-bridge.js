/*************************************************************
 * API-BRIDGE.JS — Agrinesia B2B (frontend terpisah / GitHub Pages)
 * -----------------------------------------------------------
 * Menyediakan `google.script.run`-compatible API di browser yang
 * TIDAK dijalankan sebagai GAS HtmlService page (misalnya saat
 * index.html/javascript.html/stylesheet.html di-hosting statis
 * di GitHub Pages), dengan memanggil endpoint /exec (doPost →
 * handleRpc_ di Code.gs) lewat fetch().
 *
 * TIDAK ADA satu baris pun di javascript.html yang perlu diubah:
 * setiap `google.script.run.withSuccessHandler(...).withFailureHandler(...).fnName(args)`
 * tetap ditulis persis sama seperti versi native GAS.
 *
 * KONTRAK BACKEND (lihat Code.gs):
 *   doPost(e) -> handleRpc_(e)
 *   Body request (single):  { fn: "namaFungsi", args: [...] }
 *   Body request (batch):   { batch: [ {fn, args}, {fn, args}, ... ] }
 *   Response (single):      { ok:true, result:<any> } | { ok:false, error:"pesan" }
 *   Response (batch):       { ok:true, batch: [ {ok,result}|{ok:false,error}, ... ] }
 *
 * WAJIB DIISI SEBELUM DIPAKAI:
 *   AGRI_BRIDGE_CONFIG.EXEC_URL = URL Web App GAS (diakhiri /exec)
 *************************************************************/
(function (global) {
  'use strict';

  // =====================================================
  // KONFIGURASI — isi EXEC_URL dengan URL deploy GAS kamu
  // (Deploy > Manage deployments > Web app > URL, akhiran /exec)
  // =====================================================
  var CONFIG = {
    EXEC_URL: (global.AGRI_BRIDGE_CONFIG && global.AGRI_BRIDGE_CONFIG.EXEC_URL) || '',

    // Jendela waktu (ms) untuk mengumpulkan beberapa panggilan google.script.run
    // yang terjadi hampir bersamaan menjadi SATU request batch — meniru semangat
    // handleBatchRpc_ yang sudah dipakai boot path AGENT (lihat performance-overhaul).
    BATCH_WINDOW_MS: 20,

    // Kuota concurrent request AKTUAL ke GAS, dipisah prioritas supaya polling/
    // preload background (LO) tidak menyaingi aksi user langsung (HI) — sama
    // prinsipnya dengan STAGGER_MS/PRELOAD_PAGE_LIMIT_ yang sudah ada di Code.gs.
    MAX_CONCURRENT_HI: 4,
    MAX_CONCURRENT_LO: 2,

    // Retry untuk error transient (network drop, GAS 5xx, redirect gagal) —
    // BUKAN untuk error aplikasi (mis. "Sesi habis"), yang harus langsung
    // sampai ke failureHandler tanpa diulang.
    MAX_RETRIES: 2,
    RETRY_BASE_DELAY_MS: 400,

    // Timeout per request tunggal (ms) sebelum dianggap gagal.
    REQUEST_TIMEOUT_MS: 30000
  };

  if (!CONFIG.EXEC_URL) {
    console.error('[api-bridge] AGRI_BRIDGE_CONFIG.EXEC_URL belum diisi. ' +
      'Set sebelum javascript.html dimuat, mis:\n' +
      '<script>window.AGRI_BRIDGE_CONFIG = { EXEC_URL: "https://script.google.com/macros/s/XXXX/exec" };</script>');
  }

  // =====================================================
  // Nama fungsi yang dipanggil low-priority (dipakai preload/polling
  // di javascript.html) — request ini dikirim lewat kuota LO supaya
  // tidak menyaingi aksi user yang aktif menunggu (klik tombol, submit).
  // Daftar ini bebas ditambah; fungsi yang tidak terdaftar otomatis HI.
  // =====================================================
  var LOW_PRIORITY_FNS = {
    ping: true,
    getUnreadChatCount: true,
    listChatMessages: true,
    getMySignatureStatus: true
  };

  // =====================================================
  // ANTRIAN & BATCHING
  // =====================================================
  var pendingBatch = [];   // job menunggu dikumpulkan jadi 1 request
  var batchTimer = null;
  var activeHi = 0;
  var activeLo = 0;
  var waitQueueHi = [];
  var waitQueueLo = [];

  function isLowPriority(fnName) {
    return !!LOW_PRIORITY_FNS[fnName];
  }

  function nextTick(fn) {
    // setTimeout(0) dipakai daripada Promise.microtask supaya jendela batching
    // benar-benar menunggu BATCH_WINDOW_MS, bukan cuma end-of-microtask-queue.
    return setTimeout(fn, 0);
  }

  function scheduleFlush() {
    if (batchTimer) return;
    batchTimer = setTimeout(flushBatch, CONFIG.BATCH_WINDOW_MS);
  }

  function flushBatch() {
    batchTimer = null;
    if (!pendingBatch.length) return;

    var jobs = pendingBatch;
    pendingBatch = [];

    // Pisah HI/LO jadi dua request batch terpisah supaya prioritas tetap berlaku
    // di level jaringan (LO tidak memblokir HI walau digabung waktunya).
    var hiJobs = jobs.filter(function (j) { return !j.lowPriority; });
    var loJobs = jobs.filter(function (j) { return j.lowPriority; });

    if (hiJobs.length) runQueued(hiJobs, false);
    if (loJobs.length) runQueued(loJobs, true);
  }

  function runQueued(jobs, lowPriority) {
    var waitQueue = lowPriority ? waitQueueLo : waitQueueHi;
    waitQueue.push(jobs);
    pumpQueue(lowPriority);
  }

  function pumpQueue(lowPriority) {
    var waitQueue = lowPriority ? waitQueueLo : waitQueueHi;
    var maxConcurrent = lowPriority ? CONFIG.MAX_CONCURRENT_LO : CONFIG.MAX_CONCURRENT_HI;
    var activeCount = lowPriority ? activeLo : activeHi;

    if (activeCount >= maxConcurrent || !waitQueue.length) return;

    var jobs = waitQueue.shift();
    if (lowPriority) activeLo++; else activeHi++;

    sendBatch(jobs).finally(function () {
      if (lowPriority) activeLo--; else activeHi--;
      pumpQueue(lowPriority);
    });
  }

  function sendBatch(jobs) {
    var body = jobs.length === 1
      ? { fn: jobs[0].fn, args: jobs[0].args }
      : { batch: jobs.map(function (j) { return { fn: j.fn, args: j.args }; }) };

    return fetchWithRetry(body, 0).then(function (payload) {
      if (jobs.length === 1) {
        settleJob(jobs[0], payload);
        return;
      }
      // Respons batch: payload.ok true di level HTTP/transport, tiap item punya ok sendiri.
      if (!payload || payload.ok !== true || !Array.isArray(payload.batch)) {
        // Kegagalan transport total untuk seluruh batch (bukan error per-fungsi) —
        // sebar sebagai failure ke semua job supaya tidak ada callback yang menggantung.
        var transportErr = (payload && payload.error) || 'Respons batch tidak valid dari server';
        jobs.forEach(function (j) { settleJob(j, { ok: false, error: transportErr }); });
        return;
      }
      jobs.forEach(function (j, i) { settleJob(j, payload.batch[i]); });
    }).catch(function (err) {
      var msg = (err && err.message) ? err.message : String(err);
      jobs.forEach(function (j) { settleJob(j, { ok: false, error: msg }); });
    });
  }

  function settleJob(job, result) {
    if (result && result.ok) {
      if (job.onSuccess) {
        try { job.onSuccess(result.result); } catch (cbErr) { console.error('[api-bridge] success handler error:', cbErr); }
      }
    } else {
      var errMsg = (result && result.error) || 'Terjadi kesalahan tidak diketahui';
      if (job.onFailure) {
        try { job.onFailure(new Error(errMsg)); } catch (cbErr) { console.error('[api-bridge] failure handler error:', cbErr); }
      } else {
        // Sama seperti google.script.run native: tanpa withFailureHandler, error
        // dilempar ke console, tidak membisu total.
        console.error('[api-bridge] RPC "' + job.fn + '" gagal tanpa failureHandler:', errMsg);
      }
    }
  }

  // =====================================================
  // TRANSPORT — fetch dengan timeout + retry untuk error transient
  // =====================================================
  function fetchWithRetry(body, attempt) {
    return fetchOnce(body).catch(function (err) {
      var isTransient = err && err.transient;
      if (isTransient && attempt < CONFIG.MAX_RETRIES) {
        var delay = CONFIG.RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        return new Promise(function (resolve) {
          setTimeout(resolve, delay);
        }).then(function () {
          return fetchWithRetry(body, attempt + 1);
        });
      }
      throw err;
    });
  }

  function fetchOnce(body) {
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timeoutId = controller && setTimeout(function () { controller.abort(); }, CONFIG.REQUEST_TIMEOUT_MS);

    return fetch(CONFIG.EXEC_URL, {
      method: 'POST',
      // text/plain menghindari CORS preflight (OPTIONS) yang tidak didukung GAS
      // Web App secara native — pola standar untuk POST ke doPost dari origin lain.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: controller ? controller.signal : undefined
    })
      .then(function (res) {
        if (timeoutId) clearTimeout(timeoutId);
        if (!res.ok) {
          var e = new Error('HTTP ' + res.status + ' dari server');
          e.transient = res.status >= 500 || res.status === 429;
          throw e;
        }
        return res.json();
      })
      .catch(function (err) {
        if (timeoutId) clearTimeout(timeoutId);
        if (err && err.name === 'AbortError') {
          var timeoutErr = new Error('Request timeout — jaringan lambat, coba lagi');
          timeoutErr.transient = true;
          throw timeoutErr;
        }
        // Kegagalan fetch murni (offline, DNS, CORS block) dianggap transient —
        // layak diretry sebelum menyerah ke failureHandler.
        if (err instanceof TypeError) {
          err.transient = true;
        }
        throw err;
      });
  }

  // =====================================================
  // google.script.run SHIM
  // Mendukung dua gaya pemanggilan yang keduanya dipakai di javascript.html:
  //   google.script.run.namaFungsi(args)                          // fire-and-forget
  //   google.script.run.withSuccessHandler(fn).namaFungsi(args)   // dengan handler
  //   google.script.run.withSuccessHandler(fn).withFailureHandler(fn).namaFungsi(args)
  // =====================================================
  function createRunProxy(onSuccess, onFailure) {
    var proxy = {
      withSuccessHandler: function (fn) { return createRunProxy(fn, onFailure); },
      withFailureHandler: function (fn) { return createRunProxy(onSuccess, fn); },
      // withUserObject tidak dipakai di codebase ini (dicek: 0 pemakaian), tapi
      // disediakan sebagai no-op supaya tidak crash jika suatu saat dipanggil.
      withUserObject: function () { return proxy; }
    };

    return new Proxy(proxy, {
      get: function (target, prop) {
        if (prop in target) return target[prop];
        // prop yang tidak dikenal = nama fungsi backend yang mau dipanggil
        return function () {
          var args = Array.prototype.slice.call(arguments);
          var job = {
            fn: prop,
            args: args,
            onSuccess: onSuccess,
            onFailure: onFailure,
            lowPriority: isLowPriority(prop)
          };
          pendingBatch.push(job);
          scheduleFlush();
        };
      }
    });
  }

  global.google = global.google || {};
  global.google.script = global.google.script || {};
  global.google.script.run = createRunProxy(null, null);

  // =====================================================
  // Ekstra: dipakai langsung (bukan lewat shim) untuk kasus yang butuh
  // Promise, mis. boot path yang membatch validateSession + getAgentDashboardConfig
  // secara eksplisit (lihat performance-overhaul.md).
  // =====================================================
  global.callBackendBatch = function (calls) {
    // calls: [{fn, args}, ...] -> Promise<[result, result, ...]> (reject jika ADA yang gagal)
    return new Promise(function (resolve, reject) {
      var results = new Array(calls.length);
      var remaining = calls.length;
      var failed = false;

      calls.forEach(function (call, i) {
        var job = {
          fn: call.fn,
          args: call.args || [],
          lowPriority: isLowPriority(call.fn),
          onSuccess: function (r) {
            results[i] = r;
            remaining--;
            if (remaining === 0 && !failed) resolve(results);
          },
          onFailure: function (err) {
            if (failed) return;
            failed = true;
            reject(err);
          }
        };
        pendingBatch.push(job);
      });
      scheduleFlush();
    });
  };
  global.window && (global.window.callBackendBatch = global.callBackendBatch);

  console.log('[api-bridge] Siap. EXEC_URL=' + (CONFIG.EXEC_URL ? 'terkonfigurasi' : 'BELUM DIISI'));
})(typeof window !== 'undefined' ? window : this);
