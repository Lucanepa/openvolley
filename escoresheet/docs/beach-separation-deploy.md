# Deploying the OpenBeach separation and tournaments (S1, S2, T1, T2)

Owner checklist for the `feat/beach-separation` branch. It covers four
phases of `~/ov-ops/openbeach-separation-tournaments-PLAN.md`:

- S1: one login, separate roles per app (db/012)
- S2: the OpenBeach brand (mails, manager-beach)
- T1: the tournament core (db/013, db/014)
- T2: the Excel/CSV import

Owner decisions D1 to D9 (2026-10-07) apply. Background:
`docs/app-separation-spec.md`, `docs/beach-tournaments-spec.md` and
`docs/manager-site-deploy.md` ("OpenBeach's manager").

Respect the deploy freeze in `deploy/RUNBOOK-hetzner.md` (Friday 17:00 to
Sunday 23:59). Deploy on a weekday when no match is running. Hosts follow the
runbook: `lenovo$` is lenovoserver and `hetzner#` is the VM.

## What changes

| Piece | Change |
|---|---|
| Database | `db/012_app_memberships.sql`, `db/013_beach_official_index.sql`, `db/014_beach_tournaments.sql`, then `roles.sql`. All of them are idempotent, run in one transaction each, and are safe while the 2.2.0 backend runs. `db/007` changed too, but only its duplicate scan on a re-run. **Do not re-run 007.** |
| Backend image | A new build. It needs 012 (`audit_log.app`, `auth.app_memberships`). Without 014, `/api/beach/*` answers 503. |
| Env vars | **None required.** `MAIL_FROM_BEACH` and `MANAGER_URL_BEACH` are optional (see step 4). |
| Kit | `deploy/compose.yaml` passes the two optional variables. Rsync the kit. |
| Frontend | A new Cloudflare Pages project, `openbeach-manager`, with the CNAME `manager-beach`. The existing `openvolley-manager` and `openvolley-app` rebuild from `main` as usual. |
| OpenBeach app | Lives in the openbeach repo and is **not part of this branch**. That work: in-app sign-up removed, "Create account" sends people to `https://manager-beach.openvolley.app/#signup`, `app: 'beach'` sent on reset and resend, the role UI reads `apps.beach`, and the subdomain renames of plan 2.2. |

## 0. First, the admin account (plan section 0, decision D3)

The only admin in production is still `admin@openbeach.app`, and that
domain is not registered. Before you deploy, give `admin` and `super_admin`
to an account whose mailbox you control. Use the SQL in
`docs/scorer-accounts-deploy.md`, section 6. Then remove the roles from
`admin@openbeach.app`, or delete that account. In v1 only the global admin
administers both consoles (D2).

## 1. Before: a backup and the current tag

```bash
hetzner# cd /opt/openvolley
hetzner# systemctl start openvolley-backup.service && journalctl -u openvolley-backup -n 20 --no-pager   # fresh dump, says OK
hetzner# grep ^OV_BACKEND_IMAGE= .env | tee -a DEPLOYED.log                                           # the tag to roll back to
```

If `feat/account-approval` is merged first, its `db/011` runs before 012.
Nothing in 012 to 014 depends on it, and 012 also runs without it.

## 2. Build and ship the image, then rsync the kit

```bash
lenovo$ cd ~/repos/openvolley && git switch main && git pull     # after the merge
lenovo$ escoresheet/deploy/build-image.sh --ship hetzner           # prints the NEW tag
lenovo$ rsync -rlt --chmod=D750,F640 --exclude=.env escoresheet/deploy/ hetzner:/opt/openvolley/   # never .env
lenovo$ ssh hetzner 'chmod 750 /opt/openvolley/*.sh && chmod 644 /opt/openvolley/cloudflared/config.yml /opt/openvolley/pkgs/Caddyfile'
hetzner# cd /opt/openvolley && docker compose config -q
```

