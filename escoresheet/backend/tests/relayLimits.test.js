/**
 * lib/relayLimits.js: the checks on what the relay keeps of a socket's
 * bundles and live states (server.js handleSyncMatchData,
 * handleLiveStateUpdate). The relay end to end: tests/relayLimits.relay.test.js.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  approxHeapBytes, frameTooLarge, relayBundleProblem, relayMemoryBudget,
  MAX_RELAY_EVENTS, MAX_RELAY_SETS, MAX_RELAY_PLAYERS, MAX_RELAY_PIN_LENGTH, MAX_FRAME_VALUES,
  RELAY_HEAP_SHARE, NEW_ROOM_SHARE, RELAY_ANON_SHARE, FAST_PROPERTIES
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

  it('a type-only field (matchPin) must be text or a number, but may be any length', () => {
    const TYPE_ONLY = ['matchPin']
    // the relay never compares matchPin, so a long one must not stop the sync
    assert.equal(relayBundleProblem(sync({ match: { matchPin: 'p'.repeat(MAX_RELAY_PIN_LENGTH + 100) } }), PIN_FIELDS, TYPE_ONLY), null)
    assert.equal(relayBundleProblem(sync({ match: { matchPin: 1234 } }), PIN_FIELDS, TYPE_ONLY), null)
    assert.equal(relayBundleProblem(sync({ match: { matchPin: null } }), PIN_FIELDS, TYPE_ONLY), null)
    // but a non-text, non-number one is still refused (it must never be String()d)
    for (const bad of [{ toString: 1 }, ['x'], true]) {
      const r = relayBundleProblem(sync({ match: { matchPin: bad } }), PIN_FIELDS, TYPE_ONLY)
      assert.deepEqual([r?.code, r?.field], ['bad-request', 'match.matchPin'], JSON.stringify(bad))
    }
    // without the type-only list, matchPin is not checked at all
    assert.equal(relayBundleProblem(sync({ match: { matchPin: 'x'.repeat(5000) } }), PIN_FIELDS), null)
  })

  it('refuses a status, scheduledAt or team name that is not text or a number (bad-request)', () => {
    // these feed the match list, landing page and PIN check: String() / new Date()
    // of an object there answered 500 (or sorted the whole list to an error)
    for (const bad of [{ toString: 1 }, {}, ['live'], Number.NaN]) {
      for (const field of ['status', 'scheduledAt', 'scheduled_at', 'homeTeamName', 'awayTeamName']) {
        const r = relayBundleProblem(sync({ match: { [field]: bad } }), PIN_FIELDS)
        assert.deepEqual([r?.code, r?.field], ['bad-request', `match.${field}`], `${field}: ${JSON.stringify(bad)}`)
      }
    }
    // a team name that is an object, however the bundle names the teams
    for (const team of ['homeTeam', 'awayTeam', 'team1Team', 'team2Team', 'team1', 'team2']) {
      assert.equal(relayBundleProblem(sync({ [team]: { name: { toString: 1 } } }), PIN_FIELDS)?.code, 'bad-request', team)
      assert.equal(relayBundleProblem(sync({ [team]: ['Home VC'] }), PIN_FIELDS)?.code, 'bad-request', `${team} array`)
    }
    // the legacy teams[] format
    assert.equal(relayBundleProblem(sync({ homeTeam: undefined, teams: [{ name: {} }, { name: 'A' }] }), PIN_FIELDS)?.code, 'bad-request')
    // what scorers actually send is kept: text status, ISO or numeric scheduledAt,
    // a missing one, a string team, a team object with a text name
    assert.equal(relayBundleProblem(sync({ match: { status: 'live', scheduledAt: '2026-10-06T18:00:00Z' } }), PIN_FIELDS), null)
    assert.equal(relayBundleProblem(sync({ match: { scheduledAt: 1760000000000, homeTeamName: 'Home VC' } }), PIN_FIELDS), null)
    assert.equal(relayBundleProblem(sync({ match: { status: undefined, scheduledAt: null } }), PIN_FIELDS), null)
    assert.equal(relayBundleProblem(sync({ homeTeam: 'Home VC', awayTeam: { name: 'Away VC', shortName: 'AVC' } }), PIN_FIELDS), null)
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

  it('counts an object with many keys (or integer-like keys) at its dictionary cost', () => {
    const n = 2000
    const obj = (K) => { const o = {}; for (let j = 0; j < K; j++) o[`f${j}`] = j; return o }
    // V8 keeps an object with many named keys as a hash table (measured ~1.6 KB
    // per 20-key object built one key at a time, where the fast layout is ~200 B)
    const small = approxHeapBytes(Array.from({ length: n }, () => obj(FAST_PROPERTIES)))
    const big = approxHeapBytes(Array.from({ length: n }, () => obj(FAST_PROPERTIES + 8)))
    assert.ok(big / n > 1200, `${big / n} per 24-key object`)
    assert.ok(big / n > 5 * (small / n), `dictionary ${big / n} vs fast ${small / n} per object`)
    // integer-like keys ("7", "1000") go to an element hash table of their own
    const indexed = approxHeapBytes(Array.from({ length: n }, () => ({ 7: 1, 1000: 2, 50000: 3 })))
    assert.ok(indexed / n > 3 * 88, `integer keys ${indexed / n} per object`)
    // but a key that is not a plain non-negative integer is a normal name,
    // counted like any other name (not in the element table): the lookalikes
    // "-1"/"007" cost exactly what names of the same length do
    assert.equal(approxHeapBytes({ '-1': 1, '007': 2, x: 3 }), approxHeapBytes({ aa: 1, bbb: 2, x: 3 }))
    assert.notEqual(approxHeapBytes({ 1: 1, 7: 2, 9: 3 }), approxHeapBytes({ a: 1, b: 2, c: 3 }))
  })

  it('counts a fresh key order as its own hidden class, a shared one once', () => {
    // An anonymous socket can give every event in a bundle a different key
    // order; V8 then makes a fresh hidden class (a map) for each, several
    // hundred bytes the shared-name cost does not capture. The estimate must
    // stay at or above what V8 really keeps (measured on Node 22/24, per object
    // at the MAX_RELAY_EVENTS cap): about 440 (8 keys), 760 (12), 2170 (16, the
    // object-rest strip path). Objects built in a FIXED order share one map.
    const n = 4096
    const names = (K) => Array.from({ length: K }, (_, i) => 'field' + i)
    const fixed = (K) => { const ns = names(K); return Array.from({ length: n }, () => { const o = {}; for (const k of ns) o[k] = 1; return o }) }
    // a different key order for every object (a seeded shuffle, as an anonymous
    // socket could emit): each is its own hidden class
    let seed = 1
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const varied = (K) => { const base = names(K); return Array.from({ length: n }, () => { const ns = base.slice(); for (let i = ns.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1));[ns[i], ns[j]] = [ns[j], ns[i]] } const o = {}; for (const k of ns) o[k] = 1; return o }) }
    for (const [K, perObject] of [[8, 440], [12, 760], [16, 2170]]) {
      const v = approxHeapBytes(varied(K))
      const f = approxHeapBytes(fixed(K))
      assert.ok(v > 3 * f, `K=${K}: varied ${(v / n).toFixed(0)}/obj vs fixed ${(f / n).toFixed(0)}/obj`)
      assert.ok(v / n >= perObject, `K=${K}: estimate ${(v / n).toFixed(0)}/obj must cover the measured ${perObject}/obj`)
    }
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
    // new rooms are shed below the total (headroom for the matches in play);
    // the rooms the database does not know as official hold a smaller share
    assert.equal(b.newRoomTotal, Math.floor(b.total * NEW_ROOM_SHARE))
    assert.equal(b.newRoomPerAddress, Math.floor(b.perAddress * NEW_ROOM_SHARE))
    assert.equal(b.anonTotal, Math.floor(b.total * RELAY_ANON_SHARE))
    assert.ok(b.anonTotal < b.newRoomTotal && b.newRoomTotal < b.total, 'anon < new-room < total')
    const six = relayMemoryBudget({ heapLimitBytes: heap, maxMb: '6' })
    assert.equal(six.total, 6 * 1024 * 1024)
    assert.equal(six.perAddress, 3 * 1024 * 1024)
    assert.equal(six.newRoomTotal, Math.floor(6 * 1024 * 1024 * NEW_ROOM_SHARE))
    assert.equal(six.anonTotal, Math.floor(6 * 1024 * 1024 * RELAY_ANON_SHARE))
    assert.deepEqual(relayMemoryBudget({ heapLimitBytes: heap, maxMb: ' ' }), b, 'empty: the default')
    for (const bad of ['0', '-5', 'abc', '1e999']) {
      assert.throws(() => relayMemoryBudget({ heapLimitBytes: heap, maxMb: bad }), /OV_RELAY_MAX_MB/, bad)
    }
  })
})
