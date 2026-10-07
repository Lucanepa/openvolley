# Deploying the event history and the activity log (db/015, db/016)

Owner checklist for the `feat/activity-log` branch. Background:
`docs/activity-log-spec.md`.

| Piece | Change |
|---|---|
| Database | `backend/db/015_event_revisions.sql` (events gain `voided_at`, `voided_by`, `void_reason` and `rev`, plus the `event_revisions` table and two triggers; `ov_match_children_guard()` is redefined to let an account deletion clear `voided_by` / `actor_id` on a closed match). `backend/db/016_activity_log.sql` (the `activity_log` table and its delete-with-the-match trigger). Both are additive and idempotent, and each runs in one transaction. |
| `roles.sql` | **Changed:** revokes UPDATE on `event_revisions` and `activity_log` from `ov_app`, which makes them append-only. Run it **after** 015 and 016. |
| Backend image | New build with the new routes: `POST /api/match/event-revisions`, `POST/GET /api/activity`, `GET/DELETE /api/admin/activity`, `GET /api/admin/activity/export` and `GET /api/admin/matches/:id/revisions`. It also has the daily activity purge and the extended account deletion. |
| Env vars | None. |
| Clients | Web (Pages), desktop and Android builds of 2.4.0. **Old clients keep working:** every new column is nullable or has a default, and no old route changed. Old clients simply never send revisions or activity. |
| Desktop | `tauri-plugin-log` is a new crate (Cargo.lock updated). It writes `desktop.log` into `<data dir>/OpenVolley/logs`. |

Respect the deploy freeze (`RUNBOOK-hetzner.md`). The order matters:
**migrations → roles.sql → backend image → clients.** If a client arrives
first, it sees 404 on the new routes, parks those jobs as "failed" and
retries them hourly. Nothing is lost.

## 1. Before

```bash
hetzner# cd /opt/openvolley
hetzner# systemctl start openvolley-backup.service && journalctl -u openvolley-backup -n 20 --no-pager
hetzner# grep ^OV_BACKEND_IMAGE= .env | tee -a DEPLOYED.log
```

## 2. Migrations 015 and 016, then roles.sql

```bash
lenovo$ ssh hetzner 'cd /opt/openvolley && docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -v ON_ERROR_STOP=1' \
          < escoresheet/backend/db/015_event_revisions.sql
lenovo$ ssh hetzner 'cd /opt/openvolley && docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -v ON_ERROR_STOP=1' \
          < escoresheet/backend/db/016_activity_log.sql
lenovo$ ssh hetzner /opt/openvolley/apply-roles.sh < escoresheet/backend/db/roles.sql
```

Check: `ov_app` may insert into both tables but not update them.

```bash
hetzner# docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -tAc \
  "SELECT t, has_table_privilege('ov_app', t, 'INSERT'), has_table_privilege('ov_app', t, 'UPDATE') FROM unnest(ARRAY['public.event_revisions','public.activity_log']) t"
# public.event_revisions|t|f
# public.activity_log|t|f
```

The `ALTER TABLE events ADD COLUMN rev integer NOT NULL DEFAULT 0` is a
metadata-only change on Postgres 11 and later, so it does not rewrite the table.

## 3. Backend image, then the clients

Build and roll out the backend as in `RUNBOOK-hetzner.md` "Updating". Then
publish the 2.4.0 clients.

Smoke test, signed in as the admin, on a test-free official match:

1. Score two points and undo one.
2. In the console's Matches tab, open "Corrections". It lists the undo,
   with reason "Undo", the device and the time.
3. Open "Activity" on the same match. It lists the points, the undo and
   the uploads.
4. `GET /api/db events` of the match no longer returns the undone point.
   Restoring the match by PIN on another device does not replay it.

## 4. Rollback

The previous backend image ignores the new columns and tables, so rolling
back the image is enough. If the new data must also go:

```sql
BEGIN;
DROP TABLE IF EXISTS public.activity_log;
DROP TRIGGER IF EXISTS matches_delete_activity ON public.matches;
DROP FUNCTION IF EXISTS public.ov_matches_delete_activity();
DROP TRIGGER IF EXISTS events_apply_void ON public.events;
DROP FUNCTION IF EXISTS public.ov_events_apply_void();
DROP TABLE IF EXISTS public.event_revisions;
-- voided events become live again: only if you really want that
ALTER TABLE public.events DROP COLUMN IF EXISTS voided_at, DROP COLUMN IF EXISTS voided_by,
  DROP COLUMN IF EXISTS void_reason, DROP COLUMN IF EXISTS rev;
COMMIT;
```

`ov_match_children_guard()` keeps its 015 body, which only adds the
account-deletion exception, so it is safe to leave in place.

## 5. Not tested in a real match yet

Undo, decision change, forfeit reversal, reopen set and manual adjustments
now write the event history. Run them on a tablet before release, and check
in the activity log that the reasons are right.
