# Team managers: a team prepares its own roster before the game

Status: built on `feat/team-managers` (db/023). Not deployed.

Owner, 2026-11-08, after SVRZ approved the eScoresheet:

- "do we have the possibility to also add team responsibles in the competition manager?"
- 1. a team manager link per team, like the club managers: **yes**
- 2. the club manager names them and **gives a link to their teams**; the team manager edits
  its own team in the manager: **yes**
- 3. the team sends its roster for a game ahead of time: **yes, see 2**
- "it is imperative that openvolley is offline first"
- Decisions, 2026-11-08: competition yes; **no lock** ("any manual adjustment can be done");
  **sign ahead if they want to**; the scorer's button says **Accept**; **deleted as soon as
  used**; admin: no own My teams, but **sees all** teams

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
  on the device (localStorage, 7 days) through sign-up and the email confirmation. Signed in, it
  asks "Manage <team> with <address>?" (the team named by `POST /api/account/invite-preview`,
  which checks the code as a redeem does and keeps nothing): Yes redeems it and opens My teams,
  "Use another account" signs out and keeps the link, "Forget this link" drops it. A link opened
  in a tab that is already signed in asks too. The kept link goes when a session ends on the
  device or another account signs in (AuthContext `clearLocalAccountData`). A club manager link
  (`#club=`, db/029) asks the same and works only for the address it was mailed to (db/036
  `invite_codes.invited_email`; another account: 403 `OV_INVITE_OTHER_ACCOUNT`).
