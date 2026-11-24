-- 006_matches_updated_at.sql: updated_at follows every write of a match / set
--
-- matches.updated_at (and sets.updated_at) only had DEFAULT now(): no trigger
-- moved it (the restored Supabase schema has one on profiles only), and the
-- backend's /api/db update path did not set it, so a match that was set up,
-- played and closed kept updated_at = created_at. matchRestore orders its
-- candidates by matches.updated_at and the realtime broadcasts carried the
-- stale value.
--
-- A BEFORE UPDATE trigger now sets updated_at = now() on every UPDATE of
-- public.matches, and of public.sets when that table has the column (an
-- upsert that hits an existing row is an UPDATE too). INSERTs keep the column
-- default; lib/pgQuery.js no longer passes a client-sent updated_at for
-- these tables (a stale device clock).
--
-- Not on match_live_state: its updated_at is written by the scorer and the
-- realtime hub orders that table's changes by it (lib/realtimeHub.js).
-- Not on profiles: it keeps its own profiles_updated_at trigger.
--
-- The trigger function is SECURITY INVOKER and only touches NEW; ov_app needs
-- no EXECUTE on it (EXECUTE is checked when a trigger is created, not when
-- it fires; roles.sql revokes function EXECUTE from ov_app).
--
-- Run as ov_owner after 005 (restore.sh runs every db/NNN_*.sql with
-- NNN >= 003 in numeric order), then roles.sql. Idempotent.

CREATE OR REPLACE FUNCTION public.ov_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS matches_touch_updated_at ON public.matches;
CREATE TRIGGER matches_touch_updated_at
  BEFORE UPDATE ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.ov_touch_updated_at();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sets' AND column_name = 'updated_at'
  ) THEN
    DROP TRIGGER IF EXISTS sets_touch_updated_at ON public.sets;
    CREATE TRIGGER sets_touch_updated_at
      BEFORE UPDATE ON public.sets
      FOR EACH ROW EXECUTE FUNCTION public.ov_touch_updated_at();
  END IF;
END $$;
