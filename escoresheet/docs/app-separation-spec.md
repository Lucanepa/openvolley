# OpenVolley and OpenBeach: one login, separate roles (phase S1, as built)

Plan: `~/ov-ops/openbeach-separation-tournaments-PLAN.md`, sections 1.2 and 1.3, phase S1. Owner decisions D1 (one login per email, per-app membership and roles) and D2 (only the global admin administers both apps in v1).

This is the backend part only. Brand-aware mail, the second manager build and the OpenBeach app changes are phase S2.

## 1. The rule

The server checks every role against the **sport of the row** being written: the `sport_type` of a match (the payload for an insert, the stored match for an update, the parent match for sets, events and live state), the sport of a saved team's competition, the sport of an invite code, the folder of a scoresheet. It never uses the app the client says it is. Both Android apps send Origin `https://localhost`, so the declared app can only choose branding.

## 2. Roles and flags (`backend/lib/access.js`)

| Role | Sport |
|---|---|
| `scorer`, `referee`, `competition_manager` | indoor (unchanged) |
| `beach:scorer`, `beach:referee`, `beach:competition_manager` | beach |
| `admin`, `super_admin` | both (global admin) |

`accessFromRoles(roles)` keeps its top-level flags (`canScore`, `canManageTeams`, `canReadTeams`, `isPending`) **meaning indoor**, so OpenVolley 2.1/2.2 clients behave as before: a beach-only account is pending for them. It adds `apps.indoor` and `apps.beach` (`{ roles, canScore, canManageTeams, canReadTeams, isPending }`) and a non-enumerable `forSport(sport)`. `API_GRANTABLE_ROLES` gains the three beach roles; `super_admin` stays SQL only.

`frontend/src/lib/access.js` is unchanged in S1: its role lists stay indoor, so the indoor manager console shows and edits indoor roles only (a beach role is kept when an admin changes indoor roles there). The beach manager build (S2) reads `apps.beach` from `GET /api/me`.

## 3. Migration `backend/db/012_app_memberships.sql`

| Object | What |
|---|---|
| `auth.app_memberships(user_id, app, joined_at, joined_via)` | PK `(user_id, app)`, `app IN ('indoor','beach')`, `joined_via IN ('backfill','signup','join','invite','admin')`, cascades with the account. Not on the `/api/db` allowlist. |
| Backfill | Every account without any membership gets `indoor` (`joined_via = 'backfill'`, `joined_at` = account creation). Nobody gets `beach`. A re-run never adds `indoor` to an account that has only `beach`. |
| `invite_codes.sport` | `NOT NULL DEFAULT 'indoor'`, CHECK `indoor|beach`. `role` keeps its plain CHECK. |
| `audit_log.app` | Nullable, CHECK `NULL|indoor|beach`. `NULL` = indoor (every existing row). Index `(app, id DESC)`. The close entry of db/007's trigger now names a beach match's app. |
| `matches_sport_lock` trigger | `BEFORE UPDATE OF sport_type`: beach ↔ not-beach is refused with SQLSTATE `OVS01` (pgQuery answers 409 `OV_SPORT_LOCKED`). `NULL` ↔ `indoor` is not a change. No bypass, also not for the admin. |
| Grants | `ov_app`: `SELECT, INSERT, DELETE` on `auth.app_memberships` (in 012 and in `roles.sql`). |

Idempotent, one transaction, safe under the running 2.2.0 backend. Run after 011 (feat/account-approval) if it is there; nothing depends on it.

**Membership rules** (`lib/accounts.js`): a member of an app has a membership row of it, or a role of it, or is the global admin. An account with **no membership row at all** counts as indoor: sign-up does not record the app yet (S2 adds that), and an older backend may create accounts after 012 ran. Adding the first membership of another app to such an account writes its `indoor` row first, so joining OpenBeach never ends an indoor membership.

## 4. Enforcement points

