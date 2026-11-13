-- current_definitions.sql: the current body of every function that more
-- than one numbered migration defines. current as of: db/033
--
-- scripts/migrate.mjs applies it after the numbered files on every run, in
-- one transaction. A numbered file never runs twice through the runner, but
-- one run by hand (psql), or again with --rerun, puts back the body IT had:
-- db/007 the closed-match guard without 015's exception for an account
-- deletion (a scorer who undid a point in a closed match could no longer be
-- deleted) and the close audit without 012's app; db/011 the approval void
-- without the app; db/015 the born-voided trigger that takes another match's
-- revisions (032); db/030 the manager-role functions without 031's SECURITY
-- DEFINER (every write of club_managers / team_managers failed with 42501).
-- The next runner run puts the bodies below back; lib/schemaVersion.js (the
-- backend at start, scripts/check-schema.mjs) reports a body that differs.
-- The numbered files stay as they are: a fresh database still builds from
-- them, and their recorded checksums stay valid.
--
-- Rules (scripts/migrate.mjs refuses to run when one is broken):
--   * a new migration that redefines (CREATE OR REPLACE / ALTER) a function or
--     trigger an earlier file defines copies its new definition here as well,
--     and raises "current as of" above to its own number;
--   * only functions and triggers of the numbered files; nothing new is
--     created here, and nothing that takes a lock writes would wait for
--     (CREATE OR REPLACE FUNCTION takes none).
-- Bodies are byte for byte those of the files named (lib/schemaVersion.js
-- compares the stored body with them). Ownership and grants stay as they are
-- (CREATE OR REPLACE keeps both; roles.sql revokes EXECUTE from ov_app).
--
-- By hand, after a migration was run by hand:
--   docker exec -i ov-postgres psql -X -U ov_owner -d openvolley -v ON_ERROR_STOP=1 < db/current_definitions.sql
BEGIN;

-- db/007, as db/015 left it: an account deletion may clear voided_by / actor_id of a closed match's rows
CREATE OR REPLACE FUNCTION public.ov_match_children_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF coalesce(current_setting('ov.allow_closed', true), '') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - ARRAY['voided_by', 'actor_id']) = (to_jsonb(OLD) - ARRAY['voided_by', 'actor_id'])
     AND (to_jsonb(NEW) ->> 'voided_by') IS NULL AND (to_jsonb(NEW) ->> 'actor_id') IS NULL
     AND ((to_jsonb(OLD) ->> 'voided_by') IS NOT NULL OR (to_jsonb(OLD) ->> 'actor_id') IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.matches m
              WHERE m.closed_at IS NOT NULL
                AND m.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.match_id END,
                             CASE WHEN TG_OP <> 'DELETE' THEN NEW.match_id END)) THEN
    RAISE EXCEPTION 'match is closed' USING ERRCODE = 'OVC01';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

-- db/007, as db/012 left it: the close entry carries the match's app
CREATE OR REPLACE FUNCTION public.ov_matches_close_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.closed_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.closed_at IS NULL) THEN
    INSERT INTO public.audit_log (actor_id, action, match_id, details, app)
    VALUES (NEW.closed_by, 'match.close', NEW.id,
            jsonb_build_object('external_id', NEW.external_id, 'game_n', NEW.game_n, 'status', NEW.status),
            CASE WHEN NEW.sport_type IS NOT DISTINCT FROM 'beach' THEN 'beach' END);
  END IF;
  RETURN NULL;
END
$$;

-- db/011, as db/012 left it: the void entry carries the match's app
CREATE OR REPLACE FUNCTION public.ov_matches_void_approvals()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor_text text := coalesce(current_setting('ov.user_id', true), '');
  actor uuid := CASE WHEN actor_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN actor_text::uuid END;
  reopened boolean := (OLD.closed_at IS NOT NULL AND NEW.closed_at IS NULL)
                      OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('ended', 'approved', 'final'));
  why text := CASE WHEN reopened THEN 'match_reopened' ELSE 'result_changed' END;
  n integer;
BEGIN
  UPDATE public.match_approvals
     SET revoked_at = now(), revoked_reason = why, revoked_by = actor
   WHERE match_id = NEW.id AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    INSERT INTO public.audit_log (actor_id, action, match_id, details, app)
    VALUES (actor, 'match.approval_void', NEW.id,
            jsonb_build_object('count', n, 'reason', why, 'external_id', NEW.external_id, 'game_n', NEW.game_n),
            CASE WHEN NEW.sport_type IS NOT DISTINCT FROM 'beach' THEN 'beach' END);
  END IF;
  RETURN NULL;
END
$$;

-- db/015, as db/032 left it: only a revision of the event's own match makes it born voided
CREATE OR REPLACE FUNCTION public.ov_events_apply_void()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE r record;
BEGIN
  IF NEW.external_id IS NULL OR NEW.match_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT op, client_ts, actor_id, reason INTO r
    FROM public.event_revisions
   WHERE event_external_id = NEW.external_id AND match_id = NEW.match_id AND op IN ('void', 'restore')
   ORDER BY id DESC
   LIMIT 1;
  IF FOUND AND r.op = 'void' THEN
    NEW.voided_at := r.client_ts;
    NEW.voided_by := r.actor_id;
    NEW.void_reason := r.reason;
  END IF;
  RETURN NEW;
END
$$;

-- db/030, with db/031's fixed search_path
CREATE OR REPLACE FUNCTION public.ov_sync_manager_roles(uid uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  want text[] := '{}';
BEGIN
  IF uid IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.club_managers WHERE user_id = uid) THEN want := array_append(want, 'club_manager'); END IF;
  IF EXISTS (SELECT 1 FROM public.team_managers WHERE user_id = uid) THEN want := array_append(want, 'team_manager'); END IF;
  -- the other roles in their order, then the manager roles that apply; written only when it changes
  UPDATE public.profiles p
     SET roles = n.next
    FROM (SELECT p2.ctid AS row_id,
                 (SELECT coalesce(array_agg(r ORDER BY o), '{}')
                    FROM unnest(coalesce(p2.roles, '{}')) WITH ORDINALITY AS x(r, o)
                   WHERE r NOT IN ('club_manager', 'team_manager')) || want AS next
            FROM public.profiles p2 WHERE p2.user_id = uid) n
   WHERE p.ctid = n.row_id AND p.roles IS DISTINCT FROM n.next;
END $$;

-- db/030, with db/031's SECURITY DEFINER and search_path: it calls ov_sync_manager_roles, which ov_app may not execute
CREATE OR REPLACE FUNCTION public.ov_manager_rows_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  club uuid;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM public.ov_sync_manager_roles(NEW.user_id);
    -- a new manager joins the club (of the team)
    IF TG_TABLE_NAME = 'club_managers' THEN
      club := NEW.club_id;
    ELSE
      SELECT ct.club_id INTO club FROM public.club_teams ct WHERE ct.id = NEW.team_id;
    END IF;
    IF club IS NOT NULL THEN
      INSERT INTO public.account_clubs (user_id, club_id, granted_by)
      VALUES (NEW.user_id, club, NEW.added_by)
      ON CONFLICT (user_id, club_id) DO NOTHING;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    PERFORM public.ov_sync_manager_roles(OLD.user_id);
  END IF;
  RETURN NULL;
END $$;

COMMIT;
