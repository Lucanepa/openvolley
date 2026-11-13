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
-- (from an editor added after the close only within 6 hours of it,
-- lib/scoresheets.js LATE_EDITOR_WINDOW_MS; that same file replaceable for
-- 10 minutes by its uploader or the closing account; for a match closed
-- before this file ran, its file on disk is the approval's). The manager's
-- Scoresheets tab and the final mail serve only
-- these files of the match (the newest); a match without a row (files stored
-- before this file ran) falls back to the file names, and then only to files
-- that have no row (also none with a NULL match_id) and whose storage owner
-- created the match, closed it or was its editor before the close.
-- scripts/scoresheet-records.mjs --apply, a deploy step after this file and
-- the new backend, writes the row of the file each match closed before this
-- file ran has by the names (its time kept; idempotent). From then on a
-- closed match is served and held by its row; the names stay only for one
-- the step could not record (a file the names give to two closed matches),
-- and the server logs each.
--
--   path       the object's key in the bucket ({day}/game{n}_k{hex}.pdf,
--              beach/{day}/game{n}_{seed}.pdf); one match per file
--   match_id   NULL once the match is deleted (the app's sync queue deletes
--              open and test matches): the row stays, so that file is never
--              another match's by its name (a delete must not hand a file
--              stored for one match to a closed match of the same name)
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
-- Idempotent, adds one table only. On a database where an earlier draft of
-- this file ran: first_stored_at is added (NULL there, not the time this
-- file ran, which would open the 10 minutes again), match_id becomes
-- nullable with ON DELETE SET NULL (it was CASCADE), and that draft's
-- public.match_scoresheets_start (one row, no longer read) is dropped.
-- Deploy as every migration: this file and apply-roles.sh before or with
-- the backend that reads the table (a backend without the table answers PDF
-- uploads with 503 and the apps send them again; PDFs the previous backend
-- stores after this file ran have no row and are found by their names, the
-- step records them). Then, in the new backend's container,
-- scripts/scoresheet-paths.mjs and scripts/scoresheet-records.mjs (each a
-- dry run first, then --apply; README "Files stored before this change").
BEGIN;

CREATE TABLE IF NOT EXISTS public.match_scoresheets (
  path       text        PRIMARY KEY CHECK (length(path) BETWEEN 1 AND 1024),
  match_id   uuid        REFERENCES public.matches(id) ON DELETE SET NULL,
  stored_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  sha256     text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size       integer     NOT NULL CHECK (size >= 0),
  stored_at  timestamptz NOT NULL DEFAULT now(),
  first_stored_at timestamptz DEFAULT now()
);

ALTER TABLE public.match_scoresheets ADD COLUMN IF NOT EXISTS first_stored_at timestamptz;
ALTER TABLE public.match_scoresheets ALTER COLUMN first_stored_at SET DEFAULT now();

-- an earlier draft: match_id NOT NULL ... ON DELETE CASCADE
ALTER TABLE public.match_scoresheets ALTER COLUMN match_id DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'match_scoresheets_match_id_fkey' AND conrelid = 'public.match_scoresheets'::regclass
                    AND confdeltype = 'n') THEN
    ALTER TABLE public.match_scoresheets DROP CONSTRAINT IF EXISTS match_scoresheets_match_id_fkey;
    ALTER TABLE public.match_scoresheets ADD CONSTRAINT match_scoresheets_match_id_fkey
      FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE SET NULL;
  END IF;
END $$;
DROP TABLE IF EXISTS public.match_scoresheets_start;

CREATE INDEX IF NOT EXISTS match_scoresheets_match_idx ON public.match_scoresheets (match_id, stored_at DESC);

COMMENT ON TABLE public.match_scoresheets IS 'The scoresheet PDFs the server accepted for each match (match_id NULL: its match was deleted): who stored them, when, their SHA-256 (db/033).';

COMMIT;
