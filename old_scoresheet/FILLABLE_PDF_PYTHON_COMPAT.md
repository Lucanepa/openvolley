# Fillable PDF Generation - Python-Compatible Implementation

This implementation matches the working Python script exactly, using `pdf-lib` to fill form fields in the `matchblatt_fillable.pdf`.

## Files

- **`src/utils/fillPdfFormSimple.js`** - Core filling logic (matches Python)
- **`src/utils/generateFillablePdfSimple.js`** - PDF generation and download
- **`src/components/Scoreboard.jsx`** - Integration with Scoreboard (debug function)
- **`test-fill-from-json.html`** - Standalone test page

## Usage in Scoreboard

When viewing a match in the Scoreboard, open the browser console (F12) and run:

```javascript
window.debugGenerateFillablePDF()
```

This will:
1. Gather the current match data
2. Look up team names from the teams table
3. Fill the PDF form fields
4. Download the filled PDF

## Field Mappings (Python-Compatible)

### Match Type Checkboxes (Fields ending with `_x`)
- `championship_x` - Championship match
- `cup_x` - Cup match
- `friendly_x` - Friendly match
- `tournament_x` - Tournament match

### Category Checkboxes
- `men_x` - Men's match
- `female_x` - Women's match
- `U19_x`, `U17_x`, `U23_x` - Age group matches

### Match Information
- `liga_text` - League name
- `match_n` - Match/game number
- `home_team` - Home team name (from teams table)
- `away_team` - Away team name (from teams table)
- `home_team_short` - First 3 letters of home team (uppercase)
- `away_team_short` - First 3 letters of away team (uppercase)
- `city` - City
- `hall` - Hall/venue name
- `date` - Match date (DD.MM.YYYY format)
- `time` - Match time (HH:MM format)

### Bench Officials (per team)
- `home_roster_coach_name` / `home_roster_coach_dob`
- `home_roster_ac1_name` / `home_roster_ac1_dob` - Assistant Coach 1
- `home_roster_ac2_name` / `home_roster_ac2_dob` - Assistant Coach 2
- `home_roster_p_name` / `home_roster_p_dob` - Physiotherapist
- `home_roster_m_name` / `home_roster_m_dob` - Medical

(Same pattern for `away_roster_*`)

### Match Officials
- `1_referee_name` / `1_referee_country` / `1_referee_dob`
- `2_referee_name` / `2_referee_country` / `2_referee_dob`
- `scorer_name` / `scorer_country` / `scorer_dob`
- `ass_scorer_name` / `ass_scorer_country` / `ass_scorer_dob`

## Data Format

The function expects match data in this format:

```javascript
{
  match_type_1: 'championship',  // or 'cup', 'friendly', 'tournament'
  match_type_2: 'men',            // or 'female', 'U19', 'U17', 'U23'
  league: 'League Name',
  gameNumber: '123',
  homeTeam: 'Team A',  // Team name (not ID)
  awayTeam: 'Team B',  // Team name (not ID)
  city: 'City Name',
  hall: 'Hall Name',
  scheduledAt: '2025-11-17T14:00:00Z',  // ISO date/time
  bench_home: [
    { role: 'Coach', firstName: 'John', lastName: 'Doe', dob: '01.01.1980' }
  ],
  bench_away: [
    { role: 'Coach', firstName: 'Jane', lastName: 'Smith', dob: '02.02.1985' }
  ],
  officials: [
    { role: '1st referee', firstName: 'Ref', lastName: 'One', country: 'SUI', dob: '03.03.1990' },
    { role: '2nd referee', firstName: 'Ref', lastName: 'Two', country: 'GER', dob: '04.04.1991' },
    { role: 'scorer', firstName: 'Score', lastName: 'Keeper', country: 'AUT', dob: '05.05.1992' },
    { role: 'assistant scorer', firstName: 'Asst', lastName: 'Scorer', country: 'ITA', dob: '06.06.1993' }
  ]
}
```

## Date Formats

- **Input:** ISO 8601 format (`2025-11-17T14:00:00Z`) or `DD/MM/YYYY`
- **Output (Date):** `DD.MM.YYYY` (e.g., `17.11.2025`)
- **Output (Time):** `HH:MM` (e.g., `14:00`)
- **DOB:** `DD/MM/YYYY` → `DD.MM.YYYY` (slashes converted to dots)

## Testing

Use `test-fill-from-json.html`:

1. Open `test-fill-from-json.html` in a browser
2. Paste your database export JSON
3. Click "Fill PDF"
4. Check console for field filling progress
5. PDF will download automatically

The console will show:
- `✓ field_name: value` for each successfully filled field
- Total number of fields set
- Any errors encountered

## Differences from Python Implementation

None - this is a 1:1 port of the Python logic to JavaScript using `pdf-lib`.

## Form Flattening

After filling, the form is flattened (made non-editable) using `form.flatten()`. This converts form fields into regular content on the PDF page.

