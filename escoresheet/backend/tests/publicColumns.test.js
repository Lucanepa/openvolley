/**
 * What anonymous readers see: lib/publicColumns.js on its own, and wired into
 * the realtime hub the way server.js wires it (redactSecrets, then
 * projectLiveRow). Also the hub's duplicate drop (one frame per scorer state).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  LIVE_COLUMNS,
  ANON_DB_COLUMNS,
  ANON_DB_FILTER_COLUMNS,
  projectRow,
  projectRows,
  projectLiveRow,
  hasAnonPolicy,
  anonSelectCheck,
  publicRelayMatch,
  publicPeople,
  relayMatchListRow,
  cloudListsMatch,
  isPublicIp
} from '../lib/publicColumns.js'
import { createRealtimeHub } from '../lib/realtimeHub.js'
import { redactSecrets } from '../lib/secrets.js'

const MATCH = '33333333-3333-4333-8333-333333333333'
const SIGNATURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'
const DOB = '2001-02-03'

/** A matches row as the scorer syncs it (shape from CoinToss/MatchSetup/backupManager). */
function fullMatchRow() {
  return {
    id: MATCH,
    external_id: 'seed-1',
    game_n: 991303,
    game_pin: '864201',
    connection_pins: { referee: '531642', bench_home: '642753' },
    status: 'live',
    sport_type: 'indoor',
    test: false,
    scheduled_at: '2026-10-05T16:00:00+00:00',
    created_at: '2026-10-05T15:00:00+00:00',
    updated_at: '2026-10-05T16:30:00+00:00',
    current_set: 2,
    set_results: [{ set: 1, home: 25, away: 2 }],
    final_score: null,
    winner: null,
    home_team: { name: 'Home VC', short_name: 'HVC', color: '#ff0000', coach_email: 'coach@example.ch' },
    away_team: { name: 'Away VC', short_name: 'AVC', color: '#0000ff' },
    match_info: { hall: 'Halle', city: 'Zürich', league: '3L', championship_type: 'league', best_of: 3, scorer_phone: '079' },
    coin_toss: { team_a: 'home', team_b: 'away', confirmed: true, first_serve: 'home', serve_a: true },
    connections: { referee_enabled: true, home_bench_enabled: true, away_bench_enabled: false, pending_home_roster: { players: [{ number: 1, dob: DOB }] } },
    players_home: [{ number: 1, first_name: 'Ana', last_name: 'Muster', dob: DOB, libero: '', is_captain: true, is_lfp: false }],
    players_away: [{ number: 7, firstName: 'Bea', lastName: 'Beispiel', dob: DOB, libero: 'libero1' }],
    bench_home: [{ role: 'Coach', firstName: 'Carl', lastName: 'Coach', dob: DOB }],
    bench_away: [],
    officials: [{ role: '1st referee', firstName: 'Rita', lastName: 'Ref', dob: DOB, country: 'CHE' }],
    signatures: { home_coach: SIGNATURE, away_captain: SIGNATURE },
    approval: { approved_by: 'Rita Ref', signature: SIGNATURE },
    manual_changes: [{ field: 'x' }],
    sanctions: [{ player: 1 }],
    results: { note: 'x' },
    // db/017: the scorer's remarks (free text: names, injuries) are not public
    remarks: 'Team A, Set 2, Result 3:5: player no. 4 Muster injured, call 079'
  }
}

const json = (v) => JSON.stringify(v)
const leaksPersonalData = (text) => text.includes(DOB) || text.includes('data:image') || text.includes('864201') ||
  text.includes('531642') || text.includes('Rita') || text.includes('coach@') || text.includes('079')

