# Scoop (Windows, no store account)

[Scoop](https://scoop.sh) manifests for the two Windows apps. Unlike winget
nothing has to be submitted anywhere: Scoop installs straight from a
manifest URL, and these files are that URL once they are on `main`.

```powershell
scoop install https://raw.githubusercontent.com/Lucanepa/openvolley/main/escoresheet/packaging/scoop/openvolley.json
scoop install https://raw.githubusercontent.com/Lucanepa/openvolley/main/escoresheet/packaging/scoop/openbeach.json

scoop update openvolley      # re-reads the manifest from that URL
scoop uninstall openvolley
```

## How it installs (and why not "portable")

Most Scoop apps are portable: Scoop unpacks them into `~\scoop\apps`, no
administrator rights. These manifests instead **run the official NSIS
installer silently** (`setup.exe /S`, one administrator prompt), so the app
ends up exactly as from the website: `%ProgramFiles%\<productName>`, Start
menu entry, Apps & features entry, and the Windows Defender Firewall rule
for the tablets. The scripts are in the manifests' `installer` /
`uninstaller` blocks.

Unpacking the installer instead (`#/dl.7z`) would leave the app without
the firewall rule (tablets get no page until someone allows it at
Defender's prompt), and its own updater (kind `Nsis`, `updater.rs`) would
install each update as a second copy in Program Files beside the Scoop one.

So:

- `scoop install` = the official installer; `scoop uninstall` = its
  uninstaller, silently (the firewall rule goes; match data and backups stay).
- `scoop update` skips the old version's uninstaller and runs the new
  installer, which replaces the old version in place (as the app's own
  updater does).
- The app keeps updating itself between matches. When it did, `scoop update`
  later reinstalls the same version: harmless.
- Do not run `scoop update` during a match: the installer quits the app
  (the match is saved, the tablets disconnect).
- Because it is not portable and needs administrator rights, these
  manifests do not qualify for Scoop's official `extras` bucket; they are
  meant to be installed by URL as above.

Optional: a bucket gives `scoop install openvolley` by name and lets
`scoop status` see updates. That needs a small extra repository (owner step,
not done): create e.g. `Lucanepa/scoop-openvolley` with these two files in a
`bucket/` folder, then
`scoop bucket add openvolley https://github.com/Lucanepa/scoop-openvolley`.

## New version

After the GitHub release is published:

```bash
escoresheet/packaging/scoop/update-manifests.sh openvolley 2.4.0
escoresheet/packaging/scoop/update-manifests.sh openbeach 2.0.1
escoresheet/packaging/scoop/validate.sh --urls
```

and commit to `main` (users' `scoop update` reads the manifest from `main`).
`update-manifests.sh` takes the URL from the manifest's `autoupdate` block
and downloads the installer for the SHA-256 (`--file`, `--sha256` to
override). On Windows, Scoop's own `checkver.ps1 -u` does the same from the
`checkver` / `autoupdate` blocks.

`validate.sh` checks the files against Scoop's JSON schema
(`ScoopInstaller/Scoop/schema.json`), parses the installer and uninstaller
scripts with PowerShell (pwsh container), checks that `checkver` finds the
manifest's version among the GitHub releases and that the URL is the
`autoupdate` URL, and with `--urls` that the download matches the hash.

## Not covered

- Not run on a real Windows machine (no Windows here): the scripts parse and
  the files pass the schema; the install, update and uninstall paths are
  untested. First real test: `scoop install .\openvolley.json`, then
  `scoop uninstall openvolley` (Apps & features entry and firewall rule
  must be gone, `%LOCALAPPDATA%\com.openvolley.escoresheet` must stay).
  Checked without Windows: Scoop's own `bin/checkver.ps1` (pwsh on Linux)
  finds 2.3.0 / 2.0.0, and its `-Update -ForceUpdate` rewrites a manifest
  with the same URL and hash. The uninstaller's `scoop-update.ps1` check
  was tried with a stand-in call stack (update: returns at once; uninstall:
  goes on). The installer's `/S` install, a second `/S` run over it and the
  silent uninstall worked under Wine.
- `scoop update` recognises an update by the `scoop-update.ps1` frame on the
  call stack (the uninstaller then does nothing): if a future Scoop renames
  that script, an update uninstalls first and installs again (still works,
  one more administrator prompt).
- `scoop install --global` works the same (the app is per machine anyway).