- The same code can also be typed into the existing "Invite code" field.
- Redeeming adds the `team_managers` row and, through db/030, the `team_manager` role; no club
  membership (db/036: a team manager's reads go through its team, `mayManage`). A code of a
  removed team is invalid (`ON DELETE CASCADE`).
- The club manager sees each team's managers and removes one. Removing one revokes the team
  links that account redeemed (audited `invite.revoke`, reason `team_manager_removed`), and the
  same link refuses it afterwards (409 `OV_INVITE_REMOVED`); a new link from the club manager
  works. A link, like every code, stands only while its creator may still make it (an admin, or a
  manager of the link's club).

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
  whether a roster was sent, when and by whom. **Prepare roster** opens the game's roster, a page
  of its own with the game in the address (`#myteams/<team id>/<game number>`; Back returns to
  the list; owner 2026-11-10): tick up to 14 players of the saved team, shirt numbers, captain, up
  to 2 liberos, the officials; or Import Einsatzliste for this game. Save sends it.
- **The game page's head**: when, where (hall, address and postal code with a map link), league,
  referees and the game number (owner 2026-11-10: "at the top where, when, referees etc"). The
  referees are names only, as in the public match assignments; `GET /api/team/:id/games` gives
  `hall_address`, `hall_postal_code` and `referees` (no dates of birth: none is kept since
  db/048). Each player and official is one line: name and licence number.
- **Every page has its address** (owner 2026-11-10: "make sure every page there gets their own
  page"): the team at `#myteams/<team id>`, a game at `#myteams/<team id>/<game number>`; in My
  club the club at `#myclub/<club id>`, a person of its licence lists at
  `#myclub/<club id>/person/<licence>`, and a team opens in My teams.
- **Officials of a game**: each has a role menu (coach, assistant coaches 1 and 2,
  physiotherapist, medic). Each role once: a ticked official who takes a role, or is ticked in
  it, unticks the one who had it. **Add official** adds someone typed in (role, names, licence
  optional; the physiotherapist offered first, then the medic), not necessarily
  of the club's lists (owner 2026-11-10: "have people be put as P/M manually").
- Locked at kick-off (**D2**, owner 2026-11-15, replacing "no lock"): a game's roster can be sent,
  changed and deleted until its kick-off; after it the team only reads it (409 `OV_GAME_STARTED`),
  and the console lists the game under **Earlier games**, read-only. The scorer still accepts a
  sent roster after kick-off, and adjusts anything in the hall by hand as today.
- Signatures (**D3**, owner): optional. The coach and the captain may sign ahead on that page
  (the same signature pad as the app). A signature belongs to the roster it was made on: a change
  after signing drops it and asks to sign again. Without them, they sign at the coin toss.

### Filled from official matches (db/048, owner 2026-11-19)

"As club/team management can be used saltuarly": the saved team fills itself from the official
matches, also for a team nobody manages (`backend/lib/rosterSaveBack.js`; no client job, older
apps feed it too).

- **When.** After every successful write of a `matches` row (`/api/db`, `/api/match/restore`),
  once the match has been quiet for 60 s (at most 10 min), and at start for the matches written in
  the last 6 h. Only an official match that is **closed** (owner decision 2026-11-23 no. 2, audit
  2611 PERM-04: approved / final with `closed_at`; the coin toss is not enough): not a test,
  `game_n > 0`, indoor, not exempt (released or a second match of the game), of the current
  season, its game in `svrz_games`.
- **Whose team.** The writer is the account that closed the match (`closed_by`), else its
  creator. The side whose team is of a club the writer is a member of is merged at once, as
  below, with the writer as the actor (audit, `imported_by` of the club's new rows). **The other
  side** (another club's team, or a team of no club) gets a **suggestion** only
  (`roster_suggestions`, db/058; no personal data, the roster stays the match's): nothing is
  written to its saved team or its club's lists. Whoever may manage that team (its team managers,
  its club's managers, admins) sees it on the team's page with what it would change (`GET
  /api/team/:id/roster-suggestions`) and confirms it (merged then, the same way, the manager the
  actor) or rejects it (`POST /api/team/:id/roster-suggestions/:sid { decision }`; audited
  `team.squad.suggestion`). A suggestion of a match an admin reopened waits until it is closed
  again; a deleted match takes its suggestions with it.
- **Which team.** Each side of the row by its team name against the schedule's home and away
  names (the same, accents and case aside, or one holding the other; straight or swapped: Match
  Setup's swap, a game played the other way round). A side no name points to is left alone.
- **The saved team** of the season (`lib/teams.js` `ensureSquad`: found as the squad is, else made
  as a team manager's first save makes it, under the same lock; without a club name for a team that
  is no club's). The match's people: the same person by licence, else by name (accents, case,
  first and last name swapped). **The match's shirt number wins**; a player of the saved team who
  had it loses it. Only the team's **latest** official match sets numbers: an older one (another
  closed official match of the team kicks off later and its roster reached the team: its writer
  is of the team's club, or the team confirmed its suggestion; a deleted match is gone) adds
  people and fills an empty number nobody holds. A missing licence is filled in; another licence than the saved team's stays
  the saved team's (counted). New people come without captain or libero; **nobody is removed**;
  the captain and libero flags stay; a player set inactive who played is active again. Officials
  are added or completed, never removed. **Their role follows the latest match** (owner
  2026-11-20): on the team's latest official match an official of the saved team takes the role the
  sheet names (Coach, Assistant Coach 1 / 2, Physiotherapist, Medic); an older match changes no
  role (its new officials come with the match's role). An official of the saved team who is not on
  that match and held a role it gave to someone else takes the role left over by the moves: the
  role the one who took theirs had before, when nobody holds it now, else where that one's own
  role went, and so on (the coach misses a game and the assistant coaches: the two swap; the next
  match swaps them back). Nothing left over (a new official took the role, or the role left over is
  held already): they keep their role. The saved team allows a role twice (`validateRoster`); only
  the match sheet and a game roster name each role once, and nobody gets a role no sheet gave
  anyone. Audit counts `roles` (set by the match) and `moved` (moved to the role left over). A
  person that would
  break the saved team's rules is left out, never the whole save: a player of the other gender in
  the club's players list, more than 40 players or 10 officials, twice in the roster, a name too
  long.
- **The club's lists** (team in `club_teams`): its people with a licence (4 to 7 digits) as
  `match` rows (docs/club-licences-spec.md section 8): players to `players`, Coach and Assistant
  Coaches to `coaches`.
- **Audit** `team.squad.match` (the writer's own side; the writer the actor) and
  `team.squad.suggestion` (made, confirmed, rejected): game number, season, side, ids, counts; no
  name, no licence. Nothing changed: no write, no entry, no suggestion.
- **Numbers on the next import.** An Einsatzliste has no shirt numbers. Match Setup fills them from
  the side's saved team on the device (by licence, else name; never a number the roster has),
  for 14 players or fewer and for the player pool of more; "Add from club" too, and its picker
  shows the number. The manager's game roster (Import Einsatzliste, Add from club) and squad
  editor fill a player new to the list from the stored squad, its inactive players too. Match
  Setup asks for a fresh copy of the saved teams when it opens online (at most every 10 minutes);
  nothing waits for it.

## 4. The scorer: offline first

The scorer's tablet never waits on the network for a roster.

1. **Download ahead.** Whenever the app is open, signed in with an indoor scorer role and online
   (start, sign-in, the connection coming back, every 15 minutes, opening Official game), it
   fetches `GET /api/game-rosters`: the rosters sent for the home games of its clubs from today to
   7 days ahead (home and away team). They are kept in IndexedDB (`game_rosters`, Dexie v21),
   for this account only, and cleared on sign-out and account switch like the saved teams.
2. **Match Setup reads the device.** For an official game, Match Setup looks up the game number in
   that table. A roster found for a team shows a card above that team's roster: "Roster sent by
   the team", who and when, players and officials, whether they signed ahead, Show, **Accept**,
   Not now. Accept fills the roster, the bench and the signatures made ahead, as an accepted
   remote roster does. Nothing is filled without the tap (**D4**).
5. **Accepted = used (D5, owner).** Accept marks the device copy at once and tells the server
   (`POST /api/game-rosters/used` with the version accepted), now or as soon as the tablet is
   online again; the server deletes the roster's names, licence numbers and
   signatures at once and keeps a row without them, so the team sees "Accepted by the scorer".
   A newer version the team sent meanwhile is left alone and offered again. Rows nobody accepts
   go 14 days after the game.
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
| `PUT /api/team/:teamId/roster?game=<n>` | `{ players, staff, coach_signature?, captain_signature? }`: at most 14 players with distinct numbers, one captain, at most 2 liberos, at most 5 officials, each role once; signatures are PNG data URLs (≤ 200,000 characters), the coach's needs a Coach, the captain's a captain. Any time; a new version clears "accepted" |
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
| `GET /api/game-rosters?games=1,2` | rosters of these games (at most 50); accepted ones are left out |
| `POST /api/game-rosters/used` | `{ game_number, side, season?, updated_at }`: accepted in Match Setup; the content is deleted. `{ used }` or `{ used: false, reason: 'changed' \| 'gone' }` |

`/api/me` gains `managedTeams: [{ id, name, club_id, club_name, via: 'team' \| 'club' \| 'admin' }]`
(admins: every team of every club).

## 6. Data and privacy

- `game_rosters(game_number, season, side, team_name, players, staff, coach_signature,
  captain_signature, used_at, used_by, updated_by, updated_at)`: names, licence numbers and the
  optional signatures of one game's roster. No date of birth since db/048: a `dob` sent is dropped,
  db/048 removed the key from stored rows, and the roster hash (`lib/teams.js` `rosterHash`)
  changed with it, so a signature given ahead before db/048 is dropped once, at the roster's next
  send. Not on the `/api/db` allowlist,
  never in a public projection, never anonymous, never in the activity log or the audit details
  (the audit keeps the game number, side and counts).
- **Deleted as soon as a scorer accepts it** (**D5**): the content goes at once, the row without
  personal data stays for the team's "Accepted". Every row goes 14 days after the game (the sweep
  runs with every write and every scorer read). The match record holds the roster from Match
  Setup on.
- Audit: `team.managers` (redeem, remove), `team.roster` (put, delete), `team.squad`,
  `team.squad.match` (an official match's roster, counts only).
- The privacy policy already names team managers who enter rosters (roster page). It needs one
  more line for the manager and the 14 days before this is switched on for clubs (owner review,
  privacy 1.8).

## 7. Decisions (owner, 2026-11-08)

- **D1** The first saved team of a team goes into the season's competition of its league, created
  when there is none. Yes.
- **D2** No lock: a game's roster can be changed at any time. Replaced 2026-11-15: locked at kick-off
  ("how can I prepare a roster for a game already started").
- **D3** The coach and the captain may sign ahead if they want to.
- **D4** The scorer taps **Accept**; a sent roster never fills Match Setup by itself.
- **D5** A sent roster is deleted as soon as it is accepted (14 days after the game at the latest).
- **D6** Admins see every team in My teams.
