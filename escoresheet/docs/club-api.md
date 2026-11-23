# Club API (tokens)

For a club's own website or software: read the club's teams, games and matches,
and send rosters. Live scores on a website need **no token**: use the public
widget (`public-api.md`). Code: `backend/lib/clubApi.js`, `db/044_club_api_tokens.sql`.
Machine-readable: `openapi.yaml`.

## Tokens

A club manager makes tokens in the manager: **My club → API**. A token

- belongs to **one club** (optionally one team), carries **scopes**, and may end after 1 to 730 days;
- is shown **once** (only a SHA-256 is stored); the list shows its first characters;
- acts **as the manager who made it**: it can do nothing that manager could not (same functions, same
  rules: the team must be the club's, the game the team's, the gender rule, limits). It stops when the
  manager no longer manages the club, while the account is deactivated, or when it is deleted;
- needs the manager's **password** to be made when it has a write scope;
- can be revoked at any time (software using it stops at once). At most 20 active tokens per club.

Scopes: `read` · `rosters:write` · `teams:write` · `licences:write` (a write scope brings `read`).
`read` reaches **no personal data**: the club, its teams, their games and the matches (a game's roster
summary has its counts and times, never the name of the team manager who sent it or the scorer who
accepted it). Rosters, squads
and licence lists (names, licence numbers, signatures; no dates of birth since db/048) are read with
the write scope of that data, which needs the manager's password to make. Expired tokens do not count against the 20.

Keep write tokens on a server. A token in a web page is visible to every visitor; the widget and the
public API need none.

## Requests

`Authorization: Bearer ovk_…` on `https://backend.openvolley.app/api/club/v1`. Every write (`PUT`, `POST`, `DELETE`) must send `Content-Type: application/json`, a `DELETE` without a body too, or the server answers 415 (a protection against cross-site form posts). 240 requests a minute per
token; from one address 1200 a minute, and after 60 refused tokens in a minute (missing, unknown,
revoked or expired) that address gets 429 for the rest of the minute, whatever token it sends. Answers are `{ "data": …, "error": null }` or `{ "data": null, "error": { "code", "message" } }`
(the matches routes answer the public API's bodies, see `public-api.md`).

| Request | Scope | What |
|---|---|---|
| `GET /club` | read | The club: id, name, teams, contact address (not its managers) |
| `GET /teams` | read | `{ id, name }` of the club's teams |
| `GET /games` | read | The club's games from today, all teams (from the VolleyManager schedule) |
| `GET /teams/:team/games` | read | One team's games, each with its roster summary (counts and times; `updated_by_name` / `used_by_name` are always `null` here: who sent or accepted a roster is personal data) |
| `GET /teams/:team/games/:game/roster` | rosters:write | The roster sent for a game, or `null` |
| `PUT /teams/:team/games/:game/roster` | rosters:write | `{ players, staff, coach_signature?, captain_signature? }` |
| `DELETE /teams/:team/games/:game/roster` | rosters:write | Remove it |
| `GET` / `PUT /teams/:team/squad` | teams:write | The team's saved team (`{ players, staff }`) |
| `GET /licences` | licences:write | The club's licence lists and people |
| `PUT /licences/players` `scorers` `coaches` | licences:write | `{ people: [{ sv_number, last_name, first_name, gender }] }` replaces that list (a `dob` an older client still sends is accepted and dropped) |
| `GET /matches?from&to&status&limit` | read | The club's matches (home or away), as the public API shows them |
| `GET /matches/:id`, `/live`, `/stats` | read | One of the club's matches |

**Games are read-only.** Official games come from the VolleyManager schedule; a club cannot create or
change one. A roster for a game of the team's schedule can be sent any time before the scorer accepts it;
accepted rosters are deleted (the row stays without personal data) and every one goes 14 days after the game.

Rosters, squads and licence lists contain names and licence numbers: only a token of that club reads
them. No date of birth is kept or answered (db/048): a `dob` in a roster, squad or licence list body is
dropped. Rosters and squads have no age-class rule; a youth team's squad takes any player of the club.
The public API never shows names.

## Audit

Every token made or revoked, every write with a token, and every read of personal data (roster,
squad, licence lists; once per token and route every 10 minutes) is in the audit log (`club_api.token`,
`club_api.call` with the token id, the route and the status, `club_api.read` with the token id, the
route, team and game; never a name).

## Example

```sh
T=ovk_…
curl -H "Authorization: Bearer $T" https://backend.openvolley.app/api/club/v1/teams
curl -X PUT -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"players":[{"number":7,"first_name":"Anna","last_name":"Muster","active":true}],"staff":[]}' \
  https://backend.openvolley.app/api/club/v1/teams/<team id>/games/<game number>/roster
```
