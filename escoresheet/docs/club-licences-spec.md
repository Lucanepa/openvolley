# Club licence lists: the club's people from VolleyManager

Status: first build in main (PR #94, db/024, release 3.0.15). The 2026-11-09 feedback (no gender
note in the picker; team officials from anyone of the club) on `feat/licence-export-reminder`.

Owner, 2026-11-09:

- In My club, club managers see their club's people ("trainers, players etc.") with their
  team(s); "each club manager can feed them by using this (from club administration in
  volleymanager)": the XLSX exports of VolleyManager's club administration.
- "just import dob, licence n, name, last name — that's all we need" and "gender (so we can
  divide the players in genders and a player can't play in the wrong gender)".
- "then in roster you can also add player(s) from the club" (My teams) and "same on the
  escoresheet itself" (Match Setup).
- OpenVolley is offline first: Match Setup never waits on the network.
- Decision **D2** (team managers, 2026-11-08) stands: the scorer can adjust anything in the hall,
  so in Match Setup the gender rule is a warning, not a block.

Owner, 2026-11-09 (feedback on the first build):

- The picker's note "Women only: players registered as men are not offered." (and its men's twin)
  "can go away". The filter itself stays.
- "coaches can literally be any player/member of the club from the list": a team official
  (coach, assistant coaches, physiotherapist, medic) is chosen from anyone of the club's three
  lists, of either gender, and the gender rule never applies to officials.

## 1. What is kept: five fields

Per person of a list: **licence number** (the Swiss Volley "SV" number, 4 to 7 digits), **last
name**, **first name**, **date of birth**, **gender** (`m` / `f`). Nothing else.

The exports also carry email addresses, phone numbers, home addresses, nationality, categories,
clubs and dates. None of it is read into the app, sent or stored:

- The file is read **in the browser** (`frontend/src/utils/vmLicenceExport.js`, jszip and the
  browser's XML parser). The function answers the five fields per person and three counts (rows
  read, rows left out, the language of the headers); the file itself never leaves the device.
- The request carries the five fields only (`clubApi.putLicences` picks them again).
- The server refuses any other field in the body (400, `people[i].<field>: not accepted`).

### The export format

Sheet 1 (`Sheet1`): a title row, a blank row, the header row (row 3), then one row per person.
The scorers and coaches exports have the same first five columns. Header names, compared after
lowercasing, trimming, collapsing spaces and dropping dots and colons; the language is the one
whose names match best (Italian `Nome` is the first name, French `Nom` and German `Name` the last
name):

| | Licence | Last name | First name | Date of birth | Gender |
|---|---|---|---|---|---|
| it | `N. SV` | `Cognome` | `Nome` | `Data di nascita` | `Sesso` (`D` f, `U` m) |
| de | `SV-Nr.`, `SV Nr.`, `SV-Nummer` | `Name`, `Nachname` | `Vorname` | `Geburtsdatum` | `Geschlecht` (`W`/`F` f, `M` m) |
| fr | `N° SV`, `No SV`, `N. SV` | `Nom` | `Prénom` | `Date de naissance` | `Sexe` (`F` f, `H`/`M` m) |
| en | `SV no.`, `SV No`, `SV number` | `Last name`, `Surname` | `First name` | `Date of birth` | `Gender`, `Sex` (`F`/`W` f, `M` m) |

- No licence header: the column whose non-empty values are all 4 to 7 digit numbers.
- A file without a licence, last name or first name column is refused with a message naming what
  is missing.
- Dates: an Excel date cell (a serial number; the 1900 system with Excel's 29 February 1900, or
  the 1904 system), an ISO date (`t="d"` or text) or `DD.MM.YYYY` text. Anything else: no date.
- A row without a 4 to 7 digit licence number or a last name is left out and counted ("2 rows
  left out"). A licence number twice in one file is one person.

## 2. Who sees what

| Who | What | Where |
|---|---|---|
| Club managers of the club (db/020), admins | uploads each list; every person once, with its lists and teams | My club → Licences |
| Team managers of a team (db/023), the club's managers, admins | the club's three lists (the **players** list for the players, everyone for the officials), the team's gender | My teams → "Add from club" |
| Scorers of the club (indoor saved-teams read right; their `account_clubs`) | the three lists of each of their clubs (the **players** list and everyone once), the team names and each team's gender | the scoring tablet's copy, Match Setup |

Never public, never anonymous, never on the `/api/db` allowlist. Another club's manager, a team
manager outside its own teams and a scorer of another club see nothing of it.

### My club → Licences

- Upload: the list (Players, Scorers, Coaches) and the `.xlsx` file. A preview says how many
  people were read, that only licence number, name, date of birth and gender are kept, how many
  rows were left out and whom the upload replaces; **Save list** sends it. At most 2000 people per
  list.
- Per list: how many people, when it was updated and by whom; **Delete list** (an empty upload).
- Everyone of the three lists once: name, licence, date of birth, gender, list chips and team
  chips. A person's teams are the club's teams whose saved team of this season (the squad of My
  teams) has a player or an official with that licence number. Search by name or licence, filter
  by list and gender. Works at 390 px.

### My teams → "Add from club"

**Players.** In the squad editor and in a game's roster dialog: a picker (search, several at once)
over the club's players list. When the team's gender is known, only players of that gender (and
those the list gives no gender) are offered; the picker says nothing about it (no note). Chosen
players come with licence number, names and date of birth, without a shirt number. The merge rules
of the Einsatzliste import decide who is already there (the same licence, else the same name, also
with first and last name swapped): nobody is added twice, a player found gets the licence and date
of birth. In a game's roster a player found is ticked.

**Team officials.** "Add from club" in the officials part of the squad editor and of a game's
roster dialog: a picker over **everyone of the club's three lists** (players, scorers, coaches;
each person once, its lists shown), with **no gender filter**. The picker asks for the role
(coach, assistant coach 1 and 2, physiotherapist, medic; it starts at the first role nobody holds)
and one person:

