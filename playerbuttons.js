// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TT Extras contributors. See LICENSE.
// Regroup the normal player's two button pills after Next: Speed, CC, Settings and PiP in the first,
// like/dislike, comments and save in the second. Done in the row data, so D-pad focus follows.
// TizenTube patches each instance as it is constructed, so wrap the finished instance to see Speed
// and PiP; a player built before the hook is patched in place once its element is found.
// A setting change takes effect on the next row build, which may require reopening the player.
(function () {
    if (location.hostname !== 'www.youtube.com') return;
    if (window.__tizentubeExtrasPlayerButtons) return;
    window.__tizentubeExtrasPlayerButtons = true;

    var X = window.__ttx;
    if (!X) return;

    var KEY = 'playerButtonsFirst';
    var ENGAGEMENT = 'props.data.engagementActions';
    var FEATURED = 'TRANSPORT_CONTROLS_BUTTON_TYPE_FEATURED_ACTION';
    var PLAYBACK_SETTINGS = 'TRANSPORT_CONTROLS_BUTTON_TYPE_PLAYBACK_SETTINGS';
    var SPEED = 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED';
    var PIP = 'TRANSPORT_CONTROLS_BUTTON_TYPE_PIP';
    var loggedTypes = false, loggedMissing = false, loggedFailures = {};

    function enabled() { return X.settings.get(KEY, false) === true; }

    X.settingsRow(KEY, function () {
        return X.row({
            title: 'Player buttons',
            subtitle: 'Speed, CC, settings and PiP in their own group after Next',
            icon: 'SETTINGS',
            secondaryIcon: enabled() ? 'CHECK_BOX' : 'CHECK_BOX_OUTLINE_BLANK',
            commands: [{ tizentubeExtrasCommand: { togglePlayerButtonsFirst: true } }]
        });
    });

    X.onCommand('togglePlayerButtonsFirst', function () {
        X.settings.set(KEY, !enabled());
        X.refreshSettings(KEY);
    });

    function missing() {
        if (loggedMissing) return;
        loggedMissing = true;
        X.log({ playerButtons: 'engagement method not found' });
    }

    function buttonType(button) {
        return button && typeof button.type === 'string' ? button.type : '';
    }

    function failure(message) {
        if (loggedFailures[message]) return;
        loggedFailures[message] = true;
        X.log({ playerButtons: message });
    }

    // The player controls that go into the first pill after Speed, in this order.
    function controlRank(type) {
        return /CAPTION|SUBTITLE/i.test(type) ? 0 : type === PLAYBACK_SETTINGS ? 1 : type === PIP ? 2 : -1;
    }
    // CC, Settings and PiP from the second list, in pill order (first of each kind).
    function controlsOf(second) {
        var out = [null, null, null];
        for (var i = 0; second && i < second.length; i++) {
            var rank = controlRank(buttonType(second[i]));
            if (rank !== -1 && !out[rank]) out[rank] = second[i];
        }
        return out.filter(function (b) { return b; });
    }
    function typeSet(list) {
        var set = {};
        for (var i = 0; list && i < list.length; i++) set[buttonType(list[i])] = true;
        return set;
    }
    // The engagement buttons that move to the second pill: all but Speed.
    function socialOf(first) {
        return first ? first.filter(function (b) { return buttonType(b) !== SPEED; }) : [];
    }

    function patchInstance(instance, engagementName, rowName) {
        var engagement = instance[engagementName];
        if (typeof engagement !== 'function') return missing();
        if (engagement.__ttxPlayerButtons) return true;
        var buildSecond = rowName && rowName !== engagementName && instance[rowName];

        function read(fn, receiver, what) {
            if (typeof fn !== 'function') return failure(what + ' method not found');
            var buttons;
            try { buttons = fn.call(receiver); }
            catch (e) { return failure(what + ' method threw'); }
            if (!Array.isArray(buttons)) return failure(what + ' method did not return an array');
            return buttons;
        }

        function speedFirst(buttons) {
            var speed = buttons.filter(function (b) { return buttonType(b) === SPEED; });
            return speed.concat(buttons.filter(function (b) { return buttonType(b) !== SPEED; }));
        }

        // Each pill reads the other builder without arguments. That read equals YouTube's own call (same
        // buttons, same commands) only if YouTube calls both builders without arguments, so regroup only after
        // both have been seen called that way in an earlier build (both pills then switch on the same build);
        // a call with arguments or without a list switches regrouping off for this player.
        var seenFirst = false, seenSecond = false, trusted = false, distrusted = false;
        function distrust() { trusted = false; distrusted = true; }
        function observe(which, args, buttons) {
            var was = trusted;
            if (args.length !== 0 || !Array.isArray(buttons)) {
                if (!distrusted) failure(which + ' builder called with ' + args.length + ' argument(s) or no list; regrouping off');
                distrust();
                return false;
            }
            if (which === 'first') seenFirst = true; else seenSecond = true;
            if (!distrusted && seenFirst && seenSecond) trusted = true;
            return was && trusted;
        }

        function buildEngagement() {
            var buttons = engagement.apply(this, arguments);
            if (typeof buildSecond !== 'function') {
                // No second pill: only Speed can move, within this one.
                if (!Array.isArray(buttons) || !enabled() || X.onShortsPage()) return buttons;
                failure('second-list method not found');
                return speedFirst(buttons);
            }
            if (!observe('first', arguments, buttons) || !enabled() || X.onShortsPage()) return buttons;
            var second = read(buildSecond, this, 'second-list');
            if (!second) { distrust(); return buttons; }
            if (!loggedTypes) {
                loggedTypes = true;
                X.log({ playerButtons: 'types', engagement: buttons.map(buttonType), second: second.map(buttonType) });
            }
            // Everything but Speed goes to the second pill; CC, Settings and PiP come from it.
            return buttons.filter(function (b) { return buttonType(b) === SPEED; }).concat(controlsOf(second));
        }
        buildEngagement.__ttxPlayerButtons = true;
        instance[engagementName] = buildEngagement;

        if (typeof buildSecond === 'function') instance[rowName] = function () {
            var buttons = buildSecond.apply(this, arguments);
            if (!observe('second', arguments, buttons) || !enabled() || X.onShortsPage()) return buttons;
            var first = read(engagement, this, 'first-list');
            if (!first) { distrust(); return buttons; }
            var leaving = typeSet(controlsOf(buttons));
            return socialOf(first).concat(buttons.filter(function (b) { return !leaving[buttonType(b)]; }));
        };
        return true;
    }

    function source(fn) {
        return typeof fn === 'function' ? Function.prototype.toString.call(fn) : '';
    }

    function methodName(body, marker) {
        // TizenTube finds assignments in the original constructor, even when the instance method's
        // source has since been replaced. Recognize function, arrow and function IIFE assignments.
        var assignment = /(?:^|[^\w$.])[\w$]+\.([\w$]+)\s*=\s*\(*\s*(?:function\b|(?:\([^()]*\)|[\w$]+)\s*=[>])/g;
        var at = body.indexOf(marker), name = null, match;
        while (at !== -1 && (match = assignment.exec(body)) && match.index < at) name = match[1];
        return name;
    }

    function wrapConstructor(original, engagementName, rowName, state) {
        var isClass = /^class\s/.test(source(original));
        function Controls() {
            var constructing = this instanceof Controls, result;
            if (constructing && isClass) {
                var args = [null].concat(Array.prototype.slice.call(arguments));
                var Bound = Function.prototype.bind.apply(original, args);
                result = new Bound();
            } else {
                result = original.apply(this, arguments);
            }
            var instance = result && (typeof result === 'object' || typeof result === 'function')
                ? result : constructing && this;
            if (instance && !state.retired) {
                try { patchInstance(instance, engagementName, rowName); }
                catch (e) { missing(); }
            }
            return result;
        }
        Controls.prototype = original.prototype;
        Object.getOwnPropertyNames(original).forEach(function (key) {
            if (!(key in Controls)) Object.defineProperty(Controls, key, Object.getOwnPropertyDescriptor(original, key));
        });
        if (Object.setPrototypeOf) Object.setPrototypeOf(Controls, Object.getPrototypeOf(original));
        // TizenTube uses the registry value's toString both to find it and to parse its assignments.
        Object.defineProperty(Controls, 'toString', { value: function () { return original.toString(); } });
        return Controls;
    }

    function patchAdded(records, patchElement) {
        for (var i = 0; i < records.length; i++) {
            var added = records[i].addedNodes;
            for (var j = 0; j < added.length; j++) {
                var node = added[j];
                if (node.nodeType !== 1) continue;
                if (patchElement(node)) return true;
                var descendants = node.getElementsByTagName('*');
                for (var k = 0; k < descendants.length; k++) if (patchElement(descendants[k])) return true;
            }
        }
        return false;
    }

    function hook(registry, key, ctor, body, alreadyPatched) {
        var engagementName = methodName(body, ENGAGEMENT);
        if (!engagementName) return missing();
        var rowName = methodName(body, PLAYBACK_SETTINGS);
        var slot = Object.getOwnPropertyDescriptor(registry, key);
        if (!slot || !slot.writable || (!alreadyPatched && !slot.configurable)) return missing();

        var state = { retired: false };
        var wrapped = wrapConstructor(ctor, engagementName, rowName, state);
        var proto = ctor.prototype;
        function patchElement(element) {
            var inst = element.__instance;
            if (!inst || typeof inst !== 'object' || !proto.isPrototypeOf(inst)) return false;
            try { return patchInstance(inst, engagementName, rowName); }
            catch (e) { missing(); return false; }
        }
        if (alreadyPatched) {
            registry[key] = wrapped;
            return patchElement;
        }

        // The vendor waits for a video and then assigns its constructor to this slot. Catch that
        // assignment synchronously and retire the earlier wrapper that the vendor captured.
        Object.defineProperty(registry, key, {
            enumerable: slot.enumerable,
            configurable: true,
            get: function () { return wrapped; },
            set: function (replacement) {
                if (replacement === wrapped) return;
                state.retired = true;
                slot.value = typeof replacement === 'function' && replacement.prototype === ctor.prototype
                    ? wrapConstructor(replacement, engagementName, rowName, { retired: false }) : replacement;
                Object.defineProperty(registry, key, slot);
            }
        });
        return patchElement;
    }

    // Constructors already looked at, so each is stringified once (the registry holds hundreds).
    var checked = {}, checkedRegistry = null;
    function install() {
        var registry = window._yttv;
        if (!registry) return false;
        if (registry !== checkedRegistry) { checked = {}; checkedRegistry = registry; }
        var keys = Object.keys(registry);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i], ctor = registry[key];
            if (checked[key] === ctor) continue;
            checked[key] = ctor;
            if (typeof ctor !== 'function' || !ctor.prototype) continue;
            var body = source(ctor);
            var alreadyPatched = body.indexOf(FEATURED) === -1;
            if (alreadyPatched) {
                // The vendor keeps the original prototype and its constructor when it wraps.
                if (body.indexOf(ENGAGEMENT) === -1 || body.indexOf(PLAYBACK_SETTINGS) === -1) continue;
                body = source(ctor.prototype.constructor);
                if (body.indexOf(FEATURED) === -1) continue;
            }
            var patchElement = null;
            try { patchElement = hook(registry, key, ctor, body, alreadyPatched); }
            catch (e) { missing(); }
            if (!patchElement) continue;   // a look-alike: keep looking for the real one
            checked = {};
            checkedRegistry = null;
            var all = document.getElementsByTagName('*'), live = 0;
            for (var j = 0; j < all.length; j++) if (patchElement(all[j])) live++;
            X.log({ playerButtons: 'hooked', alreadyPatched: alreadyPatched, live: live });
            return { patchElement: patchElement, live: live };
        }
        return false;
    }

    function discover() {
        var hooked = install();
        if (hooked && hooked.live) return;
        // After hooking, inspect only new DOM branches until the reusable player is found.
        var lastCount = -1, lastRegistry = null;
        var observer = new MutationObserver(function (records) {
            if (hooked) {
                if (patchAdded(records, hooked.patchElement)) observer.disconnect();
                return;
            }
            // Registration can be late. Rescan only when the registry grows or changes identity.
            var registry = window._yttv, count = registry ? Object.keys(registry).length : -1;
            if (count === lastCount && registry === lastRegistry) return;
            lastCount = count;
            lastRegistry = registry;
            tryHook();
        });
        function tryHook() {
            hooked = install();
            if (!hooked) return false;
            lastRegistry = null;
            document.removeEventListener('loadedmetadata', onMetadata, true);
            if (hooked.live) observer.disconnect();
            return true;
        }
        function onMetadata(event) {
            if (!event.target || event.target.nodeName !== 'VIDEO' || !X.isWatch() || X.onShortsPage()) return;
            if (tryHook()) return;
            missing();
            observer.disconnect();
            document.removeEventListener('loadedmetadata', onMetadata, true);
        }
        observer.observe(document.documentElement, { childList: true, subtree: true });
        if (!hooked) document.addEventListener('loadedmetadata', onMetadata, true);
    }

    discover();
})();
