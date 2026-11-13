# Club licence lists: the club's people from VolleyManager

Status: first build in main (PR #94, db/024, release 3.0.15). The 2026-11-09 feedback (no gender
note in the picker; team officials from anyone of the club) on `feat/licence-export-reminder`.
People added by hand (section 8, db/026, privacy 1.12) on `fix/manager-list-cards`.

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
| Team managers of a team (db/023), the club's managers, admins | the club's players of the team's gender and age class, the people of the team's saved team, a name search over the three lists for the officials (a few rows), the team's gender; dates of birth only of the people in the team's saved team (section 9) | My teams → "Add from club" |
| Scorers of the club (indoor saved-teams read right; their `account_clubs`) | the three lists of each of their clubs (the **players** list and everyone once) **without dates of birth**, the team names and each team's gender; the date of birth of each person they add to a roster, on demand (section 9) | the scoring tablet's copy, Match Setup |

Never public, never anonymous, never on the `/api/db` allowlist. Another club's manager, a team
manager outside its own teams and a scorer of another club see nothing of it.

### My club → Licences

- Upload: the list (Players, Scorers, Coaches) and the `.xlsx` file. A preview says how many
  people were read, that only licence number, name, date of birth and gender are kept, how many
  rows were left out and whom the upload replaces; **Save list** sends it. At most 2000 people per
  list.
- Per list: how many people, when it was updated and by whom; **Delete list** (an empty upload:
  everyone of the list, those added by hand too, section 8).
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
`players`, `scorers`, `coaches` (one route each, never a uuid). Every person a read answers has
`manual` (section 8): `true` when the person is only in the lists by hand, `false` when an upload
has them.

| Route | Who | |
|---|---|---|
| `PUT /api/club/:id/licences/:list` | the club's managers, admins | `{ people: [{ sv_number, last_name, first_name, dob, gender }] }`, at most 2000; replaces the uploaded people of that list in one transaction, keeps those added by hand (section 8); an empty list deletes the whole list. `{ list, count, manual, imported_at }` (`count`: the upload's people, `manual`: those by hand the list keeps) |
| `GET /api/club/:id/licences` | the club's managers, admins | `{ season, lists: { players, scorers, coaches: { count, manual, imported_at, imported_by_name } }, people: [{ sv_number, last_name, first_name, dob, gender, manual, lists, teams: [{ id, name }] }] }`: `count` everyone of the list, `manual` those by hand; `imported_at` and `imported_by_name` the last upload's (`null` without one) |
| `POST /api/club/:id/licences/people` | the club's managers, admins | section 8 |
| `DELETE /api/club/:id/licences/rows/:rowId` | the club's managers, admins | one row added by hand (section 9) |
| `GET /api/team/:id/club-players` | whoever may manage the team | `{ team, gender: 'm' \| 'f' \| null, age_class: 'U16' \| null, players, people }`: `players` the players list of the team's gender and age class (five fields and `manual`), `people` the people of the team's saved team and those players once `{ sv_number, last_name, first_name, dob, gender, manual, lists }`; `dob` only of the people of the saved team (section 9) |
| `GET /api/team/:id/club-people?q=` | whoever may manage the team | at least 3 characters: at most 10 people of the three lists by name or licence number, `dob` as above. `{ people, more }` |
| `POST /api/team/:id/club-people` | whoever may manage the team | section 8, to the team's club |
| `GET /api/club-licences` | indoor `canReadTeams` (scorers) | `{ fetched_at, clubs: [{ club_id, club_name, team_names, team_genders, players, people }] }`: the caller's clubs, `players` and `people` as above, `dob` always `null` (section 9) |
| `GET /api/club-licences/dob?club=&sv=` | the same | at most 30 licence numbers of one of the caller's clubs: `{ club_id, people: [{ sv_number, dob }] }` (404 for another club) |

`players` keeps the shape of the first build (plus `manual`): the apps of release 3.0.15 read only
`players` (the roster rows), and keep working; `people` is new. An app reading a server without
`people` offers the players list for the officials too; one without `manual` shows everyone as
from the club.

