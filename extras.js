// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TT Extras contributors. See LICENSE.
// TizenTube extras, loaded after TizenTube's own userscript (see loader.js):
//  - optionally (settings row, off by default) the YouTube wordmark is swapped for the YouTube
//    Premium one, so the app is easy to tell apart from official YouTube. The image is Google's
//    own, loaded from its URL; it is not copied into this project;
//  - local watch history on the History page and in Home's "Recently watched" row.
(function () {
    if (location.hostname !== 'www.youtube.com') return;
    if (window.__tizentubeExtras) return;
    window.__tizentubeExtras = true;

    var X = window.__ttx;
    if (!X) return;
    var log = X.log;

    // ---------------------------------------------------------------- Premium wordmark

    var PREMIUM_WORDMARK = 'https://www.gstatic.com/youtube/img/branding/livingroom/premium/wordmark_truncated/fullcolor_white_57_2x_v2.png';
    // The wordmark is a background image set inline on the logo's thumbnail element. Scripts may
    // not add <style> elements (CSP), so the rule goes into the page's own nonce'd stylesheet,
    // as TizenTube's theme does.
    var LOGO_CSS = '\nytlr-thumbnail-details[style*="branding/livingroom/youtube/wordmark"] {' +
        ' background-image: url("' + PREMIUM_WORDMARK + '") !important;' +
        ' background-size: contain !important; background-repeat: no-repeat !important;' +
        ' background-position: right center !important; }\n';

    function logoOn() { return X.settings.get('premiumLogo') === true; }

    var logoTimer = null;
    function applyLogoCss() {
        clearTimeout(logoTimer);
        logoTimer = null;
        var style = document.querySelector('style[nonce]');
        if (!style) { if (logoOn()) logoTimer = setTimeout(applyLogoCss, 250); return; }
        var has = style.textContent.indexOf(PREMIUM_WORDMARK) !== -1;
        if (logoOn() && !has) style.textContent += LOGO_CSS;
        else if (!logoOn() && has) style.textContent = style.textContent.split(LOGO_CSS).join('');
    }
    applyLogoCss();

    X.settingsRow('premiumLogo', function () {
        return X.row({
            title: 'YouTube Premium logo',
            subtitle: 'Show the Premium wordmark instead of the YouTube one',
            icon: 'PERSON',
            secondaryIcon: logoOn() ? 'CHECK_BOX' : 'CHECK_BOX_OUTLINE_BLANK',
            commands: [{ tizentubeExtrasCommand: { togglePremiumLogo: true } }]
        });
    });

    X.onCommand('togglePremiumLogo', function () {
        X.settings.set('premiumLogo', !logoOn());
        X.refreshSettings('premiumLogo');
        applyLogoCss();
    });

    // ---------------------------------------------------------------- History storage

    var HISTORY_KEY = 'tizentube-extras-history';
    var MAX_ENTRIES = 200;
    var SHELF_ITEMS = 25;
    // Not YouTube's own 'FEhistory': the app treats that ID as a detail page (its "hsa" set), which
    // collapses the sidebar and moves focus into the page as soon as the entry is highlighted.
    var HISTORY_BROWSE_ID = 'FEtizentube_history';

    function loadHistory() {
        return X.loadJson(HISTORY_KEY, [], function (list) {
            return Array.isArray(list) ? list.filter(function (e) { return e && typeof e === 'object' && typeof e.id === 'string'; }) : null;
        });
    }

    function saveHistory(list) {
        if (X.saveJson(HISTORY_KEY, list.slice(0, MAX_ENTRIES))) historyRevision++;
    }

    function remember(videoId, fields) {
        var list = loadHistory();
        var index = -1;
        for (var i = 0; i < list.length; i++) if (list[i].id === videoId) { index = i; break; }
        var entry = index >= 0 ? list.splice(index, 1)[0] : { id: videoId };
        for (var k in fields) if (fields[k] !== undefined && fields[k] !== '') entry[k] = fields[k];
        list.unshift(entry);
        saveHistory(list);
        return entry;
    }

    function updatePosition(videoId, seconds, length) {
        var list = loadHistory();
        for (var i = 0; i < list.length; i++) {
            if (list[i].id !== videoId) continue;
            list[i].length = list[i].length || length;
            // While a video loads (before it seeks to where it left off) the player reports 0:00.
            if (seconds < 5) return;
            // Close to the end counts as finished: start from the beginning next time. The margin
            // is at most a tenth of the length, so short clips are not finished from the start.
            var len = list[i].length;
            var done = len && seconds > len - Math.min(len * 0.1, Math.max(20, len * 0.03));
            list[i].position = done ? 0 : Math.floor(seconds);
            list[i].finished = !!done;
            log({ position: videoId, seconds: seconds, length: list[i].length, finished: !!done });
            saveHistory(list);
            return;
        }
    }

    function removeFromHistory(videoId) {
        saveHistory(loadHistory().filter(function (e) { return e.id !== videoId; }));
    }

    // ---------------------------------------------------------------- Recording what is watched

    var current = null; // { id, live }

    // The player element is looked up again on every tick, so a replaced player is followed and the old
    // one is not kept.
    var player = null, hookTries = 0;
    function onStateChange() {
        try {
            var state = player.getPlayerStateObject();
            var data = player.getVideoData();
            // Previews on focused tiles play in the same player; only count the watch page.
            if (!data || !data.video_id || !X.isWatch()) return;
            if (data.title) X.addDetails(data.video_id, { title: data.title, author: data.author });
            if (state.isPlaying) {
                if (!current || current.id !== data.video_id) {
                    var d = X.details[data.video_id] || {};
                    var entry = remember(data.video_id, {
                        title: d.title || data.title,
                        author: d.author || data.author,
                        length: d.length || Math.round(player.getDuration ? player.getDuration() : 0) || undefined,
                        thumbnail: d.thumbnail,
                        live: d.live || data.isLive,
                        watchedAt: X.now()
                    });
                    current = { id: data.video_id, live: !!entry.live, named: !!entry.title };
                    log({ recorded: entry });
                }
            } else if (current && current.id === data.video_id && !current.live) {
                updatePosition(current.id, player.getCurrentTime(), Math.round(player.getDuration()));
            }
            // The title may only become known after playback started.
            if (current && current.id === data.video_id && !current.named && X.details[current.id] && X.details[current.id].title) {
                remember(current.id, X.details[current.id]);
                current.named = true;
            }
        } catch (e) {
            log({ playerError: String(e), stack: String(e.stack).slice(0, 400) });
        }
    }
    function attach(p) {
        if (player) { try { player.removeEventListener('onStateChange', onStateChange); } catch (e) {} }
        player = p;
        if (player) player.addEventListener('onStateChange', onStateChange);
    }
    function findPlayer() {
        var p = document.querySelector('.html5-video-player');
        return p && p.getVideoData ? p : null;
    }
    function hookPlayer() {
        var p = findPlayer();
        // Every 0.5 s for the first minute, then every 5 s (the player can appear late, e.g. after a long idle start).
        if (!p) return setTimeout(hookPlayer, ++hookTries < 120 ? 500 : 5000);
        attach(p);
        setInterval(function () {
            var p2 = findPlayer();
            if (p2 !== player) attach(p2); // a new player, or none: the old one is let go
            if (!player) return;
            try {
                if (!current || current.live || !X.isWatch()) return;
                var data = player.getVideoData();
                if (data && data.video_id === current.id && player.getPlayerStateObject().isPlaying) {
                    updatePosition(current.id, player.getCurrentTime(), Math.round(player.getDuration()));
                }
            } catch (e) {}
        }, 10000);
    }
    hookPlayer();

    function onHashChange(e) {
        if (current && e.oldURL.indexOf('#/watch') !== -1 && !X.isWatch()) {
            // Leaving the watch page: keep the position the 10 s timer has not saved yet. BACK usually
            // stops the player first (saved by the state change above); by now it may already have
            // reset to 0:00 or moved on to another video, so only trust it if it still has this one.
            try {
                var player = document.querySelector('.html5-video-player');
                var data = player && player.getVideoData && player.getVideoData();
                if (!current.live && data && data.video_id === current.id) {
                    var time = player.getCurrentTime(), length = Math.round(player.getDuration());
                    if (time >= 5 && length && time <= length + 1) updatePosition(current.id, time, length);
                }
            } catch (err) {}
            current = null;
        }
        clearTimeout(reloadTimer);
        reloadTimer = null;
        navigated = true;
        // Back from a video the page stays as it was, focus on the tile you came from (a reload would put it on the
        // first row): Recently watched / History catch up on the next visit from another page, or on Refresh.
        if (e.oldURL.indexOf('#/watch') === -1) maybeReloadHome();
    }

    window.addEventListener('hashchange', function (e) {
        try { onHashChange(e); } catch (err) { log({ hashchangeError: String(err) }); }
    });

    // ---------------------------------------------------------------- The Home row

    var historyRevision = 0, homeRevision = null, pageRevision = null;

    function isHistoryPage() {
        return X.isPage(HISTORY_BROWSE_ID);
    }

    // Pages are kept in memory, so after watching something, going back to Home or History would
    // show them as they were: reload them when one is opened from another page (not when backing out of the
    // video, see onHashChange). Never under the Shorts player, whose hash is Home's '#/' (X.onShortsPage):
    // each surface catches up when it renders again.
    var reloadTimer = null;
    function reloadDue() {
        var revision = X.isHome() ? homeRevision : isHistoryPage() ? pageRevision : null;
        return revision !== null && revision !== historyRevision && !X.onShortsPage();
    }
    function maybeReloadHome() {
        if (reloadTimer !== null || !reloadDue()) return;
        reloadTimer = setTimeout(function () {
            reloadTimer = null;
            if (!reloadDue()) return;
            keepHomeFeed();
            X.resolveCommand(RELOAD);
        }, 300);
    }

    // ---------------------------------------------------------------- Home: keep the feed that is on screen

    // The app asks for Home before TizenTube or we are loaded (on the TV the first browse ends ~1.6 s after start, loader.js
    // starts ~1.5 s), so that first, fresh feed is drawn as YouTube sent it. TizenTube's "Reload Home on Startup" (on by
    // default) then sends SOFT_RELOAD_PAGE, and the reloaded response, the first one we can add our rows to, carries another,
    // mostly stale set of videos. The same happens on our own reloads (after watching, removing, blocking). So such a
    // response gets the shelves (and the continuation for scrolling) of the feed on screen, read from the app's data of the
    // drawn <ytlr-tv-surface-content-renderer>. Startup: that data never passed TizenTube's JSON.parse, so it is put through
    // it once (ad filter, shelf styling). Our reloads: it already has, and our own rows are taken out to be built afresh.
    // Anything unexpected (no single drawn list, too few shelves, an error) leaves YouTube's response as it is.
    var RELOAD = { signalAction: { signal: 'SOFT_RELOAD_PAGE' } };
    var START_MS = 20000, KEEP_MS = 10000, OUR_ROW = 'ttxHomeRow';
    var loadedAt = X.now(), firstHome = true, navigated = false, homeContSeen = false, keepAt = 0;

    function keepHomeFeed() { if (X.isHome()) keepAt = X.now(); }
    X.keepHomeFeed = keepHomeFeed; // block.js: its reloads on Home keep the feed too

    function isHomeId(id) { return id === 'FEtopics' || id === 'FEwhat_to_watch'; }
    // The surface (holder of content.sectionListRenderer) of a Home browse, or of the answer to Home's Refresh tile,
    // which comes as continuationContents.tvSurfaceContentContinuation (TizenTube's JSON.parse does not handle that shape).
    function homeSurface(r, info) {
        if (!isHomeId(info.browseId) && !(!info.browseId && X.isHome())) return null;
        var s = info.kind === 'browse' ? r.contents.tvBrowseRenderer.content && r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer
            : info.kind === 'continuation' && r.continuationContents ? r.continuationContents.tvSurfaceContentContinuation : null;
        var sl = s && s.content && s.content.sectionListRenderer;
        return sl && Array.isArray(sl.contents) ? s : null;
    }
    function shelfCount(list) {
        var n = 0;
        for (var i = 0; i < list.contents.length; i++) if (list.contents[i] && list.contents[i].shelfRenderer) n++;
        return n;
    }
    // TizenTube's JSON.parse (X.origParse, below ours) only treats browse-shaped responses: wrap the list in one.
    function viaTizenTube(r, list) {
        var out = X.origParse(X.origStringify({ responseContext: r.responseContext,
            contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: { sectionListRenderer: list } } } } } }));
        return out.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer;
    }
    // The section list on screen for this target; null unless exactly one drawn surface matches.
    function shownList(targetId) {
        var els = document.getElementsByTagName('ytlr-tv-surface-content-renderer'), found = null, n = 0;
        for (var i = 0; i < els.length; i++) {
            var d = els[i].__instance && els[i].__instance.props && els[i].__instance.props.data;
            var sl = d && d.content && d.content.sectionListRenderer;
            if (!sl || !Array.isArray(sl.contents) || (targetId && d.targetId && d.targetId !== targetId)) continue;
            found = sl;
            n++;
        }
        return n === 1 ? found : null;
    }
    function keepShown(r, surface, fresh) {
        var shown = shownList(surface.targetId), why = null, list = null;
        if (!shown) why = 'no single drawn list';
        else {
            var copy = { contents: [], continuations: shown.continuations, trackingParams: shown.trackingParams };
            for (var i = 0; i < shown.contents.length; i++) {
                var c = shown.contents[i];
                if (!(c && c.shelfRenderer && c.shelfRenderer[OUR_ROW])) copy.contents.push(c);
            }
            if (shelfCount(copy) < 2) why = 'too few shelves';
            // A copy either way: our phases must not change the app's live objects.
            else list = fresh ? viaTizenTube(r, copy) : X.origParse(X.origStringify(copy));
            if (list && (!Array.isArray(list.contents) || shelfCount(list) < 2)) { list = null; why = 'bad copy'; }
        }
        log({ homeFeed: list ? 'kept' : 'new', why: why || undefined, fresh: fresh, shelves: list ? list.contents.length : undefined });
        if (list) surface.content.sectionListRenderer = list;
    }

    X.onResponse('harvest', function (r, info) {
        if (info.kind !== 'browse' && info.kind !== 'continuation') return;
        var surface = homeSurface(r, info);
        if (!surface) {
            if (info.kind === 'continuation' && isHomeId(info.browseId)) homeContSeen = true;
            return;
        }
        if (info.kind === 'continuation') { // Refresh tile: a whole new Home, still as YouTube sent it
            var list = viaTizenTube(r, surface.content.sectionListRenderer);
            if (list && Array.isArray(list.contents)) surface.content.sectionListRenderer = list;
            log({ homeFeed: 'refresh', shelves: list && list.contents && list.contents.length });
            return;
        }
        var first = firstHome, keep = keepAt && X.now() - keepAt < KEEP_MS;
        firstHome = false;
        keepAt = 0;
        if (!X.isHome() || X.onShortsPage()) return;
        if (first && !navigated && !homeContSeen && X.now() - loadedAt < START_MS) keepShown(r, surface, true);
        else if (keep) keepShown(r, surface, false);
    });

    function tile(entry) {
        // Fill in what wasn't known when the entry was recorded.
        var known = X.details[entry.id];
        if (known) {
            if (!entry.title) entry.title = known.title;
            if (!entry.author) entry.author = known.author;
            if (known.thumbnail && (!entry.thumbnail || entry.thumbnail.height * 16 !== entry.thumbnail.width * 9)) {
                entry.thumbnail = known.thumbnail;
            }
        }
        return X.videoTile({
            id: entry.id, title: entry.title, author: entry.author, thumbnail: entry.thumbnail,
            length: entry.length, position: entry.position, finished: entry.finished, live: entry.live,
            sub: X.ago(entry.watchedAt),
            menuItems: [
                X.navItem('Play from the beginning', { watchEndpoint: { videoId: entry.id } }),
                X.menuItem('Remove from history', { removeFromHistory: entry.id })
            ]
        });
    }

    function historyShelf() {
        var list = loadHistory().slice(0, SHELF_ITEMS);
        if (!list.length) return null;
        return X.shelf('Recently watched', list.map(tile));
    }

    // Our rows on Home (marked, so a kept feed can drop them before they are built afresh).
    function addHistoryShelf(surface) {
        var sections = surface.content.sectionListRenderer;
        var shelf = historyShelf();
        // Second for now; the Subscriptions row (if any) is put in front of it below, making this third.
        if (shelf) {
            shelf.shelfRenderer[OUR_ROW] = true;
            sections.contents.splice(Math.min(1, sections.contents.length), 0, shelf);
        }
        // Then the cached Subscriptions row goes second, after YouTube's first row (Recommended);
        // nothing when there is none.
        var subsShelf = null;
        try { subsShelf = X.subs && X.subs.homeShelf(); } catch (err) { log({ subsShelfError: String(err) }); }
        if (subsShelf) {
            subsShelf.shelfRenderer[OUR_ROW] = true;
            sections.contents.splice(Math.min(1, sections.contents.length), 0, subsShelf);
        }
        homeRevision = historyRevision;
    }

    // ---------------------------------------------------------------- The History page

    // Signed out, YouTube refuses its history page (401, "Something went wrong"), so that request
    // never leaves the TV: it is answered here with a grid of the local history.
    function historyPageResponse() {
        return X.gridPage(HISTORY_BROWSE_ID, 'History', loadHistory().map(tile), 'Videos you watch will show up here.');
    }

    // ---------------------------------------------------------------- Registrations

    X.onResponse('harvest', function (r, info) {
        // (X's own handler, registered before this one, has added the player's details already.)
        if (info.kind !== 'player' || !r.videoDetails.videoId) return;
        var vd = r.videoDetails;
        if (current && current.id === vd.videoId) remember(vd.videoId, X.details[vd.videoId]);
    });

    X.onResponse('mutate', function (r, info) {
        // Home is FEtopics when signed out, FEwhat_to_watch when signed in; also its Refresh tile's answer.
        if (info.kind !== 'browse' && info.kind !== 'continuation') return;
        var surface = homeSurface(r, info);
        if (surface) addHistoryShelf(surface);
    });

    // A sidebar entry for the history page, placed after Home.
    X.guideEntry({ browseId: HISTORY_BROWSE_ID, title: 'History', iconType: 'WATCH_HISTORY', after: ['FEtopics', 'FEwhat_to_watch'] });

    X.localPage(HISTORY_BROWSE_ID, function (body, respond) {
        var page = historyPageResponse();
        pageRevision = historyRevision;
        respond(page);
    });

    X.onCommand('removeFromHistory', function (id) {
        if (!id) return;
        removeFromHistory(id);
        if (X.isHome() || isHistoryPage()) {
            keepHomeFeed();
            X.resolveCommand(RELOAD);
        }
    });

    X.test.extras = {
        tile: tile, historyShelf: historyShelf, historyPageResponse: historyPageResponse,
        loadHistory: loadHistory, saveHistory: saveHistory, remember: remember, updatePosition: updatePosition,
        removeFromHistory: removeFromHistory
    };

    log({ extrasLoaded: location.href, historyEntries: loadHistory().length });
})();
