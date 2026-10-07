-- 011_account_approvals.sql: the 1st referee, the 2nd referee and the scorer
-- approve a match result with their account and a personal approval PIN,
-- next to the drawn signatures (docs/account-approval-spec.md section 1).
--
-- Run as ov_owner after 010 (restore.sh runs every db/NNN_*.sql with
-- NNN >= 003 in numeric order), then roles.sql. Idempotent. One transaction.
-- Safe under the running backend: new tables, new triggers and new functions
-- only; no existing row or column changes.
--
--   auth.approval_pins     one personal PIN per account: HMAC-SHA256 with a key
--                          derived from OV_PIN_SECRET (never in the database)
--                          and a per-row salt, plus the failure counter and
--                          lockout (lib/approvalPin.js, lib/approvals.js)
--   public.match_approvals one row per approval; append-only (revocation is
--                          the only change), frozen with the match once it is
--                          closed, voided when the match is reopened or a
--                          team's name changes after the end
--
-- SQLSTATE OVA01 (approval is immutable) -> lib/pgQuery.js 409 OV_APPROVAL_IMMUTABLE

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. Approval PINs ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth.approval_pins (
  user_id          uuid        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  key_id           smallint    NOT NULL DEFAULT 1 CHECK (key_id BETWEEN 1 AND 1000),
  salt             bytea       NOT NULL CHECK (octet_length(salt) = 16),
  mac              bytea       NOT NULL CHECK (octet_length(mac) = 32),
  set_at           timestamptz NOT NULL DEFAULT now(),
  failed_attempts  integer     NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),  -- rolling: a right PIN keeps it, 30 days without a failure restart it
  last_failed_at   timestamptz,
  locked_until     timestamptz,
  disabled_at      timestamptz,          -- too many failures: only a new PIN (password) clears it
  last_used_at     timestamptz
);

-- 2. Approvals ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.match_approvals (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id        uuid        NOT NULL REFERENCES public.matches (id) ON DELETE CASCADE,
  slot            text        NOT NULL CHECK (slot IN ('referee1', 'referee2', 'scorer')),
  user_id         uuid        REFERENCES auth.users (id) ON DELETE SET NULL,   -- the official
  display_name    text        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  approved_at     timestamptz NOT NULL DEFAULT now(),
  requested_by    uuid        REFERENCES auth.users (id) ON DELETE SET NULL,   -- the session that sent it
  ip_hash         bytea       CHECK (ip_hash IS NULL OR octet_length(ip_hash) = 32),
  device_hash     bytea       CHECK (device_hash IS NULL OR octet_length(device_hash) = 32),
  match_status    text        NOT NULL,                                       -- matches.status at approval
  result_key      text        NOT NULL CHECK (length(result_key) <= 400),     -- canonical result
  result_hash     bytea       NOT NULL CHECK (octet_length(result_hash) = 32),-- sha256(result_key)
  revoked_at      timestamptz,
  revoked_by      uuid        REFERENCES auth.users (id) ON DELETE SET NULL,
  revoked_reason  text        CHECK (revoked_reason IN ('undo', 'match_reopened', 'result_changed')),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
-- One active approval per slot, one active slot per account (per match)
CREATE UNIQUE INDEX IF NOT EXISTS match_approvals_slot_uidx ON public.match_approvals (match_id, slot) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS match_approvals_user_uidx ON public.match_approvals (match_id, user_id) WHERE revoked_at IS NULL AND user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS match_approvals_user_idx ON public.match_approvals (user_id);
CREATE INDEX IF NOT EXISTS match_approvals_match_idx ON public.match_approvals (match_id, approved_at DESC);

-- 3. Approvals are append-only ------------------------------------------------------
-- An UPDATE may only revoke a row once (revoked_at / revoked_by /
-- revoked_reason from NULL) and set user_id / requested_by / revoked_by to
-- NULL (the ON DELETE SET NULL of a deleted account). Only a bug reaches the
-- exception.
CREATE OR REPLACE FUNCTION public.ov_match_approvals_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  movable text[] := ARRAY['user_id', 'requested_by', 'revoked_at', 'revoked_by', 'revoked_reason'];
BEGIN
  IF (to_jsonb(NEW) - movable) IS DISTINCT FROM (to_jsonb(OLD) - movable)
     OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL)
     OR (NEW.requested_by IS DISTINCT FROM OLD.requested_by AND NEW.requested_by IS NOT NULL) THEN
    RAISE EXCEPTION 'approval is immutable' USING ERRCODE = 'OVA01';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    -- revoked already: only the revoker may be forgotten
    IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
       OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason
       OR (NEW.revoked_by IS DISTINCT FROM OLD.revoked_by AND NEW.revoked_by IS NOT NULL) THEN
      RAISE EXCEPTION 'approval is immutable' USING ERRCODE = 'OVA01';
    END IF;
  ELSIF NEW.revoked_at IS NULL AND NEW.revoked_by IS NOT NULL THEN
    -- a revoker without a revocation
    RAISE EXCEPTION 'approval is immutable' USING ERRCODE = 'OVA01';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS match_approvals_immutable ON public.match_approvals;
