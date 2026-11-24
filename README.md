# TizenTube Extras

TT Extras adds features to [TizenTube](https://github.com/reisxd/TizenTube)'s userscript for the
YouTube TV web app in TizenTube Cobalt. The patched app loads the scripts from this repo through jsDelivr.

To build and install the app, follow [INSTALL.md](INSTALL.md). It uses `patch-apk.py` and the icons in `icons/`.

## Features

- Guest auto-login takes you straight to Home when signed out. You can turn it off in settings.
- Follow channels without an account. Local Subscriptions appear in a Home row and on a sidebar page.
  Scroll through the video rows to load older videos.
- Watch history stays on the TV. Find videos in the Recently watched row on Home or on the History page.
- Save Shorts from the player and find them on the Saved page in the sidebar.
- Block individual videos or whole channels from a tile's long-press menu. Unblock them in settings.
- On Home, Shorts appear only in Shorts rows.
- Refresh Home from the top bar next to the microphone or from the sidebar just below Home.
- Search with an English QWERTY keyboard and number row. In the sidebar, Up and Down wrap around.
- Double-press Left or Right to seek 10 seconds in a video or 5 seconds in a Short. In the Shorts
  player, press Left once with the video focused to choose a playback speed from 0.5× to 2×.
- Optionally move the player's speed, captions, settings and picture-in-picture buttons into their own
  group right after Next.
- Choose an optional YouTube Premium logo or a background picture in settings.

## Background pictures

Turn on Background in settings to show a dimmed picture behind every page except the video player.
Pictures live in `backgrounds/`, with file names listed in `backgrounds/backgrounds.json`.
The included picture is “TON 618” by Denniszeng (Wikimedia Commons, CC0).

## How updates work

The loader runs a vetted copy of TizenTube's userscript from `vendor/tizentube/`, then loads the
TT Extras modules from the same tagged release. New upstream releases are checked automatically
after a seven-day wait and published only after manual review.

## License

TT Extras is licensed under GPL-3.0-or-later. See [LICENSE](LICENSE).
