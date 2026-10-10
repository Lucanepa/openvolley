# winget (Windows Package Manager)

Manifests for the two Windows apps, ready to submit to
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs):

| Package identifier    | App                    | Release tag          | Installer (GitHub release asset)                |
|-----------------------|------------------------|----------------------|-------------------------------------------------|
| `Lucanepa.OpenVolley` | OpenVolley eScoresheet | `desktop-v<X>`       | `Openvolley.eScoresheet_<X>_x64-setup.exe`      |
| `Lucanepa.OpenBeach`  | OpenBeach              | `beach-desktop-v<X>` | `OpenBeach_<X>_x64-setup.exe`                   |

Once they are in winget-pkgs, people install them with

```powershell
winget install Lucanepa.OpenVolley     # or: winget install openvolley
winget install Lucanepa.OpenBeach      # or: winget install openbeach
```

## Files

```
manifests/l/Lucanepa/OpenVolley/2.3.0/   the same path as in winget-pkgs
  Lucanepa.OpenVolley.yaml               version manifest
  Lucanepa.OpenVolley.installer.yaml     installer: URL, SHA-256, switches
  Lucanepa.OpenVolley.locale.en-US.yaml  default locale (English; the only one:
                                         German texts tripped the banking check)
manifests/l/Lucanepa/OpenBeach/2.0.0/    the same for OpenBeach
update-manifests.sh                      writes them for a new version
validate.sh, validate.py                 checks them (Docker)
```

Only the version to submit is kept here; winget-pkgs keeps every version.
The manifests use schema 1.28.0, the version winget-pkgs' tools (komac,
wingetcreate) write today.

## What the installer manifest says, and why

- `InstallerType: nullsoft`: Tauri's NSIS installer.
- `Scope: machine`, `ElevationRequirement: elevatesSelf`: `installMode`
  is `perMachine` (tauri.conf.json): it installs to
  `%ProgramFiles%\<productName>` and asks for administrator rights itself
  (needed for the Windows Defender Firewall rule for the tablets,
  `src-tauri/windows/installer-hooks.nsh`).
- `InstallerSwitches: Silent /S`: NSIS's silent switch. A silent install
  and uninstall never ask anything; the hooks quit a running app cleanly
  first (`--quit`), keep the match data and backups.
- `ProductCode` / `AppsAndFeaturesEntries`: what Tauri writes to Apps &
  features (64-bit HKLM, key = productName): DisplayName
  `Openvolley eScoresheet` (lower-case v, the productName) or `OpenBeach`,
  Publisher `openvolley` (Tauri's default: the second part of the
  identifier, no `bundle.publisher` is set). winget matches an installed
  copy by this, so it also sees copies installed from the website's
  download and offers them upgrades.
- `UpgradeBehavior: install`: the new installer replaces the old one in place.
- WebView2: no dependency is declared; the installer downloads the WebView2
  runtime itself when Windows lacks it (Tauri's default
  `webviewInstallMode`, downloadBootstrapper). Windows 10/11 have it.
- The installers are not Authenticode-signed. winget-pkgs accepts unsigned
  installers; winget checks the download against `InstallerSha256` instead.

## Updates: winget and the app's own updater

The app keeps its own updater on Windows (tauri-plugin-updater, `updater.rs`
kind `Nsis`): a winget install is exactly the website's NSIS install, in the
same folder with the same Apps & features entry. Both paths lead to the same
version, whichever runs first:

- the app downloads an update, signed with the release key, and installs it
  when no match is live (passive installer, one administrator prompt);
- `winget upgrade` installs it once the new manifest is merged in
  winget-pkgs (hours to a few days after the release).

After the app updated itself, winget sees the new DisplayVersion and has
nothing to do. **winget does not know about matches**: `winget upgrade --all`
(or a scheduled one) during a match quits the app (the installer hook asks
it to quit; the match is saved, the tablets disconnect until it is started
again). Tell scorers not to run it at the scoretable during a match.

