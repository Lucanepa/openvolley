-- 021_final_mail.sql: the final scoresheet by email (owner decisions
-- 2026-10-29, ~/ov-ops/club-manager-home-email-PLAN.md step 4).
--
-- Once an official indoor match is closed and its PDF stored, the server
-- (lib/finalMail.js) mails the PDF once to the scorer, the referees and the
-- contact address of each team's club (db/020 clubs.contact_email). Only while
-- the switch is on: public.app_settings.send_final_email, OFF by default, set
-- in the manager's Settings tab by admins and competition managers, so nothing
-- goes out while the app is being tested. Matches closed before the switch was
-- turned on are never mailed.
--
-- public.match_final_mails: one row per close of a match (a reopened and
-- closed again match gets a second one, sent as "corrected"); what went out,
-- never the addresses. Test matches are mailed to their scorer only, straight
-- from the request, and never recorded.
--
-- roles.sql: no change (ov_app's table grants cover new tables); run
-- apply-roles.sh after this file as with every migration all the same.
-- Not on the /api/db allowlist: only lib/finalMail.js reads and writes them.
--
-- Idempotent. Deploy: 021, apply-roles.sh, the backend image.
BEGIN;

-- One row: the app's settings (more switches may join it)
CREATE TABLE IF NOT EXISTS public.app_settings (
  id                boolean     PRIMARY KEY DEFAULT true CHECK (id),
  send_final_email  boolean     NOT NULL DEFAULT false,
  changed_by        uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at        timestamptz
);
INSERT INTO public.app_settings (id, send_final_email) VALUES (true, false) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.match_final_mails (
  match_id    uuid        NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  closed_at   timestamptz NOT NULL,                       -- the close this mail is about
  outcome     text        NOT NULL CHECK (outcome IN ('sent', 'no_pdf', 'no_recipients')),
  recipients  integer     NOT NULL DEFAULT 0 CHECK (recipients >= 0),
  corrected   boolean     NOT NULL DEFAULT false,
  at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, closed_at)
);

COMMENT ON TABLE public.app_settings IS 'One row: app-wide switches, e.g. the final scoresheet mail (db/021).';
COMMENT ON TABLE public.match_final_mails IS 'The final scoresheet mail of each close of a match, without addresses (db/021).';

COMMIT;
