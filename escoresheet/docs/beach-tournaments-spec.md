# OpenBeach tournaments (phases T1 and T2, as built)

Plan: `~/ov-ops/openbeach-separation-tournaments-PLAN.md`, sections 1.2 (migrations 013 and 014) and 3 (the tournament module), phase T1. Owner decisions D5 (double elimination first), D6 (court tablets need a signed-in `beach:scorer`, phase T3), D7 (internet required in tournament mode v1) and D9 (public pages show names and countries only).

T1 is the tournament core: the data model, the API, manual creation in OpenBeach's manager (manager-beach.openvolley.app), the double-elimination bracket, the schedule, manual results and the final ranking. T2 is the Excel/CSV import (section 9). Not yet built: court tablets that claim a match and the results that flow back from a closed scored match (T3), the public pages on livescore-beach (T4; the data endpoint is here), the Swiss Volley import (T5), pool formats.

## 1. Migrations

| File | What |
|---|---|
| `backend/db/013_beach_official_index.sql` | Recreates `matches_official_game_uidx` with `AND sport_type IS DISTINCT FROM 'beach'`. Beach game numbers restart with every tournament, and the season splits in July, so game 1 of a summer's second tournament was refused with `OV_GAME_TAKEN`. Indoor keeps the same key. `lib/officialGame.js findClaim()` answers "free" for beach, so the friendly pre-check (`/api/db`, `/api/match/restore`, `/api/match/official-check`) never refuses what the index allows. Idempotent: a re-run sees "beach" in the index predicate and stops. `007`'s duplicate scan reads the same predicate: re-run after 013, it leaves beach matches alone (it would otherwise exempt a beach game 1 of a second tournament). |
| `backend/db/014_beach_tournaments.sql` | The tables below and `matches.tournament_match_id` (FK to `beach_tmatches`, unique when set, CHECK beach only, added `NOT VALID` so no scan). `updated_at` triggers (006's function). Grants `ov_app` DML when the role exists; `roles.sql` covers every public table anyway. |

| Table | Key columns |
|---|---|
| `beach_tournaments` | `slug` (unique, `a-z0-9-`, the public address), `title`, `venue`, `city`, `plus_code`, `starts_on`/`ends_on` (at most 14 days), `day_start`/`day_end` (Zurich play hours), `status` draft → published → live → finished → archived, `public`, `source` manual\|xlsx\|swissvolley, `created_by` |
| `beach_tournament_managers` | `(tournament_id, user_id)`, `added_by` |
| `beach_courts` | `number` (unique per tournament), `name`, `active`, `flex` |
| `beach_draws` | `gender`, `category`, `format` (`DE` in T1), `board_size` 8/16/32, `scoring` `{best_of, points}`, `slot_minutes`, `rest_minutes`, `registration_end`, `coaching_allowed`, `sv_tournament_id` (unique, T5), `status` entries → seeded → drawn → playing → done |
| `beach_entries` | `seed` (unique per draw, deferred, so seeds can swap), `team_id` → `competition_teams` (a saved beach pair, db/009), `name`, `player1`/`player2` `{first, last, licence, country}`, `wildcard`, `late`, `status` registered\|withdrawn\|replaced\|dq, `final_rank` |
| `beach_pools`, `beach_pool_members` | for the pool formats (later phases; empty in T1) |
| `beach_tmatches` | `tournament_id`, `draw_id`, `game_n` (unique per tournament), `code` (unique per draw), `phase`, `round`, `position`, `wave`, `source1`/`source2` (`seed:4`, `winner:W3`, `loser:L2`), `entry1_id`/`entry2_id`, `winner_rank`/`loser_rank`, `court_id`, `scheduled_at`, `duration_min`, `status` scheduled\|ready\|called\|in_progress\|finished\|walkover\|cancelled, `match_id` (unique, the scored match, T3), `claimed_by`/`claimed_at` (T3), `winner_entry_id`, `result` played\|retired\|forfeit\|walkover, `sets`, `referee`, `scorer` |

None of these tables is on the `/api/db` allowlist. `matches.tournament_match_id` is server-only: `server.js WRITE_DENYLIST.matches` and `lib/matchRestore.js serverOnlyColumns` strip it from every client write until T3 links it for the account that claimed the tournament match.

## 2. Who may do what

The beach roles of the row's sport (`lib/access.js`), never the app the client says it is.

| Action | Who |
|---|---|
| any `/api/beach/*` | some beach right: `beach:scorer`, `beach:competition_manager` or the global admin (else 403 before anything is revealed) |
| read a tournament | its editors; any beach reader once it is not a draft (archived ones are not listed for readers) |
| create | `beach:competition_manager` or the global admin |
| edit (everything below) | the global admin, or a `beach:competition_manager` who created the tournament or is one of its co-managers |
| co-manager | only an account with `beach:competition_manager` (or admin); any other email answers the same 404 |
| licences (ranking, entries in `GET /api/beach/tournaments/:id`) | editors; other readers get `{ first, last, country }` only |

## 3. HTTP API (`backend/lib/beachTournaments.js`, routed by `lib/manageApi.js`)

| Endpoint | Contract |
|---|---|
| `GET /api/beach/tournaments` | `{ tournaments: [{ ...tournament, draws, can_edit }] }` |
| `POST /api/beach/tournaments` | `{ title, starts_on, ends_on, slug?, venue?, city?, plus_code?, day_start?, day_end?, public?, courts?, source? }` (`source` `manual` or `xlsx`, T2); without `slug` one is made from the title and year (`zuri-open-2026`, then `-2`, ...). 201 `{ tournament }`; 409 `OV_SLUG_TAKEN` |
| `GET /api/beach/tournaments/:id` | `{ tournament, managers (editors only), courts, draws, entries, matches }`; player licences for editors only |
| `PATCH /api/beach/tournaments/:id` | any field above plus `status`, `public` |
| `DELETE /api/beach/tournaments/:id` | 409 `OV_DRAW_STARTED` once a match has begun or has a result |
| `POST /api/beach/tournaments/:id/managers { email }`, `DELETE .../managers/:userId` | co-managers |
| `PUT /api/beach/tournaments/:id/courts { courts: [{ number, name, active, flex }] }` | the full list; courts left out are removed (their matches lose the court) |
| `POST /api/beach/tournaments/:id/draws` | `{ gender, category, format: 'DE', board_size?, slot_minutes?, rest_minutes?, coaching_allowed?, registration_end? }` |
| `PATCH`, `DELETE /api/beach/draws/:id` | gender and board fixed once drawn (409 `OV_DRAW_DRAWN`); delete refused once begun |
| `POST /api/beach/draws/:id/entries` | `{ team_id }` (a saved beach pair: name and player snapshot from it) or `{ player1, player2, name? }`; `seed?`, `wildcard?`, `late?`. 409 `OV_ENTRY_EXISTS` for a pair entered twice |
| `PATCH`, `DELETE /api/beach/entries/:id` | seeds, withdrawals and deletes only before the draw is made |
| `PUT /api/beach/draws/:id/seeds { order: [entryId] }` | seeds 1..n in this order |
| `POST /api/beach/draws/:id/generate { dryRun?, board_size? }` | the bracket of the registered entries in seed order: `{ board_size, teams, warnings, seeds, matches }`. `dryRun` writes nothing. Writing replaces the draw's matches (only before any has begun or ended: 409 `OV_DRAW_STARTED`), fixes the seeds and refreshes the player snapshots from the saved pairs. Game numbers continue after the tournament's other draws (the tournament row is locked, so two draws generated at once get distinct numbers). 409 `OV_DRAW_SIZE` outside 4..32 pairs. The board: `board_size` of the body (400 when too small), else the draw's `board_size` when it still fits, else the smallest that fits. Only a chosen size is stored on the draw, never a derived one, so a late pair after a reset gets a bigger board, and one fewer a smaller one; a stored choice that no longer fits is cleared |
| `DELETE /api/beach/draws/:id/bracket` | back to seeded (only before any match has begun or ended) |
| `POST /api/beach/tournaments/:id/schedule { dryRun?, day_start?, day_end? }` | `{ slots, unplaced, warnings }`; begun matches keep their slot; during the tournament nothing new starts before now; every match that has not begun is placed again (a hand move of an open match is not kept); the hours are saved on the tournament |
| `PATCH /api/beach/tmatches/:id { court_id, scheduled_at, duration_min, referee, scorer, force? }` | a slot moves only before the match has begun (409 `OV_MATCH_BEGUN`). A new slot is checked like the planner: 409 `OV_SLOT_CONFLICT` `{ conflicts: [{ reason, game_n?, code? }] }`, reason `court` (another match on that court then), `days`, `hours`, `before_source` (before a match it waits for has ended plus the rest), `after_dependent` (a match waiting for it starts before it has ended plus the rest). `force: true` keeps it anyway (audited `forced`); the manager's dialog asks first. Clearing a court or a time is never checked |
| `POST /api/beach/tmatches/:id/result { winner: 1\|2, result, sets, expect? }` | `winner` 1 = entry1. `expect` `{ winner_entry_id, result, sets }` is the result the caller's screen showed (all null for a first entry); 409 `OV_RESULT_CHANGED` `{ match }` when the stored one differs, so a second manager never overwrites a result silently (the console always sends it). `played`: 2 or 3 finished sets (21/21/15 by default, two points clear, the winner wins two); `retired`/`forfeit`: the sets so far or none; `walkover`: none. A correction that changes the winner is refused once a dependent match has begun (409 `OV_BRACKET_LOCKED`). 409 `OV_MATCH_NOT_READY`, `OV_MATCH_LINKED` |
| `DELETE /api/beach/tmatches/:id/result` | the match is open again (same lock) |
| `POST /api/beach/tournaments/:id/import[?dryRun=1]` | the Excel/CSV import (T2, section 9): `{ entries?, matches?, hash? }`; editors only |
| `GET /api/beach/draws/:id/ranking` | `{ tournament, draw, complete, ranking, csv }` (editors; licences included) |
| `GET /api/public/beach/t/:slug` | anonymous, 120 per minute and IP, `Cache-Control: public, max-age=15` (and 15 s in the process). Only `public` tournaments that are not drafts. Names and countries only: no licence, no account ids or emails, no scored-match ids, no officials (D9) |

Every write is audit-logged with `app = 'beach'`: `tournament.create`, `.update`, `.delete`, `.managers`, `.draw`, `.entry`, `.schedule`, `.result`, `.import` (T2: counts only, no names or licences).

**Results are recomputed over the whole draw** in the same transaction (draw row locked): who plays each match from the sources and the results, `ready` when both pairs are known, the final ranks, the draw's status (`playing`, `done` once every match has a result, the 3rd place too: `complete` in the ranking follows it). Entering or withdrawing a result is therefore idempotent.

## 4. The double-elimination draw (`backend/lib/beachBracket.js`)

Board 8, 16 or 32 (the smallest that fits, or `board_size`); seeds n+1..board are byes and go to the top seeds.

- Winners bracket: W1 in the standard seed order (1-16, 8-9, 4-13, 5-12, 2-15, 7-10, 3-14, 6-11 for 16), then winners against winners.
- Losers bracket: the losers of W1 in pairs, then for every later winners round a drop round (the previous losers' winners against the new losers, which come in reversed order on odd drop rounds and in order on even ones, so the halves cross) and, except after the last, a round that halves the bracket.
- Crossover semifinals (the winner of the first last-winners match against the losers-bracket finalist that took the other one's loser), 3rd place, final.
- A match with a bye is not played (no ghost games): a top seed of a 12-team draw starts in W2, and no first losers round is played. n teams always play 2n − 2 matches.
- Ranks: 1, 2, 3, 4, then the losers of the last losers round 5th, the round before them next, and so on (shared: 5, 5, 7, 7, 9 ×4, 13 ×4, 17 ×8, 25 ×8). A round with no match gives no rank.
- Codes in playing order: W1.., L1.., SF1, SF2, P3, F. Each match has a `wave` (1 + the latest wave it waits for), which orders the games and the schedule.
- Warnings (they never block): fewer than 5 pairs (8 for an A category), a board of 16 on 1 court or 32 on fewer than 4 (Art. 46).

Golden files: `backend/tests/fixtures/beach-de/de-{8,12,16,24,32}.txt`, checked by `tests/beachBracket.test.js` together with random and favourite-wins playthroughs of every size 4..32. **The official Swiss Volley templates (MyBeach "Tableauvorlagen", plan action A3) were not available.** Compare the goldens with them before the first official tournament; a difference is a change of `beachBracket.js` and of these files.

## 5. The schedule (`backend/lib/beachSchedule.js`)

Greedy list scheduling in bracket order (wave, then the draw's order, then the game number) over the active courts and the tournament's days, inside the Zurich play hours (DST safe). A match starts no earlier than the end of every match it waits for plus the draw's rest time, so a pair never plays two matches at once; it takes the court with the earliest gap where its slot fits (a later match can fill a gap). Begun matches keep their slot and block their court. During the tournament (the clock on one of its days) no new slot starts before now, rounded up to 5 minutes; before the first day or after the last the clock changes nothing. A re-plan places every match that has not begun again, hand moves included (pin a slot by starting the match, or move it again after the re-plan). What does not fit is returned as unplaced (and loses its slot). Warning: more than 18 matches on a court in a day.

## 6. The manager (manager-beach, Tournaments tab)

`frontend/src/components/manage/tournaments/`: the list and "New tournament"; one tournament with Details (fields, status, public page, co-managers, delete), Courts, Draws (pairs from saved pairs or typed, seeds by reordering, the bracket drawn after a preview, results, corrections, withdrawals), Schedule (planned after a dry run, a grid of times × courts per day, each match movable, referee and scorer names), Ranking (table, CSV download with a BOM for Excel, copy). Only in OpenBeach's console (`ManageConsole` tab `apps: ['beach']`), for `beach:competition_manager` and the admin. API client `src/lib/tournamentApi.js`, pure helpers `src/domain/beachTournament.js`. Strings in the `tournaments` namespace of all five locales (de-CH in standard German, like the console's other sections).

## 7. Deploy order

1. As `ov_owner`: `db/013_beach_official_index.sql`, `db/014_beach_tournaments.sql`, then `roles.sql` (all idempotent). The running backend keeps working: 013 only allows more beach matches (its friendly pre-check may still name a beach claim of the same season until the new image runs); 014 adds tables and one nullable column.
2. The backend image. Without 014, `/api/beach/*` answers 503 (no table); nothing else uses it.
3. The `openbeach-manager` Pages project (`build:manager-beach`).

Rollback: the previous image works on a 013/014 database. A beach match with a game number already used that season by another beach match would then be refused by the old friendly check on its next write; with 013 in place the database itself still accepts it. To restore the old index exactly, drop and recreate it with 007's definition (only possible when no two beach matches share a game and season).

## 8. Tests

Backend: `migration014.pg.test.js` (013 and 014 on a 012 database, twice; checks, cascades, FK, grants), `beachBracket.test.js` (goldens and playthroughs), `beachSchedule.test.js`, `beachTournaments.test.js` (set rules, slug, CSV, routing), `beachTournaments.e2e.test.js` (roles, drafts, co-managers, courts, entries from a saved pair, seeds, preview and bracket, game numbers per tournament, schedule, results through to the final ranking, lock, CSV, public projection without licences and none for scorers in the bundle, hand moves checked against the schedule (`OV_SLOT_CONFLICT`, `force`), stale results refused (`OV_RESULT_CHANGED`), the board following late pairs, a draw done only with its 3rd place, two draws generated at once, `tournament_match_id` never written by `/api/db`, audit per app). `migration014.pg.test.js` also re-runs 007 after 013 (no beach exemptions). `officialGame.pg.test.js` and `accounts.pg.test.js` assert the db/013 rule (no season claim for beach).

Frontend: `src/domain/__tests__/beachTournament.test.js`, `src/__tests__/BeachTournaments.test.jsx`, `src/__tests__/ManagerBeach.test.jsx` (the beach tabs).

## 9. The Excel/CSV import (phase T2)

Plan section 3.4: the file is read in the browser, the server checks it and answers a preview, and only "Apply" with the preview's hash changes anything.

**The template** ("Download template", built in the browser): sheet **Entries** (Draw, Gender, Seed, Player 1 last name / first name / licence / country, Player 2 the same, Team name, Wildcard), sheet **Matches** (Draw, Gender, Game #, Date, Time, Court, Phase, Round, Team 1, Team 2, 1st referee, Scorer) and an **Info** sheet with the rules and an example per column. Headers in the screen's language (de-CH: de); the columns are text-formatted, so a licence `00123` or a date typed `11.07.2026` stays as written. A CSV file is one sheet (`;`, `,` or tab; UTF-8, else Windows-1252).

**In the browser** (`frontend/src/domain/beachImport.js`): columns are found loosely (lower case, no accents or punctuation, as openbeach's old `excelParser_beach.js`), under their names in en, de, fr, it and the usual others (`Nachname 1`, `P2 Last`, `Lizenz`, `Nr.`, `Platz`, ...); a sheet is Entries or Matches by its name or its columns, its header may sit below a title row. Excel's day numbers become `YYYY-MM-DD` / `HH:MM` by their column. The rows go to the server as text, `{ row, <field>: text }`. Blocking before anything is sent: no sheet found, missing required columns (Entries: Draw, Gender, both last names; Matches: Game #), two sheets of a kind, more than 600 / 1200 rows, an old `.xls`. An empty sheet is not sent. The XLSX reader and writer (`frontend/src/lib/xlsxCodec.js`, on fflate, which jspdf already ships) load with the dialog; the Android build gets `xlsxCodec.stub.js` (`vite.config.js`, `CAPACITOR=true`), so the APK carries no XLSX code.

**On the server** (`backend/lib/beachImport.js`, pure; `importTournament` in `lib/beachTournaments.js`):

| Endpoint | Contract |
|---|---|
| `POST /api/beach/tournaments/:id/import?dryRun=1` | `{ entries?: [row], matches?: [row] }` → the plan: `{ hash, summary, can_apply, warnings, rows: { entries, matches }, draws, entries, matches, courts }`. Every row `{ row, status: ok\|warning\|error, op, messages: [{ level, code, field?, ... }] }`; the diff: draws (`new` / `existing`, `bracket` when drawn here), pairs (`new` with their values, `changed` with `{ field, from, to }`, `removed` = withdrawn; unchanged ones only counted), games (`changed`: court, start, officials), new courts. Nothing is written. |
| `POST /api/beach/tournaments/:id/import` | the same body plus `hash`. The plan is made again with the tournament and its draws locked; 409 `OV_IMPORT_CHANGED` `{ preview }` when its hash differs (the file or the tournament changed: the console shows the new preview), 400 `OV_IMPORT_INVALID` `{ preview }` when a row has an error, else applied in one transaction: `{ applied: summary, hash }`. A plan with nothing to change answers the same and writes nothing. |

Rules of the plan:
- **Values** are checked per row: gender in five languages (`Damen`, `Herren`, `W`, `F`, `Mixte`, ...), seed `3` / `#3` / `Seed 3` (1..128), country 3 letters, wildcard yes/no in five languages, game 1..9999, date `11.07.2026` / `2026-07-11` / `11.7.26`, time `9:30` / `9.30` / `9h30` (Europe/Zurich), court `3` / `Platz 3` (1..99), texts at most 200 characters.
- **Draws**: Draw (the category) and Gender name the draw (category matched case-insensitively); a draw the tournament does not have is created (format DE).
- **Pairs**: a row finds its pair in the draw by both licence numbers, else by both players' names in either order (a registered pair before a withdrawn namesake); a blank cell keeps the value. A pair of the draw missing from the file is **withdrawn** (seed cleared). **Seeds**: when any row of a draw has a seed, the file's seeds are the draw's (blank = none); else the pairs keep theirs. Duplicates in the file are errors (same pair, same seed, a licence twice). A new pair whose two licences are exactly those of one saved beach pair (db/009) is linked to it (the tournament's season first); no saved pair is created.
- **A drawn bracket** (status drawn, playing, done) takes names, players and wildcards only, as `PATCH /api/beach/entries/:id`; a new, re-seeded or re-registered pair is an error (`draw_drawn`), and its pairs missing from the file stay (warning `kept_drawn`).
- **Matches** (optional, an organiser's own plan): a row finds its game by number; Draw and Gender, when given, must be that game's draw (`game_other_draw`, `unknown_draw`). A draw named there without a bracket gets one in the same import, exactly as "Draw the bracket" (board: the stored choice when it fits, else the smallest; game numbers after the tournament's other draws, draws in the plan's order), after every registered pair is seeded (seeded ones first, then the draw's order, then the file's; warning `seeds_assigned`); 4..32 pairs, else `draw_size`. A row sets the date and time, the court (created when missing) and the officials; blank keeps. A game that has begun keeps its court and time (`match_begun`). Warnings, never blocking: the slot rules of a hand move (`lib/beachSchedule.js slotIssues`: court taken, not a tournament day, outside the play hours, before the game it waits for, after a game that waits for it), Team 1 / Team 2 against the bracket (a seed or the pair's name), Phase against the game's phase (also the console's own phase names). Round is not checked.
- **The hash** is the SHA-256 of the plan's JSON: it covers the file's rows and every value of the tournament the plan read.

Audit: `tournament.import` with the counts (`draws_new`, `entries_new`, `entries_changed`, `entries_removed`, `brackets`, `matches_changed`, `courts_new`) and the title; never names or licences.

**Not in T2**: the MyBeach seed-list export (after action A2: a parser of its own, same preview), creating saved pairs from the file, the Google Sheets link, the Swiss Volley import (T5).

**Deploy**: no migration. The backend image (the endpoint and the audit action), then the `openbeach-manager` Pages project (`build:manager-beach`). An older manager simply has no import button.

**Tests**: backend `tests/beachImport.test.js` (values, rows, diff, seeds, drawn brackets, Matches sheet, brackets drawn by the import, clashes, hash) and `tests/beachImport.e2e.test.js` (roles, the dry run writes nothing, a stale hash and a changed tournament refused with the new preview, errors refused, the same file twice, withdrawals, a saved pair linked by licences, a Matches sheet drawing the bracket and setting slots and officials, the audit). Frontend `src/domain/__tests__/beachImport.test.js` (columns in four languages, CSV, Excel day numbers, sheets, the template read back), `src/lib/__tests__/xlsxCodec.test.js` (reading what Excel writes, writing, the Android stub and its alias), `src/__tests__/BeachImport.test.jsx` (the dialog: preview, apply with the hash, a stale preview, errors, problems found in the browser, the template download, "New tournament" from a file).
