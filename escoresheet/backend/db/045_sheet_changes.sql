-- 045_sheet_changes.sql: when the data a match's scoresheet is drawn from last changed
--
-- The managers' Scoresheets tab marks a stored PDF "Out of date" when the match's
-- data changed after it (lib/scoresheets.js pdf_stale). It used to work that out
-- from the match row's updated_at, its sets' updated_at, its events' created_at
-- and its event revisions. Two things were wrong (owner 2026-11-16):
--   * an UPDATE of an event row itself (the SQL tab, the Data tab) moved none of
--     them: the PDF did not show as out of date;
--   * releasing a game (lib/accounts.js release-game: official_game_exempt,
--     released_at) moves matches.updated_at, so its PDF showed as out of date
--     although nothing on the sheet changed.
--
-- public.match_sheet_changes holds one row per match: changed_at, the last time
-- anything the sheet prints changed. Triggers keep it:
--   * events, sets, match_approvals: any INSERT or DELETE, and an UPDATE that
--     changes a column other than the bookkeeping ones (sets.updated_at; the
--     voided_by / actor_id / user_id / requested_by / revoked_by an account
--     deletion clears, ON DELETE SET NULL);
--   * event_revisions: any INSERT (a correction or an undo, db/015);
--   * matches: an UPDATE that changes a column the sheet reads, i.e. any column
--     but the bookkeeping ones listed in ov_match_sheet_changed() below (the
--     close, the game release, the official season, sync and connection
--     columns, updated_at).
-- Statement-level, with transition tables: a sync that inserts 500 events
-- writes the row once. A child row of a match being deleted writes nothing
-- (the match is gone; the row would fail the foreign key).
--
-- The closed-match guards (db/007, 015, 039) are untouched: the triggers fire
-- AFTER the write those guards let through, and only write this table, which has
-- no guard. Nothing writes public.matches, so updated_at, the realtime hub and
-- matchRestore's order are not moved.
--
-- Backfill: the value the list computed until now, without the match row's
-- updated_at when a game release wrote it (updated_at within seconds of
-- released_at: the release's own write), so those PDFs no longer show as out of date.
--
-- Not on the /api/db allowlist: the triggers are the only writers, lib/scoresheets.js
-- the only reader. roles.sql: run apply-roles.sh after this file, as with every
-- migration (ov_app's default privileges cover the table; the ov_read view of it
-- is built there). Idempotent.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.match_sheet_changes (
  match_id   uuid        PRIMARY KEY REFERENCES public.matches(id) ON DELETE CASCADE,
  changed_at timestamptz NOT NULL
);
COMMENT ON TABLE public.match_sheet_changes IS 'When the data a match''s scoresheet is drawn from last changed (db/045 triggers; the Scoresheets tab''s "Out of date").';

-- The matches of the changed child rows (transition tables new_rows / old_rows).
-- TG_ARGV: the columns an UPDATE may change without the sheet changing.
CREATE OR REPLACE FUNCTION public.ov_sheet_rows_changed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ign text[] := coalesce(TG_ARGV::text[], ARRAY[]::text[]);
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.match_sheet_changes AS c (match_id, changed_at)
    SELECT DISTINCT n.match_id, now() FROM new_rows n
     WHERE n.match_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.matches m WHERE m.id = n.match_id)
    ON CONFLICT (match_id) DO UPDATE SET changed_at = greatest(c.changed_at, excluded.changed_at);
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.match_sheet_changes AS c (match_id, changed_at)
    SELECT DISTINCT o.match_id, now() FROM old_rows o
     WHERE o.match_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.matches m WHERE m.id = o.match_id)
    ON CONFLICT (match_id) DO UPDATE SET changed_at = greatest(c.changed_at, excluded.changed_at);
  ELSE
    INSERT INTO public.match_sheet_changes AS c (match_id, changed_at)
    SELECT DISTINCT x.match_id, now()
      FROM new_rows n JOIN old_rows o ON o.id = n.id
      CROSS JOIN LATERAL (VALUES (n.match_id), (o.match_id)) AS x(match_id)
     WHERE (to_jsonb(n) - ign) IS DISTINCT FROM (to_jsonb(o) - ign)
       AND x.match_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.matches m WHERE m.id = x.match_id)
    ON CONFLICT (match_id) DO UPDATE SET changed_at = greatest(c.changed_at, excluded.changed_at);
  END IF;
  RETURN NULL;
