# Openvolley eScoresheet

Open-source, offline-first volleyball match scoring for every court.

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)

## About

Openvolley eScoresheet is a digital scoring application for volleyball matches. It replaces the paper scoresheet with a modern app that works on any device -- tablets, phones, laptops, or desktops.

**Offline-first**: Score an entire match without internet. All data is stored locally and syncs to the cloud when a connection is available.

**Multi-role**: Separate interfaces for every role at the court:

- **Scoreboard** -- Full scoring interface for the scorer
- **Referee Dashboard** -- Live match view for the referee
- **Bench Dashboard** -- Team-specific view for coaches
- **Livescore** -- Spectator-facing score display for screens/projectors
- **Roster Upload** -- Import team rosters from PDF before the match
- **Scoresheet Database** -- Browse completed match scoresheets

**Cross-platform**: Runs as a web app (PWA), desktop app (Windows, macOS, Linux), or mobile app (Android, iOS).

**Official scoresheets**: Generates regulation-compliant PDF scoresheets directly in the browser.

**Multi-language**: English, French, Italian, German, Swiss German.

## Live Demo

| Subdomain | Purpose |
| --- | --- |
| [app.openvolley.app](https://app.openvolley.app) | Main Scoreboard |
| [referee.openvolley.app](https://referee.openvolley.app) | Referee Dashboard |
| [bench.openvolley.app](https://bench.openvolley.app) | Bench Dashboard |
| [livescore.openvolley.app](https://livescore.openvolley.app) | Live Score Display |
| [roster.openvolley.app](https://roster.openvolley.app) | Roster Upload |
| [scoresheet.openvolley.app](https://scoresheet.openvolley.app) | Scoresheet Database |
| [beach.openvolley.app](https://beach.openvolley.app) | Beach Volleyball |

## Quick Start

```bash
git clone https://github.com/lucacanepa/openvolley.git
cd openvolley/escoresheet/frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## Tech Stack

| Category | Technology |
| --- | --- |
| Frontend | React 19, Vite 7.3 |
| Offline Storage | Dexie.js 4.3 (IndexedDB) |
| Cloud Sync | Own Node.js backend + PostgreSQL |
| Desktop | Tauri 2 |
| Mobile | Capacitor 8 |
| PDF | jsPDF, pdf-lib, pdfjs-dist |
| i18n | i18next (5 languages) |
| PWA | vite-plugin-pwa |
| Backend (optional) | Node.js, WebSocket (ws) |

## Documentation

| Guide | Description |
| --- | --- |
| [Installation & Development](escoresheet/wiki/Installation.md) | Set up your dev environment |
| [Architecture](escoresheet/wiki/Architecture.md) | Tech stack, structure, design decisions |
| [Deployment](escoresheet/wiki/Deployment.md) | Build for web, desktop, mobile |
| [User Guide](escoresheet/wiki/User-Guide.md) | How to score a match |
| [Troubleshooting](escoresheet/wiki/Troubleshooting.md) | Common issues and solutions |
| [Backend Server](escoresheet/backend/README.md) | Optional WebSocket relay for multi-device sync |

## Desktop Downloads

Install page: [get.openvolley.app](https://get.openvolley.app). Downloads are on [GitHub Releases](https://github.com/Lucanepa/openvolley/releases):

- **Windows** -- installer (`…_x64-setup.exe`), or `winget install Lucanepa.OpenVolley`
- **macOS** -- universal disk image (`…_universal.dmg`, Apple silicon and Intel, macOS 11+; signed and notarized by Apple) or `brew install --cask lucanepa/tap/openvolley`
- **Linux** -- AppImage, or the signed APT repository (`curl -fsSL https://get.openvolley.app/install.sh | sudo sh`, or the two steps below)

### Check the downloads

The install page and the package repositories are served from one host. The
values here come from GitHub instead, so a first install can be checked
against a second source before anything runs as root.

install.sh SHA-256: `4714c20c314aa2e96793c231efed17038c08b98060bd6b960740cee936bdc3d8`

```sh
curl -fsSLO https://get.openvolley.app/install.sh
sha256sum install.sh        # must print the SHA-256 above
sudo sh install.sh          # or: sudo sh install.sh openbeach-escoresheet
```

| Key | Fingerprint |
|---|---|
| APT repository (`apt/openvolley.gpg`, checked by install.sh) | `AB46 9DA8 DC3E C90F 8057 320D 285B 18D7 6C16 B82C` |
| pacman repository (`arch/openvolley.gpg`) | `BE15 C309 C340 D0BC 214C 82E6 E6E4 A27E 6680 A88B` |
| Flatpak repository (`flatpak/openvolley-flatpak.gpg`, in the `.flatpakref`) | `BC22 2902 84D8 80AA 4151 453F 335B 7570 B684 CF6D` |
| F-Droid repository (`fdroid/repo`) | `61C70F8949441E04E2E21ACC8E6E5C6CC502ADD52A157FB9A8DD8588DACE0720` |
| Desktop updater (minisign, in `tauri.conf.json`) | key id `10D20EE2D20973C5` |

Each GitHub release lists the SHA-256 of its installers in its notes.

## Contributing

Contributions are welcome! See the [Installation guide](escoresheet/wiki/Installation.md) to set up your development environment, and the [Architecture docs](escoresheet/wiki/Architecture.md) to understand the codebase.

## License

[GPL-3.0-or-later](LICENSE) -- Free and open source forever.
