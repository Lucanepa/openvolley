-- 046_global_matches.sql: the Global tool's opt-in cloud copy (lib/globalMatches.js)
--
-- A Global match (any tournament, no account) stays on the scorer's device.
-- In Match setup the scorer may opt in to "Save in the cloud" (owner
-- 2026-11-17): the match is then kept here as well, readable by the server,
-- so it can
--   * be continued or corrected on another scorer device (backup code + PIN),
--   * be shared with a read-only link (result, sets, the PDF scoresheet),
--   * be listed with the other matches of a tournament for whoever has the
--     tournament's organizer code.
--
-- No account, so no foreign key: a row is found by a SHA-256 of the match's
-- own random key (key_hash; the key never reaches the database), its writes
-- need the match's PIN (pin_hash, a SHA-256 salted with the key), the share
-- link is a random token (share_token, null = not shared) and the organizer
-- list a SHA-256 of the organizer code (organizer_hash). Nothing here is
-- mixed into matches / sets / events: no club, game, approval or account
-- logic sees a Global match.
--
-- summary: the result as the lists show it (team names, sets, status, hall,
-- league, time; lib/globalMatches.js sanitizeSummary). bundle: the device's
-- match export (rosters, events), what another device continues from. pdf:
-- the finished scoresheet, when the device sent one.
--
-- Retention (privacy policy): deleted 180 days after the last save
-- (expires_at, moved on every save; the backend's hourly sweep), or at once
-- when the scorer deletes it.
--
-- Not on the /api/db allowlist: lib/globalMatches.js is the only reader and
-- writer. roles.sql: ov_app's default privileges cover the table; the ov_read
-- view leaves out the hashes, the token, the bundle and the PDF. Run
-- apply-roles.sh after this file as with every migration. Idempotent.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.global_matches (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash       text        NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  pin_hash       text        NOT NULL CHECK (pin_hash ~ '^[0-9a-f]{64}$'),
  share_token    text        UNIQUE CHECK (share_token IS NULL OR share_token ~ '^[A-Za-z0-9_-]{22}$'),
  organizer_hash text        CHECK (organizer_hash IS NULL OR organizer_hash ~ '^[0-9a-f]{64}$'),
  summary        jsonb       NOT NULL,
  bundle         jsonb       NOT NULL,
  pdf            bytea,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '180 days'
);
CREATE INDEX IF NOT EXISTS global_matches_organizer_idx ON public.global_matches (organizer_hash, updated_at DESC) WHERE organizer_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS global_matches_expires_idx ON public.global_matches (expires_at);
COMMENT ON TABLE public.global_matches IS 'The Global tool''s opt-in cloud copy of a match, no account (db/046, lib/globalMatches.js); deleted 180 days after the last save.';

COMMIT;
