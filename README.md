# OpenVolley

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

An open-source offline-first volleyball Progressive Web App (PWA) for scorekeeping and match management.

## Features

- 🏐 **Volleyball Scoreboard**: Track scores with proper volleyball rules (25/15 points, lead by 2)
- 🌍 **Internationalization**: Support for English, German, and Italian (EN/DE/IT)
- 📱 **PWA**: Works offline with service workers and IndexedDB
- 📊 **PDF Export**: Export match results to PDF using jsPDF
- 👥 **Lineup Management**: Manage team lineups and player positions
- 🔄 **Substitution Tracking**: Track player substitutions (max 6 per set)
- ☁️ **Realtime Sync**: Supabase integration for cloud synchronization
- 🔌 **Offline/Online Indicator**: Visual status of network connectivity
- ✅ **Tested**: Comprehensive Vitest test coverage for game rules

## Tech Stack

- **React** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool
- **Dexie** - IndexedDB wrapper for offline storage
- **Supabase** - Backend and realtime synchronization
- **i18next** - Internationalization
- **jsPDF** - PDF generation
- **Vitest** - Testing framework
- **vite-plugin-pwa** - PWA functionality

## Getting Started

### Prerequisites

- Node.js 18+ and npm

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Test

```bash
npm test
```

### Environment Variables

Create a `.env` file for Supabase configuration (optional):

```
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

Note: The app works fully offline without Supabase configuration.

## Volleyball Rules Implemented

- **Regular Sets**: First to 25 points, must win by 2
- **Tiebreak Set (5th)**: First to 15 points, must win by 2
- **Match Format**: Best of 5 sets
- **Substitutions**: Maximum 6 per set per team

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please ensure all source files include the GPL-3.0 header.

## Authors

OpenVolley Contributors

---

**Note**: This is an open-source project. Feel free to use, modify, and distribute under the GPL-3.0 license.