## 3. Migrations 012, 013 and 014, then roles.sql

Run them as `ov_owner`, in this order, and read the NOTICE lines:

```bash
lenovo$ for f in 012_app_memberships 013_beach_official_index 014_beach_tournaments; do
          ssh hetzner 'cd /opt/openvolley && docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -v ON_ERROR_STOP=1' \
            < escoresheet/backend/db/$f.sql || break
        done
lenovo$ ssh hetzner /opt/openvolley/apply-roles.sh < escoresheet/backend/db/roles.sql   # "ok: ov_app logs in and sees N matches"
```

What they do:

- **012** makes every existing account an OpenVolley (indoor) member. Every
  existing role stays an indoor role, and **nobody gets a beach role**.
- **012** also adds `invite_codes.sport` and `audit_log.app`.
- **012** adds a trigger that refuses any change of a match's `sport_type`
  between beach and indoor (409 `OV_SPORT_LOCKED`).
- **013** takes beach matches out of the per-season official-game index.
  Beach game numbers restart with every tournament.
- **014** adds the tournament tables and the nullable column
  `matches.tournament_match_id`.

Run the same steps on the dev database.

Check:

```bash
hetzner# docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -c "
  SELECT (SELECT count(*) FROM auth.app_memberships WHERE app = 'indoor') AS indoor_members,
         (SELECT count(*) FROM auth.users) AS accounts,
         (SELECT pg_get_expr(indpred, indrelid) LIKE '%beach%' FROM pg_index WHERE indexrelid = 'public.matches_official_game_uidx'::regclass) AS index_without_beach,
         to_regclass('public.beach_tmatches') AS tournament_tables"
```

Expect `indoor_members` = `accounts`, `t`, and `beach_tmatches`.

## 4. Switch the backend

```bash
hetzner# cd /opt/openvolley
hetzner# sed -i 's|^OV_BACKEND_IMAGE=.*|OV_BACKEND_IMAGE=openvolley-backend:<NEW>|' .env
hetzner# env | grep -E '^(OV_|TUNNEL_TOKEN)=' ; docker compose config --images | grep backend   # nothing exported; shows <NEW>
hetzner# docker compose up -d && docker compose ps
hetzner# docker compose exec ov-backend node -e 'fetch("http://127.0.0.1:8080/health").then(async r=>console.log(r.status, await r.text()))'
hetzner# echo "$(date -u +%FT%TZ) deployed openvolley-backend:<NEW> (db/012-014, OpenBeach separation + tournaments)" >> DEPLOYED.log
```

Env: you do not need to set anything. With the production `MANAGER_URL`
(`https://manager.openvolley.app`), the OpenBeach mails go out as
`OpenBeach <address of MAIL_FROM>` and link to
`https://manager-beach.openvolley.app`.

If you want them spelled out in `/opt/openvolley/.env`, add:

```
MAIL_FROM_BEACH='OpenBeach <noreply@openvolley.app>'
MANAGER_URL_BEACH=https://manager-beach.openvolley.app
```

**On a dev or staging backend with its own `MANAGER_URL`, set both.**
Otherwise a startup warning says `MANAGER_URL_BEACH is not set`. Read
`deploy/env.example` first: a value that is set but unusable turns all
account mails off.

## 5. The OpenBeach manager: Pages project and CNAME (you create both)

In Cloudflare: Workers & Pages -> Create -> Pages -> Connect to Git, then
choose the `openvolley` repository.

| Setting | Value |
|---|---|
| Project name | `openbeach-manager` |
| Production branch | `main` |
| Preview branches | Custom: `dev` only |
| Framework preset | None |
| Root directory | `escoresheet/frontend` |
| Build command | `npm ci && node scripts/build-subdomains.js manager-beach` |
| Build output directory | `dist-manager-beach` |
| Environment variables (Production and Preview) | `VITE_BACKEND_URL` = `https://backend.openvolley.app` |
| Custom domain | `manager-beach.openvolley.app` |

