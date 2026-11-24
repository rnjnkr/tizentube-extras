// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TT Extras contributors. See LICENSE.
// Sidebar (guide) focus wraps around: UP on the first entry (Sign in when present) goes to the last,
// and DOWN on the last goes to the first.
//
// Built to survive minified-name changes (the select method was fa() until the 2026-11-17 YouTube
// update, then ga()): discovery follows the guide's own call sites (build/robust-nav-keyboard.md).
//  - Where focus is: the deepest .zylon-focus element (YouTube's own focus path; document.activeElement
//    can be stale in this app), activeElement only as a fallback; the guide's named `focused` prop must agree.
//  - Which entry is selected: the guide's named `selectedIndex` getter, else the focused entry's props.index.
//  - Top/bottom: the rendered <ytlr-guide-entry-renderer>s (named props `index`, `hidden`).
//  - The select method: an own 1-argument function of the guide instance that the guide's own named
//    handlers (onRightFocus, onBack, the account wrapper) call with an index. An uninterrupted
//    sample with selection and focus on the target caches the pick for that guide instance.
//    A throw or a confirmed no-op lets native navigation handle edge presses for one second,
//    then the next edge press tries the next candidate.
(function () {
    if (location.hostname !== 'www.youtube.com') return;
    if (window.__tizentubeExtrasNav) return;
    window.__tizentubeExtrasNav = true;

    var X = window.__ttx;   // common.js, loaded first (loader.js)
    if (!X) return;
    var log = X.log;

    var lastRoot = null, lastGuide = null, picked = null, failed = null, retryAfter = 0;
    var keySerial = 0;
    var pending = false;    // one validation at a time (no queued timers)
    var NAMED = { onBack: 1, onRightFocus: 1, onUp: 1, onDown: 1, onLeft: 1, onRight: 1, onSelect: 1, template: 1 };

    function up(el, name) {
        for (; el; el = el.parentElement) if (el.nodeName === name) return el;
        return null;
    }
    function focused() {
        var f = document.querySelectorAll('.zylon-focus');
        return f.length ? f[f.length - 1] : document.activeElement;
    }
    function entryIndex(entry) {
        var p = entry && entry.__instance && entry.__instance.props;
        if (!p) return null;
        var idx = up(entry, 'YT-VIRTUAL-LIST') ? p.index : -1;
        return typeof idx === 'number' ? idx : null;
    }
    function selected(guide, entry) {
        var s;
        try { s = guide.selectedIndex; } catch (e) {}
        return typeof s === 'number' ? s : entryIndex(entry);
    }
    function src(f) { try { return typeof f === 'function' ? String(f) : ''; } catch (e) { return ''; } }
    function usable(guide, n) {
        return !NAMED[n] && Object.prototype.hasOwnProperty.call(guide, n) &&
            typeof guide[n] === 'function' && guide[n].length === 1 && !/^class[\s{]/.test(src(guide[n]));
    }

    // Candidate names, best first.
    function candidates(guide) {
        var out = [], i, m;
        function add(n) { if (n && out.indexOf(n) < 0 && usable(guide, n)) out.push(n); }
        if (picked) add(picked);
        m = /this\.([\w$]+)\(this\.selectedIndex,!0\)/.exec(src(guide.onRightFocus)); if (m) add(m[1]);
        m = /:this\.([\w$]+)\(\w+\);/.exec(src(guide.onBack)); if (m) add(m[1]);
        var keys = Object.keys(guide);
        for (i = 0; i < keys.length; i++) {
            m = /^\(\)[=][>]\{this\.([\w$]+)\(-1\)\}$/.exec(src(guide[keys[i]])); if (m) add(m[1]);
        }
        return out;
    }

    function reset(root, guide) {
        lastRoot = root;
        lastGuide = guide;
        picked = failed = null;
        retryAfter = 0;
    }
    X.test = X.test || {};
    X.test.nav = { hasGuide: function () { return lastGuide !== null || lastRoot !== null; } };

    window.addEventListener('keydown', function (e) {
        var press = ++keySerial;
        if (lastRoot && !document.contains(lastRoot)) reset(null, null);
        var k = e.keyCode;
        if ((k !== 38 && k !== 40) || e.repeat || pending) return;
        var f = focused();
        var entry = f && up(f, 'YTLR-GUIDE-ENTRY-RENDERER');
        var root = entry && up(entry, 'YTLR-GUIDE-RESPONSE');
        var guide = root && document.contains(root) && root.__instance;
        if (!guide) return;
        if (guide !== lastGuide) reset(root, guide);
        else lastRoot = root;
        if ((guide.props && guide.props.focused === false) || Date.now() < retryAfter) return;

        var entries = root.querySelectorAll('ytlr-guide-entry-renderer'), lo = null, hi = null;
        for (var i = 0; i < entries.length; i++) {
            var p = entries[i].__instance && entries[i].__instance.props;
            if (!p || p.hidden) continue;
            var idx = entryIndex(entries[i]);
            if (idx === null) continue;
            if (lo === null || idx < lo) lo = idx;
            if (hi === null || idx > hi) hi = idx;
        }
        var here = selected(guide, entry);
        if (typeof here !== 'number' || lo === null) return;
        var target = k === 38 && here === lo ? hi : k === 40 && here === hi ? lo : null;
        if (target === null || target === here) return;

        var names = candidates(guide);
        if (!names.length) return;
        var next = (names.indexOf(failed) + 1) % names.length, name = names[next];
        var startFocus = entryIndex(entry);
        pending = true;
        e.preventDefault();
        e.stopImmediatePropagation();
        var line = { navWrap: k === 38 ? 'up' : 'down', from: here, to: target, via: name };
        if (name !== picked) line.candidates = names.join(',');   // first use: how the method was found
        log(line);
        var started = Date.now(), err = null;
        try { guide[name](target); } catch (x) {
            failed = name;
            retryAfter = Date.now() + 1000;
            try { err = String(x); } catch (e) { err = 'selector threw'; }
        }
        setTimeout(function () {
            pending = false;
            var now = Date.now(), anotherKey = press !== keySerial;
            var leaf = focused();
            var clean = !anotherKey && up(leaf, 'YTLR-GUIDE-RESPONSE') === root &&
                root.__instance === guide && !(guide.props && guide.props.focused === false);
            var sel = selected(guide, null), fx = entryIndex(up(leaf, 'YTLR-GUIDE-ENTRY-RENDERER'));
            if (err === null && clean && sel === target && fx === target) { picked = name; failed = null; return; }
            var noOp = err === null && clean && startFocus === here && sel === here && fx === here;
            if (noOp) {
                failed = name;
                retryAfter = now + 1000;
            }
            log({ navWrapFailed: name, reason: noOp ? 'no-op' : 'inconclusive', target: target,
                selectedIndex: sel, focusIndex: fx, error: err, elapsedMs: now - started, anotherKey: anotherKey,
                others: names.slice(next + 1).concat(names.slice(0, next)) });
        }, 200);
    }, true);
})();
