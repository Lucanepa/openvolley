#!/usr/bin/env python3
"""Edits the Flatpak manifest and the AppStream metainfo of an app (stdlib only).

  flatpak-meta.py set-deb MANIFEST (--url URL --sha256 SHA | --path FILE)
      Points the app module's .deb source (the one with dest-filename
      <command>.deb) at a release URL with its SHA-256 (bump.sh, committed),
      or at a local file (publish-flatpak.sh, a build copy only).

  flatpak-meta.py add-release METAINFO VERSION DATE URL [NOTES]
      Adds <release version="VERSION" date="DATE"> with its details URL at the
      top of <releases>, unless that version is already listed. NOTES: a text
      file ("- item" lines become a list, other lines paragraphs). The file is
      edited as text so the rest keeps its layout.

  flatpak-meta.py version MANIFEST
      Prints the version in the .deb URL of the manifest.
"""
import json
import re
import sys
from xml.sax.saxutils import escape


def deb_source(manifest: dict) -> dict:
    command = manifest["command"]
    for module in manifest["modules"]:
        if not isinstance(module, dict) or module.get("name") != command:
            continue
        for source in module["sources"]:
            if source.get("dest-filename") == f"{command}.deb":
                return source
    raise SystemExit(f"no {command}.deb source in the {command} module")


def set_deb(path: str, args: list) -> None:
    with open(path) as f:
        manifest = json.load(f)
    source = deb_source(manifest)
    opts = dict(zip(args[::2], args[1::2]))
    if len(args) % 2 or set(opts) - {"--url", "--sha256", "--path"}:
        raise SystemExit("set-deb: --url URL --sha256 SHA, or --path FILE")
    for key in ("url", "sha256", "path", "only-arches"):
        source.pop(key, None)
    if "--path" in opts:
        source["path"] = opts["--path"]
    else:
        if not re.fullmatch(r"[0-9a-f]{64}", opts.get("--sha256", "")) or not opts.get("--url", "").startswith("https://"):
            raise SystemExit("set-deb: --url https://... and a 64-hex --sha256 are both needed")
        source["url"] = opts["--url"]
        source["sha256"] = opts["--sha256"]
        source["only-arches"] = ["x86_64"]
    # keep the key order readable: type, url/path, sha256, dest-filename, only-arches
    order = ["type", "url", "path", "sha256", "dest-filename", "only-arches"]
    rebuilt = {k: source[k] for k in order if k in source}
    source.clear()
    source.update(rebuilt)
    with open(path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")


def version(path: str) -> None:
    with open(path) as f:
        source = deb_source(json.load(f))
    m = re.search(r"_(\d+\.\d+\.\d+[^_]*)_amd64\.deb$", source.get("url", ""))
    if not m:
        raise SystemExit(f"{path}: the .deb source has no release URL")
    print(m.group(1))


def notes_xml(text: str, indent: str) -> str:
    out, items = [], []

    def flush():
        if items:
            out.append(f"{indent}  <ul>")
            out.extend(f"{indent}    <li>{escape(i)}</li>" for i in items)
            out.append(f"{indent}  </ul>")
            items.clear()

    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith(("- ", "* ")):
            items.append(line[2:].strip())
        else:
            flush()
            out.append(f"{indent}  <p>{escape(line)}</p>")
    flush()
    if not out:
        return ""
    return f"{indent}<description>\n" + "\n".join(out) + f"\n{indent}</description>\n"


def add_release(path: str, ver: str, date: str, url: str, notes_file: str | None) -> None:
    if not re.fullmatch(r"\d+\.\d+\.\d+([.~+-][0-9A-Za-z.~+-]*)?", ver):
        raise SystemExit(f"add-release: {ver}: not a version")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise SystemExit(f"add-release: {date}: not a date like 2026-10-07")
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if re.search(rf'<release\s[^>]*version="{re.escape(ver)}"', text):
        print(f"{path}: release {ver} already listed")
        return
    m = re.search(r"^([ \t]*)<releases>[ \t]*\n", text, re.M)
    if not m:
        raise SystemExit(f"{path}: no <releases> element")
    ind = m.group(1) + "  "
    notes = ""
    if notes_file:
        with open(notes_file, encoding="utf-8") as f:
            notes = notes_xml(f.read(), ind + "  ")
    block = (
        f'{ind}<release version="{ver}" date="{date}">\n'
        f'{ind}  <url type="details">{escape(url)}</url>\n'
        f"{notes}"
        f"{ind}</release>\n"
    )
    text = text[: m.end()] + block + text[m.end():]
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"{path}: added release {ver} ({date})")


def main(argv: list) -> None:
    if len(argv) >= 2 and argv[0] == "set-deb":
        set_deb(argv[1], argv[2:])
    elif len(argv) in (5, 6) and argv[0] == "add-release":
        add_release(argv[1], argv[2], argv[3], argv[4], argv[5] if len(argv) == 6 else None)
    elif len(argv) == 2 and argv[0] == "version":
        version(argv[1])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
