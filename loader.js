// TT Extras loader: loaded by the patched TizenTube Cobalt app (see the README) instead of
// TizenTube's userscript. Loads a vetted copy of that userscript, then TT Extras' modules, all
// from one tagged release so a half-published change or a stale CDN cache can't mix versions.
//
// Copyright (C) 2026 TT Extras contributors. Licensed under the GNU General Public License v3.0 or later; see LICENSE.
(function () {
    var VERSION = 'v1.0.0';
    var MODULES = ['common.js', 'net.js', 'channels.js', 'extras.js', 'background.js', 'refresh.js', 'guest.js', 'block.js', 'subsfeed.js', 'subs.js', 'seek.js', 'shorts.js', 'saved.js', 'keyboard.js', 'nav.js'];
    var CDN = 'https://cdn.jsdelivr.net/gh/rnjnkr/tizentube-extras@' + VERSION + '/';

    // TizenTube's updater offers official releases, which can't install over this re-signed app.
    try {
        var config = JSON.parse(localStorage['ytaf-configuration'] || '{}');
        if (config.enableUpdater !== false) {
            config.enableUpdater = false;
            localStorage['ytaf-configuration'] = JSON.stringify(config);
        }
    } catch (e) {}

    // YouTube's page requires Trusted Types for script URLs; TizenTube's own injection is exempt
    // because it is native.
    var policy = null;
    try {
        if (window.trustedTypes && trustedTypes.createPolicy) {
            policy = trustedTypes.createPolicy('tizentube-extras-loader', {
                createScriptURL: function (url) { return url; }
            });
        }
    } catch (e) {}

    function load(src) {
        var script = document.createElement('script');
        script.src = policy ? policy.createScriptURL(src) : src;
        script.async = false; // run in order: TizenTube first
        (document.head || document.documentElement).appendChild(script);
    }

    function fromCdn() {
        load(CDN + 'vendor/tizentube/userScript.js');
        for (var i = 0; i < MODULES.length; i++) load(CDN + MODULES[i]);
    }

    fromCdn();
})();
