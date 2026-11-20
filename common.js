// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TT Extras contributors. See LICENSE.
// TT Extras shared prelude (window.__ttx), loaded right after TizenTube's userscript (see loader.js).
// Owns the only JSON.parse wrapper, the only XMLHttpRequest wrapper and the only resolveCommand
// wrapper of ours; features (extras.js, guest.js, block.js, subs.js, ...) register handlers on it.
// Interface contract: build/design-subs-block.md section 2. ES5 only.
(function () {
  if (location.hostname !== 'www.youtube.com') return;
  if (window.__ttx) return;
  var X = window.__ttx = {};

  var origParse = JSON.parse;           // TizenTube's wrapper when it ran first: what we wrap
  var origStringify = JSON.stringify;
  X.origParse = origParse;
  X.origStringify = origStringify;
  X.now = function () { return Date.now(); };

  var base = document.currentScript && document.currentScript.src ? document.currentScript.src.replace(/[^/?#]*([?#].*)?$/, '') : '';
  var DEV = /\.localhost[:/]/.test(base);
  X.base = base;
  X.DEV = DEV;

  // Development builds report to the dev server's /log (dev-server.py).
  function log(obj) {
    if (!DEV) return;
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', base.replace(/dev\/$/, '') + 'log');
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(origStringify(obj));
    } catch (e) {}
  }
  X.log = log;
  function errLog(label, e) { log({ handlerError: label, error: String(e), stack: String(e && e.stack).slice(0, 400) }); }
  if (DEV) {
    window.addEventListener('error', function (e) {
      log({ error: String(e.message), at: e.filename + ':' + e.lineno });
    });
    if (window.fetch) {
      var devFetch = window.fetch;
      window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : input && input.url;
        var p = devFetch.apply(this, arguments);
        if (url && url.indexOf('/youtubei/v1/browse') !== -1) {
          var body = init && typeof init.body === 'string' ? init.body : '';
          var m = /"browseId":"([^"]+)"/.exec(body);
          p.then(function (res) { log({ fetchBrowse: m && m[1], status: res.status, url: url.slice(0, 120) }); },
            function (err) { log({ fetchBrowse: m && m[1], failed: String(err) }); });
        }
        return p;
      };
    }
  }

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function callAll(list, args, label) {
    var copy = list.slice();
    for (var i = 0; i < copy.length; i++) {
      try { copy[i].apply(null, args); } catch (e) { errLog(label, e); }
    }
  }

  // ---- Page state

  X.isHome = function () {
    return location.hash === '' || location.hash === '#/' || location.hash.indexOf('#/?') === 0;
  };
  X.isPage = function (id) { return location.hash.indexOf('c=' + id) !== -1; };
  X.isWatch = function () { return location.hash.indexOf('#/watch') === 0; };
  // The Shorts player keeps the hash at '#/', so X.isHome() is true there too. Reload helpers use this guard:
  // a visible Shorts page (X.isShorts, shorts.js) or a Shorts start (reelWatchEndpoint) in the last 3 s,
  // which covers the moment the hash changes before the page is drawn.
  var lastReelCmd = 0;
  X.onShortsPage = function () {
    return (X.isShorts ? !!X.isShorts() : false) || X.now() - lastReelCmd < 3000;
  };
  X.signedIn = function () {
    try { return !!(window.ytcfg && ytcfg.get && ytcfg.get('LOGGED_IN')); } catch (e) { return false; }
  };

  // ---- Storage

  var storageTrimmers = [];
  var lastFullToast = 0;
  X.onStorageFull = function (fn) { storageTrimmers.push(fn); };

  X.loadJson = function (key, fallback, validate) {
    var raw, obj;
    try { raw = localStorage[key]; } catch (e) { return fallback; }
    if (raw === undefined || raw === null || raw === '') return fallback;
    try { obj = origParse(raw); } catch (e) { log({ corruptJson: key }); return fallback; }
    if (validate) {
      try { obj = validate(obj); } catch (e) { obj = null; }
      if (obj === null || obj === undefined) { log({ invalidJson: key }); return fallback; }
    }
    return obj;
  };

  X.saveJson = function (key, obj) {
    function write() {
      try { localStorage[key] = origStringify(obj); return true; } catch (e) { return false; }
    }
    if (write()) return true;
    for (var i = 0; i < storageTrimmers.length; i++) {
      try { storageTrimmers[i](key, obj); } catch (e) { errLog('storageTrimmer', e); }
      if (write()) return true;
    }
    log({ storageFull: key });
    var now = X.now();
    if (!lastFullToast || now - lastFullToast >= 60000) {
      lastFullToast = now;
      X.toast('Storage full — change not saved');
    }
    return false;
  };

  var SETTINGS_KEY = 'tizentube-extras-settings';
  function loadSettings() {
    return X.loadJson(SETTINGS_KEY, {}, function (o) { return o && typeof o === 'object' && !Array.isArray(o) ? o : null; });
  }
  X.settings = {
    get: function (name, dflt) {
      var v = loadSettings()[name];
      return v === undefined ? dflt : v;
    },
    set: function (name, value) {
      var s = loadSettings();
      s[name] = value;
      return X.saveJson(SETTINGS_KEY, s);
    }
  };

  // ---- Text and renderer builders

  function text(s) { return { simpleText: s }; }
  X.text = text;

  X.plainText = function (t) {
    if (!t) return undefined;
    if (t.simpleText) return t.simpleText;
    if (t.runs) return t.runs.map(function (r) { return r.text; }).join('');
    return undefined;
  };
  var plainText = X.plainText;

  X.duration = function (seconds) {
    seconds = Math.floor(seconds);
    var h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
    var mm = h ? (m < 10 ? '0' : '') + m : String(m);
    return (h ? h + ':' : '') + mm + ':' + (s < 10 ? '0' : '') + s;
  };

  X.ago = function (time) {
    var minutes = Math.floor((X.now() - time) / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    var days = Math.floor(hours / 24);
    if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
    return new Date(time).toLocaleDateString();
  };

  // English relative time ("3 days ago", "Streamed 2 weeks ago", "Just now") -> approximate epoch ms, or null.
  var AGO_UNITS = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, year: 31536000000 };
  X.parseAgo = function (str, now) {
    if (typeof str !== 'string') return null;
    if (now === undefined) now = X.now();
    var m = /\b(\d+|an?|one)\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/i.exec(str);
    if (m) {
      var n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : 1;
      return now - n * AGO_UNITS[m[2].toLowerCase()];
    }
    if (/\bjust now\b|\bmoments? ago\b/i.test(str)) return now;
    if (/\byesterday\b/i.test(str)) return now - AGO_UNITS.day;
    return null;
  };

  X.lineRenderer = function (texts) {
    return {
      lineRenderer: {
        items: texts.map(function (t) { return { lineItemRenderer: { text: text(t) } }; })
      }
    };
  };
  var lineRenderer = X.lineRenderer;

  X.menuItem = function (title, ownCommand) {
    return {
      menuServiceItemRenderer: {
        text: { runs: [{ text: title }] },
        // The menu only renders service items whose endpoint is a type it knows, so carry
        // ours with an empty playlistEditEndpoint; the resolveCommand wrapper looks at the other key.
        // No customAction in it: TizenTube's resolveCommand swallows every one of those.
        serviceEndpoint: { clickTrackingParams: null, playlistEditEndpoint: {}, tizentubeExtrasCommand: ownCommand }
      }
    };
  };
  X.navItem = function (title, endpoint) {
    return { menuNavigationItemRenderer: { text: { runs: [{ text: title }] }, navigationEndpoint: endpoint } };
  };

  function newMenu(id, title, subtitle, thumbnails, items) {
    return {
      contentId: id,
      thumbnail: { thumbnails: thumbnails },
      title: text(title || ''),
      subtitle: text(subtitle || ''),
      menu: { menuRenderer: { items: items || [] } }
    };
  }

  // Shared by video and channel tiles: a tileRenderer with its long-press menu.
  function makeTile(o) {
    var thumbs = o.thumbnails;
    return {
      tileRenderer: {
        style: o.style || 'TILE_STYLE_YTLR_DEFAULT',
        header: { tileHeaderRenderer: { thumbnail: { thumbnails: thumbs }, thumbnailOverlays: o.overlays || [] } },
        metadata: { tileMetadataRenderer: { title: text(o.title), lines: o.lines } },
        onSelectCommand: o.onSelect,
        contentId: o.id,
        contentType: o.contentType,
        onLongPressCommand: { showMenuCommand: newMenu(o.id, o.menuTitle, o.subtitle, thumbs, o.menuItems) }
      }
    };
  }

  X.videoTile = function (spec) {
    var id = spec.id;
    var watch = { videoId: id };
    if (spec.position > 5 && !spec.live) watch.startTimeSeconds = spec.position;

    var overlays = [];
    if (spec.length && !spec.live) {
      overlays.push({ thumbnailOverlayTimeStatusRenderer: { text: text(X.duration(spec.length)), style: 'DEFAULT' } });
      var percent = spec.finished ? 100 : watch.startTimeSeconds ? Math.max(1, Math.round(100 * spec.position / spec.length)) : 0;
      if (percent > 0) overlays.push({ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: percent } });
    }

    var lines = [];
    if (spec.lines) {
      for (var i = 0; i < spec.lines.length; i++) lines.push(lineRenderer(spec.lines[i]));
    } else {
      if (spec.author) lines.push(lineRenderer([spec.author]));
      var sub = spec.sub !== undefined ? spec.sub : spec.watchedAt ? X.ago(spec.watchedAt) : undefined;
      if (sub) lines.push(lineRenderer([sub]));
    }
    return makeTile({
      id: id, style: spec.style, contentType: spec.contentType || 'TILE_CONTENT_TYPE_VIDEO',
      thumbnails: [spec.thumbnail || { url: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg', width: 320, height: 180 }],
      overlays: overlays, title: spec.title || 'Video ' + id, menuTitle: spec.title, subtitle: spec.author,
      lines: lines, onSelect: spec.onSelect || { watchEndpoint: watch }, menuItems: spec.menuItems
    });
  };

  // Channel tile (assumption A11): a tileRenderer of type CHANNEL whose OK opens the channel page.
  X.channelTile = function (spec) {
    var avatar = spec.avatar || spec.placeholder;
    if (typeof avatar === 'string') avatar = { url: avatar };
    return makeTile({
      id: spec.id, contentType: 'TILE_CONTENT_TYPE_CHANNEL', thumbnails: avatar ? [avatar] : [],
      title: spec.title || '', menuTitle: spec.title, subtitle: spec.subtitle,
      lines: spec.subtitle ? [lineRenderer([spec.subtitle])] : [], onSelect: { browseEndpoint: { browseId: spec.id } },
      menuItems: spec.menuItems
    });
  };

  // TizenTube's own shelf pass (So) applies these two settings to every shelf it sees; ours are built outside it, so mirror them.
  // Config lives in localStorage['ytaf-configuration'] (JSON). Missing/unreadable => no change (enlarge stays as before).
  X.thumbEffects = function (effects) {
    try {
      var cfg = origParse(localStorage['ytaf-configuration'] || '{}') || {};
      if (cfg.disableEnlargingThumbnails === true) effects.enlarge = false;
      if (cfg.enableShrinkingThumbnails === true) effects.shrink = true;
    } catch (e) { /* keep defaults */ }
    return effects;
  };

  // The app cannot draw a Shorts shelf (or Shorts grid) that has the "shrink" effect: the row stays empty, or, next to our
  // extra rows, shows the tiles of another shelf. TizenTube's setting "Enable Shrinked Thumbnails" sets it on every shelf,
  // so it is taken off Shorts shelves again (below, and in X.shelf). "enlarge" is harmless there and stays as configured.
  function isShortsShelf(s) {
    if (/SHORTS/.test(String(s.tvhtml5ShelfRendererType))) return true;
    var h = s.content && s.content.horizontalListRenderer, t = h && Array.isArray(h.items) && h.items[0];
    return !!(t && t.tileRenderer && t.tileRenderer.style === 'TILE_STYLE_YTLR_SHORTS');
  }
  X.unshrinkShorts = function (shelf) {
    var e = shelf && shelf.tvhtml5Style && shelf.tvhtml5Style.effects;
    if (e && e.shrink !== undefined && isShortsShelf(shelf)) { delete e.shrink; return true; }
    return false;
  };
  // TizenTube's shrink setting, cached by the raw config string (a localStorage read per response is cheap, a parse is not).
  var shrinkRaw = null, shrinkOn = false;
  function shrinkEnabled() {
    try {
      var raw = localStorage['ytaf-configuration'] || '';
      if (raw !== shrinkRaw) { shrinkRaw = raw; shrinkOn = !!raw && (origParse(raw) || {}).enableShrinkingThumbnails === true; }
    } catch (e) { shrinkOn = false; }
    return shrinkOn;
  }
  function unshrinkIn(node, depth) {
    if (!node || typeof node !== 'object' || depth > 14) return;
    if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) unshrinkIn(node[i], depth + 1); return; }
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      if (k === 'tileRenderer' || k === 'lockupViewModel') continue;
      if (k === 'shelfRenderer') X.unshrinkShorts(node[k]);
      else if (node[k] && typeof node[k] === 'object') unshrinkIn(node[k], depth + 1);
    }
  }

  X.shelf = function (title, items, opts) {
    opts = opts || {};
    var visible = opts.visible || 3;
    var shelf = {
      content: { horizontalListRenderer: { items: items, visibleItemCount: visible, collapsedItemCount: visible } },
      headerRenderer: {
        shelfHeaderRenderer: {
          avatarLockup: {
            avatarLockupRenderer: { title: { runs: [{ text: title }] }, size: 'AVATAR_LOCKUP_SIZE_SMALL' }
          }
        }
      },
      tvhtml5Style: { effects: X.thumbEffects({ enlarge: true }) }
    };
    if (opts.shorts) shelf.tvhtml5ShelfRendererType = 'TVHTML5_SHELF_RENDERER_TYPE_SHORTS';
    // A row that loads more as it scrolls (see X.localContinuation).
    if (opts.continuation) shelf.content.horizontalListRenderer.continuations = [{ nextContinuationData: { continuation: opts.continuation } }];
    X.unshrinkShorts(shelf);
    return { shelfRenderer: shelf };
  };

  X.messageContent = function (message) { return { messageRenderer: { text: text(message) } }; };

  X.surfacePage = function (browseId, title, content) {
    return origStringify({
      responseContext: {
        serviceTrackingParams: [{ service: 'GFEEDBACK', params: [{ key: 'browse_id', value: browseId }] }]
      },
      contents: {
        tvBrowseRenderer: {
          content: {
            tvSurfaceContentRenderer: {
              header: { tvSurfaceHeaderRenderer: { title: { runs: [{ text: title }] } } },
              content: content
            }
          }
        }
      }
    });
  };
  X.gridPage = function (browseId, title, items, emptyText) {
    return X.surfacePage(browseId, title, items && items.length
      ? { gridRenderer: { items: items } } : X.messageContent(emptyText || ''));
  };
  X.shelvesPage = function (browseId, title, shelves, emptyText) {
    return X.surfacePage(browseId, title, shelves && shelves.length
      ? { sectionListRenderer: { contents: shelves } } : X.messageContent(emptyText || ''));
  };

  // Popups (TizenTube's own shapes, see design 1.3).
  X.toastCmd = function (title, subtitle) {
    var toast = { title: text(title) };
    if (subtitle) toast.subtitle = text(subtitle);
    return { openPopupAction: { popupType: 'TOAST', popup: { overlayToastRenderer: toast } } };
  };
  X.row = function (spec) {
    var r = { title: text(spec.title) };
    if (spec.subtitle) r.subtitle = text(spec.subtitle);
    if (spec.icon) r.icon = { iconType: spec.icon };
    if (spec.secondaryIcon) r.secondaryIcon = { iconType: spec.secondaryIcon };
    r.serviceEndpoint = { commandExecutorCommand: { commands: spec.commands || [] } };
    return { compactLinkRenderer: r };
  };
  X.modalCmd = function (spec) {
    var header = { title: text(spec.title) };
    if (spec.subtitle) header.subtitle = text(spec.subtitle);
    var cmd = {
      openPopupAction: {
        popupType: 'MODAL',
        popup: {
          overlaySectionRenderer: {
            overlay: {
              overlayTwoPanelRenderer: {
                actionPanel: {
                  overlayPanelRenderer: {
                    header: { overlayPanelHeaderRenderer: header },
                    content: { overlayPanelItemListRenderer: { items: spec.rows || [], selectedIndex: spec.selectedIndex } }
                  }
                },
                backButton: { buttonRenderer: { command: { signalAction: { signal: 'POPUP_BACK' } } } }
              }
            },
            dismissalCommand: { signalAction: { signal: 'POPUP_BACK' } }
          }
        },
        uniqueId: spec.uniqueId
      }
    };
    if (spec.update) {
      cmd.openPopupAction.shouldMatchUniqueId = true;
      cmd.openPopupAction.updateAction = true;
    }
    return cmd;
  };
  X.toast = function (title, subtitle) { return X.resolveCommand(X.toastCmd(title, subtitle)); };
  X.modal = function (spec) { return X.resolveCommand(X.modalCmd(spec)); };

  // ---- Shared runtime data

  // Title, channel, length and thumbnail of videos, gathered from the tiles in YouTube's
  // responses (the player's own data has no title on TV) and from player responses.
  // Bounded: Cobalt keeps the page for days, so beyond DETAILS_CAP ids the oldest DETAILS_DROP go (insertion order).
  var DETAILS_CAP = 2000, DETAILS_DROP = 250;
  var details = X.details = Object.create(null), detailKeys = [];
  X.addDetails = function (videoId, fields) {
    var d = details[videoId];
    if (!d) {
      d = details[videoId] = {};
      detailKeys.push(videoId);
      if (detailKeys.length > DETAILS_CAP) {
        var gone = detailKeys.splice(0, DETAILS_DROP);
        for (var g = 0; g < gone.length; g++) if (gone[g] !== videoId) delete details[gone[g]];
      }
    }
    for (var k in fields) if (fields[k] !== undefined && fields[k] !== '' && fields[k] !== null) d[k] = fields[k];
  };

  // ---- Item identification (design 5.2)

  var SKIP = {
    trackingParams: 1, clickTrackingParams: 1, loggingDirectives: 1, responseContext: 1, frameworkUpdates: 1,
    streamingData: 1, playerConfig: 1, adPlacements: 1
  };
  var MAX_DEPTH = 40;

  function firstChannelId(node, depth) {
    if (!node || typeof node !== 'object' || depth > 12) return null;
    var b = node.browseEndpoint;
    if (b && typeof b.browseId === 'string' && b.browseId.indexOf('UC') === 0) return b.browseId;
    var r, i;
    if (Array.isArray(node)) {
      for (i = 0; i < node.length; i++) if ((r = firstChannelId(node[i], depth + 1))) return r;
      return null;
    }
    for (var k in node) {
      if (SKIP[k]) continue;
      var v = node[k];
      if (v && typeof v === 'object' && (r = firstChannelId(v, depth + 1))) return r;
    }
    return null;
  }

  function idForName(name) {
    try { return X.channels && X.channels.idForName && name ? X.channels.idForName(name) || null : null; } catch (e) { return null; }
  }

  function pathGet(o) {
    for (var i = 1; i < arguments.length; i++) {
      if (o === null || o === undefined) return undefined;
      o = o[arguments[i]];
    }
    return o;
  }

  function showItems(show) {
    var mr = show && show.menu && show.menu.menuRenderer;
    return mr && Array.isArray(mr.items) ? mr.items : null;
  }

  X.itemVideo = function (item) {
    if (!item || typeof item !== 'object') return null;
    var t = item.tileRenderer, lv = item.lockupViewModel;
    var id, kind = 'other', channelId = null, title, author, show, thumbs, owner;
    if (t) {
      var sel = t.onSelectCommand || {};
      id = t.contentId || pathGet(sel, 'watchEndpoint', 'videoId') || pathGet(sel, 'reelWatchEndpoint', 'videoId') || null;
      var browse = pathGet(sel, 'browseEndpoint', 'browseId');
      if (typeof browse !== 'string') browse = '';
      if (t.style === 'TILE_STYLE_YTLR_SHORTS' || sel.reelWatchEndpoint) kind = 'short';
      else if (t.contentType === 'TILE_CONTENT_TYPE_VIDEO' || sel.watchEndpoint) kind = 'video';
      else if (t.contentType === 'TILE_CONTENT_TYPE_CHANNEL' || browse.indexOf('UC') === 0) {
        kind = 'channel';
        channelId = browse.indexOf('UC') === 0 ? browse : (typeof id === 'string' && id.indexOf('UC') === 0 ? id : null);
      } else if (t.contentType === 'TILE_CONTENT_TYPE_PLAYLIST') kind = 'playlist';
      owner = pathGet(t, 'metadata', 'tileMetadataRenderer') || {};
      title = plainText(owner.title);
      author = kind === 'channel' ? title : plainText(pathGet(owner, 'lines', 0, 'lineRenderer', 'items', 0, 'lineItemRenderer', 'text'));
      show = pathGet(t, 'onLongPressCommand', 'showMenuCommand');
    } else if (lv) {
      var ct = lv.contentType || '';
      var m = /^LOCKUP_CONTENT_TYPE_(VIDEO|SHORT|CHANNEL|PLAYLIST)$/.exec(ct);
      kind = m ? m[1].toLowerCase() : 'other';
      id = lv.contentId || null;
      owner = pathGet(lv, 'metadata', 'lockupMetadataViewModel') || {};
      title = pathGet(owner, 'title', 'content');
      author = kind === 'channel' ? title :
        pathGet(owner, 'metadata', 'contentMetadataViewModel', 'metadataRows', 0, 'metadataParts', 0, 'text', 'content');
      if (kind === 'channel' && typeof id === 'string' && id.indexOf('UC') === 0) channelId = id;
      show = pathGet(lv, 'rendererContext', 'commandContext', 'onLongPress', 'innertubeCommand', 'showMenuCommand');
    } else return null;
    var items = showItems(show);
    var guessed = false;
    if (!channelId) {
      channelId = firstChannelId(owner, 0) || (items && firstChannelId(items, 0)) ||
        (id && details[id] && details[id].channelId) || null;
      // Last resort, a guess from the display name: another channel can have the same name, so changes (block,
      // unsubscribe) resolve the owner from the video instead (channelIdGuessed).
      if (!channelId) { channelId = idForName(author); guessed = !!channelId; }
    }
    var v = { id: id, kind: kind, author: author, channelId: channelId || null, channelIdGuessed: guessed, title: title, menuItems: items };
    v.ensureMenu = function () {
      var s, srcs;
      if (t) {
        s = pathGet(t, 'onLongPressCommand', 'showMenuCommand');
        if (!s && t.onLongPressCommand) return v.menuItems; // some other long-press command: leave it alone
        srcs = pathGet(t, 'header', 'tileHeaderRenderer', 'thumbnail', 'thumbnails');
      } else {
        s = pathGet(lv, 'rendererContext', 'commandContext', 'onLongPress', 'innertubeCommand', 'showMenuCommand');
        srcs = pathGet(lv, 'contentImage', 'thumbnailViewModel', 'image', 'sources');
      }
      if (!s) {
        s = newMenu(id, title, author, srcs || (id ? [{ url: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg', width: 320, height: 180 }] : []));
        if (t) t.onLongPressCommand = { showMenuCommand: s };
        else {
          var rc = lv.rendererContext || (lv.rendererContext = {});
          var cc = rc.commandContext || (rc.commandContext = {});
          var ol = cc.onLongPress || (cc.onLongPress = {});
          (ol.innertubeCommand || (ol.innertubeCommand = {})).showMenuCommand = s;
        }
      }
      var mr = (s.menu || (s.menu = {})).menuRenderer || (s.menu.menuRenderer = {});
      return (v.menuItems = Array.isArray(mr.items) ? mr.items : (mr.items = []));
    };
    return v;
  };

  // ---- Response classification

  X.browseIdOf = function (response) {
    var params = response.responseContext && response.responseContext.serviceTrackingParams || [];
    for (var i = 0; i < params.length; i++) {
      var p = params[i] && params[i].params || [];
      for (var j = 0; j < p.length; j++) if (p[j] && p[j].key === 'browse_id') return p[j].value;
    }
    return null;
  };

  function info(r, raw) {
    var c = r.contents, kind = 'other';
    if (r.videoDetails) kind = 'player';
    else if (r.items && r.items[0] && r.items[0].guideSectionRenderer) kind = 'guide';
    else if (c && c.tvBrowseRenderer) kind = 'browse';
    else if (c && c.singleColumnWatchNextResults) kind = 'next';
    else if (c && c.sectionListRenderer) kind = 'search';
    else if (r.continuationContents || r.onResponseReceivedActions) kind = 'continuation';
    else if (Array.isArray(r.entries)) kind = 'reel';
    else if (r.overlay && r.overlay.reelPlayerOverlayRenderer) kind = 'reelOverlay';
    var browseId = X.browseIdOf(r);
    return {
      kind: kind,
      browseId: browseId,
      raw: raw,
      hasTiles: typeof raw === 'string' && (raw.indexOf('"tileRenderer"') !== -1 || raw.indexOf('"lockupViewModel"') !== -1),
      isLocal: typeof browseId === 'string' && browseId.indexOf('FEtizentube_') === 0
    };
  }
  X.info = info;

  // ---- Walker

  // Every array that holds a tile (tileRenderer/lockupViewModel), in document order, as
  // {items, ctx:{parentKey, parent, info}, entry}. `entry` is the path to the root, for clean-up.
  function walk(root, inf) {
    var out = [];
    if (!root || typeof root !== 'object') return out;
    var stack = [{ node: root, key: null, up: null, depth: 0, parentKey: null, parent: null }];
    while (stack.length) {
      var cur = stack.pop(), node = cur.node, i, kids = [];
      if (cur.depth > MAX_DEPTH) continue;
      if (Array.isArray(node)) {
        var tiles = false;
        for (i = 0; i < node.length; i++) {
          var e = node[i];
          if (!e || typeof e !== 'object') continue;
          if (e.tileRenderer || e.lockupViewModel) tiles = true;
          else kids.push({ node: e, key: null, up: cur, depth: cur.depth + 1, parentKey: cur.parentKey, parent: cur.parent });
        }
        if (tiles) out.push({ items: node, ctx: { parentKey: cur.parentKey, parent: cur.parent, info: inf }, entry: cur });
      } else {
        for (var k in node) {
          if (SKIP[k] || k === 'tileRenderer' || k === 'lockupViewModel') continue;
          var v = node[k];
          if (v && typeof v === 'object') kids.push({ node: v, key: k, up: cur, depth: cur.depth + 1, parentKey: k, parent: node });
        }
      }
      for (i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
  }

  // Structural clean-up after the filter phase: only for item arrays that were shortened (rec.before)
  // and ended up empty.
  function removeWrapper(wrapper, inf) {
    var arr = wrapper.up && wrapper.up.node;
    if (!Array.isArray(arr)) return;
    var i = arr.indexOf(wrapper.node);
    if (i === -1) return;
    arr.splice(i, 1);
    // An itemSectionRenderer whose contents were shelves, all removed now.
    var ae = wrapper.up;
    if (!arr.length && ae.key === 'contents' && ae.up && ae.up.up) {
      if (ae.up.key === 'itemSectionRenderer') removeWrapper(ae.up.up, inf);
      else if (ae.up.key === 'sectionListRenderer' && inf && inf.isLocal) emptyToMessage(ae.up, 'sectionListRenderer');
    }
  }
  function emptyToMessage(entry, key) {
    var holder = entry.up.node;
    delete holder[key];
    holder.messageRenderer = { text: text('Nothing to show.') };
  }
  function cleanup(recs, inf) {
    for (var n = 0; n < recs.length; n++) {
      var rec = recs[n];
      if (rec.before === undefined || rec.items.length >= rec.before || rec.items.length) continue;
      var e = rec.entry, hl = e.up;
      if (!hl) continue;
      if (e.key === 'items' && hl.key === 'horizontalListRenderer' && hl.up && hl.up.key === 'content' &&
        hl.up.up && hl.up.up.key === 'shelfRenderer' && hl.up.up.up) {
        removeWrapper(hl.up.up.up, inf);
      } else if (e.key === 'contents' && hl.key === 'itemSectionRenderer' && hl.up) {
        removeWrapper(hl.up, inf);
      } else if (e.key === 'items' && hl.key === 'gridRenderer' && inf && inf.isLocal && hl.up) {
        emptyToMessage(hl, 'gridRenderer');
      }
    }
  }

  // ---- Pipeline (single JSON.parse hook)

  var PHASES = ['harvest', 'mutate', 'filter'];
  var respHandlers = { harvest: [], mutate: [], filter: [] };
  var itemHandlers = { harvest: [], mutate: [], filter: [] };
  function addHandler(table, phase, fn) {
    if (!table[phase]) throw new Error('unknown phase ' + phase);
    table[phase].push(fn);
  }
  X.onResponse = function (phase, fn) { addHandler(respHandlers, phase, fn); };
  X.onItems = function (phase, fn) { addHandler(itemHandlers, phase, fn); };

  function processResponse(r, raw) {
    var inf = info(r, raw);
    if (inf.kind === 'other') return;
    if (DEV && inf.kind === 'browse') log({ browse: inf.browseId, hash: location.hash });
    for (var p = 0; p < PHASES.length; p++) {
      var phase = PHASES[p];
      if (inf.kind === 'player' && phase !== 'harvest') break;
      if (phase === 'mutate' && inf.kind === 'guide') {
        try { applyGuideEntries(r); } catch (e) { errLog('guide', e); }
      }
      callAll(respHandlers[phase], [r, inf], phase);
      if (inf.kind === 'player' || !inf.hasTiles || !itemHandlers[phase].length) continue;
      var recs = walk(r, inf), i;
      if (phase === 'filter') for (i = 0; i < recs.length; i++) recs[i].before = recs[i].items.length;
      for (i = 0; i < recs.length; i++) callAll(itemHandlers[phase], [recs[i].items, recs[i].ctx], phase);
      if (phase === 'filter') cleanup(recs, inf);
    }
  }

  function parseWrapper() {
    var r = origParse.apply(this, arguments); // the original's own errors propagate as before
    try {
      if (r && typeof r === 'object') processResponse(r, arguments[0]);
    } catch (e) {
      log({ parseError: String(e), stack: String(e && e.stack).slice(0, 400) });
    }
    return r;
  }
  X.parse = parseWrapper;
  JSON.parse = parseWrapper;

  // TizenTube's shelf pass has run by now (we wrap its JSON.parse); undo its shrink on Shorts shelves.
  X.onResponse('mutate', function (r, inf) {
    if (inf.kind !== 'browse' && inf.kind !== 'continuation') return;
    if (typeof inf.raw === 'string' && inf.raw.indexOf('SHORTS') === -1) return;
    if (!shrinkEnabled()) return;
    unshrinkIn(r, 0);
  });

  // Built-in harvest handlers, registered first so features' handlers see their results.
  X.onResponse('harvest', function (r, inf) {
    if (inf.kind !== 'player' || !r.videoDetails.videoId) return;
    var vd = r.videoDetails;
    var thumbs = (vd.thumbnail && vd.thumbnail.thumbnails) || [];
    var thumb = null;
    for (var i = 0; i < thumbs.length; i++) {
      if (thumbs[i].width <= 640 && (!thumb || thumbs[i].width > thumb.width)) thumb = thumbs[i];
    }
    X.addDetails(vd.videoId, {
      title: vd.title,
      author: vd.author,
      channelId: vd.channelId,
      length: Number(vd.lengthSeconds) || undefined,
      live: !!vd.isLive || !!vd.isLiveContent && !Number(vd.lengthSeconds),
      // Tile thumbnails are 16:9; the player's are often 4:3 with black bars.
      thumbnail: details[vd.videoId] && details[vd.videoId].thumbnail ? undefined : thumb
    });
  });
  X.onItems('harvest', function (items) {
    for (var i = 0; i < items.length; i++) {
      var t = items[i] && items[i].tileRenderer;
      if (!t || t.contentType !== 'TILE_CONTENT_TYPE_VIDEO' || !t.contentId) continue;
      var meta = t.metadata && t.metadata.tileMetadataRenderer || {};
      var firstLine = meta.lines && meta.lines[0] && meta.lines[0].lineRenderer;
      var thumbs = t.header && t.header.tileHeaderRenderer && t.header.tileHeaderRenderer.thumbnail;
      var thumb = thumbs && thumbs.thumbnails && thumbs.thumbnails[thumbs.thumbnails.length - 1];
      X.addDetails(t.contentId, {
        title: plainText(meta.title),
        author: firstLine && firstLine.items && firstLine.items[0] && plainText(firstLine.items[0].lineItemRenderer.text),
        thumbnail: thumb && thumb.url && thumb.url.indexOf('/vi/') !== -1 ? { url: thumb.url, width: thumb.width, height: thumb.height } : undefined
      });
    }
  });

  // ---- Retrying installs

  // Runs fn (returns true when installed) every 50 ms until it succeeds (500 ms after 30 s; stops at
  // `giveUp` tries if given), then again at 5/10/20/40/80 s: other scripts wrap over us later.
  function keepInstalled(fn, giveUp) {
    var done = false, tries = 0;
    function attempt() {
      var ok = false;
      try { ok = fn(); } catch (e) { errLog('install', e); }
      if (ok) {
        if (!done) {
          done = true;
          [5000, 10000, 20000, 40000, 80000].forEach(function (ms) { setTimeout(attempt, ms); });
        }
      } else if (!done && !(giveUp && tries >= giveUp)) {
        tries++;
        setTimeout(attempt, tries < 600 ? 50 : 500);
      }
    }
    attempt();
  }

  // TizenTube also copies its JSON.parse into window._yttv[k].JSON; mirror that for ours.
  function copyParse() {
    var ok = false;
    for (var key in window._yttv) {
      var entry = window._yttv[key];
      if (!entry || !entry.JSON || !entry.JSON.parse) continue;
      if (entry.JSON.parse === origParse) entry.JSON.parse = parseWrapper;
      if (entry.JSON.parse === parseWrapper) ok = true;
    }
    return ok;
  }
  keepInstalled(copyParse, 600);

  // ---- Local pages (design 2.4)

  var localPages = {};
  X.localPage = function (browseId, provider) { localPages[browseId] = provider; };
  // Continuations of our own rows: a row built with a continuation token "ttx<name>.<rest>" makes the app ask for more
  // when it scrolls near the end; provider(rest, respond) answers with X.listContinuation(...).
  var localConts = {};
  X.localContinuation = function (name, provider) { localConts[name] = provider; };
  X.listContinuation = function (items, token) {
    var c = { items: items };
    if (token) c.continuations = [{ nextContinuationData: { continuation: token } }];
    return { responseContext: {}, continuationContents: { horizontalListContinuation: c } };
  };

  function answerLocally(xhr, body) {
    var values = {
      readyState: 4, status: 200, statusText: 'OK',
      responseText: body, response: body, responseURL: xhr.__tizentubeExtrasUrl
    };
    Object.keys(values).forEach(function (k) {
      Object.defineProperty(xhr, k, { configurable: true, get: function () { return values[k]; } });
    });
    xhr.getResponseHeader = function (name) {
      return /^content-type$/i.test(name) ? 'application/json; charset=UTF-8' : null;
    };
    xhr.getAllResponseHeaders = function () {
      return 'content-type: application/json; charset=UTF-8\r\n';
    };
    var ticket = xhr.__ttxTicket;
    setTimeout(function () {
      ['readystatechange', 'load', 'loadend'].forEach(function (type) {
        if (xhr.__ttxTicket === ticket) xhr.dispatchEvent(new Event(type));
      });
    }, 0);
  }
  var LOCAL_PROPS = ['readyState', 'status', 'statusText', 'responseText', 'response', 'responseURL', 'getResponseHeader', 'getAllResponseHeaders'];
  // A request that is aborted or reopened gets no local answer (any more), and loses one it had.
  function dropLocal(xhr) {
    if (!xhr.__ttxTicket) return;
    xhr.__ttxTicket = null;
    for (var i = 0; i < LOCAL_PROPS.length; i++) { try { delete xhr[LOCAL_PROPS[i]]; } catch (e) {} }
  }

  function serveLocal(xhr, id, provider, body, fallback) {
    var answered = false, timer = null, ticket = {};
    xhr.__ttxTicket = ticket;
    function answer(json) {
      if (answered) return;
      answered = true;
      if (timer !== null) clearTimeout(timer);
      if (xhr.__ttxTicket !== ticket) return;
      try { answerLocally(xhr, typeof json === 'string' ? json : origStringify(json)); } catch (e) { errLog('answerLocally', e); }
    }
    function failed() { answer(fallback ? fallback() : X.surfacePage(id, '', X.messageContent('Could not load.'))); }
    timer = setTimeout(function () { timer = null; failed(); }, 8000);
    try { provider(body, answer); } catch (e) { errLog('localPage ' + id, e); if (fallback) answer(X.listContinuation([], null)); else failed(); }
  }

  var xhrLink = document.createElement('a');
  var xhrOpen = XMLHttpRequest.prototype.open;
  var xhrSend = XMLHttpRequest.prototype.send;
  var xhrAbort = XMLHttpRequest.prototype.abort;
  XMLHttpRequest.prototype.open = function (method, url) {
    dropLocal(this);
    xhrLink.href = String(url);
    this.__tizentubeExtrasUrl = xhrLink.href.split('#')[0];
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.abort = function () {
    dropLocal(this);
    return xhrAbort.apply(this, arguments);
  };
  // Only YouTube's own browse endpoint (same origin), with the request's top-level fields.
  function browseRequest(url) {
    return url.indexOf(location.origin + '/') === 0 && /^\/youtubei\/v1\/browse(\?|$)/.test(url.slice(location.origin.length));
  }
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    var url = String(xhr.__tizentubeExtrasUrl || '');
    if (browseRequest(url) && typeof body === 'string') {
      var req = null;
      try { req = origParse(body); } catch (e) {}
      var bid = req && typeof req.browseId === 'string' ? req.browseId : '';
      if (/^FEtizentube_[a-z_]+$/.test(bid) && hasOwn(localPages, bid)) {
        serveLocal(xhr, bid, localPages[bid], body);
        return;
      }
      var cm = req && typeof req.continuation === 'string' ? /^ttx([a-z]+)\.(.*)$/.exec(req.continuation) : null;
      if (cm && hasOwn(localConts, cm[1])) {
        var name = cm[1], rest = cm[2];
        // Past the deadline the row asks again later (same token): slow loading must not end it.
        serveLocal(xhr, 'ttx' + name, function (b, respond) { localConts[name](rest, respond); }, body,
          function () { return X.listContinuation([], 'ttx' + name + '.' + rest); });
        return;
      }
      if (DEV) {
        xhr.addEventListener('loadend', function () {
          log({ xhrBrowse: bid, status: xhr.status, type: xhr.responseType, url: url.slice(0, 120),
            body: xhr.status !== 200 && (xhr.responseType === '' || xhr.responseType === 'text') ? String(xhr.responseText).slice(0, 400) : undefined });
        });
      }
    }
    return xhrSend.apply(this, arguments);
  };

  // ---- Guide entries (design 2.5)

  var guideEntries = [];
  X.guideEntry = function (spec) { guideEntries.push(spec); };

  function guideId(it) {
    var e = it && it.guideEntryRenderer;
    return e && e.navigationEndpoint && e.navigationEndpoint.browseEndpoint && e.navigationEndpoint.browseEndpoint.browseId;
  }
  function indexOfGuide(items, id) {
    for (var i = 0; i < items.length; i++) if (guideId(items[i]) === id) return i;
    return -1;
  }
  function applyGuideEntries(r) {
    var items = r.items[0].guideSectionRenderer.items;
    if (!Array.isArray(items)) return;
    if (DEV) log({ guide: items.map(function (it) {
      var e = it.guideEntryRenderer || {};
      return [plainText(e.formattedTitle), guideId(it), e.icon && e.icon.iconType].join(' | ');
    }) });
    for (var n = 0; n < guideEntries.length; n++) {
      var spec = guideEntries[n];
      try {
        if (spec.when && !spec.when()) continue;
        if (indexOfGuide(items, spec.browseId) !== -1) continue;
        var at = spec.replace ? indexOfGuide(items, spec.replace) : -1;
        if (at !== -1) {
          var entry = items[at].guideEntryRenderer;
          entry.navigationEndpoint.browseEndpoint.browseId = spec.browseId;
          entry.__ttx = spec.browseId;
          continue;
        }
        var after = -1;
        for (var a = 0; spec.after && a < spec.after.length && after === -1; a++) after = indexOfGuide(items, spec.after[a]);
        items.splice(after >= 0 ? after + 1 : Math.min(2, items.length), 0, {
          guideEntryRenderer: {
            navigationEndpoint: { browseEndpoint: { browseId: spec.browseId } },
            formattedTitle: text(spec.title),
            icon: { iconType: spec.iconType }
          }
        });
      } catch (e) { errLog('guideEntry ' + spec.browseId, e); }
    }
  }

  // ---- Commands (design 2.6)

  var commandHandlers = {};
  var anyHandlers = [];
  X.onCommand = function (key, fn) { (commandHandlers[key] || (commandHandlers[key] = [])).push(fn); };
  X.onAnyCommand = function (fn) { anyHandlers.push(fn); };

  function dispatchOwn(cmd) {
    var c = cmd.tizentubeExtrasCommand || cmd.tizentubeExtrasGuestCommand;
    if (c && typeof c === 'object') {
      for (var key in c) {
        if (hasOwn(commandHandlers, key)) callAll(commandHandlers[key], [c[key], cmd], 'command ' + key);
      }
    }
    return true;
  }

  function findInstance() {
    for (var key in window._yttv) {
      var entry = window._yttv[key];
      if (entry && entry.instance && typeof entry.instance.resolveCommand === 'function') return entry.instance;
    }
    return null;
  }
  X.resolveCommand = function (cmd) {
    if (cmd && (cmd.tizentubeExtrasCommand || cmd.tizentubeExtrasGuestCommand)) return dispatchOwn(cmd);
    var instance = findInstance();
    return instance ? instance.resolveCommand(cmd) : undefined;
  };

  var topWrapper = null, topState = null;
  function patchResolveCommand() {
    for (var key in window._yttv) {
      var entry = window._yttv[key];
      if (!entry || !entry.instance || !entry.instance.resolveCommand) continue;
      var instance = entry.instance;
      // Ours is recognised by identity (other scripts copy function properties onto their own wrappers).
      if (instance.resolveCommand === topWrapper) return true;
      var original = instance.resolveCommand;
      // Re-wrapping (another script wrapped over ours): the older copy, still further down the chain, becomes a
      // pure pass-through, so the handlers run once per command.
      var state = { retired: false };
      var patched = function (cmd) {
        if (state.retired) return original.apply(this, arguments);
        var args = Array.prototype.slice.call(arguments);
        if (cmd && cmd.reelWatchEndpoint) lastReelCmd = X.now();
        for (var i = 0; i < anyHandlers.length; i++) {
          var res;
          try { res = anyHandlers[i](cmd); } catch (e) { errLog('anyCommand', e); }
          if (res && res.handled) return true;
          if (res && res.replace) { cmd = res.replace; args[0] = cmd; }
        }
        if (cmd && (cmd.tizentubeExtrasCommand || cmd.tizentubeExtrasGuestCommand)) return dispatchOwn(cmd); // never pass ours down
        if (cmd && cmd.openPopupAction && cmd.openPopupAction.uniqueId === 'tt-settings') {
          try { insertSettingsRows(cmd.openPopupAction); } catch (e) { errLog('settingsRows', e); }
        }
        return original.apply(this, args);
      };
      for (var k in original) {
        if (hasOwn(original, k) && !(k in patched)) patched[k] = original[k];
      }
      instance.resolveCommand = patched;
      if (topState) topState.retired = true;
      topWrapper = patched;
      topState = state;
      return true;
    }
    return false;
  }
  keepInstalled(patchResolveCommand, 840); // ~30 s at 50 ms, then ~2 min at 500 ms

  // ---- Settings rows (design 2.6)

  var settingsRows = [];
  var pendingSelect = null;
  var ROW_INDEX = 2; // in TizenTube's settings list, before "Ad block"

  X.settingsRow = function (id, builder, index) {
    for (var i = 0; i < settingsRows.length; i++) {
      if (settingsRows[i].id === id) { settingsRows[i] = { id: id, builder: builder, index: index }; return; }
    }
    settingsRows.push({ id: id, builder: builder, index: index });
  };

  function isOwnRow(item) {
    try {
      var c = item.compactLinkRenderer.serviceEndpoint.commandExecutorCommand.commands[0];
      return !!(c.tizentubeExtrasCommand || c.tizentubeExtrasGuestCommand);
    } catch (e) { return false; }
  }

  function insertSettingsRows(action) {
    var list = action.popup.overlaySectionRenderer.overlay.overlayTwoPanelRenderer.actionPanel
      .overlayPanelRenderer.content.overlayPanelItemListRenderer;
    var items = list.items, i;
    var numeric = typeof list.selectedIndex === 'number';
    for (i = items.length - 1; i >= 0; i--) { // stale rows of ours from an earlier pass
      if (!isOwnRow(items[i])) continue;
      items.splice(i, 1);
      if (numeric && list.selectedIndex > i) list.selectedIndex--;
    }
    var selectNode = null, pos = ROW_INDEX;
    for (i = 0; i < settingsRows.length; i++) {
      var def = settingsRows[i], row;
      try { row = def.builder(); } catch (e) { errLog('settingsRow ' + def.id, e); continue; }
      if (!row) continue;
      var at = Math.min(def.index === undefined || def.index === null ? pos : def.index, items.length);
      items.splice(at, 0, row);
      if (def.index === undefined || def.index === null) pos = at + 1;
      if (numeric && list.selectedIndex >= at) list.selectedIndex++; // TizenTube counts its own rows only
      if (pendingSelect !== null && def.id === pendingSelect) selectNode = row;
    }
    if (selectNode) list.selectedIndex = items.indexOf(selectNode);
  }

  // Re-issues TizenTube's SETTINGS_UPDATE so its popup rebuilds in place (through our wrapper, which
  // adds our rows again); the row named by selectRowId keeps the selection.
  X.refreshSettings = function (selectRowId) {
    pendingSelect = selectRowId === undefined ? null : selectRowId;
    try {
      X.resolveCommand({ customAction: { action: 'SETTINGS_UPDATE', parameters: [ROW_INDEX] } });
    } finally {
      pendingSelect = null;
    }
  };

  // ---- Test hooks

  X.test = {
    common: {
      info: info, walk: walk, itemVideo: X.itemVideo, videoTile: X.videoTile, shelf: X.shelf,
      parseAgo: X.parseAgo, ago: X.ago, duration: X.duration, insertSettingsRows: insertSettingsRows,
      applyGuideEntries: applyGuideEntries, cleanup: cleanup, dispatchOwn: dispatchOwn,
      patchResolveCommand: patchResolveCommand, copyParse: copyParse, answerLocally: answerLocally,
      guideEntries: guideEntries, settingsRows: settingsRows
    }
  };

  log({ ttxLoaded: location.href });
})();
