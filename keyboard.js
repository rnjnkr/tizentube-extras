// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TT Extras contributors. See LICENSE.
// QWERTY search keyboard: replaces YouTube TV's alphabetical English search keyboard layout
// (8 columns, A-Z) with a number row + QWERTY rows. Patches the live layout object of the
// <ytlr-search-keyboard> component in place; fails safe (does nothing) if anything is missing.
//
// Name-independent (build/robust-nav-keyboard.md): the re-render goes through the component's state
// setter, found by structure (the 1-argument method on the instance or its prototype chain whose source
// merges into this.state: Object.assign({},this.state,x)) instead of by its minified name (J until the
// 2026-11-17 YouTube update, then K). The data we touch uses non-minified names (state.layout.frames,
// 'LETTER_LAYOUT', key label/action). The focus-position state key is found by shape ({row, col}).
// The effect is validated on screen; if it doesn't hold, the old rows are put back and patching stops.
(function () {
    if (window.__tizentubeExtrasKeyboard) return;
    window.__tizentubeExtrasKeyboard = true;
    var X = window.__ttx;
    if (!X) return;

    var warned = false;
    var broken = false;     // J misbehaved: stop patching
    function warn(why) {
        if (warned) return;
        warned = true;
        X.log({ keyboard: 'skipped', why: why });
    }

    function label(k) { return k && typeof k.label === 'string' ? k.label : ''; }

    function clone(src, over) {
        var o = {}, p;
        for (p in src) o[p] = src[p];
        for (p in over) o[p] = over[p];
        return o;
    }

    // The component's setState: a 1-arg function that merges its argument into this.state. Searched on
    // the instance and up its prototype chain; the name is cached for the session (fast path).
    var setterName = null;
    function isSetter(f) {
        if (typeof f !== 'function' || f.length !== 1) return false;
        var t;
        try { t = Function.prototype.toString.call(f); } catch (e) { return false; }
        // A method, not a class (a class body would contain the setter's source too).
        return !/^class[\s{]/.test(t) && t.length < 400 && /Object\.assign\(\{\},this\.state,[\w$]+\)/.test(t);
    }
    function findSetter(inst) {
        if (setterName && isSetter(inst[setterName])) return setterName;
        for (var o = inst, d = 0; o && o !== Object.prototype && d < 10; o = Object.getPrototypeOf(o), d++) {
            var names = Object.getOwnPropertyNames(o);
            for (var i = 0; i < names.length; i++) {
                if (names[i] === 'constructor') continue;
                var desc = Object.getOwnPropertyDescriptor(o, names[i]);
                if (desc && isSetter(desc.value)) return (setterName = names[i]);
            }
        }
        return null;
    }

    // Finds the focus-position state key (an object {row, col} of numbers); null if none.
    function focusKey(state) {
        var keys = Object.keys(state || {});
        for (var i = 0; i < keys.length; i++) {
            var v = state[keys[i]];
            if (v && typeof v === 'object' && typeof v.row === 'number' && typeof v.col === 'number') return keys[i];
        }
        return null;
    }

    function patch(el) {
        var inst = el.__instance;
        var frames = inst && inst.state && inst.state.layout && inst.state.layout.frames;
        if (!frames || typeof frames.get !== 'function') return warn('no layout.frames');
        var frame = frames.get('LETTER_LAYOUT');
        var rows = frame && frame.keys;
        if (!Array.isArray(rows) || !Array.isArray(rows[0]) || !rows[0].length) return warn('no LETTER_LAYOUT rows');

        // Already patched, or not the default English alphabetical layout: leave alone.
        if (label(rows[0][0]) === '1') return;
        if (label(rows[0][0]) !== 'A' || rows[0][0].action !== 'TEXT') return;
        var set = findSetter(inst);
        if (!set) {     // won't appear later this session: stop observing
            broken = true;
            mo.disconnect();
            return warn('no state setter; own fns: ' + Object.keys(inst).filter(function (n) { return typeof inst[n] === 'function'; }).join(','));
        }

        var all = [].concat.apply([], rows);
        var proto = null, bs = null, num = null, i;
        for (i = 0; i < all.length; i++) {
            if (!proto && all[i].action === 'TEXT' && /^[A-Z]$/.test(label(all[i]))) proto = all[i];
            if (!bs && all[i].action === 'BACKSPACE') bs = all[i];
            if (!num && all[i].action === 'NUMBER_LAYOUT') num = all[i];
        }
        if (!proto || !bs || !num) return warn('missing template keys');

        function T(c) {
            var over = { label: c.toUpperCase(), ariaLabel: c };
            if ('value' in proto) over.value = c;   // typed text is value || label
            return clone(proto, over);
        }
        var out = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'].map(function (r) { return r.split('').map(T); });
        out[2].push(bs);
        out[3].push(num);

        var old = rows.slice(), fk = focusKey(inst.state);
        function restore(why) {
            broken = true;
            rows.length = 0;
            old.forEach(function (r) { rows.push(r); });
            warn(why);
            mo.disconnect();
        }
        rows.length = 0;
        out.forEach(function (r) { rows.push(r); });
        var upd = {};
        if (fk) upd[fk] = { row: 1, col: 0 };
        try { inst[set](upd); } catch (e) { restore(set + ' threw: ' + e); return; }
        X.log({ keyboard: 'qwerty', setter: set, focusKey: fk });
        // The setter was found by structure: the screen must show the number row, else the model
        // (QWERTY) and the screen (A-Z) would disagree, so put the old rows back and stop.
        setTimeout(function () {
            if (broken || !el.isConnected && !document.contains(el)) return;
            if ((el.textContent || '').replace(/\s+/g, '').indexOf('1234567890') === -1) restore('screen not updated via ' + set);
        }, 300);
    }

    var els = document.getElementsByTagName('ytlr-search-keyboard');
    function check() {
        for (var i = 0; i < els.length && !broken; i++) {
            try { patch(els[i]); } catch (e) { warn('' + e); }
        }
    }

    // Cheap detection: a childList observer that only does a live-collection length check.
    var mo = new MutationObserver(function () {
        if (els.length) check();
    });
    function start() {
        mo.observe(document.documentElement, { childList: true, subtree: true });
        check();
    }
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start);
})();
