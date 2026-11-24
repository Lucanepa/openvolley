-- 022: passkeys (lib/passkeys.js, lib/auth.js). Sign-in with the device's
-- fingerprint, face or PIN: the device keeps a private key, this table the
-- matching PUBLIC key, one row per device key. Relying party openvolley.app,
-- so one key works on every OpenVolley and OpenBeach site. Optional: without
-- the table the passkey actions answer 503 and everything else is unchanged.
--
--   credential_id  the device's name for the key (base64url), unique
--   public_key     COSE public key, base64url
--   counter        the device's signature count (never goes backwards)
--   label          "iPhone · Safari", from the user agent at set-up
--
-- Account deletion removes the rows through the FK cascade; setting a new
-- password (reset link, operator CLI) deletes them in its transaction.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS auth.passkeys (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  credential_id  text        NOT NULL UNIQUE CHECK (credential_id ~ '^[A-Za-z0-9_-]+$' AND length(credential_id) <= 1024),
  public_key     text        NOT NULL CHECK (length(public_key) BETWEEN 1 AND 4096),
  counter        bigint      NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports     text[]      NOT NULL DEFAULT '{}',
  backed_up      boolean     NOT NULL DEFAULT false,
  label          text        NOT NULL DEFAULT '' CHECK (length(label) <= 80),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);

-- "the keys of this account": the profile list, the per-account cap.
CREATE INDEX IF NOT EXISTS passkeys_user_idx ON auth.passkeys (user_id);

-- The app role needs DML here. roles.sql grants it too; this covers running
-- the migration after roles.sql.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_app') THEN
    GRANT USAGE ON SCHEMA auth TO ov_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth.passkeys TO ov_app;
  END IF;
END $$;

COMMIT;
