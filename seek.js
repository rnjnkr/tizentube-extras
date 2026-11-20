// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TT Extras contributors. See LICENSE.
// Double-press D-pad left/right on the watch page to seek -/+10 s.
(function () {
    if (location.hostname !== 'www.youtube.com') return;
    if (window.__tizentubeExtrasSeek) return;
    window.__tizentubeExtrasSeek = true;

    var X = window.__ttx;   // common.js, loaded first (loader.js)
    if (!X) return;
    var DEV = X.DEV, log = X.log;

    var GAP = 400;
    var STEP = 10;
    var last = { key: 0, time: 0, armed: false, burst: false, target: -1, seekAt: 0 };

    function toast(text) {
        try { X.toast(text); } catch (e) {}
    }

    function getPlayer() {
        var p = document.querySelector('.html5-video-player');
        return p && p.getCurrentTime && p.seekTo ? p : null;
    }

    // Natively, with the controls hidden the focus is on <ytlr-watch-default>; the first LEFT/RIGHT
    // only shows the controls and focuses the progress bar, where further presses start a native
    // 10 s scrub preview that needs OK to commit. So a press counts as the start of a double
    // press only when the controls were hidden, and the burst then continues (each extra press
    // within GAP seeks another 10 s) so it is not handed to the native scrubber.
    function controlsHidden() {
        var a = document.activeElement;
        return !!a && a.nodeName === 'YTLR-WATCH-DEFAULT';
    }

    window.addEventListener('keydown', function (e) {
        var k = e.keyCode;
        // Any other key, or leaving the watch page, ends a pending double press (RIGHT, OK, RIGHT).
        if ((k !== 37 && k !== 39) || location.hash.indexOf('#/watch') !== 0 || (X.isShorts && X.isShorts())) {
            last.armed = false;
            last.burst = false;
            return;
        }
        // The event's own timestamp, so slow handling of the first press does not eat into GAP
        // (both clocks are never mixed within a run; Date.now() only if timeStamp is unusable).
        var now = e.timeStamp > 0 ? e.timeStamp : Date.now();
        // Key held after a double press: swallow the repeats so they do not reach the native scrubber.
        if (e.repeat && last.burst && last.key === k && now - last.time < GAP) {
            e.preventDefault();
            e.stopImmediatePropagation();
            last.time = now;
            return;
        }
        var continuing = last.armed && last.key === k && now - last.time < GAP && !e.repeat;
        if (!continuing) {
            last.key = k;
            last.time = now;
            last.armed = controlsHidden();
            last.burst = false;
            return;
        }
        var player = getPlayer();
        if (!player) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        last.time = now; // a further press within GAP of this one seeks again
        last.burst = true;
        // The player may not report the new position yet when presses chain.
        var from = last.target >= 0 && now - last.seekAt < 1000 ? last.target : player.getCurrentTime();
        if (!isFinite(from)) return;
        var dur = player.getDuration();
        var to = from + (k === 39 ? STEP : -STEP);
        if (to < 0) to = 0;
        // Never seek to the very end (it would end the video and autoplay the next). Live streams
        // report a 0/NaN/Infinity duration: no clamp there, the player limits to the live edge and
        // seeking back works as usual.
        if (isFinite(dur) && dur > 0) {
            var max = dur - 1;
            if (k === 39 && from >= max) return; // already at the end margin: swallow, do nothing
            if (to > max) to = max;
        }
        if (!isFinite(to)) return;
        player.seekTo(to, true);
        last.target = to;
        last.seekAt = now;
        toast(k === 39 ? '+10s' : '\u221210s');
        log({ seek: k === 39 ? '+10' : '-10', from: from, to: to, t: now });
        if (DEV) setTimeout(function () {
            var st = player.getPlayerStateObject && player.getPlayerStateObject();
            log({ seekCheck: player.getCurrentTime(), playing: st && st.isPlaying, paused: st && st.isPaused });
        }, 3000);
    }, true);
})();
