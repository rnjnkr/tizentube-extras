// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TT Extras contributors. See LICENSE.
// TT Extras channel directory (id <-> name, avatar) and resolveForVideo(). Design section 4.7.
// Learns from the response pipeline (harvest phase); persisted debounced under one localStorage key. ES5 only.
(function () {
  if (location.hostname !== 'www.youtube.com') return;
  if (window.__ttxChannelsLoaded) return;
  window.__ttxChannelsLoaded = true;
  var X = window.__ttx;
  if (!X) return;

  var KEY = 'tizentube-extras-channel-dir';
  var CAP = 500;
  var DAY = 86400000;
  var SAVE_MS = 2000;
  var ID_RE = /^UC[\w-]{22}$/;

  // Maps keyed by channel names (chosen by channel owners) or ids have no prototype, so a name such as
  // "constructor" or "__proto__" is just a key.
  function dict() { return Object.create(null); }
  function emptyStore() { return { v: 1, byId: dict(), byName: dict() }; }
  function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }

  function norm(name) {
    if (typeof name !== 'string') return '';
    return name.toLowerCase().replace(/\s+/g, ' ').replace(/^ | $/g, '').replace(/ - topic$/, '');
  }

  function rebuildNames(s) {
    var best = dict(), id, n;
    s.byName = dict();
    for (id in s.byId) {
      n = norm(s.byId[id].name);
      if (!n) continue;
      if (!best[n] || s.byId[id].seen >= s.byId[best[n]].seen) best[n] = id;
    }
    s.byName = best;
  }

  function validate(o) {
    if (!isObj(o) || o.v !== 1 || !isObj(o.byId) || !isObj(o.byName)) return null;
    var s = emptyStore(), id, e;
    for (id in o.byId) {
      e = o.byId[id];
      if (!ID_RE.test(id) || !isObj(e) || typeof e.name !== 'string') continue;
      s.byId[id] = { name: e.name, seen: typeof e.seen === 'number' ? e.seen : 0 };
      if (typeof e.avatar === 'string') s.byId[id].avatar = e.avatar;
    }
    rebuildNames(s);
    return s;
  }

  var store = X.loadJson(KEY, null, validate) || emptyStore();
  var dirty = false, saveTimer = null;
  var pending = dict();

  function count(s) { var n = 0; for (var k in s.byId) n++; return n; }

  // Drops the `drop` oldest ids (by seen) of s, with their byName entries.
  function dropOldest(s, drop) {
    var ids = [], i;
    for (var id in s.byId) ids.push(id);
    ids.sort(function (a, b) { return s.byId[a].seen - s.byId[b].seen; });
    for (i = 0; i < drop && i < ids.length; i++) delete s.byId[ids[i]];
    rebuildNames(s);
  }

  function schedule() {
    dirty = true;
    if (saveTimer !== null) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      if (!dirty) return;
      dirty = false;
      try { X.saveJson(KEY, store); } catch (e) {}
    }, SAVE_MS);
  }

  function learn(c) {
    try {
      if (!c || typeof c.id !== 'string' || !ID_RE.test(c.id) || typeof c.name !== 'string') return false;
      var name = c.name.replace(/^\s+|\s+$/g, '');
      if (!name) return false;
      var avatar = typeof c.avatar === 'string' && c.avatar ? c.avatar : null;
      var now = X.now(), e = store.byId[c.id], changed = false, n = norm(name);
      if (!e) {
        e = store.byId[c.id] = { name: name, seen: now };
        if (avatar) e.avatar = avatar;
        store.byName[n] = c.id;
        changed = true;
        var over = count(store) - CAP;
        if (over > 0) dropOldest(store, over);
      } else {
        if (e.name !== name) {
          var old = norm(e.name);
          if (store.byName[old] === c.id) delete store.byName[old];
          e.name = name;
          changed = true;
        }
        if (avatar && e.avatar !== avatar) { e.avatar = avatar; changed = true; }
        if (now - e.seen > DAY) { e.seen = now; changed = true; }
        if (changed) store.byName[n] = c.id;
      }
      if (changed) schedule();
      return changed;
    } catch (err) { return false; }
  }

  function get(id) {
    var e = typeof id === 'string' ? store.byId[id] : null;
    if (!e) return null;
    var r = { id: id, name: e.name, seen: e.seen };
    if (e.avatar) r.avatar = e.avatar;
    return r;
  }

  function idForName(name) {
    var n = norm(name);
    return n && store.byName[n] || null;
  }

  X.onStorageFull(function (key, obj) {
    var half = Math.floor(count(store) / 2);
    if (key === KEY && isObj(obj) && isObj(obj.byId)) {
      var ids = [], i;
      for (var id in obj.byId) ids.push(id);
      ids.sort(function (a, b) { return obj.byId[a].seen - obj.byId[b].seen; });
      for (i = 0; i < Math.floor(ids.length / 2); i++) delete obj.byId[ids[i]];
      rebuildNames(obj);
      if (obj !== store) store = obj;
    } else {
      dropOldest(store, half);
      try { localStorage[KEY] = X.origStringify(store); } catch (e) {}
    }
  });

  // ---- Parsing

  function firstAvatar(node, depth) {
    if (!node || typeof node !== 'object' || depth > 6) return null;
    var i, r;
    if (Array.isArray(node.thumbnails)) {
      for (i = 0; i < node.thumbnails.length; i++) {
        var u = node.thumbnails[i] && node.thumbnails[i].url;
        if (typeof u === 'string' && u.indexOf('ggpht') !== -1) return u;
      }
    }
    for (var k in node) {
      if (k === 'thumbnails' || k === 'buttons' || k === 'trackingParams') continue;
      var v = node[k];
      if (v && typeof v === 'object' && (r = firstAvatar(v, depth + 1))) return r;
    }
    return null;
  }

  function walkNext(r, fn) {
    var a = r && r.contents && r.contents.singleColumnWatchNextResults;
    a = a && a.results && a.results.results && a.results.results.contents;
    if (!Array.isArray(a)) return null;
    for (var i = 0; i < a.length; i++) {
      var sec = a[i] && a[i].itemSectionRenderer, cs = sec && sec.contents;
      if (!Array.isArray(cs)) continue;
      for (var j = 0; j < cs.length; j++) {
        var m = cs[j] && cs[j].videoMetadataRenderer;
        if (m) return m;
      }
    }
    return null;
  }

  function parseOwner(r) {
    try {
      var m = walkNext(r);
      var o = m && m.owner && m.owner.videoOwnerRenderer;
      if (!o) return null;
      var ne = o.navigationEndpoint, id = ne && ne.browseEndpoint && ne.browseEndpoint.browseId;
      if (typeof id !== 'string' || !ID_RE.test(id)) return null;
      return { id: id, name: X.plainText(o.title) || '', avatar: firstAvatar(o, 0) };
    } catch (e) { return null; }
  }

  function currentVideoId(r) {
    try {
      var m = walkNext(r);
      var id = (m && m.videoId) || (r.currentVideoEndpoint && r.currentVideoEndpoint.watchEndpoint && r.currentVideoEndpoint.watchEndpoint.videoId);
      return typeof id === 'string' ? id : null;
    } catch (e) { return null; }
  }

  function parseHeader(r) {
    var c = r.contents && r.contents.tvBrowseRenderer && r.contents.tvBrowseRenderer.content;
    var h = c && c.tvSurfaceContentRenderer && c.tvSurfaceContentRenderer.header;
    if (!h) return null;
    h = h.channelHeaderRenderer || h;
    var name = X.plainText(h.title);
    return name ? { name: name, avatar: firstAvatar(h, 0) } : null;
  }

  X.onResponse('harvest', function (r, inf) {
    try {
      var o;
      if (inf.kind === 'player') {
        var vd = r.videoDetails;
        if (vd) learn({ id: vd.channelId, name: vd.author });
      } else if (inf.kind === 'next') {
        o = parseOwner(r);
        if (o) {
          learn(o);
          var vid = currentVideoId(r);
          if (vid) X.addDetails(vid, { channelId: o.id, author: o.name });
        }
      } else if (inf.kind === 'browse' && typeof inf.browseId === 'string' && inf.browseId.indexOf('UC') === 0) {
        var h = parseHeader(r);
        if (h) learn({ id: inf.browseId, name: h.name, avatar: h.avatar });
      }
    } catch (e) {}
  });

  X.onItems('harvest', function (items) {
    try {
      for (var i = 0; i < items.length; i++) {
        var v = X.itemVideo(items[i]);
        if (v && v.kind === 'channel' && v.channelId && v.title) learn({ id: v.channelId, name: v.title });
      }
    } catch (e) {}
  });

  // ---- resolveForVideo

  function finish(videoId, err, res) {
    var list = pending[videoId] || [];
    delete pending[videoId];
    for (var i = 0; i < list.length; i++) {
      try { list[i](err, res); } catch (e) {}
    }
  }

  function resolveForVideo(videoId, cb) {
    if (typeof cb !== 'function') return;
    var d = X.details[videoId], known = d && d.channelId && get(d.channelId);
    if (known) {
      setTimeout(function () {
        try { cb(null, { id: known.id, name: known.name, avatar: known.avatar || null }); } catch (e) {}
      }, 0);
      return;
    }
    if (pending[videoId]) { pending[videoId].push(cb); return; }
    pending[videoId] = [cb];
    var payload = {
      videoId: videoId, racyCheckOk: true, contentCheckOk: true,
      playbackContext: { lactMilliseconds: Math.floor(Math.random() * 2000), isLyricsMode: false },
      autonavState: 'STATE_NONE',
      mdxContext: { mdxReceiverContext: { mdxConnectedDevices: [] } }
    };
    try {
      if (!X.net || !X.net.innertube) { finish(videoId, { error: 'noNet' }); return; }
      X.net.innertube('/youtubei/v1/next', payload, function (err, json) {
        try {
          if (err) { finish(videoId, err); return; }
          var o = parseOwner(json);
          if (!o) { finish(videoId, { error: 'noOwner' }); return; }
          learn(o);
          X.addDetails(videoId, { channelId: o.id });
          finish(videoId, null, { id: o.id, name: o.name, avatar: o.avatar });
        } catch (e) { finish(videoId, { error: String(e) }); }
      });
    } catch (e) { finish(videoId, { error: String(e) }); }
  }

  X.channels = { norm: norm, learn: learn, get: get, idForName: idForName, resolveForVideo: resolveForVideo };

  X.test = X.test || {};
  X.test.channels = {
    norm: norm, learn: learn, idForName: idForName, get: get, parseOwner: parseOwner,
    reset: function () {
      store = emptyStore(); dirty = false; pending = dict();
      if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
    },
    size: function () { return count(store); },
    store: function () { return store; }
  };
})();
