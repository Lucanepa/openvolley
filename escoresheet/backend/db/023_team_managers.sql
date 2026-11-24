-- 023_team_managers.sql: team managers, and the roster a team sends for a game
-- before the scorer opens it (docs/team-managers-spec.md).
--
-- Owner decisions 2026-11-08:
--   a. a team manager manages one VolleyManager team of a club (club_teams),
--      or a few; the club's managers give a link (an invite code with the team)
--      and remove them; admins too;
--   b. the team manager edits its team's saved team and sends the roster of
--      each of its games ahead of time; the scorer's tablet downloads it and
--      Match Setup offers it, offline first.
--
-- No global role: profiles.roles is unchanged, so a team manager scores
-- nothing and manages nothing else (as a club manager, db/020).
--
-- 1. club_teams.id: a stable id per team (lib/clubs.js writes the team list
--    as a diff from now on, so a kept team keeps its id and its managers).
-- 2. team_managers(team_id, user_id): who manages which team.
-- 3. invite_codes: role 'team_manager', with team_id (the team whoever
--    redeems the code manages). A code of a removed team goes with it.
-- 4. game_rosters: one team's roster of one game (personal data: names,
--    dates of birth, licence numbers, optional coach and captain signatures
--    made ahead). Owner 2026-11-08: no lock (the team may change it at any
--    time), and deleted as soon as the scorer accepts it: the content goes,
--    a row without personal data stays (used_at, used_by) so the team sees
--    it was accepted. lib/teams.js sweeps every row 14 days after the game.
--
-- roles.sql: no change (ov_app's default privileges cover new tables); run
-- apply-roles.sh after this file as with every migration all the same.
-- None of these tables is on the /api/db allowlist (server.js ALLOWED_TABLES):
-- only lib/teams.js and lib/accounts.js read and write them.
--
-- Idempotent. Deploy: 023, apply-roles.sh, the backend image, the manager,
-- then the scorer apps. Old apps never ask for a game roster.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. a stable id per club team
ALTER TABLE public.club_teams ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS club_teams_id_uidx ON public.club_teams (id);

-- 2. team managers
CREATE TABLE IF NOT EXISTS public.team_managers (
  team_id     uuid        NOT NULL REFERENCES public.club_teams(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_by    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS team_managers_user_idx ON public.team_managers (user_id);

-- 3. the team link: an invite code for a team
ALTER TABLE public.invite_codes ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.club_teams(id) ON DELETE CASCADE;
DO $$
DECLARE c record;
BEGIN
  -- the role list of 007 (or of a restored older schema), whatever its name:
  -- every CHECK on invite_codes that names the role column but this one
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.invite_codes'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ~ '\mrole\M'
              AND conname <> 'invite_codes_role_team_check'
  LOOP
    EXECUTE format('ALTER TABLE public.invite_codes DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invite_codes_role_team_check' AND conrelid = 'public.invite_codes'::regclass) THEN
    ALTER TABLE public.invite_codes ADD CONSTRAINT invite_codes_role_team_check CHECK (
      (role IN ('scorer', 'referee', 'competition_manager') AND team_id IS NULL)
      OR (role = 'team_manager' AND team_id IS NOT NULL AND sport = 'indoor'));
  END IF;
END $$;

-- 4. a team's roster of one game, sent ahead
CREATE TABLE IF NOT EXISTS public.game_rosters (
  game_number text        NOT NULL CHECK (game_number ~ '^[0-9]{1,12}$'),
  season      integer     NOT NULL CHECK (season BETWEEN 2000 AND 2100),
  side        text        NOT NULL CHECK (side IN ('home', 'away')),
  team_name   text        NOT NULL CHECK (length(btrim(team_name)) BETWEEN 1 AND 200),
  players     jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(players) = 'array' AND jsonb_array_length(players) <= 14),
  staff       jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(staff) = 'array' AND jsonb_array_length(staff) <= 5),
  kickoff     text,
  coach_signature   text  CHECK (coach_signature IS NULL OR (left(coach_signature, 22) = 'data:image/png;base64,' AND length(coach_signature) <= 200000)),
  captain_signature text  CHECK (captain_signature IS NULL OR (left(captain_signature, 22) = 'data:image/png;base64,' AND length(captain_signature) <= 200000)),
  used_at     timestamptz,
  used_by     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_number, season, side)
);
CREATE INDEX IF NOT EXISTS game_rosters_updated_idx ON public.game_rosters (updated_at);

COMMENT ON TABLE public.team_managers IS 'Accounts that manage a club team: its saved team and its game rosters (db/023).';
COMMENT ON COLUMN public.invite_codes.team_id IS 'The team a team_manager code gives (db/023).';
COMMENT ON TABLE public.game_rosters IS 'A team''s roster of one game, sent before the match exists; its content is deleted when the scorer accepts it, the row 14 days after the game (db/023).';

COMMIT;
