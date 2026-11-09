# Club licence lists: the club's people from VolleyManager

Status: built on `feat/club-licences` (db/024). Not deployed.

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
| Team managers of a team (db/023), the club's managers, admins | the club's **players** list, the team's gender | My teams → "Add from club" |
| Scorers of the club (indoor saved-teams read right; their `account_clubs`) | the **players** list of each of their clubs, the team names and each team's gender | the scoring tablet's copy, Match Setup |

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

In the squad editor and in a game's roster dialog: a picker (search, several at once) over the
club's players list. When the team's gender is known, only players of that gender (and those the
list gives no gender) are offered. Chosen players come with licence number, names and date of
birth, without a shirt number. The merge rules of the Einsatzliste import decide who is already
there (the same licence, else the same name, also with first and last name swapped): nobody is
added twice, a player found gets the licence and date of birth. In a game's roster a player found
is ticked.

## 3. The gender rule

A **team's gender** comes from its games in the schedule (`svrz_games`, home or away, by the
team's name): the one gender they have (`men` / `women`, `m` / `f`). Games without a gender say
nothing; a mixed gender or both genders make it unknown, and an unknown gender checks nothing.

- **Squad and game rosters (manager).** `PUT /api/team/:id/squad` and `PUT
  /api/team/:id/roster` refuse a player whose licence number is in the club's **players** list
  with the other gender than the team's: 400 `OV_WRONG_GENDER` with the player's `index`. The
  squad editor and the roster dialog check the same before saving, with the same message.
- **Match Setup (scorer).** Never a block (**D2**). The game's gender is the schedule's (the
  match's gender, from the official game); a test match has none. A roster player who is in the
  club's list with the other gender gets a warning in the roster panel ("Anna Beispiel is
  registered with the club as a woman, and this is a men's game"). Match Setup's roster rows have
  no licence numbers, so a player is matched by name and, when both have one, the date of birth.

## 4. API (lib/licences.js, db/024)

All JSON, `{ status, body }` like lib/teams.js. Ids in paths are uuids; the list is one of
`players`, `scorers`, `coaches` (one route each, never a uuid).

| Route | Who | |
|---|---|---|
| `PUT /api/club/:id/licences/:list` | the club's managers, admins | `{ people: [{ sv_number, last_name, first_name, dob, gender }] }`, at most 2000; replaces that list in one transaction (an empty list deletes it). `{ list, count, imported_at }` |
| `GET /api/club/:id/licences` | the club's managers, admins | `{ season, lists: { players, scorers, coaches: { count, imported_at, imported_by_name } }, people: [{ sv_number, last_name, first_name, dob, gender, lists, teams: [{ id, name }] }] }` |
| `GET /api/team/:id/club-players` | whoever may manage the team | `{ team, gender: 'm' \| 'f' \| null, players }` (the players list) |
| `GET /api/club-licences` | indoor `canReadTeams` (scorers) | `{ fetched_at, clubs: [{ club_id, club_name, team_names, team_genders, players }] }`: the caller's clubs |

Audit: `club.licences` with `{ club_id, list, count }`, never a name or a licence number.

## 5. The scoring tablet: offline first

1. **Download ahead.** Whenever the app is open, signed in with an indoor scorer role and online
   (sign-in, the connection coming back, every 15 minutes), it fetches `GET /api/club-licences`
   with the sent rosters (db/023) and keeps it in IndexedDB (`club_players`, Dexie v22, one row
   per club), for this account only; cleared on sign-out, account deletion and account switch,
   like the saved teams.
2. **Match Setup reads the device.** For a team whose name is one of the scorer's club teams, the
   roster editor offers **Add from club** (filtered by the game's gender, see 3) and the warning.
   Nothing waits on the network; without a copy (never online, another club's team) the button is
   not there and every other way to fill a roster stays.
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
- **L4** The scorers and coaches lists are shown in My club only; "Add from club" and the tablet
  copy use the players list.
- **L5** The audit entry keeps the club id with the list and the count (which club changed which
  list), never a person.
