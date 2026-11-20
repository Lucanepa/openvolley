/**
 * db/049_drop_birthdate_columns.sql on a database in production's state
 * before it (the synthetic schema with 005 to 048 and 050, the directory's
 * unique key on the name and the date of birth, the operator's ov_read
 * views of roles.sql): the seven dob columns go, their indexes with them (not
 * replaced), the ov_read views of those tables are dropped for roles.sql to
 * rebuild, everything else stays; a view outside ov_read on a column stops
 * the file without a change; a second run changes nothing. Then the calls of
 * the installed apps through pgQuery (server.js nullColumns): selects of the
 * dropped columns answer null rows, writes with a dob succeed without it,
 * filters on them are refused; the deploy step scrubLeftovers skips them.
 * Made-up people only.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'
import { createPgQuery } from '../lib/pgQuery.js'
import { DOB_COLUMNS } from '../lib/publicColumns.js'
import { scrubLeftovers } from '../scripts/scrub-sheet-birthdates.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DB = join(here, '..', 'db')
const sqlOf = (f) => readFileSync(join(DB, f), 'utf8')
const FILE_049 = sqlOf('049_drop_birthdate_columns.sql')
const DROPPED = [['profiles', 'dob'], ['referee_database', 'dob'], ['svrz_games', 'referee_1_dob'], ['svrz_games', 'referee_2_dob'],
  ['competition_players', 'dob'], ['competition_staff', 'dob'], ['club_licences', 'dob']]
// production's order: 048 and 050 ran, 049 comes after them
const BEFORE_049 = [
  readFileSync(join(here, 'fixtures', 'synthetic_schema.sql'), 'utf8'),
  ...readdirSync(DB).filter((f) => /^0(0[5-9]|[1-3]\d|4[0-8]|50)_[a-z0-9_]+\.sql$/.test(f)).sort().map(sqlOf),
  sqlOf('current_definitions.sql'),
  'UPDATE public.club_rule SET enabled = false WHERE id;',
  // the production directory's unique key on the name and the date of birth
  'CREATE UNIQUE INDEX referee_database_name_dob_uidx ON public.referee_database (first_name, last_name, dob);',
  // roles.sql's operator views (one per table, naming its columns), a few of them
  `CREATE SCHEMA ov_read;
   CREATE VIEW ov_read.profiles AS SELECT id, user_id, first_name, last_name, dob FROM public.profiles;
   CREATE VIEW ov_read.referee_database AS SELECT id, first_name, last_name, dob FROM public.referee_database;
   CREATE VIEW ov_read.svrz_games AS SELECT id, game_number, referee_1_dob, referee_2_dob FROM public.svrz_games;
   CREATE VIEW ov_read.club_licences AS SELECT id, sv_number, dob FROM public.club_licences;
   CREATE VIEW ov_read.matches AS SELECT id, external_id FROM public.matches;`
].join('\n')

describe('db/049 (the date-of-birth columns go)', { skip: SKIP_PG }, () => {
  let tdb, raw, db
  const id = {}
  const one = async (sql, args = []) => (await raw.query(sql, args)).rows[0]
  const hasColumn = async (t, c) => (await one(
    'SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = $2 AND NOT attisdropped) AS ok', [`public.${t}`, c])).ok
  const columnsLeft = async () => {
    const left = []
    for (const [t, c] of DROPPED) if (await hasColumn(t, c)) left.push(`${t}.${c}`)
    return left
  }
  const views = async () => (await raw.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ov_read' ORDER BY 1")).rows.map((r) => r.relname)

  before(async () => {
    tdb = await createTestDatabase('mig049', { schemaSql: BEFORE_049 })
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    id.user = (await one("INSERT INTO auth.users (email) VALUES ('mia@example.test') RETURNING id")).id
    await raw.query("INSERT INTO public.profiles (user_id, first_name, last_name, license_number) VALUES ($1, 'Mia', 'Muster', '123456')", [id.user])
    // two referees of one name (the key took the NULL dates as distinct)
    await raw.query(`INSERT INTO public.referee_database (first_name, last_name, country, sport_type) VALUES
      ('Max', 'Pfiff', 'CHE', '["indoor"]'), ('Max', 'Pfiff', 'CHE', '["indoor"]')`)
    await raw.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, referee_1_first_name, referee_1_last_name)
      VALUES ('490001', 'VBC Musterdorf H1', 'VBC Beispiel H2', 'Max', 'Pfiff')`)
    const comp = await one("INSERT INTO public.competitions (name, season) VALUES ('2. Liga', '2026/27') RETURNING id")
    const team = await one("INSERT INTO public.competition_teams (competition_id, name) VALUES ($1, 'VBC Musterdorf') RETURNING id", [comp.id])
    await raw.query("INSERT INTO public.competition_players (team_id, number, last_name, license_number) VALUES ($1, 7, 'Muster', '123456')", [team.id])
    await raw.query("INSERT INTO public.competition_staff (team_id, role, last_name, license_number) VALUES ($1, 'Coach', 'Trainer', '654321')", [team.id])
    const club = await one("INSERT INTO public.clubs (name) VALUES ('VBC Musterdorf') RETURNING id")
    await raw.query("INSERT INTO public.club_licences (club_id, list, sv_number, last_name) VALUES ($1, 'players', '123456', 'Muster')", [club.id])
  })

  after(async () => {
    await db?.close()
    await raw?.end()
    await tdb?.drop()
  })

  it('a view outside ov_read on a column stops the file: nothing changes, the error names it', async () => {
    await raw.query('CREATE VIEW public.profile_birthdays AS SELECT user_id, dob FROM public.profiles')
    const err = await raw.query(FILE_049).then(() => null, (e) => e)
    await raw.query('ROLLBACK')
    assert.ok(err, 'the file stops')
    assert.match(`${err.message} ${err.detail}`, /profile_birthdays/)
    assert.equal((await columnsLeft()).length, DROPPED.length)
    assert.deepEqual(await views(), ['club_licences', 'matches', 'profiles', 'referee_database', 'svrz_games'])
    await raw.query('DROP VIEW public.profile_birthdays')
  })

  it('drops the seven columns, their index and the ov_read views on them; nothing else', async () => {
    const notices = []
    const onNotice = (n) => notices.push(n.message)
    raw.on('notice', onNotice)
    try {
      await raw.query(FILE_049)
    } finally {
      raw.off('notice', onNotice)
    }
    assert.deepEqual(await columnsLeft(), [])
    // the key on (first_name, last_name, dob) is gone and not replaced: the namesakes stay
    assert.equal((await one("SELECT to_regclass('public.referee_database_name_dob_uidx') AS r")).r, null)
    assert.equal((await one("SELECT count(*)::int AS n FROM pg_index WHERE indrelid = 'public.referee_database'::regclass AND indisunique AND NOT indisprimary")).n, 0)
    assert.equal((await one("SELECT count(*)::int AS n FROM public.referee_database WHERE first_name = 'Max' AND last_name = 'Pfiff'")).n, 2)
    // the ov_read views of the tables went (roles.sql rebuilds them); the others stay
    assert.deepEqual(await views(), ['matches'])
    assert.ok(notices.some((m) => m.includes('referee_database_name_dob_uidx')), notices.join('\n'))
    assert.ok(notices.some((m) => m.includes('ov_read.profiles')), notices.join('\n'))
    // the data stays
    assert.deepEqual(await one('SELECT first_name, last_name, license_number FROM public.profiles'), { first_name: 'Mia', last_name: 'Muster', license_number: '123456' })
    assert.deepEqual(await one('SELECT referee_1_first_name, referee_1_last_name FROM public.svrz_games'), { referee_1_first_name: 'Max', referee_1_last_name: 'Pfiff' })
    assert.equal((await one('SELECT license_number FROM public.competition_players')).license_number, '123456')
    assert.equal((await one('SELECT license_number FROM public.competition_staff')).license_number, '654321')
    assert.equal((await one('SELECT sv_number FROM public.club_licences')).sv_number, '123456')
  })

  it('a second run changes nothing', async () => {
    await raw.query(FILE_049)
    assert.deepEqual(await columnsLeft(), [])
    assert.deepEqual(await views(), ['matches'])
  })

  it('the deploy step that scrubbed leftovers skips the columns that are gone', async () => {
    const out = await scrubLeftovers(raw)
    for (const [t, c] of DROPPED) assert.ok(!(`${t}.${c}` in out), `${t}.${c}`)
  })

  it('the installed apps: the dropped columns read as null, a write with a dob succeeds without it, no filter on them', async () => {
    db = createPgQuery({ connectionString: tdb.url, logger: quietLogger(), nullColumns: DOB_COLUMNS })
    const W = { proto: 2 }
    const q = (table, action, params = {}, opts = {}) => db.runQuery({ table, action, params }, opts)
    // the referee picker of apps before 3.5.0
    let r = await q('referee_database', 'select', { columns: 'id, first_name, last_name, country, dob, created_at', order: [{ column: 'last_name' }] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.data.map((x) => [x.last_name, x.dob]), [['Pfiff', null], ['Pfiff', null]])
    // the official-match loader ('*') and the account ('*')
    r = await q('svrz_games', 'select', { columns: '*', filters: [{ type: 'eq', column: 'game_number', value: '490001' }], single: true })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual([r.body.data.referee_1_last_name, r.body.data.referee_1_dob, r.body.data.referee_2_dob], ['Pfiff', null, null])
    r = await q('profiles', 'select', { columns: '*', single: true }, { scope: { column: 'user_id', value: id.user } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual([r.body.data.first_name, r.body.data.dob], ['Mia', null])
    // the official history of apps before 3.5.0: an insert with a dob, a profile save with one
    r = await q('referee_database', 'insert', { data: { first_name: 'Ada', last_name: 'Neu', country: 'CHE', dob: '2001-01-01', sport_type: ['indoor'] }, returning: 'id, dob', single: true }, W)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.data.dob, null)
    r = await q('profiles', 'update', { data: { first_name: 'Mia', dob: '1990-06-08' }, returning: '*' }, { ...W, scope: { column: 'user_id', value: id.user } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual([r.body.data[0].first_name, r.body.data[0].dob], ['Mia', null])
    // no filter or order on them
    for (const [table, column] of [['referee_database', 'dob'], ['svrz_games', 'referee_1_dob'], ['profiles', 'dob']]) {
      r = await q(table, 'select', { columns: 'id', filters: [{ type: 'eq', column, value: '2001-01-01' }] }, table === 'profiles' ? { scope: { column: 'user_id', value: id.user } } : {})
      assert.equal(r.body.error?.code, 'OV_DOB_FILTER', `${table}.${column}`)
    }
    r = await q('svrz_games', 'select', { columns: 'id', order: [{ column: 'referee_2_dob' }] })
    assert.equal(r.body.error?.code, 'OV_DOB_FILTER')
  })
})
