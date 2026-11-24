-- 012_app_memberships.sql: OpenVolley (indoor) and OpenBeach (beach) keep one
-- login per email but separate memberships and roles
-- (~/ov-ops/openbeach-separation-tournaments-PLAN.md, section 1.2, phase S1).
--
-- Run as ov_owner after 011 (restore.sh runs every db/NNN_*.sql with
-- NNN >= 003 in numeric order), then roles.sql. Idempotent. One transaction.
-- Safe under the running 2.2.0 backend: new table, new columns with constant
-- defaults (no table rewrite), one new trigger; no existing value changes.
--
-- 1. auth.app_memberships: which app an account has joined. Not on the /api/db
--    allowlist (and in the auth schema), so only server code reaches it.
--    Backfill: every account without any membership becomes an indoor member.
--    Nobody gets 'beach' automatically. lib/accounts.js also counts an
--    account with no membership row at all as indoor (one created by an older
--    backend after this migration ran), and a role of an app as membership.
-- 2. invite_codes.sport: a code grants its role in one sport ('beach' codes
--    grant beach:<role>). `role` keeps its CHECK: the role stays plain.
-- 3. audit_log.app: NULL = indoor (every existing row), 'beach' for beach
--    entries. The close entry of db/007's trigger and the void entry of
--    db/011's trigger name the match's sport.
-- 4. matches.sport_type cannot change after insert (indoor <-> beach). NULL
--    and 'indoor' both count as indoor, as in db/007's official-game index.
--    SQLSTATE OVS01 -> lib/pgQuery.js answers 409 OV_SPORT_LOCKED.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. Memberships ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth.app_memberships (
  user_id     uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  app         text        NOT NULL CHECK (app IN ('indoor', 'beach')),
  joined_at   timestamptz NOT NULL DEFAULT now(),
  joined_via  text        NOT NULL DEFAULT 'join'
                          CHECK (joined_via IN ('backfill', 'signup', 'join', 'invite', 'admin')),
  PRIMARY KEY (user_id, app)
);
CREATE INDEX IF NOT EXISTS app_memberships_app_idx ON auth.app_memberships (app, user_id);

-- Accounts with no membership at all are indoor members (a re-run never adds
-- 'indoor' to an account that joined only OpenBeach).
INSERT INTO auth.app_memberships (user_id, app, joined_at, joined_via)
SELECT u.id, 'indoor', coalesce((to_jsonb(u) ->> 'created_at')::timestamptz, now()), 'backfill'
  FROM auth.users u
 WHERE NOT EXISTS (SELECT 1 FROM auth.app_memberships m WHERE m.user_id = u.id)
ON CONFLICT DO NOTHING;

-- 2. Invite codes per sport -------------------------------------------------------
ALTER TABLE public.invite_codes ADD COLUMN IF NOT EXISTS sport text NOT NULL DEFAULT 'indoor';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'invite_codes_sport_check' AND conrelid = 'public.invite_codes'::regclass) THEN
    ALTER TABLE public.invite_codes ADD CONSTRAINT invite_codes_sport_check CHECK (sport IN ('indoor', 'beach'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS invite_codes_sport_created_idx ON public.invite_codes (sport, created_at DESC);

-- 3. Audit entries per app ----------------------------------------------------------
ALTER TABLE public.audit_log ADD COLUMN IF NOT EXISTS app text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'audit_log_app_check' AND conrelid = 'public.audit_log'::regclass) THEN
    ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_app_check CHECK (app IS NULL OR app IN ('indoor', 'beach'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS audit_log_app_id_idx ON public.audit_log (app, id DESC);

-- db/007's close entry, now with the match's app (NULL = indoor, as before)
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

-- db/011's void entry (match.approval_void), now with the match's app too.
-- The same function as in 011 but for the app column; 011 runs first (and
-- is in production), so its trigger already points at this function.
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

-- 4. The sport of a match is fixed ----------------------------------------------------
-- Without it an indoor scorer could create an indoor match and flip it to
-- beach (or the reverse), past the per-sport role checks of lib/pgQuery.js.
CREATE OR REPLACE FUNCTION public.ov_matches_sport_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.sport_type IS NOT DISTINCT FROM 'beach') IS DISTINCT FROM (OLD.sport_type IS NOT DISTINCT FROM 'beach') THEN
    RAISE EXCEPTION 'the sport of a match cannot change' USING ERRCODE = 'OVS01';
  END IF;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'matches' AND column_name = 'sport_type') THEN
    DROP TRIGGER IF EXISTS matches_sport_lock ON public.matches;
    CREATE TRIGGER matches_sport_lock
      BEFORE UPDATE OF sport_type ON public.matches
      FOR EACH ROW EXECUTE FUNCTION public.ov_matches_sport_lock();
  ELSE
    RAISE NOTICE '012: public.matches has no sport_type column; no sport lock';
  END IF;
END $$;

-- Grants: roles.sql (run next) gives ov_app exactly this on the new auth
-- table; this covers running 012 after roles.sql. (invite_codes / audit_log
-- keep their table grants: new columns need nothing.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_app') THEN
    GRANT USAGE ON SCHEMA auth TO ov_app;
    GRANT SELECT, INSERT, DELETE ON auth.app_memberships TO ov_app;
  END IF;
END $$;

COMMIT;
