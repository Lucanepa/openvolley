-- 040_final_mail.sql: the final scoresheet mail (db/021, lib/finalMail.js)
-- as one state machine per close, and a released match left out of it.
--
-- Before: a mail the hourly budget held back, and a close whose sends failed
-- five times, were recorded as 'sent' (also with 0 recipients) and never
-- tried again; a close without a PDF within 2 hours was recorded as 'no_pdf'
-- and never mailed, also when the PDF came later; a re-close after an admin
-- reopen was mailed with the previous approval's PDF when that one was stored
-- less than 15 minutes before it; and 20 closes still waiting for a PDF held
-- back every later one. A match an admin released (release-game: a
-- duplicate) stayed official for the mail.
--
-- public.match_final_mails (one row per close of a match) now holds the
-- state of its mail:
--   outcome      pending      looked at, not done: waiting for the PDF of the
--                             close's approval, or a failed send to try again
--                deferred     the hourly budget held mails back; tried again
--                             at next_try_at, no try counted
--                sent         mailed with the approval's PDF
--                sent_no_pdf  mailed without it (no PDF within the grace after
--                             the close; the scorer and the admins are told);
--                             the PDF follows on its own once it is stored
--                partial / failed  given up after the last try with failed
--                             sends (some / nobody reached)
--                no_recipients, and no_pdf (the backend before this file: never mailed)
--   attempts     rounds with a failed send (a budget hold is not one)
--   next_try_at  when the sweep looks at it again (NULL: nothing left to do)
--   delivered    who a round already reached, so a retry mails nobody twice:
--                the SHA-256 (32 hex digits) of the round, the match, the
--                close and the address, never an address; emptied when the
--                round is done
--   reopen_notice  'sent' / 'none' once the officials whose approvals an
--                admin reopen voided were told (NULL: not yet, or no reopen)
--   recipients   how many addresses the mail reached
-- public.matches.released_at: when an admin released the match's game
-- number (lib/accounts.js releaseGame). A released match (official_game_exempt
-- and released_at) is not mailed; the managers' Scoresheets list marks it.
-- The exemption ends when the match moves to another game key (db/007), and
-- the match is official again: released_at then counts no more.
--
-- Rows written before this file keep their outcome ('sent', 'no_pdf',
-- 'no_recipients'): nothing is mailed again for them, and a close of theirs
-- that an admin reopened before this file ran counts as told (reopen_notice
-- 'none'), so the deploy sends no old reopen notices.
--
-- roles.sql: no change (ov_app's table grants cover new columns); run
-- apply-roles.sh after this file as with every migration all the same.
-- match_final_mails is not on the /api/db allowlist; matches is, and
-- released_at is the server's: server.js WRITE_DENYLIST drops it from client
-- writes.
--
-- Idempotent, one transaction: adds columns, checks and an index, and marks
-- the closes reopened before it (only when it adds reopen_notice); safe
-- while the running backend serves (the previous backend writes 'sent' /
-- 'no_pdf' / 'no_recipients' rows as before, which the new one reads).
-- Deploy: deploy/deploy.sh runs it with the new image (scripts/migrate.mjs),
-- before the backend switches; no step by hand.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS released_at timestamptz;

ALTER TABLE public.match_final_mails ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE public.match_final_mails ADD COLUMN IF NOT EXISTS next_try_at timestamptz;
ALTER TABLE public.match_final_mails ADD COLUMN IF NOT EXISTS delivered text[] NOT NULL DEFAULT '{}';
-- reopen_notice: the closes reopened before this file ran are not told now
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'match_final_mails' AND column_name = 'reopen_notice') THEN
    ALTER TABLE public.match_final_mails ADD COLUMN reopen_notice text;
    UPDATE public.match_final_mails f SET reopen_notice = 'none'
     WHERE EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = 'match.reopen' AND a.match_id = f.match_id AND a.at > f.closed_at);
  END IF;
END $$;

-- The outcomes above (021's check allowed sent / no_pdf / no_recipients)
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.match_final_mails'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%outcome%' AND conname <> 'match_final_mails_outcome_040'
  LOOP
    EXECUTE format('ALTER TABLE public.match_final_mails DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.match_final_mails'::regclass AND conname = 'match_final_mails_outcome_040') THEN
    ALTER TABLE public.match_final_mails ADD CONSTRAINT match_final_mails_outcome_040
      CHECK (outcome IN ('pending', 'deferred', 'sent', 'sent_no_pdf', 'partial', 'failed', 'no_recipients', 'no_pdf'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.match_final_mails'::regclass AND conname = 'match_final_mails_attempts_040') THEN
    ALTER TABLE public.match_final_mails ADD CONSTRAINT match_final_mails_attempts_040 CHECK (attempts >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.match_final_mails'::regclass AND conname = 'match_final_mails_reopen_notice_040') THEN
    ALTER TABLE public.match_final_mails ADD CONSTRAINT match_final_mails_reopen_notice_040
      CHECK (reopen_notice IS NULL OR reopen_notice IN ('sent', 'none'));
  END IF;
END $$;

-- The sweep's due rows
CREATE INDEX IF NOT EXISTS match_final_mails_due_idx ON public.match_final_mails (next_try_at) WHERE next_try_at IS NOT NULL;

COMMENT ON COLUMN public.match_final_mails.delivered IS 'Who the round in progress already reached: SHA-256 prefixes of round, match, close and address, never an address (db/040).';
COMMENT ON COLUMN public.matches.released_at IS 'When an admin released the game number (release-game, db/040); with official_game_exempt the match is not mailed as final.';

COMMIT;
