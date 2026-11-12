/**
 * lib/relayLimits.js: the checks on what the relay keeps of a socket's
 * bundles and live states (server.js handleSyncMatchData,
 * handleLiveStateUpdate). The relay end to end: tests/relayLimits.relay.test.js.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  approxHeapBytes, frameTooLarge, relayBundleProblem, relayMemoryBudget,
  MAX_RELAY_EVENTS, MAX_RELAY_SETS, MAX_RELAY_PLAYERS, MAX_RELAY_PIN_LENGTH, MAX_FRAME_VALUES, RELAY_HEAP_SHARE
} from '../lib/relayLimits.js'

const PIN_FIELDS = ['refereePin', 'homeTeamPin', 'awayTeamPin', 'gamePin', 'game_pin', 'team1Pin', 'team2Pin']

describe('relayBundleProblem', () => {
  const sync = (extra = {}) => ({
    type: 'sync-match-data',
    matchId: 'm1',
    match: { seed_key: 'm1', status: 'live', gamePin: '987654', refereePin: '314159', homeTeamPin: null, awayTeamPin: '' },
    homeTeam: { name: 'Home VC' },
    awayTeam: 'Away VC',
    homePlayers: [{ number: 1 }],
    awayPlayers: [],
    sets: [{ index: 1, homePoints: 25, awayPoints: 20 }],
    events: [{ id: 1, type: 'point', payload: { team: 'home' } }],
    ...extra
  })

  it('takes what scorers send: text, numeric and missing PINs, beach lists, the legacy format', () => {
    assert.equal(relayBundleProblem(sync(), PIN_FIELDS), null)
    assert.equal(relayBundleProblem(sync({ match: { gamePin: 987654, refereePin: 314159 } }), PIN_FIELDS), null)
    assert.equal(relayBundleProblem(sync({ match: { status: 'live' } }), PIN_FIELDS), null, 'a later sync leaves the PINs out')
    assert.equal(relayBundleProblem(sync({ homePlayers: undefined, team1Players: [{ number: 1 }, { number: 2 }], team2Players: [] }), PIN_FIELDS), null)
    assert.equal(relayBundleProblem({ matchId: 'm1', match: { gamePin: '1' }, teams: [{ id: 1 }, { id: 2 }], players: [{ teamId: 1 }] }, PIN_FIELDS), null)
    assert.equal(relayBundleProblem(sync({ events: null, sets: null }), PIN_FIELDS), null)
    assert.equal(relayBundleProblem(sync({ events: new Array(MAX_RELAY_EVENTS).fill(null) }), PIN_FIELDS), null, 'up to the limit')
    // the PINs of a connection_pins object are not looked at (not in pinFields)
    assert.equal(relayBundleProblem(sync({ match: { connection_pins: { referee: '1' } } }), PIN_FIELDS), null)
    assert.equal(relayBundleProblem({}, PIN_FIELDS), null, 'the relay answers a sync without match itself')
  })

  it('refuses a PIN that is not text or a number, or too long: bad-request', () => {
    for (const bad of [{ toString: 1 }, ['314159'], true, '1'.repeat(MAX_RELAY_PIN_LENGTH + 1), Number.NaN]) {
      for (const field of ['refereePin', 'gamePin', 'game_pin', 'team1Pin']) {
        const match = { [field]: bad }
        const r = relayBundleProblem(sync({ match }), PIN_FIELDS)
        assert.equal(r?.code, 'bad-request', `${field}: ${JSON.stringify(bad)}`)
        assert.equal(r.field, `match.${field}`)
        assert.match(r.message, /Invalid match data/)
      }
    }
  })

  it('refuses lists that are no array (bad-request) or longer than any match has (too-large)', () => {
    const cases = [
      ['events', MAX_RELAY_EVENTS], ['sets', MAX_RELAY_SETS], ['players', MAX_RELAY_PLAYERS],
      ['homePlayers', MAX_RELAY_PLAYERS], ['awayPlayers', MAX_RELAY_PLAYERS], ['team1Players', MAX_RELAY_PLAYERS], ['team2Players', MAX_RELAY_PLAYERS]
    ]
    for (const [field, max] of cases) {
      const long = relayBundleProblem(sync({ [field]: new Array(max + 1).fill(0) }), PIN_FIELDS)
      assert.deepEqual([long?.code, long?.field], ['too-large', field])
      assert.match(long.message, /too large/)
      assert.equal(relayBundleProblem(sync({ [field]: { length: 1, 0: {} } }), PIN_FIELDS)?.code, 'bad-request', field)
      assert.equal(relayBundleProblem(sync({ [field]: 'x' }), PIN_FIELDS)?.code, 'bad-request', field)
    }
  })
})

describe('approxHeapBytes', () => {
  it('counts at least what V8 keeps of the most compact shapes', () => {
    const n = 1000
    // measured with Node 22 / 24 (per item, including its array slot)
    const measured = [
      [() => ({}), 64], [() => [], 40], [() => [0], 64], [() => [{}], 120], [() => ({ a: {} }), 96],
      [() => [[0]], 120], [() => ({ a: 1 }), 40], [() => 1.5, 8], [() => true, 8]
    ]
    for (const [make, perItem] of measured) {
      const bytes = approxHeapBytes(Array.from({ length: n }, make))
      assert.ok(bytes >= perItem * n, `${JSON.stringify(make())}: ${bytes / n} per item, V8 ${perItem}`)
    }
    // a new key costs more than one that repeats (V8 shares the hidden class)
    const sameKeys = approxHeapBytes(Array.from({ length: n }, () => ({ setIndex: 1 })))
    const newKeys = approxHeapBytes(Array.from({ length: n }, (_, i) => ({ [`k${i}`]: 1 })))
    assert.ok(newKeys > sameKeys + 100 * n, `${newKeys} vs ${sameKeys}`)
    // past the names it remembers, every name counts as new
    const many = Array.from({ length: 10000 }, (_, i) => ({ [`k${i}`]: 1 }))
    assert.ok(approxHeapBytes([many, many]) >= 2 * approxHeapBytes(many) - 4096 * 200)
  })

  it('counts strings by their characters: one byte each when all are ASCII, else two', () => {
    const ascii = 'a'.repeat(100000)
    const twoByte = '€' + 'a'.repeat(99999)
    assert.ok(approxHeapBytes(ascii) >= 100000 && approxHeapBytes(ascii) < 100100)
    assert.ok(approxHeapBytes(twoByte) >= 200000)
    assert.ok(approxHeapBytes('é'.repeat(1000)) >= 2000, 'Latin-1 that is not ASCII: two')
    assert.equal(approxHeapBytes(null), 8)
    assert.equal(approxHeapBytes(undefined), 8)
  })

  it('a long five-set bundle with 14 signatures costs about its JSON size', () => {
    const signature = 'data:image/png;base64,' + Buffer.alloc(30000, 3).toString('base64')
    const events = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, matchId: 1, seq: i + 1, setIndex: 1 + (i % 5), type: 'point', payload: { team: i % 2 ? 'home' : 'away' }, ts: '2026-10-06T18:00:00.000Z' }))
    const match = { seed_key: 'm', status: 'live' }
    for (let i = 0; i < 14; i++) match[`signature${i}`] = signature
    const bundle = [match, { name: 'Home VC' }, { name: 'Away VC' }, [], [], [], events]
    const json = JSON.stringify(bundle).length
    const bytes = approxHeapBytes(bundle)
    assert.ok(bytes > json && bytes < 2 * json, `${bytes} for ${json} bytes of JSON`)
  })
})

describe('frameTooLarge', () => {
  it('counts the values of a frame before it is parsed', () => {
    // n values: an array and n - 1 numbers in it
    const values = (n) => '[' + new Array(n - 1).fill('0').join(',') + ']'
    assert.equal(frameTooLarge(Buffer.from(values(MAX_FRAME_VALUES))), false)
    assert.equal(frameTooLarge(Buffer.from(values(MAX_FRAME_VALUES + 1))), true)
    assert.equal(frameTooLarge(values(MAX_FRAME_VALUES + 1)), true, 'a string frame too')
    assert.equal(frameTooLarge(Buffer.from('[' + new Array(MAX_FRAME_VALUES).fill('{}').join(',') + ']')), true, 'objects count as values')
    // a big frame with few values (signatures, long text): not refused
    assert.equal(frameTooLarge(Buffer.from(JSON.stringify({ match: { s: 'a'.repeat(9 * 1024 * 1024) } }))), false)
    assert.equal(frameTooLarge(Buffer.from('{"type":"ping"}')), false)
    assert.equal(frameTooLarge(null), false)
  })
})

describe('relayMemoryBudget', () => {
  it('a share of the heap limit, half of it per address; OV_RELAY_MAX_MB sets the total', () => {
    const heap = 304 * 1024 * 1024 // --max-old-space-size=256 on Node 22
    const b = relayMemoryBudget({ heapLimitBytes: heap })
    assert.equal(b.total, Math.floor(heap * RELAY_HEAP_SHARE))
    assert.equal(b.perAddress, Math.floor(b.total / 2))
    assert.ok(b.total > 100 * 1024 * 1024 && b.total < 110 * 1024 * 1024)
    assert.deepEqual(relayMemoryBudget({ heapLimitBytes: heap, maxMb: '6' }), { total: 6 * 1024 * 1024, perAddress: 3 * 1024 * 1024 })
    assert.deepEqual(relayMemoryBudget({ heapLimitBytes: heap, maxMb: ' ' }), b, 'empty: the default')
    for (const bad of ['0', '-5', 'abc', '1e999']) {
      assert.throws(() => relayMemoryBudget({ heapLimitBytes: heap, maxMb: bad }), /OV_RELAY_MAX_MB/, bad)
    }
  })
})
