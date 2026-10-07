# OpenBeach tournaments (phase T1, as built)

Plan: `~/ov-ops/openbeach-separation-tournaments-PLAN.md`, sections 1.2 (migrations 013 and 014) and 3 (the tournament module), phase T1. Owner decisions D5 (double elimination first), D6 (court tablets need a signed-in `beach:scorer`, phase T3), D7 (internet required in tournament mode v1) and D9 (public pages show names and countries only).

T1 is the tournament core: the data model, the API, manual creation in OpenBeach's manager (manager-beach.openvolley.app), the double-elimination bracket, the schedule, manual results and the final ranking. Not in T1: the Excel/CSV import (T2), court tablets that claim a match and the results that flow back from a closed scored match (T3), the public pages on livescore-beach (T4; the data endpoint is here), the Swiss Volley import (T5), pool formats.

## 1. Migrations

| File | What |
|---|---|
| `backend/db/013_beach_official_index.sql` | Recreates `matches_official_game_uidx` with `AND sport_type IS DISTINCT FROM 'beach'`. Beach game numbers restart with every tournament, and the season splits in July, so game 1 of a summer's second tournament was refused with `OV_GAME_TAKEN`. Indoor keeps the same key. `lib/officialGame.js findClaim()` answers "free" for beach, so the friendly pre-check (`/api/db`, `/api/match/restore`, `/api/match/official-check`) never refuses what the index allows. Idempotent: a re-run sees "beach" in the index predicate and stops. |
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
| ranking with licences | editors |

## 3. HTTP API (`backend/lib/beachTournaments.js`, routed by `lib/manageApi.js`)

| Endpoint | Contract |
|---|---|
| `GET /api/beach/tournaments` | `{ tournaments: [{ ...tournament, draws, can_edit }] }` |
| `POST /api/beach/tournaments` | `{ title, starts_on, ends_on, slug?, venue?, city?, plus_code?, day_start?, day_end?, public?, courts? }`; without `slug` one is made from the title and year (`zuri-open-2026`, then `-2`, ...). 201 `{ tournament }`; 409 `OV_SLUG_TAKEN` |
| `GET /api/beach/tournaments/:id` | `{ tournament, managers (editors only), courts, draws, entries, matches }` |
| `PATCH /api/beach/tournaments/:id` | any field above plus `status`, `public` |
| `DELETE /api/beach/tournaments/:id` | 409 `OV_DRAW_STARTED` once a match has begun or has a result |
| `POST /api/beach/tournaments/:id/managers { email }`, `DELETE .../managers/:userId` | co-managers |
| `PUT /api/beach/tournaments/:id/courts { courts: [{ number, name, active, flex }] }` | the full list; courts left out are removed (their matches lose the court) |
| `POST /api/beach/tournaments/:id/draws` | `{ gender, category, format: 'DE', board_size?, slot_minutes?, rest_minutes?, coaching_allowed?, registration_end? }` |
| `PATCH`, `DELETE /api/beach/draws/:id` | gender and board fixed once drawn (409 `OV_DRAW_DRAWN`); delete refused once begun |
| `POST /api/beach/draws/:id/entries` | `{ team_id }` (a saved beach pair: name and player snapshot from it) or `{ player1, player2, name? }`; `seed?`, `wildcard?`, `late?`. 409 `OV_ENTRY_EXISTS` for a pair entered twice |
| `PATCH`, `DELETE /api/beach/entries/:id` | seeds, withdrawals and deletes only before the draw is made |
| `PUT /api/beach/draws/:id/seeds { order: [entryId] }` | seeds 1..n in this order |
| `POST /api/beach/draws/:id/generate { dryRun?, board_size? }` | the bracket of the registered entries in seed order: `{ board_size, teams, warnings, seeds, matches }`. `dryRun` writes nothing. Writing replaces the draw's matches (only before any has begun or ended: 409 `OV_DRAW_STARTED`), fixes the seeds and refreshes the player snapshots from the saved pairs. Game numbers continue after the tournament's other draws. 409 `OV_DRAW_SIZE` outside 4..32 pairs |
| `DELETE /api/beach/draws/:id/bracket` | back to seeded (only before any match has begun or ended) |
| `POST /api/beach/tournaments/:id/schedule { dryRun?, day_start?, day_end? }` | `{ slots, unplaced, warnings }`; begun matches keep their slot; the hours are saved on the tournament |
| `PATCH /api/beach/tmatches/:id { court_id, scheduled_at, duration_min, referee, scorer }` | a slot moves only before the match has begun (409 `OV_MATCH_BEGUN`) |
| `POST /api/beach/tmatches/:id/result { winner: 1\|2, result, sets }` | `winner` 1 = entry1. `played`: 2 or 3 finished sets (21/21/15 by default, two points clear, the winner wins two); `retired`/`forfeit`: the sets so far or none; `walkover`: none. A correction that changes the winner is refused once a dependent match has begun (409 `OV_BRACKET_LOCKED`). 409 `OV_MATCH_NOT_READY`, `OV_MATCH_LINKED` |
| `DELETE /api/beach/tmatches/:id/result` | the match is open again (same lock) |
| `GET /api/beach/draws/:id/ranking` | `{ tournament, draw, complete, ranking, csv }` (editors; licences included) |
| `GET /api/public/beach/t/:slug` | anonymous, 120 per minute and IP, `Cache-Control: public, max-age=15` (and 15 s in the process). Only `public` tournaments that are not drafts. Names and countries only: no licence, no account ids or emails, no scored-match ids, no officials (D9) |

