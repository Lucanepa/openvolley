-- 016_activity_log.sql: the match activity log (docs/activity-log-spec.md).
--
-- What happened on each scoring device - scoring, corrections (undo, delete,
-- edit, manual changes), sync results, app start / update / quit, errors -
-- uploaded in batches by the scorer app (POST /api/activity,
-- lib/activityLog.js). Data is the same the scoresheet already holds plus the
-- device's random id, the app version, the platform and the account id;
-- never a PIN, password, token, signature image, date of birth, email or
-- phone (sanitized on the device and again here). Click and keystroke
-- streams never leave the device.
--
-- Append-only for the app (db/roles.sql revokes UPDATE). Retention
-- (purgeActivity, daily): rows without a match 90 days, match rows 24 months
-- after the event, or with the match (trigger below). Account deletion:
-- device rows go, match rows stay without the account (lib/auth.js).
--
-- Idempotent. Deploy: 015 and 016, then apply-roles.sh, then the backend.
BEGIN;

CREATE TABLE IF NOT EXISTS public.activity_log (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid               uuid        NOT NULL UNIQUE,                        -- client idempotency
  at                timestamptz NOT NULL DEFAULT now(),                 -- received
  client_ts         timestamptz NOT NULL,
  app               text        NOT NULL DEFAULT 'indoor' CHECK (app IN ('indoor', 'beach')),
  -- no FK: the entry may arrive before its match
  match_external_id text        CHECK (match_external_id IS NULL OR length(match_external_id) <= 200),
  account_id        uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  uploader_id       uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  device_id         text        CHECK (device_id IS NULL OR length(device_id) <= 64),
  app_version       text        CHECK (app_version IS NULL OR length(app_version) <= 32),
  platform          text        CHECK (platform IS NULL OR length(platform) <= 24),
  kind              text        NOT NULL CHECK (kind ~ '^[a-z_]+(\.[a-z_]+)+$' AND length(kind) <= 64),
  level             text        NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  set_index         integer,
  event_seq         numeric,
  event_external_id text        CHECK (event_external_id IS NULL OR length(event_external_id) <= 200),
  data              jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(data) <= 8192)
);
CREATE INDEX IF NOT EXISTS activity_log_match_idx   ON public.activity_log (match_external_id, client_ts) WHERE match_external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS activity_log_account_idx ON public.activity_log (account_id, at DESC);
CREATE INDEX IF NOT EXISTS activity_log_kind_idx    ON public.activity_log (kind, at DESC);
CREATE INDEX IF NOT EXISTS activity_log_at_idx      ON public.activity_log (at);

-- Deleted with its match
CREATE OR REPLACE FUNCTION public.ov_matches_delete_activity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.external_id IS NOT NULL THEN
    DELETE FROM public.activity_log WHERE match_external_id = OLD.external_id;
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS matches_delete_activity ON public.matches;
CREATE TRIGGER matches_delete_activity
  AFTER DELETE ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.ov_matches_delete_activity();

COMMIT;