When you set the custom domain, Cloudflare adds the proxied record
`CNAME manager-beach -> openbeach-manager.pages.dev` to the
`openvolley.app` zone.

- **CORS and CSP:** nothing to change. The backend already trusts
  `https://manager-beach.openvolley.app`.
- **Preview builds:** for `https://dev.openbeach-manager.pages.dev`, add that
  origin to `PUBLIC_ORIGINS` on the VM, as for the other previews.

Only once this site is up: release the OpenBeach app build whose "Create
account" opens `manager-beach.openvolley.app/#signup`.

## 6. Beach roles (S3, decision D1)

After the deploy nobody holds a beach role, except you as global admin.

**Who should get one.** Two read-only queries, as `ov_owner`:

```sql
-- Beach candidates: accounts that own beach matches, beach competitions or beach pairs
SELECT u.email, p.roles,
       (SELECT array_agg(m.app ORDER BY m.app) FROM auth.app_memberships m WHERE m.user_id = u.id) AS apps,
       (SELECT count(*) FROM public.matches x WHERE x.created_by = u.id AND x.sport_type = 'beach') AS beach_matches,
       (SELECT count(*) FROM public.competitions c WHERE c.created_by = u.id AND c.sport = 'beach') AS beach_competitions,
       (SELECT count(*) FROM public.competition_teams t JOIN public.competitions c ON c.id = t.competition_id
         WHERE t.created_by = u.id AND c.sport = 'beach') AS beach_teams
  FROM auth.users u LEFT JOIN public.profiles p ON p.user_id = u.id
 WHERE EXISTS (SELECT 1 FROM public.matches x WHERE x.created_by = u.id AND x.sport_type = 'beach')
    OR EXISTS (SELECT 1 FROM public.competitions c WHERE c.created_by = u.id AND c.sport = 'beach')
    OR EXISTS (SELECT 1 FROM public.competition_teams t JOIN public.competitions c ON c.id = t.competition_id
                WHERE t.created_by = u.id AND c.sport = 'beach')
 ORDER BY u.email;

-- Legacy scorers: `scorer` with no invite redemption and no role change in the audit
-- (the Supabase-era default). Keep or remove each one in OpenVolley's console.
SELECT u.email, p.roles, u.created_at, u.last_sign_in_at
  FROM auth.users u JOIN public.profiles p ON p.user_id = u.id
 WHERE 'scorer' = ANY (p.roles)
   AND NOT EXISTS (SELECT 1 FROM public.invite_redemptions r WHERE r.user_id = u.id)
   AND NOT EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = 'account.roles' AND a.target_user_id = u.id)
 ORDER BY u.created_at;
```

**How to grant one.** These two ways are audit-logged:

- **A beach invite code.** In manager-beach, open Invite codes -> New invite
  code. Choose the role: Scorer, Referee or Competition manager. Each code
  grants one beach role. For tournament volunteers, a code with about 30
  uses that expires in 3 days works well.
- **Join, then approve.** The person signs in at `manager-beach.openvolley.app`
  with their existing password and clicks **Join OpenBeach**. They then show
  up under Accounts -> Pending in the beach console, and you give them the
  role there.

The beach console lists only OpenBeach members. Use the SQL fallback below
only for an account that cannot do either. It is **not audit-logged**:

```sql
BEGIN;
INSERT INTO auth.app_memberships (user_id, app, joined_via)
SELECT u.id, a.app, 'admin'
  FROM auth.users u CROSS JOIN (VALUES ('indoor'), ('beach')) AS a(app)
 WHERE lower(u.email) = lower('<email>')
   AND (a.app = 'beach' OR NOT EXISTS (SELECT 1 FROM auth.app_memberships m WHERE m.user_id = u.id))
ON CONFLICT DO NOTHING;
UPDATE public.profiles
   SET roles = (SELECT array_agg(DISTINCT r) FROM unnest(coalesce(roles, '{}') || '{beach:scorer}'::text[]) AS r)
 WHERE user_id = (SELECT id FROM auth.users WHERE lower(email) = lower('<email>'))
RETURNING user_id, roles;
COMMIT;
```

