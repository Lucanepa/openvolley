-- 032_match_id_scoping.sql: a set, an event and an event revision belong to
-- their match by the match row, never by an external_id prefix.
--
-- Before: a set / event id only had to START with its match's external_id
-- plus ':' or '_' (lib/pgQuery.js, lib/eventRevisions.js), so a match whose
-- external_id is a prefix of another match's ids ('match', 'match_<ms>',
-- '<id>:e') counted as their match too; and db/015's insert trigger gave an
-- arriving event the newest void / restore filed under its id in ANY match.
-- An account that may write test matches could so void the points of another
-- match, or hold its next set / event ids so that the match's own uploads and
-- its restore were refused.
-- Now the backend (lib/pgQuery.js childMatchKey) takes an id only under the
-- one match it names: the text before its first ':', or for an id without
-- ':' the older apps' backup form `<match>_set_<n>` / `<match>_event_<n>`.
-- This file:
--   1. ov_events_apply_void(): only a revision of the event's own match makes
--      it born voided,
--   2. the external_id of a match that has sets, events or revisions is fixed
--      (SQLSTATE OVI01, pgQuery: 409 OV_MATCH_ID_LOCKED): their ids name it,
--      and a rename would leave them naming the old one,
--   3. sets and events of a TEST match under another match's id are deleted
--      (held ids, which kept that match's own uploads out); the same rows of
--      an official match are only counted, an admin decides about them,
--   4. an event whose void was set or lifted by another match's revision gets
--      the state its own match's revisions give (the newest void or restore
--      of that match; none: not voided),
--   5. pending revisions (applied = false) filed under a match that the event
--      id does not name are deleted,
--   6. sets and events whose id only the old rule took as their own match's
--      are counted (nothing is changed).
-- Read the NOTICEs: a number above 0 in 3 to 5 means another match's data was
-- tampered with before this fix; they name the matches concerned (at most 50
-- each). Above 0 in 6: an older app's delete of one such event deletes it
-- (no void, no history), and their own match can no longer re-upload them.
--
-- Idempotent, one transaction, safe while the running backend serves (the
-- old backend works with it too). Deploy: this file, then roles.sql, then the
-- backend image; then this file once more (rows written by the old backend
-- in between). 3 deletes rows for good: take a backup first.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- 3 to 5 may touch closed matches (db/007's and db/015's guards)
SELECT set_config('ov.allow_closed', 'on', true);

-- The match external_id a set / event id names, NULL for none
-- (lib/pgQuery.js childMatchKey). For this file only.
CREATE OR REPLACE FUNCTION pg_temp.ov_child_match_key(child text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN child IS NULL OR child = '' THEN NULL
    WHEN strpos(child, ':') > 0 THEN
      CASE WHEN strpos(child, ':') > 1 AND strpos(child, ':') < length(child) THEN left(child, strpos(child, ':') - 1) END
    ELSE substring(child from '^(.+)_(?:set|event)_[^_]+$')
  END
$$;

-- ' (matches <external_id> game <game_n>, ...)' for a NOTICE: at most 50 of
-- them, then how many more; '' for none. For this file only.
CREATE OR REPLACE FUNCTION pg_temp.ov_match_list(exts text[])
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT CASE WHEN count(*) = 0 THEN '' ELSE
           ' (matches ' || string_agg(label, ', ' ORDER BY rn) FILTER (WHERE rn <= 50) ||
           CASE WHEN count(*) > 50 THEN ' and ' || (count(*) - 50) || ' more' ELSE '' END || ')'
         END
    FROM (SELECT x.ext || coalesce(' game ' || m.game_n, '') AS label, row_number() OVER (ORDER BY x.ext) AS rn
            FROM (SELECT DISTINCT e AS ext FROM unnest(exts) AS e WHERE e IS NOT NULL) x
            LEFT JOIN public.matches m ON m.external_id = x.ext) l
$$;

-- 1. A void that arrived before its event (the insert job was retried after
-- the undo): the event is born voided. A later restore of the same event
-- wins. Only the revisions of the event's own match count.
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

-- 2. The external_id of a match with sets, events or revisions is fixed. The
-- children are checked when they are written; a rename afterwards would leave
-- them under ids that name the old external_id, and the match that later
-- takes it would find them held. The apps never rename a match. No bypass,
-- also not for the admin (delete the children first).
CREATE OR REPLACE FUNCTION public.ov_matches_external_id_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sets WHERE match_id = OLD.id)
     OR EXISTS (SELECT 1 FROM public.events WHERE match_id = OLD.id)
     OR EXISTS (SELECT 1 FROM public.event_revisions WHERE match_id = OLD.id) THEN
    RAISE EXCEPTION 'the external_id of a match with sets or events cannot change' USING ERRCODE = 'OVI01';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS matches_external_id_lock ON public.matches;
