-- 019_match_scorer_device.sql: which device scores a match (the scoring-device
-- handover).
--
-- Before: a match continued on another device (PC -> phone, a replacement
-- tablet) was written by both: nothing told the first device that the second
-- one had taken over, so a PC left open on the scorer's table kept writing its
-- own score into the same cloud match (2026-10-20, game 406970).
--
-- Now the server keeps one ACTIVE SCORING DEVICE per match: the installation
-- id the apps already send with the event history and the activity log
-- (frontend utils/deviceId.js, a random uuid per installation, never a
-- person), its platform ('android', 'tauri-linux', 'web' ...) and when it took
-- the match over. lib/scorerDevice.js:
--   - the first write of a match that names a device (/api/db, the backup
--     restore, the event history) makes that device the scorer;
--   - "Continue / join on this device" (restore by game PIN, a backup restore)
--     and "Take back scoring here" make the device the scorer explicitly
--     (POST /api/match/scorer); the previous device is told over its relay
--     socket and gets 409 OV_SCORER_MOVED on its next write;
--   - a write that names another device than the scorer is refused with 409
--     OV_SCORER_MOVED (the platform and the time of the take-over only, never
--     the other device's id);
--   - a write that names no device (an app from before this change) is
--     neither checked nor recorded: old apps keep working as before.
-- Test matches and closed matches are not checked (a closed match refuses
-- every write anyway, db/007).
--
-- A table of its own, not columns of public.matches: the closed-match guard
-- (db/007 ov_matches_guard) compares whole rows, and the handover must not
-- touch the match row, its updated_at or its realtime changes. Not on the
-- /api/db allowlist (server.js ALLOWED_TABLES): only the server reads and
-- writes it. A match deleted takes its row along (ON DELETE CASCADE).
--
-- roles.sql: no change. ov_app's table grants (and the default privileges)
-- cover a new table; run apply-roles.sh after this file as with every
-- migration all the same.
--
-- Idempotent. Deploy: 019, apply-roles.sh, the backend image, the clients.
-- A backend without 019 answers as before (lib/scorerDevice.js treats a
-- missing table as "no scorer recorded"), and an older backend ignores the
-- device the new apps send.
BEGIN;

CREATE TABLE IF NOT EXISTS public.match_scorer_devices (
  match_id    uuid        PRIMARY KEY REFERENCES public.matches(id) ON DELETE CASCADE,
  device_id   text        NOT NULL,
  platform    text,
  claimed_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  claimed_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.match_scorer_devices DROP CONSTRAINT IF EXISTS match_scorer_devices_device_id_check;
ALTER TABLE public.match_scorer_devices ADD CONSTRAINT match_scorer_devices_device_id_check
  CHECK (device_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE public.match_scorer_devices DROP CONSTRAINT IF EXISTS match_scorer_devices_platform_check;
ALTER TABLE public.match_scorer_devices ADD CONSTRAINT match_scorer_devices_platform_check
  CHECK (platform IS NULL OR platform ~ '^[a-z0-9-]{1,24}$');

COMMENT ON TABLE public.match_scorer_devices IS
  'The active scoring device of a match (db/019, lib/scorerDevice.js): writes naming another device get 409 OV_SCORER_MOVED. Server only, not on the /api/db allowlist.';

COMMIT;