Every write is audit-logged with `app = 'beach'`: `tournament.create`, `.update`, `.delete`, `.managers`, `.draw`, `.entry`, `.schedule`, `.result`.

**Results are recomputed over the whole draw** in the same transaction (draw row locked): who plays each match from the sources and the results, `ready` when both pairs are known, the final ranks, the draw's status (`playing`, `done` after the final). Entering or withdrawing a result is therefore idempotent.

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

Greedy list scheduling in bracket order (wave, then the draw's order, then the game number) over the active courts and the tournament's days, inside the Zurich play hours (DST safe). A match starts no earlier than the end of every match it waits for plus the draw's rest time, so a pair never plays two matches at once; it takes the court with the earliest gap where its slot fits (a later match can fill a gap). Begun matches keep their slot and block their court. What does not fit is returned as unplaced (and loses its slot). Warning: more than 18 matches on a court in a day.

## 6. The manager (manager-beach, Tournaments tab)

`frontend/src/components/manage/tournaments/`: the list and "New tournament"; one tournament with Details (fields, status, public page, co-managers, delete), Courts, Draws (pairs from saved pairs or typed, seeds by reordering, the bracket drawn after a preview, results, corrections, withdrawals), Schedule (planned after a dry run, a grid of times × courts per day, each match movable, referee and scorer names), Ranking (table, CSV download with a BOM for Excel, copy). Only in OpenBeach's console (`ManageConsole` tab `apps: ['beach']`), for `beach:competition_manager` and the admin. API client `src/lib/tournamentApi.js`, pure helpers `src/domain/beachTournament.js`. Strings in the `tournaments` namespace of all five locales (de-CH in standard German, like the console's other sections).

## 7. Deploy order

1. As `ov_owner`: `db/013_beach_official_index.sql`, `db/014_beach_tournaments.sql`, then `roles.sql` (all idempotent). The running backend keeps working: 013 only allows more beach matches (its friendly pre-check may still name a beach claim of the same season until the new image runs); 014 adds tables and one nullable column.
2. The backend image. Without 014, `/api/beach/*` answers 503 (no table); nothing else uses it.
3. The `openbeach-manager` Pages project (`build:manager-beach`).

Rollback: the previous image works on a 013/014 database. A beach match with a game number already used that season by another beach match would then be refused by the old friendly check on its next write; with 013 in place the database itself still accepts it. To restore the old index exactly, drop and recreate it with 007's definition (only possible when no two beach matches share a game and season).

## 8. Tests

Backend: `migration014.pg.test.js` (013 and 014 on a 012 database, twice; checks, cascades, FK, grants), `beachBracket.test.js` (goldens and playthroughs), `beachSchedule.test.js`, `beachTournaments.test.js` (set rules, slug, CSV, routing), `beachTournaments.e2e.test.js` (roles, drafts, co-managers, courts, entries from a saved pair, seeds, preview and bracket, game numbers per tournament, schedule, results through to the final ranking, lock, CSV, public projection without licences, `tournament_match_id` never written by `/api/db`, audit per app). `officialGame.pg.test.js` and `accounts.pg.test.js` assert the db/013 rule (no season claim for beach).

Frontend: `src/domain/__tests__/beachTournament.test.js`, `src/__tests__/BeachTournaments.test.jsx`, `src/__tests__/ManagerBeach.test.jsx` (the beach tabs).
