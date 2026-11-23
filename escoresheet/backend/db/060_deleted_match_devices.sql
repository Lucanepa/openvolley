-- 060_deleted_match_devices.sql: the devices that scored a match, kept with
-- the record of its deletion, so the app that holds the match still hears
-- that it was deleted (2611 review, SR-1).
--
-- db/056 (PERM-17) kept the accounts that could write a match when it was
-- deleted (deleted_matches.owners: its creator and editors) and server.js
-- matchState answers "deleted" (OV_MATCH_DELETED) to them and to admins only;
-- anyone else hears "unknown" (OV_MATCH_UNKNOWN), as of a match never
-- stored. But the app reads "unknown" as "the server lost it" and sends the
-- match again (frontend useSyncQueue resyncMatch), and the device that holds
-- the match's sent jobs is not always its creator's or an editor's account:
-- another scorer may sign in on the club tablet that scored it (the app
-- allows that on purpose), and once the creator's account is deleted the
-- list is empty. A match an admin deleted then came back as that scorer's.
--
-- deleted_matches.devices text[] NULL: the installation ids (frontend
-- utils/deviceId.js, a random uuid per installation, never a person) of the
-- devices that scored the match when it was deleted: its active scoring
-- device (db/019 match_scorer_devices) and the devices that made its event
-- revisions (db/015 event_revisions.device_id), at most 20. matchState also
-- answers "deleted" to a request that names one of them (the `device` body
-- field the apps send with every /api/db write and, from now on, with
-- /api/match/known). NULL: deleted before this file (the owners rule alone).
-- The ids are already stored with the match (019, 015); this keeps them as
-- long as the record of its deletion.
--
-- Safe on a live database: one nullable column without a default (a catalog
-- change), and the trigger function of db/056 replaced (CREATE OR REPLACE
-- takes no lock writes wait for). Idempotent; one transaction
-- (scripts/migrate.mjs). current_definitions.sql carries the new body. By hand:
--   docker exec -i ov-postgres psql -X -U ov_owner -d openvolley -v ON_ERROR_STOP=1 < db/060_deleted_match_devices.sql
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.deleted_matches ADD COLUMN IF NOT EXISTS devices text[];
COMMENT ON COLUMN public.deleted_matches.devices IS
  'The installation ids of the devices that scored the match when it was deleted: its scoring device (db/019) and the devices of its event revisions (db/015), at most 20 (db/060). POST /api/match/known and the /api/db update say "deleted" to a request that names one. NULL: deleted before db/060.';

CREATE OR REPLACE FUNCTION public.ov_matches_deleted_owners()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.external_id IS NOT NULL THEN
    INSERT INTO public.deleted_matches (external_id, owners, devices)
    VALUES (OLD.external_id, ARRAY(
      SELECT DISTINCT o.user_id FROM (
        SELECT OLD.created_by AS user_id
        UNION ALL
        SELECT e.user_id FROM public.match_editors e WHERE e.match_id = OLD.id
      ) o WHERE o.user_id IS NOT NULL ORDER BY o.user_id), ARRAY(
      SELECT d.device_id FROM (
        SELECT lower(s.device_id) AS device_id FROM public.match_scorer_devices s WHERE s.match_id = OLD.id
        UNION
        SELECT lower(r.device_id) FROM public.event_revisions r WHERE r.match_id = OLD.id AND r.device_id IS NOT NULL
      ) d WHERE d.device_id <> '' ORDER BY d.device_id LIMIT 20))
    ON CONFLICT (external_id) DO UPDATE SET owners = EXCLUDED.owners, devices = EXCLUDED.devices, deleted_at = now();
  END IF;
  RETURN OLD;
END
$$;

COMMIT;
