/**
 * restore.sh --scrub-except (be-db-migrations-4): the database it marks
 * "(rehearsal, scrubbed)" (the template pgTestDb.js copies for every test
 * file) kept the rosters, birth dates, signatures and referee names of the
 * dump. The scrub SQL is taken from restore.sh itself and run with psql on
 * a throwaway database holding such rows.
 * db/043 (be-db-migrations-9) drops the Supabase SECURITY DEFINER helpers
 * and their triggers such a dump brings along.
 * Needs PG_TEST_URL and psql on the PATH.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'

const here = dirname(fileURLToPath(import.meta.url))
const restoreSh = readFileSync(join(here, '..', 'scripts', 'migrate', 'restore.sh'), 'utf8')
// The rehearsal password's bcrypt hash needs pgcrypto, which the test
// databases already have: a fixed hash instead, the rest unchanged.
const SCRUB_SQL = restoreSh.split(`cat >"$WORK/scrub.sql" <<'SQL'\n`)[1].split('\nSQL\n')[0]
  .replace(/CREATE SCHEMA ov_scrub;[\s\S]*?DROP SCHEMA ov_scrub;/, "SELECT set_config('ov.scrub_hash', 'x', true);")

describe('restore.sh --scrub-except', { skip: SKIP_PG }, () => {
  let db, sql, keep, other

  before(async () => {
    db = await createTestDatabase('scrub')
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    keep = (await sql.query("INSERT INTO auth.users (email) VALUES ('keeper@example.invalid') RETURNING id")).rows[0].id
    other = (await sql.query("INSERT INTO auth.users (email, raw_user_meta_data) VALUES ('player.parent@example.invalid', '{\"first_name\":\"Anna\"}') RETURNING id")).rows[0].id
    await sql.query("INSERT INTO public.profiles (user_id, first_name, last_name, dob) VALUES ($1, 'Kim', 'Keeper', '1990-01-01'), ($2, 'Anna', 'Example', '2011-05-05')", [keep, other])
    await sql.query(`INSERT INTO public.matches (external_id, game_n, status, players_home, players_away, officials, signatures, remarks)
      VALUES ('match_1_aaa', 1, 'final', '[{"first_name":"Lea","last_name":"Muster","dob":"2010-02-03","licence":"12345"}]'::jsonb,
              '[{"first_name":"Ben"}]'::jsonb, '[{"role":"1st referee","name":"Rita Ref"}]'::jsonb, '{"home_captain":"data:image/png;base64,AAAA"}'::jsonb, 'Lea injured')`)
    await sql.query("INSERT INTO public.referee_database (first_name, last_name, dob) VALUES ('Rita', 'Ref', '1980-03-03')")
    await sql.query("INSERT INTO public.svrz_games (game_number, team_home, referee_1, referee_1_first_name, referee_1_dob) VALUES ('1001', 'Home Team', 'Ref, Rita', 'Rita', '1980-03-03')")
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await db?.drop()
  })

  it('leaves no personal data outside the kept account, and keeps every row', async () => {
    const before = (await sql.query('SELECT (SELECT count(*) FROM public.matches) m, (SELECT count(*) FROM public.svrz_games) g')).rows[0]
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', db.url], {
      input: "\\set keep_email 'keeper@example.invalid'\n\\set scrub_pw 'rehearsal-pw-1'\n" + SCRUB_SQL,
      stdio: ['pipe', 'ignore', 'pipe']
    })
    const m = (await sql.query("SELECT players_home, players_away, officials, signatures, remarks FROM public.matches WHERE external_id = 'match_1_aaa'")).rows[0]
    assert.ok(m, 'the match row stays')
    const dump = JSON.stringify(m) + JSON.stringify((await sql.query('SELECT * FROM public.referee_database')).rows) +
      JSON.stringify((await sql.query('SELECT * FROM public.svrz_games')).rows) +
      JSON.stringify((await sql.query('SELECT * FROM public.profiles WHERE user_id = $1', [other])).rows) +
      JSON.stringify((await sql.query('SELECT email, raw_user_meta_data FROM auth.users WHERE id = $1', [other])).rows)
    for (const word of ['Lea', 'Muster', '2010-02-03', '12345', 'Ben', 'Rita', 'base64', 'Anna', '2011-05', 'player.parent', '1980-03']) {
      assert.equal(dump.includes(word), false, `${word} left after the scrub`)
    }
    assert.equal((await sql.query('SELECT first_name FROM public.profiles WHERE user_id = $1', [keep])).rows[0].first_name, 'Kim')
    assert.equal((await sql.query("SELECT game_number FROM public.svrz_games")).rows[0].game_number, '1001')
    const after = (await sql.query('SELECT (SELECT count(*) FROM public.matches) m, (SELECT count(*) FROM public.svrz_games) g')).rows[0]
    assert.deepEqual(after, before)
  })

  it('db/043 drops the Supabase definer helpers and their trigger, and runs again on a database without them', async () => {
    await sql.query(`CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
      CREATE FUNCTION public.delete_user() RETURNS void LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
      CREATE FUNCTION public.reset_test_match(text) RETURNS void LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';`)
    const m043 = readFileSync(join(here, '..', 'db', '043_drop_supabase_definers.sql'), 'utf8')
    await sql.query(m043)
    await sql.query(m043)
    const left = await sql.query(`SELECT proname FROM pg_proc WHERE proname IN ('delete_user', 'reset_test_match', 'handle_new_user')
      UNION ALL SELECT tgname FROM pg_trigger WHERE tgname = 'on_auth_user_created'`)
    assert.deepEqual(left.rows, [])
  })
})
