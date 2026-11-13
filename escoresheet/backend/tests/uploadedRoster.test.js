/**
 * lib/uploadedRoster.js: the rules of an uploaded roster, the signatures an
 * upload may fill in, and the pending rosters a started match drops. The
 * server's checkUploadedRoster is a copy of the scorer app's
 * (frontend/src/domain/uploadedRoster.js): both must answer alike, and the
 * app's copies of the signature pattern and the bench roles must be the
 * server's (lib/teams.js, lib/savedTeams.js). Made-up names.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as server from '../lib/uploadedRoster.js'
import * as app from '../../frontend/src/domain/uploadedRoster.js'
import { SIGNATURE_RE } from '../lib/teams.js'
import { STAFF_ROLES } from '../lib/savedTeams.js'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const player = (number, extra = {}) => ({ number, firstName: 'Anna', lastName: `Muster${number}`, dob: '14/03/2008', libero: '', isCaptain: false, ...extra })
const good = () => ({
  players: [player(1, { isCaptain: true }), player(2, { libero: 'libero1' }), player(3, { libero: 'libero2' }), player(4, { isLfp: true })],
  bench: [{ role: 'Coach', firstName: 'Hans', lastName: 'Beispiel', dob: '' }, { role: 'Assistant Coach 1', firstName: 'Eva', lastName: 'Exemple', dob: '' }],
  coachSignature: PNG,
  captainSignature: null,
  timestamp: '2026-11-12T18:30:00.000Z'
})

// Rosters the rules refuse, each with the problem it must name
const REFUSED = [
  ['not an object', 'x', 'roster', 'notObject'],
  ['players not a list', { players: 'x' }, 'players', 'notList'],
  ['too many players', { players: Array.from({ length: 31 }, (_, i) => player((i % 99) + 1)) }, 'players', 'tooMany'],
  ['a player that is no object', { players: ['x'] }, 'players[0]', 'notObject'],
  ['an object as a number', { players: [player({})] }, 'players[0].number', 'badNumber'],
  ['an object as a name', { players: [player(5, { lastName: {} })] }, 'players[0].lastName', 'badText'],
  ['a name too long', { players: [player(5, { firstName: 'A'.repeat(81) })] }, 'players[0].firstName', 'badText'],
  ['number "constructor"', { players: [player('constructor')] }, 'players[0].number', 'badNumber'],
  ['number 0', { players: [player(0)] }, 'players[0].number', 'badNumber'],
  ['number 100', { players: [player(100)] }, 'players[0].number', 'badNumber'],
  ['number 7.5', { players: [player(7.5)] }, 'players[0].number', 'badNumber'],
  ['7 and "7"', { players: [player(7), player('7')] }, 'players[1].number', 'numberTwice'],
  ['two captains', { players: [player(1, { isCaptain: true }), player(2, { isCaptain: true })] }, 'players[1].isCaptain', 'captainTwice'],
  ['"Libero 1" twice', { players: [player(1, { libero: 'libero1' }), player(2, { libero: 'libero1' })] }, 'players[1].libero', 'liberoSlotTwice'],
  ['a third libero slot', { players: [player(1, { libero: 'libero3' })] }, 'players[0].libero', 'badLibero'],
  ['captain as text', { players: [player(1, { isCaptain: 'yes' })] }, 'players[0].isCaptain', 'badFlag'],
  ['a date that is no date', { players: [player(1, { dob: '<b>' })] }, 'players[0].dob', 'badDate'],
  ['bench role "constructor"', { bench: [{ role: 'constructor', lastName: 'Muster' }] }, 'bench[0].role', 'badRole'],
  ['bench role "hasOwnProperty"', { bench: [{ role: 'hasOwnProperty' }] }, 'bench[0].role', 'badRole'],
  ['two coaches', { bench: [{ role: 'Coach' }, { role: 'Coach' }] }, 'bench[1].role', 'roleTwice'],
  ['a link as a signature', { coachSignature: 'https://tracker.example/s.png' }, 'coachSignature', 'badSignature'],
  ['text as a signature', { captainSignature: 'x' }, 'captainSignature', 'badSignature'],
  ['another image type', { coachSignature: 'data:image/svg+xml;base64,PHN2Zz4=' }, 'coachSignature', 'badSignature'],
  ['a huge signature', { coachSignature: `data:image/png;base64,${'A'.repeat(1000001)}` }, 'coachSignature', 'badSignature'],
  ['a timestamp that is no time', { timestamp: { at: 1 } }, 'timestamp', 'badTimestamp']
]

describe('checkUploadedRoster', () => {
  it('keeps a good roster in the stored shape, without other keys', () => {
    const r = server.checkUploadedRoster({ ...good(), extra: 'dropped', players: [...good().players, { ...player(9), note: 'dropped', number: '09' }] })
    assert.equal(r.ok, true)
    assert.deepEqual(Object.keys(r.roster), ['players', 'bench', 'coachSignature', 'captainSignature', 'timestamp'])
    assert.deepEqual(r.roster.players.at(-1), { number: 9, firstName: 'Anna', lastName: 'Muster9', dob: '14/03/2008', libero: '', isCaptain: false, isLfp: false })
    assert.equal(r.roster.players[3].isLfp, true)
    assert.equal(r.roster.coachSignature, PNG)
    assert.equal(r.roster.captainSignature, null)
  })

  it('takes a player without number, name or date (filled in by the scorer)', () => {
    const r = server.checkUploadedRoster({ players: [{ number: 3 }, { number: null, lastName: ' Muster ' }], bench: [] })
    assert.equal(r.ok, true)
    assert.deepEqual(r.roster.players.map((p) => [p.number, p.lastName, p.dob]), [[3, '', ''], [null, 'Muster', '']])
  })

  for (const [what, roster, path, code] of REFUSED) {
    it(`refuses ${what}`, () => {
      const r = server.checkUploadedRoster(roster)
      assert.equal(r.ok, false)
      assert.deepEqual(r.problems[0], { path, code })
    })
  }

  it('the scorer app answers alike (frontend/src/domain/uploadedRoster.js)', () => {
    for (const [, roster] of [['good', good()], ...REFUSED]) {
      assert.deepEqual(app.checkUploadedRoster(roster), server.checkUploadedRoster(roster))
    }
    assert.equal(app.SIGNATURE_RE.source, SIGNATURE_RE.source)
    assert.deepEqual([...app.BENCH_ROLES], [...STAFF_ROLES])
    for (const k of ['UPLOADED_ROSTER_MAX_PLAYERS', 'UPLOADED_NAME_MAX', 'UPLOADED_SIGNATURE_MAX_LENGTH']) assert.equal(app[k], server[k], k)
  })

  it('the rules are the same code in both files', () => {
    const rules = (file) => {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8')
      return text.slice(text.indexOf('// ---- the rules'), text.indexOf('// ---- end of the rules')).split('\n').slice(1).join('\n')
    }
    assert.equal(rules('../lib/uploadedRoster.js'), rules('../../frontend/src/domain/uploadedRoster.js'))
  })
})

describe('signaturesAfterUpload', () => {
  it('fills empty keys only, the other team and stored ones stay', () => {
    const stored = { home_coach: 'data:image/png;base64,SCORER', home_captain: '', away_coach: 'data:image/png;base64,AWAY' }
    assert.deepEqual(server.signaturesAfterUpload(stored, 'home', { coachSignature: PNG, captainSignature: PNG }),
      { home_coach: 'data:image/png;base64,SCORER', home_captain: PNG, away_coach: 'data:image/png;base64,AWAY' })
    assert.equal(server.signaturesAfterUpload(stored, 'away', { coachSignature: PNG, captainSignature: null }), null)
    assert.deepEqual(server.signaturesAfterUpload(null, 'away', { coachSignature: null, captainSignature: PNG }), { away_captain: PNG })
    assert.equal(server.signaturesAfterUpload({}, 'home', { coachSignature: null, captainSignature: null }), null)
  })
})

describe('withPendingRostersCleared', () => {
  it('a status that leaves setup drops both pending rosters, the other connection keys as sent', () => {
    assert.deepEqual(server.withPendingRostersCleared({ id: 'm', status: 'live', connections: { referee_enabled: true } }),
      { id: 'm', status: 'live', connections: { referee_enabled: true, pending_home_roster: null, pending_away_roster: null } })
    assert.deepEqual(server.withPendingRostersCleared({ status: 'ended' }).connections, { pending_home_roster: null, pending_away_roster: null })
  })
  it('anything else is left as it is', () => {
    for (const data of [{ status: 'setup', connections: {} }, { current_set: 2 }, null, [{ status: 'live' }], { status: 'live', connections: 'x' }]) {
      assert.deepEqual(server.withPendingRostersCleared(data), data)
    }
  })
})