describe('publicColumns: live projection', () => {
  it('keeps what livescore and the tablets read of a match, nothing personal', () => {
    const live = projectLiveRow('matches', redactSecrets('matches', fullMatchRow()))
    assert.equal(leaksPersonalData(json(live)), false, json(live))
    for (const col of ['players_home', 'players_away', 'bench_home', 'bench_away', 'officials', 'signatures',
      'approval', 'connections', 'connection_pins', 'game_pin', 'manual_changes', 'sanctions', 'results', 'remarks']) {
      assert.equal(col in live, false, col)
    }
    assert.equal(live.id, MATCH)
    assert.equal(live.external_id, 'seed-1')
    assert.equal(live.sport_type, 'indoor', 'filter columns survive the projection')
    assert.deepEqual(live.set_results, [{ set: 1, home: 25, away: 2 }])
    assert.deepEqual(live.home_team, { name: 'Home VC', short_name: 'HVC', color: '#ff0000' })
    assert.deepEqual(live.match_info, { hall: 'Halle', city: 'Zürich', league: '3L', championship_type: 'league', best_of: 3 })
    assert.equal(live.coin_toss.team_a, 'home')
  })

  it('keeps every match_live_state column the referee and livescore read', () => {
    const row = {
      id: 'x', match_id: MATCH, sport_type: 'indoor', current_set: 5, best_of: 3, match_status: 'in_progress',
      points_a: 8, points_b: 5, sets_won_a: 1, sets_won_b: 1, side_a: 'left', serving_team: 'right',
      lineup_a: { I: { number: 7 } }, team_a_name: 'A', team_b_name: 'B', scorer_attention_trigger: 't',
      set_interval_active: false, timeout_active: false, updated_at: '2026-10-05T16:00:00Z', game_pin: '864201'
    }
    const live = projectLiveRow('match_live_state', redactSecrets('match_live_state', row))
    const { game_pin: _pin, ...expected } = row
    assert.deepEqual(live, expected)
  })

  it('keeps the beach live-state columns (server, challenges, technical timeout)', () => {
    const row = {
      match_id: MATCH, sport_type: 'beach', points_a: 12, points_b: 9, server_number: 2,
      challenges_used_a: 0, challenges_used_b: 1, tto_active: true, tto_started_at: '2026-10-06T10:00:00Z'
    }
    assert.deepEqual(projectLiveRow('match_live_state', row), row)
  })

  it('events go out without payload or state snapshot; sets unchanged', () => {
    const ev = projectLiveRow('events', { id: 1, match_id: MATCH, external_id: 'seed-1:e:1', type: 'sanction', set_index: 1, payload: { playerName: 'Ana' }, state_snapshot: { x: 1 }, lineup_left: {} })
    assert.deepEqual(ev, { id: 1, match_id: MATCH, external_id: 'seed-1:e:1', type: 'sanction', set_index: 1 })
    const set = { id: 's', match_id: MATCH, index: 5, home_points: 15, away_points: 10, finished: true }
    assert.deepEqual(projectLiveRow('sets', set), set)
  })

  it('never mutates the row and passes tables without a policy', () => {
    const row = fullMatchRow()
    const before = json(row)
    projectLiveRow('matches', row)
    assert.equal(json(row), before)
    const other = { a: 1 }
    assert.equal(projectLiveRow('profiles', other), other)
    assert.equal(projectRow(LIVE_COLUMNS, 'matches', null), null)
  })
})

describe('publicColumns: anonymous /api/db reads', () => {
  it('keeps the rosters the referee/bench render, without dates of birth', () => {
    const anon = projectRows(ANON_DB_COLUMNS, 'matches', [redactSecrets('matches', fullMatchRow())])[0]
    assert.equal(leaksPersonalData(json(anon)), false, json(anon))
    assert.deepEqual(anon.players_home, [{ number: 1, first_name: 'Ana', last_name: 'Muster', libero: '', is_captain: true, is_lfp: false }])
    assert.deepEqual(anon.players_away, [{ number: 7, firstName: 'Bea', lastName: 'Beispiel', libero: 'libero1' }])
    assert.deepEqual(anon.bench_home, [{ role: 'Coach', firstName: 'Carl', lastName: 'Coach' }])
    assert.deepEqual(anon.connections, { referee_enabled: true, home_bench_enabled: true, away_bench_enabled: false })
    for (const col of ['officials', 'signatures', 'approval', 'manual_changes', 'sanctions', 'results', 'remarks']) assert.equal(col in anon, false, col)
    assert.equal(anonSelectCheck('matches', { columns: 'id, remarks' }).needsMore, true, 'remarks need a session')
    assert.equal(anonSelectCheck('matches', { columns: 'id', filters: [{ type: 'eq', column: 'remarks', value: 'x' }] }).badFilter, 'remarks')
    // single / maybeSingle answers are one object
    assert.equal(projectRows(ANON_DB_COLUMNS, 'matches', fullMatchRow()).officials, undefined)
    assert.equal(hasAnonPolicy('matches'), true)
    assert.equal(hasAnonPolicy('match_live_state'), false)
  })

  it('anonSelectCheck: public columns need no session; JSON columns and non-public filters do', () => {
    assert.deepEqual(anonSelectCheck('matches', { columns: 'id' }), { needsMore: false, badFilter: null })
    assert.deepEqual(anonSelectCheck('matches', { columns: 'id, status', filters: [{ type: 'eq', column: 'external_id', value: 'x' }], order: [{ column: 'scheduled_at' }] }), { needsMore: false, badFilter: null })
    assert.equal(anonSelectCheck('matches', { columns: '*' }).needsMore, true)
    assert.equal(anonSelectCheck('matches', {}).needsMore, true)
    assert.equal(anonSelectCheck('matches', { columns: 'signatures, connections' }).needsMore, true)
    assert.equal(anonSelectCheck('matches', { columns: 'players_home' }).needsMore, true, 'partly public: a session sees more')
    for (const column of ['players_home', 'players_home->>dob', 'officials', 'signatures->>home_coach', 'set_results', 'connections->>pending_home_roster']) {
      assert.equal(anonSelectCheck('matches', { columns: 'id', filters: [{ type: 'contains', column, value: '[]' }] }).badFilter, column)
      assert.equal(anonSelectCheck('matches', { columns: 'id', order: { column } }).badFilter, column)
    }
    assert.deepEqual(anonSelectCheck('match_live_state', { columns: '*' }), { needsMore: false, badFilter: null })
    assert.ok(ANON_DB_FILTER_COLUMNS.matches.every((c) => ANON_DB_COLUMNS.matches[c] === true))
  })
})

