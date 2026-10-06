/**
 * Beach (openbeach, sport_type 'beach') on the shared backend: the
 * validate-connection-pin types per sport, beach match tokens and relay PIN
 * grants (lib/matchAccess.js), and the public projections of beach rows
 * (lib/publicColumns.js). Indoor answers must not change.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createMatchTokens, pinGrantsAccess, isTokenRole, connectionPinType, CONNECTION_PIN_TYPES } from '../lib/matchAccess.js'
import { projectLiveRow, projectAnonDbRows, anonSelectCheck } from '../lib/publicColumns.js'

const SECRET = 'x'.repeat(40)

describe('validate-connection-pin types per sport', () => {
  it('indoor keeps its five types, keys and flags', () => {
    assert.deepEqual(Object.keys(CONNECTION_PIN_TYPES.indoor), ['referee', 'bench_home', 'bench_away', 'upload_home', 'upload_away'])
    assert.deepEqual(connectionPinType('indoor', 'referee'), { pinKeys: ['referee'], enabledKey: 'referee_enabled' })
    assert.deepEqual(connectionPinType('indoor', 'bench_home'), { pinKeys: ['bench_home'], enabledKey: 'home_bench_enabled' })
    assert.deepEqual(connectionPinType('indoor', 'bench_away'), { pinKeys: ['bench_away'], enabledKey: 'away_bench_enabled' })
    assert.deepEqual(connectionPinType('indoor', 'upload_home'), { pinKeys: ['upload_home'], enabledKey: null })
  })

  it('beach: referee, team1/team2 benches (current and old key), upload PINs', () => {
    assert.deepEqual(connectionPinType('beach', 'referee'), { pinKeys: ['referee'], enabledKey: 'referee_enabled' })
    assert.deepEqual(connectionPinType('beach', 'bench_team1'), { pinKeys: ['bench_team1', 'team1_data'], enabledKey: 'team1_bench_enabled' })
    assert.deepEqual(connectionPinType('beach', 'bench_team2'), { pinKeys: ['bench_team2', 'team2_data'], enabledKey: 'team2_bench_enabled' })
    assert.deepEqual(connectionPinType('beach', 'upload_team1'), { pinKeys: ['upload_team1'], enabledKey: null })
  })

  it('a type of the other sport, an unknown sport or a prototype key is refused', () => {
    assert.equal(connectionPinType('beach', 'bench_home'), null)
    assert.equal(connectionPinType('indoor', 'bench_team1'), null)
    assert.equal(connectionPinType('snow', 'referee'), null)
    assert.equal(connectionPinType('beach', '__proto__'), null)
    assert.equal(connectionPinType('constructor', 'referee'), null)
    assert.equal(connectionPinType(null, 'referee'), null)
    assert.equal(connectionPinType('beach', 7), null)
  })
})

describe('beach match tokens', () => {
  const tokens = createMatchTokens({ secret: SECRET })
  // The scorer's Dexie match as openbeach relays it
  const beach = {
    seed_key: 'match_b', refereePin: '314159', refereeConnectionEnabled: true,
    team1Pin: '271828', team1TeamConnectionEnabled: true,
    team2Pin: '161803', team2TeamConnectionEnabled: false
  }

  it('bench_team1 / bench_team2 are token roles; the beach upload PINs are not', () => {
    assert.equal(isTokenRole('bench_team1'), true)
    assert.equal(isTokenRole('bench_team2'), true)
    assert.equal(isTokenRole('upload_team1'), false)
  })

  it('a bench_team1 token follows the team1 connection flag and PIN on the relay', () => {
    const t1 = tokens.verify(tokens.issue({ matchKey: 'match_b', role: 'bench_team1', pin: '271828' }))
    assert.equal(tokens.stillGrants(t1, beach), true)
    assert.equal(tokens.stillGrants(t1, { ...beach, team1TeamConnectionEnabled: false }), false, 'team1 bench disconnected')
    assert.equal(tokens.stillGrants(t1, { ...beach, team1Pin: '999999' }), false, 'PIN regenerated')
    // older openbeach builds: team1TeamPin
    const { team1Pin, ...old } = beach
    assert.equal(tokens.stillGrants(t1, { ...old, team1TeamPin: '271828' }), true)
    assert.equal(tokens.stillGrants(t1, { ...old, team1TeamPin: '999999' }), false)
    // a beach scorer sending the home/away wire names (team1 = home)
    assert.equal(tokens.stillGrants(t1, { homeTeamPin: '271828', homeTeamConnectionEnabled: true }), true)
    assert.equal(tokens.stillGrants(t1, { homeTeamPin: '271828', homeTeamConnectionEnabled: false }), false)
    // team2's connection is off
    const t2 = tokens.verify(tokens.issue({ matchKey: 'match_b', role: 'bench_team2', pin: '161803' }))
    assert.equal(tokens.stillGrants(t2, beach), false)
    assert.equal(tokens.stillGrants(t2, { ...beach, team2TeamConnectionEnabled: true }), true)
    // the referee role is shared
    const ref = tokens.verify(tokens.issue({ matchKey: 'match_b', role: 'referee', pin: '314159' }))
    assert.equal(tokens.stillGrants(ref, beach), true)
  })

  it('database rows: the beach connection flags', () => {
    const t1 = tokens.verify(tokens.issue({ matchKey: 'match_b', role: 'bench_team1', pin: '271828' }))
    assert.equal(tokens.stillGrantsRow(t1, { connections: { team1_bench_enabled: true } }), true)
    assert.equal(tokens.stillGrantsRow(t1, { connections: { team1_bench_enabled: false } }), false)
    assert.equal(tokens.stillGrantsRow(t1, { connections: { home_bench_enabled: true } }), false, 'the indoor flag is not the beach one')
    const home = tokens.verify(tokens.issue({ matchKey: 'm', role: 'bench_home', pin: '271828' }))
    assert.equal(tokens.stillGrantsRow(home, { connections: { team1_bench_enabled: true } }), false, 'and the other way round')
  })

  it('indoor tokens are unchanged by the beach names', () => {
    const home = tokens.verify(tokens.issue({ matchKey: 'm', role: 'bench_home', pin: '271828' }))
    assert.equal(tokens.stillGrants(home, { homeTeamPin: '271828', homeTeamConnectionEnabled: true }), true)
    assert.equal(tokens.stillGrants(home, { team1Pin: '271828', team1TeamConnectionEnabled: true }), false, 'an indoor role never reads team1 fields')
  })
})

describe('pinGrantsAccess for beach matches (relay)', () => {
  const beach = {
    refereePin: '314159', refereeConnectionEnabled: true,
    team1Pin: '271828', team1TeamConnectionEnabled: true,
    team2TeamPin: '161803', team2TeamConnectionEnabled: false,
    team1UploadPin: '141421', matchPin: '424242', gamePin: '987654'
  }
  it('referee, an enabled team bench (new or old field name), the game PIN; never upload or the match-protect PIN', () => {
    assert.equal(pinGrantsAccess(beach, '314159'), true)
    assert.equal(pinGrantsAccess(beach, '271828'), true)
    assert.equal(pinGrantsAccess(beach, '987654'), true)
    assert.equal(pinGrantsAccess(beach, '161803'), false, 'team2 bench connection is off')
    assert.equal(pinGrantsAccess({ ...beach, team2TeamConnectionEnabled: true }, '161803'), true, 'older team2TeamPin name')
    assert.equal(pinGrantsAccess(beach, '141421'), false)
    assert.equal(pinGrantsAccess(beach, '424242'), false)
    assert.equal(pinGrantsAccess({ ...beach, team1TeamConnectionEnabled: false }, '271828'), false)
  })
})

describe('public projections of beach rows', () => {
  const row = {
    id: 'u1', external_id: 'match_b', sport_type: 'beach', status: 'live', game_n: 12,
    team1_data: { name: 'Muster / Beispiel', short_name: 'MUS', color: '#ef4444', country: 'SUI', secret: 'x' },
    team2_data: { name: 'Rossi / Bianchi', short_name: 'ROS', color: '#3b82f6' },
    players_team1: [{ number: 1, first_name: 'Anna', last_name: 'Muster', dob: '2001-01-01', country: 'SUI', is_captain: true }],
    players_team2: [{ number: 2, first_name: 'Lia', last_name: 'Rossi', dob: '2002-02-02' }],
    connections: { referee_enabled: true, team1_bench_enabled: true, team2_bench_enabled: false, other: 1 },
    connection_pins: { referee: '314159' },
    officials: [{ role: 'referee 1', last_name: 'R', dob: '1980-01-01' }],
    signatures: { team1_captain: 'data:...' }
  }

  it('live viewers get the beach teams (names and colours), no rosters, no connection data', () => {
    const live = projectLiveRow('matches', row)
    assert.deepEqual(live.team1_data, { name: 'Muster / Beispiel', short_name: 'MUS', color: '#ef4444' })
    assert.deepEqual(live.team2_data, { name: 'Rossi / Bianchi', short_name: 'ROS', color: '#3b82f6' })
    assert.equal(live.sport_type, 'beach')
    for (const k of ['players_team1', 'players_team2', 'connections', 'connection_pins', 'officials', 'signatures']) {
      assert.equal(k in live, false, k)
    }
  })

  it('anonymous /api/db: beach connection flags for the pickers; rosters only with the match token', () => {
    const anon = projectAnonDbRows('matches', row)
    assert.deepEqual(anon.connections, { referee_enabled: true, team1_bench_enabled: true, team2_bench_enabled: false })
    assert.equal('players_team1' in anon, false)
    assert.equal('connection_pins' in anon, false)
    const granted = projectAnonDbRows('matches', row, { grantedExternalId: 'match_b' })
    assert.deepEqual(granted.players_team1, [{ number: 1, first_name: 'Anna', last_name: 'Muster', is_captain: true }])
    assert.deepEqual(granted.players_team2, [{ number: 2, first_name: 'Lia', last_name: 'Rossi' }])
    // grantRow sees the projected flags, so a bench_team1 token can be checked
    const tokens = createMatchTokens({ secret: SECRET })
    const t1 = tokens.verify(tokens.issue({ matchKey: 'match_b', role: 'bench_team1', pin: '271828' }))
    const t2 = tokens.verify(tokens.issue({ matchKey: 'match_b', role: 'bench_team2', pin: '161803' }))
    assert.equal('players_team1' in projectAnonDbRows('matches', row, { grantedExternalId: 'match_b', grantRow: (r) => tokens.stillGrantsRow(t1, r) }), true)
    assert.equal('players_team1' in projectAnonDbRows('matches', row, { grantedExternalId: 'match_b', grantRow: (r) => tokens.stillGrantsRow(t2, r) }), false)
  })

  it('beach sets keep team1/team2 points; the beach team columns are not filterable', () => {
    assert.deepEqual(projectLiveRow('sets', { id: 's', sport_type: 'beach', team1_points: 21, team2_points: 19, lineup: [1] }),
      { id: 's', sport_type: 'beach', team1_points: 21, team2_points: 19 })
    assert.equal(anonSelectCheck('matches', { columns: 'id', filters: [{ type: 'eq', column: 'sport_type', value: 'beach' }] }).badFilter, null)
    assert.equal(anonSelectCheck('matches', { columns: 'id', filters: [{ type: 'contains', column: 'team1_data', value: '{}' }] }).badFilter, 'team1_data')
    assert.equal(anonSelectCheck('matches', { columns: 'id, team1_data' }).needsMore, true, 'team1_data is kept in part only')
  })

  it('live state rows of beach matches keep the beach fields the displays read', () => {
    const ls = projectLiveRow('match_live_state', { match_id: 'u1', sport_type: 'beach', points_a: 5, server_number: 2, challenges_used_a: 1, connection_pins: { r: 1 } })
    assert.deepEqual(ls, { match_id: 'u1', sport_type: 'beach', points_a: 5, server_number: 2, challenges_used_a: 1 })
  })
})
