-- 032_club_api_tokens.sql: API tokens of a club (lib/clubApi.js, docs/club-api.md).
--
-- A club manager makes a token in the manager console (the API tab). The token
-- acts for ONE club (optionally for one of its teams) with the scopes it was
-- given, as the manager who made it: it can do nothing that manager could not,
-- and it stops working when that manager no longer manages the club (checked on
-- every call) or the account is deleted (ON DELETE CASCADE).
--
-- Only a SHA-256 of the token is stored (a token is 32 random bytes, so a plain
-- hash is enough); the token itself is shown once. `prefix` is its first
-- characters, for the list in the manager.
--
-- Not on the /api/db allowlist: lib/clubApi.js is the only reader and writer.
-- roles.sql: ov_app's default privileges cover the new table; run apply-roles.sh
-- after this file as with every migration all the same. Idempotent.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.club_api_tokens (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id      uuid        NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  created_by   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  team_id      uuid        REFERENCES public.club_teams(id) ON DELETE CASCADE,
  label        text        NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  prefix       text        NOT NULL CHECK (length(prefix) BETWEEN 4 AND 16),
  token_hash   bytea       NOT NULL UNIQUE,
  scopes       text[]      NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 4
                                       AND scopes <@ ARRAY['read', 'rosters:write', 'teams:write', 'licences:write']::text[]),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS club_api_tokens_club_idx ON public.club_api_tokens (club_id, created_at DESC);

COMMIT;
