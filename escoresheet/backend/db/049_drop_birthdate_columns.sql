-- 049_drop_birthdate_columns.sql: the date-of-birth columns go
--
-- db/048 (owner 2026-11-19: "delete bdates from everywhere") cleared them and
-- kept the columns, because installed apps still select some of them
-- (referee_database.dob in the referee picker of apps before 3.5.0,
-- svrz_games.referee_1_dob / referee_2_dob through the official-match
-- loader's '*', profiles.dob through the account's '*'). Since the backend
-- of openvolley#288, /api/db reads them as NULL whether the table
-- has them or not (lib/pgQuery.js nullColumns = lib/publicColumns.js
-- DOB_COLUMNS: named or with '*', never written, no filter, order or conflict
-- target), so those apps keep working without them. This file drops:
--   profiles.dob, referee_database.dob, svrz_games.referee_1_dob /
--   referee_2_dob, competition_players.dob, competition_staff.dob,
--   club_licences.dob
-- each only where the table and the column exist (profiles,
-- referee_database and svrz_games come from the Supabase-era restore, not
-- from a numbered file). A value left in one goes with it.
--
-- Indexes and constraints on a column go with it (ALTER TABLE ... DROP
-- COLUMN), each named in a NOTICE. The production directory's unique index
-- on referee_database (first_name, last_name, dob) is dropped and NOT
-- replaced: since db/048 every dob is NULL, which the index takes as distinct,
-- so it has enforced nothing since; a unique (first_name, last_name) would
-- fail on the namesakes and duplicates already there and refuse a second
-- referee of the same name (the picker keys the rows by id since db/048).
--
-- Views: the operator's ov_read views (roles.sql: one per table, naming its
-- columns) depend on the columns; the ones of these tables are dropped here
-- and rebuilt without the columns by the next roles.sql run (apply-roles.sh,
-- which deploy.sh runs right after the migrations). Any other object that
-- depends on a column (a view outside ov_read, a function body) stops the
-- file: nothing changes, and the error names it.
--
-- DEPLOY ORDER: the backend serving while this runs must be one with
-- pgQuery's nullColumns (openvolley#288) and vmSync without the
-- dob columns: an older backend's catalog still lists the columns, so its
-- '*' selects fail (42703) until its catalog is read again, its selects that
-- name a dob column fail for good (PGRST204), and its schedule sync's upsert
-- names referee_1_dob. Deploy that backend first, then this file.
--
-- One transaction (scripts/migrate.mjs); each ALTER waits at most
-- lock_timeout for its table. Idempotent: a second run finds no column and
-- changes nothing.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  c record;
  d record;
  att smallint;
BEGIN
  FOR c IN
    SELECT x.t, x.col, to_regclass(x.t) AS rel FROM (VALUES
      ('public.profiles', 'dob'),
      ('public.referee_database', 'dob'),
      ('public.svrz_games', 'referee_1_dob'),
      ('public.svrz_games', 'referee_2_dob'),
      ('public.competition_players', 'dob'),
      ('public.competition_staff', 'dob'),
      ('public.club_licences', 'dob')) AS x(t, col)
  LOOP
    CONTINUE WHEN c.rel IS NULL;
    SELECT a.attnum INTO att FROM pg_attribute a WHERE a.attrelid = c.rel AND a.attname = c.col AND NOT a.attisdropped;
    CONTINUE WHEN att IS NULL;
    -- the ov_read views on the column (roles.sql rebuilds them)
    FOR d IN
      SELECT DISTINCT v.oid::regclass AS view
        FROM pg_depend dep
        JOIN pg_rewrite rw ON rw.oid = dep.objid
        JOIN pg_class v ON v.oid = rw.ev_class
        JOIN pg_namespace n ON n.oid = v.relnamespace
       WHERE dep.classid = 'pg_rewrite'::regclass AND dep.refclassid = 'pg_class'::regclass
         AND dep.refobjid = c.rel AND dep.refobjsubid = att AND v.oid <> c.rel AND n.nspname = 'ov_read'
    LOOP
      RAISE NOTICE 'db/049: view % dropped (roles.sql rebuilds it without %)', d.view, c.col;
      EXECUTE format('DROP VIEW %s', d.view);
    END LOOP;
    -- the indexes and constraints that go with the column
    FOR d IN
      SELECT DISTINCT i.indexrelid::regclass AS idx
        FROM pg_index i
        JOIN pg_depend dep ON dep.classid = 'pg_class'::regclass AND dep.objid = i.indexrelid
       WHERE i.indrelid = c.rel AND dep.refclassid = 'pg_class'::regclass AND dep.refobjid = c.rel AND dep.refobjsubid = att
    LOOP
      RAISE NOTICE 'db/049: index % goes with %.% (not replaced)', d.idx, c.t, c.col;
    END LOOP;
    FOR d IN
      SELECT con.conname FROM pg_constraint con WHERE con.conrelid = c.rel AND att = ANY(con.conkey)
    LOOP
      RAISE NOTICE 'db/049: constraint % goes with %.%', d.conname, c.t, c.col;
    END LOOP;
    EXECUTE format('ALTER TABLE %s DROP COLUMN %I', c.rel, c.col);
    RAISE NOTICE 'db/049: %.% dropped', c.t, c.col;
  END LOOP;
END $$;

COMMIT;
