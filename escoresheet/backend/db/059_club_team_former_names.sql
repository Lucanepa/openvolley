-- 059_club_team_former_names.sql: the names a club team had before the
-- schedule sync renamed it (audit 26.11, LOG-24)
--
-- Since a66c1abba the schedule (svrz_games) holds Romandie and Ticino team
-- names in their region's language. The sync renames a club's team from its
-- German name to the region's (lib/vmSync.js followTeamRenames), so that the
-- club rule (db/018), the final mail and the take-over of a held game match
-- the schedule again. The matches the club's scorers stored before keep the
-- name of their day (home_team / away_team ->> 'name'): the club API
-- (/api/club/v1/matches) and the public ?club= list pick a club's matches by
-- those names, so they need the old name as well as the new one.
--
--   club_teams.former_names  text[], the team's earlier names, oldest first
--                            (at most 10): the sync appends the German name
--                            it renames from. Read with team_name by
--                            lib/publicApi.js clubTeamNames, unless another
--                            club's team has that name today.
-- Each rename is in the audit log (club.update, details.by 'vm-sync').
--
-- Safe while the old backend serves: a new column with a constant default
-- (no table rewrite, PostgreSQL 11+); the old backend never names it.
-- Idempotent; one transaction (scripts/migrate.mjs); waits at most
-- lock_timeout for club_teams. No grant: roles.sql grants per table, and
-- its ov_read views follow the new column when it runs after this file.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.club_teams
  ADD COLUMN IF NOT EXISTS former_names text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.club_teams.former_names IS
  'The team''s earlier names, oldest first (at most 10): the German name the schedule sync renamed it from (db/059, lib/vmSync.js followTeamRenames). The club API and the public ?club= list match a club''s older matches by them.';

COMMIT;
