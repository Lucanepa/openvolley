# Deploying scorer accounts (db/007) to production

Owner checklist for the `feat/scorer-accounts` branch: approved scorers, one
cloud match per official game, server-locked closing with admin reopen, the
admin console, invite codes, the audit log and saved teams. Background:
`docs/scorer-accounts-spec.md` and `backend/README.md`.

What changes on the server:

| Piece | Change |
|---|---|
| Database | `backend/db/007_scorer_accounts.sql` (new tables, columns, triggers, one unique index). It is additive and idempotent, runs in one transaction, and **does not change the roles of existing accounts**. |
| `roles.sql` | **Unchanged.** Run it again after 007 anyway, as with every migration (it grants `ov_app` the new tables and sequences). |
| Backend image | New build: the new routes (`/api/admin/*`, `/api/saved-teams*`, `/api/account/redeem-invite`, `/api/match/official-check`), the new write rules. `/api/verify-reopen-password` is gone. |
| Env vars | **None new.** `REOPEN_PASSWORD_HASH` is no longer read: delete it from `/opt/openvolley/.env` when convenient (leaving it does no harm). On Cloudflare Pages, delete `VITE_REOPEN_PASSWORD_HASH` if it is set. |
| Kit | `deploy/compose.yaml` no longer passes `REOPEN_PASSWORD_HASH`: rsync the kit as in "Updating" of `deploy/RUNBOOK-hetzner.md`. |
| Frontend | Pages rebuild (the app must ship with the backend: the old app still calls the removed reopen-password route). |

Respect the deploy freeze (`RUNBOOK-hetzner.md`, Friday 17:00 to Sunday
23:59): do all of this on a weekday, with no match running. The steps below
use the hosts of the runbook (`lenovo$` = lenovoserver, `hetzner#` = the VM).

## 1. Before: backup and a dry look

```bash
hetzner# cd /opt/openvolley
hetzner# systemctl start openvolley-backup.service && journalctl -u openvolley-backup -n 20 --no-pager   # fresh dump, check it says OK
hetzner# grep ^OV_BACKEND_IMAGE= .env | tee -a DEPLOYED.log                                           # the tag to roll back to
```

Who is admin today (007 keeps these roles as they are):

```bash
hetzner# docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -c \
  "SELECT u.email, p.roles FROM public.profiles p JOIN auth.users u ON u.id = p.user_id ORDER BY u.email"
```

Optional preview of the official-game duplicates 007 will exempt (it never
fails on them; it reports each one with a `NOTICE`):

```bash
hetzner# docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -c "
  SELECT game_n, sport_type, count(*) AS matches, array_agg(external_id ORDER BY created_at) AS external_ids
    FROM public.matches
   WHERE test IS NOT TRUE AND game_n > 0
   GROUP BY game_n, sport_type,
     date_part('year', coalesce(scheduled_at, created_at) AT TIME ZONE 'Europe/Zurich')::int
       - CASE WHEN date_part('month', coalesce(scheduled_at, created_at) AT TIME ZONE 'Europe/Zurich') < 7 THEN 1 ELSE 0 END
  HAVING count(*) > 1"
```

## 2. Build and ship the backend image

```bash
lenovo$ cd ~/repos/openvolley && git switch <the merged branch> && git pull
lenovo$ escoresheet/deploy/build-image.sh --ship hetzner        # prints the NEW tag
```

Kit (compose.yaml changed):

```bash
lenovo$ rsync -rlt --chmod=D750,F640 --exclude=.env escoresheet/deploy/ hetzner:/opt/openvolley/   # RUNBOOK step 4; never .env
lenovo$ ssh hetzner 'chmod 750 /opt/openvolley/*.sh && chmod 644 /opt/openvolley/cloudflared/config.yml /opt/openvolley/pkgs/Caddyfile'
hetzner# cd /opt/openvolley && docker compose config -q
```

## 3. Migration 007, then roles.sql

Run it as `ov_owner` with `ON_ERROR_STOP`, and **read the NOTICE lines**
(duplicates exempted, or "profiles.roles is not text[]"):

```bash
lenovo$ ssh hetzner 'cd /opt/openvolley && docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -v ON_ERROR_STOP=1' \
          < escoresheet/backend/db/007_scorer_accounts.sql
lenovo$ ssh hetzner /opt/openvolley/apply-roles.sh < escoresheet/backend/db/roles.sql   # "ok: ov_app logs in and sees N matches"
```

007 also marks every non-test match that is already `approved` or `final` as
closed (`closed_at`), so they are read-only from now on; an admin reopens one
in the console when needed.

Do the same on the dev database.

## 4. Switch the backend

Right after step 3 (an old backend on the new schema refuses edits of closed
matches with a bare 400 and has no admin reopen):

