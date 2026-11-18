-- 047_live_state_public_counts.sql: match_live_state.subs_count_a / subs_count_b
--
-- A scoreboard that follows a match without its PIN (Point Hub, the LedBox,
-- a TV page) gets no subs_a / subs_b: they name shirt numbers and stay
-- PIN-only (lib/publicColumns.js LIVE_STATE_PRIVATE_COLUMNS), so it showed 0
-- substitutions all match (owner 2026-11-17). The scorer now also writes a
-- count per team: the regular substitutions of the set current_set names
-- (frontend/src/domain/livePublicFields.js), public like timeouts_a / _b.
-- It writes set_results as well (the finished sets: [{ set, home, away, a, b }]);
-- the column came with the Supabase dump, added here for a database without it.
--
-- An app newer than this migration loses nothing on an older database: pgQuery
-- writes a live state without a column the table lacks (counted under
-- droppedColumns on /health), so the order of deploy and app release does not
-- matter. Idempotent; no grants (ov_app's DML covers new columns).

ALTER TABLE public.match_live_state
  ADD COLUMN IF NOT EXISTS subs_count_a smallint,
  ADD COLUMN IF NOT EXISTS subs_count_b smallint,
  ADD COLUMN IF NOT EXISTS set_results json;
