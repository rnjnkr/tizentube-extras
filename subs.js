// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TT Extras contributors. See LICENSE.
// TT Extras subs.js: local Subscriptions for guests (design section 4). The channels are kept in
// localStorage; the sidebar's Subscriptions entry opens a local page with their latest videos, more
// videos, Shorts and a row of channel tiles. Subscribing: long-press menu item on tiles, YouTube's
// own (signed-out) Subscribe button, and a button on channel pages. Data comes from subsfeed.js. ES5 only.
(function () {
  if (location.hostname !== 'www.youtube.com') return;
  if (window.__ttxSubsLoaded) return;
  window.__ttxSubsLoaded = true;
  var X = window.__ttx;
  if (!X) return;

  var KEY = 'tizentube-extras-subs';
  var PAGE = 'FEtizentube_subscriptions';
  var CMD = 'tizentubeExtrasCommand';
  var CAP = 200;
  var ID_RE = /^UC[\w-]{22}$/;
  var WAIT_EMPTY_MS = 4000;     // nothing cached yet: wait this long for the first data before answering
  var PARTIAL_MS = 15000;       // a long first load: check for partial results this often and reload once
  var RELOAD_MAX_MS = 120000;   // a refresh finishing later than this does not reload the page under the user
  var SUB_KEYS = ['subscribe', 'unsubscribe', 'toggleSubscription'];
  var RELOAD = { signalAction: { signal: 'SOFT_RELOAD_PAGE' } };
  var PAGE_SIZE = 20;           // videos per load of an endless row (Home's Subscriptions row, the page's "More" row)

  function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function str(s) { return typeof s === 'string' ? s.replace(/^\s+|\s+$/g, '') : ''; }
  function validId(id) { return typeof id === 'string' && ID_RE.test(id); }
  function short(s) { s = String(s); return s.length > 28 ? s.slice(0, 28) + '…' : s; }
  function norm(name) { return X.channels && X.channels.norm ? X.channels.norm(name) : str(name).toLowerCase(); }
  function logErr(label, e) { try { X.log({ subs: label, error: String(e) }); } catch (e2) {} }
  function known(id) { try { return X.channels && X.channels.get ? X.channels.get(id) : null; } catch (e) { return null; } }
  function active() { return !X.signedIn(); }
  function reload() { X.resolveCommand(RELOAD); }
  function avatarUrl(a) {
    var u = typeof a === 'string' ? a : isObj(a) && typeof a.url === 'string' ? a.url : null;
    // the TV hands out 48px avatars; the channel tile is much bigger
    return u ? u.replace(/=s48-/, '=s240-') : null;
  }
  function clone(n, d) {
    if (!n || typeof n !== 'object' || d > 30) return n;
    var out, i;
    if (Array.isArray(n)) {
      out = [];
      for (i = 0; i < n.length; i++) out.push(clone(n[i], d + 1));
      return out;
    }
    out = {};
    for (var k in n) if (hasOwn(n, k)) out[k] = clone(n[k], d + 1);
    return out;
  }

  // ---- Storage (design 4.1): {v:1, channels:[{id, title, avatar, addedAt}]}, newest first

  var store = { v: 1, channels: [] };
  var byId = Object.create(null);

  function validate(o) {
    if (!isObj(o) || o.v !== 1 || !Array.isArray(o.channels)) return null;
    var s = { v: 1, channels: [] }, seen = {};
    for (var i = 0; i < o.channels.length && s.channels.length < CAP; i++) {
      var e = o.channels[i];
      if (!isObj(e) || !validId(e.id) || hasOwn(seen, e.id)) continue;
      seen[e.id] = 1;
      s.channels.push({
        id: e.id, title: str(e.title) || e.id, avatar: avatarUrl(e.avatar),
        addedAt: typeof e.addedAt === 'number' ? e.addedAt : 0
      });
    }
    return s;
  }

  function rebuild() {
    byId = Object.create(null);
    for (var i = 0; i < store.channels.length; i++) byId[store.channels[i].id] = store.channels[i];
  }

  function load() {
    store = X.loadJson(KEY, null, validate) || { v: 1, channels: [] };
    rebuild();
  }
  function save() { return X.saveJson(KEY, store); }

  function list() { return store.channels.slice(); }
  function isSubscribed(id) { return typeof id === 'string' && !!byId[id]; }

  // -> 'ok' | 'exists' | 'limit' | 'invalid' | 'failed'
  function add(spec) {
    var id = spec && spec.id;
    if (!validId(id)) return 'invalid';
    if (byId[id]) return 'exists';
    if (store.channels.length >= CAP) return 'limit';
    var k = known(id);
    store.channels.unshift({
      id: id, title: str(spec.title) || (k && k.name) || id,
      avatar: avatarUrl(spec.avatar) || (k && k.avatar) || null, addedAt: X.now()
    });
    if (!save()) { store.channels.shift(); rebuild(); return 'failed'; }
    rebuild();
    return 'ok';
  }

  function remove(id) {
    for (var i = 0; i < store.channels.length; i++) {
      if (store.channels[i].id !== id) continue;
      var e = store.channels.splice(i, 1)[0];
      if (!save()) { store.channels.splice(i, 0, e); rebuild(); return null; }
      rebuild();
      if (X.subsfeed) X.subsfeed.dropChannel(id);
      return e;
    }
    return null;
  }

  // Fills in a missing title/avatar of a subscribed channel; true when something changed.
  function improve(id, title, avatar) {
    var c = byId[id], changed = false;
    if (!c) return false;
    title = str(title); avatar = avatarUrl(avatar);
    if (title && c.title === c.id) { c.title = title; changed = true; }
    if (avatar && !c.avatar) { c.avatar = avatar; changed = true; }
    if (changed) { save(); rebuild(); }
    return changed;
  }

  // ---- Command shapes (design 4.4 entry point 2)

  // The subscribe/unsubscribe a command stands for, looking only through the wrappers YouTube puts
  // around it signed out: {id, op:'subscribe'|'unsubscribe'} or null. Anything else (menus that merely
  // contain such an item, other sign-in prompts) is not recognised.
  function recognise(cmd, depth) {
    depth = depth || 0;
    if (!isObj(cmd) || depth > 6 || cmd[CMD]) return null;
    var op = 'subscribe', e = cmd.subscribeEndpoint;
    if (!isObj(e) && isObj(cmd.unsubscribeEndpoint)) { e = cmd.unsubscribeEndpoint; op = 'unsubscribe'; }
    if (isObj(e)) return Array.isArray(e.channelIds) && validId(e.channelIds[0]) ? { id: e.channelIds[0], op: op } : null;
    var next = null, w;
    if (isObj(w = cmd.authDeterminedCommand)) next = w.authenticatedCommand;
    else if (isObj(w = cmd.signInEndpoint)) next = w.nextEndpoint;
    else if (isObj(w = cmd.authRequiredCommand) && isObj(w.identityActionContext)) next = w.identityActionContext.nextEndpoint;
    else if (isObj(w = cmd.startSignInCommand) && isObj(w.identityActionContext)) next = w.identityActionContext.nextEndpoint;
    else if (isObj(w = cmd.commandExecutorCommand) && Array.isArray(w.commands)) {
      for (var i = 0; i < w.commands.length; i++) {
        var r = recognise(w.commands[i], depth + 1);
        if (r) return r;
      }
      return null;
    }
    return next ? recognise(next, depth + 1) : null;
  }

  // ---- Menu items (design 4.4 entry point 1)

  function hasOwnCmd(menu) {
    for (var i = 0; i < menu.length; i++) {
      var it = menu[i] && menu[i].menuServiceItemRenderer;
      var c = it && it.serviceEndpoint && it.serviceEndpoint[CMD];
      if (!c) continue;
      for (var k = 0; k < SUB_KEYS.length; k++) if (c[SUB_KEYS[k]]) return true;
    }
    return false;
  }

  // v = X.itemVideo(item) -> {label, cmd} for the long-press menu, or null when there is nothing to offer.
  function menuEntryFor(v) {
    if (!v) return null;
    var isCh = v.kind === 'channel', isVid = (v.kind === 'video' || v.kind === 'short') && !!v.id;
    if (!isVid && !(isCh && validId(v.channelId))) return null;
    var name = isCh ? v.title : v.author;
    var cid = v.channelIdGuessed ? null : v.channelId; // a name guess may be another channel of the same name
    if (!validId(cid) && isVid) return {
      label: 'Toggle subscription' + (name ? ' for ' + short(name) : ''),
      cmd: { toggleSubscription: { videoId: v.id, title: name || '' } }
    };
    if (!validId(cid)) return null;
    if (byId[cid]) return { label: 'Unsubscribe from ' + short(byId[cid].title), cmd: { unsubscribe: { id: cid } } };
    return { label: 'Subscribe to ' + short(name || cid), cmd: { subscribe: { id: cid, title: name || '' } } };
  }

  X.onItems('mutate', function (items) {
    if (!active()) return;
    for (var i = 0; i < items.length; i++) {
      var v = X.itemVideo(items[i]);
      if (!v) continue;
      if (v.menuItems && hasOwnCmd(v.menuItems)) continue;
      var ent = menuEntryFor(v);
      if (!ent) continue;
      var menu = v.menuItems || v.ensureMenu();
      if (menu && !hasOwnCmd(menu)) menu.push(X.menuItem(ent.label, ent.cmd));
    }
  });

  // ---- Channel page button (design 4.4 entry point 3)

  function channelButton(id, title, avatar, subscribed) {
    var c = {};
    c[CMD] = { toggleSubscription: { id: id, title: title, avatar: avatar } };
    return {
      buttonRenderer: {
        isDisabled: false,
        text: { runs: [{ text: subscribed ? 'Unsubscribe (TT)' : 'Subscribe (TT)' }] },
        icon: { iconType: subscribed ? 'REMOVE' : 'ADD' },
        command: c,
        trackingParams: null
      }
    };
  }

  function hasButton(buttons) {
    for (var i = 0; i < buttons.length; i++) {
      var c = buttons[i] && buttons[i].buttonRenderer && buttons[i].buttonRenderer.command;
      if (c && c[CMD] && c[CMD].toggleSubscription) return true;
    }
    return false;
  }

  X.onResponse('mutate', function (r, inf) {
    if (!active() || inf.kind !== 'browse' || !validId(inf.browseId)) return;
    var tsc = r.contents && r.contents.tvBrowseRenderer && r.contents.tvBrowseRenderer.content &&
      r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer;
    var header = tsc && tsc.header;
    var h = header && (header.channelHeaderRenderer || header);
    if (!h || !Array.isArray(h.buttons) || hasButton(h.buttons)) return;
    var id = inf.browseId, k = known(id);
    var title = X.plainText(h.title) || (k && k.name) || '';
    var avatar = (k && k.avatar) || null;
    improve(id, title, avatar);
    // Next to YouTube's own Subscribe, ahead of other modules' buttons (Block channel).
    var at = h.buttons.length;
    for (var i = 0; i < h.buttons.length; i++) {
      var bc = h.buttons[i] && h.buttons[i].buttonRenderer && h.buttons[i].buttonRenderer.command;
      if (bc && bc[CMD]) { at = i; break; }
    }
    h.buttons.splice(at, 0, channelButton(id, title, avatar, !!byId[id]));
  });

  // ---- Shorts player: YouTube's Subscribe button (reel_item_watch response)

  // The reel response carries overlay.reelPlayerOverlayRenderer.subscribeButtonRenderer, itself wrapped
  // once more as subscribeButtonRenderer.subscribeButtonRenderer. For a locally subscribed channel the
  // button and its subscriptionStateEntity are flipped to subscribed; the button's unsubscribeEndpoint is
  // then recognised by the command hook below. Needs a response kind 'reelOverlay' from common.js info().
  function reelButton(r) {
    var ov = isObj(r) && isObj(r.overlay) && r.overlay.reelPlayerOverlayRenderer;
    var w = isObj(ov) && ov.subscribeButtonRenderer;
    var b = isObj(w) && (isObj(w.subscribeButtonRenderer) ? w.subscribeButtonRenderer : w);
    return isObj(b) && validId(b.channelId) ? b : null;
  }

  function mutateReelOverlay(r) {
    try {
      var b = reelButton(r);
      if (!b || !byId[b.channelId]) return false;
      var changed = false;
      if (b.subscribed !== true) {
        b.subscribed = true;
        b.buttonText = isObj(b.subscribedButtonText) ? b.subscribedButtonText : { runs: [{ text: 'Subscribed' }] };
        changed = true;
      }
      // The TV draws the button from the subscription entity in frameworkUpdates, not from the flag.
      var fu = isObj(r.frameworkUpdates) && r.frameworkUpdates.entityBatchUpdate;
      var ms = isObj(fu) && fu.mutations;
      if (Array.isArray(ms) && typeof b.subscribedEntityKey === 'string') {
        for (var i = 0; i < ms.length; i++) {
          var ent = isObj(ms[i]) && isObj(ms[i].payload) && ms[i].payload.subscriptionStateEntity;
          if (isObj(ent) && ent.key === b.subscribedEntityKey && ent.subscribed !== true) { ent.subscribed = true; changed = true; }
        }
      }
      return changed;
    } catch (e) { logErr('reelOverlay', e); return false; }
  }

  X.onResponse('mutate', function (r, inf) {
    if (!active() || !inf || inf.kind !== 'reelOverlay') return;
    mutateReelOverlay(r);
  });

  // ---- Subscribe / unsubscribe commands (design 4.4)

  function titleOf(id, spec) { var k = known(id); return str(spec && spec.title) || (k && k.name) || (byId[id] && byId[id].title) || id; }
  function afterChange(id, subscribed) {
    if (X.isPage(PAGE) && !subscribed) reload();
    else if (id && X.isPage(id)) reload(); // the channel page's button label flips
  }

  function doSubscribe(spec) {
    var id = spec.id, res = add(spec), title = titleOf(id, spec);
    if (res === 'ok') {
      X.toast('Subscribed', title);
      try {
        if (X.subsfeed) X.subsfeed.refreshChannel(id, function () { if (X.isPage(PAGE)) reload(); });
      } catch (e) { logErr('refreshChannel', e); }
      afterChange(id, true);
    } else if (res === 'exists') X.toast('Already subscribed', title);
    else if (res === 'limit') X.toast('Subscription limit reached (' + CAP + ')');
    else if (res === 'invalid') X.toast('Could not subscribe', 'Channel not found');
    else if (res === 'failed') X.toast("Couldn't save subscription", title);
    return res;
  }

  // quiet: the caller (block.js) shows its own toast and reloads once itself.
  function doUnsubscribe(id, quiet) {
    var was = !!byId[id], e = remove(id);
    if (!e) {
      if (was) X.toast("Couldn't remove subscription", titleOf(id));
      return null;
    }
    if (quiet) return e;
    X.toast('Unsubscribed', e.title);
    afterChange(id, false);
    return e;
  }

  var lookups = Object.create(null);
  function withOwner(p, action) {
    if (!p) return;
    if (validId(p.id) && !p.channelIdGuessed) { action(p); return; }
    var vid = p.videoId;
    if (!vid || !X.channels || !X.channels.resolveForVideo) { X.toast('Channel not found'); return; }
    if (lookups[vid]) return;
    lookups[vid] = true;
    X.toast('Looking up channel…', p.title || '');
    X.channels.resolveForVideo(vid, function (err, ch) {
      delete lookups[vid];
      if (err || !ch || !validId(ch.id)) { X.toast('Channel not found'); return; }
      action({ id: ch.id, title: ch.name || p.title, avatar: ch.avatar, quiet: p.quiet });
    });
  }

  X.onCommand('subscribe', function (p) { withOwner(p, doSubscribe); });
  X.onCommand('unsubscribe', function (p) {
    withOwner(p, function (owner) { doUnsubscribe(owner.id, !!owner.quiet); });
  });
  X.onCommand('toggleSubscription', function (p) {
    withOwner(p, function (owner) {
      if (byId[owner.id]) doUnsubscribe(owner.id); else doSubscribe(owner);
    });
  });

  // YouTube's own Subscribe button, signed out: it would only open a sign-in prompt, so toggle locally.
  X.onAnyCommand(function (cmd) {
    if (!cmd || typeof cmd !== 'object' || !active()) return;
    var s = recognise(cmd);
    if (!s) return;
    if (byId[s.id]) doUnsubscribe(s.id); else doSubscribe({ id: s.id });
    return { handled: true };
  });

  // ---- The page (design 4.3)

  var TITLES = {
    latest: 'Latest from your subscriptions', more: 'More from your subscriptions',
    shorts: 'Shorts from your subscriptions', channels: 'Your subscriptions'
  };
  var EMPTY_SHELF = 'Subscribe from a long-press menu ("Subscribe to <channel>") or the Subscribe (TT) button on a channel page';
  var EMPTY = 'You are not subscribed to any channels yet. To subscribe, long-press a video and choose ' +
    '"Subscribe to <channel>", or press "Subscribe (TT)" on a channel page.';

  function idMap(subs) {
    var m = {};
    for (var i = 0; i < subs.length; i++) m[subs[i].id] = subs[i];
    return m;
  }

  // Long-press menu of a row tile: Play (video tiles), Go to channel, Unsubscribe.
  function rowMenu(id, title, vid, channelTile) {
    var m = [];
    if (vid) m.push(X.navItem('Play', { watchEndpoint: { videoId: vid } }));
    if (id) {
      m.push(X.navItem('Go to channel', { browseEndpoint: { browseId: id } }));
      m.push(X.menuItem(channelTile ? 'Unsubscribe' : 'Unsubscribe from ' + short(title), { unsubscribe: { id: id } }));
    }
    return m;
  }

  function videoRow(v, byIdMap) {
    var s = byIdMap[v.channelId], author = v.author || (s && s.title) || '';
    var when = v.publishedText || (typeof v.published === 'number' ? X.ago(v.published) : undefined);
    return X.videoTile({
      id: v.id, title: v.title, author: author, thumbnail: v.thumbnail, length: v.length, sub: when,
      menuItems: rowMenu(v.channelId, author, v.id)
    });
  }

  function shortRow(v, byIdMap) {
    var s = byIdMap[v.channelId], author = v.author || (s && s.title) || '';
    if (!v.tile) return videoRow(v, byIdMap);
    var tile = clone(v.tile, 0), iv = X.itemVideo(tile);
    var menu = iv && iv.ensureMenu();
    if (menu) {
      var extra = rowMenu(v.channelId, author, null);
      for (var i = 0; i < extra.length; i++) menu.push(extra[i]);
    }
    return tile;
  }

  function channelRows(subs, data) {
    var sorted = subs.slice().sort(function (a, b) {
      var x = norm(a.title), y = norm(b.title);
      return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return sorted.map(function (s) {
      var e = data && data.channels && hasOwn(data.channels, s.id) ? data.channels[s.id] : null;
      var first = e && e.videos && e.videos[0];
      return X.channelTile({
        id: s.id, title: s.title, avatar: s.avatar, placeholder: first && first.thumbnail,
        menuItems: rowMenu(s.id, s.title, null, true)
      });
    });
  }

  function safe(fn) { try { return fn(); } catch (e) { logErr('page', e); return null; } }

  // subs: [{id, title, avatar}], data: subsfeed snapshot, opts {loading, gen}. -> JSON string of the browse response.
  function buildPage(subs, data, opts) {
    opts = opts || {};
    if (!subs || !subs.length) {
      // TV check: a messageRenderer page renders blank, so the hint is a shelf title over one placeholder tile.
      var hint = X.channelTile({
        id: PAGE, title: 'No subscriptions yet', subtitle: 'Long-press a video and choose Subscribe',
        menuItems: [X.navItem('Go to Home', { browseEndpoint: { browseId: 'FEtopics' } })]
      });
      return X.shelvesPage(PAGE, 'Subscriptions', [X.shelf(EMPTY_SHELF, [hint])], EMPTY);
    }
    var m = idMap(subs), shelves = [], videos = 0;
    var rows = safe(function () { return X.subsfeed.rows(data || { channels: {} }, m); }) || { latest: [], more: [], shorts: [] };
    function add(title, items, shorts) {
      if (items && items.length) shelves.push(X.shelf(title, items, shorts ? { shorts: true } : undefined));
    }
    function tiles(arr, fn) {
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var t = safe(function () { return fn(arr[i], m); });
        if (t) out.push(t);
      }
      return out;
    }
    var latest = tiles(rows.latest, videoRow), shorts = tiles(rows.shorts, shortRow);
    // "More" scrolls on through older videos (endless row), leaving out what "Latest" shows.
    var mp = safe(function () { return X.subsfeed.openRow(data || { channels: {} }, m, ids(rows.latest), PAGE_SIZE); }) || { items: [], more: false };
    var more = tiles(mp.items, videoRow);
    videos = latest.length + more.length + shorts.length;
    add(TITLES.latest, latest);
    if (more.length) shelves.push(X.shelf(TITLES.more, more, { continuation: contToken(mp.key, mp) }));
    else if (mp.more && (opts.gen === undefined || opts.gen === view.gen)) fillMore(mp, data, m);
    add(TITLES.shorts, shorts, true);
    add(TITLES.channels, safe(function () { return channelRows(subs, data); }));
    var title = 'Subscriptions';
    if (!videos) title += opts.loading ? ' (loading videos\u2026)' : ' (no recent videos found)';
    return X.shelvesPage(PAGE, title, shelves, 'Could not build your subscriptions.');
  }

  // ---- endless rows

  function ids(videos) { return (videos || []).map(function (v) { return v.id; }); }
  function contToken(key, r) { return r.more ? 'ttxsubs.' + key + '.' + r.next : null; }

  // Latest may cover the whole cache. Keep asking one batch at a time while this visit is current.
  function fillMore(first, data, m) {
    var gen = view.gen;
    function current() { return gen === view.gen && !view.filled && X.isPage(PAGE); }
    function load(page) {
      if (!current()) return;
      X.subsfeed.nextPage(first.key, page, data, m, PAGE_SIZE, function (r) {
        if (!current()) return;
        if (r.items.length) { view.filled = true; reload(); }
        else if (r.more) setTimeout(function () { load(r.next); }, 0);
      }, current);
    }
    setTimeout(function () { load(first.next); }, 0);
  }
  function videoTiles(videos, m) {
    var out = [];
    for (var i = 0; i < videos.length; i++) {
      var t = safe(function () { return videoRow(videos[i], m); });
      if (t) out.push(t);
    }
    return out;
  }

  X.localContinuation('subs', function (rest, respond) {
    var t = /^([a-z0-9]{1,24})\.([1-9]\d{0,9})$/.exec(rest), subs = list(), sf = X.subsfeed;
    if (!t || !subs.length || !sf) { respond(X.listContinuation([], null)); return; }
    var key = t[1], m = idMap(subs);
    sf.nextPage(key, +t[2], sf.snapshot(subs), m, PAGE_SIZE, function (r) {
      // Replay the rendered tiles too: relative date labels and channel titles can change between requests.
      if (!r.response) r.response = X.listContinuation(videoTiles(r.items, m), contToken(key, r));
      X.log({ subsMore: key, page: +t[2], items: r.items.length, more: !!r.more });
      respond(r.response);
    });
  });

  // Home's second row: all subscribed channels' videos, newest first, loading older ones as it scrolls; null with no
  // subscriptions or an empty cache.
  function homeShelf() {
    var subs = list();
    if (!active() || !subs.length || !X.subsfeed) return null;
    var m = idMap(subs), sf = X.subsfeed;
    var r = safe(function () { return sf.openRow(sf.snapshot(subs), m, null, PAGE_SIZE); });
    var items = r ? videoTiles(r.items, m) : [];
    return items.length ? X.shelf('Subscriptions', items, { continuation: contToken(r.key, r) }) : null;
  }

  function hasVideos(data) {
    for (var id in data.channels) {
      var e = data.channels[id];
      if (e && ((e.videos && e.videos.length) || (e.shorts && e.shorts.length))) return true;
    }
    return false;
  }

  function fixTitles(data) {
    for (var i = 0; i < store.channels.length; i++) {
      var c = store.channels[i];
      if (c.title !== c.id && c.avatar) continue;
      var k = known(c.id), e = hasOwn(data.channels, c.id) ? data.channels[c.id] : null;
      improve(c.id, (k && k.name) || (e && e.videos && e.videos[0] && e.videos[0].author), k && k.avatar);
    }
  }

  var view = { detach: null, gen: 0, reloaded: false, partial: false, filled: false };

  // Answers at once from the cache and refreshes in the background; reloads the page (once per visit,
  // only if still on it and the rows changed) when the refresh is done. With nothing cached yet it waits
  // a few seconds for the first data (the app shows its spinner meanwhile).
  function provider(body, respond) {
    if (view.detach) { view.detach(); view.detach = null; }
    var gen = ++view.gen, t0 = X.now(), subs = list();
    if (!subs.length || !X.subsfeed) { respond(buildPage(subs, null)); return; }
    var sf = X.subsfeed, data = sf.snapshot(subs);
    fixTitles(data);
    subs = list();
    var m = idMap(subs), answered = false, finished = false, timer = null, baseFp = '', shownLoading = false, ptimer = null;

    function answer(d, loading) {
      if (answered) return;
      answered = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      var json;
      try {
        baseFp = sf.fingerprint(d, m);
        shownLoading = loading;
        if (loading && gen === view.gen) armPartial();
        json = buildPage(subs, d, { loading: loading, gen: gen });
      } catch (e) {
        logErr('buildPage', e);
        json = X.shelvesPage(PAGE, 'Subscriptions', [], 'Could not build your subscriptions.');
      }
      respond(json);
    }

    // Cold start with many channels: the full refresh can outlast RELOAD_MAX_MS, so reload once as soon
    // as some videos exist (still on our page, rows changed). Together with done() at most two reloads:
    // view.partial and view.reloaded are separate, so the provider of that reload (which joins the same
    // run) still reloads once at the end; the gen check stops the stale one.
    function armPartial() {
      if (ptimer !== null) clearTimeout(ptimer);
      ptimer = setTimeout(function () {
        ptimer = null;
        try {
          if (finished || gen !== view.gen || view.partial || !X.isPage(PAGE)) return;
          var snap = sf.snapshot(subs);
          if (hasVideos(snap) && sf.fingerprint(snap, m) !== baseFp) {
            view.partial = true; reload();
          } else armPartial();
        } catch (e) { logErr('partialReload', e); }
      }, PARTIAL_MS);
    }

    function done(snap) {
      finished = true;
      if (gen === view.gen) view.detach = null;
      if (ptimer !== null) { clearTimeout(ptimer); ptimer = null; }
      if (!answered) { answer(snap, false); return; }
      if (gen !== view.gen || view.reloaded || !X.isPage(PAGE) || X.now() - t0 > RELOAD_MAX_MS) return;
      if (shownLoading || sf.fingerprint(snap, m) !== baseFp) { view.reloaded = true; reload(); }
    }

    if (sf.allFresh(data, subs) || hasVideos(data)) answer(data, false);
    else timer = setTimeout(function () { timer = null; answer(sf.snapshot(subs), !finished); }, WAIT_EMPTY_MS);
    view.detach = sf.refresh(subs, function (snap) {
      try { done(snap); } catch (e) { logErr('refreshDone', e); }
    });
  }

  X.localPage(PAGE, provider);

  // The sidebar's own Subscriptions entry is repurposed (YouTube's title, icon and position), or ours is
  // inserted after History when the entry is missing. Signed in, YouTube's own stays.
  X.guideEntry({
    browseId: PAGE, replace: 'FEsubscriptions', after: ['FEtizentube_history', 'FEtopics', 'FEwhat_to_watch'],
    title: 'Subscriptions', iconType: 'SUBSCRIPTIONS', when: active
  });

  try {
    window.addEventListener('hashchange', function () {
      view.reloaded = false; view.partial = false; view.filled = false;
      if (!X.isPage(PAGE)) {
        view.gen++;
        if (view.detach) { view.detach(); view.detach = null; }
      }
    });
  } catch (e) {}

  load();

  X.subs = {
    homeShelf: homeShelf, mutateReelOverlay: mutateReelOverlay, PAGE: PAGE, isSubscribed: isSubscribed, list: list, count: function () { return store.channels.length; },
    add: add, remove: remove, toggle: function (spec) {
      if (!spec || !validId(spec.id)) return 'invalid';
      if (byId[spec.id]) { remove(spec.id); return 'removed'; }
      return add(spec);
    }
  };

  X.test = X.test || {};
  X.test.subs = {
    validate: validate, recognise: recognise, mutateReelOverlay: mutateReelOverlay, menuEntryFor: menuEntryFor, channelButton: channelButton,
    buildPage: buildPage, provider: provider, hasOwnCmd: hasOwnCmd, videoRow: videoRow, shortRow: shortRow,
    channelRows: channelRows, load: load, store: function () { return store; },
    reset: function () {
      if (view.detach) view.detach();
      view = { detach: null, gen: view.gen + 1, reloaded: false, partial: false, filled: false };
      store = { v: 1, channels: [] }; rebuild(); lookups = Object.create(null);
    }
  };

  X.log({ subsLoaded: location.href, subscriptions: store.channels.length });
})();
