# Deploying approval with an account (db/011) to production

Owner checklist for the `feat/account-approval` branch: the 1st referee, the
2nd referee and the scorer can approve a match result with their account and a
personal approval PIN, next to the drawn signatures. Background:
`docs/account-approval-spec.md` (section 0 lists the review fixes R1 to R9) and
`backend/README.md` ("Approval PINs").

You need three things: migration 011, `roles.sql`, and the new backend image.
Nothing else changes: there are no new environment variables (`OV_PIN_SECRET`
and the SMTP settings are already set) and the deploy kit is unchanged. The
app side ships with the usual Pages build of the merged branch.

Respect the deploy freeze (`deploy/RUNBOOK-hetzner.md`, Friday 17:00 to Sunday
23:59). Do this on a weekday, with no match running. The hosts are the
runbook's (`lenovo$` = lenovoserver, `hetzner#` = the VM).

## 1. Backup and the current tag

```bash
hetzner# cd /opt/openvolley
hetzner# systemctl start openvolley-backup.service && journalctl -u openvolley-backup -n 20 --no-pager   # fresh dump; check it says OK
hetzner# grep ^OV_BACKEND_IMAGE= .env | tee -a DEPLOYED.log                                           # the tag to roll back to
```

## 2. Build and ship the backend image

```bash
lenovo$ cd ~/repos/openvolley && git switch <the merged branch> && git pull
lenovo$ escoresheet/deploy/build-image.sh --ship hetzner        # prints the NEW tag
```

## 3. Migration 011, then roles.sql

011 only adds two tables (`auth.approval_pins`, `public.match_approvals`),
their triggers and one trigger on `public.matches`. It is idempotent, runs in
one transaction, and is safe while the old backend runs. Run it as `ov_owner`:

```bash
lenovo$ ssh hetzner 'cd /opt/openvolley && docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -v ON_ERROR_STOP=1' \
          < escoresheet/backend/db/011_account_approvals.sql
lenovo$ ssh hetzner /opt/openvolley/apply-roles.sh < escoresheet/backend/db/roles.sql   # "ok: ov_app logs in and sees N matches"
```

Check that it is in place (expect `t | t | 1`):

```bash
hetzner# docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -c "
  SELECT to_regclass('auth.approval_pins') IS NOT NULL AS pins,
         to_regclass('public.match_approvals') IS NOT NULL AS approvals,
         (SELECT count(*) FROM pg_trigger WHERE tgname = 'matches_void_approvals') AS void_trigger"
```

Do the same on the dev database.

## 4. Switch the backend image

```bash
hetzner# cd /opt/openvolley
hetzner# sed -i 's|^OV_BACKEND_IMAGE=.*|OV_BACKEND_IMAGE=openvolley-backend:<NEW>|' .env
hetzner# docker compose config --images | grep backend                  # shows <NEW>
hetzner# docker compose up -d && docker compose ps
hetzner# docker compose logs ov-backend --since 2m | grep -E 'OV_PIN_SECRET|\[Mail\]'   # no "approval with an account is off"; "[Mail] account emails on"
hetzner# echo "$(date -u +%FT%TZ) deployed openvolley-backend:<NEW> (db/011)" >> DEPLOYED.log
```

If the log says `approval with an account is off`, `OV_PIN_SECRET` is missing
from `.env`: every approval endpoint then answers 503 and the app only offers
drawn signatures, as before. If it says `account emails off`, approvals still
work, but the officials get no notice emails.

## Rollback

Put the previous tag from `DEPLOYED.log` back into `OV_BACKEND_IMAGE` and run
`docker compose up -d ov-backend`. The 011 tables can stay: the old backend
does not read them, and drawn signatures work as before.