| Place | Rule |
|---|---|
| `server.js matchOwnerFor` → `pgQuery` `matchOwner.testOnlySports` | The sports the account cannot score in are test-only. Inserts: the payload's `sport_type` (absent = the column default, indoor). Updates/deletes: the stored match. Upserts (also `/api/match/restore`): the merged row, the payload over the stored match, for both `sport_type` and `test`, so `{external_id, test: false}` without `sport_type` cannot make an indoor scorer's beach test match official; a payload that changes the sport hits the lock (409). Sets, events, live state: the parent match. Making a match non-test is checked against the stored match's sport. `matchOwner.testOnly` alone still means every sport (old callers, the same SQL). |
| Official-game friendly checks (`/api/db`, `/api/match/restore`) | Only rows of the sports the caller can score in, so a beach-only scorer never sees who holds an indoor game (pgQuery's 403 comes first). |
| `POST /api/storage/upload` bucket `scoresheets` | First path segment `beach` (NFKC, case-insensitive) needs beach scoring rights, every other path indoor. |
| `POST /api/match/official-check` | The role of `body.sport_type` (absent = indoor). |
| `/api/saved-teams*` | Family check: the right in **some** sport. Writes: `canManageTeams` of the competition's sport (body `sport` for a new competition, the competition of `competition_id` for a new team, the stored row otherwise). An unknown id stays 404. `GET ?sport=beach` needs beach read; `?sport=all` returns the sports the caller may read (the indoor console asks for `all`). |
| Invites | A beach code grants `beach:<role>` and the beach membership. |
| `/api/admin/*` | Global admin only (D2). |

## 5. HTTP API (new and changed)

| Endpoint | Contract |
|---|---|
| `GET /api/me` | Session required. `{ id, roles, isAdmin, isSuperAdmin, canScore, canManageTeams, canReadTeams, isPending, apps: { indoor: {member, roles, canScore, canManageTeams, canReadTeams, isPending}, beach: {…} } }`. Top level = indoor. `isPending` of an app is "no role of that app"; "pending in the beach console" = `member && isPending`. |
| `POST /api/account/join { app }` | Session required. `app` ∈ `indoor|beach`, else 400. `{ app, member: true, already_member }`. Grants no role. Audited once as `account.join` with the app. Reveals nothing about other accounts. This is "Join OpenBeach with your existing password": sign in with the existing password, then join. |
| `POST /api/account/redeem-invite` | Beach code: `{ roles, role_granted: 'beach:scorer', already_had, sport: 'beach' }`. Indoor codes answer as before. |
| `POST /api/admin/invites[?app=]` | `body.sport`, else `?app=`, else indoor. A `body.sport` other than `?app=` is 400. The invite object gains `sport`. |
| `GET /api/admin/invites?app=` | The codes of that sport. Without `?app=`: all (as before). |
| `GET /api/admin/accounts?app=&filter=` | With `?app=`: members of that app; pending = no role of that app. Without: every account, pending = no indoor role (as before). |
| `GET /api/admin/audit?app=` | `beach`: `app = 'beach'`; `indoor`: everything else. Entries gain `app`. Without: all. |
| `GET /api/admin/matches?app=` | By `sport_type`. Rows gain `sport`. Without: all. |
| `POST /api/admin/accounts/:id/roles` | Accepts the beach roles. Adding a role of an app adds its membership. One `account.roles` audit entry per app whose roles changed (`admin` counts as indoor), so an indoor-only change writes exactly the entry it wrote before. |

Errors: `409 OV_SPORT_LOCKED` (a match's sport cannot change), `400 OV_INVALID_REQUEST` for an unknown `app`/`sport`.

Audit `app`: given explicitly for invites, roles and joins; an entry about a match (`match_id`) takes the match's sport; any other entry is indoor (`NULL`).

## 6. Deploy order

1. `db/012_app_memberships.sql` as ov_owner, then `roles.sql` (both idempotent). The running 2.2.0 backend keeps working: new columns have defaults, the trigger only refuses a sport change that no client does.
2. Then the backend image. It needs 012 (`audit_log.app`, `auth.app_memberships`).
3. Rollback: the previous image works on a 012 database, but it is not just the image tag once a beach invite code exists. The 2.2.0 backend ignores `invite_codes.sport`: it redeems a beach code as the plain indoor role (`scorer` / `competition_manager`), and its admin list shows beach codes as indoor codes. So BEFORE switching the image back, revoke the open beach codes (as ov_owner), and keep the output to recreate them after a fix:

   ```sql
   UPDATE public.invite_codes SET revoked_at = now()
    WHERE sport = 'beach' AND revoked_at IS NULL
   RETURNING id, label, role, max_uses, uses;
   ```

   On the old image an indoor scorer can write official beach matches again and a beach-only account has no scoring right (the 2.2.0 behaviour). The `beach:*` roles and memberships stay stored and count again once S1 is redeployed.

## 7. Tests

`backend/tests/access.test.js` (flags per sport), `pgQuery.sportAccess.test.js` (row sport, children, test flag, sport lock, restore), `migration012.pg.test.js` (backfill, re-run, CHECKs, close audit, trigger, app-role grants), `appSeparation.e2e.test.js` (cross-sport denial, scoresheets, official check, `/api/me`, invites per sport, join, `?app=` lists, audit per app). `beach.e2e.test.js` and `scorerAccounts.e2e.test.js` now give their beach accounts beach roles; their indoor parts are unchanged.
