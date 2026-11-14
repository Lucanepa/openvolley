-- 039_record_integrity.sql: a match that was closed stays an official record,
-- also after an admin reopen; the close is atomic; one set per number.
--
-- Before:
--   * the closed-match guard of sets, events, live state and approvals
--     (db/007, db/015) read matches.closed_at without a row lock, so a child
--     write in flight while the match closed was stored in the closed match;
--   * an admin reopen cleared closed_at and nothing else said the match had
--     been closed: its scorer or an editor could then delete it (with its
--     approvals, revisions, final-mail records and activity) or make it a
--     test match, and the reopen kept no copy of the approved record (the
--     approval blob was nulled, later edits overwrote the rest);
--   * an event inserted while an undo of it was being stored did not see the
--     undo (it stayed pending for good);
--   * two set rows could carry the same set number of a match, and sets and
--     events could have no match;
--   * an account deletion scanned events and the logs without an index.
--
-- Now:
--   1. ov_match_children_guard() reads the match row FOR SHARE: a close and
--      a child write in flight wait for each other, and after the wait the
--      guard sees the close.
--   2. matches.first_closed_at: when the match first closed (server only,
--      kept by the reopen). For such a match a DELETE, test = true and a
--      move to another game number or season are refused (SQLSTATE OVC01,
--      409 OV_MATCH_CLOSED) unless the write is an admin's (ov.admin, set
--      by lib/pgQuery.js for an admin session, or ov.allow_closed).
--   3. public.match_closures: each reopen keeps the record as it was closed
--      (status, approval, final score, set results, sanctions, remarks, ...
--      and the sets), and the next close adds the record as it closed
--      again: an admin sees before and after (GET /api/admin/matches/:id/closures).
--   4. ov_events_apply_void() takes the match row FOR SHARE and the lock
--      lib/eventRevisions.js apply() takes (pg_advisory_xact_lock(15015, the
--      match id)) before it reads the revisions: an insert and a revision of
--      the same match always see each other's commit.
--   5. UNIQUE (match_id, index) on sets, match_id NOT NULL on sets and events.
--      Checked first: when a match has two sets with one number, or a set or
--      event has no match, the file stops (nothing of it is applied) and
--      names them; an admin resolves them, then the file runs again.
--   6. Indexes for the account deletion (the ON DELETE SET NULL columns) and
--      events(match_id).
-- Idempotent; one transaction (scripts/migrate.mjs). Safe while the old
-- backend serves: it does not know first_closed_at (an admin's delete of a
-- once-closed match is refused until the new image runs) and it never writes
-- match_closures (the triggers do).
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 5a. The check before the constraints ---------------------------------------------
DO $$
DECLARE
  dups text;
  n_dups bigint;
  n_sets bigint;
  n_events bigint;
BEGIN
  SELECT count(*), string_agg(label, ', ') FILTER (WHERE rn <= 50) INTO n_dups, dups
    FROM (SELECT coalesce(m.external_id, d.match_id::text) || coalesce(' game ' || m.game_n, '') || ' set ' || d.index
                   || ' (' || d.n || ' rows)' AS label,
                 row_number() OVER (ORDER BY d.match_id, d.index) AS rn
            FROM (SELECT match_id, index, count(*) AS n FROM public.sets
                   WHERE match_id IS NOT NULL AND index IS NOT NULL
                   GROUP BY match_id, index HAVING count(*) > 1) d
            LEFT JOIN public.matches m ON m.id = d.match_id) l;
  SELECT count(*) INTO n_sets FROM public.sets WHERE match_id IS NULL;
  SELECT count(*) INTO n_events FROM public.events WHERE match_id IS NULL;
  IF n_dups > 0 OR n_sets > 0 OR n_events > 0 THEN
    RAISE EXCEPTION 'db/039: % set number(s) with more than one set row, % set(s) and % event(s) without a match; nothing of db/039 was applied',
      n_dups, n_sets, n_events
      USING DETAIL = coalesce('duplicate sets: ' || dups || CASE WHEN n_dups > 50 THEN ' and ' || (n_dups - 50) || ' more' ELSE '' END, 'no duplicate sets'),
            HINT = 'Keep one row per (match_id, index) in public.sets and delete or assign the rows without match_id, then run the migrations again.';
  END IF;
