// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TT Extras contributors. See LICENSE.
// Sidebar (guide) focus wraps around: UP on the first item goes to the last, DOWN on the last to the first.
//
// Built to survive minified-name changes (the select method was fa() until the 2026-11-17 YouTube
// update, then ga()): the method is found by behaviour, not by name (build/robust-nav-keyboard.md).
//  - Where focus is: the deepest .zylon-focus element (YouTube's own focus path; document.activeElement
//    can be stale in this app), activeElement only as a fallback; the guide's named `focused` prop must agree.
//  - Which entry is selected: the guide's named `selectedIndex` getter, else the focused entry's props.index.
//  - Top/bottom: the rendered <ytlr-guide-entry-renderer>s (named props `index`, `hidden`).
//  - The select method: an own 1-argument function of the guide instance that the guide's own named
//    handlers (onRightFocus, onBack, a ()=>{this.N(-1)} wrapper) call with an index, or whose source
//    selects by index (-1 = account entry). The pick is cached and validated after every call: the
//    guide's selectedIndex and the focused entry must both be the target, else the name is blacklisted;
//    after 2 failures wrapping is off for the session. A failure never swallows later keys.
(function () {
    if (location.hostname !== 'www.youtube.com') return;
    if (window.__tizentubeExtrasNav) return;
    window.__tizentubeExtrasNav = true;

    var X = window.__ttx;   // common.js, loaded first (loader.js)
    if (!X) return;
    var log = X.log;

    var broken = false;     // wrapping off for the session
    var failures = 0;
    var picked = null;      // validated method name (session cache)
    var bad = {};           // names that failed validation
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
        return !NAMED[n] && !bad[n] && Object.prototype.hasOwnProperty.call(guide, n) &&
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
        // Broad last resort (it can match unrelated code): only when the specific patterns found nothing.
        for (i = 0; !out.length && i < keys.length; i++) {
            var t = src(guide[keys[i]]);
            if (/===-1/.test(t) && /selectedIndex===/.test(t)) add(keys[i]);
        }
        return out;
    }

    window.addEventListener('keydown', function (e) {
        var k = e.keyCode;
        if ((k !== 38 && k !== 40) || e.repeat || broken || pending) return;
        var f = focused();
        var entry = f && up(f, 'YTLR-GUIDE-ENTRY-RENDERER');
        var root = entry && up(entry, 'YTLR-GUIDE-RESPONSE');
        var guide = root && root.__instance;
        if (!guide || (guide.props && guide.props.focused === false)) return;

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

        var names = candidates(guide), name = names[0];
        if (!name) {
            broken = true;
            log({ navWrapDisabled: 'no select method', ownFns: Object.keys(guide).filter(function (n) { return typeof guide[n] === 'function'; }).join(',') });
            return;   // key not swallowed: the guide handles it natively
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        var line = { navWrap: k === 38 ? 'up' : 'down', from: here, to: target, via: name };
        if (name !== picked) line.candidates = names.join(',');   // first use: how the method was found
        log(line);
        var ok = true, err = null;
        try { guide[name](target); } catch (x) { ok = false; err = String(x); }
        // The effect must hold: the guide's selection and YouTube's focus are both on the target entry.
        pending = true;
        setTimeout(function () {
            pending = false;
            var sel = null, fx = null;
            if (ok) {
                sel = selected(guide, null);
                fx = entryIndex(up(focused(), 'YTLR-GUIDE-ENTRY-RENDERER'));
                ok = sel === target && fx === target;
            }
            if (ok) { picked = name; failures = 0; return; }
            bad[name] = true;
            if (picked === name) picked = null;
            failures++;
            if (failures >= 2) broken = true;
            log({ navWrapFailed: name, target: target, selectedIndex: sel, focusIndex: fx, error: err, disabled: broken, others: names.slice(1) });
        }, 200);
    }, true);
})();