describe('publicColumns: referee dates of birth', () => {
  it('referee_database and svrz_games keep names, drop dob; dob cannot be filtered on', () => {
    const ref = { id: 'r1', first_name: 'Rita', last_name: 'Ref', country: 'SUI', dob: DOB, sport_type: ['indoor'], created_at: 'x' }
    assert.deepEqual(projectRows(ANON_DB_COLUMNS, 'referee_database', [ref]),
      [{ id: 'r1', first_name: 'Rita', last_name: 'Ref', country: 'SUI', sport_type: ['indoor'], created_at: 'x' }])
    const game = { id: 1, game_number: '991303', league: 'H2', referee_1: 'Rita Ref', referee_1_first_name: 'Rita', referee_1_dob: DOB, referee_2_dob: DOB, convocations: ['Rita Ref'] }
    const anon = projectRows(ANON_DB_COLUMNS, 'svrz_games', game)
    assert.equal(json(anon).includes(DOB), false)
    assert.equal(anon.referee_1_first_name, 'Rita')
    assert.deepEqual(anon.convocations, ['Rita Ref'])
    for (const t of ['referee_database', 'svrz_games']) assert.equal(hasAnonPolicy(t), true, t)

    // The pickers' queries: public ones need nothing; asking for dob is projected
    // unless a session verifies; filtering on dob is refused
    assert.deepEqual(anonSelectCheck('referee_database', {
      columns: 'id, sport_type',
      filters: [{ type: 'ilike', column: 'last_name', value: 'r%' }, { type: 'contains', column: 'sport_type', value: '["indoor"]' }],
      order: [{ column: 'last_name' }]
    }), { needsMore: false, badFilter: null })
    assert.equal(anonSelectCheck('referee_database', { columns: 'first_name, last_name, country, dob, created_at' }).needsMore, true)
    assert.equal(anonSelectCheck('referee_database', { columns: 'id', filters: [{ type: 'eq', column: 'dob', value: DOB }] }).badFilter, 'dob')
    assert.equal(anonSelectCheck('svrz_games', { columns: '*', filters: [{ type: 'eq', column: 'league', value: 'H2' }], order: [{ column: 'datetime' }] }).badFilter, null)
    assert.equal(anonSelectCheck('svrz_games', { columns: '*' }).needsMore, true)
    assert.equal(anonSelectCheck('svrz_games', { columns: 'id', order: { column: 'referee_1_dob' } }).badFilter, 'referee_1_dob')
    for (const t of ['referee_database', 'svrz_games']) {
      assert.ok(ANON_DB_FILTER_COLUMNS[t].every((c) => ANON_DB_COLUMNS[t][c] === true), t)
      assert.ok(Object.keys(ANON_DB_COLUMNS[t]).every((c) => !/dob/.test(c)), t)
    }
  })
})