END $$;

-- 5b. One set per number, every set and event in a match ----------------------------
ALTER TABLE public.sets ALTER COLUMN match_id SET NOT NULL;
ALTER TABLE public.events ALTER COLUMN match_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sets_match_index_uidx ON public.sets (match_id, index);
CREATE INDEX IF NOT EXISTS events_match_idx ON public.events (match_id);

-- 6. The account deletion's scans (lib/auth.js eraseAccount, the ON DELETE SET NULL) --
CREATE INDEX IF NOT EXISTS events_voided_by_idx ON public.events (voided_by) WHERE voided_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_revisions_actor_idx ON public.event_revisions (actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON public.audit_log (actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_target_user_idx ON public.audit_log (target_user_id) WHERE target_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS match_approvals_requested_by_idx ON public.match_approvals (requested_by) WHERE requested_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS match_approvals_revoked_by_idx ON public.match_approvals (revoked_by) WHERE revoked_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS activity_log_uploader_idx ON public.activity_log (uploader_id) WHERE uploader_id IS NOT NULL;

-- 1. The closed guard of a match's rows waits for a close in flight ------------------
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
  -- FOR SHARE: a close of the match in flight and this write wait for each
  -- other; the check after it reads the row as the close left it (a new
  -- snapshot per statement).
  PERFORM 1 FROM public.matches m
    WHERE m.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.match_id END,
                   CASE WHEN TG_OP <> 'DELETE' THEN NEW.match_id END)
    FOR SHARE OF m;
  IF EXISTS (SELECT 1 FROM public.matches m
              WHERE m.closed_at IS NOT NULL
                AND m.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.match_id END,
                             CASE WHEN TG_OP <> 'DELETE' THEN NEW.match_id END)) THEN
    RAISE EXCEPTION 'match is closed' USING ERRCODE = 'OVC01';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

-- 4. An arriving event and a revision of its match see each other ------------------
CREATE OR REPLACE FUNCTION public.ov_events_apply_void()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE r record;
BEGIN
  IF NEW.external_id IS NULL OR NEW.match_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- The match row first (as the restore, the revisions and the closed guard
  -- lock it), then the revisions' lock of the match (lib/eventRevisions.js):
  -- a revision stored in flight is read once it committed.
  PERFORM 1 FROM public.matches WHERE id = NEW.match_id FOR SHARE;
  PERFORM pg_advisory_xact_lock(15015, hashtext(NEW.match_id::text));
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

-- 2. Once closed, an official record ---------------------------------------------------
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS first_closed_at timestamptz;
COMMENT ON COLUMN public.matches.first_closed_at IS
  'When the match first closed (db/039): set by the server, kept by an admin reopen. Such a match is deleted, made a test match or moved to another game only by an admin.';
-- The matches closed before this file: their close, else the first close the audit log knows
UPDATE public.matches SET first_closed_at = closed_at
 WHERE first_closed_at IS NULL AND closed_at IS NOT NULL;
UPDATE public.matches m SET first_closed_at = a.first_at
  FROM (SELECT match_id, min(at) AS first_at FROM public.audit_log
         WHERE action = 'match.close' AND match_id IS NOT NULL GROUP BY match_id) a
 WHERE m.id = a.match_id AND m.first_closed_at IS NULL;

