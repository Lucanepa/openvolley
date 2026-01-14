# Architecture & Tech Stack

## Tech Stack

Openvolley eScoresheet is built using modern web technologies:

-   **Frontend Framework:** [React](https://reactjs.org/) (v18)
-   **Build Tool:** [Vite](https://vitejs.dev/)
-   **Languages:** JavaScript / TypeScript
-   **State Management:** React Context / Local State
-   **Database (Offline):** [Dexie.js](https://dexie.org/) (IndexedDB wrapper) for storing matches, sets, and events locally.
-   **Backend / Sync:** [Supabase](https://supabase.com/) for real-time synchronization and remote storage.
-   **PDF Generation:** [jsPDF](https://github.com/parallax/jsPDF) and [pdf-lib](https://pdf-lib.js.org/) for generating official scoresheets.
-   **Desktop Wrapper:** [Electron](https://www.electronjs.org/)
-   **Mobile Wrapper:** [Capacitor](https://capacitorjs.com/)

## Project Structure

```
escoresheet/
├── frontend/
│   ├── electron/           # Electron main process and preload scripts
│   ├── public/             # Static assets
│   ├── scripts/            # Build scripts
│   ├── src/                # Main React application source
│   │   ├── components/     # Reusable UI components
│   │   ├── layout/         # Layout components
│   │   ├── views/          # Page views (Scoreboard, Home, etc.)
│   │   └── ...
│   ├── vite.config.js      # Vite configuration
│   └── package.json        # Project dependencies and scripts
├── backend/                # Backend logic (if any specific separate service)
└── ...
```

## Key Concepts

### Offline-First
The application is designed to be fully functional without an internet connection. All data represents the "truth" in the local `indexedDB` (managed by Dexie). When an internet connection is available, the app synchronizes changes to Supabase.

### PDF Generation
The app generates official volleyball scoresheets in PDF format directly in the browser. This ensures that no server-side processing is required for the critical task of producing the match report.
