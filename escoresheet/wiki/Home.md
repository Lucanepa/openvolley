# Openvolley eScoresheet Wiki

**Openvolley eScoresheet** is an offline-first volleyball match scoring application for scorers, referees, and coaches. It runs on any device as a web app, desktop app, or mobile app, and supports both indoor and beach volleyball.

## Key Features

- **Offline-first**: Works without internet using local IndexedDB storage. Syncs to the cloud when connected.
- **Cross-platform**: Web (PWA), Desktop (Windows, macOS, Linux), Mobile (Android, iOS).
- **Multi-role**: Dedicated interfaces for Scoreboard, Referee, Bench, Livescore, Roster Upload, and Scoresheet Database.
- **Official scoresheets**: Generates PDF scoresheets compliant with volleyball regulations.
- **Real-time sync**: Optional WebSocket backend for live multi-device communication.
- **Multi-language**: English, French, Italian, German, Swiss German.

## Documentation

- **[Installation & Development](Installation.md)** -- Set up the project and start developing.
- **[Architecture](Architecture.md)** -- Tech stack, project structure, and design decisions.
- **[Deployment](Deployment.md)** -- Build and deploy for web, desktop, and mobile.
- **[User Guide](User-Guide.md)** -- How to score a match step by step.
- **[Troubleshooting](Troubleshooting.md)** -- Solutions to common issues.

## Additional Resources

- [Backend WebSocket Server](../backend/README.md) -- Optional relay server for multi-device sync.
- [GitHub Releases](https://github.com/lucacanepa/openvolley/releases) -- Desktop app downloads.
- [Live App](https://app.openvolley.app) -- Try the web version.

## Contributing

Contributions are welcome! See the [Installation guide](Installation.md) to set up your development environment.
