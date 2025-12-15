# Openvolley eScoresheet
## User Guide v0.8.2

---

# Table of Contents

1. Getting Started
2. Match Setup
3. Recording a Match
4. Dashboard Server (LAN Mode)
5. Match End & Approval
6. Additional Features
7. Troubleshooting

---

# 1. Getting Started

## Installation Options

| Platform | How to Install |
|----------|----------------|
| **Web Browser** | Visit the app URL, click "Install" in browser |
| **Windows** | Download `.exe` from GitHub Releases |
| **macOS** | Download `.dmg` from GitHub Releases |
| **Linux** | Download `.AppImage` from GitHub Releases |

## First Launch

Choose your match type:
- **Official Match** - Syncs to cloud, generates official scoresheets
- **Test Match** - Local only, for practice and testing

---

# 2. Match Setup

## Step-by-Step Setup

### 1. Match Information
- Date & Time
- Hall / Venue
- City
- League / Competition
- Game Number

### 2. Team Setup
For Home and Away teams:
- Team Name
- Team Color
- Short Name (3-4 letters)

### 3. Roster Setup

**Manual Entry:**
- Player Number, Name, DOB
- Mark Libero 1 / Libero 2
- Mark Team Captain

**PDF Upload:**
- Click "Upload PDF"
- System parses roster automatically

**Remote Upload (via Dashboard Server):**
- Teams can upload their roster remotely using the Game PIN

### 4. Bench Officials
- Coach
- Assistant Coach 1 & 2
- Physiotherapist
- Medic

### 5. Match Officials
- 1st Referee
- 2nd Referee
- Scorer
- Assistant Scorer

### 6. Coin Toss
- Select coin toss winner
- Select serve/receive choice
- Confirm

### 7. Pre-Match Signatures
- Home Coach & Captain
- Away Coach & Captain

---

# 3. Recording a Match

## Scoreboard Interface

### Point Recording
Click the team's point button to award points. Score updates automatically.

### Timeouts
- 2 timeouts per team per set
- Click Timeout > Select team
- Countdown timer starts automatically

### Substitutions
1. Click Substitution
2. Select team
3. Choose player OUT
4. Choose player IN
5. Confirm

### Sanctions (Cards)
| Card | Type | Effect |
|------|------|--------|
| Yellow | Warning | No point loss |
| Red | Penalty | Point to opponent |
| Red+Yellow (separate) | Expulsion | Player sits out remainder of set |
| Red+Yellow (together) | Disqualification | Player leaves match |

### Set End
- Set ends at 25 points (15 in set 5) with 2-point lead
- Click "Set End" to confirm
- Enter set duration
- Next set begins automatically

---

# 4. Dashboard Server (LAN Mode)

## Overview
Connect referee tablets and bench devices over local network - **no internet required**.

## Enabling Dashboard Server

1. Open **Home Options** (gear icon)
2. Find **Dashboard Server** section
3. Toggle **ENABLED**

## Connection Information

When enabled, you'll see:
- **Server URL**: `http://192.168.x.x:5173`
- **WebSocket Port**: `8080`
- **Referee PIN**: 6-digit code
- **QR Code**: Scan to connect quickly

## Connecting Devices

### Referee Tablet
1. Open browser on tablet
2. Navigate to server URL + `/referee`
3. Enter Referee PIN
4. Real-time match view enabled

### Bench Dashboard
1. Open browser on bench device
2. Navigate to server URL + `/bench`
3. Enter Team PIN (home or away)
4. View roster, substitutions, timeouts

### Livescore Display
1. Navigate to server URL + `/livescore`
2. Enter Game PIN
3. Display live score on projector/TV

## Header Indicator
When dashboards are connected, the header shows:
- Number of connected devices
- Referee PIN for quick reference

---

# 5. Match End & Approval

## Review Screen

After final set, review:
- Final Score (sets)
- Set-by-set breakdown
- Sanctions issued
- Match remarks

## Approval Signatures

Collect signatures in order:
1. Home Team Captain
2. Away Team Captain
3. Assistant Scorer (if present)
4. Scorer
5. 2nd Referee (if present)
6. 1st Referee

## Confirm and Approve

Clicking "Confirm and Approve" will:
- Save match to cloud (official matches)
- Generate PDF scoresheet
- Save JPG screenshot
- Export JSON backup

---

# 6. Additional Features

## Auto-Backup (Desktop App)
- Automatic backups to selected folder
- Works offline
- Configurable in Settings

## Remote Roster Upload
Teams can upload rosters before the match:
1. Share the upload URL with teams
2. Teams enter Game Number + Upload PIN
3. Upload roster PDF
4. Scorer accepts or rejects in Match Setup

## Offline Mode
- All data stored locally (IndexedDB)
- No data loss if connection drops
- Syncs automatically when back online

## Export Formats
| Format | Use |
|--------|-----|
| PDF | Official scoresheet record |
| JPG | Visual backup |
| JSON | Data backup / analysis |

---

# 7. Troubleshooting

## Connection Issues

| Status | Solution |
|--------|----------|
| "Offline" | Check internet connection |
| "Online (No Supabase)" | Supabase not configured |
| "Sync Error" | Check credentials, retry |

## Common Problems

**Match not saving:**
- Check browser storage permissions
- Clear cache and retry

**PDF not generating:**
- Disable popup blocker
- Check available disk space

**Roster upload fails:**
- Ensure PDF contains readable text
- Try different PDF format

**Dashboard not connecting:**
- Verify devices on same network
- Check firewall settings
- Confirm correct PIN entered

---

# Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space | Point to Home team |
| Enter | Point to Away team |
| Escape | Close modals |
| F | Toggle fullscreen |

---

# Support

**Email:** luca.canepa@gmail.com
**GitHub:** github.com/lucacanepa/openvolley

---

*Openvolley eScoresheet - Open source volleyball scoring*
*GPL-3.0 License - Free forever*
