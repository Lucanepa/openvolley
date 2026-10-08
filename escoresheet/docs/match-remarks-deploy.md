# Deploying the match remarks sync (db/017)

Owner checklist for `feat/remarks-sync` (OpenVolley) and `fix/ob-remarks`
(OpenBeach). Owner decision 2026-10-08: the match remarks (the scoresheet's
REMARKS box, with the automatic "Actual start time: HH:MM" line, the injury,
exceptional substitution and forfeit lines, and the scorer's own text) are
synced to the server in both apps, not kept on the device only.

**Migration number: 017.** main's migrations end at `016_activity_log.sql`.
Order: **backup → `017_match_remarks.sql` → `roles.sql` (through
`apply-roles.sh`) → backend image → clients.**

The migration MUST be on the database before the new clients are out. A new
client sends `remarks` in a match update; a database without the column
answers `400 PGRST204 unknown column "remarks"`, and that remarks job parks
as "failed" (retried hourly, 24 times). Nothing else is lost: the remarks
always travel in a job of their own (also at approval), so the approval,
status and every other match field still reach the server.

| Piece | Change |
|---|---|
| Database | `backend/db/017_match_remarks.sql`: `matches.remarks text` (nullable, no default) and the named CHECK `matches_remarks_length_check` (`length(remarks) <= 8000`, characters), dropped and re-added on every run. Additive, idempotent (tested: applied twice on a 016 database), one transaction. Metadata-only `ADD COLUMN`; the CHECK scan of `matches` is instant (the column is NULL everywhere). |
| `roles.sql` | **No change.** `ov_app` has table-level DML on `public.matches`, which covers the new column. Run `apply-roles.sh` after 017 as usual. |
| Backend image | **No code change is needed for the column:** pgQuery and the restore read the columns from the catalog, and a running backend reloads its catalog only in the background after a request named a column it did not know (that first request is still refused, and until then a backup restore drops `remarks` without an error). So restart or redeploy the backend after 017, which loads the new catalog at start. The new image only carries the tests and the test-database list (`tests/helpers/pgTestDb.js`). `lib/publicColumns.js` is an allowlist: anonymous readers, signed-in non-owners and the live socket never get `remarks` and cannot filter on it. The owner, editors, admins and the game-PIN restore lookup (`/api/match/restore-by-pin`) do. |
| Env vars | None. |
| Clients | OpenVolley and OpenBeach: every committed change of the remarks queues one match update `{ remarks }` (a Dexie hook on `matches`, so every screen is covered); the approval queues the remarks as approved just before its own job and waits for them (a refused remarks job does not hold it); backup restores send the backup's remarks (a backup from an older app has none and leaves the server's alone); restore from the server (game number + PIN) brings them back. The sync console lines show `[N characters]` instead of the text. The activity log keeps the length only, as before. **Old clients keep working**: they never send the column. |
| Self-hosters | Anyone running their own backend runs 017 the same way before updating their clients. LAN relay / venue mode has no database and is not affected. |

Respect the deploy freeze (`RUNBOOK-hetzner.md`).

## 1. Before

```bash
hetzner# cd /opt/openvolley
hetzner# systemctl start openvolley-backup.service && journalctl -u openvolley-backup -n 20 --no-pager
hetzner# grep ^OV_BACKEND_IMAGE= .env | tee -a DEPLOYED.log
```

## 2. Migration 017, then roles.sql

```bash
lenovo$ ssh hetzner 'cd /opt/openvolley && docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -v ON_ERROR_STOP=1' \
          < escoresheet/backend/db/017_match_remarks.sql
lenovo$ ssh hetzner /opt/openvolley/apply-roles.sh < escoresheet/backend/db/roles.sql
```

Check:

```bash
hetzner# docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -tAc \
  "SELECT data_type, has_column_privilege('ov_app','public.matches','remarks','UPDATE') FROM information_schema.columns WHERE table_name='matches' AND column_name='remarks'"
# text|t
hetzner# docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -tAc \
  "SELECT count(*) FROM pg_constraint WHERE conname='matches_remarks_length_check'"
# 1
```

## 3. Backend image, then the clients

Build and roll out the backend as in `RUNBOOK-hetzner.md` "Updating". To
keep the running image instead, restart the backend container after 017 so it
reads the new column at start (see the table above). Then publish the
OpenVolley and OpenBeach clients.

Smoke test, signed in, on a test-free official match in each app:

1. Type a remark in the remarks box, then let a set start late enough for
   the "Actual start time" line (or add one in Corrections).
2. `/api/db select matches remarks` of the match as its owner returns the
   text; the same select without a session (or as another account) returns
   the row without `remarks`.
3. Undo the action that wrote an automatic line: the server text loses the
   line too.
4. Approve: the server row has the remarks as approved. Restore the match by
   game number + PIN on another device: the remarks are back.

## 4. Rollback

Older clients and images ignore the column, so rolling back the image or the
clients is enough. To drop the data too:

```sql
BEGIN;
ALTER TABLE public.matches DROP CONSTRAINT IF EXISTS matches_remarks_length_check;
ALTER TABLE public.matches DROP COLUMN IF EXISTS remarks;
COMMIT;
```

Do not drop the column while new clients are out: their remarks jobs would
then fail (see above).

## 5. Not tested in a real match yet

Unit, Dexie (fake IndexedDB), API end-to-end (real Postgres 17) and
migration tests pass. Not yet run on a tablet: the remarks box, the
automatic lines and the undo of one, a forfeit (OpenBeach coin toss, the
match end default line), the approval, and restore-by-PIN on a second device.

## 6. Privacy text

`docs/legal/data-map.md` lists the new server column. The privacy policy
(`docs/legal/*/privacy.md`, section 7 "What a match contains") does not name
the remarks yet; they can mention a player's injury. Owner to decide on the
wording in the four languages.
