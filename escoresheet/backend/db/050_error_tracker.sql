-- 050_error_tracker.sql: the error tracker (lib/errorTracker.js, lib/errorAlerts.js).
--
-- Owner, 2026-11-19: "an error tool (like sentry/svrz_rc) that I get when
-- there's an error on OpenVolley app/web etc. with OS, tool, app, member".
-- Decisions: errors of everyone (signed out too, then without an account),
-- an e-mail digest + a phone push + the manager's bell, the member's name and
-- address only in the manager's Errors tab (super admins).
--
--   error_groups  one row per distinct error ("issue"): its fingerprint
--                 (product, source, kind, error name, message with ids and
--                 numbers masked, top frame without the build hash), counts,
--                 first / last seen and version, the triage state and the
--                 alert state (alert_due_at: a digest is owed; last_alert_at:
--                 the cooldown, kept here so a restart loses nothing).
--   error_events  one row per stored occurrence: where (product, tool, view,
--                 version), on what (platform, OS + version, browser, runs as,
--                 screen, language), by whom (device id, session id, the
--                 account only from a verified session), the error itself
--                 (name, message, frames, breadcrumbs, request id). Never a
--                 PIN, password, token, typed value, date of birth, e-mail or
--                 phone number (sanitized on the device and again on the
--                 server). No IP address.
--
-- Retention (errorTracker.purge, daily): events 90 days after they were
-- received, groups without events that are not open 180 days after they
-- were last seen. Account deletion: its events go (lib/auth.js ownedTables).
--
-- No column ends in _hash / _token / _secret: ov_read (roles.sql) and the
-- Data / SQL tabs would hide it.
-- The bell (db/028 notifications) gets the kind 'error', one notice per
-- recipient and group.
--
-- Idempotent. Deploy: this file (scripts/migrate.mjs), apply-roles.sh, then
-- the backend.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.error_groups (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint          text        NOT NULL UNIQUE CHECK (length(fingerprint) <= 64),
  product              text        NOT NULL CHECK (product IN ('openvolley', 'openbeach')),
  source               text        NOT NULL CHECK (source IN ('client', 'server')),
  kind                 text        NOT NULL CHECK (kind ~ '^[a-z_]+(\.[a-z_]+)*$' AND length(kind) <= 64),
  level                text        NOT NULL DEFAULT 'error' CHECK (level IN ('warn', 'error')),
  title                text        NOT NULL CHECK (length(title) <= 300),
  culprit              text        CHECK (culprit IS NULL OR length(culprit) <= 300),
  first_seen           timestamptz NOT NULL DEFAULT now(),
  last_seen            timestamptz NOT NULL DEFAULT now(),
  event_count          bigint      NOT NULL DEFAULT 0,
  first_version        text        CHECK (first_version IS NULL OR length(first_version) <= 32),
  last_version         text        CHECK (last_version IS NULL OR length(last_version) <= 32),
  status               text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'muted')),
  important            boolean     NOT NULL DEFAULT false,
  muted_until          timestamptz,
  resolved_at          timestamptz,
  resolved_by          uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_in_version  text        CHECK (resolved_in_version IS NULL OR length(resolved_in_version) <= 32),
  regressed            boolean     NOT NULL DEFAULT false,
  note                 text        CHECK (note IS NULL OR length(note) <= 1000),
  commit_ref           text        CHECK (commit_ref IS NULL OR length(commit_ref) <= 80),
  alert_due_at         timestamptz,
  alert_reason         text        CHECK (alert_reason IS NULL OR alert_reason IN ('new', 'regression', 'ongoing')),
  last_alert_at        timestamptz,
  -- events stored per day (the daily cap): the day and its count
  stored_day           date,
  stored_today         integer     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS error_groups_last_seen_idx ON public.error_groups (last_seen DESC);
