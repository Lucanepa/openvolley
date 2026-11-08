# Team managers: a team prepares its own roster before the game

Status: built on `feat/team-managers` (db/023). Not deployed.

Owner, 2026-11-08, after SVRZ approved the eScoresheet:

- "do we have the possibility to also add team responsibles in the competition manager?"
- 1. a team manager link per team, like the club managers: **yes**
- 2. the club manager names them and **gives a link to their teams**; the team manager edits
  its own team in the manager: **yes**
- 3. the team sends its roster for a game ahead of time: **yes, see 2**
- "it is imperative that openvolley is offline first"

## 1. Roles

| Who | What | Named by |
|---|---|---|
| Team manager (`team_managers`, db/023) | one or more VolleyManager teams of a club (`club_teams`): the team's players and officials for the season, the roster of each of its games | the club's managers (a link), admins |
| Club manager (db/020) | everything a team manager may do, for every team of its clubs, plus the team links | admins |

Like a club manager, a team manager is **no global role**: `profiles.roles` does not change. The
account is "pending" in the scorer app unless it has another role, and it scores nothing.

## 2. The team link

- The club manager's My club tab lists the club's teams. "Create link" makes an invite code
  (`invite_codes.role = 'team_manager'`, `team_id` = the team, `club_id` = its club; at most
  10 uses, at most 90 days, default 3 uses and 30 days). The link is
  `https://manager.openvolley.app/#team=<CODE>`. It is shown once, like every invite code
  (only the hash is stored), with Copy and Share.
- The code rides in the URL **fragment**, so it never reaches a server log. The manager keeps it
  on the device (localStorage, 7 days) through sign-up and the email confirmation, then redeems
  it by itself and opens My teams.
- The same code can also be typed into the existing "Invite code" field.
- Redeeming adds the `team_managers` row only (no role, no club membership: the account does not
  score for the club). A code of a removed team is invalid (`ON DELETE CASCADE`).
- The club manager sees each team's managers and removes one (the link only).

## 3. My teams (manager)

Shown when `/api/me` `managedTeams` is not empty (team managers, club managers).

- **Players**: the team's saved team of the current season (`competition_teams` with
  `svrz_team_name` = the team), edited with the competition manager's team editor (players,
  officials, licence numbers; name, club and VolleyManager name are fixed). **Import Einsatzliste**
  (PDF, the same reader as Match Setup) fills it. When the team has no saved team yet, the first
  save creates it in the season's competition whose `vm_leagues` holds the team's league, else in
  a new competition named after the league (**D1**). Scorers then load it in Match Setup as
  every saved team today.
- **Games**: the team's games in the schedule (`svrz_games`, home and away, from today). Each shows
  whether a roster was sent, when and by whom. **Prepare roster** opens the game's roster: tick up
  to 14 players of the saved team, shirt numbers, captain, up to 2 liberos, the officials; or
  Import Einsatzliste for this game. Save sends it.
- A game's roster can be changed until kick-off. After kick-off it is read-only (**D2**).
- No signatures here (**D3**): the coach and the captain sign in the hall, at the coin toss, as
  today. A team manager is often neither.

## 4. The scorer: offline first

The scorer's tablet never waits on the network for a roster.

1. **Download ahead.** Whenever the app is open, signed in with an indoor scorer role and online
   (start, sign-in, the connection coming back, every 15 minutes, opening Official game), it
   fetches `GET /api/game-rosters`: the rosters sent for the home games of its clubs from today to
   7 days ahead (home and away team). They are kept in IndexedDB (`game_rosters`, Dexie v21),
   for this account only, and cleared on sign-out and account switch like the saved teams.
2. **Match Setup reads the device.** For an official game, Match Setup looks up the game number in
   that table. A roster found for a team shows a card above that team's roster: "Roster sent by
   the team", who and when, players and officials, Preview, **Use it**, Not now. Use it fills the
   roster and bench as an accepted remote roster does. Nothing is filled without the tap (**D4**).
3. **Online at setup, too.** When Match Setup has a connection, it also asks for this game
   (`?games=<n>`), so a roster sent minutes ago or for another club's game shows. Offline, the
   device's copy is used and nothing waits.
4. **Nothing found**: every way that works today stays: Einsatzliste PDF in Match Setup (offline),
   saved team (offline cache), the roster page through the cloud or the laptop's own Wi-Fi.

A roster the team changes after the tablet downloaded it reaches the tablet the next time it is
online. The card says when the roster was sent, so the scorer and the coach can compare.

## 5. API (lib/teams.js, db/023)

All JSON, `{ status, body }` like lib/clubs.js. Ids in paths are uuids; the game number is a
query parameter.

Team managers of the team, club managers of its club, admins:

| Route | |
|---|---|
| `GET /api/team/:teamId` | the team and its club |
| `GET /api/team/:teamId/squad` | the saved team of the current season, or null |
| `PUT /api/team/:teamId/squad` | `{ players, staff }` (saved-team rules); creates the saved team if needed |
| `GET /api/team/:teamId/games` | the team's games from today, each with its side and roster summary |
| `GET /api/team/:teamId/roster?game=<n>` | the team's roster of that game, or null |
| `PUT /api/team/:teamId/roster?game=<n>` | `{ players, staff }`: at most 14 players with distinct numbers, one captain, at most 2 liberos, at most 5 officials, each role once; 409 `OV_ROSTER_LOCKED` after kick-off |
| `DELETE /api/team/:teamId/roster?game=<n>` | |

Club managers of the club, admins:

| Route | |
|---|---|
| `GET /api/club/:id/teams` | the club's teams with ids and their managers |
| `POST /api/club/:id/teams/:teamId/invites` | `{ max_uses?, expires_at? }` → `{ invite, code }` |
| `DELETE /api/club/:id/teams/:teamId/managers/:userId` | the link only |

Scorers (indoor `canReadTeams`, the read right of the saved teams, which already hold the same
people):

| Route | |
|---|---|
| `GET /api/game-rosters` | rosters of the home games of the caller's clubs, today to +7 days |
| `GET /api/game-rosters?games=1,2` | rosters of these games (at most 50) |

`/api/me` gains `managedTeams: [{ id, name, club_id, club_name, via: 'team' \| 'club' }]`.

## 6. Data and privacy

- `game_rosters(game_number, season, side, team_name, players, staff, updated_by, updated_at)`:
  names, dates of birth, licence numbers of one game's roster. Not on the `/api/db` allowlist,
  never in a public projection, never anonymous, never in the activity log or the audit details
  (the audit keeps the game number, side and counts).
- **Deleted 14 days after the game** (**D5**): the match record holds the roster from Match Setup
  on. The sweep runs with every write and every scorer read.
- Audit: `team.managers` (redeem, remove), `team.roster` (put, delete), `team.squad`.
- The privacy policy already names team managers who enter rosters (roster page). It needs one
  more line for the manager and the 14 days before this is switched on for clubs (owner review,
  privacy 1.8).

## 7. Decisions to confirm

- **D1** The first saved team of a team goes into the season's competition of its league, created
  when there is none.
- **D2** A game's roster is editable until kick-off.
- **D3** No signatures when the roster is sent ahead; signing stays in the hall.
- **D4** The scorer taps Use it; a sent roster never fills Match Setup by itself.
- **D5** Sent rosters are deleted 14 days after the game.
- **D6** The admin's console has no My teams of its own; an admin who is also a club manager sees it.
