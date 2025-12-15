# Openvolley eScoresheet

Offline-first volleyball e-scoresheet. Works fully offline with optional cloud sync.

## Quick Start

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173

## Build Desktop App

```bash
npm run electron:build:win    # Windows
npm run electron:build:mac    # macOS
npm run electron:build:linux  # Linux
```

## Documentation

- **User Guide**: [frontend/public/USER_GUIDE.md](./frontend/public/USER_GUIDE.md)

## Tech Stack

- React + Vite + PWA
- IndexedDB (Dexie) for offline storage
- Supabase for cloud sync (optional)
- Electron for desktop builds

## License

GPL-3.0
