-- 007_live_state_tto.sql: match_live_state.tto_active / tto_started_at
--
-- openbeach (sport_type 'beach') writes the technical timeout into the live
-- state (Scoreboard_beach.jsx syncLiveStateToSupabase: tto_active,
-- tto_started_at), but the Supabase table never had the columns, so every
-- beach live-state upsert failed with PGRST204 (pgQuery answers 42703 the
-- same way). lib/publicColumns.js lets both through to live viewers, so the
-- beach referee sees the TTO over the realtime relay.
--
-- Run as ov_owner after 006 (restore.sh runs every db/NNN_*.sql with
-- NNN >= 003 in numeric order), then roles.sql. Idempotent.

ALTER TABLE public.match_live_state
  ADD COLUMN IF NOT EXISTS tto_active boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS tto_started_at timestamptz;
