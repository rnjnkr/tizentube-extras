// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TT Extras contributors. See LICENSE.
// TT Extras refresh.js: an easy-access Home "Refresh", the same as YouTube's Refresh tile at the very bottom of Home
// (a new feed; extras.js adds our rows to its answer and puts it through TizenTube). ES5 only. Two places:
//  - Top bar: a round button left of the microphone. The bar is built by the app (no response data to add a button to),
//    so the button is drawn by CSS only (::before of <ytlr-search-bar>, shifted right to make room; nothing is added to
//    the app's DOM). Focus is virtual: LEFT on the focused mic "moves" onto it (the app keeps focus on the mic), OK
//    refreshes, RIGHT goes back to the mic, LEFT/DOWN/BACK act as from the mic. The icon is the app's own ARROW_CIRCLE
//    glyph, read from a drawn <yt-icon> (our sidebar entry); none found = no top button.
//  - Sidebar: "Refresh" right below Home. Highlighting it shows Home (on Home: nothing happens); OK refreshes.
// How a new feed is fetched: the Refresh tile runs loadReloadContinuationCommand with a token that only comes with
// Home's last page. A token seen there is used at once; otherwise the pages are fetched (X.net, up to MAX_PAGES) from
// the last continuation seen on Home until the tile appears. No token at all or a failure: SOFT_RELOAD_PAGE, which
// also brings a new (but overlapping) feed. State: two strings; listeners: keydown/keyup/keypress/hashchange, once.
(function () {
    if (location.hostname !== 'www.youtube.com') return;
    if (window.__ttxRefresh) return;
    window.__ttxRefresh = true;

    var X = window.__ttx;   // common.js, loaded first (loader.js)
    if (!X) return;
    var log = X.log;

    var MARK = 'ttxRefreshEntry';
    var ICON = 'ARROW_CIRCLE';
    var MAX_PAGES = 15;

    function isHomeId(id) { return id === 'FEtopics' || id === 'FEwhat_to_watch'; }
    function onHome() { return X.isHome() && !X.onShortsPage(); }

    // ---------------------------------------------------------------- A new feed

    var next = null;     // the last continuation token of Home's section list
    var reload = null;   // the Refresh tile's token for the feed on screen
    var busy = false;

    function nextOf(list) {
        var c = list && list.continuations;
        if (!Array.isArray(c)) return null;
        for (var i = 0; i < c.length; i++) {
            var d = c[i] && c[i].nextContinuationData;
            if (d && typeof d.continuation === 'string') return d.continuation;
        }
        return null;
    }
    // The Refresh tile's command in a section list page: {continuation, targetId} of its loadReloadContinuationCommand.
    function reloadOf(node) {
        var stack = [node], seen = 0;
        while (stack.length && seen++ < 50000) {
            var n = stack.pop();
            if (!n || typeof n !== 'object') continue;
            var c = n.loadReloadContinuationCommand;
            if (c && typeof c.continuation === 'string') return { continuation: c.continuation, targetId: c.targetId };
            for (var k in n) {
                var v = n[k];
                if (v && typeof v === 'object' && k !== 'thumbnails' && k !== 'onLongPressCommand') stack.push(v);
            }
        }
        return null;
    }
    function homeList(r, inf) {
        if (inf.kind === 'browse') {
            var s = r.contents.tvBrowseRenderer.content && r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer;
            return { list: s && s.content && s.content.sectionListRenderer, whole: true };
        }
        var cc = r.continuationContents;
        if (!cc) return null;
        if (cc.tvSurfaceContentContinuation) { // the answer to a Refresh: a whole new Home
            var t = cc.tvSurfaceContentContinuation.content;
            return { list: t && t.sectionListRenderer, whole: true };
        }
        return cc.sectionListContinuation ? { list: cc.sectionListContinuation, whole: false } : null;
    }
    // After extras.js's harvest (which may swap in the drawn feed): keep the tokens of the feed on screen.
    X.onResponse('mutate', function (r, inf) {
        if (inf.kind !== 'browse' && inf.kind !== 'continuation') return;
        // The answer to the Refresh command has no browseId (as in extras.js): taken for Home's while on Home.
        if (!isHomeId(inf.browseId) && !(!inf.browseId && onHome())) return;
        var h = homeList(r, inf);
        if (!h || !h.list) return;
        var n = nextOf(h.list);
        if (h.whole) { next = n; reload = null; if (inf.kind === 'continuation') pendingVia = null; return; }
        if (n) next = n;
        if (typeof inf.raw !== 'string' || inf.raw.indexOf('loadReloadContinuationCommand') !== -1) {
            var t = reloadOf(h.list);
            if (t) reload = t;
        }
    });

    function fallback(why, via) {
        log({ homeRefresh: 'fallback', why: why, via: via });
        X.resolveCommand({ signalAction: { signal: 'SOFT_RELOAD_PAGE' } });
    }
    // Pages after `token` until one has the Refresh tile; cb(err, reloadToken, pages).
    function walk(token, pages, cb) {
        if (pages >= MAX_PAGES) { cb('no Refresh tile in ' + pages + ' pages'); return; }
        X.net.innertube('/youtubei/v1/browse', { continuation: token }, function (err, json) {
            if (err || !json || typeof json !== 'object') { cb('net ' + (err && typeof err === 'object' ? X.origStringify(err) : err)); return; }
            var list = json.continuationContents && json.continuationContents.sectionListContinuation;
            if (!list) { cb('not a Home page'); return; }
            var t = reloadOf(list);
            if (t) { cb(null, t, pages + 1); return; }
            var n = nextOf(list);
            if (!n) { cb('last page without a Refresh tile'); return; }
            walk(n, pages + 1, cb);
        }, { timeout: 8000, group: 'homeRefresh' });
    }
    // Home's surface (<ytlr-tv-surface-content-renderer>) reloads only for a command whose targetId is its own; the tile's
    // command carries it. Without one, the drawn Home surface's targetId (named prop data.targetId) is used.
    function homeTargetId() {
        var els = document.getElementsByTagName('ytlr-tv-surface-content-renderer'), found = null, n = 0;
        for (var i = 0; i < els.length; i++) {
            var d = els[i].__instance && els[i].__instance.props && els[i].__instance.props.data;
            if (!d || typeof d.targetId !== 'string' || !/FEtopics|FEwhat_to_watch/.test(d.targetId)) continue;
            found = d.targetId;
            n++;
        }
        return n === 1 ? found : null;
    }
    var checkTimer = null, pendingVia = null;
    function issue(cmd, via, pages, ms) {
        var target = typeof cmd.targetId === 'string' ? cmd.targetId : homeTargetId();
        if (!target) { fallback('no Home targetId', via); return; }
        log({ homeRefresh: 'reload', via: via, pages: pages, ms: ms, target: target });
        pendingVia = via;
        if (checkTimer !== null) clearTimeout(checkTimer);
        // Expected: the new Home within seconds (the mutate handler above clears pendingVia); else the plain reload.
        checkTimer = setTimeout(function () {
            checkTimer = null;
            var v = pendingVia;
            pendingVia = null;
            if (v !== null && onHome()) fallback('no new feed after the reload command', v);
        }, 8000);
        X.resolveCommand({ loadReloadContinuationCommand: { continuation: cmd.continuation, targetId: target } });
    }
    function refresh(via) {
        if (busy || pendingVia !== null) { log({ homeRefresh: 'busy', via: via }); return; }
        if (!onHome()) { log({ homeRefresh: 'skipped', why: 'not on Home', via: via }); return; }
        if (reload) { issue(reload, via, 0); return; }
        if (!next || !X.net) { fallback(next ? 'no net' : 'no continuation', via); return; }
        busy = true;
        var started = X.now();
        X.toast('Refreshing Home…');
        walk(next, 0, function (err, token, pages) {
            busy = false;
            if (!onHome()) { log({ homeRefresh: 'dropped', why: 'left Home', via: via }); return; }
            if (err) { fallback(err, via); return; }
            issue(token, via, pages, X.now() - started);
        });
    }
    X.homeRefresh = refresh;

    // ---------------------------------------------------------------- Sidebar entry

    function guideBrowseId(it) {
        var e = it && it.guideEntryRenderer;
        return e && e.navigationEndpoint && e.navigationEndpoint.browseEndpoint && e.navigationEndpoint.browseEndpoint.browseId;
    }
    X.onResponse('mutate', function (r, inf) {
        if (inf.kind !== 'guide') return;
        var items = r.items[0].guideSectionRenderer.items, home = -1;
        if (!Array.isArray(items)) return;
        for (var i = 0; i < items.length; i++) {
            if (items[i] && items[i].guideEntryRenderer && items[i].guideEntryRenderer[MARK]) return;
            if (home === -1 && isHomeId(guideBrowseId(items[i]))) home = i;
        }
        if (home === -1) { log({ homeRefresh: 'no sidebar entry', why: 'no Home entry' }); return; }
        var ep = { browseEndpoint: { browseId: guideBrowseId(items[home]) } };
        ep[MARK] = true;
        var entry = { navigationEndpoint: ep, formattedTitle: { simpleText: 'Refresh' }, icon: { iconType: ICON } };
        entry[MARK] = true;
        items.splice(home + 1, 0, { guideEntryRenderer: entry });
    });

    // Highlighting the entry runs its endpoint (the sidebar previews pages): it shows Home like Home's entry, but on
    // Home itself nothing happens (no reload of Home).
    X.onAnyCommand(function (cmd) {
        if (cmd && cmd[MARK] && onHome()) return { handled: true };
    });

    // ---------------------------------------------------------------- Keys

    function up(el, name) {
        for (; el; el = el.parentElement) if (el.nodeName === name) return el;
        return null;
    }
    function focused() {
        var f = document.querySelectorAll('.zylon-focus');
        return f.length ? f[f.length - 1] : null;
    }
    function micFocused() {
        var f = focused();
        return !!(f && f.nodeName === 'YTLR-SEARCH-VOICE-MIC-BUTTON' && up(f, 'YTLR-SEARCH-BAR'));
    }
    function onEntry() {
        var e = up(focused(), 'YTLR-GUIDE-ENTRY-RENDERER');
        var d = e && e.__instance && e.__instance.props && e.__instance.props.data;
        return !!(d && d[MARK]);
    }

    var topOn = false, virt = false, swallowed = {}, guideTimer = null;
    function setVirt(on) {
        virt = on;
        try {
            if (on) document.body.setAttribute('data-ttx-refresh', '');
            else document.body.removeAttribute('data-ttx-refresh');
        } catch (e) {}
    }
    function stop(e) {
        swallowed[e.keyCode] = true;
        e.preventDefault();
        e.stopImmediatePropagation();
    }
    // OK on the sidebar entry: the key goes on (the sidebar closes and focus moves into Home, as for Home's entry);
    // the refresh follows once Home is shown (one timer, 10 tries).
    function afterGuideOk(tries) {
        guideTimer = setTimeout(function () {
            guideTimer = null;
            if (onHome()) refresh('sidebar');
            else if (tries < 10) afterGuideOk(tries + 1);
            else log({ homeRefresh: 'skipped', why: 'Home not shown', via: 'sidebar' });
        }, 300);
    }

    window.addEventListener('keydown', function (e) {
        try {
            var k = e.keyCode;
            if (virt) {
                if (!onHome() || !micFocused()) { setVirt(false); return; }
                if (k === 13) { stop(e); setVirt(false); refresh('topbar'); return; }
                if (k === 39) { stop(e); setVirt(false); return; }
                if (k === 38) { stop(e); return; }
                setVirt(false);     // LEFT, DOWN, BACK, ...: as from the mic
                return;
            }
            if (k === 37 && topOn && !e.repeat && onHome() && micFocused()) { stop(e); setVirt(true); return; }
            if (k === 13 && !e.repeat && guideTimer === null && onEntry()) afterGuideOk(0);
        } catch (err) { log({ homeRefreshKeyError: String(err) }); }
    }, true);
    function swallowRest(e) {
        if (!swallowed[e.keyCode]) return;
        if (e.type === 'keyup') delete swallowed[e.keyCode];
        e.preventDefault();
        e.stopImmediatePropagation();
    }
    window.addEventListener('keypress', swallowRest, true);
    window.addEventListener('keyup', swallowRest, true);

    function homeFlag() {
        try {
            if (X.isHome()) document.body.setAttribute('data-ttx-home', '');
            else document.body.removeAttribute('data-ttx-home');
        } catch (e) {}
    }
    window.addEventListener('hashchange', function () { setVirt(false); homeFlag(); });

    // ---------------------------------------------------------------- Top-bar button (CSS)

    var GAP = 90; // px: the mic's width (72) plus the mic-to-search-box gap (18)
    function css(glyph, font) {
        var bar = 'body[data-ttx-home] ytlr-search-bar', on = 'body[data-ttx-home][data-ttx-refresh] ';
        return '\n' + bar + ' { left: ' + GAP + 'px; }\n' +
            bar + '::before { content: "' + glyph + '"; font-family: ' + font + '; position: absolute; left: -' + GAP + 'px; top: 0;' +
            ' width: 72px; height: 72px; line-height: 72px; text-align: center; font-size: 36px; border-radius: 50%;' +
            ' background-color: rgba(255,255,255,0.1); color: rgb(241,241,241); }\n' +
            on + 'ytlr-search-bar::before { background-color: rgb(241,241,241); color: rgb(15,15,15); }\n' +
            on + 'ytlr-search-voice-mic-button { background-color: rgba(255,255,255,0.1) !important; color: rgb(241,241,241) !important; }\n' +
            on + 'ytlr-search-voice-mic-button yt-icon { color: rgb(241,241,241) !important; }\n';
    }
    // The glyph and font of a drawn ARROW_CIRCLE icon, as a CSS string escape; null when there is none (yet).
    function findGlyph() {
        var icons = document.getElementsByTagName('yt-icon');
        for (var i = 0; i < icons.length; i++) {
            var p = icons[i].__instance && icons[i].__instance.props;
            if (!p || p.icon !== ICON) continue;
            var st = window.getComputedStyle(icons[i], '::before');
            var m = st && /^["'](.+)["']$/.exec(String(st.content));
            if (!m || !st.fontFamily) continue;
            var esc = '';
            for (var j = 0; j < m[1].length; j++) esc += '\\' + m[1].charCodeAt(j).toString(16) + ' ';
            return { glyph: esc.replace(/ $/, ''), font: st.fontFamily.replace(/[;{}<>]/g, '') };
        }
        return null;
    }
    function installTop(tries) {
        var g = null, style = document.querySelector('style[nonce]');
        try { g = style && findGlyph(); } catch (e) { log({ homeRefresh: 'no top button', why: String(e) }); return; }
        if (!g) {
            if (tries < 60) setTimeout(function () { installTop(tries + 1); }, 500);
            else log({ homeRefresh: 'no top button', why: style ? 'no drawn ' + ICON + ' icon' : 'no style' });
            return;
        }
        style.textContent += css(g.glyph, g.font);
        topOn = true;
        log({ homeRefresh: 'top button', glyph: g.glyph, font: g.font, tries: tries });
    }
    homeFlag();
    installTop(0);
})();
