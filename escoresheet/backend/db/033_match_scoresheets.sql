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
-- stored before this file ran (public.match_scoresheets_start) that have no
-- row and whose storage owner created, edits or closed the match.
-- scripts/scoresheet-records.mjs --apply, right after this file, writes the
-- row of the file each match closed before this file ran has by the names
-- (its time kept; idempotent). From then on a closed match is served and
-- held by its row; the names stay only for one the step could not record (a
-- file the names give to two closed matches), and the server logs each.
--
-- public.match_scoresheets_start: one row, when this file first ran. From
-- then on the backend records every PDF it stores, or refuses it, so a file
-- without a row is from before that time or no match's: its row failed, or
-- went with its match (ON DELETE CASCADE; the app's sync queue deletes open
-- and test matches). Such a newer file is never a match's by its name, and
-- the step above never records it.
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
-- Idempotent, adds two tables only (and the first_stored_at column to a
-- table an earlier draft of this file made without it: NULL there, not the
-- time this file ran, which would open the 10 minutes again); a re-run keeps
-- the start time of the first run. Deploy: the backend image FIRST, then
-- right after it 033 and apply-roles.sh (until 033 is in, the new image
-- answers PDF uploads with 503 and the apps send them again), then
-- scripts/scoresheet-records.mjs in the backend container (a dry run, then
-- --apply). Not the other way round: a PDF the old image stores after 033
-- ran has no row and is newer than the start, so the Scoresheets tab and
-- the final mail would not find it (README "Files stored before this change").
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

-- One row: since when every stored PDF is recorded
CREATE TABLE IF NOT EXISTS public.match_scoresheets_start (
  id          boolean     PRIMARY KEY DEFAULT true CHECK (id),
  started_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.match_scoresheets_start (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.match_scoresheets IS 'The scoresheet PDFs the server accepted for each match: who stored them, when, their SHA-256 (db/033).';
COMMENT ON TABLE public.match_scoresheets_start IS 'One row: when db/033 first ran; a PDF stored since then without a match_scoresheets row is no match''s (db/033).';

COMMIT;
