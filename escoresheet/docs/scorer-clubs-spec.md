# Scorers score the home games of their own club

OpenVolley (indoor). Owner request 2026-10-13: "have each scorer signed up for
a specific club so they can't score games of another team". Deploy steps:
[scorer-clubs-deploy.md](scorer-clubs-deploy.md).

## 1. Owner decisions (2026-10-13)

| | Decision |
|---|---|
| a | A scorer scores only the **home** games of its club(s). |
| b | An account may belong to **several** clubs. |
| c | A scorer **without a club** scores no official game until an admin adds one. |
| d | **Indoor only**: beach matches are not checked. |

Also decided in the design:
- An admin switches the rule on. It is **off** after the deploy. Turning it on
  blocks every scorer without a club at once, so the clubs and their scorers are
  set up first.
- Admins score any game.
- A game that is not in the VolleyManager schedule (`svrz_games`) has no
  known home team, so it is refused while the rule is on.

## 2. Data (db/018_clubs.sql)

- `public.clubs`: a name, unique case-insensitively.
- `public.club_teams (club_id, team_name)`: the club's VolleyManager team names,
  as `svrz_games.team_home` spells them (`KSC Wiedikon H1`). A team belongs to
  one club only (unique index on the trimmed, lower-cased name).
- `public.account_clubs (user_id, club_id, granted_by, granted_at)`: which
  clubs an account scores for. Deleted with the account or the club.
- `public.invite_codes.club_id`: the club a code's redeemer joins (indoor codes
  only). The free-text `club` column stays as the label.
- `public.club_rule`: one row, `enabled` (default false), who switched it and
  when.

None of these tables is on the `/api/db` allowlist. Only the admin endpoints
read and write them, so a scorer cannot add itself to a club.

## 3. The rule (the database)

`ov_matches_club_guard`, a BEFORE INSERT OR UPDATE trigger on `public.matches`.
It refuses the write when all of these hold:
- the rule is on;
- `ov.user_id` is set (a signed-in account's write through pgQuery or
  matchRestore; trusted server code sets none);
- the row is an official indoor game: not a test match, not beach,
  `game_n > 0`, not `official_game_exempt`;
- the write claims the game anew: an INSERT that is not the INSERT half of an
  upsert of a stored match, or an UPDATE that changes `game_n` or turns a test
  or beach row into an official indoor one;
- the writer is not an admin;
- and one of the following:
  - the writer has no club: `OVL01` → 403 `OV_CLUB_REQUIRED`;
  - VolleyManager does not know the game: `OVL03` → 403 `OV_GAME_NOT_IN_SCHEDULE`;
  - the home team (`svrz_games.team_home` of the game number, never the
    client's) is not a team of the writer's clubs: `OVL02` → 403 `OV_NOT_YOUR_CLUB`.

Matches stored before the rule (or before a club change) go on as they were:
their further writes do not claim the game anew.

## 4. API (lib/clubs.js, lib/manageApi.js)

Admins:
- `GET /api/admin/clubs` → `{ clubs: [{ id, name, teams, scorers }], rule: { enabled, changed_at } }`.
- `POST /api/admin/clubs { name, teams? }`.
- `PATCH /api/admin/clubs/:id { name?, teams? }`, where `teams` is the whole list.
- `DELETE /api/admin/clubs/:id`.
- Errors of these three: 409 `OV_CLUB_EXISTS`, 409 `OV_TEAM_TAKEN` (details:
  `team: club`), 400 `OV_INVALID_REQUEST`.
- `GET /api/admin/club-teams?q=` → the VolleyManager team names (home and away),
  each with `club_id` / `club_name`.
- `PUT /api/admin/accounts/:id/clubs { club_ids }` (the whole list, at most 20;
  404 `OV_CLUB_NOT_FOUND`).
- `PUT /api/admin/club-rule { enabled }`.
- `POST /api/admin/invites` accepts `club_id` (indoor; 404 `OV_CLUB_NOT_FOUND`).
- `GET /api/admin/accounts` gives each account its `clubs: [{ id, name }]`.

Everyone signed in:
- `GET /api/me` adds `clubs: [{ id, name, teams }]` and `clubRule`.
- `POST /api/match/official-check` adds `club`: `{ ok: true[, home_team] }` or
  `{ ok: false, code, home_team, clubs }`. This is the database's rule, asked
  before the match exists.
- Redeeming an invite code that carries a club adds the club, also when the
  role was already there.

Audit: `club.create`, `club.update`, `club.delete`, `account.clubs`,
`club_rule.set`.

A database without db/018 reads as "no clubs, rule off" (no 503s while the
backend is deployed before the migration).

## 5. Apps

**Scorer app:**
- `AuthContext` loads `clubs` and `clubRule` from `/api/me` once signed in, on
  focus and when the connection comes back. It caches them per account in
  `localStorage['ov:clubs']`.
- `access.clubs` / `access.clubRule` / `access.clubsKnown`.
- A change of clubs or of the rule is an access change (`ACCESS_CHANGED_EVENT`),
  so the jobs the server refused are sent again.

**Match setup:**
- After a schedule game is loaded, and when the match info is confirmed, the
  official check's `club` verdict decides (`lib/access.js matchClubBlock`).
- Offline, the cached clubs decide, for a schedule game only: a typed home team
  may be spelled otherwise than VolleyManager's. "No club at all" is certain
  offline too.
- A blocked official game shows a red banner, and confirming refuses with the
  reason. Test matches are never blocked.

**Sync:**
- The three codes are cloud blocks (`CLOUD_BLOCK_CODES`): the match carries
  `cloudBlock` and `CloudBlockNotice` says why it does not sync. The match stays
  safe on the device.
- They are also live-state refusals: the scoreboard stops pushing that match's
  live score for a while.

**Manager (OpenVolley console, admins):**
- A **Clubs** tab: the switch (switching on asks first), the clubs with their
  teams and scorer count, and the club editor with a search over the
  VolleyManager team names. A team of another club is shown but cannot be
  picked.
- **Accounts:** club chips and a "Clubs" editor per account.
- **Invites:** a club picker for new codes.
- The OpenBeach console shows none of it.

## 6. Tests

- `backend/tests/clubs.e2e.test.js` covers:
  - every write path (`/api/db` insert, upsert, update; `/api/match/restore`);
  - the rule off and on, admins, test and beach matches, stored matches;
  - the official check, `/api/me`, invites, the admin endpoints, the audit.
- `backend/tests/migration018.pg.test.js` covers:
  - 018 runs twice;
  - the guard's SQLSTATEs, the cascades, the app role.
- `frontend/src/lib/__tests__/access.test.js` covers `clubVerdict`,
  `matchClubBlock` and `accessChanged`.
- `frontend/src/components/__tests__/ManageClubs.test.jsx` covers:
  - the Clubs tab (switch, editor, team picker, team taken);
  - an account's clubs;
  - an invite's club.