describe('publicColumns: the match relay bundle', () => {
  it('publicRelayMatch drops officials, signatures, approval, pending rosters, manual changes and dob', () => {
    const match = {
      id: 7,
      status: 'live',
      refereeConnectionEnabled: true,
      officials: [{ role: '1st referee', lastName: 'Ref', dob: DOB }],
      signatures: { home_coach: SIGNATURE },
      homeCoachSignature: SIGNATURE,
      away_captain_signature: SIGNATURE,
      approval: { approved: true },
      manualChanges: [{ a: 1 }],
      manual_changes: [{ a: 1 }],
      pendingHomeRoster: { players: [] },
      pending_away_roster: { players: [] },
      bench_home: [{ role: 'Coach', lastName: 'Coach', dob: DOB, country: 'SUI' }],
      players_home: [{ number: 4, lastName: 'P', birthdate: DOB }],
      remarks: 'ok'
    }
    const before = json(match)
    const out = publicRelayMatch(match)
    assert.equal(json(match), before, 'not mutated')
    assert.deepEqual(out, {
      id: 7,
      status: 'live',
      refereeConnectionEnabled: true,
      bench_home: [{ role: 'Coach', lastName: 'Coach' }],
      players_home: [{ number: 4, lastName: 'P' }],
      remarks: 'ok'
    })
    assert.deepEqual(publicPeople([{ number: 1, dob: DOB, country: 'SUI', email: 'a@b' }, null]), [{ number: 1 }, null])
    assert.equal(publicRelayMatch(null), null)
  })

  it('relayMatchListRow: scheduled/live matches whatever the referee connection, public fields only', () => {
    const entry = {
      matchId: 'seed-1',
      match: {
        status: 'scheduled',
        gameNumber: 4711,
        refereeConnectionEnabled: false,
        refereePin: '314159',
        gamePin: '987654',
        scheduledAt: '2026-10-05T18:00:00.000Z',
        officials: [{ lastName: 'Ref', dob: DOB }],
        homeCoachSignature: SIGNATURE
      },
      homeTeam: { name: 'Home VC', players: [{ dob: DOB }] },
      awayTeam: 'Away VC',
      homePlayers: [{ number: 1, dob: DOB }]
    }
    const row = relayMatchListRow(entry)
    assert.deepEqual(row, {
      id: 'seed-1',
      gameNumber: 4711,
      homeTeam: 'Home VC',
      awayTeam: 'Away VC',
      scheduledAt: '2026-10-05T18:00:00.000Z',
      dateTime: row.dateTime,
      status: 'scheduled',
      sportType: 'indoor',
      test: false,
      refereeConnectionEnabled: false,
      homeTeamConnectionEnabled: false,
      awayTeamConnectionEnabled: false
    })
    assert.equal(typeof row.dateTime, 'string')
    assert.deepEqual(
      ['homeTeamConnectionEnabled', 'awayTeamConnectionEnabled'].map((k) => relayMatchListRow({ matchId: 'x', match: { homeTeamConnectionEnabled: true, awayTeamConnectionEnabled: 'yes' } })[k]),
      [true, false]
    )
    assert.ok(!/314159|987654|dob|Ref|data:image/.test(json(row)))
    // No status counts as scheduled; finished matches are not listed
    assert.equal(relayMatchListRow({ matchId: 'x', match: {} }).status, 'scheduled')
    assert.equal(relayMatchListRow({ matchId: 'x', match: { status: 'final' } }), null)
    // ?finished=1 (the livescore): finished ones too
    assert.equal(relayMatchListRow({ matchId: 'x', match: { status: 'final' } }, { includeFinished: true }).status, 'final')
    assert.equal(relayMatchListRow({ matchId: 'x', match: { status: 'ended' } }, { includeFinished: true }).status, 'ended')
    assert.equal(relayMatchListRow({ matchId: 'x', match: { status: 'cancelled' } }, { includeFinished: true }), null)
    // Team names from the match when the bundle has none; defaults otherwise
    assert.deepEqual(
      [relayMatchListRow({ matchId: 'x', match: { homeTeamName: 'A' } }).homeTeam, relayMatchListRow({ matchId: 'x', match: {} }).awayTeam],
      ['A', 'Away']
    )
    assert.equal(relayMatchListRow({ matchId: 'x', match: { test: true, status: 'live' } }).test, true)
    // The sport of the room (handleSyncMatchData): openbeach lists only its own
    assert.equal(relayMatchListRow({ matchId: 'x', sportType: 'beach', match: {} }).sportType, 'beach')
    assert.equal(relayMatchListRow({ matchId: 'x', sportType: 'other', match: { sport_type: 'beach' } }).sportType, 'indoor')
  })

  it('isPublicIp: only routable internet addresses', () => {
    for (const ip of ['203.0.113.9', '8.8.8.8', '::ffff:8.8.8.8', '2001:db8::1', '172.32.0.1', '100.128.0.1']) assert.equal(isPublicIp(ip), true, ip)
    for (const ip of ['127.0.0.1', '::1', '10.0.0.5', '172.18.0.5', '192.168.1.20', '169.254.1.1', '100.100.1.1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '', null, 'unknown', 'x.y']) assert.equal(isPublicIp(ip), false, String(ip))
  })

  it('cloudListsMatch: referee connection on for everyone; otherwise only to its own venue (same public address)', () => {
    // Referee connection on: listed for every caller (the referee tablets pick it)
    assert.equal(cloudListsMatch({ refereeConnectionEnabled: true, requesterIp: '198.51.100.1', requesterIpKey: '198.51.100.1', ownerIpKeys: ['203.0.113.9'] }), true)
    // Off: the venue's LedBox behind the same NAT as the scorer sees it ...
    assert.equal(cloudListsMatch({ requesterIp: '203.0.113.9', requesterIpKey: '203.0.113.9', ownerIpKeys: ['198.51.100.7', '203.0.113.9'] }), true)
    assert.equal(cloudListsMatch({ requesterIp: '2001:db8:1:2::99', requesterIpKey: '2001:db8:1:2::/64', ownerIpKeys: ['2001:db8:1:2::/64'] }), true)
    // ... nobody else does
    assert.equal(cloudListsMatch({ requesterIp: '198.51.100.1', requesterIpKey: '198.51.100.1', ownerIpKeys: ['203.0.113.9'] }), false)
    assert.equal(cloudListsMatch({ requesterIp: '198.51.100.1', requesterIpKey: '198.51.100.1', ownerIpKeys: [] }), false)
    // Behind a proxy that hides the caller every request comes from the proxy:
    // a private address is no venue, even when the scoreboard shares it
    assert.equal(cloudListsMatch({ requesterIp: '172.18.0.5', requesterIpKey: '172.18.0.5', ownerIpKeys: ['172.18.0.5'] }), false)
    assert.equal(cloudListsMatch({ requesterIp: '127.0.0.1', requesterIpKey: '127.0.0.1', ownerIpKeys: ['127.0.0.1'] }), false)
    assert.equal(cloudListsMatch(), false)
  })

  it('publicRelayMatch drops openbeach\'s pending team1/team2 rosters and filters its team rosters', () => {
    const roster = { players: [{ number: 1, lastName: 'Muster', dob: DOB }] }
    const out = publicRelayMatch({
      id: 3,
      team1Name: 'Muster / Beispiel',
      pendingTeam1Roster: roster,
      pendingTeam2Roster: roster,
      pending_team1_roster: roster,
      pending_team2_roster: roster,
      players_team1: [{ number: 1, lastName: 'Muster', dob: DOB }],
      team2Players: [{ number: 2, lastName: 'Rossi', dateOfBirth: DOB }]
    })
    assert.deepEqual(out, {
      id: 3,
      team1Name: 'Muster / Beispiel',
      players_team1: [{ number: 1, lastName: 'Muster' }],
      team2Players: [{ number: 2, lastName: 'Rossi' }]
    })
    assert.equal(json(out).includes(DOB), false)
  })
})

// ---------------------------------------------------------------------------
// The hub, wired like server.js, over in-memory sockets
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = [] }
  send(data) { this.sent.push(JSON.parse(String(data))) }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close') }
  terminate() { this.close() }
  ping() {}
  deliver(msg) { this.emit('message', Buffer.from(JSON.stringify(msg)), false) }
  changes() { return this.sent.filter((m) => m.type === 'db-change') }
}

