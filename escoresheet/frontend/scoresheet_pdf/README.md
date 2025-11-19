# Scoresheet PDF Integration

## Overview

This directory contains the React-based scoresheet viewer that displays match data in a printable format following the official FIVB volleyball scoresheet layout.

## Changes Made

### 1. Removed Mock Data
- All mock data has been removed from `App_Scoresheet.tsx`
- The component now accepts real match data via props

### 2. Updated Component Structure
- `App_Scoresheet.tsx` now accepts a `matchData` prop containing:
  - `match`: Match details (dates, location, officials, etc.)
  - `homeTeam` / `awayTeam`: Team information
  - `homePlayers` / `awayPlayers`: Player rosters
  - `sets`: Set-by-set score data
  - `events`: Match events (serves, subs, timeouts, etc.)
  - `sanctions`: Disciplinary actions

### 3. Type System Updates
- Updated `types_scoresheet.ts` to match database schema
- Fixed imports in all component files (`FooterSection.tsx`, `SetFive.tsx`, `StandardSet.tsx`)
- Made `Player` type compatible with database player records

### 4. Integration with Main App
- Updated `MatchEnd.jsx` to pass match data to scoresheet
- Data is stored in `sessionStorage` when "Show Scoresheet" button is clicked
- Scoresheet opens in a new window
- Updated `index_scoresheet.tsx` to load data from `sessionStorage`

### 5. Build Configuration
- Added scoresheet to main Vite build config (`vite.config.js`)
- Scoresheet is now built as part of the main application
- Accessible at `/scoresheet_pdf/index_scoresheet.html` in production

## Usage

### From Match End Screen
1. Complete a match
2. Navigate to the Match End screen
3. Click "Show Scoresheet" button
4. Scoresheet opens in a new window with all match data
5. Use "Print PDF" button to print/save as PDF
6. Use "Close" button to close the window

### Data Flow
```
MatchEnd.jsx 
  → Loads match data from Dexie database
  → Stores data in sessionStorage
  → Opens new window with scoresheet
  
index_scoresheet.tsx
  → Retrieves data from sessionStorage
  → Passes to App_Scoresheet component
  → Cleans up sessionStorage
  
App_Scoresheet.tsx
  → Renders scoresheet with real data
  → Formats players, sets, and match info
  → Provides print/close controls
```

## Data Mapping

### Players
Database player records are mapped to scoresheet format:
- `number`: Player jersey number (converted to string)
- `name`: Full name (from `firstName` + `lastName`)
- `dob`: Date of birth
- `libero`: Libero designation (libero1, libero2, or empty)
- `isCaptain`: Captain flag

### Sets
Set data from database includes:
- `startTime` / `endTime`: Set timing
- `homePoints` / `awayPoints`: Final scores
- Lineup and substitution data (to be implemented from events)

### Match Info
Match metadata includes:
- Teams (A/B designation based on coin toss)
- Officials (referees, scorer, assistant scorer)
- Venue and date information
- Signatures (coaches and captains)

## TODO: Future Enhancements

1. **Parse Events**: Extract lineups, substitutions, and timeouts from event log
2. **Sanctions**: Parse sanction events and display in sanctions table
3. **Set 5 Logic**: Handle court change at 8 points in deciding set
4. **Validation**: Add validation for incomplete data
5. **Offline Support**: Ensure scoresheet works without network connection
6. **Export Options**: Add PDF export functionality (currently uses browser print)

## Development

### Running the Scoresheet in Dev Mode
```bash
# From escoresheet/frontend directory
npm run dev

# Access scoresheet at:
http://localhost:5173/scoresheet_pdf/index_scoresheet.html
```

### Building
```bash
npm run build

# Scoresheet will be built to dist/scoresheet_pdf/
```

## Technical Notes

- Uses Tailwind CSS for styling
- Optimized for A4 landscape printing
- Responsive layout that scales for different screen sizes
- Print styles ensure proper page breaks and layout
- Uses React 19 and TypeScript for type safety

