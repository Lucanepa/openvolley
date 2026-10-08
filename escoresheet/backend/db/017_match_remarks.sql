-- 017_match_remarks.sql: the scoresheet remarks reach the server.
--
-- Before: the REMARKS box of the scoresheet (the scorer's own lines, the
-- automatic ones: "Actual start time: HH:MM", injuries and exceptional
-- substitutions, forfeit / default lines, corrections) lived only in the
-- scoring device's IndexedDB (match.remarks, OpenVolley and OpenBeach). A
-- restore on another device, the server's copy of a closed match and the
-- admin console had none of it. Now both apps send the text with the other
-- match fields (sync queue match update { remarks }, the approval job, the
-- backup restore) and the restore-by-pin lookup gives it back.
--
-- One text column, the sheet's lines separated by "\n", at most 8000
-- characters (the apps clip what they send to that; the box on the sheet
-- holds far less). Last write wins, like every other plain match column.
--
-- Not public: lib/publicColumns.js is an allowlist and does not list it, so
-- anonymous /api/db readers, signed-in non-owners and the live socket never
-- see it and cannot filter on it. The owner, an editor, an admin and the
-- game-PIN restore lookup do. The activity log keeps the remarks' length only
-- (lib/activitySanitize.js 'match.remarks'), never the text.
--
-- A closed match (db/007) refuses a change of its remarks like any other
-- change; the admin reopen lifts the lock as before.
--
-- roles.sql: no change. ov_app has table-level DML on public.matches, which
-- covers a new column; run apply-roles.sh after this file as with every
-- migration all the same.
--
-- Idempotent (the CHECK is named, dropped and re-added). Deploy: 017, then
-- apply-roles.sh (roles.sql), then the backend image, then the clients.
-- Old clients keep working: the column is nullable and nobody has to send it.
BEGIN;

ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS remarks text;

ALTER TABLE public.matches DROP CONSTRAINT IF EXISTS matches_remarks_length_check;
ALTER TABLE public.matches ADD CONSTRAINT matches_remarks_length_check
  CHECK (remarks IS NULL OR length(remarks) <= 8000);

COMMENT ON COLUMN public.matches.remarks IS
  'Scoresheet REMARKS box, lines separated by newlines, at most 8000 characters (db/017). Not public (lib/publicColumns.js).';

COMMIT;
