# Deploying "scorers score the home games of their club" (db/018)

> **Host moved, 16.10.2026:** production now runs on lenovoserver. The Hetzner VPS belongs to
> the KSC Wiedikon club and must never host OpenVolley again. Run the `hetzner#` steps below on
> lenovoserver with `sudo` (`/opt/openvolley` is root-only there):
> `cd /opt/openvolley && docker compose ...` becomes
> `sudo docker compose --project-directory /opt/openvolley ...`, `ssh hetzner <cmd>` becomes
> `sudo <cmd>`, `build-image.sh --ship hetzner` becomes `--ship local`. Current commands:
> `deploy/RUNBOOK-hetzner.md` ("Updating", "Apply a new db migration").

Owner checklist for `feat/scorer-clubs` (OpenVolley). Design and decisions:
[scorer-clubs-spec.md](scorer-clubs-spec.md).

**Migration number: 018.** Order: **backup → `018_clubs.sql` → `roles.sql`
(through `apply-roles.sh`) → backend image → clients → set up clubs → switch the
rule on.**

The rule is **off** after the migration. Nothing changes for anyone until an
admin switches it on in the manager (Clubs tab). The backend tolerates a
database without 018 (it reads as "no clubs, rule off"), and old clients keep
working while the rule is off. With it on, an old client gets 403
`OV_CLUB_REQUIRED` / `OV_NOT_YOUR_CLUB` / `OV_GAME_NOT_IN_SCHEDULE` from the
sync. It parks the match as failed: the match stays on the device and stops
syncing, without the explanation the new app shows.

| Piece | Change |
|---|---|
| Database | `backend/db/018_clubs.sql`: `clubs`, `club_teams`, `account_clubs`, `club_rule` (one row, off), `invite_codes.club_id`, and the trigger `matches_club_guard`. Additive, idempotent (tested: applied twice on a 017 database), one transaction. |
| `roles.sql` | **No change.** `ov_app`'s grants on all tables of `public` cover the new ones. Run `apply-roles.sh` after 018 as usual. |
| Backend image | `lib/clubs.js`, routes in `lib/manageApi.js`, `/api/me` and the official check in `lib/accounts.js`, the SQLSTATE map in `lib/pgQuery.js`. |
| Env vars | None. |
| Clients | OpenVolley app (match setup verdict, cloud-block texts), manager (Clubs tab, account clubs, invite club). OpenBeach: no change. |

Respect the deploy freeze (`RUNBOOK-hetzner.md`).

## 1. Before

```bash
hetzner# cd /opt/openvolley
hetzner# systemctl start openvolley-backup.service && journalctl -u openvolley-backup -n 20 --no-pager
hetzner# grep ^OV_BACKEND_IMAGE= .env | tee -a DEPLOYED.log
```

## 2. Migration 018, then roles.sql

```bash
lenovo$ ssh hetzner 'cd /opt/openvolley && docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -v ON_ERROR_STOP=1' \
          < escoresheet/backend/db/018_clubs.sql
lenovo$ ssh hetzner /opt/openvolley/apply-roles.sh < escoresheet/backend/db/roles.sql
```

Check:

```bash
hetzner# docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -tAc \
  "SELECT enabled FROM public.club_rule; SELECT count(*) FROM pg_trigger WHERE tgname='matches_club_guard'; SELECT has_table_privilege('ov_app','public.account_clubs','INSERT')"
# f
# 1
# t
```

## 3. Backend image, then the clients

Build and roll out the backend as in `RUNBOOK-hetzner.md` "Updating", then the
app release (web apps and managers from main, desktop and Android as usual).

## 4. Set up the clubs, then switch the rule on

1. Manager → **Clubs** → **New club**: name it and tick its VolleyManager
   teams (search, e.g. "Wiedikon"). A team can be in one club only.
2. Manager → **Accounts** → **Clubs** on each scorer: tick its club(s). New
   scorers can get theirs with an invite code that carries the club
   (**Invites** → New code → Club).
3. When every active scorer has a club: **Clubs** → switch on (it asks first).

To check who would be blocked before switching on:

```bash
hetzner# docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -c \
  "SELECT u.email FROM auth.users u JOIN public.profiles p ON p.user_id = u.id
    WHERE 'scorer' = ANY(p.roles) AND NOT p.roles && ARRAY['admin','super_admin']
      AND NOT EXISTS (SELECT 1 FROM public.account_clubs ac WHERE ac.user_id = u.id)
    ORDER BY u.email"
```

## 5. Rollback

- **Switch the rule off** in the Clubs tab. This is immediate, and nothing else
  changes.
- **Image:** the previous `OV_BACKEND_IMAGE` (last line of `DEPLOYED.log`) back
  into `.env`, then `docker compose up -d`. The old image ignores the new tables.
  The trigger stays; with the rule off it does nothing.
- **Remove the trigger entirely** (only if needed):
  `DROP TRIGGER IF EXISTS matches_club_guard ON public.matches;`
  The tables can stay.
