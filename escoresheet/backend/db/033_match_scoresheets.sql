-- 033_match_scoresheets.sql: a match's stored scoresheet PDF is the one an
-- account that may write the match stored for it.
--
-- Until now the server took a match's PDF by its file name alone (the match
-- day's folder, game{n}_k{hex}.pdf, the newest one), and any approved scorer
-- of the sport could add such a file: the competition managers then opened,
-- and the final mail (db/021) sent, another account's file as the match's
-- scoresheet. And the file stayed changeable after the close.
--
-- public.match_scoresheets: one row per PDF of the 'scoresheets' storage
-- bucket that the server accepted for a match (lib/scoresheets.js storePdf,
-- POST /api/storage/upload): only from the match's creator, an editor or an
-- admin (pgQuery assertMatchWritable), after the close once per approval
-- (that same file replaceable for 10 minutes by its uploader or the closing
-- account; for a match closed before this file ran, its file on disk is the
-- approval's). The manager's Scoresheets tab and the final mail serve only
-- these files of the match (the newest); a match without a row (files stored
-- before this file ran) falls back to the file names, and then only to files
-- whose storage owner created, edits or closed the match.
--
--   path       the object's key in the bucket ({day}/game{n}_k{hex}.pdf,
--              beach/{day}/game{n}_{seed}.pdf); one match per file
--   stored_by  the account that stored it; NULL once that account is deleted
--              (the file stays the match's record, like matches.created_by)
--   sha256     of the stored bytes: a resent job after the close (the same
--              bytes) is accepted, a changed file is not
--   first_stored_at  when it was first stored for the match's approval (since
--              its last reopen; a file from before this file ran that is
--              recorded later: its own time); a replacement does not move it.
--              After the close that file is replaced for 10 minutes after
--              the close, or after this time when it is later
--              (lib/scoresheets.js CLOSED_REPLACE_GRACE_MS), never 10 minutes
--              after the last replacement. NULL (a row of an earlier draft
--              of this file): the close counts
--
-- roles.sql: no change (ov_app's table grants cover new tables); run
-- apply-roles.sh after this file as with every migration all the same.
-- Not on the /api/db allowlist: only lib/scoresheets.js reads and writes it.
--
-- Idempotent, adds a table only (and its first_stored_at column to a table
-- an earlier draft of this file made without it: NULL there, not the time
-- this file ran, which would open the 10 minutes again). Deploy: 033,
-- apply-roles.sh, then the backend image (an image without this table
-- answers PDF uploads with 503).
BEGIN;

CREATE TABLE IF NOT EXISTS public.match_scoresheets (
  path       text        PRIMARY KEY CHECK (length(path) BETWEEN 1 AND 1024),
  match_id   uuid        NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  stored_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  sha256     text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size       integer     NOT NULL CHECK (size >= 0),
  stored_at  timestamptz NOT NULL DEFAULT now(),
  first_stored_at timestamptz DEFAULT now()
);

ALTER TABLE public.match_scoresheets ADD COLUMN IF NOT EXISTS first_stored_at timestamptz;
ALTER TABLE public.match_scoresheets ALTER COLUMN first_stored_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS match_scoresheets_match_idx ON public.match_scoresheets (match_id, stored_at DESC);

COMMENT ON TABLE public.match_scoresheets IS 'The scoresheet PDFs the server accepted for each match: who stored them, when, their SHA-256 (db/033).';

COMMIT;
