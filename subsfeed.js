// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TT Extras contributors. See LICENSE.
// TT Extras subsfeed.js: data side of local (guest) subscriptions. Fetches each subscribed channel's latest
// videos (Atom feed, Videos-tab fallback) and Shorts (Shorts tab), caches them and merges them into rows on
// Home and Subscriptions. Fetches older Videos-tab pages on demand, up to 1000 videos per row. UI lives in subs.js. ES5 only.
(function () {
  if (location.hostname !== 'www.youtube.com') return;
  if (window.__ttxSubsfeed) return;
  window.__ttxSubsfeed = true;
  var X = window.__ttx;
  if (!X) return;

  var CACHE_KEY = 'tizentube-extras-subs-cache';
  var TTL = 30 * 60000;           // a cached channel is fresh this long
  var ERROR_RETRY = 5 * 60000;    // a channel whose last refresh failed is retried after this
  var ERROR_DROP = 24 * 3600000;  // snapshot() hides failed channels older than this
  // Cache size (JSON chars). 200 channels x (6 videos + 3 shorts, no thumbnail URLs, no Shorts tile copies) is about
  // 450 KB, so 800 KB holds 200 subscriptions with room to spare; it is above the design's 600 KB overall
  // localStorage figure on purpose, because a smaller cache made 100+ subscriptions refetch on every visit.
  var BUDGET = 800 * 1024;
  var KEEP_VIDEOS = 6, KEEP_SHORTS = 3;
  var LATEST_PER_CHANNEL = 2;     // design 12 Q2: newest videos per channel in the "Latest" row
  var LATEST_CAP = 30, MORE_CAP = 40, SHORTS_CAP = 30;
  var WORKERS = 2;                // channels in flight (A + B each; net.js allows 3 requests)
  var SAVE_EVERY = 25;            // cache save interval during a refresh (and once at its end)
  var BG_SAVE_EVERY = 50;         // the same in the background (saving trims and stringifies the whole cache)
  var GROUP = 'subsfeed';
  var BG_GROUP = 'subsfeed-bg';   // the background refresh's own net group: leaving the page does not cancel it
  var BG_DELAY = 25000;           // first background refresh this long after start, so Home loads undisturbed
  var BG_MIN_AGE = 30 * 60000;    // background refresh when the cache has stale channels and the last one began this long ago
  var BG_PAUSE = 15000;           // recheck interval while a video is playing (no new channels are started then)
  var PAGE = 'FEtizentube_subscriptions';
  var SHORTS_RE = /#shorts\b/i;
  var SHORTS_LINK_RE = /<link\s[^>]*href="[^"]*\/shorts\//;
  var TABS = {
    shorts: { setting: 'shortsParams', word: 'shorts', defaults: ['EgZzaG9ydHPyBgUKA5oBAA==', 'EgZzaG9ydHM='] },
    videos: { setting: 'videosParams', word: 'videos', defaults: ['EgZ2aWRlb3PyBgQKAjoA', 'EgZ2aWRlb3M='] }
  };

  var cacheMem = null;   // the cache as last loaded/saved
  var current = null;    // the running refresh
  var lastIds = null;    // subscribed ids seen last (cache trimming)
  var bgRetry = false;   // a retry of the background start is scheduled
  var lastBg = 0;        // when the last background refresh began

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isArr(a) { return Object.prototype.toString.call(a) === '[object Array]'; }
  function isNum(n) { return typeof n === 'number' && n === n; }
  function validId(id) { return typeof id === 'string' && /^UC[\w-]{0,62}$/.test(id); }
  function logErr(label, e) { try { X.log({ subsfeed: label, error: String(e) }); } catch (e2) {} }
  function call(cb, arg) { if (typeof cb !== 'function') return; try { cb(arg); } catch (e) { logErr('callback', e); } }
  function pathGet(o) {
    for (var i = 1; i < arguments.length; i++) {
      if (o === null || o === undefined) return undefined;
      o = o[arguments[i]];
    }
    return o;
  }
  function thumbFor(id) { return { url: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg', width: 320, height: 180 }; }

  // ---- base64 (jsc/old Cobalt may lack atob) -------------------------------------------------

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64decodeManual(s) {
    var out = '', acc = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      var v = B64.indexOf(s.charAt(i));
      if (v < 0) return '';
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 255); }
      acc &= (1 << bits) - 1;
    }
    return out;
  }
  // Binary string of a (URL-safe, percent-encoded or unpadded) base64 text; '' when invalid.
  function b64decode(s) {
    s = String(s);
    try { s = decodeURIComponent(s); } catch (e) {}
    s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/[\s=]+/g, '');
    if (/[^A-Za-z0-9+\/]/.test(s)) return '';
    if (typeof atob === 'function') {
      try { return atob(s + '===='.slice(0, (4 - s.length % 4) % 4)); } catch (e) {}
    }
    return b64decodeManual(s);
  }

  // ---- feed (Source A) ------------------------------------------------------------------------

  function unescapeXml(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, function (m, e) {
      var c = e.toLowerCase();
      if (c === 'amp') return '&';
      if (c === 'lt') return '<';
      if (c === 'gt') return '>';
      if (c === 'quot') return '"';
      if (c === 'apos') return "'";
      var n = c.charAt(1) === 'x' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
      if (!(n > 0) || n > 0x10ffff) return m;
      if (n > 0xffff) { n -= 0x10000; return String.fromCharCode(0xd800 + (n >> 10), 0xdc00 + (n & 1023)); }
      return String.fromCharCode(n);
    });
  }
  function tag(xml, name) {
    var m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(xml);
    return m ? unescapeXml(m[1]).replace(/^\s+|\s+$/g, '') : '';
  }
  // The feed gives channel ids without their 'UC' prefix.
  function feedChannelId(s) { return s && s.length === 22 ? 'UC' + s : s; }

  function parseFeed(xml) {
    var out = { channel: { id: '', title: '' }, videos: [] };
    if (typeof xml !== 'string' || xml.length > 4000000) return out;
    var first = xml.indexOf('<entry>');
    var head = first < 0 ? xml : xml.slice(0, first);
    out.channel.id = feedChannelId(tag(head, 'yt:channelId'));
    out.channel.title = tag(head, 'title');
    var re = /<entry>[\s\S]*?<\/entry>/g, m, seen = {};
    while ((m = re.exec(xml)) && out.videos.length < 50) {
      var e = m[0], id = tag(e, 'yt:videoId');
      if (!id || hasOwn(seen, '$' + id)) continue;
      seen['$' + id] = 1;
      var title = tag(e, 'title'), ms = Date.parse(tag(e, 'published'));
      var author = tag(tag(e, 'author'), 'name') || out.channel.title;
      out.videos.push({
        id: id, title: title, channelId: feedChannelId(tag(e, 'yt:channelId')) || out.channel.id, author: author,
        // A Short's entry links to /shorts/<id> instead of /watch?v=<id> (seen on the TV, 2026-11-18).
        published: isNum(ms) ? ms : null, thumbnail: thumbFor(id), isShort: SHORTS_RE.test(title) || SHORTS_LINK_RE.test(e)
      });
    }
    return out;
  }

  // ---- tiles (Sources B and C) ----------------------------------------------------------------

  // Iterative walk over every object in document order; fn returns true to not descend into a node.
  function scan(root, fn) {
    var stack = [{ n: root, d: 0 }], budget = 300000;
    while (stack.length && budget-- > 0) {
      var cur = stack.pop(), n = cur.n, i;
      if (!n || typeof n !== 'object' || cur.d > 40) continue;
      if (isArr(n)) {
        for (i = n.length - 1; i >= 0; i--) stack.push({ n: n[i], d: cur.d + 1 });
        continue;
      }
      if (fn(n)) continue;
      var keys = Object.keys(n);
      for (i = keys.length - 1; i >= 0; i--) {
        var k = keys[i];
        if (k === 'trackingParams' || k === 'clickTrackingParams' || k === 'responseContext') continue;
        if (n[k] && typeof n[k] === 'object') stack.push({ n: n[k], d: cur.d + 1 });
      }
    }
  }

  var STRIP = { trackingParams: 1, clickTrackingParams: 1, loggingDirectives: 1 };
  var TILE_KEEP = ['header', 'metadata', 'onSelectCommand', 'style', 'contentId', 'contentType'];
  function stripCopy(n, depth) {
    if (!n || typeof n !== 'object' || depth > 30) return n;
    var out, i;
    if (isArr(n)) {
      out = [];
      for (i = 0; i < n.length; i++) out.push(stripCopy(n[i], depth + 1));
      return out;
    }
    out = {};
    for (var k in n) if (hasOwn(n, k) && !STRIP[k]) out[k] = stripCopy(n[k], depth + 1);
    return out;
  }
  function trimTile(t) {
    var out = {};
    for (var i = 0; i < TILE_KEEP.length; i++) if (t[TILE_KEEP[i]] !== undefined) out[TILE_KEEP[i]] = stripCopy(t[TILE_KEEP[i]], 0);
    return { tileRenderer: out };
  }

  // "1:02:03" -> seconds
  function parseLength(s) {
    var m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s*$/.exec(typeof s === 'string' ? s : '');
    return m ? (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) : null;
  }

  // Texts of the lines after the first (author) line of a tile.
  function metaTexts(item) {
    var out = [], i, j, t = item.tileRenderer;
    if (item.gridVideoRenderer) return [X.plainText(item.gridVideoRenderer.publishedTimeText)];
    if (t) {
      var lines = pathGet(t, 'metadata', 'tileMetadataRenderer', 'lines') || [];
      for (i = 1; i < lines.length; i++) {
        var its = pathGet(lines[i], 'lineRenderer', 'items') || [];
        for (j = 0; j < its.length; j++) out.push(X.plainText(pathGet(its[j], 'lineItemRenderer', 'text')));
      }
    } else {
      var rows = pathGet(item.lockupViewModel, 'metadata', 'lockupMetadataViewModel', 'metadata', 'contentMetadataViewModel', 'metadataRows') || [];
      for (i = 1; i < rows.length; i++) {
        var parts = rows[i] && rows[i].metadataParts || [];
        for (j = 0; j < parts.length; j++) out.push(pathGet(parts[j], 'text', 'content'));
      }
    }
    return out;
  }

  function overlayLength(ov) {
    for (var i = 0; i < ov.length; i++) {
      var r = ov[i] && ov[i].thumbnailOverlayTimeStatusRenderer;
      var s = r ? parseLength(X.plainText(r.text)) : null;
      if (s !== null) return s;
    }
    return null;
  }

  function tileVideo(item) {
    var g = item && item.gridVideoRenderer;
    if (!g) return X.itemVideo(item);
    var by = g.shortBylineText || g.longBylineText || g.ownerText;
    function bylineId(text) { return pathGet(text, 'runs', 0, 'navigationEndpoint', 'browseEndpoint', 'browseId'); }
    var owner = g.channelId || bylineId(g.shortBylineText) || bylineId(g.longBylineText) || bylineId(g.ownerText);
    return { id: g.videoId, kind: pathGet(g, 'navigationEndpoint', 'reelWatchEndpoint') ? 'short' : 'video',
      title: X.plainText(g.title), author: X.plainText(by), channelId: owner };
  }

  function tilesToVideos(resp, channelId, now) {
    var out = { videos: [], shorts: [] }, items = [], headerTitle = '', seen = {};
    if (!resp || typeof resp !== 'object') return out;
    if (now === undefined) now = X.now();
    scan(resp, function (n) {
      if (n.tileRenderer || n.lockupViewModel || n.gridVideoRenderer) { items.push(n); return true; }
      if (!headerTitle && n.channelHeaderRenderer) headerTitle = X.plainText(n.channelHeaderRenderer.title) || '';
      return false;
    });
    for (var i = 0; i < items.length; i++) {
      var item = items[i], grid = item.gridVideoRenderer, iv = tileVideo(item);
      if (!iv || typeof iv.id !== 'string' || !iv.id || hasOwn(seen, '$' + iv.id)) continue;
      if (iv.kind !== 'video' && iv.kind !== 'short') continue;
      if (channelId && iv.channelId && !iv.channelIdGuessed && iv.channelId !== channelId) continue;
      seen['$' + iv.id] = 1;
      var v = {
        id: iv.id, title: iv.title || '', channelId: channelId || iv.channelId || '', author: iv.author || headerTitle || '',
        published: null, thumbnail: thumbFor(iv.id), isShort: iv.kind === 'short'
      };
      var texts = metaTexts(item);
      for (var j = 0; j < texts.length; j++) {
        var p = X.parseAgo(texts[j], now);
        if (p !== null) { v.published = p; v.publishedText = texts[j]; break; }
      }
      if (item.tileRenderer || grid) {
        var len = grid ? parseLength(X.plainText(grid.lengthText)) : null;
        var overlays = grid ? grid.thumbnailOverlays : pathGet(item.tileRenderer, 'header', 'tileHeaderRenderer', 'thumbnailOverlays');
        if (len === null) len = overlayLength(overlays || []);
        if (len !== null) v.length = len;
        if (grid) v.thumbnail = pathGet(grid, 'thumbnail', 'thumbnails', 0) || v.thumbnail;
        if (v.isShort && item.tileRenderer) v.tile = trimTile(item.tileRenderer);
      }
      (v.isShort ? out.shorts : out.videos).push(v);
    }
    out.title = headerTitle;
    return out;
  }

  // Params of the channel tab (from a channel page response) whose decoded params contain `word`.
  function findTabParams(resp, word) {
    var found = null;
    scan(resp, function (n) {
      var p = n.tabRenderer && pathGet(n.tabRenderer, 'endpoint', 'browseEndpoint', 'params');
      if (!found && typeof p === 'string' && b64decode(p).toLowerCase().indexOf(word) !== -1) found = p;
      return false;
    });
    return found;
  }

  // ---- cache ----------------------------------------------------------------------------------

  function validateCache(o) {
    if (!o || typeof o !== 'object' || o.v !== 1 || !o.channels || typeof o.channels !== 'object') return null;
    var out = { v: 1, channels: {} };
    for (var id in o.channels) {
      var e = o.channels[id];
      if (!hasOwn(o.channels, id) || !validId(id) || !e || typeof e !== 'object') continue;
      var ne = { fetchedAt: isNum(e.fetchedAt) ? e.fetchedAt : 0, videos: [], shorts: [] };
      if (typeof e.error === 'string') { ne.error = e.error; ne.errorAt = isNum(e.errorAt) ? e.errorAt : 0; }
      for (var k = 0; k < 2; k++) {
        var src = e[k ? 'shorts' : 'videos'], cap = k ? KEEP_SHORTS : KEEP_VIDEOS;
        for (var i = 0; isArr(src) && i < src.length && ne[k ? 'shorts' : 'videos'].length < cap; i++) {
          if (src[i] && typeof src[i] === 'object' && typeof src[i].id === 'string') {
            if (!src[i].thumbnail) src[i].thumbnail = thumbFor(src[i].id); // not stored, see compactVideo
            ne[k ? 'shorts' : 'videos'].push(src[i]);
          }
        }
      }
      out.channels[id] = ne;
    }
    return out;
  }

  function getCache() {
    if (!cacheMem) cacheMem = X.loadJson(CACHE_KEY, null, validateCache) || { v: 1, channels: {} };
    return cacheMem;
  }

  function size(o) { return X.origStringify(o).length; }

  // Stored form of a video: the thumbnail URL is derivable from the id, so it is not stored; Shorts tile copies
  // (big) only with `tiles`.
  function compactVideo(v, tiles) {
    var o = {};
    for (var k in v) if (hasOwn(v, k) && k !== 'thumbnail' && (tiles || k !== 'tile')) o[k] = v[k];
    return o;
  }
  function compactEntry(e, nv, ns, tiles) {
    var ne = { fetchedAt: e.fetchedAt, videos: [], shorts: [] }, i;
    if (e.error) { ne.error = e.error; ne.errorAt = e.errorAt; }
    for (i = 0; i < e.videos.length && i < nv; i++) ne.videos.push(compactVideo(e.videos[i], false));
    for (i = 0; i < e.shorts.length && i < ns; i++) ne.shorts.push(compactVideo(e.shorts[i], tiles));
    return ne;
  }

  // Pure: the stored form of `cache`, within `budget` chars (never mutates its input). Order of cuts: channels no
  // longer subscribed (when `subsIds` is given), then Shorts tile copies, then the oldest items of every channel
  // (fewer and fewer per channel). A still-subscribed channel keeps its entry; only without `subsIds`
  // (storage-full retry) are whole channels dropped, oldest fetchedAt first, as a last resort.
  function trimCache(cache, subsIds, budget) {
    var keep = null, id, i;
    if (subsIds) {
      keep = {};
      if (isArr(subsIds)) for (i = 0; i < subsIds.length; i++) keep[subsIds[i]] = 1;
      else keep = subsIds;
    }
    var src = {};
    for (id in cache.channels) if (hasOwn(cache.channels, id) && (!keep || hasOwn(keep, id))) src[id] = cache.channels[id];
    function build(nv, ns, tiles) {
      var out = { v: 1, channels: {} };
      for (var k in src) out.channels[k] = compactEntry(src[k], nv, ns, tiles);
      return out;
    }
    var out = build(KEEP_VIDEOS, KEEP_SHORTS, true);
    if (size(out) <= budget) return out;
    out = build(KEEP_VIDEOS, KEEP_SHORTS, false);
    var steps = [[4, 2], [3, 1], [2, 1], [1, 0], [0, 0]];
    for (i = 0; i < steps.length && size(out) > budget; i++) out = build(steps[i][0], steps[i][1], false);
    if (keep || size(out) <= budget) return out;
    var ids = [], sizes = {}, total = 20;
    for (id in out.channels) { sizes[id] = size(out.channels[id]) + id.length + 4; total += sizes[id]; ids.push(id); }
    ids.sort(function (a, b) {
      var d = out.channels[a].fetchedAt - out.channels[b].fetchedAt;
      return d || (a < b ? -1 : a > b ? 1 : 0);
    });
    for (i = 0; i < ids.length && total > budget; i++) { total -= sizes[ids[i]]; delete out.channels[ids[i]]; }
    return out;
  }

  function saveCache() {
    try {
      var stored = trimCache(getCache(), lastIds, BUDGET);
      cacheMem = validateCache(stored) || stored; // back to the in-memory form (thumbnails restored)
      X.saveJson(CACHE_KEY, stored);
    } catch (e) { logErr('save', e); }
  }

  X.onStorageFull(function (key, obj) {
    if (key === CACHE_KEY && obj && obj.channels) obj.channels = trimCache(obj, null, BUDGET / 3).channels; // retry smaller
    else { try { delete localStorage[CACHE_KEY]; } catch (e) {} cacheMem = { v: 1, channels: {} }; }
  });

  // ---- public data helpers --------------------------------------------------------------------

  function subIds(subs) {
    var list = isArr(subs) ? subs : subs && isArr(subs.channels) ? subs.channels : [], out = [], seen = {};
    for (var i = 0; i < list.length; i++) {
      var id = typeof list[i] === 'string' ? list[i] : list[i] && list[i].id;
      if (validId(id) && !hasOwn(seen, id)) { seen[id] = 1; out.push(id); }
    }
    return out;
  }

  function isStale(e, now) {
    if (!e) return true;
    if (e.error) return now - (e.errorAt || 0) >= ERROR_RETRY;
    return now - e.fetchedAt >= TTL;
  }

  function snapshot(subs) {
    var ids = subIds(subs), c = getCache(), now = X.now(), out = { channels: {} };
    lastIds = ids;
    for (var i = 0; i < ids.length; i++) {
      var e = hasOwn(c.channels, ids[i]) ? c.channels[ids[i]] : null;
      if (!e || (e.error && now - e.fetchedAt > ERROR_DROP)) continue;
      out.channels[ids[i]] = e;
    }
    return out;
  }

  function allFresh(data, subs) {
    var ids = subIds(subs), now = X.now();
    for (var i = 0; i < ids.length; i++) {
      var e = data && data.channels && hasOwn(data.channels, ids[i]) ? data.channels[ids[i]] : null;
      if (!e || isStale(e, now)) return false;
    }
    return true;
  }

  // ---- rows / fingerprint ---------------------------------------------------------------------

  function dated(v) { return isNum(v.published); }
  function strCmp(a, b) { a = String(a || ''); b = String(b || ''); return a < b ? -1 : a > b ? 1 : 0; }

  // Within a channel: dated newest first (ties by id), then undated in source order.
  function channelOrder(list) {
    var dec = list.map(function (v, i) { return { v: v, i: i }; });
    dec.sort(function (a, b) {
      var ad = dated(a.v), bd = dated(b.v);
      if (ad !== bd) return ad ? -1 : 1;
      if (ad && a.v.published !== b.v.published) return b.v.published - a.v.published;
      return ad ? strCmp(a.v.id, b.v.id) : a.i - b.i;
    });
    return dec.map(function (d) { return d.v; });
  }

  // Across channels: dated newest first; undated after, round-robin (n-th of each channel, channels in order); ties by author, id.
  function mergeCmp(a, b) {
    var ad = dated(a.v), bd = dated(b.v);
    if (ad !== bd) return ad ? -1 : 1;
    if (ad) { if (a.v.published !== b.v.published) return b.v.published - a.v.published; }
    else {
      if (a.idx !== b.idx) return a.idx - b.idx;
      if (a.ci !== b.ci) return a.ci - b.ci;
    }
    return strCmp(a.v.author, b.v.author) || strCmp(a.v.id, b.v.id);
  }
  function vids(list) { return list.map(function (d) { return d.v; }); }

  function rows(data, subsById) {
    var chans = data && data.channels || {}, list = [], id;
    for (id in chans) {
      if (!hasOwn(chans, id) || !chans[id] || (subsById && !hasOwn(subsById, id))) continue;
      var ev = chans[id].videos || [], es = chans[id].shorts || [];
      var t = subsById && subsById[id] && subsById[id].title || (ev[0] || es[0] || {}).author || '';
      list.push({ id: id, e: chans[id], key: String(t).toLowerCase() });
    }
    list.sort(function (a, b) { return strCmp(a.key, b.key) || strCmp(a.id, b.id); });
    var seen = {}, latest = [], more = [], shorts = [], c, i;
    function take(arr, isShort) {
      var out = [];
      for (var j = 0; j < arr.length; j++) {
        var v = arr[j];
        if (!v || typeof v.id !== 'string' || hasOwn(seen, v.id) || (!isShort && v.isShort)) continue;
        seen[v.id] = 1;
        out.push(v);
      }
      return channelOrder(out);
    }
    for (c = 0; c < list.length; c++) {
      var mine = take(list[c].e.videos || [], false);
      for (i = 0; i < mine.length; i++) (i < LATEST_PER_CHANNEL ? latest : more).push({ v: mine[i], idx: i, ci: c });
    }
    for (c = 0; c < list.length; c++) {
      var sh = take(list[c].e.shorts || [], true);
      for (i = 0; i < sh.length; i++) shorts.push({ v: sh[i], idx: i, ci: c });
    }
    latest.sort(mergeCmp); more.sort(mergeCmp); shorts.sort(mergeCmp);
    // what does not fit in "Latest" moves down to "More" (it sorts in by date there) instead of vanishing
    more = more.concat(latest.slice(LATEST_CAP)).sort(mergeCmp);
    latest = latest.slice(0, LATEST_CAP);
    return { latest: vids(latest), more: vids(more.slice(0, MORE_CAP)), shorts: vids(shorts.slice(0, SHORTS_CAP)) };
  }

  function fingerprint(data, subsById) {
    var r = rows(data, subsById || null);
    function ids(l) { return l.map(function (v) { return v.id; }).join(','); }
    return ids(r.latest) + '|' + ids(r.more) + '|' + ids(r.shorts);
  }

  // ---- fetching -------------------------------------------------------------------------------

  function errText(e) {
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object') return e.status ? 'http ' + e.status : e.client ? 'client ' + String(e.error || '') : 'error';
    return 'error';
  }
  // Errors that say nothing about whether the params are right: do not spend more requests on them.
  function fatal(e) {
    if (typeof e === 'string') return e !== 'parse';
    return !!(e && typeof e === 'object' && (e.status >= 500 || e.status === 429));
  }
  function netOpts(group) { return group ? { group: group } : undefined; }
  function noNet(cb) { setTimeout(function () { cb('noNet'); }, 0); }

  function newProbe() { return { shorts: { miss: 0, hit: 0, zero: 0, off: false }, videos: { miss: 0, hit: 0, zero: 0, off: false } }; }

  function rememberSetting(name, p) {
    try { if (X.settings.get(name, '') !== p) X.settings.set(name, p); } catch (e) {}
  }

  // One tab of a channel (kind 'shorts' | 'videos'): cb(err) or cb(null, [Video]).
  // With a remembered params value: exactly one request. Without: the defaults in order, then discovery from
  // the channel page's tabs, until one yields a tile; the winner is remembered. Probing stops for the rest of
  // a run after 3 channels without a winner (they may simply have no such tab).
  // stopped(): optional; true once the page run was stopped, so no follow-up request is sent for a page that is gone.
  function fetchTab(id, kind, group, probe, cb, stopped, guard) {
    var T = TABS[kind], P = probe[kind];
    var remembered = X.settings.get(T.setting, '');
    if (typeof remembered !== 'string') remembered = '';
    var probing = !remembered && !P.off;
    var cands = remembered ? [remembered] : probing ? T.defaults.slice() : [T.defaults[0]];
    var tried = [], lastErr = null, gotOk = false;
    if (!X.net) { noNet(cb); return; }

    function browse(payload, next) {
      if (stopped && stopped()) { cb('cancelled'); return; }
      X.net.innertube('/youtubei/v1/browse', payload, guard(next), netOpts(group));
    }
    function noWinner() {
      if (probing && ++P.miss >= 3) P.off = true;
      if (gotOk) cb(null, []); else cb(lastErr || 'noTab');
    }
    function won(p, list) {
      if (!remembered) rememberSetting(T.setting, p);
      else P.hit++;
      cb(null, list);
    }
    // TV check: the channel page is one mixed page (own videos plus other channels' shelves), so the Videos
    // fallback keeps only tiles whose author is the page's channel (when that leaves any).
    function pick(json) {
      var page = kind === 'videos' && videosPage(json, true);
      if (page) return tilesToVideos(page.items, id).videos;
      var r = tilesToVideos(json, id), list = r[kind];
      if (kind === 'videos' && r.title) {
        var own = list.filter(function (v) { return v.author === r.title; });
        if (own.length) list = own;
      }
      return list;
    }
    function step(i) {
      if (i >= cands.length) { if (probing) discover(); else noWinner(); return; }
      var p = cands[i];
      tried.push(p);
      browse({ browseId: id, params: p }, function (err, json) {
        if (err) {
          if (fatal(err)) { cb(err); return; }
          lastErr = errText(err);
          step(i + 1);
          return;
        }
        gotOk = true;
        var list = safePick(json);
        if (list.length) { won(p, list); return; }
        if (remembered) { P.zero++; cb(null, []); return; }
        step(i + 1);
      });
    }
    // An odd response must not throw out of the network callback: the channel would never finish.
    function safePick(json) { try { return pick(json); } catch (e) { logErr('pick', e); return []; } }
    function discover() {
      browse({ browseId: id }, function (err, json) {
        if (err) { if (fatal(err)) { cb(err); return; } lastErr = errText(err); noWinner(); return; }
        gotOk = true;
        var p = null;
        try { p = findTabParams(json, T.word); } catch (e) { logErr('findTabParams', e); }
        if (!p || tried.indexOf(p) !== -1) { noWinner(); return; }
        browse({ browseId: id, params: p }, function (err2, json2) {
          if (err2) { if (fatal(err2)) { cb(err2); return; } lastErr = errText(err2); noWinner(); return; }
          var list = safePick(json2);
          if (list.length) won(p, list); else noWinner();
        });
      });
    }
    step(0);
  }

  function fetchFeed(id, group, cb, guard) {
    if (!X.net) { noNet(cb); return; }
    X.net.get('https://www.youtube.com/feeds/videos.xml?channel_id=' + encodeURIComponent(id), guard(function (err, text) {
      if (err) { cb(err); return; }
      if (typeof text !== 'string' || !/<feed[\s>]/.test(text)) { cb('parse'); return; }
      cb(null, parseFeed(text));
    }), netOpts(group));
  }

  function copyVideo(v, id, author) {
    var o = {};
    for (var k in v) if (hasOwn(v, k)) o[k] = v[k];
    o.channelId = id;
    if (author) o.author = author;
    return o;
  }

  // Merge of the sources of one channel into a cache entry. `shorts` is B (or the previous entry's shorts when B failed).
  function mergeChannel(id, feedVideos, shorts, author, now) {
    var pubs = {}, i, inShorts = {}, videos = [], outShorts = [];
    for (i = 0; i < feedVideos.length; i++) pubs['$' + feedVideos[i].id] = feedVideos[i];
    for (i = 0; i < shorts.length; i++) {
      var s = copyVideo(shorts[i], id, author), f = pubs['$' + s.id];
      if (hasOwn(inShorts, '$' + s.id)) continue;
      inShorts['$' + s.id] = 1;
      s.isShort = true;
      if (f && f.published !== null) s.published = f.published;
      outShorts.push(s);
    }
    for (i = 0; i < feedVideos.length; i++) {
      var v = feedVideos[i];
      if (hasOwn(inShorts, '$' + v.id)) continue;
      v = copyVideo(v, id, author);
      v.isShort = SHORTS_RE.test(v.title || '') || !!v.isShort;
      (v.isShort ? outShorts : videos).push(v);
    }
    return { fetchedAt: now, videos: videos.slice(0, KEEP_VIDEOS), shorts: outShorts.slice(0, KEEP_SHORTS) };
  }

  // Runs A (feed), B (Shorts tab) and C (Videos tab) in parallel. A gives the precise dates, C the lengths (the
  // feed has none) and is the videos source when A failed. A's lengths fall back to the previous entry's.
  // seq (background runs): C only follows A, and only when A failed or some of A's videos still lack a length after the previous entry's.
  // cb('ok', entry) | cb('fail', text) | cb('cancelled').
  function fetchChannel(id, group, probe, prev, cb, seq, stopped) {
    var st = { pending: 3, feed: null, aErr: null, shorts: null, bErr: null, cVids: null, cErr: null };
    var finished = false;
    function finish(kind, payload) {
      if (finished) return;
      finished = true;
      cb(kind, payload);
    }
    // X.net isolates callback errors. Settle this channel even if a response handler throws.
    function guard(fn) {
      return function () {
        if (finished) return;
        try { fn.apply(null, arguments); }
        catch (e) { logErr('fetchChannel', e); finish('fail', String(e)); }
      };
    }
    function join() {
      if (--st.pending > 0) return;
      var src = st.feed ? st.feed.videos : st.aErr === 'cancelled' ? null : st.cVids;
      // A finished videos source is stored even when leaving the page cancelled the Shorts request (previous Shorts stay).
      if (!src && (st.aErr === 'cancelled' || st.bErr === 'cancelled' || st.cErr === 'cancelled')) { finish('cancelled'); return; }
      if (!src) { finish('fail', errText(st.aErr) + (st.cErr ? '/' + errText(st.cErr) : '')); return; }
      var shorts = st.shorts || (prev ? prev.shorts : []);
      var author = st.feed ? st.feed.channel.title : '';
      if (st.feed) {
        var lens = {}, i, v;
        if (prev) for (i = 0; i < prev.videos.length; i++) if (typeof prev.videos[i].length === 'number') lens['$' + prev.videos[i].id] = prev.videos[i].length;
        if (st.cVids) for (i = 0; i < st.cVids.length; i++) if (typeof st.cVids[i].length === 'number') lens['$' + st.cVids[i].id] = st.cVids[i].length;
        for (i = 0; i < src.length; i++) {
          v = src[i];
          if (hasOwn(lens, '$' + v.id)) v.length = lens['$' + v.id];
        }
      }
      finish('ok', mergeChannel(id, src, shorts, author, X.now()));
    }
    function runC() { fetchTab(id, 'videos', group, probe, function (e, list) { st.cErr = e; st.cVids = e ? null : list; join(); }, stopped, guard); }
    function needC(feed) {
      if (!feed) return true;
      var known = {}, i;
      if (prev) for (i = 0; i < prev.videos.length; i++) if (typeof prev.videos[i].length === 'number') known['$' + prev.videos[i].id] = true;
      for (i = 0; i < feed.videos.length; i++) {
        if (typeof feed.videos[i].length !== 'number' && !hasOwn(known, '$' + feed.videos[i].id)) return true;
      }
      return false;
    }
    function start() {
      fetchFeed(id, group, function (err, feed) {
        if (err) st.aErr = err; else st.feed = feed;
        if (seq) { if (needC(st.feed)) runC(); else join(); }
        join();
      }, guard);
      fetchTab(id, 'shorts', group, probe, function (e, list) { st.bErr = e; st.shorts = e ? null : list; join(); }, stopped, guard);
      if (!seq) runC();
    }
    guard(start)();
  }

  function applyResult(id, kind, payload) {
    var c = getCache(), prev = hasOwn(c.channels, id) ? c.channels[id] : null;
    if (kind === 'ok') c.channels[id] = payload;
    else if (kind === 'fail') {
      c.channels[id] = {
        fetchedAt: prev ? prev.fetchedAt : 0, error: payload, errorAt: X.now(),
        videos: prev ? prev.videos : [], shorts: prev ? prev.shorts : []
      };
      try { X.log({ subsfeed: 'channelFailed', id: id, error: payload }); } catch (e) {}
    } else return false;
    return true;
  }

  function prevOf(id) { var c = getCache(); return hasOwn(c.channels, id) ? c.channels[id] : null; }

  // ---- refresh --------------------------------------------------------------------------------

  function workerLimit(run) {
    var s = X.settings.get('shortsParams', '');
    if (run.bg && !run.page) return 1; // gentle in the background, unless a page is waiting for this run
    return (typeof s === 'string' && s) || run.probe.shorts.off ? WORKERS : 1; // learn the params from one channel first
  }

  function finishRun(run) {
    if (run.finished) return;
    run.finished = true;
    if (current === run) current = null;
    var k, kinds = ['shorts', 'videos'];
    for (var i = 0; i < kinds.length; i++) {
      k = run.probe[kinds[i]];
      // A remembered value that never produced a tile over 5+ channels is probably stale: probe again next time.
      if (k.hit === 0 && k.zero >= 5) rememberSetting(TABS[kinds[i]].setting, '');
    }
    if (run.dirty) saveCache();
    if (run.bg) { try { X.log({ subsfeed: 'bgEnd', fetched: run.done, of: run.ids.length, errors: run.errs, ms: X.now() - run.t0, stopped: run.stopped }); } catch (e) {} }
    while (run.waiters.length) {
      var w = run.waiters.shift();
      call(w.cb, snapshot(w.subs));
    }
  }

  function pump(run) {
    if (run.pumping) return;
    run.pumping = true;
    try {
      while (!run.stopped && run.active < workerLimit(run) && run.next < run.ids.length) {
        if (run.bg && (X.isWatch() || (X.isShorts && X.isShorts()))) { // a video is playing: start nothing new, look again shortly
          if (!run.paused) { run.paused = true; setTimeout(function () { run.paused = false; pump(run); }, BG_PAUSE); }
          break;
        }
        run.paused = false; // not playing (any more): do not wait out the pause timer
        launch(run, run.ids[run.next++]);
      }
    } finally { run.pumping = false; }
    if (run.active === 0 && !run.paused && (run.stopped || run.next >= run.ids.length)) finishRun(run);
  }

  function launch(run, id) {
    run.active++;
    var done = false;
    fetchChannel(id, run.bg ? BG_GROUP : GROUP, run.probe, prevOf(id), function (kind, payload) {
      if (done) return;
      done = true;
      run.active--;
      run.done++;
      if (kind === 'fail') run.errs++;
      try {
        if (applyResult(id, kind, payload) && ++run.dirty % (run.bg ? BG_SAVE_EVERY : SAVE_EVERY) === 0) saveCache();
      } catch (e) { logErr('apply', e); }
      pump(run);
    }, run.bg && !run.page, function () { return run.stopped; });
  }

  function waitForRun(run, subs, cb) {
    if (!cb) return;
    var waiter = { subs: subs, cb: cb };
    run.waiters.push(waiter);
    return function () {
      var at = run.waiters.indexOf(waiter);
      if (at !== -1) run.waiters.splice(at, 1);
    };
  }

  function refresh(subs, onDone, bg) {
    var ids = subIds(subs), now = X.now(), c = getCache();
    lastIds = ids;
    // One run at a time: a caller arriving during a run (background or page) just waits for its result.
    if (current && !current.stopped) {
      if (onDone) {
        if (current.bg && !current.page) { // a page waits for this run: full speed
          var run = current;
          run.page = true;
          setTimeout(function () { try { pump(run); } catch (e) { logErr('refresh', e); } }, 0);
        }
      }
      return waitForRun(current, subs, onDone);
    }
    var stale = [], i;
    for (i = 0; i < ids.length; i++) {
      var e = hasOwn(c.channels, ids[i]) ? c.channels[ids[i]] : null;
      if (isStale(e, now)) stale.push({ id: ids[i], at: e ? e.fetchedAt : -1, n: i });
    }
    if (!stale.length) { if (onDone) setTimeout(function () { call(onDone, snapshot(subs)); }, 0); return; }
    stale.sort(function (a, b) { return a.at - b.at || a.n - b.n; });
    var run = current = {
      ids: stale.map(function (s) { return s.id; }), next: 0, active: 0, stopped: false, finished: false, pumping: false,
      dirty: 0, done: 0, errs: 0, probe: newProbe(), bg: !!bg, page: false, paused: false, t0: now, waiters: []
    };
    if (run.bg) { try { X.log({ subsfeed: 'bgStart', stale: run.ids.length, of: ids.length }); } catch (e) {} }
    setTimeout(function () { try { pump(run); } catch (e) { logErr('refresh', e); finishRun(run); } }, 0);
    return waitForRun(run, subs, onDone);
  }

  function refreshChannel(id, onDone) {
    function done() { call(onDone, { channels: getCache().channels }); }
    if (!validId(id)) { setTimeout(done, 0); return; }
    if (lastIds && lastIds.indexOf(id) === -1) lastIds.push(id);
    try {
      fetchChannel(id, undefined, newProbe(), prevOf(id), function (kind, payload) {
        try { if (applyResult(id, kind, payload)) saveCache(); } catch (e) { logErr('apply', e); }
        done();
      });
    } catch (e) { logErr('refreshChannel', e); setTimeout(done, 0); }
  }

  // Leaving the Subscriptions page: queued channels are dropped (they stay stale) and in-flight requests run on (net.cancel only drops queued jobs); a channel whose
  // videos source (feed or Videos tab) already finished is still cached, with its previous Shorts if only Shorts was cancelled.
  try {
    window.addEventListener('hashchange', function () {
      try {
        if (X.isPage(PAGE)) return;
        if (current && current.bg) { current.page = false; return; } // the background refresh keeps going, gently again
        if (current) current.stopped = true;
        if (X.net && X.net.cancel) X.net.cancel(GROUP);
        if (current && current.active === 0) finishRun(current);
      } catch (e) { logErr('hashchange', e); }
    });
  } catch (e) {}

  // Quiet refresh of the stale channels, not cancelled by navigation. Runs at most once per BG_MIN_AGE, only with
  // local subscriptions (signed out); the result shows the next time Home is built. A running refresh is reused.
  function backgroundRefresh() {
    try {
      var now = X.now();
      if (X.signedIn() || !X.subs || now - lastBg < BG_MIN_AGE) return;
      var subs = X.subs.list();
      if (!subs.length) return;
      if (current && !current.stopped) { // page refresh or earlier background run still going: look again later
        if (!bgRetry) { bgRetry = true; setTimeout(function () { bgRetry = false; backgroundRefresh(); }, 60000); }
        return;
      }
      lastBg = now;
      refresh(subs, null, true);
    } catch (e) { logErr('background', e); }
  }
  try {
    setTimeout(backgroundRefresh, BG_DELAY);
    // Home shown again after a long run: the same check (BG_MIN_AGE keeps it to once per threshold).
    window.addEventListener('hashchange', function () { if (X.isHome()) setTimeout(backgroundRefresh, 3000); });
  } catch (e) {}

  // ---- endless rows (older videos on demand) ---------------------------------------------------
  // Rows keep their Latest exclusions, shown ids and last two answers until eviction or ROW_MAX.
  // The shared older videos expire separately. Each continuation tops up a short page with one fetch per unfinished
  // channel; dates are comparable within a page, and later pages may discover a newer video.
  var DEEP_PER_CHANNEL = 300, DEEP_TOTAL = 1500, DEEP_IDLE = 10 * 60000, DEEP_GROUP = 'subsfeed-more';
  var PAGE_BUDGET_MS = 6000;   // a page request stops fetching after this (common.js answers locally within 8 s)
  var PAGE_ROUNDS = 4;         // ... or after this many rounds
  var MAX_ROWS = 6, ROW_MAX = 1000, EMPTY_PAGES = 10, MAX_ERRORS = 2;
  var deep = null, idleTimer = null;
  var rowMap = Object.create(null), rowKeys = [], rowSeq = 0;

  function deepState(subsById) {
    if (!deep) deep = { t0: X.now(), chans: Object.create(null), total: 0 };
    if (subsById) {
      for (var id in deep.chans) if (!hasOwn(subsById, id)) dropChannel(id);
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { deep = null; }, DEEP_IDLE);
    return deep;
  }
  function dropChannel(id) {
    if (!deep || !deep.chans[id]) return;
    deep.total -= deep.chans[id].videos.length;
    delete deep.chans[id];
  }

  function tokenOf(n) {
    var c = n && n.nextContinuationData && n.nextContinuationData.continuation;
    if (typeof c !== 'string') c = pathGet(n, 'continuationItemRenderer', 'continuationEndpoint', 'continuationCommand', 'token');
    return typeof c === 'string' && c ? c : null;
  }
  // The channel's videos list in a Videos tab response or its continuation: of all the lists in it (TV shelves and grids,
  // web grids and appended items), the one holding the most video tiles. On TV channel pages a playlists or channels
  // shelf can sit beside it, so tiles are counted by kind, not just by number. Its next-page token is read from that
  // same list (its continuations, or a continuation item at its end), also when the list is empty.
  // gridOnly: return null when no list holds a video tile (the caller then falls back). -> { items, next } or null
  function isVideoTile(v) {
    if (!v || typeof v !== 'object') return false;
    if (v.gridVideoRenderer || v.videoRenderer) return true;
    var t = v.tileRenderer;
    if (t) return t.contentType === 'TILE_CONTENT_TYPE_VIDEO' || t.contentType === 'TILE_CONTENT_TYPE_SHORTS' ||
      !!(t.onSelectCommand && (t.onSelectCommand.watchEndpoint || t.onSelectCommand.reelWatchEndpoint));
    var lv = v.lockupViewModel || pathGet(v, 'richItemRenderer', 'content', 'lockupViewModel');
    if (lv) return lv.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' || lv.contentType === 'LOCKUP_CONTENT_TYPE_SHORT';
    return !!pathGet(v, 'richItemRenderer', 'content', 'videoRenderer');
  }
  function videosPage(resp, gridOnly) {
    var best = null, bestN = 0, owner = null, emptyOwner = null;
    scan(resp, function (n) {
      var keys = ['items', 'contents', 'continuationItems'];
      for (var k = 0; k < keys.length; k++) {
        var arr = n[keys[k]];
        if (!isArr(arr)) continue;
        var c = 0;
        for (var i = 0; i < arr.length; i++) if (isVideoTile(arr[i])) c++;
        if (c > bestN) { best = arr; bestN = c; owner = n; }
        else if (!c && !emptyOwner && (n.continuations || (arr.length && tokenOf(arr[arr.length - 1])))) emptyOwner = n;
      }
      return isVideoTile(n);
    });
    if (!best) {
      if (gridOnly) return null;
      owner = emptyOwner;
      best = owner ? owner.items || owner.contents || owner.continuationItems || [] : [];
    }
    var next = null, i, cs = owner && owner.continuations || [];
    for (i = 0; i < cs.length && !next; i++) next = tokenOf(cs[i]);
    for (i = best.length - 1; i >= 0 && !next; i--) next = tokenOf(best[i]);
    return { items: best, next: next };
  }

  function loadOlder(d, id, key, cb, waiting) {
    var ch = d.chans[id] || (d.chans[id] = {
      videos: [], next: null, done: false, waiters: null, tokens: Object.create(null), empties: 0, errors: 0
    });
    var active = ch.waiters;
    if (!active) ch.waiters = Object.create(null);
    ch.waiters[key] = cb;
    waiting.push(ch.waiters);
    if (!active) fetchOlder(d, id, ch);
  }

  function fetchOlder(d, id, ch) {
    function done(err, json) {
      try {
        if (deep !== d || d.chans[id] !== ch) return;
        if (err) {
          if (++ch.errors >= MAX_ERRORS) ch.done = true;
          logErr('olderPage', err);
          return;
        }
        ch.errors = 0;
        var page = videosPage(json, false), got = tilesToVideos(page.items, id, d.t0).videos;
        var have = Object.create(null), before = ch.videos.length, i, v;
        for (i = 0; i < before; i++) have[ch.videos[i].id] = 1;
        for (i = 0; i < got.length && ch.videos.length < DEEP_PER_CHANNEL && d.total < DEEP_TOTAL; i++) {
          v = got[i];
          if (have[v.id] || SHORTS_RE.test(v.title)) continue;
          have[v.id] = 1;
          ch.videos.push(v);
          d.total++;
        }
        // When another channel filled the cache mid-batch, retry this page if space opens up.
        if (i < got.length && ch.videos.length < DEEP_PER_CHANNEL) return;
        ch.empties = before === ch.videos.length ? ch.empties + 1 : 0;
        ch.next = page.next;
        ch.done = !ch.next || !!ch.tokens[ch.next] || ch.empties >= EMPTY_PAGES || ch.videos.length >= DEEP_PER_CHANNEL;
        if (ch.next) ch.tokens[ch.next] = 1;
      } catch (e) { ch.done = true; logErr('olderPage', e); }
      finally {
        var w = ch.waiters;
        ch.waiters = null;
        for (var key in w) call(w[key]);
      }
    }
    try {
      var params = X.settings.get(TABS.videos.setting, '');
      if (typeof params !== 'string' || !params) params = TABS.videos.defaults[0];
      var payload = ch.next ? { continuation: ch.next } : { browseId: id, params: params };
      X.net.innertube('/youtubei/v1/browse', payload, done, netOpts(DEEP_GROUP));
    } catch (e) { done(e); }
  }

  function candidates(row, data, subsById, d) {
    var chans = data && data.channels || {}, subs = subsById || chans;
    var list = [], older = [], seen = Object.create(null);
    for (var id in subs) {
      if (!hasOwn(subs, id)) continue;
      var ch = d.chans[id], cached = chans[id] && chans[id].videos || [];
      if (d.total < DEEP_TOTAL && !(ch && ch.done)) older.push(id);
      var videos = ch ? cached.concat(ch.videos) : cached;
      for (var i = 0; i < videos.length; i++) {
        var v = videos[i];
        if (!v || typeof v.id !== 'string' || v.isShort || seen[v.id] || row.shown[v.id] || row.skip[v.id]) continue;
        var sub = subs[v.channelId];
        if (X.block && X.block.isBlocked({ id: v.id, channelId: v.channelId, author: v.author || (sub && sub.title) })) continue;
        seen[v.id] = 1;
        list.push(v);
      }
    }
    return { list: channelOrder(list), older: older };
  }

  function take(row, page, st, count) {
    var items = st ? st.list.slice(0, count) : [];
    row.emitted += items.length;
    if (row.emitted === ROW_MAX) {
      delete rowMap[row.key];
      rowKeys.splice(rowKeys.indexOf(row.key), 1);
      return { items: items, more: false, next: null };
    }
    var more = !!st && (st.list.length > items.length || st.older.length > 0);
    for (var i = 0; i < items.length; i++) row.shown[items[i].id] = 1;
    row.next = more ? page + 1 : null;
    delete row.answers[page - 2];
    row.answers[page] = { items: items, more: more, next: row.next };
    return row.answers[page];
  }

  function finishPage(key, row, answer) {
    for (var i = 0; i < row.waiting.length; i++) delete row.waiting[i][key];
    row.waiting.length = 0;
    var waiters = row.pending;
    row.pending = null;
    for (i = 0; waiters && i < waiters.length; i++) call(waiters[i], answer);
  }

  // Page zero is synchronous so Home and Subscriptions can build their shelves from cache.
  function openRow(data, subsById, skipIds, count) {
    var key = (++rowSeq).toString(36), d = deepState(subsById);
    var row = { key: key, emitted: 0, shown: Object.create(null), skip: Object.create(null), answers: {}, pending: null, waiting: [] };
    for (var i = 0; skipIds && i < skipIds.length; i++) row.skip[skipIds[i]] = 1;
    rowMap[key] = row;
    rowKeys.push(key);
    var r = take(row, 0, candidates(row, data, subsById, d), Math.max(0, Math.min(count, ROW_MAX)));
    if (rowKeys.length > MAX_ROWS) {
      var oldest = rowKeys.shift(), evicted = rowMap[oldest];
      delete rowMap[oldest];
      finishPage(oldest, evicted, { items: [], more: false, next: null });
    }
    r.key = key;
    return r;
  }

  // wanted (optional): checked before each further round; false stops loading and answers with what is there.
  function nextPage(key, page, data, subsById, count, cb, wanted) {
    var row = rowMap[key], end = { items: [], more: false, next: null };
    if (!row) { call(cb, end); return; }
    rowKeys.splice(rowKeys.indexOf(key), 1);
    rowKeys.push(key);
    if (hasOwn(row.answers, page)) { call(cb, row.answers[page]); return; }
    if (row.next !== page) { call(cb, end); return; }
    count = Math.max(0, Math.min(count, ROW_MAX - row.emitted));
    function finish(answer) { finishPage(key, row, answer); }
    if (row.pending) {
      row.pending.push(cb);
      if (row.pending.length > 3) finish(take(row, page, null, count));
      return;
    }
    row.pending = [cb];
    var d, start = X.now(), rounds = 0;
    function failed(e) {
      logErr('nextPage', e);
      finish(take(row, page, null, count));
    }
    // A round loads one older page per unfinished channel. After a round any new videos are answered; an empty result
    // starts another round (the app does not ask again after an empty answer, so it would end the row), up to
    // PAGE_ROUNDS rounds or PAGE_BUDGET_MS, or until nothing more can load.
    function round() {
      if (!row.pending) return;
      if (rowMap[key] !== row) { finish(end); return; }
      var st = candidates(row, data, subsById, d);
      if (st.list.length >= count || (rounds && st.list.length) || !st.older.length || rounds++ >= PAGE_ROUNDS ||
          X.now() - start >= PAGE_BUDGET_MS || (wanted && !wanted())) { finish(take(row, page, st, count)); return; }
      // One more than the fetches, released after starting them all: a fetch that completes at once cannot end the round early.
      var left = st.older.length + 1;
      function loaded() {
        if (--left || !row.pending) return;
        try { round(); } catch (e) { failed(e); }
      }
      for (var i = 0; i < st.older.length; i++) loadOlder(d, st.older[i], key, loaded, row.waiting);
      loaded();
    }
    try {
      d = deepState(subsById);
      round();
    } catch (e) { failed(e); }
  }

  X.subsfeed = {
    backgroundRefresh: backgroundRefresh, snapshot: snapshot, allFresh: allFresh, refresh: refresh, refreshChannel: refreshChannel,
    rows: rows, fingerprint: fingerprint, parseFeed: parseFeed, tilesToVideos: tilesToVideos,
    openRow: openRow, nextPage: nextPage, dropChannel: dropChannel,
    LATEST_PER_CHANNEL: LATEST_PER_CHANNEL
  };
  X.test = X.test || {};
  X.test.subsfeed = {
    parseFeed: parseFeed, tilesToVideos: tilesToVideos, rows: rows, fingerprint: fingerprint, trimCache: trimCache,
    b64decode: b64decode, b64decodeManual: b64decodeManual, findTabParams: findTabParams, isStale: isStale,
    videosPage: videosPage, openRow: openRow, nextPage: nextPage,
    resetDeep: function () { clearTimeout(idleTimer); deep = null; rowMap = Object.create(null); rowKeys = []; },
    reset: function () { cacheMem = null; lastIds = null; if (current) current.stopped = true; current = null; }
  };
})();
