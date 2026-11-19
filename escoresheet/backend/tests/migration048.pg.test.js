/**
 * db/048_no_birthdates.sql on a database in the state before it (the
 * synthetic schema with 005 to 047), seeded with dates of birth in every
 * place the backend and the scorer apps kept one: afterwards no date is left
 * (lib/birthdates.js countBirthdates over every JSON column, the dob columns
 * NULL, no dob key in the metadata and the sent rosters), the licence numbers
 * are untouched, the closed matches stay closed with their approvals, and a
 * second run changes nothing. The remark rule is the same as the relay's
 * (lib/publicColumns.js redactRemarkDobs).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'
import { countBirthdates, isDateValue, scrubBirthdates } from '../lib/birthdates.js'
import { redactRemarkDobs } from '../lib/publicColumns.js'

const here = dirname(fileURLToPath(import.meta.url))
const DB = join(here, '..', 'db')
const sqlOf = (f) => readFileSync(join(DB, f), 'utf8')
const BEFORE_048 = [
  readFileSync(join(here, 'fixtures', 'synthetic_schema.sql'), 'utf8'),
  ...readdirSync(DB).filter((f) => /^0(0[5-9]|[1-3]\d|4[0-7])_[a-z0-9_]+\.sql$/.test(f)).sort().map(sqlOf),
  sqlOf('current_definitions.sql'),
  'UPDATE public.club_rule SET enabled = false WHERE id;',
  // a restore's staging copy of the accounts (db/000_prelude.sql), and the
  // production directory's unique key on the name and the date of birth
  `CREATE TABLE auth.users_import (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb);
   CREATE UNIQUE INDEX referee_database_name_dob_uidx ON public.referee_database (first_name, last_name, dob);`
].join('\n')

// every JSON column a person's date of birth was kept in
const JSON_COLUMNS = {
  matches: ['officials', 'players_home', 'players_away', 'bench_home', 'bench_away', 'connections', 'manual_changes', 'match_info',
    'coin_toss', 'players_team1', 'players_team2', 'team1_data', 'team2_data'],
  match_closures: ['closed_record', 'reclosed_record'],
  events: ['payload', 'state_snapshot'],
  event_revisions: ['before', 'after'],
  match_live_state: ['last_event_data'],
  beach_competition_matches: ['officials', 'match_info']
}

describe('db/048 (no birthdates outside a match\'s own sheet)', { skip: SKIP_PG }, () => {
  let tdb, raw
  const id = {}
  const one = async (sql, args = []) => (await raw.query(sql, args)).rows[0]

  /** Every date of birth left: [where] */
  async function datesLeft () {
    const left = []
    for (const [table, cols] of Object.entries(JSON_COLUMNS)) {
      const { rows } = await raw.query(`SELECT ${cols.map((c) => `${c}::jsonb AS ${c}`).join(', ')}, to_jsonb(t) ->> 'remarks' AS remarks FROM public.${table} t`)
      for (const r of rows) {
        for (const c of cols) if (countBirthdates(r[c])) left.push(`${table}.${c}: ${JSON.stringify(r[c])}`)
        if (r.remarks && redactRemarkDobs(r.remarks) !== r.remarks) left.push(`${table}.remarks: ${r.remarks}`)
      }
    }
    for (const [t, c] of [['profiles', 'dob'], ['referee_database', 'dob'], ['svrz_games', 'referee_1_dob'], ['svrz_games', 'referee_2_dob'],
      ['competition_players', 'dob'], ['competition_staff', 'dob'], ['club_licences', 'dob']]) {
      const { n } = await one(`SELECT count(*)::int AS n FROM public.${t} WHERE ${c} IS NOT NULL`)
      if (n) left.push(`${t}.${c}: ${n}`)
    }
    for (const t of ['auth.users', 'auth.users_import']) {
      const { n } = await one(`SELECT count(*)::int AS n FROM ${t} WHERE raw_user_meta_data ? 'dob'`)
      if (n) left.push(`${t}.raw_user_meta_data: ${n}`)
    }
    const { n } = await one("SELECT count(*)::int AS n FROM public.game_rosters WHERE jsonb_path_exists(players, '$[*].dob') OR jsonb_path_exists(staff, '$[*].dob')")
    if (n) left.push(`game_rosters: ${n}`)
    return left
  }

  const remark = 'Player #7 dob: 03.05.2011 → 04.06.2011 (VBC Musterdorf)\n- Bench official Coach dob: 1980-01-01 -> 1980-02-01 (Gästeteam)\nSet 2 started late'
  const players = [
    { number: 1, first_name: 'Mia', last_name: 'Muster', dob: '14.03.2008', is_captain: true },
    { number: 2, first_name: 'Lea', last_name: 'Beispiel', dob: '123456' },
    { number: 3, first_name: 'Nora', last_name: 'Probe', dob: '01.01.1900' },
    { number: 4, first_name: 'Ida', last_name: 'Test', dob: '2008-03-14' },
    { number: 5, first_name: 'Eva', last_name: 'Muster', dob: '14/03/2008' },
    { number: 6, first_name: 'Ana', last_name: 'Muster', dob: '4-3-08' },
    { number: 7, first_name: 'Zoe', last_name: 'Muster', dob: null }
  ]

  before(async () => {
    tdb = await createTestDatabase('mig048', { schemaSql: BEFORE_048 })
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    // accounts
    id.user = (await one(`INSERT INTO auth.users (email, raw_user_meta_data) VALUES ('mia@example.test', '{"first_name":"Mia","dob":"1990-05-06","mail_lang":"de"}') RETURNING id`)).id
    await raw.query(`INSERT INTO auth.users_import (id, email, raw_user_meta_data) VALUES (gen_random_uuid(), 'x@example.test', '{"dob":"1991-01-01"}')`)
    await raw.query("INSERT INTO public.profiles (user_id, first_name, last_name, dob) VALUES ($1, 'Mia', 'Muster', '1990-05-06')", [id.user])
    // the referee directory: two people of one name, told apart by the date
    await raw.query(`INSERT INTO public.referee_database (first_name, last_name, dob, sport_type) VALUES
      ('Max', 'Pfiff', '1970-01-01', '["indoor"]'), ('Max', 'Pfiff', '1971-02-02', '["indoor"]')`)
    await raw.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, referee_1_first_name, referee_1_dob, referee_2_dob)
      VALUES ('480001', 'VBC Musterdorf', 'VBC Beispiel', 'Max', '1970-01-01', '1975-05-05')`)
    // a saved team and a club list
    const comp = await one("INSERT INTO public.competitions (name, season) VALUES ('2. Liga', '2026/27') RETURNING id")
    const team = await one("INSERT INTO public.competition_teams (competition_id, name) VALUES ($1, 'VBC Musterdorf') RETURNING id", [comp.id])
    await raw.query("INSERT INTO public.competition_players (team_id, last_name, dob, license_number) VALUES ($1, 'Muster', '2008-03-14', '123456')", [team.id])
    await raw.query("INSERT INTO public.competition_staff (team_id, role, last_name, dob, license_number) VALUES ($1, 'Coach', 'Trainer', '1980-01-01', '654321')", [team.id])
    const club = await one("INSERT INTO public.clubs (name) VALUES ('VBC Musterdorf') RETURNING id")
    id.club = club.id
    await raw.query("INSERT INTO public.club_licences (club_id, list, sv_number, last_name, dob) VALUES ($1, 'players', '123456', 'Muster', '2008-03-14')", [club.id])
    await raw.query(`INSERT INTO public.game_rosters (game_number, season, side, team_name, players, staff) VALUES ('480001', 2026, 'home', 'VBC Musterdorf',
      '[{"number":1,"last_name":"Muster","dob":"2008-03-14","license_number":"123456"}]', '[{"role":"Coach","last_name":"Trainer","dob":null}]')`)
    // a closed official match with an approval, an open one with an uploaded roster, a beach one
    const officials = [{ role: '1st referee', firstName: 'Max', lastName: 'Pfiff', dob: '01.01.1900' },
      { role: 'scorer', firstName: 'Mia', lastName: 'Muster', licence: '98765', dob: '1985-01-02' }]
    const manual = [
      { ts: '2026-10-01T10:00:00Z', category: 'player', field: 'dob', before: '01.02.2003', after: '02.02.2003', description: 'Player #7 dob: 01.02.2003 → 02.02.2003 (Home)' },
      { ts: '2026-10-01T10:01:00Z', category: 'official', field: 'ref1.dob', before: '', after: '1980-01-01', description: 'ref1 dob: (empty) → 1980-01-01' },
      { ts: '2026-10-01T10:02:00Z', category: 'player', field: 'remove', before: { number: 7, lastName: 'Muster', dob: '01.02.2003' }, after: null, description: 'Removed player #7 Muster' },
      { ts: '2026-10-01T10:03:00Z', category: 'player', field: 'number', before: '7', after: '8', description: 'Player #7 number: 7 → 8 (Home)' }
    ]
    id.closed = (await one(`INSERT INTO public.matches (external_id, game_n, status, test, players_home, players_away, bench_home, officials, manual_changes, remarks, match_info, home_team, away_team)
      VALUES ('m048_closed', 480001, 'live', false, $1, $2, $3, $4, $5, $6, $7, '{"name":"VBC Musterdorf"}', '{"name":"VBC Beispiel"}') RETURNING id`,
    [JSON.stringify(players), JSON.stringify([{ number: 9, first_name: 'Ola', last_name: 'Gast', dob: '2007-07-07' }]),
      JSON.stringify([{ role: 'Coach', first_name: 'Tim', last_name: 'Trainer', dob: '1980-01-01' }]), JSON.stringify(officials), JSON.stringify(manual), remark,
      JSON.stringify({ referee1Dob: '01.01.1970', hall: 'Halle Musterdorf' })])).id
    await raw.query(`INSERT INTO public.match_approvals (match_id, slot, display_name, match_status, result_key, result_hash)
      VALUES ($1, 'referee1', 'Max Pfiff', 'approved', 'k', sha256('k'))`, [id.closed])
    id.open = (await one(`INSERT INTO public.matches (external_id, game_n, status, test, connections, players_home)
      VALUES ('m048_open', 480002, 'setup', true, $1, '[{"number":1,"last_name":"Muster","dob":"123456"}]') RETURNING id`,
    [JSON.stringify({ referee_enabled: true, pending_home_roster: { players: [{ number: 1, lastName: 'Muster', dob: '3.4.2009' }], bench: [{ role: 'Coach', dob: '1980-01-01' }] } })])).id
    // a beach match (OpenBeach): its people in players_team1 / players_team2 and officials
    id.beach = (await one(`INSERT INTO public.matches (external_id, game_n, status, sport_type, players_team1, players_team2, team1_data, officials)
      VALUES ('m048_beach', 12, 'live', 'beach', '[{"number":1,"lastName":"Sand","dob":"1999-09-09"},{"number":2,"lastName":"Strand","dob":"55555"}]',
              '[{"number":1,"lastName":"Kies","dob":"09/09/1998"},{"number":2,"lastName":"Welle","dob":"7654321"}]',
              '{"name":"Sand/Strand","dateOfBirth":"1999-09-09"}',
              '[{"role":"referee","lastName":"Pfiff","dob":"1970-01-01"},{"role":"scorer","lastName":"Zahl","dob":"123456"}]') RETURNING id`)).id
    await raw.query(`INSERT INTO public.events (match_id, type, payload, state_snapshot) VALUES ($1, 'remark', '{"player":{"number":7,"dob":"05.05.2005"},"text":"x"}', '{"home":{"players":[{"dob":"2001-01-01"}]}}')`, [id.closed])
    await raw.query(`INSERT INTO public.event_revisions (rev_uid, match_id, event_external_id, op, reason, before, after, applied, client_ts)
      VALUES (gen_random_uuid(), $1, 'e1', 'edit', 'correction', '{"payload":{"dob":"05.05.2005"}}', '{"payload":{"dob":"06.05.2005"}}', true, now())`, [id.closed])
    await raw.query(`INSERT INTO public.match_live_state (match_id, last_event_data) VALUES ($1, '{"player":{"dob":"2008-03-14","number":1}}')`, [id.closed])
    await raw.query(`INSERT INTO public.match_closures (match_id, closed_record, reclosed_record)
      VALUES ($1, $2, '{"officials":[{"dob":"1985-01-02","licence":"98765"}]}')`, [id.closed, JSON.stringify({ officials, remarks: remark })])
    // its approval closes it (db/007)
    await raw.query("UPDATE public.matches SET status = 'approved' WHERE id = $1", [id.closed])
    await raw.query(`INSERT INTO public.beach_competition_matches (external_id, officials) VALUES ('b048', '[{"role":"referee","dob":"1970-01-01"}]')`)
    // the matches as the scorer left them (closed and its updated_at)
    id.closedAt = (await one('SELECT closed_at FROM public.matches WHERE id = $1', [id.closed])).closed_at
    assert.ok(id.closedAt, 'the approved official match is closed')
    assert.ok((await datesLeft()).length > 20, 'seeded with dates of birth everywhere')

    await raw.query(sqlOf('048_no_birthdates.sql'))
  })
  after(async () => {
    await raw?.end().catch(() => {})
    await tdb?.drop()
  })

  it('leaves no date of birth in any table, column or JSON field', async () => {
    assert.deepEqual(await datesLeft(), [])
  })

  it('keeps the licence numbers and everything else', async () => {
    const m = await one('SELECT players_home, officials, match_info, closed_at FROM public.matches WHERE id = $1', [id.closed])
    assert.deepEqual(m.players_home.map((p) => p.dob), [null, '123456', null, null, null, null, null])
    assert.deepEqual(m.players_home.map((p) => p.last_name), players.map((p) => p.last_name))
    assert.equal(m.players_home[0].is_captain, true)
    assert.equal(m.officials[1].licence, '98765')
    assert.equal(m.officials[1].dob, null)
    assert.equal(m.match_info.referee1Dob, null)
    assert.equal(m.match_info.hall, 'Halle Musterdorf')
    assert.equal((await one('SELECT players_home FROM public.matches WHERE id = $1', [id.open])).players_home[0].dob, '123456')
    const b = await one('SELECT players_team1, players_team2, team1_data, officials FROM public.matches WHERE id = $1', [id.beach])
    assert.deepEqual(b.players_team1.map((p) => p.dob), [null, '55555'])
    assert.deepEqual(b.players_team2.map((p) => p.dob), [null, '7654321'])
    assert.deepEqual(b.officials.map((p) => [p.lastName, p.dob]), [['Pfiff', null], ['Zahl', '123456']])
    assert.equal(b.team1_data.name, 'Sand/Strand')
    assert.equal(b.team1_data.dateOfBirth, null)
    assert.equal((await one('SELECT license_number FROM public.competition_players')).license_number, '123456')
    assert.equal((await one('SELECT license_number FROM public.competition_staff')).license_number, '654321')
    assert.equal((await one('SELECT sv_number FROM public.club_licences')).sv_number, '123456')
    const g = await one('SELECT players, staff FROM public.game_rosters')
    assert.deepEqual(g.players, [{ number: 1, last_name: 'Muster', license_number: '123456' }])
    assert.deepEqual(g.staff, [{ role: 'Coach', last_name: 'Trainer' }])
    const u = await one('SELECT raw_user_meta_data FROM auth.users WHERE id = $1', [id.user])
    assert.deepEqual(u.raw_user_meta_data, { first_name: 'Mia', mail_lang: 'de' })
    assert.equal((await one('SELECT count(*)::int AS n FROM public.referee_database WHERE first_name = $1', ['Max'])).n, 2)
  })

  it('keeps a correction in the remarks and the manual changes, without its dates', async () => {
    const m = await one('SELECT remarks, manual_changes FROM public.matches WHERE id = $1', [id.closed])
    assert.equal(m.remarks, 'Player #7 date of birth changed (VBC Musterdorf)\n- Bench official Coach date of birth changed (Gästeteam)\nSet 2 started late')
    assert.equal(m.remarks, redactRemarkDobs(remark))
    assert.deepEqual(m.manual_changes.map((c) => [c.before, c.after, c.description]), [
      [null, null, 'Player #7 date of birth changed (Home)'],
      ['', null, 'ref1 date of birth changed'],
      [{ number: 7, lastName: 'Muster', dob: null }, null, 'Removed player #7 Muster'],
      ['7', '8', 'Player #7 number: 7 → 8 (Home)']
    ])
  })

  it('the SQL remark rule is the relay\'s, the SQL scrub is lib/birthdates.js', async () => {
    for (const t of [remark, 'dob: a → b', 'Xdob: 1 → 2', 'dob: → 2', 'dob: 1 → ', 'Player #1 dob: 1.1.2000 → 2.2.2000 (A (B))',
      'a\rPlayer #2 dob: 1.1.2000 -> 2.2.2000 (Team)\rb', 'no dates here', 'dob: 1 → 2 dob: 3 → 4', '']) {
      assert.equal((await one('SELECT pg_temp.ov048_remark($1) AS r', [t])).r, redactRemarkDobs(t), JSON.stringify(t))
    }
    const sample = { players: players.map((p) => ({ ...p })), changes: [{ field: 'Dob', before: '1.1.2000', after: '22.2.2000', description: 'x dob: 1.1.2000 → 22.2.2000' }], referee_1_dob: '1970-01-01' }
    assert.deepEqual((await one('SELECT pg_temp.ov048_scrub($1::jsonb) AS j', [JSON.stringify(sample)])).j, scrubBirthdates(sample).value)
    assert.equal(countBirthdates(scrubBirthdates(sample).value), 0)
    assert.ok(isDateValue('01.01.1900') && isDateValue('2008-03-14T00:00:00Z') && !isDateValue('123456') && !isDateValue('2008'))
  })

  it('closed matches stay closed and keep their approvals', async () => {
    const m = await one('SELECT closed_at, status FROM public.matches WHERE id = $1', [id.closed])
    assert.equal(m.closed_at.toISOString(), id.closedAt.toISOString())
    assert.equal(m.status, 'approved')
    assert.equal((await one('SELECT count(*)::int AS n FROM public.match_approvals WHERE match_id = $1 AND revoked_at IS NULL', [id.closed])).n, 1)
    // the guards are back after the file: a closed match is read-only again
    await assert.rejects(raw.query("UPDATE public.matches SET remarks = 'x' WHERE id = $1", [id.closed]), /match is closed/)
  })

  it('adds profiles.license_number (4 to 7 digits) and the club lists\' source match', async () => {
    await raw.query("UPDATE public.profiles SET license_number = '12345' WHERE user_id = $1", [id.user])
    await assert.rejects(raw.query("UPDATE public.profiles SET license_number = '12a45' WHERE user_id = $1", [id.user]), /check constraint/)
    await assert.rejects(raw.query("UPDATE public.profiles SET license_number = '123' WHERE user_id = $1", [id.user]), /check constraint/)
    await raw.query("INSERT INTO public.club_licences (club_id, list, sv_number, last_name, source) VALUES ($1, 'coaches', '222222', 'Trainer', 'match')", [id.club])
    await assert.rejects(raw.query("INSERT INTO public.club_licences (club_id, list, sv_number, last_name, source) VALUES ($1, 'coaches', '333333', 'X', 'other')", [id.club]), /check constraint/)
  })

  it('runs again without a change', async () => {
    const before = await one(`SELECT md5(string_agg(to_jsonb(m)::text, '' ORDER BY id)) AS h FROM public.matches m`)
    await raw.query(sqlOf('048_no_birthdates.sql'))
    const after = await one(`SELECT md5(string_agg(to_jsonb(m)::text, '' ORDER BY id)) AS h FROM public.matches m`)
    assert.equal(after.h, before.h)
    assert.deepEqual(await datesLeft(), [])
  })
})
