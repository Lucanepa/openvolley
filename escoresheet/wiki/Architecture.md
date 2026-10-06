# Architecture & Tech Stack

## Tech Stack

| Category | Technology | Version |
|----------|-----------|---------|
| Frontend Framework | [React](https://react.dev/) | 19.2 |
| Build Tool | [Vite](https://vitejs.dev/) | 7.3 |
| Offline Database | [Dexie.js](https://dexie.org/) (IndexedDB) | 4.3 |
| Cloud Sync | [Supabase](https://supabase.com/) (PostgreSQL) | 2.95 |
| Desktop | [Electron](https://www.electronjs.org/) | 40 |
| Mobile | [Capacitor](https://capacitorjs.com/) | 8.1 |
| PDF Generation | [jsPDF](https://github.com/parallax/jsPDF), [pdf-lib](https://pdf-lib.js.org/) | 4.1 |
| PDF Parsing | [pdfjs-dist](https://mozilla.github.io/pdf.js/) | 5.4 |
| Internationalization | [i18next](https://www.i18next.com/) + react-i18next | 25.8 |
| PWA | [vite-plugin-pwa](https://vite-pwa-org.netlify.app/) | 1.2 |
| Backend (optional) | Node.js + [ws](https://github.com/websockets/ws) | >=20, 8.18 |
| Email (backend) | [Nodemailer](https://nodemailer.com/) + Resend API | 6.10 |
| State Management | React Context + local state | - |
| Languages | JavaScript (JSX) | - |

## Project Structure

```
openvolley/
├── index.html                      # Landing page (Indoor / Beach selector)
├── landing.js / landing.css        # Landing page assets
├── escoresheet/
│   ├── frontend/
│   │   ├── src/
│   │   │   ├── App.jsx             # Main scoreboard app
│   │   │   ├── RefereeApp.jsx      # Referee dashboard
│   │   │   ├── BenchApp.jsx        # Bench / coach interface
│   │   │   ├── LivescoreApp.jsx    # Live score display
│   │   │   ├── ScoresheetApp.jsx   # Scoresheet database browser
│   │   │   ├── UploadRosterApp.jsx # Roster PDF upload
│   │   │   ├── components/         # Shared UI components
│   │   │   ├── contexts/           # React contexts (Alert, Auth, Logging, Scale)
│   │   │   ├── db/                 # Dexie database schema & migrations
│   │   │   ├── hooks/              # Custom hooks (useAuth, useSyncQueue, useRealtimeConnection, ...)
│   │   │   ├── i18n/               # Translations (en, fr, it, de, de-CH)
│   │   │   ├── lib/                # Supabase client setup
│   │   │   └── utils/              # Utilities (backendConfig, connectionManager, parseRosterPdf, ...)
│   │   ├── electron/               # Electron main process (main.js, preload.js, serverManager.js)
│   │   ├── scripts/                # Build scripts (build-subdomains.js, translate.js, install-hooks.js)
│   │   ├── vite.config.js          # Multi-page build, PWA config
│   │   └── package.json
│   ├── backend/
│   │   ├── server.js               # WebSocket relay, email, iCal feed integration
│   │   └── package.json
│   └── wiki/                       # This documentation
├── .github/workflows/release.yml   # CI/CD: builds desktop apps on tag push
└── assets/                         # Shared images and icons
```

## Multi-Page Application

The app is built as a multi-page application with 6 entry points, each rendering a different React root:

| Route | Entry Point | Purpose |
|-------|-------------|---------|
| `/` | `App.jsx` | Main scoreboard (scoring interface) |
| `/referee` | `RefereeApp.jsx` | Referee dashboard |
| `/bench` | `BenchApp.jsx` | Bench / coach interface |
| `/livescore` | `LivescoreApp.jsx` | Live score display for spectators |
| `/scoresheet` | `ScoresheetApp.jsx` | Scoresheet database browser |
| `/upload_roster` | `UploadRosterApp.jsx` | Team roster PDF upload |

Each page has its own `index.html` and can be deployed independently as a separate subdomain (e.g., `referee.openvolley.app`).

Vite's `rollupOptions.input` configures all 6 entry points in a single build. The `build:subdomains` script produces separate `dist-*` folders for individual subdomain deployment.

## Subdomain Architecture

In production, each role is deployed as a separate subdomain:

```
                        DNS (Cloudflare)
                             │
        ┌──────────┬─────────┼─────────┬──────────┐
        ▼          ▼         ▼         ▼          ▼
   app.*      referee.*   bench.*  livescore.*  roster.*
  (main)
   Static      Static    Static    Static     Static
        │          │         │         │          │
        └──────────┴─────────┼─────────┴──────────┘
                             ▼
                    Backend (optional)
                    WebSocket + API
```

Indoor subdomains: `app`, `referee`, `bench`, `livescore`, `roster`, `scoresheet`
Beach subdomains: `beach`, `beach_referee`, `beach_scoresheet` (separate repo)

## Offline-First Data Flow

All data is written to local IndexedDB first, then synced to Supabase asynchronously:

```
User Action
    │
    ▼
Write to Dexie (IndexedDB)  ← immediate, works offline
    │
    ▼
Queue in sync_queue table   ← resource, action, payload, status
    │
    ▼
useSyncQueue hook processes  ← when online, in order: match → set → event
    │
    ▼
Upsert to Supabase          ← uses external_id for deduplication
```

**Key design decisions:**

- **Local-first writes**: Every user action writes to IndexedDB instantly. No network dependency for core functionality.
- **sync_queue table**: Buffers pending Supabase writes with status tracking (`queued` / `sent` / `error`).
- **Processing order**: `match` -> `set` -> `event` to respect foreign key dependencies in Supabase.
- **external_id pattern**: Each record gets a stable identifier (`seed_key` for matches, Dexie ID for sets/events) that survives sync. This enables safe `onConflict` upserts since Supabase UUIDs aren't known until first sync.

## Database Schema

The local database uses Dexie (IndexedDB) with 15 schema versions. Current tables:

| Table | Purpose | Key Indexes |
|-------|---------|-------------|
| `teams` | Team information | `name` |
| `players` | Player rosters | `teamId` |
| `matches` | Match metadata, signatures, PINs | `externalId`, `test` |
| `sets` | Set scores, timing | `matchId`, `startTime`, `endTime` |
| `events` | All match actions with state snapshots | `[matchId+seq]`, `[matchId+setIndex]` |
| `sync_queue` | Pending Supabase writes | `resource`, `status` |
| `match_setup` | Draft match configuration | `updatedAt` |
| `referees` | Referee profiles | `seedKey` |
| `scorers` | Scorer profiles | `seedKey` |
| `interaction_logs` | User interaction logs | `ts`, `gameNumber`, `sessionId` |

Events store a `stateSnapshot` after each action, enabling trivial undo (restore previous snapshot) instead of complex per-event reversal logic.

## Real-Time Communication

Two independent sync paths:

1. **Supabase cloud sync** (`useSyncQueue`): Asynchronous queue processing for data persistence. Works whenever internet is available.

2. **WebSocket relay** (`useRealtimeConnection`): Optional backend server for instant updates between Scoreboard, Referee, and Bench devices. Works over local WiFi (no internet) or cloud relay.
   - Every relay client resolves the relay through `getRelayWebSocketUrl()` (`utils/backendConfig.js`), so the scorer publishes where its tablets listen.
   - Match rooms are keyed by the match's `seed_key` (a test match's `seedKey`). The scorer does not publish a match before it has one: a Dexie id is never a room key. Subscribers, including the point-hub LedBox bridge, must use the seed key (`MATCH_ID=<seed key>`, or look it up via `/api/match/list` / `/api/match/by-game-number`). A request by Dexie id is not answered.
   - The scorer page has one relay connection (`scorerRelay` in `utils/relayPublisher.js`), shared by `App.jsx` (the current match, in every view) and `Scoreboard.jsx` (every scoring action), so one socket owns the match on the relay.
   - The scorer sends its PINs with the first sync of a key on its socket and when one changes. A relay that lost the match, or a socket that has not proved it yet, answers a PIN-less sync with `pins-required`, and the scorer resends them. That is not a failed claim: only claims carrying a wrong game PIN count toward the claim limits. Protocol reference: `frontend/electron/lanRelayCore.cjs`.
   - Tablets show the newest score whichever path brought it: a live-state push newer than the relay copy overrides that copy's score (`applyNewerLiveState`, `createLiveStateTracker`). "Newer" is the scorer's live-state sequence number (`_seq` / `_session` on the push) against the last number issued before the sync read IndexedDB (`match._syncedSeq` / `_syncSession`), never the wall clock: an NTP step back on the scorer must not roll the referee's score back. Only across sessions (a reload) or for a database row without a number do the timestamps (`updated_at` against `match._syncedAt`) decide. Referee and bench links (QR codes) preselect the match by its seed key and still ask for the PIN.

Both paths are optional. The app functions fully offline with local IndexedDB only.

## PDF Generation

Scoresheets are generated entirely in the browser using jsPDF and html-to-image. No server-side processing required. The app also uses pdfjs-dist to parse uploaded roster PDFs.

## PWA & Service Worker

Configured via `vite-plugin-pwa` with:

- **Update strategy**: `prompt` -- users choose when to update (no auto-skip-waiting)
- **Static assets**: Cache-first (30-day expiry)
- **API routes**: Network-first with 10s timeout, falling back to cache
- **HTML pages**: Network-first (24-hour cache)
- **Multi-page support**: `navigateFallback` is disabled; each page is served independently

## CI/CD

GitHub Actions workflow (`.github/workflows/release.yml`):

- **Triggers**: Push a tag matching `v*` or manual workflow dispatch with version input
- **Builds**: Parallel jobs for Windows (NSIS installer + portable), macOS (DMG + ZIP, x64 + arm64), Linux (AppImage + DEB + RPM)
- **Node.js**: v22
- **Output**: Creates a GitHub Release with all artifacts
- **Cleanup**: Automatically deletes releases older than the last 3
- **Required secrets**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