`winget uninstall Lucanepa.OpenVolley` runs the uninstaller silently: the
firewall rule goes, match data (`%LOCALAPPDATA%\com.openvolley.escoresheet`,
OpenBeach `com.openvolley.beach`) and the automatic match backups (under
`%APPDATA%`) stay.

## New version

After the GitHub release with the Windows installer is published (the
installer must be downloadable, winget-pkgs downloads it too):

```bash
escoresheet/packaging/winget/update-manifests.sh openvolley 2.4.0
escoresheet/packaging/winget/update-manifests.sh openbeach 2.0.1
escoresheet/packaging/winget/validate.sh --urls
```

`update-manifests.sh` downloads the installer for its SHA-256 and reads the
release date from the release (`--file PATH`, `--sha256 HEX`, `--date` to
override). It replaces the version folder; commit it.

`validate.sh` checks every file against the official JSON schemas of
microsoft/winget-cli (`schemas/JSON/manifests/v1.28.0`, downloaded once to
`~/.cache/openvolley/winget-schemas`) in a python container, plus what the
winget-pkgs pipeline checks across files (one identifier and version, folder
path, file names, default locale); `--urls` downloads each installer and
compares the hash.

On a Windows machine the same checks, and a real install, are:

```powershell
winget settings --enable LocalManifestFiles     # once, as administrator
winget validate --manifest manifests\l\Lucanepa\OpenVolley\2.3.0
winget install  --manifest manifests\l\Lucanepa\OpenVolley\2.3.0
```

## Owner steps (not done: they need your GitHub account)

First submission (one pull request per package, both can go at once):

1. Fork microsoft/winget-pkgs: `gh repo fork microsoft/winget-pkgs --clone=false`.
2. Submit the version folder, one of:
   - **wingetcreate** (Windows):
     `wingetcreate submit --token <GitHub PAT, public_repo> manifests\l\Lucanepa\OpenVolley\2.3.0`
     (it opens the PR from your fork);
   - **komac** (Linux too, `cargo install komac` or its release binary),
     or **by hand**: copy `manifests/l/Lucanepa/OpenVolley/2.3.0/` to the
     same path in your fork, commit, open a PR to `microsoft/winget-pkgs`
     `master` titled `New package: Lucanepa.OpenVolley version 2.3.0`.
3. On your first PR the Microsoft CLA bot asks you to agree (a comment).
   The pipeline then installs the package in a VM; a moderator merges it.
   Answer review comments in the PR.

Every later version: `update-manifests.sh` + `validate.sh --urls`, then the
same submit with the new folder (title `New version: Lucanepa.OpenVolley
version 2.4.0`), or let wingetcreate write it from the URL alone:

```powershell
wingetcreate update Lucanepa.OpenVolley --version 2.4.0 --submit --token <PAT> `
  --urls https://github.com/Lucanepa/openvolley/releases/download/desktop-v2.4.0/Openvolley.eScoresheet_2.4.0_x64-setup.exe
```

(`komac update Lucanepa.OpenVolley --version 2.4.0 --urls <url> --submit`
does the same on Linux.) This could later run in the desktop workflow after a
release (e.g. the `vedantmgoyal9/winget-releaser` action); it would need a
GitHub token with `public_repo` on your fork as a repository secret, so it is
not set up here.

## Not covered

- Not installed on a real Windows machine from these manifests (no Windows
  here); checked with the schemas, the cross-file rules and the real hashes.
  The Apps & features values were confirmed by running both release
  installers with `/S` under Wine (64-bit prefix): the 64-bit HKLM keys
  `Openvolley eScoresheet` and `OpenBeach` hold the DisplayName,
  DisplayVersion, Publisher `openvolley` and `C:\Program Files\<productName>`
  that the installer manifests give. A second `/S` run over the same version
  and a silent uninstall also worked there. Wine is not Windows: UAC, the
  firewall rule and winget itself were not tested.
- x64 only: there is no ARM64 Windows build.
