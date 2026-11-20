// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TT Extras contributors. See LICENSE.
// "Login as Guest automatically": when YouTube TV opens on its signed-out welcome screen
// ("Get started" / sign in / "Watch as guest"), pick "Watch as guest" so the app goes straight
// to Home. On by default; a check box row in TizenTube's settings turns it off.
(function () {
    if (location.hostname !== 'www.youtube.com') return;
    if (window.__tizentubeExtrasGuest) return;
    window.__tizentubeExtrasGuest = true;

    var X = window.__ttx;
    if (!X) return;

    var ATTEMPTS_KEY = 'tizentube-extras-guest-attempts';
    var GUEST = 'UNAUTHENTICATED_IDENTITY_TYPE_GUEST';
    var ON_EXIT = 'ACCOUNT_EVENT_TRIGGER_ON_EXIT';
    // The welcome screens shown at startup and on BACK-exit ("Welcome back"); the same page can
    // be reached from other sign-in flows, which are left alone.
    var TRIGGERS = { ACCOUNT_EVENT_TRIGGER_APP_WELCOME: 1, ACCOUNT_EVENT_TRIGGER_WELCOME_BACK: 1 };
    TRIGGERS[ON_EXIT] = 1;

    // ---------------------------------------------------------------- Settings

    function autoGuest() {
        return X.settings.get('autoGuest') !== false;
    }
    if (X.settings.get('autoGuest') === undefined) X.settings.set('autoGuest', true);

    // ---------------------------------------------------------------- Settings row and commands

    // In TizenTube's settings list, before "Ad block" (common.js places it at index 2).
    X.settingsRow('autoGuest', function () {
        return X.row({
            title: 'Login as Guest automatically',
            subtitle: 'Skip the sign-in and Welcome back screens',
            icon: 'EXIT_TO_APP',
            secondaryIcon: autoGuest() ? 'CHECK_BOX' : 'CHECK_BOX_OUTLINE_BLANK',
            commands: [{ tizentubeExtrasCommand: { toggleAutoGuest: true } }]
        });
    });

    X.onCommand('toggleAutoGuest', function () {
        X.settings.set('autoGuest', !autoGuest());
        // Rebuilds TizenTube's popup in place, keeping our row selected.
        X.refreshSettings('autoGuest');
        updateHiding();
    });

    // Signed out, BACK from Home opens "Welcome back" instead of leaving the app: just leave, as
    // TizenTube does for the "Who's watching" exit screen.
    X.onAnyCommand(function (cmd) {
        if (cmd && cmd.startWelcomeCommand && autoGuest() && eventTrigger(cmd.startWelcomeCommand.identityActionContext) === ON_EXIT) {
            X.log({ guest: 'exit' });
            return { replace: { signalAction: { signal: 'EXIT_APP' } } };
        }
    });

    // ---------------------------------------------------------------- Welcome screen

    var welcomes = document.getElementsByTagName('ytlr-welcome');

    function eventTrigger(ctx) {
        return ctx && typeof ctx === 'object' ? ctx.eventTrigger : undefined;
    }

    // Looks in the page's own data for the screen's identityActionContext (bounded search).
    function findContext(root) {
        var seen = [], found = null;
        (function walk(o, depth) {
            if (found || !o || typeof o !== 'object' || depth > 6 || o.nodeType || seen.length > 3000) return;
            if (seen.indexOf(o) !== -1) return;
            seen.push(o);
            if (o.identityActionContext && eventTrigger(o.identityActionContext)) { found = o.identityActionContext; return; }
            var keys = Object.keys(o);
            for (var i = 0; i < keys.length && i < 80 && !found; i++) {
                var v;
                try { v = o[keys[i]]; } catch (e) { continue; }
                walk(v, depth + 1);
            }
        })(root, 0);
        return found;
    }

    // The command YouTube itself would run for "Watch as guest", or null if not ready yet.
    // Stage 2 (sign-in options): the guest item's own serviceEndpoint. Stage 1 ("Get started"):
    // the same command built from the screen's identityActionContext.
    function guestCommand(welcome) {
        var items = welcome.getElementsByTagName('ytlr-compact-link-renderer');
        for (var i = 0; i < items.length; i++) {
            var inst = items[i].__instance;
            var ep = inst && inst.props && inst.props.data && inst.props.data.serviceEndpoint;
            if (ep && ep.switchToGuestMode) return { how: 'item', cmd: ep, trigger: eventTrigger(ep.switchToGuestMode.identityActionContext) };
        }
        var ctx = welcome.__instance && findContext(welcome.__instance.props);
        if (ctx) return { how: 'context', cmd: { switchToGuestMode: { identityActionContext: ctx, identityType: GUEST } }, trigger: eventTrigger(ctx) };
        return null;
    }

    function fallbackCommand() {
        return { how: 'fallback', cmd: { switchToGuestMode: { identityType: GUEST, identityActionContext: {
            eventTrigger: 'ACCOUNT_EVENT_TRIGGER_STANDARD', nextEndpoint: { browseEndpoint: { browseId: 'default' } } } } } };
    }

    // At most 3 tries a minute, across reloads too, so a failing switch can never spin.
    function takeAttempt() {
        var now = Date.now(), list;
        try { list = JSON.parse(localStorage[ATTEMPTS_KEY] || '[]'); } catch (e) { list = []; }
        if (!(list instanceof Array)) list = [];
        list = list.filter(function (t) { return t > now - 60000 && t <= now; });
        if (list.length >= 3) return false;
        list.push(now);
        try { localStorage[ATTEMPTS_KEY] = JSON.stringify(list); } catch (e) {}
        return true;
    }

    var timer = null, current = null, firstSeen = 0, lastTry = 0, released = null;
    // When the page started or the app came back to the front: a welcome screen whose context can't be
    // read is only taken for the startup one if it appears within STARTUP_MS of either.
    var STARTUP_MS = 20000, startedAt = Date.now();

    // While we handle it the screen is kept transparent, so normally it never shows at all; it
    // is shown again if we leave it alone or give up. Inline opacity on the element: CSP blocks our
    // own <style>. Set from the MutationObserver callback, which runs before the screen is painted.
    function updateHiding() {
        if (!welcomes.length) return;
        var w = welcomes[0], want = autoGuest() && w !== released ? '0' : '';
        try { if (w.style.opacity !== want) w.style.opacity = want; } catch (e) {}
    }
    function release(welcome) {
        released = welcome;
        updateHiding();
    }

    function schedule(delay) {
        if (timer === null) timer = setTimeout(check, delay);
    }

    function check() {
        timer = null;
        // No welcome screen: drop the references, so a removed screen is not kept in memory.
        if (!welcomes.length) { current = null; released = null; return; }
        updateHiding();
        if (!autoGuest()) return;
        var welcome = welcomes[0], now = Date.now();
        if (welcome === released) return;
        if (welcome !== current) {
            current = welcome;
            firstSeen = now;
            lastTry = 0;
        }
        if (lastTry && now - lastTry < 3000) return schedule(3000 - (now - lastTry));
        var found = guestCommand(welcome);
        if (!found) {
            if (now - firstSeen < 1500) return schedule(250);
            if (firstSeen - startedAt > STARTUP_MS) return release(welcome); // maybe a sign-in you opened
            found = fallbackCommand();
        } else if (!TRIGGERS[found.trigger]) {
            return release(welcome); // another sign-in flow: leave it alone
        }
        if (!takeAttempt()) return release(welcome);
        lastTry = now;
        X.log({ guest: found.how, trigger: found.trigger, afterMs: now - firstSeen });
        X.resolveCommand(found.cmd);
        schedule(3000);
    }

    var shown = null; // the welcome element updateHiding() last saw from the observer
    new MutationObserver(function () {
        if (!welcomes.length) { current = released = shown = null; return; }
        if (welcomes[0] !== shown) { shown = welcomes[0]; updateHiding(); }
        schedule(0);
    }).observe(document.documentElement, { childList: true, subtree: true });
    // Cobalt resumes the same page when the app is reopened, possibly still on a welcome screen.
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'hidden') { startedAt = Date.now(); schedule(0); }
    });
    updateHiding();
    schedule(0);
})();
