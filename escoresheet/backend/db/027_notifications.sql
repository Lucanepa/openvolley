-- 027_notifications.sql: the manager's notifications (the bell), first of
-- them "a new account signed up" (lib/signupNotices.js).
--
-- Owner, 2026-11-11: "why i don't get emails when there's a new signup";
-- decisions: 1. admins AND the approvers of the sign-up's requests (club
-- managers of its clubs, team managers of its teams) are told; 2. on every
-- sign-up, once its address is confirmed; 3. as a mail and as a notification
-- in the manager.
--
-- notifications: one row per recipient and event. `subject_user_id` is the
-- account the notice is about (the new sign-up); its name and address are
-- read live, never copied here, and the row goes with either account (ON
-- DELETE CASCADE). `target` is the manager page the notice opens
-- ('accounts/<id>', 'myclub/<club id>', 'myteams/<team id>'); `details` the
-- parts asked for at that time, by kind and club / team name only (no
-- personal data). `app`: the manager it shows in (indoor | beach).
-- Rows older than 90 days are deleted when the list is read.
--
-- roles.sql: no change (ov_app's default privileges cover new tables); run
-- apply-roles.sh after this file as with every migration all the same.
-- Not on the /api/db allowlist (server.js ALLOWED_TABLES), never public:
-- only lib/signupNotices.js reads and writes it.
--
-- Idempotent. Deploy: 027, apply-roles.sh, the backend image, the manager.
-- A backend without this file sends the mails and stores no notification.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.notifications (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind             text        NOT NULL CHECK (kind IN ('signup')),
  app              text        NOT NULL DEFAULT 'indoor' CHECK (app IN ('indoor', 'beach')),
  subject_user_id  uuid        REFERENCES auth.users(id) ON DELETE CASCADE,
  target           text        NOT NULL CHECK (length(target) <= 200),
  details          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  read_at          timestamptz
);

CREATE INDEX IF NOT EXISTS notifications_user_idx ON public.notifications (user_id, app, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_subject_idx ON public.notifications (subject_user_id);
-- One notice per recipient and sign-up (a second confirmation adds none)
CREATE UNIQUE INDEX IF NOT EXISTS notifications_once_uidx ON public.notifications (user_id, kind, subject_user_id);

COMMENT ON TABLE public.notifications IS 'The manager''s notifications (db/027): who signed up, for the admins and the approvers of its requests.';

COMMIT;
