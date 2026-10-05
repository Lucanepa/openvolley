-- 003_svrz_games_local_time.sql: one-off data fix after porting vm-sync.
--
-- The Supabase Edge Function formatted svrz_games.date (dd/mm/yyyy) and
-- svrz_games.time (HH:MM) from UTC. For a `datetime` carrying Z or an offset
-- that put every stored kick-off 1 h (winter) or 2 h (summer) early, and late
-- games could carry the previous day. lib/vmSync.js now formats in
-- Europe/Zurich; this recomputes those rows from the stored `datetime` the
-- same way.
--
-- Rows whose `datetime` has NO zone designator are left alone: such a value is
-- a Zurich wall-clock time (that is how the frontend's `new Date(datetime)`
-- reads it, and how lib/vmSync.js#parseVmDateTime reads it now), and the Edge
-- Function stored its literal digits, which are already right. Rows whose
-- `datetime` is NULL, '', not ISO 8601 or out of range (2026-02-30T..) are
-- left alone too; a value Postgres cannot cast is skipped, it does not abort
-- the migration.
--
-- Before running, look at what production stores:
--   SELECT datetime FROM public.svrz_games ORDER BY id DESC LIMIT 5;
-- If every value lacks Z/offset, this migration changes no svrz_games row.
--
-- It also closes svrz_sync_log rows the Edge Function left in 'running'
-- (a failure after the log row was inserted never updated it).
--
-- Run as the table owner (ov_owner), once, after the data restore:
--
--   docker exec -i ov-postgres psql -U ov_owner -d openvolley -v ON_ERROR_STOP=1 < db/003_svrz_games_local_time.sql
--
-- Idempotent: re-running changes nothing (rows already in Zurich time are
-- skipped, closed log rows are no longer 'running'). `datetime` itself is not
-- changed.

BEGIN;

-- Every value converted carries a zone, so the session zone cannot matter;
-- pinned anyway so the result never depends on who runs it.
SET LOCAL TimeZone = 'UTC';

-- Cast that yields NULL instead of an error (temporary: gone with the session)
CREATE OR REPLACE FUNCTION pg_temp.ov003_try_timestamptz(t text) RETURNS timestamptz
LANGUAGE plpgsql AS $$
BEGIN
  RETURN t::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;

WITH parsed AS (
  SELECT id,
         (pg_temp.ov003_try_timestamptz(datetime) AT TIME ZONE 'Europe/Zurich') AS local_ts
    FROM public.svrz_games
   -- Same pattern as lib/vmSync.js VM_DATETIME_RE, with the zone designator required
   WHERE datetime ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-](0\d|1[0-4])(:?[0-5]\d)?)$'
)
UPDATE public.svrz_games g
   SET date = to_char(p.local_ts, 'DD/MM/YYYY'),
       "time" = to_char(p.local_ts, 'HH24:MI')
  FROM parsed p
 WHERE g.id = p.id
   AND p.local_ts IS NOT NULL
   AND (g.date, g."time") IS DISTINCT FROM (to_char(p.local_ts, 'DD/MM/YYYY'), to_char(p.local_ts, 'HH24:MI'));

DROP FUNCTION pg_temp.ov003_try_timestamptz(text);

UPDATE public.svrz_sync_log
   SET status = 'failed',
       finished_at = now(),
       message = left(coalesce(nullif(message, '') || ' | ', '') || 'closed by 003: stuck in running (Edge Function failed after start)', 1000)
 WHERE status = 'running'
   AND started_at < now() - interval '1 hour';

COMMIT;