- Squad editor: the first official row of that role takes the person (names, date of birth,
  licence number); without such a row, a row of that role is added.
- Game roster: the person is ticked in that role (added when the squad does not have them in it),
  and whoever was ticked in that role before is unticked: each role once.
- Someone already in the chosen role is shown as already there and cannot be chosen again; the
  picker names who holds the role now (the choice takes their place).

## 3. The gender rule

A **team's gender** comes from its games in the schedule (`svrz_games`, home or away, by the
team's name): the one gender they have (`men` / `women`, `m` / `f`). Games without a gender say
nothing; a mixed gender or both genders make it unknown, and an unknown gender checks nothing.

- **Players only.** The rule checks the players of a squad or roster, never its officials: a
  coach, assistant coach, physiotherapist or medic may be anyone of the club, of either gender
  (owner 2026-11-09).
- **Squad and game rosters (manager).** `PUT /api/team/:id/squad` and `PUT
  /api/team/:id/roster` refuse a player whose licence number is in the club's **players** list
  with the other gender than the team's: 400 `OV_WRONG_GENDER` with the player's `index`. The
  squad editor and the roster dialog check the same before saving, with the same message.
- **Match Setup (scorer).** Never a block (**D2**). The game's gender is the schedule's (the
  match's gender, from the official game); a test match has none. A roster player who is in the
  club's list with the other gender gets a warning in the roster panel ("Anna Beispiel is
  registered with the club as a woman, and this is a men's game"). Match Setup's roster rows have
  no licence numbers, so a player is matched by name and, when both have one, the date of birth.
  The bench officials get no warning.

## 4. API (lib/licences.js, db/024)

All JSON, `{ status, body }` like lib/teams.js. Ids in paths are uuids; the list is one of
`players`, `scorers`, `coaches` (one route each, never a uuid).

| Route | Who | |
|---|---|---|
| `PUT /api/club/:id/licences/:list` | the club's managers, admins | `{ people: [{ sv_number, last_name, first_name, dob, gender }] }`, at most 2000; replaces that list in one transaction (an empty list deletes it). `{ list, count, imported_at }` |
| `GET /api/club/:id/licences` | the club's managers, admins | `{ season, lists: { players, scorers, coaches: { count, imported_at, imported_by_name } }, people: [{ sv_number, last_name, first_name, dob, gender, lists, teams: [{ id, name }] }] }` |
| `GET /api/team/:id/club-players` | whoever may manage the team | `{ team, gender: 'm' \| 'f' \| null, players, people }`: `players` the players list (five fields), `people` everyone of the three lists once `{ sv_number, last_name, first_name, dob, gender, lists }` |
| `GET /api/club-licences` | indoor `canReadTeams` (scorers) | `{ fetched_at, clubs: [{ club_id, club_name, team_names, team_genders, players, people }] }`: the caller's clubs, `players` and `people` as above |

`players` keeps the shape of the first build: the apps of release 3.0.15 read only `players` (the
roster rows), and keep working; `people` is new. An app reading a server without `people` offers
the players list for the officials too.

Audit: `club.licences` with `{ club_id, list, count }`, never a name or a licence number.

## 5. The scoring tablet: offline first

1. **Download ahead.** Whenever the app is open, signed in with an indoor scorer role and online
   (sign-in, the connection coming back, every 15 minutes), it fetches `GET /api/club-licences`
   with the sent rosters (db/023) and keeps it in IndexedDB (`club_players`, Dexie v22, one row
   per club: its players list and **everyone of its three lists** with their lists; `people` is a
   field of the row, no new index and no new Dexie version), for this account only; cleared on
   sign-out, account deletion and account switch, like the saved teams.
2. **Match Setup reads the device.** For a team whose name is one of the scorer's club teams, the
   roster editor offers **Add from club** for the players (the players list, filtered by the
   game's gender, see 3) with the warning, and **Add from club** for the bench officials (anyone
   of the three lists, either gender: the role's row takes the names and the date of birth, else
   a row of that role is added; each role once). Nothing waits on the network; without a copy
   (never online, another club's team) the buttons are not there and every other way to fill a
   roster stays.
3. A list the club changes after the download reaches the tablet the next time it is online.

## 6. Data and retention

- `club_licences(club_id, list, sv_number, last_name, first_name, dob, gender, imported_at,
  imported_by)`, primary key `(club_id, list, sv_number)`.
- **Each upload replaces that list.** A person who left the club is gone with the next upload.
- **Deleted with the club** (`ON DELETE CASCADE`) or with the list (Delete list). `imported_by`
  is set NULL when that account is deleted.
- Tablet copies: replaced by each download, cleared on sign-out and account switch.
- Backups as every table (privacy policy section 18).

## 7. Decisions

- **L1** (owner) Five fields only, read in the browser; nothing else of the export is sent.
- **L2** (owner) The gender rule: refused in the manager, a warning in Match Setup (**D2**).
- **L3** Team gender from the schedule; unknown (no games, mixed, both) checks nothing. A player
  the list gives no gender is offered to every team and never refused.
- **L4** (owner 2026-11-09, replaces "the scorers and coaches lists in My club only") Player rows
  are added from the players list (of the team's gender); a team official from anyone of the three
  lists, of either gender, with no gender rule. Team managers and the club's scorers (tablet copy)
  therefore get all three lists of their club.
- **L6** (owner 2026-11-09) The picker shows no note about the gender filter.
- **L5** The audit entry keeps the club id with the list and the count (which club changed which
  list), never a person.