Audit: `club.licences` with `{ club_id, list, count }`, `club.licences.manual` with `{ club_id,
team_id, added, lists }` (section 8), never a name or a licence number.

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
  imported_by, source, season, id)`, primary key `(club_id, list, sv_number)`; `source` `import`
  or `manual` (db/026; `imported_at`/`imported_by` of a manual row: when and by whom it was
  added); `season` the season of the upload or of the row by hand, `id` a row id (db/037).
- **Each upload replaces the uploaded people of that list.** A person who left the club is gone
  with the next upload. Those added by hand stay until Delete list (section 8) or until a club
  manager removes them one by one (section 9).
- **One season** (db/037): only the current season's rows (July to June) are served; the rows of
  past seasons are deleted every day (and by the club's next upload or row by hand), so a club
  uploads its lists again for each season.
- **Deleted with the club** (`ON DELETE CASCADE`) or with the list (Delete list, those added by
  hand too). `imported_by` is set NULL when that account is deleted.
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
- **L7** (owner 2026-11-10) People typed in by hand can be kept in the club's lists (section 8): a
  gray shield until an upload has them, then green. An upload never removes them; Delete list
  does.

## 8. People added by hand (db/026)

Owner, 2026-11-10: "if I add somebody manually, when saving ask if I want to save him/her in the
club. Those from the club/recognized/linked -> green shield. Those added manually -> gray shield,
but can be linked later."

- **When.** Save in My teams' squad editor first asks whether the people typed in by hand (in
  none of the club's lists, not even by hand) who have a licence number go to the club's lists,
  all ticked at first: players to the players list (with the team's gender when the schedule
  knows it), team officials to the coaches list. Those without a licence number are named, not
  offered. The roster is saved either way, then the ticked ones are added; those left unticked
  are not asked again for that team while the page is open (in memory only: never in the
  browser's storage, db/037). Nobody is added without that answer.
- **What.** The five fields of an upload (section 1) and the list; the row is `source = 'manual'`,
  `imported_by` the account that added it. A licence number any of the club's lists already has
  (uploaded or by hand) is left as it is: nothing of the club's lists is overwritten by hand, and
  a row by hand never stands for someone of another list (db/037).
- **Shields.** Each row of the squad editor and of a game's roster has one. The row is a club
  person by the same licence number, else by the same name (accents, case and order aside) and
  date of birth. Green: a person of an uploaded list (`manual: false`); a dot on it when the
  club has a field the row lacks (tap: filled in). Gray: typed by hand, also a person kept by hand
  (`manual: true`, every row of the person by hand; in every read: `players` and `people`, My
  club, where it is tagged "Added by hand", and the tablet's copy). In the squad editor the gray
  shield links the row to someone of the uploaded lists (the search starts at its last name, or
  with everyone when that finds nobody; the row takes names, date of birth and licence number).
- **Match Setup.** The same shields from the tablet's copy (offline; it keeps `manual`), beside
  Delete in the one-line rows (landscape; the stacked rows of a tablet held upright leave them
  out). Its rows have no licence number: a club person by name and, when both have one, date of
  birth. The gray shield links the row (names and date of birth), the green one with a dot fills
  in the first name or date of birth. No "save in the club" there: scorers do not manage teams.
- **Linked later.** An upload replaces only the uploaded rows of its list. A row by hand whose
  licence number the upload has becomes an uploaded row with VolleyManager's fields (green from
  then on, and gone with a later upload that no longer has it); the others stay by hand. Delete
  list (an empty upload) removes the whole list, those added by hand too.
- **Gender.** A row by hand with a gender counts for the gender rule (section 3) like an uploaded
  one; without a gender it never refuses anyone.

| Route | Who | |
|---|---|---|
| `POST /api/team/:id/club-people` | whoever may manage the team (its team managers, the club's managers, admins) | to the team's club (404 for an unknown team) |
| `POST /api/club/:id/licences/people` | the club's managers, admins | to that club (404 for an unknown club) |

Body (both): `{ people: [{ list, sv_number, last_name, first_name, dob, gender }] }`, 1 to 30
people, `list` one of `players`, `scorers`, `coaches`, the five fields as an upload's (section 1);
any other field in the body or in a person is refused (400 `OV_INVALID_REQUEST`, nothing stored).
A licence number twice in one list in one request is one person. Answer 200 `{ club_id, added,
already }`: the people of the request added, and those the list had already. Audit (only when
someone was added): `club.licences.manual` with `{ club_id, team_id (null for the club's route),
added, lists: { <list>: n } }`, never a name or a licence number. Privacy 1.12.

Deploy: `db/026_club_licences_manual.sql` and `apply-roles.sh` before the backend image, then the
manager. Without 026 the new backend reads every row as uploaded and answers 503 to the two
routes and to an upload (Delete list still works); a backend of before 026 works on it (its
upload replaces the rows by hand too).

## 9. Only what each role needs (db/037)

Owner decision 2 (rollout audit, 2026-11): a team manager gets only the people its team needs,
filtered on the server, and dates of birth only once a person is in a roster; the scoring tablets
keep no dates of birth.

- **Team managers.** `players`: the players list of the team's gender (and those the list gives
  no gender) and age class: a team whose leagues this season name one `U<n>` ("U16 Juniorinnen")
  gets the players born in the season's first year minus n or later (one year more than the
  class's own limit, so nobody of the class is left out) and those without a date of birth.
  `people`: the people of the team's saved team and those players. An official may be anyone of
  the club: the picker asks the server's name search (`GET /api/team/:id/club-people?q=`, at
  least 3 characters, at most 10 rows). Dates of birth only of the people of the team's saved
  team; saving a squad or a game roster fills in the club's date of birth of each row with a
  licence number of the lists and none of its own (lib/licences.js fillDob).
- **Scorers.** `GET /api/club-licences` sends no dates of birth. Match Setup asks for those of
  the people it adds from the club (`GET /api/club-licences/dob`, online; offline the scorer
  types them or a sent roster brings them).
- **Rows by hand.** A licence number of any list of the club is not added by hand again; `manual`
  of a row of the players list is that row's own; a person's names, date of birth and gender come
  from its uploaded rows first. At most 300 rows by hand per club and 100 per account a day (409
  `OV_MANUAL_LIMIT`). My club's page of a person lists its rows by hand, each with Remove
  (`DELETE /api/club/:id/licences/rows/:rowId`, 409 `OV_NOT_HAND_ADDED` for an uploaded row;
  audit `club.licences.manual_delete` with `{ club_id, list }`).
- **Person pages** are `#myclub/<club id>/person/<row id>`: no licence number in the browser's
  history.
- **Seasons.** Section 6.

Deploy: `db/037_club_data_scope.sql` (the migration runner, deploy.sh) before the backend image.
Without 037 the new backend reads every row as one of the current season and answers 503 to an
upload and to a row by hand; a backend of before 037 works on it.
