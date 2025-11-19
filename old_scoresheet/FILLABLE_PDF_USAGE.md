# How to Use the Fillable PDF System

## Overview

This system allows you to fill the official fillable PDF scoresheet (`matchblatt_fillable.pdf`) with match data from your application.

## Step-by-Step Workflow

### 1. Extract Field Mapping (One-time setup)

1. Open `extract-pdf-fields.html` in your browser
2. Click "Extract Fields" - it will automatically load `matchblatt_fillable.pdf`
3. Review the extracted fields to see all form field names
4. Click "Download Mapping File" to save `pdf-field-mapping.json`
5. Place the JSON file in your `public/` folder (or wherever your static assets are served)

### 2. Use the Mapping File in Your Code

The JSON mapping file contains:
- **fieldMappings**: All field names and their data types
- **fieldGroups**: Organized groups (players, liberos, bench officials)
- **specialFields**: Checkboxes, dates, etc.

### 3. Generate Filled PDFs

#### Option A: Using the Helper Function (Recommended)

```javascript
import { generateAndDownloadFillablePdf, transformMatchDataForFillablePdf } from './utils/generateFillablePdf.js'

// Transform your existing match data
const matchData = {
  match: data.match,
  homeTeam: data.homeTeam,
  awayTeam: data.awayTeam,
  homePlayers: data.homePlayers,
  awayPlayers: data.awayPlayers,
  referees: allReferees,
  scorers: allScorers
}

// Transform to fillable PDF format
const fillableData = transformMatchDataForFillablePdf(matchData)

// Generate and download
await generateAndDownloadFillablePdf(fillableData)
```

#### Option B: Direct Usage

```javascript
import { generateFilledPdf } from './utils/fillPdfForm.js'

// Load the mapping file
const mappingResponse = await fetch('/pdf-field-mapping.json')
const fieldMapping = await mappingResponse.json()

// Prepare match data
const matchData = {
  match: {
    scheduledAt: '2025-11-16T20:00:00.000Z',
    venue: 'Kantonsschule Wiedikon (Halle A)',
    city: 'Zürich',
    league: '3L B',
    gameNumber: '123456',
    matchType: 'championship' // or 'cup'
  },
  homeTeam: { name: 'Volley Zürich Test' },
  awayTeam: { name: 'Volley Basel Test' },
  players: {
    home: [
      { number: 1, name: 'Müller Max', firstName: 'Max', lastName: 'Müller', dob: '15.05.1995' },
      // ... up to 14 players
    ],
    away: [ /* same structure */ ]
  },
  liberos: {
    home: [
      { number: 13, name: 'Libero1', firstName: 'Lib', lastName: 'Ero1', dob: '10.01.1995' },
      // ... up to 2 liberos
    ],
    away: [ /* same structure */ ]
  },
  bench: {
    home: [
      { role: 'coach', firstName: 'Marco', lastName: 'Frei', dob: '15.05.1975' },
      { role: 'assistant_coach', firstName: 'Jan', lastName: 'Widmer', dob: '21.09.1980' },
      { role: 'physiotherapist', firstName: 'Eva', lastName: 'Gerber', dob: '03.12.1985' }
    ],
    away: [ /* same structure */ ]
  },
  officials: {
    referee1: { firstName: 'Hans', lastName: 'Müller' },
    referee2: { firstName: 'Peter', lastName: 'Schmidt' },
    scorer: { firstName: 'Anna', lastName: 'Weber' },
    assistantScorer: { firstName: 'Lisa', lastName: 'Fischer' }
  }
}

// Generate PDF
const pdfBytes = await generateFilledPdf('matchblatt_fillable.pdf', fieldMapping, matchData)

// Download or display
const blob = new Blob([pdfBytes], { type: 'application/pdf' })
const url = URL.createObjectURL(blob)
// ... use URL for download or iframe display
```

## Integration with Existing Code

You can integrate this into your existing Scoreboard component:

