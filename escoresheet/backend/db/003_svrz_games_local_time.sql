-- 003_svrz_games_local_time.sql: one-off data fix after porting vm-sync.
--
-- The Supabase Edge Function formatted svrz_games.date (dd/mm/yyyy) and
-- svrz_games.time (HH:MM) from UTC, so every stored kick-off is 1 h (winter)
-- or 2 h (summer) early, and late games can carry the previous/next day.
-- lib/vmSync.js now formats in Europe/Zurich; this recomputes the existing
-- rows from the stored ISO `datetime` column the same way.
--
-- It also closes svrz_sync_log rows the Edge Function left in 'running'
-- (a failure after the log row was inserted never updated it).
--
-- Run as the table owner (ov_owner), once, after the data restore:
--
--   docker exec -i ov-postgres psql -U ov_owner -d openvolley -v ON_ERROR_STOP=1 < db/003_svrz_games_local_time.sql
--
-- Idempotent: re-running changes nothing (rows already in Zurich time are
-- skipped, closed log rows are no longer 'running'). Rows whose `datetime` is
-- not an ISO timestamp are left alone. A `datetime` without a zone designator
-- is read as UTC, exactly as the Edge Function (Deno on UTC hosts) and
-- lib/vmSync.js#parseVmDateTime read it. `datetime` itself is not changed: the
-- frontend parses it and it was always correct.

BEGIN;

-- Offset-less timestamps are interpreted in the session time zone
SET LOCAL TimeZone = 'UTC';

WITH parsed AS (
  SELECT id,
         (datetime::timestamptz AT TIME ZONE 'Europe/Zurich') AS local_ts
    FROM public.svrz_games
   WHERE datetime ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?$'
)
UPDATE public.svrz_games g
   SET date = to_char(p.local_ts, 'DD/MM/YYYY'),
       "time" = to_char(p.local_ts, 'HH24:MI')
  FROM parsed p
 WHERE g.id = p.id
   AND (g.date, g."time") IS DISTINCT FROM (to_char(p.local_ts, 'DD/MM/YYYY'), to_char(p.local_ts, 'HH24:MI'));

UPDATE public.svrz_sync_log
   SET status = 'failed',
       finished_at = now(),
       message = left(coalesce(nullif(message, '') || ' | ', '') || 'closed by 003: stuck in running (Edge Function failed after start)', 1000)
 WHERE status = 'running'
   AND started_at < now() - interval '1 hour';

COMMIT;
