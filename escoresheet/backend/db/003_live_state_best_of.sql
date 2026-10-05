-- 003_live_state_best_of.sql: match_live_state.best_of
--
-- The scoreboard writes best_of into the live state (Scoreboard.jsx,
-- MatchSetup.jsx), but the Supabase table never had the column, so those
-- upserts failed with PGRST204. pgQuery would answer 42703 the same way.
--
-- Run as ov_owner after 002_app_sessions.sql (restore.sh runs every db/NNN_*.sql
-- with NNN >= 003 in order). Idempotent.

ALTER TABLE public.match_live_state ADD COLUMN IF NOT EXISTS best_of integer;