CREATE INDEX IF NOT EXISTS error_groups_status_idx    ON public.error_groups (status, last_seen DESC);
CREATE INDEX IF NOT EXISTS error_groups_alert_idx     ON public.error_groups (alert_due_at) WHERE alert_due_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.error_events (
  id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid                uuid        NOT NULL UNIQUE,                        -- client idempotency
  group_id           uuid        NOT NULL REFERENCES public.error_groups(id) ON DELETE CASCADE,
  at                 timestamptz NOT NULL DEFAULT now(),                 -- received
  client_ts          timestamptz NOT NULL,
  level              text        NOT NULL CHECK (level IN ('warn', 'error')),
  kind               text        NOT NULL CHECK (kind ~ '^[a-z_]+(\.[a-z_]+)*$' AND length(kind) <= 64),
  product            text        NOT NULL CHECK (product IN ('openvolley', 'openbeach')),
  source             text        NOT NULL CHECK (source IN ('client', 'server')),
  tool               text        NOT NULL CHECK (tool ~ '^[a-z_]{1,24}$'),
  app_version        text        CHECK (app_version IS NULL OR length(app_version) <= 32),
  build              text        CHECK (build IS NULL OR length(build) <= 40),
  platform           text        CHECK (platform IS NULL OR length(platform) <= 24),
  os_name            text        CHECK (os_name IS NULL OR length(os_name) <= 24),
  os_version         text        CHECK (os_version IS NULL OR length(os_version) <= 24),
  browser            text        CHECK (browser IS NULL OR length(browser) <= 32),
  browser_version    text        CHECK (browser_version IS NULL OR length(browser_version) <= 24),
  runs_as            text        CHECK (runs_as IS NULL OR runs_as IN ('tab', 'pwa', 'desktop', 'android_app', 'ios_app', 'server')),
  device_model       text        CHECK (device_model IS NULL OR length(device_model) <= 48),
  point_hub          boolean     NOT NULL DEFAULT false,
  screen             text        CHECK (screen IS NULL OR length(screen) <= 16),
  viewport           text        CHECK (viewport IS NULL OR length(viewport) <= 16),
  dpr                numeric(4,2),
  lang               text        CHECK (lang IS NULL OR length(lang) <= 16),
  tz                 text        CHECK (tz IS NULL OR length(tz) <= 48),
  online             boolean,
  device_id          text        CHECK (device_id IS NULL OR length(device_id) <= 64),
  session_id         text        CHECK (session_id IS NULL OR length(session_id) <= 64),
  -- only from the request's own verified session, never from the body
  account_id         uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  view               text        CHECK (view IS NULL OR length(view) <= 120),
  match_external_id  text        CHECK (match_external_id IS NULL OR length(match_external_id) <= 200),
  error_name         text        CHECK (error_name IS NULL OR length(error_name) <= 80),
  message            text        NOT NULL CHECK (length(message) <= 500),
  frames             jsonb       NOT NULL DEFAULT '[]'::jsonb,
  breadcrumbs        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  data               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  request_id         text        CHECK (request_id IS NULL OR length(request_id) <= 32),
  CHECK (pg_column_size(frames) + pg_column_size(breadcrumbs) + pg_column_size(data) <= 16384)
);
CREATE INDEX IF NOT EXISTS error_events_group_idx   ON public.error_events (group_id, at DESC);
CREATE INDEX IF NOT EXISTS error_events_at_idx      ON public.error_events (at);
CREATE INDEX IF NOT EXISTS error_events_account_idx ON public.error_events (account_id, at DESC) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS error_events_device_idx  ON public.error_events (device_id, at DESC) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS error_events_request_idx ON public.error_events (request_id) WHERE request_id IS NOT NULL;

COMMENT ON TABLE public.error_groups IS 'The error tracker (db/050, lib/errorTracker.js): one row per distinct error, its counts, triage and alert state.';
COMMENT ON TABLE public.error_events IS 'The error tracker (db/050, lib/errorTracker.js): stored occurrences (90 days); no IP, no typed values; the account only from a verified session.';

-- The bell (db/028, db/036): kind 'error', one notice per recipient and group
DO $$
BEGIN
  IF to_regclass('public.notifications') IS NOT NULL THEN
    ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
    ALTER TABLE public.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('signup', 'team_manager_proposal', 'error'));
    CREATE UNIQUE INDEX IF NOT EXISTS notifications_error_once_uidx ON public.notifications (user_id, target) WHERE kind = 'error';
  END IF;
END $$;

COMMIT;
