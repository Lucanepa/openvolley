-- 048_no_birthdates.sql: no birthdates outside a match's own sheet
--
-- Owner 2026-11-19: "for switzerland: import only the licence number from the
-- einsatzliste etc. also on club manager/team manager etc: ONLY licence
-- number. delete bdates from everywhere, also sign up etc." and, for the
-- sheets already stored: "Scrub past sheets too". From the backend image of
-- this file on:
--   * sign-up and the profile keep first and last name, email and an optional
--     licence number (profiles.license_number, below); no date of birth;
--   * club lists, squads, game rosters, the referee directory and the
--     schedule carry none (lib/licences.js, savedTeams.js, teams.js, auth.js,
--     vmSync.js and server.js drop one that is sent and never return one);
--   * a match's own sheet carries a date of birth only where its scorer types
--     one (a Swiss sheet's value beside the name is the licence number).
--
-- This file deletes the dates of birth stored so far:
--   1. NULL: profiles.dob, referee_database.dob (the unique index on
--      first_name, last_name, dob takes NULLs as distinct: no conflict),
--      svrz_games.referee_1_dob / referee_2_dob, competition_players.dob,
--      competition_staff.dob, club_licences.dob.
--   2. The key dob goes from auth.users.raw_user_meta_data (and
--      auth.users_import, a restore's staging copy) and from every entry of
--      game_rosters.players / staff.
--   3. Past sheets: a person's value beside the name that is a DATE becomes
--      null; a licence number stays. A date is d.m.yy(yy) with '.', '/' or '-'
--      between, or an ISO yyyy-mm-dd (the rule the scorer app shares,
--      frontend domain/idMode.js); 01.01.1900, the placeholder, is one; digits
--      only are a licence. In every JSON column of public.matches (rosters,
--      benches, officials, the teams' uploaded rosters in connections,
--      manual_changes, coin_toss ...), match_closures (closed_record,
--      reclosed_record), events (payload, state_snapshot, line-ups),
--      event_revisions (before, after), match_live_state,
--      beach_competition_matches and beach_entries: a key named dob,
--      dateOfBirth, date_of_birth, birthDate, birthdate, birth_date or ending
--      in one of them (referee_1_dob, ref1Dob ...), and the before / after of
--      a manual change of such a field. A date-of-birth correction in the
--      remarks and in a manual change's description ("Player #7 dob:
--      03.05.2011 → 04.06.2011 (Team)") keeps the change and loses the dates:
--      "Player #7 date of birth changed (Team)" (the rule of
--      lib/publicColumns.js redactRemarkDobs). Beach and test matches too.
--      The closed-match guards (db/007, 039) let these writes through, as an
--      admin's reopen (ov.allow_closed); nothing reopens, no approval is
--      voided (db/011 fires on a reopen, a status or a team name only).
--      The matches' updated_at moves (db/006) and their sheets count as
--      changed (db/045): the stored PDFs are out of date until rebuilt.
-- The stored scoresheet PDFs are rebuilt from the scrubbed records by
-- scripts/scrub-sheet-birthdates.mjs: a deploy step after this file and the
-- backend image (dry run first, then --apply). It also deletes again a date
-- of birth that the old backend stored between this file and the switch.
--
-- Also:
--   * profiles.license_number: 4 to 7 digits or NULL; the account's own
--     through /api/db (owner-scoped as the rest of the profile);
--   * club_licences_source_check takes 'match' as well (a person saved from
--     an official match's roster).
--
-- The dob columns stay: /api/db refuses a select of a column the table does
-- not have, and installed apps still select referee_database.dob and
-- svrz_games.referee_1_dob. A later 049 drops them once those apps are gone.
--
-- Safe while the old backend serves: it reads the columns as before (now
-- NULL), never reads license_number, and the CHECK holds for every row (the
-- column is new). Each write locks only the rows it changes; the ALTERs wait
-- at most lock_timeout. Idempotent (a second run changes nothing); one
-- transaction (scripts/migrate.mjs). roles.sql: no change (ov_app's DML
-- covers the new column; the ov_read views are rebuilt by every
-- apply-roles.sh run); run apply-roles.sh after this file as with every
-- migration all the same.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- the closed-match guards (db/007, 039) let the scrub of a closed match through
SET LOCAL ov.allow_closed = 'on';

-- A date of birth as the sheet keeps one (not a licence number)
CREATE OR REPLACE FUNCTION pg_temp.ov048_is_date(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT v IS NOT NULL AND (btrim(v) ~ '^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$' OR btrim(v) ~ '^\d{4}-\d{2}-\d{2}')
$$;

-- The name of a key or a manual change's field that holds a date of birth
CREATE OR REPLACE FUNCTION pg_temp.ov048_is_dob_key(k text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT k IS NOT NULL AND k ~* '(dob|date_?of_?birth|birth_?date)$'
$$;

-- lib/publicColumns.js redactRemarkDobs: "dob: <old> → <new>" (or ->) to the
-- end of its line, or to the line's trailing " (Team)", becomes "date of
-- birth changed"; the rest of the text as it is
CREATE OR REPLACE FUNCTION pg_temp.ov048_remark(t text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  n       int;
  acc     text := '';
  copied  int := 1;   -- the next character not yet copied (1-based)
  pos     int := 1;   -- where the next search starts
  hit     int;        -- where "dob: " starts (1-based)
  line_end int;
  rest    text;
  rlen    int;
  arrow   int;
  a2      int;
  val     int;        -- where the value after the arrow starts in rest (1-based)
  lbl     int;        -- where the trailing " (Team)" starts in rest, 0 when none
  label_text text;
BEGIN
  IF t IS NULL OR strpos(t, 'dob: ') = 0 THEN RETURN t; END IF;
  n := length(t);
  LOOP
    hit := strpos(substr(t, pos), 'dob: ');
    EXIT WHEN hit = 0;
    hit := pos + hit - 1;
    IF hit > 1 AND substr(t, hit - 1, 1) ~ '[A-Za-z0-9_]' THEN
      pos := hit + 1;
      CONTINUE;
    END IF;
    line_end := coalesce(nullif(strpos(substr(t, hit), E'\n'), 0) + hit - 1, n + 1);
    line_end := least(line_end, coalesce(nullif(strpos(substr(t, hit), E'\r'), 0) + hit - 1, n + 1));
    line_end := least(line_end, coalesce(nullif(strpos(substr(t, hit), U&'\2028'), 0) + hit - 1, n + 1));
    line_end := least(line_end, coalesce(nullif(strpos(substr(t, hit), U&'\2029'), 0) + hit - 1, n + 1));
    rest := substr(t, hit, line_end - hit);
    rlen := length(rest);
    -- the first arrow after at least one character of the old value
    arrow := strpos(substr(rest, 7), ' → ');
    a2 := strpos(substr(rest, 7), ' -> ');
    IF arrow > 0 AND (a2 = 0 OR arrow <= a2) THEN
      val := 6 + arrow + 3;
    ELSIF a2 > 0 THEN
      val := 6 + a2 + 4;
    ELSE
      val := 0;
    END IF;
    IF val = 0 OR val > rlen THEN
      pos := line_end;
      EXIT WHEN pos > n;
      CONTINUE;
    END IF;
    lbl := 0;
    IF right(rest, 1) = ')' AND strpos(rest, ' (') > 0 THEN
      -- the last " (" of the line (reverse(' (') = '( ')
      lbl := rlen - strpos(reverse(rest), '( ');
      IF lbl > 0 THEN
        label_text := substr(rest, lbl + 2, rlen - lbl - 2);
        IF strpos(label_text, '(') > 0 OR strpos(label_text, ')') > 0 THEN lbl := 0; END IF;
      END IF;
    END IF;
    acc := acc || substr(t, copied, hit - copied) || 'date of birth changed';
    IF lbl > val THEN
      copied := hit + lbl - 1;
    ELSE
      copied := hit + rlen;
    END IF;
    pos := copied;
    EXIT WHEN pos > n;
  END LOOP;
  IF copied = 1 THEN RETURN t; END IF;
  RETURN acc || substr(t, copied);
END
$$;

-- A JSON value without the dates of birth of its people (rule above); the
-- same value when there is none
CREATE OR REPLACE FUNCTION pg_temp.ov048_scrub(j jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  dob_field boolean;
  r jsonb;
BEGIN
  IF j IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(j) = 'array' THEN
    SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(e) IN ('object', 'array') THEN pg_temp.ov048_scrub(e) ELSE e END ORDER BY i), '[]'::jsonb)
      INTO r FROM jsonb_array_elements(j) WITH ORDINALITY AS x(e, i);
    RETURN r;
  END IF;
  IF jsonb_typeof(j) <> 'object' THEN RETURN j; END IF;
  -- a manual change of a date-of-birth field: { field: 'dob' | 'ref1.dob', before, after, description }
  dob_field := jsonb_typeof(j -> 'field') = 'string' AND pg_temp.ov048_is_dob_key(j ->> 'field');
  SELECT coalesce(jsonb_object_agg(k, CASE
           WHEN jsonb_typeof(v) = 'string' AND pg_temp.ov048_is_dob_key(k) AND pg_temp.ov048_is_date(v #>> '{}') THEN 'null'::jsonb
           WHEN dob_field AND k IN ('before', 'after') AND jsonb_typeof(v) = 'string' AND pg_temp.ov048_is_date(v #>> '{}') THEN 'null'::jsonb
           WHEN k IN ('description', 'remarks') AND jsonb_typeof(v) = 'string' THEN to_jsonb(pg_temp.ov048_remark(v #>> '{}'))
           WHEN jsonb_typeof(v) IN ('object', 'array') THEN pg_temp.ov048_scrub(v)
           ELSE v END), '{}'::jsonb)
    INTO r FROM jsonb_each(j) AS x(k, v);
  RETURN r;
END
$$;

-- Every JSON column of `tbl` (json, jsonb or text that holds JSON is left:
-- only json and jsonb) and, with `remarks`, its text column remarks: the
-- rows with something to scrub (a cheap text test first), rewritten
CREATE OR REPLACE FUNCTION pg_temp.ov048_scrub_table(tbl text) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  c record;
  n bigint := 0;
  k bigint;
BEGIN
  IF to_regclass(tbl) IS NULL THEN RETURN 0; END IF;
  FOR c IN
    SELECT a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ
      FROM pg_attribute a
     WHERE a.attrelid = to_regclass(tbl) AND a.attnum > 0 AND NOT a.attisdropped
       AND (format_type(a.atttypid, a.atttypmod) IN ('json', 'jsonb')
            OR (a.attname = 'remarks' AND format_type(a.atttypid, a.atttypmod) = 'text'))
     ORDER BY a.attnum
  LOOP
    IF c.typ = 'text' THEN
      EXECUTE format('UPDATE %s SET %I = pg_temp.ov048_remark(%I) WHERE strpos(%I, ''dob: '') > 0 AND pg_temp.ov048_remark(%I) IS DISTINCT FROM %I',
                     tbl, c.col, c.col, c.col, c.col, c.col);
    ELSE
      EXECUTE format('UPDATE %s SET %I = pg_temp.ov048_scrub(%I::jsonb)::%s WHERE %I::text ~* ''dob|birth'' AND pg_temp.ov048_scrub(%I::jsonb) IS DISTINCT FROM %I::jsonb',
                     tbl, c.col, c.col, c.typ, c.col, c.col, c.col);
    END IF;
    GET DIAGNOSTICS k = ROW_COUNT;
    n := n + k;
  END LOOP;
  RETURN n;
END
$$;

-- profiles: the licence number, no date of birth ------------------------------
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS license_number text;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'profiles_license_number_check' AND conrelid = 'public.profiles'::regclass) THEN
      ALTER TABLE public.profiles ADD CONSTRAINT profiles_license_number_check
        CHECK (license_number IS NULL OR license_number ~ '^[0-9]{4,7}$');
    END IF;
    COMMENT ON COLUMN public.profiles.license_number IS
      'The account''s licence number (Swiss Volley SV number, 4 to 7 digits), optional, set at sign-up or in the profile (db/048).';
  END IF;
END $$;

-- club_licences: rows saved from an official match's roster ('match') ---------
DO $$
BEGIN
  IF to_regclass('public.club_licences') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.club_licences'::regclass AND attname = 'source' AND NOT attisdropped) THEN
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'club_licences_source_check' AND conrelid = 'public.club_licences'::regclass
                  AND pg_get_constraintdef(oid) NOT LIKE '%match%') THEN
      ALTER TABLE public.club_licences DROP CONSTRAINT club_licences_source_check;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'club_licences_source_check' AND conrelid = 'public.club_licences'::regclass) THEN
      ALTER TABLE public.club_licences ADD CONSTRAINT club_licences_source_check
        CHECK (source IN ('import', 'manual', 'match'));
    END IF;
    COMMENT ON COLUMN public.club_licences.source IS
      'import: from the VolleyManager upload of the list; manual: added by hand by a team or club manager (db/026); match: from an official match''s roster (db/048); until an upload contains it.';
  END IF;
END $$;

-- 1. the dob columns: NULL ------------------------------------------------------
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT t, col FROM (VALUES
      ('public.profiles', 'dob'),
      ('public.referee_database', 'dob'),
      ('public.svrz_games', 'referee_1_dob'),
      ('public.svrz_games', 'referee_2_dob'),
      ('public.competition_players', 'dob'),
      ('public.competition_staff', 'dob'),
      ('public.club_licences', 'dob')) AS x(t, col)
    WHERE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass(x.t) AND a.attname = x.col AND NOT a.attisdropped)
  LOOP
    EXECUTE format('UPDATE %s SET %I = NULL WHERE %I IS NOT NULL', c.t, c.col, c.col);
  END LOOP;
END $$;

-- 2. the key dob of the accounts' metadata and of the sent game rosters ---------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['auth.users', 'auth.users_import'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass(t) AND a.attname = 'raw_user_meta_data'
                AND NOT a.attisdropped AND format_type(a.atttypid, a.atttypmod) = 'jsonb') THEN
      EXECUTE format('UPDATE %s SET raw_user_meta_data = raw_user_meta_data - ''dob'' WHERE raw_user_meta_data ? ''dob''', t);
    END IF;
  END LOOP;
  IF to_regclass('public.game_rosters') IS NOT NULL THEN
    UPDATE public.game_rosters g
       SET players = coalesce((SELECT jsonb_agg(CASE WHEN jsonb_typeof(e) = 'object' THEN e - 'dob' ELSE e END ORDER BY i)
                                 FROM jsonb_array_elements(g.players) WITH ORDINALITY AS x(e, i)), '[]'::jsonb),
           staff = coalesce((SELECT jsonb_agg(CASE WHEN jsonb_typeof(e) = 'object' THEN e - 'dob' ELSE e END ORDER BY i)
                               FROM jsonb_array_elements(g.staff) WITH ORDINALITY AS x(e, i)), '[]'::jsonb)
     WHERE jsonb_path_exists(g.players, '$[*].dob') OR jsonb_path_exists(g.staff, '$[*].dob');
  END IF;
END $$;

-- 3. past sheets ------------------------------------------------------------------
SELECT pg_temp.ov048_scrub_table(t)
  FROM unnest(ARRAY['public.matches', 'public.match_closures', 'public.events', 'public.event_revisions',
                    'public.match_live_state', 'public.beach_competition_matches', 'public.beach_entries']) AS t;

COMMIT;