-- After matches_guard (BEFORE triggers run by name), which sets closed_at.
CREATE OR REPLACE FUNCTION public.ov_matches_record_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  admin boolean := coalesce(current_setting('ov.allow_closed', true), '') = 'on'
                   OR coalesce(current_setting('ov.admin', true), '') = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.first_closed_at IS NOT NULL AND NOT admin THEN
      RAISE EXCEPTION 'match was closed: only an admin deletes it' USING ERRCODE = 'OVC01';
    END IF;
    RETURN OLD;
  END IF;
  -- first_closed_at is the server's: a client value is ignored
  IF TG_OP = 'INSERT' THEN
    IF NOT admin THEN NEW.first_closed_at := NULL; END IF;
  ELSE
    IF NOT admin OR NEW.first_closed_at IS NULL THEN NEW.first_closed_at := OLD.first_closed_at; END IF;
  END IF;
  IF NEW.first_closed_at IS NULL AND NEW.closed_at IS NOT NULL THEN
    NEW.first_closed_at := NEW.closed_at;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.first_closed_at IS NOT NULL AND NOT admin
     AND ((NEW.test IS TRUE AND OLD.test IS NOT TRUE)
          OR NEW.game_n IS DISTINCT FROM OLD.game_n
          OR NEW.official_season IS DISTINCT FROM OLD.official_season) THEN
    RAISE EXCEPTION 'match was closed: only an admin makes it a test match or moves it to another game' USING ERRCODE = 'OVC01';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS matches_guard_record ON public.matches;
CREATE TRIGGER matches_guard_record
  BEFORE INSERT OR UPDATE OR DELETE ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.ov_matches_record_guard();

-- 3. The record of each close an admin reopened --------------------------------------
CREATE TABLE IF NOT EXISTS public.match_closures (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  match_id        uuid        NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  -- the close that was reopened
  closed_at       timestamptz,
  closed_by       uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  reopened_at     timestamptz NOT NULL DEFAULT now(),
  reopened_by     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  reason          text        CHECK (reason IS NULL OR length(reason) <= 500),
  -- the record as it was closed / as it closed again (NULL: not yet)
  closed_record   jsonb       NOT NULL,
  reclosed_at     timestamptz,
  reclosed_record jsonb
);
CREATE INDEX IF NOT EXISTS match_closures_match_idx ON public.match_closures (match_id, reopened_at);
CREATE INDEX IF NOT EXISTS match_closures_closed_by_idx ON public.match_closures (closed_by) WHERE closed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS match_closures_reopened_by_idx ON public.match_closures (reopened_by) WHERE reopened_by IS NOT NULL;

-- AFTER UPDATE (not OF closed_at: db/007's guard sets it on a close that
-- does not name it): a reopen (closed_at cleared) stores the closed row and its
-- sets; the next close fills in what it closed with. ov.reopen_reason: the
-- admin's reason (lib/accounts.js reopenMatch). No secrets (PINs) are kept.
CREATE OR REPLACE FUNCTION public.ov_matches_closure_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  keys text[] := ARRAY['status', 'approval', 'final_score', 'winner', 'set_results', 'results', 'sanctions',
                       'remarks', 'signatures', 'manual_changes', 'officials', 'coin_toss'];
  actor_text text := coalesce(current_setting('ov.user_id', true), '');
  actor uuid := CASE WHEN actor_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN actor_text::uuid END;
  rec jsonb;
BEGIN
  IF OLD.closed_at IS NOT NULL AND NEW.closed_at IS NULL THEN
    rec := (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(keys) AS k);
  ELSIF OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL THEN
    rec := (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(keys) AS k);
  ELSE
    RETURN NULL;
  END IF;
  rec := rec || jsonb_build_object('sets', (
    SELECT coalesce(jsonb_agg(to_jsonb(s) - ARRAY['id', 'match_id', 'updated_at'] ORDER BY s.index, s.external_id), '[]'::jsonb)
      FROM public.sets s WHERE s.match_id = NEW.id));
  IF NEW.closed_at IS NULL THEN
    INSERT INTO public.match_closures (match_id, closed_at, closed_by, reopened_by, reason, closed_record)
    VALUES (NEW.id, OLD.closed_at, OLD.closed_by, actor,
            left(nullif(current_setting('ov.reopen_reason', true), ''), 500), rec);
  ELSE
    UPDATE public.match_closures SET reclosed_at = NEW.closed_at, reclosed_record = rec
     WHERE match_id = NEW.id AND reclosed_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS matches_closure_record ON public.matches;
CREATE TRIGGER matches_closure_record
  AFTER UPDATE ON public.matches
  FOR EACH ROW WHEN (OLD.closed_at IS DISTINCT FROM NEW.closed_at)
  EXECUTE FUNCTION public.ov_matches_closure_record();

COMMIT;
