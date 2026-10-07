# OpenVolley and OpenBeach: one login, separate roles (phase S1, as built)

Plan: `~/ov-ops/openbeach-separation-tournaments-PLAN.md`, sections 1.2 and 1.3, phase S1. Owner decisions D1 (one login per email, per-app membership and roles) and D2 (only the global admin administers both apps in v1).

Sections 1 to 7 are the backend part (S1). Section 8 is phase S2: brand-aware mail, `app` on the auth calls and the OpenBeach manager. The OpenBeach app changes (in-app sign-up removed, "Create account" to manager-beach, role UI from `apps.beach`, the subdomain renames of plan 2.2) live in the openbeach repository and are not part of this repository.

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

**Membership rules** (`lib/accounts.js`): a member of an app has a membership row of it, or a role of it, or is the global admin. An account with **no membership row at all** counts as indoor: a sign-up without `app` (every OpenVolley client) records none, and an older backend may create accounts after 012 ran. Since S2 a sign-up with `app` records that app (`joined_via = 'signup'`). Adding the first membership of another app to such an account writes its `indoor` row first, so joining OpenBeach never ends an indoor membership.

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

Audit `app`: given explicitly for invites, roles and joins; an entry about a match (`match_id`) takes the match's sport. The email-link entries of `lib/auth.js` (`account.email_confirmed`, `account.password_reset_requested`, `account.password_reset`) take the account's memberships: OpenBeach only gives `beach`, both apps give the request's `app`, anything else indoor. Any other entry is indoor (`NULL`).

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

## 8. Phase S2: the brand (as built)

| Piece | What |
|---|---|
| `backend/lib/mailer.js` | `MAIL_BRANDS` (OpenVolley `indoor`, OpenBeach `beach`) and `mailApp()` (allowlist: `'beach'`, anything else indoor). `renderMail(kind, lang, { link, app })`: OpenBeach's name in subject, text, signature and footer; the reset and password-changed mails add "This changes the password of your account for OpenVolley and OpenBeach" (en/de/fr/it). OpenVolley's mails are unchanged byte for byte. `send()` takes `app` and uses the brand's sender. Env `MAIL_FROM_BEACH` (default `OpenBeach <address of MAIL_FROM>`) and `MANAGER_URL_BEACH` (default `https://manager-beach.openvolley.app`); a set but unusable value turns all account mails off, as `MANAGER_URL` does. Budgets and inbox caps are shared. |
| `backend/lib/auth.js` | `sign-up`, `reset-password`, `reset-password/confirm`, `resend-confirmation` take `app`. The link host comes from the mailer's brand table, never from the client (`redirectTo` stays ignored). A sign-up with `app` writes its membership in the same transaction (when `auth.app_memberships` exists); without `app`, nothing (indoor, as before). `confirm-email` ignores `app`. `app` is never an authorisation. |
| `backend/lib/cors.js` | `https://manager-beach.openvolley.app` listed explicitly (the `*.openvolley.app` rule already covered it). |
| Frontend | `src/managerBrand.js` (two brands, `ManagerBrandProvider`, `useManagerBrand`), `src/managerRoot.jsx` (`renderManager(app)`), `src/manager-beach-main.jsx`, `manager-beach.html`, `brand/beach/` (logo B2). `AuthProvider app="beach"` sends `app` on sign-up, reset and resend; the reset page sends it on confirm. `lib/access.js` `BEACH_ROLES`, `accessForApp(access, 'beach')`. The console's panels take `app` / `sport`: `?app=beach` lists, beach invite codes (`sport: 'beach'`), beach roles, `?sport=beach` saved teams without the offline cache. `ManagerApp`: OpenBeach texts (`managerBeach.*`, five locales), "Join OpenBeach" for a signed-in account that is not a member (`GET /api/me`, `POST /api/account/join`), the beach app link. Without a provider (OpenVolley's manager and the main app's console) the brand is OpenVolley's, whose lists ask `?app=indoor` (S2 review: OpenBeach's members, codes and audit stay out of it; new codes send `sport: 'indoor'`). |
| Build and deploy | `scripts/build-subdomains.js` entry `manager-beach` (`dist-manager-beach`, its icons and manifest). Pages project `openbeach-manager` and the CNAME `manager-beach`: `docs/manager-site-deploy.md`, "OpenBeach's manager" (created by the owner). |

Deploy order: the S2 backend image first (it only adds), then the `openbeach-manager` Pages project and its domain. The OpenBeach app's "Create account" should point at `https://manager-beach.openvolley.app/#signup` only once that site is up.

Tests: `backend/tests/mailer.test.js` ("brands"), `emailAuth.e2e.test.js` (OpenBeach mails end to end, membership at sign-up, an unknown `app`), `cors.test.js`; `frontend/src/__tests__/ManagerBeach.test.jsx`, `buildSubdomains.test.js` (manager-beach), `lib/__tests__/accountApi.test.js` (per-app calls).
