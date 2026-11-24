#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 TT Extras contributors. See LICENSE.
"""
Turns a TizenTube Cobalt APK into TT Extras: points it at the TT Extras loader and re-signs it.

TizenTube Cobalt injects one script into every page it loads:
    https://cdn.jsdelivr.net/npm/@foxreis/tizentube/dist/userScript.js?v=<timestamp>
The URL is a string literal in lib/<abi>/libchrobalt.so, so this replaces it in place with one of the
same length (a shorter URL is padded with a dummy query parameter) and leaves everything else as is.
See INSTALL.md for the whole procedure.

Usage:
    ./patch-apk.py --keystore FILE --key-alias ALIAS [--package NAME] [--label LABEL] [--icons DIR]
                   [--version-code N] <in.apk> <out.apk> [<url-prefix>]

--keystore and --key-alias name the signing key (create one with keytool, see INSTALL.md). apksigner
asks for its password. Keep the keystore: updates must be signed with the same key.
--package installs the result as a separate app alongside TizenTube (the name must be 29 characters,
the length of io.gh.reisxd.tizentube.cobalt), and --label changes its launcher name (9 characters,
the length of "TizenTube"). --icons replaces the launcher icon and TV banner with PNGs from DIR:
ic_app-{80,120,160,240,320}.png and app_banner-{160,240,320,480,640}.png, each the size of the image
it replaces (icons/ in this repo has a set). --version-code raises the manifest's versionCode.

<url-prefix> defaults to this repo's loader on jsDelivr. The timestamp is appended to it, so it must
end in "v=". The app lets scripts load only from cdn.jsdelivr.net, api.github.com, sponsor.ajay.app,
dearrow-thumb.ajay.app and tizentube.app, so the URL must be on one of them.

The Android SDK build tools (zipalign, apksigner) are found through $ANDROID_HOME, $ANDROID_SDK_ROOT,
the usual SDK folders, or PATH.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

DEFAULT_URL = "https://cdn.jsdelivr.net/gh/rnjnkr/tizentube-extras@main/loader.js?v="
ORIGINAL_PACKAGE = "io.gh.reisxd.tizentube.cobalt"
ORIGINAL_LABEL = "TizenTube"
ORIGINAL = b"https://cdn.jsdelivr.net/npm/@foxreis/tizentube/dist/userScript.js?v="
ALLOWED_HOSTS = ("cdn.jsdelivr.net", "api.github.com", "sponsor.ajay.app", "dearrow-thumb.ajay.app", "tizentube.app")
# APK entry -> replacement file in the --icons directory (the APK's own resource paths, no extension).
ICONS = {
    "res/mipmap-mdpi-v4/ic_app": "ic_app-80.png", "res/mipmap-hdpi-v4/ic_app": "ic_app-120.png",
    "res/mipmap-xhdpi-v4/ic_app": "ic_app-160.png", "res/mipmap-xxhdpi-v4/ic_app": "ic_app-240.png",
    "res/mipmap-xxxhdpi-v4/ic_app": "ic_app-320.png",
    "res/drawable/app_banner": "app_banner-160.png", "res/drawable-hdpi-v4/app_banner": "app_banner-240.png",
    "res/drawable-xhdpi-v4/app_banner": "app_banner-320.png", "res/drawable-xxhdpi-v4/app_banner": "app_banner-480.png",
    "res/drawable-xxxhdpi-v4/app_banner": "app_banner-640.png",
}


def die(msg):
    sys.exit(f"error: {msg}")


def padded(prefix: str) -> bytes:
    """The URL prefix, padded to the original's length with a dummy query parameter."""
    if not prefix.endswith("v="):
        die('the URL must end in "v=" (the timestamp is appended to it)')
    if not prefix.startswith("https://"):
        die("the URL must be https")
    host = prefix[len("https://"):].split("/", 1)[0].split(":", 1)[0]
    if host not in ALLOWED_HOSTS:
        die(f"the app only loads scripts from {', '.join(ALLOWED_HOSTS)} (not {host})")
    url = prefix.encode("ascii")
    if len(url) == len(ORIGINAL):
        return url
    # "...loader.js?v="  ->  "...loader.js?p=xxxx&v="  (or "&p=xxxx&v=" if it already has a query)
    base = url[:-2]
    if not base.endswith((b"?", b"&")):
        die('the URL must end in "?v=" or "&v="')
    room = len(ORIGINAL) - len(base) - len(b"p=&v=")
    if room < 0:
        die(f"the URL is {len(url)} characters; at most {len(ORIGINAL) - 5} fit (without padding: {len(ORIGINAL)})")
    return base + b"p=" + b"x" * room + b"&v="


