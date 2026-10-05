/**
 * PINs at rest (lib/pinHash.js), match access tokens and PIN grants
 * (lib/matchAccess.js), and the public summary of a relayed match
 * (lib/publicColumns.js relaySummaryBundle / projectAnonDbRows).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createPinHasher, isHashedPin, pinHasherFromEnv } from '../lib/pinHash.js'
import { createMatchTokens, pinGrantsAccess } from '../lib/matchAccess.js'
import { relaySummaryBundle, projectAnonDbRows, hasAnonPolicy, anonSelectCheck } from '../lib/publicColumns.js'

const SECRET = 'x'.repeat(40)

describe('pinHash', () => {
  it('stores PINs as an HMAC with the secret, per kind; compares hashed and legacy plaintext', () => {
    const h = createPinHasher(SECRET)
    assert.equal(h.enabled, true)
    const stored = h.hash('referee', '314159')
    assert.ok(isHashedPin(stored), stored)
    assert.equal(stored.includes('314159'), false)
    assert.notEqual(h.hash('bench_home', '314159'), stored, 'kind is part of the hash')
    assert.notEqual(createPinHasher('y'.repeat(40)).hash('referee', '314159'), stored, 'secret is part of the hash')
    assert.equal(h.hash('referee', stored), stored, 'never hashed twice')
    assert.equal(h.matches('referee', '314159', stored), true)
    assert.equal(h.matches('referee', ' 314159 ', stored), true)
    assert.equal(h.matches('referee', '314158', stored), false)
    assert.equal(h.matches('bench_home', '314159', stored), false)
    assert.equal(h.matches('referee', '314159', '314159'), true, 'legacy plaintext still accepted')
    assert.equal(h.matches('referee', '', stored), false)
    assert.equal(h.matches('referee', '314159', null), false)
    assert.deepEqual(h.candidates('game', '864201'), ['864201', h.hash('game', '864201')])
  })

  it('hashMatchRow hashes game_pin and every connection_pins value, nothing else', () => {
    const h = createPinHasher(SECRET)
    const row = { external_id: 'm', game_pin: '864201', connection_pins: { referee: '531642', upload_home: 975310 }, status: 'live' }
    const out = h.hashMatchRow(row)
    assert.notEqual(out, row)
    assert.equal(row.game_pin, '864201', 'input not mutated')
    assert.equal(out.status, 'live')
    assert.equal(h.matches('game', '864201', out.game_pin), true)
    assert.equal(h.matches('referee', '531642', out.connection_pins.referee), true)
    assert.equal(h.matches('upload_home', '975310', out.connection_pins.upload_home), true)
    assert.equal(JSON.stringify(out).match(/864201|531642|975310/), null)
    const noPins = { status: 'x' }
    assert.equal(h.hashMatchRow(noPins), noPins)
  })

  it('without a secret nothing is hashed (LAN, before OV_PIN_SECRET is set)', () => {
    const h = createPinHasher(null)
    assert.equal(h.enabled, false)
    assert.equal(h.hash('game', '864201'), '864201')
    const row = { game_pin: '864201' }
    assert.equal(h.hashMatchRow(row), row)
    assert.deepEqual(h.candidates('game', '864201'), ['864201'])
    assert.equal(h.matches('referee', '314159', createPinHasher(SECRET).hash('referee', '314159')), false)
    assert.equal(pinHasherFromEnv({}).enabled, false)
    assert.equal(pinHasherFromEnv({ OV_PIN_SECRET: SECRET }).enabled, true)
    assert.throws(() => pinHasherFromEnv({ OV_PIN_SECRET: 'short' }), /at least 32/)
  })
})

describe('match access tokens', () => {
  it('grant one match, until they expire, and only with the signing secret', () => {
    let t = 1_000_000
    const tokens = createMatchTokens({ secret: SECRET, ttlMs: 1000, now: () => t })
    const tok = tokens.issue({ matchKey: 'match_1', role: 'referee', matchUuid: 'u-1' })
    assert.match(tok, /^v1\./)
    assert.deepEqual(tokens.verify(tok), { m: 'match_1', r: 'referee', exp: 1_001_000, u: 'u-1' })
    assert.equal(tokens.grants(tok, 'match_1'), true)
    assert.equal(tokens.grants(tok, 'match_2'), false)
    // forged / tampered / foreign
    const [v, body, sig] = tok.split('.')
    const forged = Buffer.from(JSON.stringify({ m: 'match_2', r: 'referee', exp: 9e15 })).toString('base64url')
    assert.equal(tokens.verify(`${v}.${forged}.${sig}`), null)
    assert.equal(tokens.verify(`${v}.${body}.${'A'.repeat(43)}`), null)
    assert.equal(createMatchTokens({ secret: 'z'.repeat(40) }).verify(tok), null)
    for (const junk of [null, 1, '', 'v1.', 'v2.a.b', tok + 'x']) assert.equal(tokens.verify(junk), null)
    t += 1001
    assert.equal(tokens.verify(tok), null, 'expired')
    assert.equal(tokens.issue({ matchKey: '' }), null)
  })

  it('a random secret per process when none (or a short one) is configured', () => {
    const a = createMatchTokens()
    const b = createMatchTokens({ secret: 'short' })
    const tok = a.issue({ matchKey: 'm' })
    assert.equal(a.grants(tok, 'm'), true)
    assert.equal(b.grants(tok, 'm'), false)
  })
})

describe('pinGrantsAccess (relay)', () => {
  const match = {
    refereePin: '314159', homeTeamPin: '271828', awayTeamPin: '161803', gamePin: '987654',
    homeTeamUploadPin: '141421',
    refereeConnectionEnabled: true, homeTeamConnectionEnabled: true, awayTeamConnectionEnabled: false
  }
  it('the referee PIN, an enabled bench PIN or the game PIN; never an upload PIN', () => {
    assert.equal(pinGrantsAccess(match, '314159'), true)
    assert.equal(pinGrantsAccess(match, ' 271828 '), true)
    assert.equal(pinGrantsAccess(match, '987654'), true)
    assert.equal(pinGrantsAccess(match, '161803'), false, 'away bench connection is off')
    assert.equal(pinGrantsAccess(match, '141421'), false)
    assert.equal(pinGrantsAccess(match, '000000'), false)
    assert.equal(pinGrantsAccess({ ...match, refereeConnectionEnabled: false }, '314159'), false)
    assert.equal(pinGrantsAccess({ game_pin: '555555' }, '555555'), true)
    assert.equal(pinGrantsAccess({}, ''), false)
    assert.equal(pinGrantsAccess({ status: 'live' }, '000000'), false, 'a match without PINs grants nothing')
    assert.equal(pinGrantsAccess(null, '314159'), false)
  })
})

describe('public summary before the PIN step', () => {
  it('relaySummaryBundle keeps teams, status, set scores and the live state only', () => {
    const entry = {
      match: { id: 7, status: 'live', gameNumber: 12, seed_key: 'match_1', refereePin: '314159', officials: [{ dob: '1980-01-01' }], players_home: [{ number: 1 }], bench_home: [{ role: 'Coach' }], coinTossTeamA: 'home' },
      homeTeam: { name: 'Home', color: '#f00', players: [1], id: 3 },
      awayTeam: 'Away',
      homePlayers: [{ number: 7, lastName: 'P' }],
      awayPlayers: [{ number: 9 }],
      sets: [{ id: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true, lineup: [1, 2] }],
      events: [{ id: 1, payload: { player: 7 } }],
      liveState: { points_a: 3 }
    }
    const s = relaySummaryBundle(entry)
    assert.deepEqual(s, {
      access: 'summary',
      match: { id: 7, status: 'live', gameNumber: 12, seed_key: 'match_1', coinTossTeamA: 'home' },
      homeTeam: { name: 'Home', color: '#f00' },
      awayTeam: 'Away',
      homePlayers: [],
      awayPlayers: [],
      sets: [{ id: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true }],
      events: [],
      liveState: { points_a: 3 }
    })
    assert.equal(relaySummaryBundle({ match: {} }).liveState, undefined)
  })

  it('anonymous /api/db: rosters only for the match the token names; events without payloads', () => {
    const rows = [
      { id: 'a', external_id: 'match_a', status: 'live', players_home: [{ number: 1, last_name: 'A', dob: '2001-01-01' }], bench_away: [{ role: 'Coach' }] },
      { id: 'b', external_id: 'match_b', status: 'live', players_home: [{ number: 2 }] }
    ]
    const none = projectAnonDbRows('matches', rows)
    assert.equal('players_home' in none[0], false)
    assert.equal('bench_away' in none[0], false)
    assert.equal(none[0].status, 'live')
    const granted = projectAnonDbRows('matches', rows, { grantedExternalId: 'match_a' })
    assert.deepEqual(granted[0].players_home, [{ number: 1, last_name: 'A' }])
    assert.equal('players_home' in granted[1], false)
    assert.equal(projectAnonDbRows('matches', rows[0], { grantedExternalId: 'match_a' }).players_home.length, 1)
    assert.equal(rows[0].players_home[0].dob, '2001-01-01', 'input not mutated')

    assert.equal(hasAnonPolicy('events'), true)
    const ev = projectAnonDbRows('events', [{ id: 1, match_id: 'a', type: 'sanction', payload: { player: 7 }, state_snapshot: {} }])
    assert.deepEqual(ev, [{ id: 1, match_id: 'a', type: 'sanction' }])
    assert.equal(anonSelectCheck('events', { columns: '*', filters: [{ type: 'eq', column: 'match_id', value: 'a' }] }).badFilter, null)
    assert.equal(anonSelectCheck('events', { columns: 'id', filters: [{ type: 'contains', column: 'payload', value: '{}' }] }).badFilter, 'payload')
  })
})
