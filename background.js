// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TT Extras contributors. See LICENSE.
// Background picture (settings rows; Off by default): a dimmed picture behind every page except actual video
// playback (Watch) — Home, the sidebar tabs, search, Shorts (visible beside a vertical video's letterbox bars),
// sign-in, Settings, etc. A class on <html> is cleared only on the Watch page. Sources (the "Background" row
// cycles through them):
//  - repo: a picture from backgrounds/ next to these modules (the tagged jsDelivr release, or the development server),
//    listed in backgrounds/backgrounds.json; the "Change background picture" row steps through the list. The setting
//    backgroundSource ("name/repo", no on-screen editor yet) takes the pictures from another public GitHub repo's
//    backgrounds/ folder through jsDelivr instead.
//  - tv: a picture kept on this TV as a data: URI in localStorage (KEY), put there by the owner (the dev-only bgseed.js).
// The page's CSP only allows images from Google hosts, data: URIs and the hosts TizenTube Cobalt exempts (jsDelivr,
// ttx.localhost), and every URL is checked against a strict pattern before it goes into the stylesheet. A 1920x1080
// picture is about 8 MB once decoded, held once while shown. State: one class, one cached list; listeners: hashchange.
(function () {
    if (location.hostname !== 'www.youtube.com') return;
    if (window.__tizentubeExtrasBackground) return;
    window.__tizentubeExtrasBackground = true;
    var X = window.__ttx;
    if (!X) return;

    var KEY = 'tizentube-extras-background';
    var CLS = 'ttx-bg';
    var START = '\n/*ttx-bg*/', END = '/*ttx-bg-end*/\n';
    var MODES = ['off', 'repo', 'tv'];
    var NAMES = { off: 'Off', repo: 'Picture from the repo', tv: 'Picture saved on this TV' };

    // Only these can go into the stylesheet: anything else could add CSS.
    var IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/;
    var FILE_RE = /^[\w-]{1,64}\.(jpg|jpeg|png|webp)$/;
    var BASE_RE = /^(https:\/\/cdn\.jsdelivr\.net\/gh\/[\w.-]{1,39}\/[\w.-]{1,100}(@[\w.-]{1,64})?\/|http:\/\/ttx\.localhost:\d{2,5}\/dev\/)backgrounds\/$/;
    var SOURCE_RE = /^[\w.-]{1,39}\/[\w.-]{1,100}(@[\w.-]{1,64})?$/;

    var list = null, listBase = null, listLoading = false;
    var refreshAfterList = false; // the list was asked for from the settings popup: show its rows when it arrives

    function tvImage() {
        var v = null;
        try { v = localStorage[KEY]; } catch (e) {}
        return typeof v === 'string' && IMAGE_RE.test(v) ? v : null;
    }
    // Where repo pictures come from: another repo when backgroundSource is set, else next to these modules.
    function base() {
        var src = X.settings.get('backgroundSource', '');
        var b = typeof src === 'string' && SOURCE_RE.test(src) ? 'https://cdn.jsdelivr.net/gh/' + src + '/backgrounds/'
            : (X.base || '') + 'backgrounds/';
        return BASE_RE.test(b) ? b : null;
    }
    function mode() {
        var m = X.settings.get('backgroundMode');
        if (m === undefined) {
            // Before modes there was one on/off setting for the TV picture.
            m = X.settings.get('background') !== false && tvImage() ? 'tv' : 'off';
        }
        if (m === 'tv' && !tvImage()) m = 'off';
        return MODES.indexOf(m) === -1 ? 'off' : m;
    }
    function repoPicture() {
        if (!list || !list.length || listBase !== base()) return null;
        var pick = X.settings.get('backgroundPick', ''), i = list.indexOf(pick);
        return listBase + list[i === -1 ? 0 : i];
    }
    function image() {
        var m = mode();
        if (m === 'tv') return tvImage();
        if (m === 'repo') { loadList(); return repoPicture(); }
        return null;
    }

    // backgrounds.json: an array of file names in the same folder. Loaded once per source (on failure, again on the
    // next change of setting).
    function loadList() {
        var b = base();
        if (!b || listLoading || (list && listBase === b)) return;
        listLoading = true;
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', b + 'backgrounds.json');
            xhr.onload = xhr.onerror = function () {
                listLoading = false;
                var names = null;
                try { if (xhr.status === 200) names = X.origParse(xhr.responseText); } catch (e) {}
                list = [];
                listBase = b;
                for (var i = 0; names instanceof Array && i < names.length && list.length < 50; i++) {
                    if (typeof names[i] === 'string' && FILE_RE.test(names[i])) list.push(names[i]);
                }
                if (!list.length) X.log({ background: 'no pictures', status: xhr.status });
                apply();
                if (refreshAfterList) { refreshAfterList = false; X.refreshSettings('background'); }
            };
            xhr.send();
        } catch (e) { listLoading = false; }
    }

    function wanted() {
        return !X.isWatch();
    }

    // Scripts may not add <style> elements (CSP), so the rule goes into the page's own nonce'd stylesheet,
    // between two marker comments so it can be taken out (or replaced) again.
    var waitTimer = null;
    function apply() {
        var img = image(), style = document.querySelector('style[nonce]');
        clearTimeout(waitTimer);
        waitTimer = null;
        if (!style) { if (img) waitTimer = setTimeout(apply, 250); return; }
        var text = style.textContent, at = text.indexOf(START), end = at === -1 ? -1 : text.indexOf(END, at);
        var rule = img ? START + 'html.' + CLS + ' #container {' +
            ' background-color: #000 !important;' +
            ' background-image: linear-gradient(rgba(0,0,0,.55), rgba(0,0,0,.55)), url("' + img + '") !important;' +
            ' background-size: cover !important; background-position: center !important;' +
            ' background-repeat: no-repeat !important; }' +
            // Pages that paint their own full-screen backdrop over #container: sign-in (a gradient picture, and a dark
            // scrim over its lower part in ::before) and the Shorts player (solid black plus a gradient in the video's
            // colours, two levels inside ytlr-player).
            ' html.' + CLS + ' ytlr-accounts-container, html.' + CLS + ' ytlr-accounts-container::before,' +
            ' html.' + CLS + ' body.WEB_PAGE_TYPE_SHORTS ytlr-player,' +
            ' html.' + CLS + ' body.WEB_PAGE_TYPE_SHORTS ytlr-player > div > div { background: none !important; }' + END : '';
        var current = at === -1 ? '' : text.slice(at, end === -1 ? text.length : end + END.length);
        if (current !== rule) style.textContent = (at === -1 ? text : text.slice(0, at) + (end === -1 ? '' : text.slice(end + END.length))) + rule;
        var root = document.documentElement, show = !!img && wanted();
        if (show !== root.classList.contains(CLS)) {
            if (show) root.classList.add(CLS); else root.classList.remove(CLS);
        }
    }
    apply();
    window.addEventListener('hashchange', apply);

    X.settingsRow('background', function () {
        var m = mode(), sub = NAMES[m];
        if (m === 'repo' && list && !list.length) sub += ' (none found)';
        return X.row({
            title: 'Background',
            subtitle: sub + ' — select to change',
            icon: 'PERSON',
            commands: [{ tizentubeExtrasCommand: { nextBackgroundMode: true } }]
        });
    });
    X.settingsRow('backgroundPick', function () {
        if (mode() !== 'repo' || !list || list.length < 2) return null;
        var pick = X.settings.get('backgroundPick', ''), i = list.indexOf(pick);
        return X.row({
            title: 'Change background picture',
            subtitle: 'Picture ' + ((i === -1 ? 0 : i) + 1) + ' of ' + list.length,
            icon: 'PERSON',
            commands: [{ tizentubeExtrasCommand: { nextBackgroundPicture: true } }]
        });
    });

    X.onCommand('nextBackgroundMode', function () {
        var m = mode(), i = MODES.indexOf(m), next;
        do { i = (i + 1) % MODES.length; next = MODES[i]; } while (next === 'tv' && !tvImage());
        X.settings.set('backgroundMode', next);
        if (next === 'repo' && !(list && listBase === base())) refreshAfterList = true;
        apply();
        X.refreshSettings('background');
    });
    X.onCommand('nextBackgroundPicture', function () {
        if (!list || !list.length) return;
        var i = list.indexOf(X.settings.get('backgroundPick', ''));
        X.settings.set('backgroundPick', list[((i === -1 ? 0 : i) + 1) % list.length]);
        apply();
        X.refreshSettings('backgroundPick');
    });

    X.test = X.test || {};
    X.test.background = { mode: mode, base: base, image: image, BASE_RE: BASE_RE, FILE_RE: FILE_RE };
})();