def utf16(s: str) -> bytes:
    return s.encode("utf-16-le")


def pool_entry(s: str) -> bytes:
    """A UTF-16 string-pool entry (length, characters, terminator), as in binary XML."""
    return len(s).to_bytes(2, "little") + utf16(s) + b"\0\0"


def replace_counted(data: bytes, old: bytes, new: bytes, what: str, expected=None) -> bytes:
    assert len(old) == len(new)
    count = data.count(old)
    if count == 0 or (expected is not None and count != expected):
        die(f"{what}: found {count} times, expected {expected or 'at least once'}")
    return data.replace(old, new)


def int_value(n: int) -> bytes:
    """A binary-XML typed value: size 8, res0, TYPE_INT_DEC (0x10), the 32-bit integer."""
    return b"\x08\x00\x00\x10" + n.to_bytes(4, "little")


def manifest_version_code(data: bytes) -> int:
    # android:versionCode is resource 0x0101021b; its attribute's typed value follows the name and raw-value fields.
    resmap = data.find(b"\x80\x01\x08\x00")          # RES_XML_RESOURCE_MAP_TYPE chunk header
    if resmap == -1:
        die("no resource map in the manifest")
    size = int.from_bytes(data[resmap + 4:resmap + 8], "little")
    ids = [int.from_bytes(data[i:i + 4], "little") for i in range(resmap + 8, resmap + size, 4)]
    if 0x0101021b not in ids:
        die("no android:versionCode in the manifest")
    name = ids.index(0x0101021b).to_bytes(4, "little")
    for at in range(0, len(data) - 20, 4):
        # attribute: ns(4) name(4) rawValue(4) typedValue(8)
        if data[at + 4:at + 8] == name and data[at + 12:at + 16] == b"\x08\x00\x00\x10":
            return int.from_bytes(data[at + 16:at + 20], "little")
    die("android:versionCode has no integer value")


def png_size(data: bytes, what: str):
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        die(f"{what} is not a PNG")
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def sdk_dirs():
    for var in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        if os.environ.get(var):
            yield Path(os.environ[var])
    yield Path.home() / "Library/Android/sdk"                  # macOS (Android Studio)
    yield Path.home() / "Android/Sdk"                          # Linux (Android Studio)
    if os.environ.get("LOCALAPPDATA"):
        yield Path(os.environ["LOCALAPPDATA"]) / "Android/Sdk"  # Windows (Android Studio)


def build_tool(name):
    names = (name, name + ".bat", name + ".exe")
    for sdk in sdk_dirs():
        if not (sdk / "build-tools").is_dir():
            continue
        versions = sorted((sdk / "build-tools").iterdir(),
                          key=lambda p: [int(x) for x in p.name.split(".") if x.isdigit()])
        for v in reversed(versions):
            for n in names:
                if (v / n).exists():
                    return str(v / n)
    found = shutil.which(name)
    if found:
        return found
    die(f"{name} not found: install the Android SDK build tools (see INSTALL.md) or set ANDROID_HOME")


