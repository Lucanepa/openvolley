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
| Cloud Sync | Supabase (PostgreSQL) |
| Desktop | Electron 40 |
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

Download the latest desktop app from [GitHub Releases](https://github.com/lucacanepa/openvolley/releases):

- **Windows** -- Installer (.exe) or Portable (.exe)
- **macOS** -- DMG (.dmg) or ZIP (.zip) for Intel and Apple Silicon
- **Linux** -- AppImage, DEB, or RPM

## Contributing

Contributions are welcome! See the [Installation guide](escoresheet/wiki/Installation.md) to set up your development environment, and the [Architecture docs](escoresheet/wiki/Architecture.md) to understand the codebase.

## License

[GPL-3.0](LICENSE) -- Free and open source forever.
