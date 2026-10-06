/**
 * Beach (openbeach) against the shared backend, end to end: server.js against
 * a real Postgres (PG_TEST_URL, or OV_E2E_DOCKER=1 for a throwaway container;
 * see tests/server.e2e.test.js) with OV_PIN_SECRET set (PINs hashed at rest).
 *
 * Beach reuses matches / sets / events / match_live_state with
 * sport_type 'beach' and names its teams team1 / team2:
 *   1. validate-connection-pin { sport: 'beach' }: referee and team benches
 *      (bench_team1 / bench_team2, old team1_data key), right and wrong PIN,
 *      no cross-sport hits; the indoor answer is unchanged
 *   2. the match token of a beach PIN check grants the beach rosters
 *      (players_team1 / players_team2) on anonymous /api/db reads
 *   3. live subscribers filtered on sport_type=beach get beach rows only, with
 *      the beach team names and no rosters; the livescore embed
 *   4. the relay keeps team1/team2 bundles (as home/away), strips the beach PIN
 *      fields, grants the beach PINs and tokens, carries sport_type on relayed
 *      live state
 *   5. scoresheets under beach/ do not collide with indoor ones
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, openSocket, provisionDatabase, subscribe } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const PIN_SECRET = randomBytes(32).toString('base64url')
const GAME_PIN = '582914'
const PINS = { referee: '640371', bench_team1: '207519', bench_team2: '918264', upload_team1: '375028' }
const INDOOR_GAME_PIN = '493016'
const INDOOR_PINS = { referee: '850263', bench_home: '126947' }
const LEGACY_PIN = '739150' // a beach match whose team1 bench PIN sits under the old team1_data key
const MATCH_PIN = '424242' // openbeach's match-protect PIN on the Dexie match
const ALL_PINS = [GAME_PIN, INDOOR_GAME_PIN, LEGACY_PIN, MATCH_PIN, ...Object.values(PINS), ...Object.values(INDOOR_PINS)]
const containsPin = (text) => ALL_PINS.some((p) => String(text).includes(p))
const DOB = '2001-05-06'

describe('beach on the shared backend', { skip: SKIP }, () => {
  let db
  let srv
  let sql
  let storageRoot
  let statusDir
  let ipSeq = 1
  const nextIp = () => `203.0.113.${ipSeq++}`
  const users = {}
  const tag = `${Date.now()}_${randomBytes(3).toString('hex')}`
  const ext = `match_beach_${tag}`
  const indoorExt = `match_indoor_${tag}`
  const legacyExt = `match_beach_old_${tag}`
  let beachUuid
  let indoorUuid

  async function account(name) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name } } })
    assert.equal(up.status, 200, up.text)
    const inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
    assert.equal(inn.status, 200, inn.text)
    return { id: inn.json.data.user.id, token: inn.json.data.session.access_token }
  }

  const dbCall = (user, table, action, params, extra = {}) =>
    api(srv.base, '/api/db', { token: user?.token, proto: action === 'select' ? null : '2', body: { table, action, params }, ...extra })
  const pinCheck = (body, ip = nextIp()) =>
    api(srv.base, '/api/match/validate-connection-pin', { proto: null, headers: { 'cf-connecting-ip': ip }, body })
  const anonMatch = (externalId, headers = {}) =>
    api(srv.base, '/api/db', { proto: null, headers, body: { table: 'matches', action: 'select', params: { columns: '*', filters: [{ type: 'eq', column: 'external_id', value: externalId }], maybeSingle: true } } })

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-beach-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-beach-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1',
      OV_PIN_SECRET: PIN_SECRET
    })
    users.alice = await account('alice') // beach scorer
    users.ivan = await account('ivan') // indoor scorer
    // new accounts are pending (db/007): approve both as scorers
    await grantRoles(sql, users.alice.id)
    await grantRoles(sql, users.ivan.id)
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('a signed-in beach scorer writes the match, its sets, events and live state with sport_type beach', async () => {
    const m = await dbCall(users.alice, 'matches', 'upsert', {
      data: {
        external_id: ext,
        sport_type: 'beach',
        status: 'live',
        game_n: 41,
        game_pin: GAME_PIN,
        scheduled_at: new Date().toISOString(),
        team1_data: { name: 'Muster / Beispiel', short_name: 'MUS', color: '#ef4444', country: 'SUI' },
        team2_data: { name: 'Rossi / Bianchi', short_name: 'ROS', color: '#3b82f6', country: 'ITA' },
        players_team1: [{ number: 1, first_name: 'Anna', last_name: 'Muster', dob: DOB, is_captain: true }, { number: 2, first_name: 'Bea', last_name: 'Beispiel', dob: DOB }],
        players_team2: [{ number: 1, first_name: 'Lia', last_name: 'Rossi', dob: DOB }, { number: 2, first_name: 'Eva', last_name: 'Bianchi', dob: DOB }],
        connections: { referee_enabled: true, team1_bench_enabled: true, team2_bench_enabled: false },
        connection_pins: PINS
      },
      onConflict: 'external_id',
      returning: 'id',
      single: true
    })
    assert.equal(m.status, 200, m.text)
    beachUuid = m.json.data.id
    const { rows: [row] } = await sql.query('SELECT sport_type, connection_pins, created_by FROM matches WHERE id = $1', [beachUuid])
    assert.equal(row.sport_type, 'beach')
    assert.equal(row.created_by, users.alice.id)
    assert.deepEqual(Object.keys(row.connection_pins).sort(), Object.keys(PINS).sort())
    for (const v of Object.values(row.connection_pins)) assert.match(v, /^h1:/, 'beach PINs are hashed at rest too')

    const s = await dbCall(users.alice, 'sets', 'upsert', { data: { external_id: `${ext}:s:1`, match_id: beachUuid, index: 1, team1_points: 21, team2_points: 18, finished: true, sport_type: 'beach' }, onConflict: 'external_id' })
    assert.equal(s.status, 200, s.text)
    const e = await dbCall(users.alice, 'events', 'insert', { data: { external_id: `${ext}:e:1`, match_id: beachUuid, set_index: 1, type: 'point', seq: 1, payload: { team: 'team1' }, sport_type: 'beach' } })
    assert.equal(e.status, 200, e.text)
    const ls = await dbCall(users.alice, 'match_live_state', 'upsert', { data: { match_id: beachUuid, sport_type: 'beach', team_a_name: 'Muster / Beispiel', team_b_name: 'Rossi / Bianchi', points_a: 3, points_b: 2, server_number: 1 }, onConflict: 'match_id' })
    assert.equal(ls.status, 200, ls.text)

    // An indoor match whose PINs must never answer a beach check (and the other way round)
    const i = await dbCall(users.ivan, 'matches', 'upsert', {
      data: {
        external_id: indoorExt, sport_type: 'indoor', status: 'live', game_n: 42, game_pin: INDOOR_GAME_PIN,
        home_team: { name: 'Home VC' }, away_team: { name: 'Away VC' },
        connections: { referee_enabled: true, home_bench_enabled: true }, connection_pins: INDOOR_PINS
      },
      onConflict: 'external_id', returning: 'id', single: true
    })
    assert.equal(i.status, 200, i.text)
    indoorUuid = i.json.data.id
    const ils = await dbCall(users.ivan, 'match_live_state', 'upsert', { data: { match_id: indoorUuid, sport_type: 'indoor', points_a: 10, points_b: 8 }, onConflict: 'match_id' })
    assert.equal(ils.status, 200, ils.text)

    // An older openbeach build stored the team1 bench PIN as connection_pins.team1_data
    const old = await dbCall(users.alice, 'matches', 'upsert', {
      data: {
        external_id: legacyExt, sport_type: 'beach', status: 'live', game_n: 43, game_pin: '615204',
        team1_data: { name: 'Old / Team' }, team2_data: { name: 'Other / Team' },
        connections: { referee_enabled: false, team1_bench_enabled: true }, connection_pins: { team1_data: LEGACY_PIN }
      },
      onConflict: 'external_id', returning: 'id', single: true
    })
    assert.equal(old.status, 200, old.text)
  })

  it('validate-connection-pin { sport: beach }: the right referee PIN answers the match and a token, a wrong one 404', async () => {
    const ok = await pinCheck({ pin: PINS.referee, type: 'referee', sport: 'beach' })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.json.success, true)
    assert.equal(ok.json.match.id, ext)
    assert.equal(ok.json.match.sportType, 'beach')
    assert.equal(ok.json.match.gameNumber, 41)
    assert.equal(ok.json.match.status, 'live')
    assert.equal(ok.json.match.refereeConnectionEnabled, true)
    assert.equal(ok.json.match.team1TeamConnectionEnabled, true)
    assert.equal(ok.json.match.team2TeamConnectionEnabled, false)
    assert.equal(ok.json.match.team1Team, 'Muster / Beispiel')
    assert.equal(ok.json.match.team2Team, 'Rossi / Bianchi')
    assert.equal(ok.json.match.team1TeamColor, '#ef4444')
    assert.match(ok.json.token, /^v1\./)
    assert.equal(containsPin(ok.text), false)
    assert.equal(ok.text.includes(DOB), false)

    const wrong = await pinCheck({ pin: '000000', type: 'referee', sport: 'beach' })
    assert.equal(wrong.status, 404)
    assert.equal(wrong.json.success, false)
    // bound to the match the caller names
    assert.equal((await pinCheck({ pin: PINS.referee, type: 'referee', sport: 'beach', matchExternalId: ext })).status, 200)
    assert.equal((await pinCheck({ pin: PINS.referee, type: 'referee', sport: 'beach', matchExternalId: legacyExt })).status, 404)
  })

  it('beach bench PINs: team1 (connection on) and the old team1_data key pass; team2 (off) does not', async () => {
    const t1 = await pinCheck({ pin: PINS.bench_team1, type: 'bench_team1', sport: 'beach' })
    assert.equal(t1.status, 200, t1.text)
    assert.equal(t1.json.match.id, ext)
    assert.match(t1.json.token, /^v1\./)
    assert.equal((await pinCheck({ pin: PINS.bench_team2, type: 'bench_team2', sport: 'beach' })).status, 404, 'team2 bench connection is off')
    assert.equal((await pinCheck({ pin: PINS.bench_team1, type: 'bench_team2', sport: 'beach' })).status, 404, 'a team1 PIN is not a team2 PIN')
    const old = await pinCheck({ pin: LEGACY_PIN, type: 'bench_team1', sport: 'beach' })
    assert.equal(old.status, 200, old.text)
    assert.equal(old.json.match.id, legacyExt)
    // upload PINs: no connection flag, no token
    const up = await pinCheck({ pin: PINS.upload_team1, type: 'upload_team1', sport: 'beach', matchExternalId: ext })
    assert.equal(up.status, 200, up.text)
    assert.equal(up.json.token, null)
  })

  it('no cross-sport answers; unknown sports and the other sport\'s types are refused; indoor is unchanged', async () => {
    assert.equal((await pinCheck({ pin: INDOOR_PINS.referee, type: 'referee', sport: 'beach' })).status, 404, 'an indoor PIN never finds a match as beach')
    assert.equal((await pinCheck({ pin: PINS.referee, type: 'referee' })).status, 404, 'a beach PIN never finds a match as indoor (the default)')
    assert.equal((await pinCheck({ pin: PINS.referee, type: 'referee', sport: 'indoor' })).status, 404)
    for (const body of [
      { pin: PINS.bench_team1, type: 'bench_home', sport: 'beach' },
      { pin: PINS.bench_team1, type: 'bench_team1' },
      { pin: PINS.referee, type: 'referee', sport: 'snow' },
      { pin: PINS.referee, type: 'referee', sport: null },
      { pin: PINS.referee, type: '__proto__', sport: 'beach' }
    ]) {
      const r = await pinCheck(body)
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.equal(r.json.error, 'Invalid request')
    }
    const indoor = await pinCheck({ pin: INDOOR_PINS.referee, type: 'referee' })
    assert.equal(indoor.status, 200, indoor.text)
    assert.deepEqual(Object.keys(indoor.json).sort(), ['match', 'success', 'token'])
    // (the team colours are left out: this match's teams have none)
    assert.deepEqual(Object.keys(indoor.json.match).sort(), [
      'awayTeam', 'awayTeamConnectionEnabled', 'gameNumber', 'homeTeam',
      'homeTeamConnectionEnabled', 'id', 'refereeConnectionEnabled', 'scheduledAt', 'status'
    ])
    assert.equal(indoor.json.match.id, indoorExt)
    assert.equal(indoor.json.match.homeTeam, 'Home VC')
    assert.equal(indoor.json.match.homeTeamConnectionEnabled, true)
    assert.equal('sportType' in indoor.json.match, false, 'the indoor answer has no new fields')
    assert.equal((await pinCheck({ pin: INDOOR_PINS.bench_home, type: 'bench_home' })).status, 200)
  })

  it('a beach match token grants the beach rosters on anonymous /api/db reads, while its connection is on', async () => {
    const anon = await anonMatch(ext)
    assert.equal(anon.status, 200, anon.text)
    assert.equal('players_team1' in anon.json.data, false, 'rosters need the PIN step')
    assert.deepEqual(anon.json.data.team1_data, { name: 'Muster / Beispiel', short_name: 'MUS', color: '#ef4444' })
    assert.deepEqual(anon.json.data.connections, { referee_enabled: true, team1_bench_enabled: true, team2_bench_enabled: false })
    assert.equal(containsPin(anon.text), false)

    const ref = await pinCheck({ pin: PINS.referee, type: 'referee', sport: 'beach' })
    const withRef = await anonMatch(ext, { 'X-OV-Match-Token': ref.json.token })
    assert.deepEqual(withRef.json.data.players_team1, [
      { number: 1, first_name: 'Anna', last_name: 'Muster', is_captain: true },
      { number: 2, first_name: 'Bea', last_name: 'Beispiel' }
    ])
    assert.equal(withRef.json.data.players_team2.length, 2)
    assert.equal(withRef.text.includes(DOB), false, 'no dates of birth')
    assert.equal(containsPin(withRef.text), false)
    // the token names one match only
    assert.equal('players_team1' in (await anonMatch(legacyExt, { 'X-OV-Match-Token': ref.json.token })).json.data, false)

    const bench = await pinCheck({ pin: PINS.bench_team1, type: 'bench_team1', sport: 'beach' })
    assert.equal((await anonMatch(ext, { 'X-OV-Match-Token': bench.json.token })).json.data.players_team1.length, 2)
    // the scorer turns the team1 bench off: its token stops granting at once
    const off = await dbCall(users.alice, 'matches', 'update', { data: { connections: { team1_bench_enabled: false } }, filters: [{ type: 'eq', column: 'id', value: beachUuid }] })
    assert.equal(off.status, 200, off.text)
    assert.equal('players_team1' in (await anonMatch(ext, { 'X-OV-Match-Token': bench.json.token })).json.data, false)
    assert.equal((await anonMatch(ext, { 'X-OV-Match-Token': ref.json.token })).json.data.players_team1.length, 2, 'the referee keeps access')
    const on = await dbCall(users.alice, 'matches', 'update', { data: { connections: { team1_bench_enabled: true } }, filters: [{ type: 'eq', column: 'id', value: beachUuid }] })
    assert.equal(on.status, 200, on.text)
  })

  it('livescore: live subscribers on sport_type=beach get beach rows only, without rosters; the livescore embed works', async () => {
    const live = await openSocket(`${srv.wsUrl}/?purpose=live`)
    try {
      await subscribe(live, 'beach-ls', [{ table: 'match_live_state', event: '*', column: 'sport_type', value: 'beach' }])
      await subscribe(live, 'beach-m', [{ table: 'matches', event: 'UPDATE', column: 'sport_type', value: 'beach' }])
      const indoor = await dbCall(users.ivan, 'match_live_state', 'update', { data: { points_a: 11 }, filters: [{ type: 'eq', column: 'match_id', value: indoorUuid }] })
      assert.equal(indoor.status, 200, indoor.text)
      const beach = await dbCall(users.alice, 'match_live_state', 'update', { data: { points_a: 4, server_number: 2 }, filters: [{ type: 'eq', column: 'match_id', value: beachUuid }] })
      assert.equal(beach.status, 200, beach.text)
      const u = await live.waitFor((m) => m.type === 'db-change' && m.table === 'match_live_state' && m.new?.match_id === beachUuid && m.new.points_a === 4, 5000, 'beach live state')
      assert.equal(u.new.sport_type, 'beach')
      assert.equal(u.new.server_number, 2)

      const upd = await dbCall(users.alice, 'matches', 'update', { data: { set_results: [{ set: 1, team1: 21, team2: 18 }] }, filters: [{ type: 'eq', column: 'id', value: beachUuid }] })
      assert.equal(upd.status, 200, upd.text)
      const mc = await live.waitFor((m) => m.type === 'db-change' && m.table === 'matches' && m.new?.external_id === ext, 5000, 'beach match update')
      assert.deepEqual(mc.new.team1_data, { name: 'Muster / Beispiel', short_name: 'MUS', color: '#ef4444' })
      for (const col of ['players_team1', 'players_team2', 'connections']) assert.equal(col in mc.new, false, col)
      assert.equal(live.messages.some((m) => m.type === 'db-change' && (m.new?.match_id === indoorUuid || m.new?.external_id === indoorExt)), false, 'an indoor row reached a beach subscription')
      assert.equal(live.raw.join('').includes(DOB) || containsPin(live.raw.join('')), false)
    } finally {
      live.ws.close()
    }

    // openbeach's livescore list: the one embed shape, filtered on the live
    // state's own sport_type
    const r = await api(srv.base, '/api/db', { proto: null, body: { table: 'match_live_state', action: 'select', params: { columns: '*, matches!match_live_state_match_id_fkey_cascade(set_results)', filters: [{ type: 'eq', column: 'sport_type', value: 'beach' }] } } })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.data.map((x) => x.match_id), [beachUuid])
    assert.deepEqual(r.json.data[0].matches.set_results, [{ set: 1, team1: 21, team2: 18 }])
  })

  it('openbeach\'s whole live-state upsert (incl. tto_active / tto_started_at) is accepted and reaches live subscribers', async () => {
    // The key set Scoreboard_beach.jsx syncLiveStateToSupabase sends, all of it
    const ttoAt = new Date().toISOString()
    const liveStateData = {
      match_id: beachUuid, sport_type: 'beach', current_set: 2,
      team_a_name: 'Muster / Beispiel', team_a_short: 'MUS', team_a_color: '#ef4444',
      team_b_name: 'Rossi / Bianchi', team_b_short: 'ROS', team_b_color: '#3b82f6',
      sets_won_a: 1, sets_won_b: 0, points_a: 12, points_b: 9, side_a: 'right',
      lineup_a: { I: 1, II: 2 }, lineup_b: { I: 1, II: 2 },
      timeouts_a: 0, timeouts_b: 1, server_number: 2, challenges_used_a: 0, challenges_used_b: 1,
      subs_a: null, subs_b: null, sanctions_a: null, sanctions_b: null,
      serving_team: 'left', last_event_type: 'technical_to', last_event_team: null, last_event_data: null,
      last_event_ts: ttoAt, timeout_active: false, timeout_started_at: null,
      tto_active: true, tto_started_at: ttoAt,
      set_interval_active: false, set_interval_started_at: null, match_status: 'in_progress',
      scorer_attention_trigger: null, game_n: 41, league: null, gender: null,
      updated_at: new Date().toISOString()
    }
    const live = await openSocket(`${srv.wsUrl}/?purpose=live`)
    try {
      await subscribe(live, 'beach-tto', [{ table: 'match_live_state', event: '*', column: 'sport_type', value: 'beach' }])
      const r = await dbCall(users.alice, 'match_live_state', 'upsert', { data: liveStateData, onConflict: 'match_id' })
      assert.equal(r.status, 200, r.text)
      const u = await live.waitFor((m) => m.type === 'db-change' && m.table === 'match_live_state' && m.new?.match_id === beachUuid && m.new.tto_active === true, 5000, 'beach TTO live state')
      assert.equal(new Date(u.new.tto_started_at).toISOString(), ttoAt)
      assert.equal(u.new.challenges_used_b, 1)
      assert.equal(u.new.points_a, 12)
      const { rows: [row] } = await sql.query('SELECT tto_active, tto_started_at FROM match_live_state WHERE match_id = $1', [beachUuid])
      assert.equal(row.tto_active, true)
      // The TTO ends: live viewers get tto_active false
      const end = await dbCall(users.alice, 'match_live_state', 'upsert', { data: { ...liveStateData, tto_active: false, tto_started_at: null, last_event_type: 'end_tto', updated_at: new Date(Date.now() + 1000).toISOString() }, onConflict: 'match_id' })
      assert.equal(end.status, 200, end.text)
      await live.waitFor((m) => m.type === 'db-change' && m.table === 'match_live_state' && m.new?.match_id === beachUuid && m.new.tto_active === false, 5000, 'TTO ended')
    } finally {
      live.ws.close()
    }
  })

  it('relay: a beach scoreboard\'s team1/team2 bundle is kept, its PINs never relayed, the beach PINs and tokens grant it', async () => {
    const scoreboard = await openSocket(srv.wsUrl)
    const viewer = await openSocket(srv.wsUrl)
    const referee = await openSocket(srv.wsUrl)
    const benchByPin = await openSocket(srv.wsUrl)
    const benchByToken = await openSocket(srv.wsUrl)
    const live = await openSocket(`${srv.wsUrl}/?purpose=live`)
    const all = [scoreboard, viewer, referee, benchByPin, benchByToken, live]
    try {
      await subscribe(live, 'relay-ls', [{ table: 'match_live_state', event: 'UPDATE', column: 'sport_type', value: 'beach' }])
      // openbeach's sync-match-data today (Scoreboard_beach.jsx): team1*/team2* names
      scoreboard.send({
        type: 'sync-match-data',
        matchId: 1,
        match: {
          id: 1, seed_key: ext, status: 'live', gamePin: GAME_PIN, matchPin: MATCH_PIN,
          refereePin: PINS.referee, team1Pin: PINS.bench_team1, team2Pin: PINS.bench_team2,
          team1TeamUploadPin: PINS.upload_team1,
          refereeConnectionEnabled: true, team1TeamConnectionEnabled: true, team2TeamConnectionEnabled: false,
          team1Name: 'Muster / Beispiel', team2Name: 'Rossi / Bianchi'
        },
        team1Team: { name: 'Muster / Beispiel', color: '#ef4444' },
        team2Team: { name: 'Rossi / Bianchi', color: '#3b82f6' },
        team1Players: [{ number: 1, lastName: 'Muster', dob: DOB }, { number: 2, lastName: 'Beispiel' }],
        team2Players: [{ number: 1, lastName: 'Rossi', dob: DOB }],
        sets: [{ index: 1, team1Points: 3, team2Points: 2 }],
        events: [{ id: 1, type: 'point' }]
      })
      scoreboard.send({ type: 'ping' })
      await scoreboard.waitFor((m) => m.type === 'pong')
      assert.equal(scoreboard.messages.some((m) => m.type === 'error'), false, JSON.stringify(scoreboard.messages.filter((m) => m.type === 'error')))

      // An indoor room whose referee PIN collides with the beach one: the
      // relay's validate-pin answers each sport with its own room only
      const indoorBoard = await openSocket(srv.wsUrl)
      all.push(indoorBoard)
      indoorBoard.send({
        type: 'sync-match-data',
        matchId: 2,
        match: { id: 2, seed_key: indoorExt, status: 'live', gamePin: INDOOR_GAME_PIN, refereePin: PINS.referee, refereeConnectionEnabled: true },
        homeTeam: { name: 'Home VC' },
        awayTeam: { name: 'Away VC' },
        homePlayers: [],
        awayPlayers: []
      })
      indoorBoard.send({ type: 'ping' })
      await indoorBoard.waitFor((m) => m.type === 'pong')
      assert.equal(indoorBoard.messages.some((m) => m.type === 'error'), false, JSON.stringify(indoorBoard.messages))
      const relayPin = (body) => api(srv.base, '/api/match/validate-pin', { proto: null, headers: { 'cf-connecting-ip': nextIp() }, body })
      const asBeach = await relayPin({ pin: PINS.referee, type: 'referee', sport: 'beach' })
      assert.equal(asBeach.status, 200, asBeach.text)
      assert.equal(asBeach.json.match.id, ext)
      assert.equal(asBeach.json.match.sportType, 'beach')
      const asIndoor = await relayPin({ pin: PINS.referee, type: 'referee' })
      assert.equal(asIndoor.status, 200, asIndoor.text)
      assert.equal(asIndoor.json.match.id, indoorExt, 'no sport: indoor rooms only')
      assert.equal('sportType' in asIndoor.json.match, false, 'the indoor answer is unchanged')
      assert.equal((await relayPin({ pin: PINS.referee, type: 'referee', sport: 'snow' })).status, 400)
      indoorBoard.ws.close()

      // the listing shows it with the team1/team2 names
      const list = await api(srv.base, '/api/match/list', { method: 'GET', proto: null })
      const listed = list.json.matches.find((m) => m.id === ext)
      assert.ok(listed, list.text)
      assert.equal(listed.homeTeam, 'Muster / Beispiel')
      assert.equal(listed.awayTeam, 'Rossi / Bianchi')

      viewer.send({ type: 'subscribe-match', matchId: ext })
      const summary = await viewer.waitFor((m) => m.type === 'match-full-data')
      assert.equal(summary.access, 'summary')
      assert.deepEqual(summary.homeTeam, { name: 'Muster / Beispiel', color: '#ef4444' })
      assert.deepEqual(summary.homePlayers, [])

      referee.send({ type: 'subscribe-match', matchId: ext, pin: PINS.referee, device: 'referee' })
      const full = await referee.waitFor((m) => m.type === 'match-full-data')
      assert.equal(full.access, 'full')
      assert.deepEqual(full.homePlayers, [{ number: 1, lastName: 'Muster' }, { number: 2, lastName: 'Beispiel' }])
      assert.deepEqual(full.awayPlayers, [{ number: 1, lastName: 'Rossi' }])
      for (const k of ['matchPin', 'team1Pin', 'team2Pin', 'team1TeamUploadPin', 'gamePin', 'refereePin']) assert.equal(k in full.match, false, k)

      benchByPin.send({ type: 'subscribe-match', matchId: ext, pin: PINS.bench_team1 })
      assert.equal((await benchByPin.waitFor((m) => m.type === 'match-full-data')).access, 'full')
      const team2 = await openSocket(srv.wsUrl)
      try {
        team2.send({ type: 'subscribe-match', matchId: ext, pin: PINS.bench_team2 })
        assert.equal((await team2.waitFor((m) => m.type === 'error')).code, 'pin-invalid', 'team2 bench connection is off')
      } finally { team2.ws.close() }

      const tok = await pinCheck({ pin: PINS.bench_team1, type: 'bench_team1', sport: 'beach' })
      benchByToken.send({ type: 'subscribe-match', matchId: ext, token: tok.json.token })
      assert.equal((await benchByToken.waitFor((m) => m.type === 'match-full-data')).access, 'full')
      const byToken = await api(srv.base, `/api/match/${encodeURIComponent(ext)}`, { method: 'GET', proto: null, headers: { 'X-OV-Match-Token': tok.json.token } })
      assert.equal(byToken.json.access, 'full')
      assert.equal(byToken.json.homePlayers.length, 2)

      // live state over the relay: published with the row's sport_type
      scoreboard.send({ type: 'live-state-update', matchId: 1, liveState: { points_a: 9, points_b: 7, server_number: 1, match_id: beachUuid, updated_at: new Date(Date.now() + 60000).toISOString() } })
      const u = await live.waitFor((m) => m.type === 'db-change' && m.table === 'match_live_state' && m.new?.points_a === 9, 5000, 'relayed beach live state')
      assert.equal(u.new.match_id, beachUuid)
      assert.equal(u.new.sport_type, 'beach', 'carried from the matches row')

      for (const c of [viewer, referee, benchByPin, benchByToken, live]) {
        assert.equal(containsPin(c.raw.join('')), false, 'a PIN was relayed')
        assert.equal(c.raw.join('').includes(DOB), false, 'a date of birth was relayed')
      }
    } finally {
      for (const c of all) c.ws.close()
    }
  })

  it('scoresheets: beach/{date}/gameN does not collide with the indoor {date}/gameN', async () => {
    const date = '2026-10-06'
    const name = `game1_k${randomBytes(16).toString('hex')}_final.json`
    const up = async (user, path, body) => api(srv.base, '/api/storage/upload', { token: user.token, body: { bucket: 'scoresheets', path, fileBase64: Buffer.from(JSON.stringify(body)).toString('base64'), contentType: 'application/json' } })
    const indoor = await up(users.ivan, `${date}/${name}`, { sport: 'indoor' })
    assert.equal(indoor.status, 200, indoor.text)
    const beach = await up(users.alice, `beach/${date}/${name}`, { sport: 'beach' })
    assert.equal(beach.status, 200, beach.text)
    const list = await api(srv.base, '/api/storage/list', { token: users.alice.token, body: { bucket: 'scoresheets', path: `beach/${date}` } })
    assert.deepEqual(list.json.data.map((f) => f.name), [name])
    const down = await api(srv.base, '/api/storage/download', { token: users.alice.token, body: { bucket: 'scoresheets', path: `beach/${date}/${name}` } })
    assert.deepEqual(JSON.parse(Buffer.from(down.json.data, 'base64').toString()), { sport: 'beach' })
    const downIndoor = await api(srv.base, '/api/storage/download', { token: users.ivan.token, body: { bucket: 'scoresheets', path: `${date}/${name}` } })
    assert.deepEqual(JSON.parse(Buffer.from(downIndoor.json.data, 'base64').toString()), { sport: 'indoor' })
  })
})