CREATE TRIGGER matches_external_id_lock
  BEFORE UPDATE OF external_id ON public.matches
  FOR EACH ROW WHEN (OLD.external_id IS DISTINCT FROM NEW.external_id)
  EXECUTE FUNCTION public.ov_matches_external_id_lock();

-- 3. Rows under the id of another (existing) match
DO $$
DECLARE
  n_test bigint := 0;
  n_official bigint;
  k bigint;
  named text[];
  named_test text[] := '{}';
  named_official text[];
BEGIN
  WITH d AS (
    DELETE FROM public.events c USING public.matches m
     WHERE m.id = c.match_id AND m.test IS TRUE
       AND pg_temp.ov_child_match_key(c.external_id) IS DISTINCT FROM m.external_id
       AND EXISTS (SELECT 1 FROM public.matches o WHERE o.external_id = pg_temp.ov_child_match_key(c.external_id))
    RETURNING pg_temp.ov_child_match_key(c.external_id) AS named
  ) SELECT count(*), coalesce(array_agg(d.named), '{}') INTO k, named FROM d;
  n_test := n_test + k;
  named_test := named_test || named;
  WITH d AS (
    DELETE FROM public.sets c USING public.matches m
     WHERE m.id = c.match_id AND m.test IS TRUE
       AND pg_temp.ov_child_match_key(c.external_id) IS DISTINCT FROM m.external_id
       AND EXISTS (SELECT 1 FROM public.matches o WHERE o.external_id = pg_temp.ov_child_match_key(c.external_id))
    RETURNING pg_temp.ov_child_match_key(c.external_id) AS named
  ) SELECT count(*), coalesce(array_agg(d.named), '{}') INTO k, named FROM d;
  n_test := n_test + k;
  named_test := named_test || named;
  WITH held AS (
    SELECT c.external_id FROM public.events c JOIN public.matches m ON m.id = c.match_id
     WHERE m.test IS NOT TRUE AND pg_temp.ov_child_match_key(c.external_id) IS DISTINCT FROM m.external_id
    UNION ALL
    SELECT c.external_id FROM public.sets c JOIN public.matches m ON m.id = c.match_id
     WHERE m.test IS NOT TRUE AND pg_temp.ov_child_match_key(c.external_id) IS DISTINCT FROM m.external_id
  )
  SELECT count(*), array_agg(pg_temp.ov_child_match_key(h.external_id)) INTO n_official, named_official
    FROM held h
   WHERE EXISTS (SELECT 1 FROM public.matches o WHERE o.external_id = pg_temp.ov_child_match_key(h.external_id));
  RAISE NOTICE '032: % set/event row(s) of test matches under another match''s id deleted%', n_test, pg_temp.ov_match_list(named_test);
  RAISE NOTICE '032: % set/event row(s) of official matches under another match''s id left as they are (an admin decides)%', n_official, pg_temp.ov_match_list(named_official);
END
$$;

-- 4. Voids set or lifted by a revision of another match
DO $$
DECLARE
  n bigint;
  affected text[];
