# Openvolley eScoresheet - User Guide

A comprehensive guide to using the Openvolley eScoresheet application for recording volleyball matches.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Application Overview](#application-overview)
3. [Creating a Match](#creating-a-match)
4. [Match Setup](#match-setup)
5. [Recording a Match](#recording-a-match)
6. [Match End & Approval](#match-end--approval)
7. [Additional Features](#additional-features)
8. [Troubleshooting](#troubleshooting)

---

## Getting Started

### Installation

The eScoresheet is a Progressive Web App (PWA) that can be installed on your device:

1. **Open the application** in your web browser
2. **Look for the install prompt** (usually appears in the address bar or as a notification)
3. **Click "Install"** to add it to your home screen
4. The app will work **fully offline** once installed

### First Launch

When you first open the app, you'll see the home screen with two options:
- **Official Match**: For real matches that sync to the cloud
- **Test Match**: For practice and testing (doesn't sync)

---

## Application Overview

### Main Views

1. **Home Screen**: Choose between Official or Test matches
2. **Match Setup**: Configure match details, teams, and rosters
3. **Scoreboard**: Record the match in real-time
4. **Match End**: Review results, sign, and approve the match

### Connection Status

The app shows your connection status:
- **Offline**: No internet connection
- **Online (No Supabase)**: Online but Supabase not configured
- **Connecting...**: Attempting to connect to Supabase
- **Syncing...**: Currently syncing data
- **Synced**: Successfully connected and synced
- **Sync Error**: Connection or sync issue

---

## Creating a Match

### Official Match

1. From the home screen, click **"Official Match"**
2. You'll see the connection status
3. Click **"New official match"** to create a new match
4. The match will be created with a unique Game PIN (displayed in the modal)

### Test Match

1. From the home screen, click **"Test Match"**
2. Click **"New test match"** to create a test match
3. Test matches are stored locally only and don't sync to the cloud

### Continue Existing Match

- Click **"Continue official match"** or **"Continue test match"** to resume a match in progress

---

## Match Setup

### Step 1: Match Information

Fill in the match details:
- **Date & Time**: Scheduled match time
- **Hall**: Venue name
- **City**: Location
- **League**: Competition name
- **Game Number**: Official match number (if applicable)

### Step 2: Team Setup

For each team (Home and Away):

1. **Team Name**: Enter the team name
2. **Team Color**: Choose a color for identification
3. **Short Name**: Abbreviated name for scoresheet display

### Step 3: Roster Setup

#### Adding Players Manually

1. Enter player information:
   - **Number**: Jersey number
   - **Last Name**: Player's last name
   - **First Name**: Player's first name
   - **Date of Birth**: Player's DOB (dd/mm/yyyy format)
   - **Libero**: Select if player is Libero 1 or Libero 2
   - **Captain**: Check if player is team captain

2. Click **"Add Player"** to add to roster
3. Repeat for all players (minimum 6 required)

#### Uploading Roster from PDF

1. Click **"Upload PDF"** button
2. Select the roster PDF file
3. The system will parse player information automatically
4. Review and accept the imported roster

#### Pending Roster Uploads

If a roster was uploaded via the upload roster page:
- You'll see a notification with the number of players
- Click **"Accept"** to import the roster
- Click **"Reject"** to discard it

### Step 4: Bench Officials

Add bench officials for each team:
- **Coach**
- **Assistant Coach 1**
- **Assistant Coach 2**
- **Physiotherapist**
- **Medic**

Enter their:
- **Role**: Select from dropdown
- **Last Name**: Official's last name
- **First Name**: Official's first name
- **Date of Birth**: Official's DOB

### Step 5: Officials

Set up match officials:
- **1st Referee**: Main referee
- **2nd Referee**: Second referee (optional)
- **Scorer**: Match scorer
- **Assistant Scorer**: Assistant scorer (optional)

### Step 6: Coin Toss

1. Click **"Coin toss"** button
2. Select which team won the coin toss (Team A or Team B)
3. Select which team chose to serve or receive
4. Confirm the coin toss result

### Step 7: Signatures

Before starting the match, collect signatures:
- **Home Team Coach**
- **Home Team Captain**
- **Away Team Coach**
- **Away Team Captain**

Click each signature box to open the signature pad, sign, and save.

---

## Recording a Match

### Starting the Match

1. Complete all setup steps
2. Click **"Start Match"** button
3. The scoreboard will appear

### Scoreboard Interface

#### Main Controls

- **Point Buttons**: Click to award points to Home or Away team
- **Timeout**: Request timeout for a team
- **Substitution**: Make player substitutions
- **Sanctions**: Record warnings, penalties, expulsions, or disqualifications
- **Set End**: End the current set

#### Recording Points

1. Click the **point button** for the team that scored
2. The score updates automatically
3. The app tracks all events in real-time

#### Timeouts

1. Click **"Timeout"** button
2. Select which team requested the timeout
3. The timeout countdown starts automatically
4. Timeouts are limited per set (2 per team)

#### Substitutions

1. Click **"Substitution"** button
2. Select the team
3. Choose the player going out
4. Choose the player coming in
5. Confirm the substitution

#### Sanctions

1. Click **"Sanction"** button
2. Select the team
3. Choose the player or official
4. Select the sanction type:
   - **Warning** (Yellow card)
   - **Penalty** (Red card + point)
   - **Expulsion** (Red + Yellow card)
   - **Disqualification** (Red + Yellow card, player leaves)
5. Confirm the sanction

#### Ending a Set

1. When a team reaches 25 points (or 15 in set 5) with a 2-point lead, click **"Set End"**
2. Enter the final set time
3. Confirm the set end
4. The next set will begin automatically

#### Match End

When a team wins 3 sets:
1. The match automatically ends
2. You'll be taken to the **Match End** screen

---

## Match End & Approval

### Review Match Results

The Match End screen displays:
- **Final Score**: Sets won by each team
- **Results Table**: Detailed set-by-set breakdown
- **Sanctions Table**: All sanctions issued during the match
- **Remarks**: Additional notes

### Approval Process

Before finalizing the match, collect signatures from:

1. **Home Team Captain**
2. **Away Team Captain**
3. **Assistant Scorer** (if present)
4. **Scorer**
5. **2nd Referee** (if present)
6. **1st Referee**

Click each signature box to sign.

### Confirm and Approve

Once all required signatures are collected:

1. Click **"Confirm and Approve"** button
2. The system will:
   - Save the match to Supabase (if official match)
   - Generate and download the scoresheet PDF
   - Capture and save a screenshot (JPG)
   - Export match data as JSON
3. After approval, click **"Done"** to return to home

### Viewing Scoresheet

- Click **"Show Scoresheet"** to view the official scoresheet in a new window
- Use the **"Save"** button in the scoresheet window to save as PDF

---

## Additional Features

### Upload Roster

Teams can upload their roster via the upload roster page:

1. Navigate to `/upload_roster.html`
2. Enter the **Game Number**
3. Select **Team** (Home or Away)
4. Enter the **Upload PIN** (provided by the scorer)
5. Upload the roster PDF
6. The roster will appear as "pending" in the match setup

### Game PIN

Each official match has a unique **Game PIN**:
- Displayed in the Official Match modal
- Used for roster uploads
- Used for referee/scorer connections

### Referee View

Referees can connect to the match:
1. Navigate to `/referee.html`
2. Enter the **Referee PIN**
3. View match progress in real-time

### Live Score View

View live scores:
1. Navigate to `/livescore.html`
2. Enter the **Game PIN**
3. View real-time match updates

### Bench View

Bench officials can view match information:
1. Navigate to `/bench.html`
2. Enter the **Game PIN**
3. View match status and rosters

---

## Troubleshooting

### Connection Issues

**Problem**: Shows "Online (No Supabase)"
- **Solution**: Check that Supabase environment variables are set correctly
- For deployment: Ensure GitHub Secrets are configured

**Problem**: Shows "Sync Error"
- **Solution**: 
  - Check internet connection
  - Verify Supabase credentials
  - Check browser console for error details

### Match Not Saving

**Problem**: Match data not persisting
- **Solution**: 
  - Check browser storage permissions
  - Ensure IndexedDB is enabled
  - Clear browser cache and try again

### Roster Upload Not Working

**Problem**: PDF upload fails or doesn't parse correctly
- **Solution**:
  - Ensure PDF is in the correct format
  - Check that the PDF contains readable text (not just images)
  - Try a different PDF file

### Signature Not Saving

**Problem**: Signature disappears after signing
- **Solution**:
  - Ensure you click "Save" after signing
  - Check browser storage permissions
  - Try signing again

### Scoresheet Not Generating

**Problem**: PDF or screenshot not downloading
- **Solution**:
  - Check browser popup blocker settings
  - Ensure downloads are allowed
  - Check available disk space

### Version Display

The app displays its version number on the home screen. This is read from `package.json` and shows the current application version.

---

## Tips & Best Practices

1. **Always complete match setup** before starting the match
2. **Verify rosters** before starting to avoid errors during the match
3. **Save frequently** - the app auto-saves, but it's good practice to verify
4. **Test with test matches** before using in official matches
5. **Keep the app updated** for the latest features and bug fixes
6. **Use Game PINs** to allow teams to upload rosters remotely
7. **Review match end screen** carefully before approving
8. **Export and backup** match data regularly

---

## Support

For issues or questions:
- **Email**: luca.canepa@gmail.com
- **Check the console** for error messages
- **Review this guide** for common solutions

---

## Keyboard Shortcuts

- **Space**: Award point to home team (when scoreboard is active)
- **Enter**: Award point to away team (when scoreboard is active)
- **Escape**: Close modals

---

## Offline Mode

The app works **fully offline**:
- All data is stored locally in IndexedDB
- Matches can be recorded without internet
- Data syncs automatically when connection is restored
- No data loss if connection drops during a match

---

## Data Export

Match data can be exported in multiple formats:
- **PDF Scoresheet**: Official format for records
- **JPG Screenshot**: Visual record of the scoresheet
- **JSON Data**: Complete match data for backup or analysis

All exports are automatically downloaded when you approve a match.

---

*Last updated: Version 1.0.0*