END
$$;

-- A match row: an UPDATE of a column the sheet reads (every column but these).
CREATE OR REPLACE FUNCTION public.ov_match_sheet_changed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ign text[] := ARRAY['updated_at', 'created_at', 'status', 'closed_at', 'closed_by', 'first_closed_at',
                      'created_by', 'official_game_exempt', 'released_at', 'official_season',
                      'connections', 'connection_pins', 'game_pin', 'tournament_match_id', 'test'];
BEGIN
  INSERT INTO public.match_sheet_changes AS c (match_id, changed_at)
  SELECT DISTINCT n.id, now()
    FROM new_rows n JOIN old_rows o ON o.id = n.id
   WHERE (to_jsonb(n) - ign) IS DISTINCT FROM (to_jsonb(o) - ign)
  ON CONFLICT (match_id) DO UPDATE SET changed_at = greatest(c.changed_at, excluded.changed_at);
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS events_sheet_ins ON public.events;
CREATE TRIGGER events_sheet_ins AFTER INSERT ON public.events
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.ov_sheet_rows_changed();
DROP TRIGGER IF EXISTS events_sheet_upd ON public.events;
CREATE TRIGGER events_sheet_upd AFTER UPDATE ON public.events
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION public.ov_sheet_rows_changed('voided_by', 'actor_id');
DROP TRIGGER IF EXISTS events_sheet_del ON public.events;
CREATE TRIGGER events_sheet_del AFTER DELETE ON public.events
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.ov_sheet_rows_changed();

DROP TRIGGER IF EXISTS sets_sheet_ins ON public.sets;
CREATE TRIGGER sets_sheet_ins AFTER INSERT ON public.sets
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.ov_sheet_rows_changed();
DROP TRIGGER IF EXISTS sets_sheet_upd ON public.sets;
CREATE TRIGGER sets_sheet_upd AFTER UPDATE ON public.sets
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION public.ov_sheet_rows_changed('updated_at');
DROP TRIGGER IF EXISTS sets_sheet_del ON public.sets;
CREATE TRIGGER sets_sheet_del AFTER DELETE ON public.sets
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.ov_sheet_rows_changed();

DROP TRIGGER IF EXISTS match_approvals_sheet_ins ON public.match_approvals;
CREATE TRIGGER match_approvals_sheet_ins AFTER INSERT ON public.match_approvals
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.ov_sheet_rows_changed();
DROP TRIGGER IF EXISTS match_approvals_sheet_upd ON public.match_approvals;
CREATE TRIGGER match_approvals_sheet_upd AFTER UPDATE ON public.match_approvals
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION public.ov_sheet_rows_changed('user_id', 'requested_by', 'revoked_by');

DROP TRIGGER IF EXISTS event_revisions_sheet_ins ON public.event_revisions;
CREATE TRIGGER event_revisions_sheet_ins AFTER INSERT ON public.event_revisions
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.ov_sheet_rows_changed();

DROP TRIGGER IF EXISTS matches_sheet_upd ON public.matches;
CREATE TRIGGER matches_sheet_upd AFTER UPDATE ON public.matches
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION public.ov_match_sheet_changed();

-- Backfill: the value the list computed until now (lib/scoresheets.js before
-- db/045), the match row's updated_at left out when a game release wrote it.
INSERT INTO public.match_sheet_changes (match_id, changed_at)
SELECT m.id, v.changed_at
  FROM public.matches m
  CROSS JOIN LATERAL (SELECT greatest(
           CASE WHEN m.released_at IS NOT NULL AND m.updated_at BETWEEN m.released_at - interval '5 seconds' AND m.released_at + interval '5 seconds' THEN NULL ELSE m.updated_at END,
           (SELECT max((to_jsonb(s) ->> 'updated_at')::timestamptz) FROM public.sets s WHERE s.match_id = m.id),
           (SELECT max(e.created_at) FROM public.events e WHERE e.match_id = m.id),
           (SELECT max(r.at) FROM public.event_revisions r WHERE r.match_id = m.id),
           (SELECT max(greatest(a.approved_at, a.revoked_at)) FROM public.match_approvals a WHERE a.match_id = m.id)
         ) AS changed_at) v
 WHERE v.changed_at IS NOT NULL
ON CONFLICT (match_id) DO NOTHING;

COMMIT;
