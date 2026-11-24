-- 031_manager_roles_definer.sql: the manager-role trigger of db/030 runs as
-- its owner.
--
-- Owner, 2026-11-11: a sign-up request could not be approved. Approving one
-- with a club manager or team manager part failed with 42501 "permission
-- denied for function ov_sync_manager_roles": the trigger function
-- ov_manager_rows_changed() calls ov_sync_manager_roles(), and roles.sql
-- revokes EXECUTE on every function from ov_app (only the trigger function
-- itself is exempt: EXECUTE is checked when a trigger is created, not when it
-- fires; a function it calls is checked at run time). Every write of
-- club_managers / team_managers by the backend failed the same way since
-- 030: approved requests, team links, club manager links, the admin's club
-- page.
--
-- Fix: the trigger function runs as its owner (SECURITY DEFINER, with a
-- fixed search_path), who may call ov_sync_manager_roles. It only touches
-- the rows of the account in NEW / OLD, as before. roles.sql: no change
-- (ov_app still has no EXECUTE on either function).
-- Idempotent. Deploy: 031, apply-roles.sh; no new image needed.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER FUNCTION public.ov_manager_rows_changed() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.ov_sync_manager_roles(uuid) SET search_path = public, pg_temp;

COMMIT;
