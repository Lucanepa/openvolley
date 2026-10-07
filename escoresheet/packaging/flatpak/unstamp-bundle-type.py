#!/usr/bin/env python3
"""Sets the Tauri bundle-type stamp of a repacked binary back to "unknown".

    python3 unstamp-bundle-type.py usr/bin/openvolley-escoresheet

The Tauri bundler stamps the bundle type into the binary: it replaces the
string "__TAURI_BUNDLE_TYPE_VAR_UNK" with "..._DEB" in the binary it puts in
the .deb. The app's updater (src-tauri/src/updater.rs) reads that stamp: a
.deb updates through APT, or tells the scorer to add the APT repo. Inside a
Flatpak neither is right (Flatpak updates the app), so this writes "UNK"
back: the app then never looks for updates and says "This build does not
update itself". Versions from 2.4.0 on also detect Flatpak themselves
(updater.rs managed_by, FLATPAK_ID); the stamp is reset for every version
so 2.3.0 and OpenBeach 2.0.0 behave the same.

Only the stamped value changes. bundle_type() compares it against five
literals stored side by side in .rodata ("..._DEB", "..._RPM", "..._APP",
"..._MSI", "..._NSS"), so the literal "..._DEB" is the one directly followed
by "..._RPM"; the stamp is the other one. Exactly one stamp must be found,
else the build fails (a Tauri change must be looked at, not guessed).
"""
import sys

MARKER = b"__TAURI_BUNDLE_TYPE_VAR_"
STAMP = MARKER + b"DEB"
STRIDE = len(STAMP)  # the literals sit at this distance (27 bytes) after one another


def unstamp(data: bytes) -> bytes:
    if MARKER + b"UNK" in data:
        raise SystemExit("bundle type is already unknown (UNK): nothing to do, refusing to guess")
    hits = []
    start = 0
    while (i := data.find(STAMP, start)) != -1:
        if data[i + STRIDE:i + 2 * STRIDE] != MARKER + b"RPM":
            hits.append(i)
        start = i + 1
    if len(hits) != 1:
        raise SystemExit(f"expected one bundle-type stamp ({STAMP.decode()}), found {len(hits)}")
    i = hits[0]
    return data[:i] + MARKER + b"UNK" + data[i + STRIDE:]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__.strip().splitlines()[2].strip())
    path = sys.argv[1]
    with open(path, "rb") as f:
        data = f.read()
    out = unstamp(data)
    assert len(out) == len(data)
    with open(path, "wb") as f:
        f.write(out)
    print(f"{path}: bundle type DEB -> UNK (the in-app updater is off)")


if __name__ == "__main__":
    main()
