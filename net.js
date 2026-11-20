// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TT Extras contributors. See LICENSE.
// TT Extras net.js: InnerTube calls (app's KabukiInnerTubeClient first, XHR fallback) and same-origin GETs
// through one queue (3 in flight, FIFO, per-request timeout). ES5 only. See build/design-subs-block.md 4.6.
(function () {
  if (location.hostname !== 'www.youtube.com') return;
  if (window.__ttxNet) return;
  window.__ttxNet = true;
  var X = window.__ttx;
  if (!X) return;

  var MAX_IN_FLIGHT = 3;
  var MAX_QUEUED = 400;     // bounded: beyond this a new request fails at once ('busy') instead of piling up
  var DEFAULT_TIMEOUT = 8000;
  var queue = [];
  var active = [];
  var failures = 0;
  var clientOk = null;      // null unknown, true seen working, false unusable for the session
  var client = null;
  var pumping = false;

  function fail(info) {
    failures++;
    try { X.log({ net: info }); } catch (e) {}
  }

  function findClient() {
    if (clientOk === false) return null;
    if (client) return client;
    try {
      var c = null, k, v;
      for (k in window._yttv) {
        v = window._yttv[k];
        if (v && v.mappings) { c = v; break; }
      }
      var kc = c ? c.get('KabukiInnerTubeClient') : null;
      if (kc && typeof kc.fetch === 'function') { client = kc; return kc; }
    } catch (e) {}
    clientOk = false;
    return null;
  }

  function getConfig() {
    var cfg = null;
    try { if (window.ytcfg && typeof window.ytcfg.d === 'function') cfg = window.ytcfg.d(); } catch (e) {}
    try { if (!cfg && window.yt && window.yt.config_) cfg = window.yt.config_; } catch (e2) {}
    return cfg && cfg.INNERTUBE_CONTEXT ? cfg : null;
  }

  // ---- queue ----------------------------------------------------------------------------
  function finishJob(job, err, a, b) {
    if (job.done) return;
    job.done = true;
    if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    for (var i = 0; i < active.length; i++) if (active[i] === job) { active.splice(i, 1); break; }
    if (err && err !== 'cancelled') fail({ kind: job.kind, target: job.target, err: typeof err === 'object' ? (err.status || String(err.error || '')) : err });
    var cb = job.cb;
    job.cb = job.run = job.abort = null; // a late XHR/observable callback must not keep the response or closures alive
    try { cb(err, a, b); } catch (e) {}
    pump();
  }

  function startJob(job) {
    active.push(job);
    job.timer = setTimeout(function () {
      job.timer = null;
      if (job.done) return;
      try { if (job.abort) job.abort(); } catch (e) {}
      finishJob(job, 'timeout');
    }, job.timeout);
    try {
      job.run(job, function (err, a, b) { finishJob(job, err, a, b); });
    } catch (e) {
      finishJob(job, { error: String(e) });
    }
  }

  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (active.length < MAX_IN_FLIGHT && queue.length) startJob(queue.shift());
    } finally { pumping = false; }
  }

  function enqueue(kind, target, run, cb, opts) {
    var job = {
      kind: kind, target: target, run: run, cb: typeof cb === 'function' ? cb : function () {},
      group: opts && opts.group, timeout: (opts && opts.timeout) || DEFAULT_TIMEOUT,
      done: false, timer: null, abort: null
    };
    if (queue.length >= MAX_QUEUED) {
      setTimeout(function () { fail({ kind: kind, target: target, err: 'busy' }); try { job.cb('busy'); } catch (e) {} }, 0);
      return;
    }
    queue.push(job);
    pump();
  }

  // ---- XHR ------------------------------------------------------------------------------
  function xhrRun(job, method, url, body, headers, onText) {
    var xhr = new XMLHttpRequest();
    job.abort = function () { try { xhr.abort(); } catch (e) {} };
    xhr.open(method, url);
    xhr.timeout = job.timeout;
    xhr.responseType = '';
    for (var h in headers) if (Object.prototype.hasOwnProperty.call(headers, h)) xhr.setRequestHeader(h, headers[h]);
    xhr.onload = function () { onText(xhr.status, xhr.responseText); };
    xhr.onerror = function () { onText(0, null, 'network'); };
    xhr.ontimeout = function () { onText(0, null, 'timeout'); };
    xhr.onabort = function () { onText(0, null, 'aborted'); };
    xhr.send(body);
  }

  function innertubeXhr(job, path, payload, done) {
    var cfg = getConfig();
    if (!cfg) { done('noConfig'); return; }
    var body = { context: cfg.INNERTUBE_CONTEXT }, k;
    for (k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) body[k] = payload[k];
    var url = path + '?prettyPrint=false&key=' + encodeURIComponent(cfg.INNERTUBE_API_KEY || '');
    var headers = {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': String(cfg.INNERTUBE_CONTEXT_CLIENT_NAME || 7),
      'X-YouTube-Client-Version': String(cfg.INNERTUBE_CLIENT_VERSION || '')
    };
    xhrRun(job, 'POST', url, X.origStringify(body), headers, function (status, text, why) {
      if (why) { done(why); return; }
      if (status < 200 || status >= 300) { done({ status: status }); return; }
      var json;
      try { json = X.origParse(text); } catch (e) { done('parse'); return; }
      done(null, json);
    });
  }

  // ---- public ---------------------------------------------------------------------------
  function innertube(path, payload, cb, opts) {
    payload = payload || {};
    enqueue('innertube', path, function (job, done) {
      var kc = findClient();
      if (kc) {
        var sub = null;
        try {
          var obs = kc.fetch({ path: path, payload: payload });
          if (obs && typeof obs.subscribe === 'function') {
            var subscription = obs.subscribe(function (res) {
              var out = res;
              if (typeof res === 'string') {
                try { out = X.origParse(res); } catch (e) { done('parse'); return; }
              }
              clientOk = true;
              done(null, out);
            }, function (err) { done({ client: true, error: String(err && (err.message || err)) }); });
            // On timeout, drop the subscription so the client does not deliver (and hold) a late response.
            if (!job.done && subscription && typeof subscription.unsubscribe === 'function') {
              job.abort = function () { try { subscription.unsubscribe(); } catch (e) {} };
            }
            sub = true;
          } else { clientOk = false; client = null; }
        } catch (e) { sub = null; }
        if (sub) return;
      }
      innertubeXhr(job, path, payload, done);
    }, cb, opts);
  }

  function get(url, cb, opts) {
    enqueue('get', url, function (job, done) {
      xhrRun(job, 'GET', url, null, {}, function (status, text, why) {
        if (why) { done(why); return; }
        if (status < 200 || status >= 300) { done({ status: status }); return; }
        done(null, text, status);
      });
    }, cb, opts);
  }

  X.net = {
    innertube: innertube,
    get: get,
    stats: function () { return { inFlight: active.length, queued: queue.length, failures: failures, clientOk: clientOk }; },
    cancel: function (group) {
      var keep = [], drop = [], i;
      for (i = 0; i < queue.length; i++) (queue[i].group === group ? drop : keep).push(queue[i]);
      queue = keep;
      for (i = 0; i < drop.length; i++) { drop[i].done = true; try { drop[i].cb('cancelled'); } catch (e) {} }
      return drop.length;
    }
  };

  X.test = X.test || {};
  X.test.net = {
    queueState: function () { return { inFlight: active.length, queued: queue.length }; },
    reset: function () {
      for (var i = 0; i < active.length; i++) { active[i].done = true; if (active[i].timer) clearTimeout(active[i].timer); }
      active = []; queue = []; failures = 0; clientOk = null; client = null; pumping = false;
    }
  };
})();