```bash
hetzner# cd /opt/openvolley
hetzner# sed -i 's|^OV_BACKEND_IMAGE=.*|OV_BACKEND_IMAGE=openvolley-backend:<NEW>|' .env
hetzner# sed -i '/^REOPEN_PASSWORD_HASH=/d' .env                                         # optional clean-up
hetzner# env | grep -E '^(OV_|TUNNEL_TOKEN)=' ; docker compose config --images | grep backend   # nothing exported; shows <NEW>
hetzner# docker compose up -d && docker compose ps
hetzner# docker compose exec ov-backend node -e 'fetch("http://127.0.0.1:8080/health").then(async r=>console.log(r.status, await r.text()))'
hetzner# echo "$(date -u +%FT%TZ) deployed openvolley-backend:<NEW> (db/007)" >> DEPLOYED.log
```

## 5. Frontend

Merge to the branch Cloudflare Pages builds from and let it rebuild
`app.openvolley.app` (and the other subdomain projects). Remove
`VITE_REOPEN_PASSWORD_HASH` from the Pages environment variables if it is
there. Tablets with the installed app pick up the new build on their next
online start (service worker); until then they cannot reopen a closed match.

## 6. You as admin

- **Keeping it:** 007 does not touch `profiles.roles`, so the existing admin
  account stays admin and the existing scorer stays scorer.
- **Becoming admin** (if your account is not admin yet, or after creating a
  new account): roles are only written by SQL, the admin API or an invite
  code. As `ov_owner`:

  ```bash
  hetzner# docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -v ON_ERROR_STOP=1 -c "
    UPDATE public.profiles
       SET roles = (SELECT array_agg(DISTINCT r) FROM unnest(coalesce(roles, '{}') || '{admin,super_admin,scorer}'::text[]) AS r)
     WHERE user_id = (SELECT id FROM auth.users WHERE lower(email) = lower('<your-email>'))
     RETURNING user_id, roles"
  ```

  `UPDATE 0` means the account has no profile row yet. Then insert one (no
  `ON CONFLICT`: the production table may lack a unique index on `user_id`):

  ```bash
  hetzner# docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -v ON_ERROR_STOP=1 -c "
    INSERT INTO public.profiles (user_id, roles)
    SELECT id, '{admin,super_admin,scorer}'::text[] FROM auth.users u
     WHERE lower(u.email) = lower('<your-email>')
       AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = u.id)
    RETURNING user_id, roles"
  ```

  `super_admin` can only be given in SQL; it
  protects your account (only a super admin may change a super admin's
  roles, and nobody can remove their own `admin`). A role granted in SQL
  applies within 30 seconds (the backend caches roles); then reload the app.
- **Everyone else** who signs up from now on is **pending**: approve them in
  the console (Admin > Accounts) or give their club an invite code (Admin >
  Invite codes; the code is shown once).

## 7. Smoke checklist (right after the deploy)

1. `curl -s https://backend.openvolley.app/health | jq .db` is `"ok"`.
2. Schema is in place:
   ```bash
   hetzner# docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -c "
     SELECT (SELECT count(*) FROM pg_indexes WHERE indexname = 'matches_official_game_uidx') AS official_index,
            (SELECT count(*) FROM pg_trigger WHERE tgname IN ('matches_guard','sets_closed_guard','events_closed_guard','match_live_state_closed_guard')) AS lock_triggers,
            (SELECT count(*) FROM public.matches WHERE closed_at IS NOT NULL) AS closed_matches"
   ```
   Expect `1`, `4`, and the number of approved/final real matches.
3. `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://backend.openvolley.app/api/verify-reopen-password` prints `404`.
4. Sign in as admin in the app: the user menu shows **Admin** and **Saved
   teams**; Admin > Accounts lists the accounts; Closed matches lists the
   backfilled matches; Official games shows the coming VolleyManager games;
   Audit log opens.
5. Create an invite code (role scorer, max uses 1, short expiry). In a private
   window sign up a throwaway account: it shows "pending approval"; a test
   match works; creating an official match says it stays on the device.
   Redeem the code: the account becomes scorer and the match syncs. Then
   revoke the code (and delete the throwaway account in its profile).
6. Saved teams: create a competition and a team with two players; in
   MatchSetup of a test match, "Load saved team" fills the roster.
7. Livescore (`livescore.openvolley.app`) still lists live matches.
8. Audit log shows the `invite.create`, `invite.redeem` and `invite.revoke`
   entries from step 5.

## Rollback

- **Backend:** put the previous tag from `DEPLOYED.log` back into
  `OV_BACKEND_IMAGE` and `docker compose up -d ov-backend` (RUNBOOK
  "Rollback"). The 007 schema can stay: the old backend runs on it, but edits
  of closed matches are refused (400 with SQLSTATE `OVC01`) and the old
  reopen password no longer unlocks them on the server.
- **Lift the lock without restoring** (emergency, keeps all data):
  ```sql
  DROP TRIGGER IF EXISTS matches_guard ON public.matches;
  DROP TRIGGER IF EXISTS sets_closed_guard ON public.sets;
  DROP TRIGGER IF EXISTS events_closed_guard ON public.events;
  DROP TRIGGER IF EXISTS match_live_state_closed_guard ON public.match_live_state;
  ```
  Re-running 007 puts them back.
- **Full undo:** restore the dump from step 1 ("Restore the database" in the
  runbook). Accounts, invites and saved teams created after the deploy are
  lost.