def main():
    args = sys.argv[1:]
    package = label = icons = version_code = keystore = alias = None
    while args and args[0].startswith("--"):
        opt = args.pop(0)
        if opt == "--keystore" and args:
            keystore = args.pop(0)
        elif opt == "--key-alias" and args:
            alias = args.pop(0)
        elif opt == "--package" and args:
            package = args.pop(0)
        elif opt == "--label" and args:
            label = args.pop(0)
        elif opt == "--icons" and args:
            icons = Path(args.pop(0))
        elif opt == "--version-code" and args and args[0].isdigit():
            version_code = int(args.pop(0))
        else:
            sys.exit(__doc__)
    if len(args) not in (2, 3) or not keystore or not alias:
        sys.exit(__doc__)
    src, dst = Path(args[0]), Path(args[1])
    prefix = args[2] if len(args) == 3 else DEFAULT_URL
    if not Path(keystore).is_file():
        die(f"--keystore: {keystore} not found")
    if package is not None and len(package) != len(ORIGINAL_PACKAGE):
        die(f"--package must be {len(ORIGINAL_PACKAGE)} characters long ({package!r} is {len(package)})")
    if label is not None and len(label) != len(ORIGINAL_LABEL):
        die(f"--label must be {len(ORIGINAL_LABEL)} characters long ({label!r} is {len(label)})")
    new = padded(prefix)
    assert len(new) == len(ORIGINAL)
    replacements = {}
    if icons is not None:
        for entry, file in ICONS.items():
            if not (icons / file).is_file():
                die(f"--icons: {icons / file} is missing")
            replacements[entry] = (icons / file).read_bytes()
    zipalign, apksigner = build_tool("zipalign"), build_tool("apksigner")

    with tempfile.TemporaryDirectory() as tmp:
        unaligned = Path(tmp) / "unaligned.apk"
        aligned = Path(tmp) / "aligned.apk"
        patched = 0
        with zipfile.ZipFile(src) as zin, zipfile.ZipFile(unaligned, "w") as zout:
            for info in zin.infolist():
                name = info.filename
                # Old signatures would no longer match.
                if name.startswith("META-INF/") and name.rsplit(".", 1)[-1].upper() in ("SF", "RSA", "DSA", "EC", "MF"):
                    continue
                data = zin.read(info)
                if name.startswith("lib/") and name.endswith("/libchrobalt.so"):
                    count = data.count(ORIGINAL)
                    if count != 1:
                        die(f"{name}: expected the TizenTube URL once, found it {count} times")
                    data = data.replace(ORIGINAL, new)
                    patched += 1
                if package and name == "AndroidManifest.xml":
                    # The package attribute and the file provider's authority, which starts with it.
                    data = replace_counted(data, utf16(ORIGINAL_PACKAGE), utf16(package), "package name in the manifest")
                if package and name == "resources.arsc":
                    # The resource table's package name, so getIdentifier(..., getPackageName()) still resolves.
                    data = replace_counted(data, utf16(ORIGINAL_PACKAGE), utf16(package), "package name in resources.arsc", 1)
                if label and name == "AndroidManifest.xml":
                    data = replace_counted(data, pool_entry(ORIGINAL_LABEL), pool_entry(label), "app label in the manifest", 1)
                if version_code is not None and name == "AndroidManifest.xml":
                    old_code = manifest_version_code(data)
                    if version_code <= old_code or version_code > 2100000000:
                        die(f"--version-code must be above the APK's {old_code} (and at most 2100000000)")
                    data = replace_counted(data, int_value(old_code), int_value(version_code), "versionCode in the manifest", 1)
                if name in replacements:
                    want, got = png_size(data, name), png_size(replacements[name], ICONS[name])
                    if want != got:
                        die(f"--icons: {ICONS[name]} is {got[0]}x{got[1]}, {name} needs {want[0]}x{want[1]}")
                    data = replacements.pop(name)
                out = zipfile.ZipInfo(name, info.date_time)
                out.compress_type = info.compress_type
                out.external_attr = info.external_attr
                zout.writestr(out, data)
        if not patched:
            die("no libchrobalt.so in the APK (is this a TizenTube Cobalt APK?)")
        if replacements:
            die(f"--icons: not in the APK: {', '.join(sorted(replacements))}")

        # Uncompressed .so files must be page-aligned so they can be mapped straight from the APK.
        subprocess.run([zipalign, "-f", "-P", "16", "4", str(unaligned), str(aligned)], check=True)
        # apksigner prompts for the keystore password itself.
        subprocess.run([apksigner, "sign", "--ks", keystore, "--ks-key-alias", alias,
                        "--out", str(dst), str(aligned)], check=True)
    Path(str(dst) + ".idsig").unlink(missing_ok=True)
    print(f"{dst}: userscript URL is now {new.decode()}<timestamp>")
    if package:
        print(f"{dst}: package {package}" + (f", label {label!r}" if label else ""))
    if icons is not None:
        print(f"{dst}: launcher icon and banner from {icons}")
    if version_code is not None:
        print(f"{dst}: versionCode {version_code}")


if __name__ == "__main__":
    main()
