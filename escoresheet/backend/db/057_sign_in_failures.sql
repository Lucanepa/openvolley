-- 057_sign_in_failures.sql: the failed sign-ins of each address, and the
-- sources that signed in to it, so that the account-wide ceiling and its way
-- past for the owner survive a restart (lib/auth.js accountCeiling, audit
-- 2611 SEC-13).
--
-- Before, the only account-wide count was in the backend's memory (100 per 15
-- minutes, gone with every restart), and past it every new source still got
-- three tries: rotating through many IPv6 /64s guessed one account's
-- password without end, and nobody was told. Now each failed sign-in counts
-- here too. Past maxFailures (100) within the window (24 h) a source that
-- signed in to the account before still gets in as usual; all other sources
-- of that address together get one try per interval (1 min, doubling with
-- each further 100 failures, at most 1 h; 429 account_locked meanwhile). The
-- account is mailed and the admins told (the error tracker) once per window.
--
-- auth.sign_in_failures: one row per address with failed sign-ins, whether or
-- not it has an account (the answers must not tell which):
--   email_key    SHA-256 of 'ov-sign-in-failures:' + the lower-cased address
--                (the table holds no address)
--   window_start when the window of `failures` began (a failure after the
--                window starts a new one)
--   failures     failed sign-ins in the window
--   next_try_at  past the ceiling: when a new source may try again
--   alerted_at   when the account and the admins were told (once per window)
--   updated_at   the last failure
-- A new password (reset, change, the operator's script) and the account's
-- deletion delete the row; the hourly session sweep deletes rows whose
-- window is over. No IP address is stored.
--
-- auth.sign_in_sources: the sources (an IPv6 /64, an IPv4 address) that
-- signed in to an address, so that past the ceiling the owner's own still
-- get in after a restart or a deploy (before, they lived in the backend's
-- memory only, and a restart locked the owner out with the guessers):
--   email_key    as in sign_in_failures
--   source_key   HMAC-SHA256 of the address and the source, keyed with a
--                key derived from OV_PIN_SECRET (HKDF, info
--                'ov-sign-in-source-v1'): without the secret a row tells
--                nothing, not even which network (no address, no IP)
--   last_ok_at   the last sign-in from it
-- At most 20 per address (the oldest go). The account's deletion deletes
-- them; the hourly sweep deletes those older than 60 days. A backend without
-- OV_PIN_SECRET writes none.
--
-- Grants: roles.sql gives ov_app SELECT, INSERT, UPDATE, DELETE (its auth
-- block); this file does the same, so it holds before roles.sql runs again.
-- A backend without this file (or before the grant) counts in memory only,
-- as before; one with it on an older backend: empty tables nothing reads.
--
-- Safe on a live database: two new, empty tables. Idempotent; one transaction
-- (scripts/migrate.mjs). By hand:
--   docker exec -i ov-postgres psql -X -U ov_owner -d openvolley -v ON_ERROR_STOP=1 < db/057_sign_in_failures.sql
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS auth.sign_in_failures (
  email_key    bytea       PRIMARY KEY CONSTRAINT sign_in_failures_email_key_check CHECK (octet_length(email_key) = 32),
  window_start timestamptz NOT NULL DEFAULT now(),
  failures     integer     NOT NULL DEFAULT 0 CONSTRAINT sign_in_failures_failures_check CHECK (failures >= 0),
  next_try_at  timestamptz,
  alerted_at   timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- the hourly sweep (rows whose window is over)
CREATE INDEX IF NOT EXISTS sign_in_failures_window_idx ON auth.sign_in_failures (window_start);

CREATE TABLE IF NOT EXISTS auth.sign_in_sources (
  email_key  bytea       NOT NULL CONSTRAINT sign_in_sources_email_key_check CHECK (octet_length(email_key) = 32),
  source_key bytea       NOT NULL CONSTRAINT sign_in_sources_source_key_check CHECK (octet_length(source_key) = 32),
  last_ok_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (email_key, source_key)
);

-- the hourly sweep (sources not seen for 60 days)
CREATE INDEX IF NOT EXISTS sign_in_sources_last_ok_idx ON auth.sign_in_sources (last_ok_at);

COMMENT ON TABLE auth.sign_in_failures IS 'Failed sign-ins per address (SHA-256 key, no address, no IP) for the account-wide ceiling of lib/auth.js; rows go with a new password, the account or their 24 h window (db/057).';
COMMENT ON TABLE auth.sign_in_sources IS 'Sources that signed in to an address (keyed HMAC, no address, no IP): past the account-wide ceiling of lib/auth.js they still get in; at most 20 per address, gone with the account or after 60 days (db/057).';

-- The app role needs DML here. roles.sql grants it too; this covers running
-- the migration after roles.sql.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_app') THEN
    GRANT USAGE ON SCHEMA auth TO ov_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth.sign_in_failures TO ov_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth.sign_in_sources TO ov_app;
  END IF;
END $$;

COMMIT;