BEGIN
  WITH touched AS (
    SELECT DISTINCT e.id
      FROM public.event_revisions f
      JOIN public.events e ON e.external_id = f.event_external_id AND e.match_id IS DISTINCT FROM f.match_id
     WHERE f.op IN ('void', 'restore')
  ), state AS (
    SELECT e.id, own.op AS own_op, own.client_ts AS own_ts, own.actor_id AS own_actor, own.reason AS own_reason,
           -- the void the event has is that of another match's revision (db/015 copied these three)
           EXISTS (SELECT 1 FROM public.event_revisions f
                    WHERE f.event_external_id = e.external_id AND f.match_id IS DISTINCT FROM e.match_id AND f.op = 'void'
                      AND f.client_ts = e.voided_at AND f.actor_id IS NOT DISTINCT FROM e.voided_by
                      AND f.reason IS NOT DISTINCT FROM e.void_reason) AS foreign_void
      FROM touched t
      JOIN public.events e ON e.id = t.id
      LEFT JOIN LATERAL (
        SELECT o.op, o.client_ts, o.actor_id, o.reason
          FROM public.event_revisions o
         WHERE o.event_external_id = e.external_id AND o.match_id = e.match_id AND o.op IN ('void', 'restore')
         ORDER BY o.id DESC
         LIMIT 1) own ON true
  ), target AS (
    SELECT id, foreign_void, own_op,
           CASE WHEN own_op = 'void' THEN own_ts END AS new_at,
           CASE WHEN own_op = 'void' THEN own_actor END AS new_by,
           CASE WHEN own_op = 'void' THEN own_reason END AS new_reason
      FROM state
  ), fixed AS (
    UPDATE public.events e
       SET voided_at = t.new_at, voided_by = t.new_by, void_reason = t.new_reason
      FROM target t
     WHERE e.id = t.id
       AND (t.foreign_void OR (t.own_op = 'void' AND e.voided_at IS NULL))
       AND (e.voided_at, e.voided_by, e.void_reason) IS DISTINCT FROM (t.new_at, t.new_by, t.new_reason)
    RETURNING e.match_id
  )
  SELECT count(*), array_agg(m.external_id) INTO n, affected
    FROM fixed f LEFT JOIN public.matches m ON m.id = f.match_id;
  RAISE NOTICE '032: % event void(s) set or lifted by another match''s revision put back to what the event''s own match says%', n, pg_temp.ov_match_list(affected);
END
$$;

-- 5. Pending revisions under a match that does not own the event id
DO $$
DECLARE
  n bigint;
  named text[];
BEGIN
  WITH d AS (
    DELETE FROM public.event_revisions r USING public.matches m
     WHERE m.id = r.match_id AND r.applied = false
       AND pg_temp.ov_child_match_key(r.event_external_id) IS DISTINCT FROM m.external_id
    RETURNING pg_temp.ov_child_match_key(r.event_external_id) AS named
  ) SELECT count(*), array_agg(d.named) INTO n, named FROM d;
  RAISE NOTICE '032: % pending revision(s) filed under a match that the event id does not name deleted%', n, pg_temp.ov_match_list(named);
END
$$;

-- 6. Rows of their own match whose id only the old rule took (it starts with
-- the match's external_id plus ':' or '_', but names no match, e.g.
-- `<match>_legacy`). Those that name another match are counted in 3.
DO $$
DECLARE
  n bigint;
  own text[];
BEGIN
  WITH legacy AS (
    SELECT c.external_id, m.external_id AS own FROM public.events c JOIN public.matches m ON m.id = c.match_id
    UNION ALL
    SELECT c.external_id, m.external_id AS own FROM public.sets c JOIN public.matches m ON m.id = c.match_id
  )
  SELECT count(*), array_agg(l.own) INTO n, own
    FROM legacy l
   WHERE l.own <> '' AND length(l.external_id) > length(l.own) AND starts_with(l.external_id, l.own)
     AND substr(l.external_id, length(l.own) + 1, 1) IN (':', '_')
     AND pg_temp.ov_child_match_key(l.external_id) IS DISTINCT FROM l.own
     AND NOT EXISTS (SELECT 1 FROM public.matches o WHERE o.external_id = pg_temp.ov_child_match_key(l.external_id));
  RAISE NOTICE '032: % set/event row(s) with an id that only the old rule took as their own match''s (an older app''s delete of one such event deletes it, without a void)%', n, pg_temp.ov_match_list(own);
END
$$;

DROP FUNCTION pg_temp.ov_match_list(text[]);
DROP FUNCTION pg_temp.ov_child_match_key(text);

COMMIT;