The fallback adds the `indoor` row only when the account has no membership
at all. Such an account counts as indoor, and this keeps it indoor.

A role granted in SQL applies within 30 seconds, because the backend caches
roles.

## 7. Smoke checklist

1. `curl -s https://backend.openvolley.app/health | jq .db` prints `"ok"`.
2. **OpenVolley is unchanged.** An indoor scorer scores and syncs an official
   indoor match from the 2.2 app. `manager.openvolley.app`:
   - shows the same tabs as before
   - lists no beach codes under Invite codes
   - shows its usual entries in the audit log
3. **manager-beach as admin.**
   - Open `https://manager-beach.openvolley.app`. You see the OpenBeach logo
     and "Manage OpenBeach", and
     `curl -sI https://manager-beach.openvolley.app | grep -i x-robots-tag`
     prints `noindex, nofollow`.
   - Sign in as the admin. Five tabs appear: Accounts, Invite codes, Audit
     log, Saved teams, Tournaments.
   - Create a beach code with the role Competition manager, 1 use.
4. **A new account through the beach code.** In a private window, sign up
   with a throwaway address at `manager-beach.openvolley.app/#signup`.
   - The confirmation mail comes from `OpenBeach <noreply@openvolley.app>`.
   - Its link opens `manager-beach.openvolley.app/#confirm?token=…`.
   - Redeem the code: the account gets the Saved teams and Tournaments tabs.
   - The account is not listed in OpenVolley's Accounts.
5. **A small tournament with that account.**
   - Create the tournament, add a draw with 4 typed pairs, then use "Draw the
     bracket".
   - Enter one result, then delete the tournament.
   - The beach audit log shows the `tournament.*` entries.
6. **An indoor-only account is shut out.** On manager-beach it gets "Join
   OpenBeach", and `GET /api/beach/tournaments` answers 403.
7. **Clean up.** Revoke the code and delete the throwaway account.

## Rollback

- **Backend.** First revoke the open beach invite codes. The 2.2.0 backend
  ignores `invite_codes.sport` and would redeem a beach code as the plain
  indoor role. As `ov_owner`, run the query below and keep its output, so you
  can recreate the codes later:

  ```sql
  UPDATE public.invite_codes SET revoked_at = now()
   WHERE sport = 'beach' AND revoked_at IS NULL
  RETURNING id, label, role, max_uses, uses;
  ```

  Then put the previous tag from `DEPLOYED.log` back in `OV_BACKEND_IMAGE` and
  run `docker compose up -d ov-backend`.

  The 012, 013 and 014 schema can stay; the old backend runs on it. What the
  old backend does on it:
  - The tournament tables are unused.
  - Beach roles and memberships stay stored, and they count again when the
    new image returns.
  - Its friendly pre-check may name a same-season beach game claim. The
    database itself still accepts the match.
- **manager-beach.** Pause or delete the `openbeach-manager` Pages project.
  Nothing else depends on it.
- **Full undo.** Restore the dump from step 1. Anything created after the
  deploy is lost: accounts, codes and tournaments.

## Not in this deploy

| Not built yet | Plan phase |
|---|---|
| Court tablets that claim a match, with results flowing back from a closed scored match | T3. Needs OpenBeach 2.0.0 Phase 1 |
| The public pages and court views on livescore-beach | T4. The data endpoint `GET /api/public/beach/t/:slug` is already live |
| The Swiss Volley import | T5. Needs action A1 |
| The MyBeach seed-list parser | Needs action A2 |
| Pool formats | Later |

The double-elimination goldens (`backend/tests/fixtures/beach-de/`) have not
yet been compared with the official Swiss Volley templates (action A3). Do
that before the first official tournament.