function liveHub(extra = {}) {
  const hub = createRealtimeHub({ redact: redactSecrets, project: projectLiveRow, pingIntervalMs: 0, logger: { log() {}, warn() {} }, ...extra })
  const subscriber = (subs) => {
    const ws = new FakeSocket()
    hub.handleConnection(ws, null, { ip: '198.51.100.7' })
    ws.deliver({ type: 'subscribe-db', id: 'c', subs })
    assert.equal(ws.sent.at(-1).type, 'subscribe-db-ack', json(ws.sent.at(-1)))
    return ws
  }
  return { hub, subscriber }
}

describe('realtimeHub with the live projection', () => {
  it('an anonymous subscriber of matches never receives personal fields (INSERT, UPDATE with old, DELETE)', () => {
    const { hub, subscriber } = liveHub()
    const livescore = subscriber([{ table: 'matches', event: '*', column: 'sport_type', value: 'indoor' }])
    const tablet = subscriber([{ table: 'matches', event: '*', column: 'external_id', value: 'seed-1' }])
    hub.broadcastDbChange('matches', 'UPSERT', [{ ...fullMatchRow(), __inserted: true }])
    hub.broadcastDbChange('matches', 'UPDATE', [fullMatchRow()], { oldRows: [fullMatchRow()] })
    hub.broadcastDbChange('matches', 'DELETE', [fullMatchRow()])
    for (const ws of [livescore, tablet]) {
      const frames = ws.changes().filter((m) => m.table === 'matches')
      assert.deepEqual(frames.map((m) => m.eventType), ['INSERT', 'UPDATE', 'DELETE'])
      const text = json(frames)
      assert.equal(leaksPersonalData(text), false, text.slice(0, 400))
      for (const f of frames) {
        for (const row of [f.new, f.old]) {
          for (const col of ['players_home', 'bench_home', 'officials', 'signatures', 'connections', 'approval']) assert.equal(col in row, false, col)
        }
      }
      assert.deepEqual(frames[0].new.set_results, [{ set: 1, home: 25, away: 2 }])
      assert.equal(frames[2].old.id, MATCH)
    }
    hub.close()
  })

  it('a filter on a column the projection drops never matches', () => {
    const hub = createRealtimeHub({ redact: redactSecrets, project: projectLiveRow, pingIntervalMs: 0, filterColumns: ['status', 'game_n', 'officials'], logger: { warn() {} } })
    const ws = new FakeSocket()
    hub.handleConnection(ws, null, { ip: '198.51.100.8' })
    ws.deliver({ type: 'subscribe-db', id: 'o', subs: [{ table: 'matches', event: '*', column: 'officials', value: '[]' }] })
    hub.broadcastDbChange('matches', 'UPDATE', [{ ...fullMatchRow(), officials: '[]' }])
    assert.equal(ws.changes().length, 0)
    hub.close()
  })

  it('rejects a project option that is not a function', () => {
    assert.throws(() => createRealtimeHub({ redact: redactSecrets, project: 'x' }), /project/)
  })
})

