#!/usr/bin/env python3
"""Checks, on the signing host, that a built Arch package only repacks its .deb.

  check-package.py PACKAGE.pkg.tar.zst RELEASE.deb PKGBUILD

publish-pacman.sh builds the packages in a container and signs them here;
this runs between the two, outside the container, so a build image or build
tool that changed the content is caught before the pacman key signs it. The
PKGBUILD (../aur/<package>-bin) takes the release .deb apart and installs
some of its files again, so every regular file of the package must be one of:

  - byte for byte the .deb's file at the same path (the bundler's icon
    folder 256x256@2 counts as 256x256, where the PKGBUILD puts it);
  - the same, with the bundle-type stamp reset (the PKGBUILD's
    _unstamp_bundle_type: one "__TAURI_BUNDLE_TYPE_VAR_DEB" becomes "...UNK");
  - usr/share/licenses/*/LICENSE with the SHA-256 the PKGBUILD pins (the first
    of sha256sums);
  - the updater marker usr/lib/*/package-manager, holding "aur";
  - pacman's own metadata at the top: .PKGINFO, .BUILDINFO, .MTREE.

Nothing else: no other file, no install scriptlet (.INSTALL), no link, no
device, no setuid or setgid bit. The .deb itself must have the SHA-256 the
PKGBUILD pins (sha256sums_x86_64). Exit 0 and one line when it holds, 1 and
the reason when not. Stdlib, zstd and dpkg-deb only.
"""
import hashlib
import re
import subprocess
import sys
import tarfile

MARKER = b"__TAURI_BUNDLE_TYPE_VAR_"
METADATA = {".PKGINFO", ".BUILDINFO", ".MTREE"}


def fail(msg):
    print(f"check-package: {msg}", file=sys.stderr)
    sys.exit(1)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def pkgbuild_sums(path):
    text = open(path, encoding="utf-8").read()

    def first(var):
        m = re.search(rf"^{var}=\(\s*'([0-9a-f]{{64}})'", text, re.M)
        return m.group(1) if m else None

    return first("sha256sums"), first("sha256sums_x86_64")


def members(cmd, what):
    """{name: (TarInfo, bytes or None)} of the tar stream cmd prints."""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    out = {}
    try:
        with tarfile.open(fileobj=proc.stdout, mode="r|") as t:
            for m in t:
                name = m.name[2:] if m.name.startswith("./") else m.name
                name = name.rstrip("/")
                if not name or name == ".":
                    continue
                data = t.extractfile(m).read() if m.isreg() else None
                out[name] = (m, data)
    except tarfile.TarError as e:
        fail(f"{what}: not a readable archive ({e})")
    if proc.wait() != 0:
        fail(f"{what}: {cmd[0]} failed")
    return out


def unstamp(data):
    """The PKGBUILD's _unstamp_bundle_type, or None when it would refuse."""
    hits = []
    start = 0
    while True:
        off = data.find(MARKER + b"DEB", start)
        if off < 0:
            break
        if data[off + 27:off + 54] != MARKER + b"RPM":
            hits.append(off)
        start = off + 1
    if len(hits) != 1:
        return None
    off = hits[0] + len(MARKER)
    return data[:off] + b"UNK" + data[off + 3:]


def main(argv):
    if len(argv) != 3:
        fail("usage: check-package.py PACKAGE.pkg.tar.zst RELEASE.deb PKGBUILD")
    pkg, deb, pkgbuild = argv
    lic_sum, deb_sum = pkgbuild_sums(pkgbuild)
    if not deb_sum:
        fail(f"{pkgbuild}: no sha256sums_x86_64 (the .deb it repacks)")
    with open(deb, "rb") as f:
        got = sha256(f.read())
    if got != deb_sum:
        fail(f"{deb}: SHA-256 {got}, the PKGBUILD pins {deb_sum}")

    allowed = {}
    for name, (m, data) in members(["dpkg-deb", "--fsys-tarfile", deb], deb).items():
        if data is None:
            continue
        sums = {sha256(data)}
        if MARKER in data:
            u = unstamp(data)
            if u is not None:
                sums.add(sha256(u))
        for path in {name, re.sub(r"^(usr/share/icons/hicolor/\d+x\d+)@2/", r"\1/", name)}:
            allowed.setdefault(path, set()).update(sums)

    files = 0
    for name, (m, data) in members(["zstd", "-dcq", pkg], pkg).items():
        if m.isdir():
            if m.mode & 0o6000:
                fail(f"{pkg}: {name}/ has a setuid/setgid bit")
            continue
        if not m.isreg():
            fail(f"{pkg}: {name} is not a regular file or folder")
        if m.mode & 0o6000:
            fail(f"{pkg}: {name} has a setuid/setgid bit")
        if "/" not in name and name.startswith("."):
            if name not in METADATA:
                fail(f"{pkg}: {name}: pacman metadata the PKGBUILD never makes (an install scriptlet?)")
            continue
        h = sha256(data)
        if h in allowed.get(name, ()):
            pass
        elif re.fullmatch(r"usr/share/licenses/[^/]+/LICENSE", name) and lic_sum and h == lic_sum:
            pass
        elif re.fullmatch(r"usr/lib/[^/]+/package-manager", name) and data == b"aur\n":
            pass
        else:
            fail(f"{pkg}: {name} is not a file of {deb} (nor the PKGBUILD's LICENSE or marker): not signed")
        files += 1
    if files == 0:
        fail(f"{pkg}: no files")
    print(f"{pkg.rsplit('/', 1)[-1]}: its {files} files come from {deb.rsplit('/', 1)[-1]}")


if __name__ == "__main__":
    main(sys.argv[1:])
