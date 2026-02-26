-- Add scorer_attention_trigger column to match_live_state table
-- This column stores a timestamp string when the scorer requests attention
-- Using a timestamp ensures every request is unique and triggers a realtime event

ALTER TABLE match_live_state 
ADD COLUMN scorer_attention_trigger TEXT;

COMMENT ON COLUMN match_live_state.scorer_attention_trigger IS 'Timestamp ISO string indicating when the scorer requested attention using the alarm bell';
