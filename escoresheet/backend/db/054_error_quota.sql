-- 054_error_quota.sql: error groups that only reports without a session fed
-- (lib/errorTracker.js, lib/errorAlerts.js; audit SEC-02, SEC-33).
--
-- POST /api/errors takes reports from anyone, signed in or not. The tracker
-- now limits the new groups a report may open (per address, in total, per
-- account), caps the stored volume (OV_ERRORS_MAX_BYTES) and purges groups
-- without events after 180 days whatever their status. This file adds the
-- one column those need:
--
--   error_groups.anonymous  true while every event of the group came from a
--                           report without a verified session (a server
--                           error or a signed-in report sets it false for
--                           good). The digest (lib/errorAlerts.js) gives
--                           these groups a smaller share and lists them last.
--
-- A constant default: no table rewrite (PostgreSQL 11+), only a short lock
-- for the catalog change, which waits at most 5 s for the backend's writes
-- (lock_timeout; run it again if it times out). Groups stored before this
-- file count as signed in (false), as they were treated so far. No index: the
-- digest reads the few due groups by error_groups_alert_idx.
--
-- Safe while the old backend serves (it never names the column; its inserts
-- take the default). Idempotent; one transaction (scripts/migrate.mjs). By hand:
--   docker exec -i ov-postgres psql -X -U ov_owner -d openvolley -v ON_ERROR_STOP=1 < db/054_error_quota.sql
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.error_groups ADD COLUMN IF NOT EXISTS anonymous boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.error_groups.anonymous IS 'True while only reports without a verified session fed the group (db/054): a smaller share of the digests (lib/errorAlerts.js).';

COMMIT;