CREATE TRIGGER match_approvals_immutable
  BEFORE UPDATE ON public.match_approvals
  FOR EACH ROW EXECUTE FUNCTION public.ov_match_approvals_immutable();

-- 4. A closed match has frozen approvals (007's function, SQLSTATE OVC01) --------
-- Except the ON DELETE SET NULL of a deleted account (the official, the
-- requester or the revoker): the row stays as a club record, as
-- matches.created_by does, and deleting the account must not fail. The UPDATE
-- trigger therefore skips updates that only null those columns.
DROP TRIGGER IF EXISTS match_approvals_closed_guard ON public.match_approvals;
CREATE TRIGGER match_approvals_closed_guard
  BEFORE INSERT OR DELETE ON public.match_approvals
  FOR EACH ROW EXECUTE FUNCTION public.ov_match_children_guard();
DROP TRIGGER IF EXISTS match_approvals_closed_guard_update ON public.match_approvals;
CREATE TRIGGER match_approvals_closed_guard_update
  BEFORE UPDATE ON public.match_approvals
  FOR EACH ROW
  WHEN ((to_jsonb(NEW) - ARRAY['user_id', 'requested_by', 'revoked_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['user_id', 'requested_by', 'revoked_by'])
        OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL)
        OR (NEW.requested_by IS DISTINCT FROM OLD.requested_by AND NEW.requested_by IS NOT NULL)
        OR (NEW.revoked_by IS DISTINCT FROM OLD.revoked_by AND NEW.revoked_by IS NOT NULL))
  EXECUTE FUNCTION public.ov_match_children_guard();

-- 5. Reopening a match, or renaming a team of it, voids its approvals -------------
-- The admin reopen (closed_at -> NULL) and every status change out of
-- ended / approved / final into another status (the scorer's "Reopen last
-- set" puts it back to live through /api/db): reason match_reopened.
-- ended -> approved -> final (the close) keeps them.
-- An approval binds the finished sets (result_key), not who played: a change
-- of the home or the away team's name after the end (swapped teams flip the
-- winner on the sheet) voids them too: reason result_changed.
-- One audit row per voiding statement.
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
    INSERT INTO public.audit_log (actor_id, action, match_id, details)
    VALUES (actor, 'match.approval_void', NEW.id,
            jsonb_build_object('count', n, 'reason', why, 'external_id', NEW.external_id, 'game_n', NEW.game_n));
  END IF;
  RETURN NULL;
END
$$;

-- home_team / away_team are json (no equality operator): compare the names,
-- trimmed and lower-cased, so a rewrite of the same team keeps the approvals.
DROP TRIGGER IF EXISTS matches_void_approvals ON public.matches;
CREATE TRIGGER matches_void_approvals
  AFTER UPDATE ON public.matches
  FOR EACH ROW
  WHEN ((OLD.closed_at IS NOT NULL AND NEW.closed_at IS NULL)
        OR (OLD.status IN ('ended', 'approved', 'final') AND NEW.status IS DISTINCT FROM OLD.status
            AND NEW.status NOT IN ('ended', 'approved', 'final'))
        OR (OLD.status IN ('ended', 'approved', 'final')
            AND (lower(btrim(OLD.home_team ->> 'name')) IS DISTINCT FROM lower(btrim(NEW.home_team ->> 'name'))
                 OR lower(btrim(OLD.away_team ->> 'name')) IS DISTINCT FROM lower(btrim(NEW.away_team ->> 'name')))))
  EXECUTE FUNCTION public.ov_matches_void_approvals();

-- 6. Grants -------------------------------------------------------------------------
-- roles.sql (run next) grants the same; this covers running 011 after it.
-- The app role needs DML on both tables (no TRUNCATE, no TRIGGER).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_app') THEN
    GRANT USAGE ON SCHEMA auth TO ov_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth.approval_pins TO ov_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.match_approvals TO ov_app;
  END IF;
END $$;

COMMIT;
