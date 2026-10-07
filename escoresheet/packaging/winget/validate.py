"""Check the winget manifests against the official winget-pkgs JSON schemas.

Run by validate.sh (in a python container): validate.py SCHEMA_DIR MANIFEST_ROOT

Besides the schemas (manifest.<type>.<ManifestVersion>.json from
microsoft/winget-cli, schemas/JSON/manifests), it checks what winget-pkgs'
own pipeline checks across the files of one version: one PackageIdentifier
and PackageVersion everywhere, the folder path
manifests/<first letter>/<Publisher>/<Name>/<version>/, the file names, one
default locale that the version manifest names, one installer manifest.
"""
import json
import pathlib
import re
import sys

import jsonschema
import yaml


class Loader(yaml.SafeLoader):
    """YAML as winget reads it: a date such as ReleaseDate stays a string."""


Loader.yaml_implicit_resolvers = {
    k: [(tag, rx) for tag, rx in v if tag != "tag:yaml.org,2002:timestamp"]
    for k, v in yaml.SafeLoader.yaml_implicit_resolvers.items()
}

SCHEMA_NAME = {
    "version": "version",
    "installer": "installer",
    "defaultLocale": "defaultLocale",
    "locale": "locale",
}


def main(schema_dir: str, root: str) -> int:
    schema_dir = pathlib.Path(schema_dir)
    root = pathlib.Path(root)
    errors = []
    versions = sorted({p.parent for p in root.rglob("*.yaml")})
    if not versions:
        print(f"no manifests under {root}")
        return 1
    for vdir in versions:
        rel = vdir.relative_to(root)
        docs = {}
        for f in sorted(vdir.glob("*.yaml")):
            text = f.read_text(encoding="utf-8")
            if "\t" in text:
                errors.append(f"{f.name}: contains a tab")
            data = yaml.load(text, Loader=Loader)
            mtype = data.get("ManifestType")
            mver = data.get("ManifestVersion")
            schema_file = schema_dir / f"manifest.{SCHEMA_NAME.get(mtype, mtype)}.{mver}.json"
            if not schema_file.is_file():
                errors.append(f"{f.name}: no schema {schema_file.name}")
                continue
            schema = json.loads(schema_file.read_text(encoding="utf-8"))
            v = jsonschema.Draft7Validator(schema, format_checker=jsonschema.Draft7Validator.FORMAT_CHECKER)
            for e in sorted(v.iter_errors(data), key=lambda e: list(e.path)):
                where = "/".join(str(p) for p in e.path) or "(root)"
                errors.append(f"{rel}/{f.name}: {where}: {e.message}")
            docs[f.name] = data

        ids = {d.get("PackageIdentifier") for d in docs.values()}
        vers = {d.get("PackageVersion") for d in docs.values()}
        if len(ids) != 1 or len(vers) != 1:
            errors.append(f"{rel}: PackageIdentifier/PackageVersion differ between files: {ids} {vers}")
            continue
        pid, pver = ids.pop(), vers.pop()
        publisher, _, name = pid.partition(".")
        want = pathlib.Path(publisher[0].lower(), publisher, *name.split("."), pver)
        if rel != want:
            errors.append(f"{rel}: folder should be {want}")
        types = {}
        for fname, d in docs.items():
            types.setdefault(d["ManifestType"], []).append((fname, d))
        version_m = types.get("version", [])
        if len(version_m) != 1 or version_m[0][0] != f"{pid}.yaml":
            errors.append(f"{rel}: needs exactly one version manifest {pid}.yaml")
        if len(types.get("installer", [])) != 1 or types["installer"][0][0] != f"{pid}.installer.yaml":
            errors.append(f"{rel}: needs exactly one installer manifest {pid}.installer.yaml")
        dl = types.get("defaultLocale", [])
        if len(dl) != 1:
            errors.append(f"{rel}: needs exactly one defaultLocale manifest")
        elif version_m and version_m[0][1].get("DefaultLocale") != dl[0][1].get("PackageLocale"):
            errors.append(f"{rel}: DefaultLocale does not match the defaultLocale manifest's PackageLocale")
        for fname, d in dl + types.get("locale", []):
            if fname != f"{pid}.locale.{d.get('PackageLocale')}.yaml":
                errors.append(f"{rel}/{fname}: should be named {pid}.locale.{d.get('PackageLocale')}.yaml")
        for fname, d in types.get("installer", []):
            for inst in d.get("Installers", []):
                url = inst.get("InstallerUrl", "")
                if f"_{pver}_" not in url:
                    errors.append(f"{rel}/{fname}: InstallerUrl does not carry version {pver}: {url}")
                if not re.fullmatch(r"[0-9A-F]{64}", inst.get("InstallerSha256", "")):
                    errors.append(f"{rel}/{fname}: InstallerSha256 must be 64 upper-case hex digits")
        print(f"checked {rel} ({len(docs)} files)")

    if errors:
        print("\nFAILED:")
        for e in errors:
            print("  " + e)
        return 1
    print("all manifests valid")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:3]))
