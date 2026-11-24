# Installing TT Extras

TT Extras runs inside [TizenTube Cobalt](https://github.com/reisxd/TizenTubeCobalt), the YouTube TV app for
Android TV and Google TV. You build the app yourself: download the official TizenTube Cobalt APK, patch it
with `patch-apk.py` from this repo so it loads TT Extras, sign it with your own key, and install it over
your network with `adb`. The result installs next to TizenTube as a separate app called **TT Extras**.

The steps are written for a person or an AI agent to follow. Each step says what to run, what you should
see, and where to stop. Steps marked **(you)** need the person at the TV or keyboard. An agent should ask
them to do it and wait.

## Before you start

You need:

- An Android TV or Google TV device on the same network as your computer.
- A macOS, Linux or Windows computer with:
  - Python 3.8 or newer (`python3 --version`)
  - Java 17 or newer (`java -version`), for `keytool` and `apksigner`
  - The Android SDK **build tools** (`zipalign`, `apksigner`) and **platform tools** (`adb`)

To get the Android tools, use one of these:

- **Android Studio.** It installs both into its SDK folder, and `patch-apk.py` finds them there.
- **Command-line tools.** Install Google's
  [command-line tools](https://developer.android.com/studio#command-line-tools-only), then run:
  `sdkmanager "platform-tools" "build-tools;34.0.0"`.
  On macOS with Homebrew: `brew install --cask android-commandlinetools`.
- **Debian or Ubuntu:** `sudo apt install adb apksigner zipalign`.

If `adb` isn't on your PATH, call it by its full path, `<sdk>/platform-tools/adb`.

Get this repo, which has `patch-apk.py` and the app icons in `icons/`:

```sh
git clone https://github.com/rnjnkr/tizentube-extras.git
cd tizentube-extras
```

## 1. Connect to the TV (you)

1. On the TV, turn on Developer options. On Google TV this is **Settings → System → About**: select
   **Android TV OS build** seven times.
2. In **Settings → System → Developer options**, turn on **USB debugging**. On some TVs it's called
   **Network debugging** or **Wireless debugging**.
3. Find the TV's IP address in **Settings → Network & Internet** (select your network).

Then, on the computer, with the TV's address in place of `TV_IP`:

```sh
adb connect TV_IP:5555
```

**(you)** The TV asks whether to allow debugging. Choose **Always allow from this computer**, then **Allow**.

**Check:** `adb devices` lists `TV_IP:5555   device`. If it says `unauthorized`, accept the prompt on the TV.
If several devices are listed, add `-s TV_IP:5555` to every `adb` command below.

## 2. Download TizenTube Cobalt

Find the TV's processor type:

```sh
adb shell getprop ro.product.cpu.abi
```

From the [latest TizenTube Cobalt release](https://github.com/reisxd/TizenTubeCobalt/releases/latest),
download the APK that matches:

| `ro.product.cpu.abi` | Download |
|---|---|
| `armeabi-v7a` (most TVs) | `cobalt-arm.apk` |
| `arm64-v8a` | `cobalt-arm64.apk` |

With the GitHub CLI: `gh release download --repo reisxd/TizenTubeCobalt --pattern cobalt-arm.apk`.

## 3. Create your signing key (once)

Android installs only signed apps, and every update must be signed with the same key. Create a key once
and keep it:

```sh
keytool -genkeypair -keystore ttextras.jks -alias ttextras -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=TT Extras"
```

**(you)** `keytool` asks for a password. Choose one and type it yourself. An agent shouldn't choose,
see or store it.

**Keep `ttextras.jks` and its password safe**, for example in a password manager and a backup. If you
lose either, you can't update the app. You'd have to uninstall it, which deletes its settings, history
and subscriptions. Never commit the keystore to a repository.

## 4. Patch the app

```sh
python3 patch-apk.py --keystore ttextras.jks --key-alias ttextras \
  --package io.github.rnjnkr.ttextras.prd --label "TT Extras" --icons icons \
  cobalt-arm.apk tt-extras.apk
```

On Windows, use `py` instead of `python3` and put the command on one line.

**(you)** `apksigner` asks for the keystore password.

**Check:** the last lines read:

```
tt-extras.apk: userscript URL is now https://cdn.jsdelivr.net/gh/rnjnkr/tizentube-extras@main/loader.js?v=<timestamp>
tt-extras.apk: package io.github.rnjnkr.ttextras.prd, label 'TT Extras'
tt-extras.apk: launcher icon and banner from icons
```

What the options do:

- `--package` makes TT Extras a separate app, so it doesn't replace TizenTube.
- `--label` sets the name in the app list.
- `--icons` gives TT Extras its own icon.

Leave them all out and the result replaces TizenTube itself, which only works after TizenTube is
uninstalled.

If it stops with `expected the TizenTube URL once` or `found 0 times`, this TizenTube Cobalt version is
laid out differently from the one the patcher knows. Stop there and open an issue in this repo, naming
the TizenTube Cobalt version.

## 5. Install

```sh
adb install tt-extras.apk
```

**Check:** it prints `Success`.

If it fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, an app with this package name is already
installed but signed with a different key. Uninstalling it deletes its data, so it's the person's
decision. Agents: ask, and never uninstall anything on your own.

## 6. First start (you)

1. Open **TT Extras** from the TV's app list. The home screen may keep showing TizenTube's icon for a
   while. To refresh it now: `adb shell pm trim-caches 999G`, then
   `adb shell am force-stop com.google.android.apps.tv.launcherx`. This clears all apps' caches, which
   rebuild themselves, and restarts the home screen.
2. TT Extras' options are in TizenTube's settings. Open the gear at the bottom of the sidebar and
   choose the **TizenTube** entry, or press the green button if your remote has one. See
   [README.md](README.md) for what each option does.

**Check:** the app shows YouTube's Home with a **Recently watched** row (after you've watched something)
and TT Extras' rows in settings.

## Updating

- **TT Extras itself** updates on its own. The app loads the latest release from this repo each time
  it starts.
- **A new TizenTube Cobalt version:** repeat steps 2, 4 and 5 with the same keystore. Install with
  `adb install -r tt-extras.apk` to keep your data.

## Uninstalling

```sh
adb uninstall io.github.rnjnkr.ttextras.prd
```

This deletes TT Extras' settings, history, subscriptions and saved Shorts. TizenTube isn't affected.

## Notes for agents

- Run only the commands above, and only against the device the person named.
- Don't install, uninstall or clear anything beyond what a step says. Ask the person before any step
  that changes the TV (steps 5 and 6, uninstalling).
- Never choose, read, print or store the keystore password. The person types it into `keytool` and
  `apksigner` themselves.
- Stop and report if a command fails in a way not covered here, or if the TV shows a system dialog you
  didn't expect.

## Legal

TT Extras is an unofficial project. It isn't affiliated with YouTube, Google or the TizenTube authors.

TizenTube Cobalt is © its authors under the BSD 3-Clause license, and TizenTube under GPL-3.0. The APK
you build is a modified copy for your own use. If you share it, include TizenTube Cobalt's license and
copyright notices, and say that it's modified.
