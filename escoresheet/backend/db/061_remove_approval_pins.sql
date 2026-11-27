-- 061_remove_approval_pins.sql: approval with a PIN was removed (owner
-- 27.11.2026: officials sign by hand). The app no longer offers it and the
-- server answers its paths 410 OV_APPROVAL_REMOVED, so the stored approval
-- PINs (db/011 auth.approval_pins: a salted HMAC per account, never the PIN)
-- have no use left: this deletes them.
--
-- Only the rows go. The tables (auth.approval_pins, public.match_approvals),
-- their triggers and the ov_read view stay until a later migration drops
-- them; account deletion and scripts/redact-person.mjs still read them.
-- OV_PIN_SECRET stays: it also hashes the game PINs (lib/pinHash.js).
--
-- Safe on a live database (nothing writes the table any more). Idempotent;
-- one transaction (scripts/migrate.mjs). By hand:
--   docker exec -i ov-postgres psql -X -U ov_owner -d openvolley -v ON_ERROR_STOP=1 < db/061_remove_approval_pins.sql
BEGIN;
SET LOCAL lock_timeout = '5s';

DELETE FROM auth.approval_pins;

COMMIT;
