-- 027_account_deactivate.sql: an admin deactivates an account without deleting it.
--
-- Owner, 2026-11-11: "add a deactivate button: deactivate but not delete".
-- A deactivated account cannot sign in (password, passkey, approval PIN) and
-- its sessions end; its roles, clubs, teams, matches and audit entries stay,
-- and Reactivate undoes it. lib/accounts.js setActive writes
-- auth.users.banned_until (9999-12-31, or NULL to reactivate); lib/auth.js
-- isUserBlocked already refuses a user whose banned_until is in the future.
--
-- The column comes from the Phase 0 import (db/000_prelude.sql) and exists in
-- production; this file only makes sure of it on a database built another
-- way. Idempotent, one statement, safe while the running backend serves.
-- Deploy: this file before the backend image.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;

COMMIT;
