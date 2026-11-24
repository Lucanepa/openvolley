-- 053_global_quota.sql: the size of each Global cloud copy and its PIN lock (db/046, lib/globalMatches.js)
--
-- Audit 2026-11-23: anyone could add cloud copies (anonymous, a fresh random
-- key each time) until the database volume, which also holds the official
-- match records, was full (SEC-01); and a leaked backup code's PIN (4 to 8
-- digits) could be guessed without a limit (SEC-30). lib/globalMatches.js now
--   * keeps the whole table under a ceiling (bytes and rows, counted from
--     stored_bytes) and each network (IPv6 /64, /56, /48) under a daily budget
--     (in memory: the privacy policy keeps IP addresses out of the database),
--     answering 507 / 429 beyond them;
--   * counts wrong PINs per copy (pin_failures, pin_failed_at; the count
--     starts over after a day without one) and, every 10 of them, locks the
--     copy (locked_until: 15 minutes, doubled each time up to a day) for the
--     networks that guessed; the right PIN from any other network still works.
--
--   stored_bytes   what the row holds: the bundle, the summary and the PDF
--                  (NULL: a row from before this file; the backend then
--                  counts pg_column_size of the columns)
--   pin_failures   wrong PINs since the count started over
--   pin_failed_at  the last wrong PIN
--   locked_until   the end of the current lock (NULL or past: none)
--
-- Nullable columns without a default: no table rewrite, a short lock only
-- (lock_timeout 5 s). The old backend keeps working (it never names them).
-- roles.sql needs nothing new: ov_app's grants cover new columns, and the
-- ov_read view (rebuilt by apply-roles.sh after every migration) shows
-- stored_bytes and locked_until, not pin_* (its secret-name rule). No
-- function, so current_definitions.sql is unchanged. Idempotent; one
-- transaction (scripts/migrate.mjs). By hand:
--   docker exec -i ov-postgres psql -X -U ov_owner -d openvolley -v ON_ERROR_STOP=1 < db/053_global_quota.sql
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.global_matches
  ADD COLUMN IF NOT EXISTS stored_bytes  bigint      CONSTRAINT global_matches_stored_bytes_check CHECK (stored_bytes IS NULL OR stored_bytes >= 0),
  ADD COLUMN IF NOT EXISTS pin_failures  integer     CONSTRAINT global_matches_pin_failures_check CHECK (pin_failures IS NULL OR pin_failures >= 0),
  ADD COLUMN IF NOT EXISTS pin_failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_until  timestamptz;

COMMENT ON COLUMN public.global_matches.stored_bytes IS 'Bytes of bundle, summary and PDF as saved (db/053; NULL before it): the table''s ceiling in lib/globalMatches.js.';
COMMENT ON COLUMN public.global_matches.pin_failures IS 'Wrong PINs since the count started over (a day without one) (db/053).';
COMMENT ON COLUMN public.global_matches.locked_until IS 'The copy is locked for the networks that guessed its PIN until then (db/053, lib/globalMatches.js).';

COMMIT;
