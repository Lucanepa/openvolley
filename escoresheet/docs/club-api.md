# Club API (tokens)

For a club's own website or software: read the club's teams, games and matches,
and send rosters. Live scores on a website need **no token**: use the public
widget (`public-api.md`). Code: `backend/lib/clubApi.js`, `db/032_club_api_tokens.sql`.
Machine-readable: `openapi.yaml`.

## Tokens

A club manager makes tokens in the manager: **My club → API**. A token

- belongs to **one club** (optionally one team), carries **scopes**, and may end after 1 to 730 days;
- is shown **once** (only a SHA-256 is stored); the list shows its first characters;
- acts **as the manager who made it**: it can do nothing that manager could not (same functions, same
  rules: the team must be the club's, the game the team's, the gender rule, limits). It stops when the
  manager no longer manages the club, or when the account is deleted;
- needs the manager's **password** to be made when it has a write scope;
- can be revoked at any time (software using it stops at once). At most 20 active tokens per club.

Scopes: `read` · `rosters:write` · `teams:write` · `licences:write` (a write scope brings `read`).

Keep write tokens on a server. A token in a web page is visible to every visitor; the widget and the
public API need none.

## Requests

`Authorization: Bearer ovk_…` on `https://backend.openvolley.app/api/club/v1`. 240 requests a minute per
token. Answers are `{ "data": …, "error": null }` or `{ "data": null, "error": { "code", "message" } }`
(the matches routes answer the public API's bodies, see `public-api.md`).

| Request | Scope | What |
|---|---|---|
| `GET /club` | read | The club: teams, contact address |
| `GET /teams` | read | `{ id, name }` of the club's teams |
| `GET /games` | read | The club's games from today, all teams (from the VolleyManager schedule) |
| `GET /teams/:team/games` | read | One team's games, each with its roster summary |
| `GET /teams/:team/games/:game/roster` | read | The roster sent for a game, or `null` |
| `PUT /teams/:team/games/:game/roster` | rosters:write | `{ players, staff, coach_signature?, captain_signature? }` |
| `DELETE /teams/:team/games/:game/roster` | rosters:write | Remove it |
| `GET` / `PUT /teams/:team/squad` | read / teams:write | The team's saved team (`{ players, staff }`) |
| `GET /licences` | read | The club's licence lists and people |
| `PUT /licences/players` `scorers` `coaches` | licences:write | `{ people: [{ sv_number, last_name, first_name, dob, gender }] }` replaces that list |
| `GET /matches?from&to&status&limit` | read | The club's matches (home or away), as the public API shows them |
| `GET /matches/:id`, `/live`, `/stats` | read | One of the club's matches |

**Games are read-only.** Official games come from the VolleyManager schedule; a club cannot create or
change one. A roster for a game of the team's schedule can be sent any time before the scorer accepts it;
accepted rosters are deleted (the row stays without personal data) and every one goes 14 days after the game.

Rosters, squads and licence lists contain names and dates of birth: only a token of that club reads them.
The public API never shows names.

## Audit

Every token made or revoked, and every write with a token, is in the audit log (`club_api.token`,
`club_api.call` with the token id, the route and the status; never a name).

## Example

```sh
T=ovk_…
curl -H "Authorization: Bearer $T" https://backend.openvolley.app/api/club/v1/teams
curl -X PUT -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"players":[{"number":7,"first_name":"Anna","last_name":"Muster","active":true}],"staff":[]}' \
  https://backend.openvolley.app/api/club/v1/teams/<team id>/games/<game number>/roster
```