describe('realtimeHub: one frame per scorer state', () => {
  const T = '2026-10-05T18:06:28.890Z'
  // The scoreboard's liveStateData as the relay forwards it (no id)...
  const relayCopy = () => ({
    match_id: MATCH, sport_type: 'indoor', current_set: 1, points_a: 12, points_b: 9, sets_won_a: 0, sets_won_b: 0,
    side_a: 'left', serving_team: 'left', lineup_a: { I: { number: 7, isServing: true }, II: { number: 3 } },
    last_event_type: 'point', last_event_ts: T, last_event_data: { team: 'home', score: 1 },
    timeout_active: false, timeout_started_at: null, updated_at: T
  })
  // ...and the same state as Postgres RETURNs it: id, defaults, jsonb key order, +00:00 timestamps.
  const dbCopy = () => ({
    id: '44444444-4444-4444-8444-444444444444', ...relayCopy(),
    lineup_a: { II: { number: 3 }, I: { isServing: true, number: 7 } },
    last_event_data: { score: 1, team: 'home' },
    last_event_ts: '2026-10-05T18:06:28.89+00:00', updated_at: '2026-10-05T18:06:28.89+00:00',
    challenges_used_a: 0, challenges_used_b: 0, server_number: 0, set_results: [], __inserted: false
  })

  it('drops the second copy of the same state, in either order', () => {
    const { hub, subscriber } = liveHub()
    const viewer = subscriber([{ table: 'match_live_state', event: '*', column: 'sport_type', value: 'indoor' }])
    assert.equal(hub.broadcastDbChange('match_live_state', 'UPDATE', [relayCopy()]), 1)
    assert.equal(hub.broadcastDbChange('match_live_state', 'UPSERT', [dbCopy()]), 0)
    assert.equal(viewer.changes().length, 1)
    assert.equal(hub.stats().duplicateDropped, 1)
    // Next state: database first this time, then the relay copy
    const next = (row) => ({ ...row, points_a: 13, updated_at: '2026-10-05T18:06:31.000Z' })
    assert.equal(hub.broadcastDbChange('match_live_state', 'UPSERT', [next(dbCopy())]), 1)
    assert.equal(hub.broadcastDbChange('match_live_state', 'UPDATE', [next(relayCopy())]), 0)
    assert.deepEqual(viewer.changes().map((m) => m.new.points_a), [12, 13])
    hub.close()
  })

  it('a same-timestamp row that changes something still goes out', () => {
    const { hub, subscriber } = liveHub()
    const viewer = subscriber([{ table: 'match_live_state', event: '*', column: 'match_id', value: MATCH }])
    hub.broadcastDbChange('match_live_state', 'UPDATE', [relayCopy()])
    // the scorer-attention alarm does not bump updated_at
    hub.broadcastDbChange('match_live_state', 'UPDATE', [{ ...dbCopy(), scorer_attention_trigger: 'alarm-1' }])
    // a changed value of a shared column
    hub.broadcastDbChange('match_live_state', 'UPDATE', [{ ...relayCopy(), side_a: 'right' }])
    assert.equal(viewer.changes().length, 3)
    assert.equal(viewer.changes()[1].new.scorer_attention_trigger, 'alarm-1')
    assert.equal(viewer.changes()[2].new.side_a, 'right')
    hub.close()
  })

  it('a side-out (point, then rotation) still sends both states', () => {
    const { hub, subscriber } = liveHub()
    const viewer = subscriber([{ table: 'match_live_state', event: '*', column: 'match_id', value: MATCH }])
    const point = { ...relayCopy(), updated_at: '2026-10-05T18:06:28.890Z' }
    const rotation = { ...relayCopy(), last_event_type: 'rotation', lineup_a: { I: { number: 3 } }, updated_at: '2026-10-05T18:06:28.910Z' }
    hub.broadcastDbChange('match_live_state', 'UPDATE', [point])
    hub.broadcastDbChange('match_live_state', 'UPDATE', [rotation])
    hub.broadcastDbChange('match_live_state', 'UPSERT', [{ ...dbCopy(), updated_at: point.updated_at }]) // older: stale
    hub.broadcastDbChange('match_live_state', 'UPSERT', [{ ...rotation, id: 'r' }]) // same as rotation: duplicate
    assert.deepEqual(viewer.changes().map((m) => m.new.last_event_type), ['point', 'rotation'])
    assert.equal(hub.stats().staleDropped, 1)
    assert.equal(hub.stats().duplicateDropped, 1)
    hub.close()
  })

  it('keeps rows for the duplicate check of recent keys only, as subscribers see them', () => {
    const { hub, subscriber } = liveHub({ maxDuplicateRows: 2 })
    const viewer = subscriber([{ table: 'match_live_state', event: '*', column: 'sport_type', value: 'indoor' }])
    const keys = ['m1', 'm2', 'm3']
    for (const k of keys) hub.broadcastDbChange('match_live_state', 'UPDATE', [{ ...relayCopy(), match_id: k }])
    assert.equal(hub.stats().duplicateRows, 2)
    assert.equal(hub.stats().orderingKeys, 3)
    // m3 (recent) is deduplicated; m1 (evicted) goes out again (never stale)
    assert.equal(hub.broadcastDbChange('match_live_state', 'UPSERT', [{ ...dbCopy(), match_id: 'm3' }]), 0)
    assert.equal(hub.broadcastDbChange('match_live_state', 'UPSERT', [{ ...dbCopy(), match_id: 'm1' }]), 1)
    assert.equal(viewer.changes().length, 4)
    // A column live subscribers never see does not make a copy "news"
    const projected = liveHub({ project: (t, row) => { const { points_b, ...rest } = row; return rest } })
    const v2 = projected.subscriber([{ table: 'match_live_state', event: '*', column: 'sport_type', value: 'indoor' }])
    projected.hub.broadcastDbChange('match_live_state', 'UPDATE', [relayCopy()])
    projected.hub.broadcastDbChange('match_live_state', 'UPDATE', [{ ...relayCopy(), points_b: 99 }])
    assert.equal(v2.changes().length, 1)
    hub.close()
    projected.hub.close()
  })
})
