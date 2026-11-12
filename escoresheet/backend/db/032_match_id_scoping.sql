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
--   2. sets and events of a TEST match under another match's id are deleted
--      (held ids, which kept that match's own uploads out); the same rows of
--      an official match are only counted, an admin decides about them,
--   3. an event whose void was set or lifted by another match's revision gets
--      the state its own match's revisions give (the newest void or restore
--      of that match; none: not voided),
--   4. pending revisions (applied = false) filed under a match that the event
--      id does not name are deleted.
-- Read the NOTICEs: a number above 0 in 2 to 4 means another match's data was
-- tampered with before this fix.
--
-- Idempotent, one transaction, safe while the running backend serves (the
-- old backend works with it too). Deploy: this file, then roles.sql, then the
-- backend image.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- 2 to 4 may touch closed matches (db/007's and db/015's guards)
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

-- 2. Rows under the id of another (existing) match
DO $$
DECLARE
  n_test bigint := 0;
  n_official bigint;
  k bigint;
BEGIN
  DELETE FROM public.events c USING public.matches m
   WHERE m.id = c.match_id AND m.test IS TRUE
     AND pg_temp.ov_child_match_key(c.external_id) IS DISTINCT FROM m.external_id
     AND EXISTS (SELECT 1 FROM public.matches o WHERE o.external_id = pg_temp.ov_child_match_key(c.external_id));
  GET DIAGNOSTICS k = ROW_COUNT;
  n_test := n_test + k;
  DELETE FROM public.sets c USING public.matches m
   WHERE m.id = c.match_id AND m.test IS TRUE
     AND pg_temp.ov_child_match_key(c.external_id) IS DISTINCT FROM m.external_id
     AND EXISTS (SELECT 1 FROM public.matches o WHERE o.external_id = pg_temp.ov_child_match_key(c.external_id));
  GET DIAGNOSTICS k = ROW_COUNT;
  n_test := n_test + k;
  SELECT (SELECT count(*) FROM public.events c JOIN public.matches m ON m.id = c.match_id
           WHERE m.test IS NOT TRUE
             AND pg_temp.ov_child_match_key(c.external_id) IS DISTINCT FROM m.external_id
             AND EXISTS (SELECT 1 FROM public.matches o WHERE o.external_id = pg_temp.ov_child_match_key(c.external_id)))
       + (SELECT count(*) FROM public.sets c JOIN public.matches m ON m.id = c.match_id
           WHERE m.test IS NOT TRUE
             AND pg_temp.ov_child_match_key(c.external_id) IS DISTINCT FROM m.external_id
             AND EXISTS (SELECT 1 FROM public.matches o WHERE o.external_id = pg_temp.ov_child_match_key(c.external_id)))
    INTO n_official;
  RAISE NOTICE '032: % set/event row(s) of test matches under another match''s id deleted', n_test;
  RAISE NOTICE '032: % set/event row(s) of official matches under another match''s id left as they are (an admin decides)', n_official;
END
$$;

-- 3. Voids set or lifted by a revision of another match
DO $$
DECLARE n bigint;
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
    RETURNING e.id
  )
  SELECT count(*) INTO n FROM fixed;
  RAISE NOTICE '032: % event void(s) set or lifted by another match''s revision put back to what the event''s own match says', n;
END
$$;

-- 4. Pending revisions under a match that does not own the event id
DO $$
DECLARE n bigint;
BEGIN
  DELETE FROM public.event_revisions r USING public.matches m
   WHERE m.id = r.match_id AND r.applied = false
     AND pg_temp.ov_child_match_key(r.event_external_id) IS DISTINCT FROM m.external_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '032: % pending revision(s) filed under a match that the event id does not name deleted', n;
END
$$;

DROP FUNCTION pg_temp.ov_child_match_key(text);

COMMIT;
