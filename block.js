// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TT Extras contributors. See LICENSE.
// TT Extras: block a channel or a video so it never appears again (design section 5).
// Filters tiles/reel entries/autoplay in the response pipeline, adds long-press menu items and a
// channel-page button, and a settings row + modal to unblock. ES5 only.
(function () {
  if (location.hostname !== 'www.youtube.com') return;
  if (window.__ttxBlockLoaded) return;
  window.__ttxBlockLoaded = true;
  var X = window.__ttx;
  if (!X) return;

  var KEY = 'tizentube-extras-blocks';
  var VIDEO_CAP = 500, CHANNEL_CAP = 300;
  var CMD = 'tizentubeExtrasCommand';

  function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function str(s) { return typeof s === 'string' ? s.replace(/^\s+|\s+$/g, '') : ''; }
  function norm(name) { return X.channels && X.channels.norm ? X.channels.norm(name) : str(name).toLowerCase(); }
  function idForName(name) {
    try { return name && X.channels && X.channels.idForName ? X.channels.idForName(name) || null : null; } catch (e) { return null; }
  }
  function isUC(id) { return typeof id === 'string' && id.indexOf('UC') === 0; }
  function short(s) { s = String(s); return s.length > 28 ? s.slice(0, 28) + '\u2026' : s; }
  function entryKey(e) { return e.id || 'name:' + norm(e.name); }

  // ---- Storage and lookups (design 5.1)

  var store = { v: 1, videos: [], channels: [] };
  // channelNameSet: names of all channel entries; nameOnlySet: names of entries without an id.
  var videoSet = Object.create(null), channelIdSet = Object.create(null), channelNameSet = Object.create(null);
  var nameOnlySet = Object.create(null);
  var anyBlocked = false, nameOnly = 0, trimNoticeShown = false, trimNoticePending = false;

  function validate(o) {
    if (!isObj(o) || o.v !== 1 || !Array.isArray(o.videos) || !Array.isArray(o.channels)) return null;
    var s = { v: 1, videos: [], channels: [] }, i, e, v;
    for (i = 0; i < o.videos.length; i++) {
      e = o.videos[i];
      if (!isObj(e) || typeof e.id !== 'string' || !e.id) continue;
      v = { id: e.id, at: typeof e.at === 'number' ? e.at : 0 };
      if (typeof e.title === 'string') v.title = e.title;
      if (typeof e.author === 'string') v.author = e.author;
      s.videos.push(v);
    }
    for (i = 0; i < o.channels.length; i++) {
      e = o.channels[i];
      if (!isObj(e) || typeof e.name !== 'string' || !e.name) continue;
      s.channels.push({ id: isUC(e.id) ? e.id : null, name: e.name, at: typeof e.at === 'number' ? e.at : 0 });
    }
    return s;
  }

  function rebuild() {
    var i, c;
    videoSet = Object.create(null); channelIdSet = Object.create(null); channelNameSet = Object.create(null);
    nameOnlySet = Object.create(null);
    nameOnly = 0;
    for (i = 0; i < store.videos.length; i++) videoSet[store.videos[i].id] = 1;
    for (i = 0; i < store.channels.length; i++) {
      c = store.channels[i];
      var n = norm(c.name);
      if (n) channelNameSet[n] = 1;
      if (c.id) channelIdSet[c.id] = 1;
      else { nameOnly++; if (n) nameOnlySet[n] = 1; }
    }
    anyBlocked = store.videos.length + store.channels.length > 0;
  }

  function load() {
    store = X.loadJson(KEY, null, validate) || { v: 1, videos: [], channels: [] };
    rebuild();
    return store;
  }

  function copyStore() { return { v: 1, videos: store.videos.slice(), channels: store.channels.slice() }; }
  function save(next) { return X.saveJson(KEY, next || store); }

  // Drops the oldest entries of list beyond cap; true when something was dropped.
  function trimList(list, cap) {
    if (list.length <= cap) return false;
    var idx = [], i;
    for (i = 0; i < list.length; i++) idx.push(i);
    idx.sort(function (a, b) { return list[a].at - list[b].at || a - b; });
    var drop = {};
    for (i = 0; i < list.length - cap; i++) drop[idx[i]] = 1;
    var kept = [];
    for (i = 0; i < list.length; i++) if (!drop[i]) kept.push(list[i]);
    list.length = 0;
    for (i = 0; i < kept.length; i++) list.push(kept[i]);
    return true;
  }

  function commit(next) {
    var t1 = trimList(next.videos, VIDEO_CAP), t2 = trimList(next.channels, CHANNEL_CAP);
    if (!save(next)) return false;
    store = next;
    rebuild();
    if ((t1 || t2) && !trimNoticeShown) { trimNoticeShown = true; trimNoticePending = true; }
    return true;
  }

  function notifyTrim() {
    if (!trimNoticePending) return;
    trimNoticePending = false;
    setTimeout(function () { try { X.toast('Oldest blocked items were removed'); } catch (e) {} }, 2500);
  }

  // Fills ids of name-only entries. Video-based blocks enter the store with their verified id.
  function upgrade() {
    var next = null, i, j, c, id;
    for (i = store.channels.length - 1; i >= 0; i--) {
      c = store.channels[i];
      if (c.id) continue;
      id = idForName(c.name);
      if (!id) continue;
      if (!next) next = copyStore();
      var dup = false;
      for (j = 0; j < next.channels.length; j++) if (next.channels[j].id === id) dup = true;
      if (dup) next.channels.splice(i, 1); else next.channels[i] = { id: id, name: c.name, at: c.at };
    }
    return !!next && commit(next);
  }

  // ---- Lookup (design 5.3)

  function blocked(v) {
    if (!v || !anyBlocked) return false;
    var id = v.id, d = id && X.details ? X.details[id] : null;
    if (id && videoSet[id]) return true;
    var cid = v.channelId || (d && d.channelId);
    if (cid && channelIdSet[cid]) return true;
    if (d && d.channelId && channelIdSet[d.channelId]) return true;
    // The tile's channel is known and not blocked by id: a name only counts for name-only entries (which have
    // no id to compare), never an entry with an id, which would catch other channels of the same name.
    if (cid && !nameOnly) return false;
    var names = cid ? nameOnlySet : channelNameSet;
    var a = v.author, i, n;
    for (i = 0; i < 2; i++) {
      if (i === 1) { a = d && d.author; if (!a || a === v.author) break; }
      if (!a) continue;
      n = norm(a);
      if (n && names[n]) return true;
      if (!cid) { // the directory's id for the name: only for tiles whose channel id is unknown
        var byName = idForName(a);
        if (byName && channelIdSet[byName]) return true;
      }
    }
    return false;
  }

  function blockedId(id) { return blocked({ id: id }); }

  // Removes blocked items from a tile array in place; returns how many.
  function filterItems(items) {
    var n = 0;
    if (!anyBlocked) return 0;
    for (var i = items.length - 1; i >= 0; i--) {
      var v = X.itemVideo(items[i]);
      if (v && blocked(v)) { items.splice(i, 1); n++; }
    }
    return n;
  }

  // Video ids of the related tiles of a `next` response, in order.
  function relatedIds(r) {
    var out = [], sn = r.contents && r.contents.singleColumnWatchNextResults;
    var list = sn && sn.pivot && sn.pivot.sectionListRenderer && sn.pivot.sectionListRenderer.contents;
    if (!Array.isArray(list)) return out;
    function arrays(el, acc) {
      if (!isObj(el)) return;
      var h = el.shelfRenderer && el.shelfRenderer.content && el.shelfRenderer.content.horizontalListRenderer;
      if (h && Array.isArray(h.items)) acc.push(h.items);
      if (el.gridRenderer && Array.isArray(el.gridRenderer.items)) acc.push(el.gridRenderer.items);
      var ic = el.itemSectionRenderer && el.itemSectionRenderer.contents;
      if (Array.isArray(ic)) for (var k = 0; k < ic.length; k++) arrays(ic[k], acc);
    }
    var lists = [], i, j;
    for (i = 0; i < list.length; i++) arrays(list[i], lists);
    for (i = 0; i < lists.length; i++) {
      for (j = 0; j < lists[i].length; j++) {
        var v = X.itemVideo(lists[i][j]);
        if (v && v.kind === 'video' && v.id) out.push(v.id);
      }
    }
    return out;
  }

  function currentVideoId(r) {
    var ce = r.currentVideoEndpoint && r.currentVideoEndpoint.watchEndpoint;
    if (ce && typeof ce.videoId === 'string') return ce.videoId;
    var m = /[?&]v=([\w-]+)/.exec(location.hash || '');
    return m ? m[1] : null;
  }

  function watchEndpoints(node, out, depth, budget) {
    if (!node || typeof node !== 'object' || depth > 14 || budget.n-- <= 0) return;
    if (node.watchEndpoint && typeof node.watchEndpoint.videoId === 'string') out.push(node.watchEndpoint);
    for (var k in node) {
      var v = node[k];
      if (v && typeof v === 'object') watchEndpoints(v, out, depth + 1, budget);
    }
  }

  // Autoplay fix-up (design 5.3, A15). relatedIds: array or function returning one; pure otherwise.
  function fixAutoplay(r, isBlockedId, related, currentId) {
    var res = { swapped: 0, deleted: false };
    var sn = r && r.contents && r.contents.singleColumnWatchNextResults;
    var ap = sn && sn.autoplay && sn.autoplay.autoplay;
    var sets = ap && ap.sets;
    if (!Array.isArray(sets)) return res;
    var eps = [], i;
    for (i = 0; i < sets.length; i++) watchEndpoints(sets[i], eps, 0, { n: 400 });
    var bad = [];
    for (i = 0; i < eps.length; i++) if (isBlockedId(eps[i].videoId)) bad.push(eps[i]);
    if (!bad.length) return res;
    var ids = typeof related === 'function' ? related() : related || [], pick = null;
    for (i = 0; i < ids.length && pick === null; i++) {
      if (ids[i] !== currentId && !isBlockedId(ids[i])) pick = ids[i];
    }
    if (pick === null) {
      delete sn.autoplay.autoplay;
      res.deleted = true;
      return res;
    }
    for (i = 0; i < bad.length; i++) {
      bad[i].videoId = pick;
      delete bad[i].params;
      delete bad[i].playerParams;
      res.swapped++;
    }
    return res;
  }

  // ---- Pipeline

  X.onResponse('filter', function (r, inf) {
    if (!anyBlocked) return;
    if (nameOnly) upgrade();
    var i;
    if (inf.kind === 'reel') {
      var kept = [];
      for (i = 0; i < r.entries.length; i++) {
        var rw = r.entries[i] && r.entries[i].command && r.entries[i].command.reelWatchEndpoint;
        if (!(rw && typeof rw.videoId === 'string' && blockedId(rw.videoId))) kept.push(r.entries[i]);
      }
      // Never leave the Shorts player with an empty list (it may end or spin): keep entries unfiltered then.
      if (kept.length) r.entries = kept;
    } else if (inf.kind === 'next') {
      fixAutoplay(r, blockedId, function () { return relatedIds(r); }, currentVideoId(r));
    }
  });

  X.onItems('filter', function (items) { filterItems(items); });

  function hasOwnCmd(menu, key) {
    for (var i = 0; i < menu.length; i++) {
      var it = menu[i] && menu[i].menuServiceItemRenderer;
      var c = it && it.serviceEndpoint && it.serviceEndpoint[CMD];
      if (c && c[key]) return true;
    }
    return false;
  }

  X.onItems('mutate', function (items) {
    for (var i = 0; i < items.length; i++) {
      var v = X.itemVideo(items[i]);
      if (!v || blocked(v)) continue;
      var isVid = (v.kind === 'video' || v.kind === 'short') && v.id;
      var isCh = v.kind === 'channel' && (v.channelId || v.title);
      if (!isVid && !isCh) continue;
      var menu = v.menuItems || v.ensureMenu();
      if (!menu) continue;
      if (isVid && !hasOwnCmd(menu, 'blockVideo')) {
        menu.push(X.menuItem('Block this video', { blockVideo: { id: v.id, title: v.title, author: v.author } }));
      }
      if (hasOwnCmd(menu, 'blockChannel')) continue;
      if (isVid && (v.author || v.channelId)) {
        menu.push(X.menuItem('Block channel ' + short(v.author || v.channelId),
          { blockChannel: { id: v.channelIdGuessed ? null : v.channelId || null, name: v.author, videoId: v.id } }));
      } else if (isCh) {
        menu.push(X.menuItem('Block channel ' + short(v.title || v.channelId),
          { blockChannel: { id: v.channelId || null, name: v.title } }));
      }
    }
  });

  // Channel-page button next to Subscribe (design 5.4).
  X.onResponse('mutate', function (r, inf) {
    if (inf.kind !== 'browse' || typeof inf.browseId !== 'string' || !/^UC/.test(inf.browseId)) return;
    var tsc = r.contents && r.contents.tvBrowseRenderer && r.contents.tvBrowseRenderer.content &&
      r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer;
    var header = tsc && tsc.header;
    var h = header && (header.channelHeaderRenderer || header);
    if (!h || !Array.isArray(h.buttons)) return;
    if (hasButton(h.buttons)) return;
    var id = inf.browseId;
    var name = X.plainText(h.title) || (X.channels && X.channels.get && (X.channels.get(id) || {}).name) || '';
    var isB = channelBlocked(id, name);
    var cmd = isB ? { unblockChannel: { key: channelKeyFor(id, name) } } : { blockChannel: { id: id, name: name } };
    var cmdWrap = {};
    cmdWrap[CMD] = cmd;
    h.buttons.push({
      buttonRenderer: {
        isDisabled: false,
        text: { runs: [{ text: isB ? 'Unblock channel (TT)' : 'Block channel (TT)' }] },
        icon: { iconType: isB ? 'ADD' : 'REMOVE' },
        command: cmdWrap,
        trackingParams: null
      }
    });
  });

  function hasButton(buttons) {
    for (var i = 0; i < buttons.length; i++) {
      var c = buttons[i] && buttons[i].buttonRenderer && buttons[i].buttonRenderer.command;
      c = c && c[CMD];
      if (c && (c.blockChannel || c.unblockChannel)) return true;
    }
    return false;
  }

  // Channel page: the id is known, so a name matches only name-only entries.
  function channelBlocked(id, name) {
    if (channelIdSet[id]) return true;
    return !!(name && nameOnlySet[norm(name)]);
  }

  function channelKeyFor(id, name) {
    var n = norm(name), i, e;
    for (i = 0; i < store.channels.length; i++) if (store.channels[i].id === id) return entryKey(store.channels[i]);
    for (i = 0; i < store.channels.length; i++) {
      e = store.channels[i];
      if (n && norm(e.name) === n) return entryKey(e);
    }
    return id;
  }

  // ---- Actions

  // Not under a player: the watch page, or the Shorts player (whose hash is Home's '#/').
  function reload() {
    if (X.isWatch() || (X.onShortsPage && X.onShortsPage())) return;
    if (X.keepHomeFeed) X.keepHomeFeed(); // on Home: same videos, minus the blocked ones (extras.js)
    X.resolveCommand({ signalAction: { signal: 'SOFT_RELOAD_PAGE' } });
  }

  function addVideo(spec) {
    spec = spec || {};
    var id = str(spec.id);
    if (!id) return null;
    var d = X.details && X.details[id];
    for (var i = 0; i < store.videos.length; i++) if (store.videos[i].id === id) return store.videos[i];
    var e = { id: id, at: X.now() };
    var title = str(spec.title) || (d && d.title), author = str(spec.author) || (d && d.author);
    if (title) e.title = String(title).slice(0, 100);
    if (author) e.author = String(author).slice(0, 60);
    var next = copyStore();
    next.videos.push(e);
    return commit(next) ? e : null;
  }

  function maybeUnsub(id) {
    try {
      if (X.subs && X.subs.isSubscribed && X.subs.isSubscribed(id)) {
        var c = {};
        c[CMD] = { unsubscribe: { id: id, quiet: true } };
        X.resolveCommand(c);
        return !X.subs.isSubscribed(id);
      }
    } catch (e) {}
    return false;
  }

  function addChannel(spec) {
    spec = spec || {};
    var name = str(spec.name), id = isUC(spec.id) ? spec.id : null, i, e;
    if (!id && name) id = idForName(name);
    if (id && !name) {
      var known = X.channels && X.channels.get && X.channels.get(id);
      name = known && known.name || id;
    }
    if (!name) return null;
    var n = norm(name);
    for (i = 0; i < store.channels.length; i++) {
      e = store.channels[i];
      if ((id && e.id === id) || (norm(e.name) === n && !(id && e.id))) break; // two ids: two channels
    }
    var found = store.channels[i];
    if (found && (found.id || !id)) return found;
    found = { id: id, name: found ? found.name : name, at: found ? found.at : X.now() };
    var next = copyStore();
    next.channels[i] = found;
    return commit(next) ? found : null;
  }

  var pending = Object.create(null);
  function resolveLater(spec) {
    var vid = spec.videoId;
    if (pending[vid]) return;
    if (!X.channels || !X.channels.resolveForVideo) { X.toast('Channel not found'); return; }
    pending[vid] = spec;
    X.channels.resolveForVideo(vid, function (err, ch) {
      if (pending[vid] !== spec) return;
      delete pending[vid];
      if (err || !ch || !isUC(ch.id)) { X.toast('Channel not found'); return; }
      blockChannel({ id: ch.id, name: ch.name || spec.name });
    });
  }

  function blockVideo(spec) {
    var e = addVideo(spec);
    if (!e) return null;
    X.toast('Blocked video', e.title || 'Video ' + e.id);
    reload();
    notifyTrim();
    return e;
  }

  function blockChannel(spec) {
    if (spec && spec.videoId && (!isUC(spec.id) || spec.channelIdGuessed)) { resolveLater(spec); return null; }
    var e = addChannel(spec);
    if (!e) return null;
    var unsub = e.id && maybeUnsub(e.id);
    X.toast('Blocked channel', e.name + (unsub ? '. Also unsubscribed' : ''));
    reload();
    notifyTrim();
    return e;
  }

  function unblockVideo(id) {
    for (var i = 0; i < store.videos.length; i++) {
      if (store.videos[i].id === id) {
        var next = copyStore(), e = next.videos.splice(i, 1)[0];
        return commit(next) ? e : null;
      }
    }
    return null;
  }

  function unblockChannel(key) {
    var removed = null, next = null;
    for (var i = store.channels.length - 1; i >= 0; i--) {
      var e = store.channels[i];
      if (entryKey(e) === key || 'name:' + norm(e.name) === key) {
        if (!next) next = copyStore();
        removed = e; next.channels.splice(i, 1);
      }
    }
    if (next && !commit(next)) return null;
    for (var vid in pending) if (key === 'name:' + norm(pending[vid].name)) delete pending[vid];
    return removed;
  }

  function fromModal(cmd) { return !!(cmd && cmd[CMD] && cmd[CMD].refreshBlocked !== undefined); }

  X.onCommand('blockVideo', function (p) { blockVideo(p); });
  X.onCommand('blockChannel', function (p) { blockChannel(p); });
  X.onCommand('unblockVideo', function (p, cmd) {
    var e = p && unblockVideo(p.id);
    if (e && !fromModal(cmd)) { X.toast('Unblocked video', e.title || 'Video ' + e.id); reload(); }
  });
  X.onCommand('unblockChannel', function (p, cmd) {
    var e = p && unblockChannel(p.key);
    if (e && !fromModal(cmd)) { X.toast('Unblocked channel', e.name); reload(); }
  });
  X.onCommand('unblockAll', function (p, cmd) {
    var changed = anyBlocked;
    if (changed && !commit({ v: 1, videos: [], channels: [] })) return;
    pending = Object.create(null);
    if (changed && !fromModal(cmd)) { X.toast('Unblocked everything'); reload(); }
  });

  // ---- Management UI (design 5.5)

  function counts() { return { channels: store.channels.length, videos: store.videos.length }; }

  function buildModalRows(s) {
    var rows = [], i, c, v;
    function cmd(inner, index) {
      var o = {};
      for (var k in inner) o[k] = inner[k];
      o.refreshBlocked = index;
      var w = {};
      w[CMD] = o;
      return [w];
    }
    if (!s.channels.length && !s.videos.length) {
      return [X.row({ title: 'Nothing is blocked', commands: [{ signalAction: { signal: 'POPUP_BACK' } }] })];
    }
    rows.push(X.row({ title: 'Unblock all', icon: 'REMOVE', commands: cmd({ unblockAll: true }, 0) }));
    for (i = 0; i < s.channels.length; i++) {
      c = s.channels[i];
      rows.push(X.row({
        title: c.name, subtitle: c.id ? 'Channel' : 'Channel (name match)', icon: 'PERSON',
        commands: cmd({ unblockChannel: { key: entryKey(c) } }, rows.length)
      }));
    }
    for (i = 0; i < s.videos.length; i++) {
      v = s.videos[i];
      rows.push(X.row({
        title: v.title || 'Video ' + v.id, subtitle: v.author,
        commands: cmd({ unblockVideo: { id: v.id } }, rows.length)
      }));
    }
    return rows;
  }

  function showModal(index, update) {
    var rows = buildModalRows(store);
    var sel = Math.max(0, Math.min(typeof index === 'number' ? index : 0, rows.length - 1));
    X.modal({ title: 'Blocked', subtitle: 'Select to unblock', uniqueId: 'ttx-blocked', rows: rows, selectedIndex: sel, update: !!update });
  }

  X.onCommand('openBlocked', function () { if (nameOnly) upgrade(); showModal(0, false); });
  X.onCommand('refreshBlocked', function (index) {
    // The parent settings row shows the counts: rebuild TizenTube's popup first, then re-issue the
    // modal so it ends up on top with the selection.
    try { X.refreshSettings('blocked'); } catch (e) {}
    showModal(index, true);
  });

  X.settingsRow('blocked', function () {
    var n = counts();
    return X.row({
      title: 'Blocked channels & videos',
      subtitle: n.channels + ' channels, ' + n.videos + ' videos',
      icon: 'REMOVE',
      commands: [{ tizentubeExtrasCommand: { openBlocked: true } }]
    });
  });

  // ---- Public API and test hooks

  X.block = {
    isBlockedVideo: blockedId,
    isBlocked: blocked,
    blockVideo: blockVideo,
    blockChannel: blockChannel,
    counts: counts
  };

  X.test = X.test || {};
  X.test.block = {
    blocked: blocked, filterItems: filterItems, fixAutoplay: fixAutoplay, buildModalRows: buildModalRows,
    load: load, save: save, upgrade: upgrade, relatedIds: relatedIds,
    store: function () { return store; },
    reset: function () {
      store = { v: 1, videos: [], channels: [] };
      trimNoticeShown = false; trimNoticePending = false;
      try { delete localStorage[KEY]; } catch (e) {}
      rebuild();
    }
  };

  load();
  try { if (nameOnly) upgrade(); } catch (e) {}
})();
