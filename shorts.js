// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TT Extras contributors. See LICENSE.
// Shorts player extras: double-press LEFT/RIGHT seeks -5/+5 s, a thin progress bar, and a playback-speed
// panel (0.5x .. 2x) that a single LEFT opens. Speed carries over to the next shorts and resets to 1x when
// leaving Shorts (never persisted). ES5 only. Does nothing (logs once) when the video can't be found.
//
// Keys (capture phase on window, so it runs before YouTube's handlers; loaded after seek.js):
//  - Outside the panel, with the focus on the video itself:
//      LEFT   is swallowed and waits GAP ms. A 2nd LEFT inside GAP = seek -5 s (further presses inside GAP
//             seek again, a held key repeats); no 2nd press = the panel opens. Any other key during the
//             wait opens the panel at once and then acts on it.
//      RIGHT  passes through at once (normal job); a 2nd RIGHT inside GAP = seek +5 s (swallowed).
//    With the focus on a button, LEFT/RIGHT are left alone (YouTube moves focus between buttons).
//  - Panel open: UP/DOWN move the cursor, OK sets the speed (panel stays open), RIGHT or BACK close it;
//    LEFT does nothing. All of these are swallowed (stopImmediatePropagation) so YouTube's focus engine
//    and BACK handler stay out; so is the matching keyup/keypress. Other keys pass.
// The panel and bar are plain DOM (pointer-events none, never focused): the page's focus is untouched.
(function () {
    if (location.hostname !== 'www.youtube.com') return;
    if (window.__tizentubeExtrasShorts) return;
    window.__tizentubeExtrasShorts = true;
    var X = window.__ttx;
    if (!X) return;

    var GAP = 400;
    var STEP = 5;
    var SPEEDS = [0.5, 1, 1.25, 1.5, 2];
    var TICK = 250;
    var IDLE_TICK = 1000;
    var HIDDEN_TICK = 5000;
    var BACK_CODES = { 27: 1, 8: 1, 4: 1, 166: 1, 461: 1, 10009: 1 };

    var speed = 1;
    var autoScroll = false;     // when on, a short that reaches its end moves on to the next one instead of looping
    try { autoScroll = X.settings.get('shortsAutoScroll', false) === true; } catch (e) {}
    var wrap = { sig: '', prev: -1, at: 0 };   // loop detector state for the current short
    var seekWall = 0;           // Date.now() of our last seek
    var cursor = 1;
    var active = false;         // the panel owns the keys
    var wasOn = false;
    var pending = null;         // timer of a swallowed first LEFT waiting to become the panel
    var pendingR = null;        // { timer, target } of a swallowed first RIGHT waiting to be replayed natively
    var replaying = false;      // true while our own synthetic RIGHT is dispatched: our handlers ignore it
    var last = { key: 0, time: 0, armed: false, burst: false, target: -1, seekAt: 0 };
    var swallowedUp = {};       // keyCode -> time of the swallowed keydown: its keyup/keypress is swallowed too (for 1.5 s)
    var cached = { v: null, t: 0 };
    var growUntil = 0;
    var seekNote = '';
    var touched = null;         // last video whose rate we changed
    var ui = null;
    var cssHost = null, cssSheet = null;   // the page's <style> and the sheet object our rules went into
    var cssAdds = 0;                        // times the rules were added (capped: a safety net against piling up)
    var CSS_MAX_ADDS = 20;
    var logged = {};

    function once(key, obj) {
        if (logged[key]) return;
        logged[key] = true;
        X.log(obj);
    }

    // ---- Route

    // The Shorts player keeps the hash at '#/' (seen on the TV), so detect it by its page element: a visible
    // <ytlr-shorts-page> (hidden/stale ones have no size). That check alone is authoritative.
    var pages = document.getElementsByTagName('ytlr-shorts-page');
    function inShorts() {
        if (!pages.length) return false; // the usual case outside Shorts: no layout needed
        for (var i = 0; i < pages.length; i++) {
            var r = pages[i].getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return true;
        }
        return false;
    }
    X.isShorts = inShorts;

    // ---- Video and player

    function getVideo() {
        var now = Date.now();
        if (cached.v && now - cached.t < 150 && document.contains(cached.v)) return cached.v;
        var vs = document.getElementsByTagName('video'), best = null, bestArea = 0;
        var w = window.innerWidth, h = window.innerHeight;
        for (var i = 0; i < vs.length; i++) {
            var r = vs[i].getBoundingClientRect();
            var iw = Math.min(r.right, w) - Math.max(r.left, 0), ih = Math.min(r.bottom, h) - Math.max(r.top, 0);
            if (iw <= 0 || ih <= 0) continue;
            var area = iw * ih;
            if (area > bestArea) { bestArea = area; best = vs[i]; }
        }
        cached.v = best;
        cached.t = now;
        return best;
    }

    function getPlayer() {
        var p = document.querySelector('.html5-video-player');
        if (!p || typeof p.getCurrentTime !== 'function' || typeof p.seekTo !== 'function') return null;
        // The API's position is the short's own timeline. The element's currentTime is an offset into the reused
        // MediaSource (seen on the TV: 106 s on the element while the API said 0.01 s), so never compare them.
        try { if (isFinite(p.getCurrentTime())) return p; } catch (e) {}
        return null;
    }

    function getCur(v) {
        var p = getPlayer();
        if (p) { try { return p.getCurrentTime(); } catch (e) {} }
        return v.currentTime;
    }

    // The short's real length. The page keeps one <video> whose MediaSource duration can be stale (seen on the
    // TV: 75 s reported for a 59.8 s short, and the player API disagreeing), which made the bar crawl and jump.
    // The player API's duration is authoritative; the element's is the fallback.
    function getDur(v) {
        var p = document.querySelector('.html5-video-player');
        if (p && typeof p.getDuration === 'function') {
            try {
                var d = p.getDuration();
                if (isFinite(d) && d > 0) return d;
            } catch (e) {}
        }
        return v.duration;
    }

    function fmt(s) {
        s = Math.max(0, Math.floor(s));
        var m = Math.floor(s / 60), r = s % 60;
        return m + ':' + (r < 10 ? '0' : '') + r;
    }

    // ---- UI

    var RULES = [
        '#ttx-sh-bar{position:fixed;z-index:2147483000;pointer-events:none;height:4px;background:rgba(255,255,255,.3);' +
        'transition:height .15s;display:none;box-sizing:border-box}',
        '#ttx-sh-bar.grow{height:12px}',
        '#ttx-sh-fill{height:100%;width:0;background:#ff2d2d}',
        '#ttx-sh-label{position:absolute;left:0;bottom:16px;padding:4px 10px;border-radius:6px;background:rgba(0,0,0,.75);' +
        'color:#fff;font:600 22px/1.2 sans-serif;white-space:nowrap;display:none}',
        '#ttx-sh-bar.grow #ttx-sh-label{display:block}',
        '#ttx-sh-panel{position:fixed;z-index:2147483000;pointer-events:none;display:none;box-sizing:border-box;width:96px;' +
        'padding:8px 6px;border-radius:10px;background:rgba(0,0,0,.6);color:#fff;font:600 22px/1.2 sans-serif;text-align:center;' +
        'opacity:.55;transition:opacity .15s}',
        '#ttx-sh-panel.open{opacity:1;background:rgba(0,0,0,.85)}',
        '#ttx-sh-panel .t{font-size:14px;font-weight:400;opacity:.8;margin-bottom:4px}',
        '#ttx-sh-panel .i{margin:3px 0;padding:6px 0;border-radius:6px;border:2px solid transparent}',
        '#ttx-sh-panel .i.a{font-size:16px;margin-top:8px}',
        '#ttx-sh-panel .i.cur{background:rgba(255,255,255,.25)}',
        '#ttx-sh-panel.open .i.sel{border-color:#fff}'
    ];

    // True while our rules are in the page's live sheet. Assigning the <style>'s textContent (TizenTube does,
    // when the first <video> appears and on every theme change) replaces its sheet object and drops rules added
    // with insertRule, so the sheet's identity tells.
    function cssOk() {
        return !!cssHost && cssHost.sheet === cssSheet && !!cssSheet && !!cssHost.parentNode;
    }

    // Adds our rules to the page's sheet (insertRule: the page's own rules are not reparsed). Returns false
    // when there is no such sheet. Called again only after the sheet was replaced, so rules never pile up.
    function addCss() {
        // CSP blocks our own <style> elements: add the rules to the page's nonce'd stylesheet (as extras.js does).
        var host = document.querySelector('style[nonce]');
        if (!host || !host.sheet) return false;
        var sheet = host.sheet, i;
        // Taken the text route before: the rules are still in the text (rare check, only after a sheet change).
        if (String(host.textContent).indexOf('#ttx-sh-bar{') !== -1) { cssHost = host; cssSheet = sheet; return true; }
        try {
            for (i = 0; i < RULES.length; i++) sheet.insertRule(RULES[i], sheet.cssRules.length);
        } catch (e) {
            // insertRule refused: the text route for all rules (it rebuilds the sheet, dropping any inserted above),
            // then stop. These rules are in the text, so they also survive TizenTube's later "+=".
            host.textContent += '\n' + RULES.join('\n') + '\n';
            X.log({ shorts: 'cssTextRoute', error: String(e) });
        }
        cssHost = host;
        cssSheet = host.sheet;
        cssAdds++;
        X.log({ shorts: 'cssAdded', n: cssAdds });
        return true;
    }

    // Critical properties inline too, so that if the rules get lost the divs stay invisible and out of the way.
    function base(el) {
        var s = el.style;
        s.position = 'fixed';
        s.pointerEvents = 'none';
        s.display = 'none';
        s.zIndex = '2147483000';
    }

    function build() {
        if (!cssOk() && cssAdds < CSS_MAX_ADDS && !addCss()) return null;
        if (ui) return ui;
        var root = document.body || document.documentElement;
        if (!root) return null;
        var bar = document.createElement('div');
        bar.id = 'ttx-sh-bar';
        base(bar);
        var fill = document.createElement('div');
        fill.id = 'ttx-sh-fill';
        var label = document.createElement('div');
        label.id = 'ttx-sh-label';
        bar.appendChild(fill);
        bar.appendChild(label);
        var panel = document.createElement('div');
        panel.id = 'ttx-sh-panel';
        base(panel);
        var title = document.createElement('div');
        title.className = 't';
        title.appendChild(document.createTextNode('Speed'));
        panel.appendChild(title);
        var items = [];
        for (var i = 0; i < SPEEDS.length; i++) {
            var it = document.createElement('div');
            it.className = 'i';
            it.appendChild(document.createTextNode(SPEEDS[i] + '×'));
            panel.appendChild(it);
            items.push(it);
        }
        var au = document.createElement('div');
        au.className = 'i a';
        au.appendChild(document.createTextNode('Auto: Off'));
        panel.appendChild(au);
        items.push(au);
        root.appendChild(bar);
        root.appendChild(panel);
        ui = { bar: bar, fill: fill, label: label, panel: panel, items: items };
        return ui;
    }

    // Writes only when the value changed (the tick runs often on a weak CPU).
    function cls(el, v) { if (el.className !== v) el.className = v; }
    function sty(el, p, v) { if (el.style[p] !== v) el.style[p] = v; }

    function renderPanel() {
        if (!ui) return;
        cls(ui.panel, active ? 'open' : '');
        for (var i = 0; i < SPEEDS.length; i++) {
            cls(ui.items[i], 'i' + (SPEEDS[i] === speed ? ' cur' : '') + (i === cursor ? ' sel' : ''));
        }
        var au = ui.items[SPEEDS.length];
        cls(au, 'i a' + (autoScroll ? ' cur' : '') + (cursor === SPEEDS.length ? ' sel' : ''));
        var txt = 'Auto: ' + (autoScroll ? 'On' : 'Off');
        if (au.firstChild && au.firstChild.nodeValue !== txt) au.firstChild.nodeValue = txt;
    }

    function hideUi() {
        if (!ui) return;
        sty(ui.bar, 'display', 'none');
        sty(ui.panel, 'display', 'none');
    }

    function layout(v) {
        if (!build()) return;
        var r = v.getBoundingClientRect();
        var w = window.innerWidth, h = window.innerHeight;
        var portrait = r.width > 0 && r.width < w * 0.8;
        var left = portrait ? Math.max(0, r.left) : 0;
        var width = portrait ? Math.min(r.width, w - left) : w;
        var bottom = Math.max(0, h - Math.min(r.bottom, h));
        sty(ui.bar, 'display', 'block');
        sty(ui.bar, 'left', left + 'px');
        sty(ui.bar, 'width', width + 'px');
        sty(ui.bar, 'bottom', bottom + 'px');
        sty(ui.panel, 'display', 'block');
        sty(ui.panel, 'left', (portrait && left > 130 ? left - 110 : 24) + 'px');
        sty(ui.panel, 'top', Math.max(24, Math.round(h / 2 - 140)) + 'px');
        renderPanel();
    }

    function setLabel(text) {
        if (ui.label.firstChild) ui.label.firstChild.nodeValue = text;
        else ui.label.appendChild(document.createTextNode(text));
    }

    function updateBar(v) {
        if (!ui) return;
        var dur = getDur(v), cur = getCur(v);
        var ok = isFinite(dur) && dur > 0 && isFinite(cur);
        sty(ui.fill, 'width', ok ? Math.min(100, Math.max(0, cur / dur * 100)) + '%' : '0');
        var grow = Date.now() < growUntil;
        cls(ui.bar, grow ? 'grow' : '');
        if (grow && ok) setLabel(seekNote + fmt(cur) + ' / ' + fmt(dur));
    }

    // ---- Speed

    function applySpeed(v) {
        if (!v) return;
        if (speed === 1 && touched !== v && v.playbackRate === 1) return;
        if (v.playbackRate !== speed) {
            try { v.playbackRate = speed; } catch (e) { once('rateFail', { shorts: 'rateFail', error: String(e) }); }
        }
        touched = v;
    }

    function setSpeed(s) {
        speed = s;
        var v = getVideo();
        applySpeed(v);
        renderPanel();
        X.log({ shorts: 'speed', speed: s, rate: v ? v.playbackRate : null });
        if (v) setTimeout(function () {
            if (v.playbackRate !== speed) X.log({ shorts: 'speedNotHeld', want: speed, got: v.playbackRate });
        }, 1000);
    }

    // ---- Seek

    function seek(k, now) {
        var v = getVideo();
        if (!v) { once('noVideo', { shorts: 'noVideo' }); return false; }
        var dur = getDur(v);
        if (!isFinite(dur) || dur <= 0) { once('noDuration', { shorts: 'noDuration', dur: String(dur) }); return false; }
        var api = getPlayer();
        var cur = api ? api.getCurrentTime() : v.currentTime;
        var from = last.target >= 0 && now - last.seekAt < 1000 ? last.target : cur;
        if (!isFinite(from)) return false;
        var to = from + (k === 39 ? STEP : -STEP);
        var max = Math.max(0, dur - 0.5);   // never to the very end (that would advance to the next short)
        if (to < 0) to = 0;
        if (to > max) to = max;
        if (k === 39 && from >= max) { growUntil = Date.now() + 1500; seekNote = ''; return true; }
        try {
            if (api) api.seekTo(to, true); else v.currentTime = to;
        } catch (e) {
            once('seekFail', { shorts: 'seekFail', error: String(e) });
            return false;
        }
        last.target = to;
        last.seekAt = now;
        seekWall = Date.now();
        seekNote = (k === 39 ? '+' : '−') + STEP + 's   ';
        growUntil = Date.now() + 1500;
        if (!ui) build();
        layout(v);
        // Show the new position at once (the video reports it only after the seek lands).
        if (ui) {
            ui.fill.style.width = (to / dur * 100) + '%';
            ui.bar.className = 'grow';
            setLabel(seekNote + fmt(to) + ' / ' + fmt(dur));
        }
        X.log({ shorts: 'seek', dir: k === 39 ? '+' : '-', from: from, to: to, api: !!api });
        if (api) setTimeout(function () {
            // The API route did not land (the Shorts player may ignore it): fall back to the element.
            var got = getCur(v);
            if (last.target === to && Math.abs(got - to) > 1.5 && got > 1 && document.contains(v)) {
                X.log({ shorts: 'seekApiFallback', want: to, got: got });
                try { api.seekTo(to, true); } catch (e) {}
            }
        }, 400);
        return true;
    }

    // ---- Panel

    function openPanel() {
        if (pending) { clearTimeout(pending); pending = null; }
        last.armed = false;
        var v = getVideo();
        if (!v || !inShorts()) return;
        if (!build()) { once('noUi', { shorts: 'noUi' }); return; }   // no UI to show: never swallow keys for it
        active = true;
        cursor = Math.max(0, SPEEDS.indexOf(speed));
        layout(v);
        renderPanel();
        X.log({ shorts: 'panelOpen' });
    }

    function closePanel() {
        active = false;
        renderPanel();
    }

    // True when the page's focus is on the video itself (body, the video, or a wrapper around it), not on a
    // button next to it.
    // document.activeElement is stale in the TV app (it kept a Home tile), so use YouTube's own focus marker:
    // the deepest .zylon-focus element. On the video it is the ytlr-shorts-page itself.
    function focusOnVideo(v) {
        var z = document.getElementsByClassName('zylon-focus');
        var f = z.length ? z[z.length - 1] : null;
        if (!f) return false;   // no marker: cannot tell, leave the keys alone
        for (var n = f; n && n !== document.body; n = n.parentElement) {
            if (/BUTTON|TOGGLE|CHIP|MENU/.test(n.nodeName)) return false;
            if (n.nodeName === 'YTLR-SHORTS-PAGE') return true;
        }
        return false;
    }

    function swallow(e) {
        e.preventDefault();
        e.stopImmediatePropagation();
        swallowedUp[e.keyCode] = Date.now();
    }

    function isBack(e) {
        return !!BACK_CODES[e.keyCode] || e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack';
    }

    function panelKey(e) {
        var k = e.keyCode;
        if (k === 38 || k === 40) {
            cursor = Math.max(0, Math.min(SPEEDS.length, cursor + (k === 40 ? 1 : -1)));
            renderPanel();
            swallow(e);
        } else if (k === 13 || k === 32) {
            if (!e.repeat) {
                if (cursor === SPEEDS.length) {
                    autoScroll = !autoScroll;
                    try { X.settings.set('shortsAutoScroll', autoScroll); } catch (er) {}
                    wrap.prev = -1;
                    renderPanel();
                    X.log({ shorts: 'autoScroll', on: autoScroll });
                } else setSpeed(SPEEDS[cursor]);
            }
            swallow(e);
        } else if (k === 39 || isBack(e)) {
            closePanel();
            swallow(e);
        } else if (k === 37) {
            swallow(e);
        }
    }

    // Replays the swallowed first RIGHT as a synthetic keydown+keyup on its original target (YouTube's focus
    // engine then moves to the buttons as it would have natively).
    function keySyn(type, target, code, name) {
        var ev = document.createEvent('Event');
        ev.initEvent(type, true, true);
        var props = { keyCode: code, which: code, key: name, code: name, charCode: 0 };
        for (var n in props) {
            try { Object.defineProperty(ev, n, { get: (function (val) { return function () { return val; }; })(props[n]) }); } catch (e) {}
        }
        target.dispatchEvent(ev);
    }

    function flushRight() {
        if (!pendingR) return;
        var pr = pendingR;
        pendingR = null;
        clearTimeout(pr.timer);
        last.armed = false;
        delete swallowedUp[39];
        var t = pr.target && document.contains(pr.target) ? pr.target : (document.activeElement || document.body);
        replaying = true;
        try {
            keySyn('keydown', t, 39, 'ArrowRight');
            keySyn('keyup', t, 39, 'ArrowRight');
        } catch (err) { X.log({ shorts: 'replayError', error: String(err) }); }
        replaying = false;
        X.log({ shorts: 'rightReplayed' });
    }

    function onKeyDown(e) {
        if (replaying) return;
        var k = e.keyCode;
        if (pendingR && k !== 39) flushRight();   // another key: the first RIGHT goes through now, then this key acts
        if (!inShorts()) {
            if (active) closePanel();
            if (pending) { clearTimeout(pending); pending = null; }
            last.armed = false;
            last.burst = false;
            return;
        }
        if (active) {
            if (!getVideo()) { closePanel(); return; }   // nothing to control: hand the keys back
            panelKey(e);
            return;
        }
        if (k !== 37 && k !== 39) {
            if (pending) { openPanel(); if (active) panelKey(e); return; }
            last.armed = false;
            last.burst = false;
            return;
        }
        if (!build()) { once('noUi', { shorts: 'noUi' }); return; }
        var v = getVideo();
        if (!v) { once('noVideo', { shorts: 'noVideo' }); return; }
        if (k === 39 && pending) { clearTimeout(pending); pending = null; last.armed = false; }   // LEFT then RIGHT: no panel
        var now = e.timeStamp > 0 ? e.timeStamp : Date.now();
        // Key held after a double press: swallow the repeats.
        if (e.repeat && last.burst && last.key === k && now - last.time < GAP) {
            swallow(e);
            last.time = now;
            seek(k, now);
            return;
        }
        if (e.repeat && pending && k === 37) { swallow(e); return; }
        var continuing = last.armed && last.key === k && now - last.time < GAP && !e.repeat;
        if (continuing) {
            if (pending) { clearTimeout(pending); pending = null; }
            if (pendingR) { clearTimeout(pendingR.timer); pendingR = null; }
            if (seek(k, now)) {
                swallow(e);
                last.time = now;
                last.burst = true;
            } else if (k === 39) {
                // Could not seek: the first RIGHT was swallowed; give it back (this one passes as well).
                last.armed = false;
            } else if (k === 37) {
                // Could not seek: do not leave the swallowed first LEFT unanswered.
                openPanel();
            }
            return;
        }
        last.key = k;
        last.time = now;
        last.burst = false;
        last.armed = focusOnVideo(v);
        if (k === 39 && last.armed && !e.repeat) {
            swallow(e);
            pendingR = { target: e.target, timer: setTimeout(flushRight, GAP + 20) };
            return;
        }
        if (k === 39 && pendingR) { swallow(e); return; }
        if (k === 37 && last.armed && !e.repeat) {
            swallow(e);
            if (pending) clearTimeout(pending);
            pending = setTimeout(function () {
                pending = null;
                last.armed = false;
                openPanel();
            }, GAP + 60);
        }
    }

    function onKeyUp(e) {
        if (replaying) return;
        var t = swallowedUp[e.keyCode];
        if (!t) return;
        if (Date.now() - t > 1500) { delete swallowedUp[e.keyCode]; return; }   // stale: its keyup never came
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.type === 'keyup') delete swallowedUp[e.keyCode];
    }

    window.addEventListener('keydown', function (e) {
        try { onKeyDown(e); } catch (err) { X.log({ shorts: 'keyError', error: String(err) }); }
    }, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('keypress', onKeyUp, true);

    // ---- Lifecycle

    function leave() {
        wasOn = false;
        active = false;
        swallowedUp = {};
        if (pending) { clearTimeout(pending); pending = null; }
        if (pendingR) { clearTimeout(pendingR.timer); pendingR = null; }
        last.armed = false;
        last.burst = false;
        last.target = -1;
        if (touched && speed !== 1) { try { touched.playbackRate = 1; } catch (e) {} }
        touched = null;
        cached.v = null;   // no <video> element kept alive outside Shorts
        speed = 1;
        cursor = 1;
        growUntil = 0;
        hideUi();
        renderPanel();
        X.log({ shorts: 'left' });
    }

    // Auto-scroll: Shorts loop, so 'ended' does not fire; the wrap (time jumps from the end back to the start)
    // is the signal. Advances with a synthetic DOWN, once per short, only when the focus is on the short.
    function checkWrap(v) {
        var dur = getDur(v), cur = getCur(v), now = Date.now();
        var vid = '';
        try { vid = document.querySelector('.html5-video-player').getVideoData().video_id || ''; } catch (e) {}   // currentSrc is constant (one reused <video>)
        var sig = vid + '|' + String(v.currentSrc).slice(-24) + '|' + (isFinite(dur) ? Math.round(dur * 10) : '?');
        if (sig !== wrap.sig) { wrap.sig = sig; wrap.prev = -1; return; }
        var prev = wrap.prev;
        wrap.prev = cur;
        if (!autoScroll || prev < 0 || !isFinite(dur) || dur <= 0) return;
        if (!(prev >= dur - 2.5 && cur < prev - dur * 0.4)) return;
        if (now - wrap.at < 2000 || now - seekWall < 1500) return;
        if (active || pending || pendingR || v.paused || !focusOnVideo(v)) return;
        wrap.at = now;
        var z = document.getElementsByClassName('zylon-focus');
        var t = z.length ? z[z.length - 1] : (document.activeElement || document.body);
        replaying = true;
        try {
            keySyn('keydown', t, 40, 'ArrowDown');
            keySyn('keyup', t, 40, 'ArrowDown');
        } catch (err) { X.log({ shorts: 'advanceError', error: String(err) }); }
        replaying = false;
        X.log({ shorts: 'autoAdvance', prev: prev, cur: cur, dur: dur });
    }

    function tick() {
        try {
            if (!inShorts()) { if (wasOn) leave(); return; }
            wasOn = true;
            var v = getVideo();
            if (!v) { hideUi(); once('noVideo', { shorts: 'noVideo' }); return; }
            layout(v);
            updateBar(v);
            checkWrap(v);
            if (speed !== 1 || touched) applySpeed(v);
        } catch (e) { once('tickError', { shorts: 'tickError', error: String(e) }); }
    }

    // Slow idle tick while not in Shorts; slower still while the app is in the background.
    (function loop() {
        tick();
        setTimeout(loop, wasOn ? TICK : document.visibilityState === 'hidden' ? HIDDEN_TICK : IDLE_TICK);
    })();
    window.addEventListener('hashchange', function () { setTimeout(tick, 0); }, false);
    // A new short usually brings a new source or element: reapply the speed at once (rate resets on load).
    ['loadedmetadata', 'emptied', 'playing'].forEach(function (name) {
        document.addEventListener(name, function (e) {
            if (e.target && e.target.nodeName === 'VIDEO' && (name === 'loadedmetadata' || name === 'emptied')) wrap.prev = -1;
            if (e.target && e.target.nodeName === 'VIDEO' && inShorts() && speed !== 1) applySpeed(e.target);
        }, true);
    });

    // ---- Shorts only in Shorts rows

    // YouTube mixes Shorts tiles (reelWatchEndpoint, SHORTS style) into Home's long-form rows; our own rows can hold them
    // too. On Home (YouTube's rows and ours) and our Subscriptions page they are dropped from every row that is not mostly
    // Shorts tiles; a row left empty goes (common.js clean-up). Plain video tiles stay whatever their length. Untouched:
    // Shorts shelves, the Saved page, the Shorts player (reel responses), the watch page (next), search, channel pages,
    // the History page.
    function rowScope(inf) {
        if (!inf || (inf.kind !== 'browse' && inf.kind !== 'continuation')) return false;
        var id = inf.browseId;
        if (id) return id === 'FEtopics' || id === 'FEwhat_to_watch' || id === 'FEtizentube_subscriptions';
        return X.isHome() && !X.onShortsPage();
    }
    function isShort(it) {
        var t = it && it.tileRenderer, lv = it && it.lockupViewModel;
        if (lv) return lv.contentType === 'LOCKUP_CONTENT_TYPE_SHORT';
        if (!t) return false;
        var sel = t.onSelectCommand || {};
        return !!(sel.reelWatchEndpoint || t.style === 'TILE_STYLE_YTLR_SHORTS' || t.contentType === 'TILE_CONTENT_TYPE_SHORTS');
    }
    function dropShorts(items) {
        var flags = [], n = 0, i;
        for (i = 0; i < items.length; i++) {
            flags.push(isShort(items[i]));
            if (flags[i]) n++;
        }
        if (!n || n * 2 > items.length) return 0; // no Shorts here, or a Shorts row
        for (i = items.length - 1; i >= 0; i--) if (flags[i]) items.splice(i, 1);
        return n;
    }
    X.onItems('filter', function (items, ctx) {
        if (rowScope(ctx && ctx.info)) dropShorts(items);
    });
    X.test = X.test || {};
    X.test.shorts = { dropShorts: dropShorts, isShort: isShort, rowScope: rowScope };
})();
