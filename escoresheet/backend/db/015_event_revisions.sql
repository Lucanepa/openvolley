-- 015_event_revisions.sql: undone, deleted and edited events keep their history.
--
-- Before: an undo deleted the event on the scoring device only; the server
-- never learnt about it, so an undone point that had already been uploaded
-- stayed on the server looking valid. Now the device sends a revision for
-- every undo / delete / edit / restore (POST /api/match/event-revisions,
-- lib/eventRevisions.js) and the server
--   - marks the event voided (voided_at, voided_by, void_reason; never deleted),
--     or applies the edit, and counts it in events.rev,
--   - keeps the revision itself in event_revisions (append-only for the app,
--     db/roles.sql): what the event was before, what it became, who, when,
--     from which device and app version, and why.
-- Views that rebuild a match from its events (restore-by-pin, /api/db reads)
-- leave voided events out. A revision that arrives before its event (the
-- insert was retried after the undo) makes the event "born voided".
--
-- Idempotent. Deploy: 015 and 016, then apply-roles.sh (roles.sql), then the
-- backend image. Old clients keep working: every new column is nullable or
-- has a default and no old route changed.
BEGIN;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS voided_at   timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS void_reason text CHECK (void_reason IS NULL OR length(void_reason) <= 40),
  ADD COLUMN IF NOT EXISTS rev         integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS events_match_live_idx ON public.events (match_id, seq) WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS public.event_revisions (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rev_uid           uuid        NOT NULL UNIQUE,            -- client idempotency
  match_id          uuid        NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  event_external_id text        NOT NULL CHECK (length(event_external_id) <= 200),
  op                text        NOT NULL CHECK (op IN ('void', 'edit', 'restore')),
  reason            text        NOT NULL CHECK (reason IN ('undo', 'delete', 'decision_change', 'manual_adjustment',
                                                           'forfeit_reversal', 'reopen_set', 'roster_reopen', 'other')),
  event_seq         numeric,
  set_index         integer,
  event_type        text        CHECK (event_type IS NULL OR length(event_type) <= 64),
  -- the server row as it was: type, set_index, seq, payload, score_a, score_b (never state_snapshot)
  before            jsonb,
  -- edit / restore: the columns written
  after             jsonb,
  -- false: the event was not on the server (undone before it was uploaded, or not yet)
  applied           boolean     NOT NULL,
  actor_id          uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  device_id         text        CHECK (device_id IS NULL OR length(device_id) <= 64),
  app_version       text        CHECK (app_version IS NULL OR length(app_version) <= 32),
  client_ts         timestamptz NOT NULL,
  at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_revisions_match_idx ON public.event_revisions (match_id, client_ts);
CREATE INDEX IF NOT EXISTS event_revisions_event_idx ON public.event_revisions (event_external_id);

-- Closed matches: frozen like their events (db/007's guard, which the admin
-- reopen and the restore pass with ov.allow_closed). One exception is added
-- here: an account deletion forgets who voided an event / sent a revision
-- (the ON DELETE SET NULL of voided_by / actor_id, and lib/auth.js's explicit
-- detach). An UPDATE that changes nothing but clearing those columns passes.
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

DROP TRIGGER IF EXISTS event_revisions_closed_guard ON public.event_revisions;
CREATE TRIGGER event_revisions_closed_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.event_revisions
  FOR EACH ROW EXECUTE FUNCTION public.ov_match_children_guard();

-- A void that arrived before its event (the insert job was retried after the
-- undo): the event is born voided. A later restore of the same event wins.
CREATE OR REPLACE FUNCTION public.ov_events_apply_void()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE r record;
BEGIN
  IF NEW.external_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT op, client_ts, actor_id, reason INTO r
    FROM public.event_revisions
   WHERE event_external_id = NEW.external_id AND op IN ('void', 'restore')
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
DROP TRIGGER IF EXISTS events_apply_void ON public.events;
CREATE TRIGGER events_apply_void
  BEFORE INSERT ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.ov_events_apply_void();

COMMIT;
