-- 052_redacted_people.sql: the register of people erased on request, for the
-- schedule sync (data-map F27)
--
-- scripts/redact-person.mjs erases a person everywhere, the schedule
-- (svrz_games) included. The daily VolleyManager sync (lib/vmSync.js)
-- overwrites every column of each game from yesterday to 14 days ahead, so
-- while VolleyManager still lists that referee, the next run wrote the name
-- and (db/051) the licence number back. redact-person now registers the
-- person here, and the sync writes NULL for a registered referee's names and
-- licence number and for a registered line judge (lib/redactedPeople.js).
--
-- public.redacted_people: no name and no number, only keyed hashes:
--   hash        HMAC-SHA256 with a key derived from OV_PIN_SECRET (HKDF,
--               "ov-redacted-person-v1") of the normalised first and last name
--               (kind 'name') or of a licence number (kind 'licence'). The key
--               is not in the database or its backups: a dump alone tells no
--               name. The column name keeps it out of the SQL browser's
--               ov_read views and the Data tab (their "...hash" rule).
--   kind        'name' or 'licence'
--   created_at  when it was registered
-- Kept as long as the service runs (a request does not expire); not swept by
-- the retention (lib/retention.js does not name it).
--
-- Grants: the backend (ov_app) reads it only (the sync); written by the owner
-- role (redact-person). roles.sql grants DML on every public table and then
-- takes it back from this one; this file does the same, so it holds before
-- roles.sql runs again. Not on the /api/db allowlist (lib/pgQuery.js); read
-- only in the Data tab (lib/dataAdmin.js READ_ONLY_TABLES).
--
-- Safe while the old backend serves: a new, empty table nothing of it reads.
-- Idempotent; one transaction (scripts/migrate.mjs). By hand:
--   docker exec -i ov-postgres psql -X -U ov_owner -d openvolley -v ON_ERROR_STOP=1 < db/052_redacted_people.sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.redacted_people (
  hash       bytea       PRIMARY KEY CONSTRAINT redacted_people_hash_check CHECK (octet_length(hash) = 32),
  kind       text        NOT NULL CONSTRAINT redacted_people_kind_check CHECK (kind IN ('name', 'licence')),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.redacted_people IS
  'People erased on request (scripts/redact-person.mjs): keyed hashes (HMAC, key from OV_PIN_SECRET) of a name or a licence number, never the name; the VolleyManager sync leaves a registered referee empty (db/052, lib/redactedPeople.js).';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.redacted_people FROM ov_app;
    GRANT SELECT ON public.redacted_people TO ov_app;
  END IF;
END $$;

COMMIT;