```javascript
// In Scoreboard.jsx, add a new button or replace the existing PDF generation

import { generateAndDownloadFillablePdf, transformMatchDataForFillablePdf } from '../utils/generateFillablePdf.js'

// In your component:
const handleGenerateFillablePdf = async () => {
  try {
    const allReferees = await db.referees.toArray()
    const allScorers = await db.scorers.toArray()
    
    const matchData = {
      match: data.match,
      homeTeam: data.homeTeam,
      awayTeam: data.awayTeam,
      homePlayers: data.homePlayers || [],
      awayPlayers: data.awayPlayers || [],
      referees: allReferees,
      scorers: allScorers
    }
    
    const fillableData = transformMatchDataForFillablePdf(matchData)
    await generateAndDownloadFillablePdf(fillableData)
  } catch (error) {
    console.error('Error generating fillable PDF:', error)
    alert('Error generating PDF. Please try again.')
  }
}
```

## Data Format Requirements

### Match Data Structure

```javascript
{
  match: {
    scheduledAt: 'ISO date string', // Required for date/time formatting
    date: '16.11.2025', // Optional: pre-formatted (dd.mm.yyyy)
    time: '20:00', // Optional: pre-formatted (HH:mm)
    venue: 'Venue name',
    city: 'City name',
    league: 'League name',
    gameNumber: '123456',
    matchType: 'championship' // or 'cup' (for checkbox)
  },
  homeTeam: { name: 'Team name' },
  awayTeam: { name: 'Team name' },
  players: {
    home: [ /* array of player objects */ ],
    away: [ /* array of player objects */ ]
  },
  liberos: {
    home: [ /* array of libero objects */ ],
    away: [ /* array of libero objects */ ]
  },
  bench: {
    home: [ /* array of bench official objects */ ],
    away: [ /* array of bench official objects */ ]
  },
  officials: {
    referee1: { firstName: 'First', lastName: 'Last' },
    referee2: { firstName: 'First', lastName: 'Last' },
    scorer: { firstName: 'First', lastName: 'Last' },
    assistantScorer: { firstName: 'First', lastName: 'Last' }
  }
}
```

### Player Object Structure

```javascript
{
  number: 1, // Player number
  name: 'Müller Max', // Full name (or will be constructed from firstName/lastName)
  firstName: 'Max', // Optional
  lastName: 'Müller', // Optional
  dob: '15.05.1995' // Date of birth in dd.mm.yyyy format (or dd/mm/yyyy, will be converted)
}
```

### Bench Official Object Structure

```javascript
{
  role: 'coach', // 'coach', 'assistant_coach', 'physiotherapist', etc.
  firstName: 'Marco',
  lastName: 'Frei',
  name: 'Frei Marco', // Optional: full name
  dob: '15.05.1975' // Date of birth in dd.mm.yyyy format
}
```

## Important Notes

1. **Date Format**: Dates should be in `dd.mm.yyyy` format. The system will convert `dd/mm/yyyy` automatically.

2. **Field Names**: The actual field names in your PDF may differ. Use the extractor tool to see the exact field names.

3. **Player Roster**: 
   - Up to 14 players per team (fills individual fields per row)
   - Up to 2 liberos per team (fills individual fields per row)

4. **Checkboxes**: Fields ending with `_x` are checkboxes. The system will check/uncheck them based on the match type.

5. **File Locations**:
   - `matchblatt_fillable.pdf` should be in your `public/` folder
   - `pdf-field-mapping.json` should be in your `public/` folder (or adjust paths in code)

## Troubleshooting

- **Fields not filling**: Check that field names in the mapping match your PDF. Re-extract if needed.
- **Date format issues**: Ensure dates are in `dd.mm.yyyy` or `dd/mm/yyyy` format.
- **Missing players**: Make sure player arrays have the correct structure and data.
- **Checkboxes not working**: Verify `matchType` is set to 'championship' or 'cup'.

