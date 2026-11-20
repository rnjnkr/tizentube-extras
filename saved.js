// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TT Extras contributors. See LICENSE.
// TT Extras saved.js: "Saved" Shorts, kept on the TV. A Save toggle in the Shorts player's action
// row (a toggleButtonViewModel added to reelActionBarViewModel.buttonViewModels, build/saved-handoff.md),
// a "Saved" sidebar entry after History and a local page with the saved Shorts. ES5 only.
(function () {
  if (location.hostname !== 'www.youtube.com') return;
  if (window.__ttxSavedLoaded) return;
  window.__ttxSavedLoaded = true;
  var X = window.__ttx;
  if (!X) return;

  var KEY = 'tizentube-extras-saved';
  var PAGE = 'FEtizentube_saved';
  var CAP = 500;
  var VIDEO_RE = /^[\w-]{11}$/;
  var RELOAD = { signalAction: { signal: 'SOFT_RELOAD_PAGE' } };

  function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function validId(id) { return typeof id === 'string' && VIDEO_RE.test(id); }
  function logErr(label, e) { try { X.log({ saved: label, error: String(e) }); } catch (e2) {} }

  // ---- Storage: [{id, title, author, channelId, thumbnail, savedAt}], newest first

  function load() {
    return X.loadJson(KEY, [], function (list) {
      return Array.isArray(list) ? list.filter(function (e) { return isObj(e) && validId(e.id); }) : null;
    });
  }

  var changed = false; // the Saved page, kept in memory by the app, needs a reload when shown again
  function store(list) {
    changed = true;
    return X.saveJson(KEY, list.slice(0, CAP));
  }

  function isSaved(id) {
    var list = load();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return true;
    return false;
  }

  function thumbFor(id) {
    var d = X.details[id], t = d && d.thumbnail;
    // Vertical original-aspect frame; a known portrait thumbnail is kept as is.
    return t && t.url && t.height > t.width ? t : { url: 'https://i.ytimg.com/vi/' + id + '/oar2.jpg', width: 405, height: 720 };
  }

  function save(s) {
    var list = load().filter(function (e) { return e.id !== s.id; });
    var d = X.details[s.id] || {};
    var entry = { id: s.id, savedAt: X.now(), thumbnail: thumbFor(s.id) };
    var title = s.title || d.title, author = s.author || d.author, channelId = s.channelId || d.channelId;
    if (title) entry.title = title;
    if (author) entry.author = author;
    if (channelId) entry.channelId = channelId;
    list.unshift(entry);
    return store(list);
  }

  function remove(id) {
    var list = load(), kept = list.filter(function (e) { return e.id !== id; });
    return kept.length === list.length ? true : store(kept);
  }

  // ---- The Save toggle in the Shorts player

  // Toggle view models handed to the app, per video: flipped in place when the state changes, so a
  // cached overlay shown again in this session starts in the right state. Bounded (TOGGLE_IDS videos,
  // TOGGLE_REFS each): they would otherwise keep overlays alive that the app has long dropped.
  var TOGGLE_IDS = 150, TOGGLE_REFS = 3;
  var toggles = Object.create(null), toggleKeys = [];

  function findLikeVideoId(node, depth) {
    if (!node || typeof node !== 'object' || depth > 14) return null;
    var le = node.likeEndpoint;
    if (isObj(le) && isObj(le.target) && validId(le.target.videoId)) return le.target.videoId;
    for (var k in node) {
      var v = node[k], r;
      if (v && typeof v === 'object' && (r = findLikeVideoId(v, depth + 1))) return r;
    }
    return null;
  }

  function button(icon, title, cmd) {
    return {
      buttonViewModel: {
        iconName: icon, title: title, accessibilityText: title,
        onTap: { innertubeCommand: { clickTrackingParams: null, playlistEditEndpoint: {}, tizentubeExtrasCommand: cmd } },
        style: 'BUTTON_VIEW_MODEL_STYLE_UNKNOWN', type: 'BUTTON_VIEW_MODEL_TYPE_UNKNOWN',
        buttonSize: 'BUTTON_VIEW_MODEL_SIZE_DEFAULT', state: 'BUTTON_VIEW_MODEL_STATE_UNKNOWN',
        accessibilityId: 'id.ttx_save', targetId: '', tooltip: ''
      }
    };
  }

  function mutateReelOverlay(r) {
    var ov = isObj(r.overlay) && r.overlay.reelPlayerOverlayRenderer;
    var bar = isObj(ov) && isObj(ov.buttonBar) && ov.buttonBar.reelActionBarViewModel;
    var list = isObj(bar) && bar.buttonViewModels;
    if (!Array.isArray(list) || X.origStringify(list).indexOf('id.ttx_save') !== -1) return;
    var hs = ov.reelPlayerHeaderSupportedRenderers;
    var h = isObj(hs) && isObj(hs.reelPlayerHeaderRenderer) ? hs.reelPlayerHeaderRenderer : {};
    var nav = h.channelNavigationEndpoint && h.channelNavigationEndpoint.browseEndpoint;
    var spec = {
      id: findLikeVideoId(bar, 0),
      title: X.plainText(h.reelTitleText),
      author: X.plainText(h.channelTitleText),
      channelId: nav && typeof nav.browseId === 'string' && nav.browseId.indexOf('UC') === 0 ? nav.browseId : undefined
    };
    var tvm = {
      defaultButtonViewModel: button('BOOKMARK', 'Save', { saveShort: spec }),
      toggledButtonViewModel: button('BOOKMARK_FILLED', 'Saved', { unsaveShort: spec }),
      isToggled: !!(spec.id && isSaved(spec.id)),
      isTogglingDisabled: false
    };
    if (spec.id) {
      var refs = toggles[spec.id];
      if (!refs) {
        refs = toggles[spec.id] = [];
        toggleKeys.push(spec.id);
        if (toggleKeys.length > TOGGLE_IDS) delete toggles[toggleKeys.shift()];   // oldest ids go first
      }
      refs.push(tvm);
      if (refs.length > TOGGLE_REFS) refs.shift();
      X.addDetails(spec.id, { title: spec.title, author: spec.author, channelId: spec.channelId });
    }
    list.push({ reelActionBarButtonViewModel: { buttonViewModel: { toggleButtonViewModel: tvm }, shouldHideInLandscape: false } });
  }

  function setToggled(id, on) {
    var t = toggles[id];
    for (var i = 0; t && i < t.length; i++) t[i].isToggled = on;
  }

  // The overlay lacked the video id: take it from the player.
  function withId(spec) {
    var s = isObj(spec) ? spec : {};
    if (validId(s.id)) return s;
    try {
      var data = document.querySelector('.html5-video-player').getVideoData();
      if (data && validId(data.video_id)) {
        var d = X.details[data.video_id] || {};
        return { id: data.video_id, title: d.title || data.title, author: d.author || data.author, channelId: d.channelId };
      }
    } catch (e) {}
    return null;
  }

  X.onResponse('mutate', function (r, inf) {
    if (!inf || inf.kind !== 'reelOverlay') return;
    try { mutateReelOverlay(r); } catch (e) { logErr('reelOverlay', e); }
  });

  X.onCommand('saveShort', function (spec) {
    var s = withId(spec);
    if (!s) { X.toast('Could not save this Short'); return; }
    // On failure X.saveJson has shown "Storage full" already.
    if (save(s)) { setToggled(s.id, true); X.toast('Saved', s.title); }
  });

  X.onCommand('unsaveShort', function (spec) {
    var s = withId(spec);
    if (!s) return;
    if (remove(s.id)) { setToggled(s.id, false); X.toast('Removed from Saved'); }
  });

  // ---- The Saved page

  var EMPTY_SHELF = 'Press the bookmark button next to a Short to save it here';

  // Page layout. Shorts tiles (TILE_STYLE_YTLR_SHORTS) only get room for a title under the thumbnail when
  // the tile has styling {arrangement VERTICAL, scale SM} AND sits in a TVHTML5_SHELF_RENDERER_TYPE_SHORTS_GRID
  // shelf (or a GRID_STYLE_TYPE_SHORTS grid); otherwise the app sizes them thumbnail-only (kabuki.js, tile
  // size tables Nva/Ova/awa/xwa), which is why YouTube's own Shorts rows here show no titles either.
  // So: one SHORTS_GRID shelf of styled Shorts tiles (title + channel; verified on the TV).

  // The Shorts player's sequence: a reelWatchEndpoint with only a videoId makes the app play the
  // tiles of the list it was opened from and stop after the last one. With sequenceProvider RPC the
  // app asks YouTube (reel_watch_sequence) for what follows, seeded with sequenceParams; the params are
  // those of YouTube's own Home Shorts shelf: protobuf {1: videoId, 5: {3: 5}}. The saved Shorts after
  // the opened one are put in front of YouTube's answer below (startSequence / mergeSequence).
  function seedParams(id) {
    var bytes = [0x0a, id.length], i;
    for (i = 0; i < id.length; i++) bytes.push(id.charCodeAt(i));
    bytes.push(0x2a, 0x02, 0x18, 0x05);
    var bin = '';
    for (i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return encodeURIComponent(btoa(bin));
  }

  var OVERLAY = { reelPlayerOverlayRenderer: { style: 'REEL_PLAYER_OVERLAY_STYLE_SHORTS', reelPlayerNavigationModel: 'REEL_PLAYER_NAVIGATION_MODEL_UNSPECIFIED' } };

  function reelEndpoint(id) {
    return {
      reelWatchEndpoint: {
        videoId: id, overlay: X.origParse(X.origStringify(OVERLAY)),
        sequenceProvider: 'REEL_WATCH_SEQUENCE_PROVIDER_RPC', sequenceParams: seedParams(id)
      }
    };
  }

  function tile(e) {
    var menu = [X.menuItem('Remove from Saved', { removeFromSaved: e.id })];
    if (e.channelId) menu.push(X.navItem('Go to channel', { browseEndpoint: { browseId: e.channelId } }));
    var spec = {
      id: e.id, title: e.title || 'Short', author: e.author, thumbnail: e.thumbnail || thumbFor(e.id),
      onSelect: reelEndpoint(e.id), menuItems: menu,
      style: 'TILE_STYLE_YTLR_SHORTS', contentType: 'TILE_CONTENT_TYPE_SHORTS', lines: e.author ? [[e.author]] : []
    };
    var t = X.videoTile(spec);
    t.tileRenderer.styling = { arrangement: 'TILE_ARRANGEMENT_VERTICAL', scale: 'TILE_SCALE_SM' };
    return t;
  }

  // block.js also filters the page's tiles; done here first so an all-blocked list shows the empty hint.
  function notBlocked(e) {
    try { return !(X.block && X.block.isBlocked({ id: e.id, author: e.author, channelId: e.channelId || null })); } catch (err) { return true; }
  }

  function visible() { return load().filter(notBlocked); }

  function pageResponse() {
    var items = visible().map(tile);
    if (items.length) {
      var shelf = X.shelf(items.length === 1 ? '1 saved Short' : items.length + ' saved Shorts, newest first', items);
      shelf.shelfRenderer.tvhtml5ShelfRendererType = 'TVHTML5_SHELF_RENDERER_TYPE_SHORTS_GRID';
      X.unshrinkShorts(shelf.shelfRenderer);
      return X.shelvesPage(PAGE, 'Saved Shorts', [shelf]);
    }
    // TV check (subs.js): a messageRenderer page renders blank, so the hint is a shelf title over one placeholder tile.
    var hint = X.channelTile({
      id: PAGE, title: 'No saved Shorts yet', subtitle: 'Use the bookmark button in the Shorts player',
      menuItems: [X.navItem('Go to Home', { browseEndpoint: { browseId: 'FEtopics' } })]
    });
    return X.shelvesPage(PAGE, 'Saved Shorts', [X.shelf(EMPTY_SHELF, [hint])]);
  }

  // ---- Continuing the Shorts player after the saved ones

  var SEQ_MAX = 200;      // saved Shorts put in front of YouTube's sequence
  var SEQ_WAIT = 20000;   // YouTube's sequence answer must come this soon after the tile was opened
  var pending = null;     // { seed, rest: [ids], at }

  // A Saved page tile was opened (its endpoint carries our seeded sequenceParams).
  function startSequence(cmd) {
    var rw = isObj(cmd) && cmd.reelWatchEndpoint;
    if (!isObj(rw) || !validId(rw.videoId) || !X.isPage(PAGE) || rw.sequenceParams !== seedParams(rw.videoId)) return;
    var ids = visible().map(function (e) { return e.id; }), at = ids.indexOf(rw.videoId);
    if (at === -1) return;
    pending = { seed: rw.videoId, rest: ids.slice(at + 1, at + 1 + SEQ_MAX), at: X.now() };
    X.log({ saved: 'seqStart', seed: pending.seed, rest: pending.rest.length });
    var p = pending;
    setTimeout(function () { if (pending === p) { X.log({ saved: 'seqNoAnswer', seed: p.seed }); pending = null; } }, SEQ_WAIT);
  }

  function entryId(en) {
    var rw = isObj(en) && isObj(en.command) && en.command.reelWatchEndpoint;
    return isObj(rw) && typeof rw.videoId === 'string' ? rw.videoId : null;
  }

  // YouTube's first sequence answer after a Saved tile was opened: the remaining saved Shorts go first,
  // YouTube's own Shorts (and its continuation, left untouched) after them.
  function mergeSequence(r) {
    var p = pending;
    if (!p || X.now() - p.at > SEQ_WAIT) return;
    pending = null;
    var skip = {}, i;
    for (i = 0; i < p.rest.length; i++) skip[p.rest[i]] = true;
    var yt = r.entries.filter(function (en) { return !skip[entryId(en)]; });
    var seedFirst = yt.length && entryId(yt[0]) === p.seed;
    var tmpl = yt.length && isObj(yt[0].command) && yt[0].command.reelWatchEndpoint;
    var ours = p.rest.map(function (id) {
      var rw = { videoId: id, overlay: X.origParse(X.origStringify(isObj(tmpl) && isObj(tmpl.overlay) ? tmpl.overlay : OVERLAY)) };
      return { command: { reelWatchEndpoint: rw } };
    });
    r.entries = seedFirst ? [yt[0]].concat(ours, yt.slice(1)) : ours.concat(yt);
    X.log({ saved: 'seqMerged', seed: p.seed, ours: ours.length, youtube: yt.length, seedFirst: !!seedFirst, keys: Object.keys(r) });
  }

  X.onAnyCommand(function (cmd) {
    try {
      // Any other Shorts player start (Home, Subscriptions, ...) ends the wait for our seeded answer.
      var rw = isObj(cmd) && cmd.reelWatchEndpoint;
      if (pending && isObj(rw) && rw.sequenceParams !== seedParams(rw.videoId)) pending = null;
      startSequence(cmd);
    } catch (e) { logErr('seqStart', e); }
  });

  X.onResponse('mutate', function (r, inf) {
    if (!inf || inf.kind !== 'reel') return;
    try { mergeSequence(r); } catch (e) { logErr('seqMerge', e); }
  });

  X.localPage(PAGE, function (body, respond) {
    changed = false;
    respond(pageResponse());
  });

  X.guideEntry({ browseId: PAGE, title: 'Saved', iconType: 'BOOKMARK_FILLED', after: ['FEtizentube_history'] });

  X.onCommand('removeFromSaved', function (id) {
    if (!validId(id) || !remove(id)) return;
    setToggled(id, false);
    if (X.isPage(PAGE)) { changed = false; X.resolveCommand(RELOAD); }
  });

  window.addEventListener('hashchange', function () {
    // The Shorts player runs at '#/' (TV check): any other page (Saved again, Home, ...) makes a pending sequence wait stale.
    if (pending && location.hash !== '#/') pending = null;
    // Back on the page after saving or removing elsewhere: show the current list.
    if (!changed || !X.isPage(PAGE)) return;
    changed = false;
    setTimeout(function () { if (X.isPage(PAGE)) X.resolveCommand(RELOAD); }, 300);
  });

  X.saved = { isSaved: isSaved, list: load };
  X.test.saved = { load: load, save: save, remove: remove, isSaved: isSaved, tile: tile, pageResponse: pageResponse, mutateReelOverlay: mutateReelOverlay,
    seedParams: seedParams, startSequence: startSequence, mergeSequence: mergeSequence };
})();
