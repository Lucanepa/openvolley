# User Guide

## Introduction

Openvolley eScoresheet lets you digitally score volleyball matches on any device. It tracks points, rotations, substitutions, timeouts, and sanctions, then generates an official PDF scoresheet at the end.

The app works completely offline -- no internet connection required during a match. If you have internet, your data syncs automatically to the cloud for backup and live viewing.

## Accessing the App

- **Web**: Visit [app.openvolley.app](https://app.openvolley.app). You can install it as a PWA (your browser will prompt you) for offline use.
- **Desktop**: Download from [GitHub Releases](https://github.com/lucacanepa/openvolley/releases) (Windows, macOS, Linux).
- **Mobile**: Install the PWA from your browser, or build native apps via Capacitor.

## Roles

The app provides separate interfaces for different roles during a match:

### Scoreboard (Main App)

The primary scoring interface. This is where the scorer records every rally, substitution, timeout, and sanction. It controls the match flow and broadcasts updates to other connected devices.

Access: [app.openvolley.app](https://app.openvolley.app)

### Referee Dashboard

A read-only view for the referee to follow the match in real time. Shows current score, rotations, and recent events.

Access: [referee.openvolley.app](https://referee.openvolley.app)

### Bench Dashboard

Team-specific view for coaches. Shows their team's rotation, substitution history, and timeout status.

Access: [bench.openvolley.app](https://bench.openvolley.app)

### Livescore Display

A spectator-facing scoreboard designed for large screens or projectors. Shows the score in a clean, minimal layout.

Access: [livescore.openvolley.app](https://livescore.openvolley.app)

### Roster Upload

Upload team roster PDFs before the match. The app parses player names and numbers from the PDF automatically.

Access: [roster.openvolley.app](https://roster.openvolley.app)

### Scoresheet Database

Browse and view completed match scoresheets.

Access: [scoresheet.openvolley.app](https://scoresheet.openvolley.app)

## Scoring a Match

### 1. Create a Match

On the home screen, tap "New Match". Fill in the match details:

- Teams (home and away)
- Date, time, and location
- Competition / league
- Game number
- Officials (referees, scorer)

You can also import match details from official league feeds if your federation is configured.

### 2. Enter Rosters

Add players for both teams:

- Enter player number, name, and position manually
- Or import rosters from uploaded PDFs
- Designate liberos (up to 2) and the team captain

### 3. Coin Toss

Record the coin toss result:

- Which team won the toss
- Their choice (serve or receive, and court side)

### 4. Set Starting Lineups

Place players into the 6 rotation positions for each team. The app validates that lineups are legal before you can proceed.

### 5. Score Rallies

Tap the side of the team that won the rally. The app handles:

- Point scoring
- Rotation tracking on side-out
- Service order validation

### 6. Record Events During Play

- **Substitutions**: Tap the substitution button, select the player going in and out. The app tracks substitution limits per set.
- **Timeouts**: Tap the timeout button. The app tracks timeouts per set per team.
- **Sanctions**: Access the sanctions menu to issue yellow cards, red cards, or expulsion/disqualification.
- **Corrections**: If you make a mistake, use the undo function to step back.

### 7. End of Set

When a set ends, the app will:

- Confirm the final set score
- Switch court sides automatically
- Prompt you to enter lineups for the next set

### 8. Finish the Match

When a team wins the required number of sets (3 out of 5, or 2 out of 3):

- The match is marked as final
- Capture digital signatures from captains, coaches, and referees
- Generate and download the official PDF scoresheet

## Working Offline

The app is designed to work without any internet connection:

- All match data is stored locally in your browser's IndexedDB database
- The connection status indicator in the app shows your current state
- When you regain internet, data syncs automatically to the cloud
- You can score an entire match offline and sync later

Your data persists across browser sessions -- closing the browser or the tab does not lose your match.

## Multi-Device Setup

To connect multiple devices (e.g., Scoreboard + Referee + Bench):

1. The scorer's device runs the main Scoreboard app
2. A WebSocket backend must be running (either locally on the same network or in the cloud)
3. The scorer enables connections and sets a match PIN in the match settings
4. Referee and Bench devices enter the PIN to connect

For setup details, see the [Backend README](../backend/README.md).

**Local network (no internet)**: All devices connect to the same WiFi. The backend runs on a laptop on the network.

**Cloud relay**: The backend runs on Render or similar. All devices need internet.

## Language Settings

The app supports multiple languages:

- English
- French (Francais)
- Italian (Italiano)
- German (Deutsch)
- Swiss German (Schweizerdeutsch)

The app auto-detects your browser language. You can change the language manually in the app settings.

## Data Backup & Export

- **PDF scoresheet**: Generated at the end of each match. Can be downloaded or shared.
- **Local storage**: All data persists in your browser's IndexedDB. Clearing browser data will delete match data.
- **Cloud sync**: When connected to Supabase, match data is automatically backed up. If you lose local data, matches that were synced can be recovered.
