-- 038_audit_protection.sql: approvals are only removed with their match, and
-- the admin audit log keeps no e-mail address.
--
-- Before: public.match_approvals (db/011) was guarded against UPDATE only, so
-- the backend role could delete a referee's approval of a closed match. And
-- the audit entries of an admin's "add editor" (match.editor_add) and "edit
-- details" (account.profile) held the plain addresses, which outlived the
-- account (its deletion keeps only a digest, lib/accounts.js deleteAccount).
--
-- Now:
--   match_approvals_delete_guard  BEFORE DELETE: refuses unless the match is
--                                 gone already, i.e. the ON DELETE CASCADE of
--                                 deleting the match (test matches, retention).
--   audit_log                     the addresses of those two actions are
--                                 replaced by their digest (email_sha256, the
--                                 same as lib/accounts.js emailDigest).
-- The grants (no UPDATE / DELETE of audit_log for ov_app) are in roles.sql.
-- Idempotent; one transaction (scripts/migrate.mjs).

CREATE OR REPLACE FUNCTION public.ov_match_approvals_delete_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- In the cascade the match row is already deleted in this transaction.
  IF EXISTS (SELECT 1 FROM public.matches WHERE id = OLD.match_id) THEN
    RAISE EXCEPTION 'match_approvals: an approval is only deleted with its match (cascade)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS match_approvals_delete_guard ON public.match_approvals;
CREATE TRIGGER match_approvals_delete_guard
  BEFORE DELETE ON public.match_approvals
  FOR EACH ROW EXECUTE FUNCTION public.ov_match_approvals_delete_guard();

CREATE OR REPLACE FUNCTION pg_temp.ov_email_digest(e text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN e IS NULL THEN NULL
              ELSE encode(sha256(convert_to('ov-account-email:' || lower(btrim(e)), 'UTF8')), 'hex') END
$$;

-- match.editor_add: { email } -> { email_sha256 }
UPDATE public.audit_log
   SET details = (details - 'email') || jsonb_build_object('email_sha256', pg_temp.ov_email_digest(details ->> 'email'))
 WHERE action = 'match.editor_add' AND details ? 'email';

-- account.profile: before.email / after.email -> before.email_sha256 / after.email_sha256
UPDATE public.audit_log
   SET details = jsonb_set(jsonb_set(details,
         '{before}', ((details -> 'before') - 'email') || jsonb_build_object('email_sha256', pg_temp.ov_email_digest(details #>> '{before,email}'))),
         '{after}', ((details -> 'after') - 'email') || jsonb_build_object('email_sha256', pg_temp.ov_email_digest(details #>> '{after,email}')))
 WHERE action = 'account.profile'
   AND jsonb_typeof(details -> 'before') = 'object' AND jsonb_typeof(details -> 'after') = 'object'
   AND ((details -> 'before') ? 'email' OR (details -> 'after') ? 'email');
