# User Guide

How to score a volleyball match with OpenVolley, step by step (version 3.2.5).

Every screen has a **?** in its header: it shows the help for that screen, with a short video and "Show me". The same help, in German, English, French and Italian, is on [openvolley.app/support](https://openvolley.app/support).

## The apps

| App | For | Where |
|---|---|---|
| eScoresheet (scorer) | The scorer's table: match setup, coin toss, every rally, signatures | [app.openvolley.app](https://app.openvolley.app), or the desktop and Android apps |
| Referee tablet | 1st and 2nd referee: score, line-ups with the rotation, time-outs, substitutions, sanctions | [referee.openvolley.app](https://referee.openvolley.app) |
| Bench tablet | A team's bench: its match live, and requests to the scorer (line-up, time-out, substitution) | [bench.openvolley.app](https://bench.openvolley.app) |
| Livescore | Fans and big screens. No PIN needed | [livescore.openvolley.app](https://livescore.openvolley.app) |
| Roster upload | Coaches: send the roster PDF to the scorer before the match | [roster.openvolley.app](https://roster.openvolley.app) |
| Manager | Clubs, team managers and admins: club, teams, team links, game rosters sent ahead, licence lists | [manager.openvolley.app](https://manager.openvolley.app) |

The desktop app (Windows, macOS, Linux) and the Android app are on [get.openvolley.app](https://get.openvolley.app). The desktop app scores without internet and serves the tablets in the hall over its own network.

## Swiss or Global

At the first open the app asks **How do you use OpenVolley?**

- **Swiss**: Swiss league games, with sign-in, the game list, the Einsatzliste, club rosters and the cloud.
- **Global**: any tournament or friendly. No sign-in and no game list; games and rosters come from Excel or CSV, teams and players stay on the device. The match's backup is kept online under a backup code.

You can change this later in **Options › Tool**, as long as no match is on the device.

## Scoring a match

### 1. Start on Home

- **Official match** (signed in): pick today's home game of your club, or enter the game yourself. It is saved on the server for the referee, the livescore and the backups.
- **Test match**: invented teams, for practice. Never saved on the server; referee and bench tablets can still follow it ("Switch to test matches").
- **Easy match**: unofficial, no rosters and no signatures.
- **Scoreboard**: points and sets only, no match.
- In the Global tool: **Match** starts a full match without signing in.

Home always opens first. **Continue match** goes back to the match on this device; the card shows its score and its state ("Scoring here", "Unsent changes", "Not checked"…).

### 2. Match setup

- **Match info**: "Load match from schedule" (gender, league, game) fills in the game number, teams, date, hall and referees. Add the short names and the team colours. Each team can have a contact e-mail for the final scoresheet.
- **Officials**: 1st referee and scorer are needed; 2nd referee, assistant scorer and line judges are optional.
- **Rosters**: "Edit roster" for each team. Add players by hand, import the roster PDF or the Einsatzliste ("Upload PDF"), or let the coach upload it on roster.openvolley.app. A team manager can also send it ahead from manager.openvolley.app: the team's card shows "Roster sent by …" with **Accept**. Mark the captain and up to two liberos, and add the bench officials.
- **Backups**: where this match is saved (cloud, this device, a USB stick with the desktop app).
- **PINs**: keep the game PIN (also on Home). You need it to delete, restore or continue the match on another device.

### 3. Coin toss

Record who won the toss, the sides and the first serve, then **Confirm coin toss result**. The captain and the coach of each team sign on the screen or on their phone ("Sign on phone"). They can also sign later during the warm-up: the scoring screen shows "Missing signature", and set 1 starts only once all four have signed.

### 4. Line-ups

Tap **Lineup** on each team's side and enter positions I to VI. The first line-up stays covered ("Line-up set") until the other team's is in. A coach can send the line-up from the bench tablet: the scorer checks it with **Review and accept**.

### 5. Rallies

Tap **Start rally** before each serve, then the point button of the team that won the rally. The **SERVE** box shows the server's number; the app rotates a team when it wins the service back. **Undo** takes back the last point; **Decision change** gives the rally to the other team or replays it.

### 6. During play

- **Time-outs**: tap the team's TO box, then **Confirm time-out** (30 seconds).
- **Substitutions**: tap the player on court, then **Substitution** and the player who comes in. Or tap the team's **Substitution** box under the score: tap who comes in, then who goes out; add more pairs the same way, then **Confirm** (only the players who may be substituted are shown).
- **Liberos**: tap a back-row player, then **Libero**.
- **Sanctions**: tap the player (or the team's Improper request / Delay warning), then the sanction.
- **Bench requests**: a card shows when a bench tablet asks for a time-out or a substitution; grant it or decline it.
- **Mistakes**: Match › **Go back** when the referees take back part of the set; Match › **Corrections** for anything else; Match › **Edit match info** for the hall, date or officials.

The app checks the rules as you go (third time-out, seventh substitution, a player who may not come in) and asks before recording anything unusual.

### 7. Set end and deciding set

At 25 points with a two-point lead the app ends the set and starts the interval. Before the deciding set it asks for a new coin toss; at 8 points the teams change courts.

### 8. Match end

Check the results, collect the signatures (captains, then officials; "Sign on phone" or "Approve with PIN" work too), then **Confirm and approve**. The app downloads a ZIP with the match data and the scoresheet PDF and closes the match on the server. Where the league sends final scoresheets, the PDF is mailed to the scorer, the referees and the team contacts.

## Tablets in the hall

The header menu (☰) › **Connect tablets** (also in Options): choose the way (internet, hall Wi-Fi with the desktop app, or the desktop app's own network), turn each tablet on, and let it scan its code. The referee and bench tablets need their PIN; the livescore needs none. The header chip (for example 2/3) shows how many tablets are connected.

## Offline, backups and another device

- Scoring never needs the internet: every change is saved on the device first and sent when the connection is back. The header pill shows the state ("Connected", "Offline (3 waiting)", "Local only"…).
- Backups: the desktop and Android apps save a file at every action; in Chrome or Edge you can pick a backup folder; signed in, a cloud backup is kept during the match. Backup files of an official match are encrypted with its game PIN and referee PIN.
- Another device: on the new device, Home › **Restore match**, enter the game number and the game PIN, and continue there. The old device stops and can take scoring back.

## Language

The language is in the header menu: English, German, Swiss German, French and Italian.
