/**
 * lib/relayLimits.js: the checks on what the relay keeps of a socket's
 * bundles and live states (server.js handleSyncMatchData,
 * handleLiveStateUpdate). The relay end to end: tests/relayLimits.relay.test.js.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  approxHeapBytes, createFrameBudget, frameTooLarge, relayBundleProblem, relayMemoryBudget,
  MAX_RELAY_EVENTS, MAX_RELAY_SETS, MAX_RELAY_PLAYERS, MAX_RELAY_PIN_LENGTH, MAX_FRAME_VALUES, MAX_RELAY_BUNDLE_BYTES,
  MAX_RELAY_CARRIED_PIN_BYTES, RELAY_HEAP_SHARE, NEW_ROOM_SHARE, RELAY_ANON_SHARE, FAST_PROPERTIES
} from '../lib/relayLimits.js'

const HEAP_SHAPES = fileURLToPath(new URL('./helpers/heapShapes.js', import.meta.url))
const PIN_FIELDS = ['refereePin', 'homeTeamPin', 'awayTeamPin', 'gamePin', 'game_pin', 'team1Pin', 'team2Pin']
// server.js MATCH_PIN_TYPE_ONLY_FIELDS / MATCH_CARRIED_PIN_FIELDS
const TYPE_ONLY = ['matchPin']
const CARRIED = ['connection_pins', 'connectionPins', 'matchPin']

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

  it('a type-only field (matchPin) must be text or a number, and may be longer than a PIN', () => {
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

  it('a PIN field the relay only carries over (connection_pins, matchPin) is at most MAX_RELAY_CARRIED_PIN_BYTES as kept: too-large', () => {
    // A sync that leaves these out keeps the stored ones (server.js
    // carryMatchSecrets), so a room's holder could park megabytes in them.
    // What apps send is far below: the five connection PINs (plain, or hashed
    // as the database keeps them), a device PIN someone typed.
    const hashed = 'h1:' + 'A'.repeat(43)
    const real = { referee: hashed, bench_home: hashed, bench_away: hashed, upload_home: hashed, upload_away: hashed }
    assert.equal(relayBundleProblem(sync({ match: { connection_pins: real, connectionPins: { referee: '314159' }, matchPin: 'p'.repeat(1000) } }), PIN_FIELDS, TYPE_ONLY, CARRIED), null)
    assert.equal(relayBundleProblem(sync({ match: { connection_pins: null, matchPin: 4711 } }), PIN_FIELDS, TYPE_ONLY, CARRIED), null)
    const over = [
      ['connection_pins', { referee: 'c'.repeat(MAX_RELAY_CARRIED_PIN_BYTES) }],
      // counted as the relay keeps it, not by its JSON (6 KB here)
      ['connectionPins', Array.from({ length: 2000 }, () => ({}))],
      ['matchPin', 'm'.repeat(MAX_RELAY_CARRIED_PIN_BYTES)]
    ]
    for (const [field, value] of over) {
      const r = relayBundleProblem(sync({ match: { [field]: value } }), PIN_FIELDS, TYPE_ONLY, CARRIED)
      assert.deepEqual([r?.code, r?.field], ['too-large', `match.${field}`], field)
      assert.match(r.message, /too large/)
    }
    // a matchPin of the wrong type is still a bad request first
    assert.equal(relayBundleProblem(sync({ match: { matchPin: { x: 'm'.repeat(MAX_RELAY_CARRIED_PIN_BYTES) } } }), PIN_FIELDS, TYPE_ONLY, CARRIED)?.code, 'bad-request')
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

  it('counts every number at its boxed size, a small integer too', () => {
    // V8 keeps a small integer unboxed only while its field holds integers:
    // once one object with the same keys had a decimal there, every object of
    // that key order holds a 16-byte box for it (measured: 16 keys, a decimal
    // first, then small integers took 2.2x the old estimate)
    assert.equal(approxHeapBytes({ a: 1, b: 2 }), approxHeapBytes({ a: 1.5, b: 2.5 }))
    assert.equal(approxHeapBytes([1, 2, 3]), approxHeapBytes([1.5, 2.5, -0]))
    const n = 10000
    const events = Array.from({ length: n }, (_, i) => ({ seq: i === 0 ? 0.5 : i, setIndex: 1, id: i }))
    // per event: its slot, the object, and three boxed numbers in their slots
    assert.ok(approxHeapBytes(events) / n >= 8 + 56 + 3 * (8 + 16), `${approxHeapBytes(events) / n} per event`)
  })

  it('counts an object with many keys (or integer-like keys) at its dictionary cost', () => {
    const n = 2000
    const obj = (K) => { const o = {}; for (let j = 0; j < K; j++) o[`f${j}`] = j; return o }
    // V8 keeps an object with many named keys as a hash table (measured ~1.6 KB
    // per 20-key object built one key at a time, where the fast layout is ~200 B)
    const small = approxHeapBytes(Array.from({ length: n }, () => obj(FAST_PROPERTIES)))
    const big = approxHeapBytes(Array.from({ length: n }, () => obj(FAST_PROPERTIES + 8)))
    assert.ok(big / n > 1600, `${big / n} per 24-key object`)
    assert.ok(big / n > 4 * (small / n), `dictionary ${big / n} vs fast ${small / n} per object`)
    // integer-like keys ("7", "1000") go to an element hash table of their own
    const indexed = approxHeapBytes(Array.from({ length: n }, () => ({ 7: 1, 1000: 2, 50000: 3 })))
    assert.ok(indexed / n > 3 * 88, `integer keys ${indexed / n} per object`)
    // but a key that is not a plain non-negative integer is a normal name,
    // counted like any other name (not in the element table): the lookalikes
    // "-1"/"007" cost exactly what names of the same length do
    assert.equal(approxHeapBytes({ '-1': 1, '007': 2, x: 3 }), approxHeapBytes({ aa: 1, bbb: 2, x: 3 }))
    assert.notEqual(approxHeapBytes({ 1: 1, 7: 2, 9: 3 }), approxHeapBytes({ a: 1, b: 2, c: 3 }))
  })

  it('counts a fresh key order as its own hidden class, a shared one a bounded number of times', () => {
    // An anonymous socket can give every event in a bundle a different key
    // order; V8 then makes a fresh hidden class (a map) for each, several
    // hundred bytes the shared-name cost does not capture. The estimate must
    // stay at or above what V8 really keeps (measured on Node 22/24, per object
    // at the MAX_RELAY_EVENTS cap): about 440 (8 keys), 760 (12), 2170 (16, the
    // object-rest strip path). Objects built in a FIXED order share one map,
    // which V8 may rebuild a few times (a field that widens): only the first
    // objects of an order count a chain each.
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
      // the chains of one order stop counting after a bounded number of objects
      const one = fixed(K)[0]
      const more = (m) => approxHeapBytes(Array.from({ length: m }, () => one))
      assert.equal(more(n + 100) - more(n), more(200) - more(100), `K=${K}: no chain past the first objects`)
    }
    // JSON.parse keeps objects of up to 127 keys in the compact layout, each order
    // with its own hidden class: past FAST_PROPERTIES the order still costs, on
    // top of the hash-table charge (measured 1.06-1.33x that charge alone)
    for (const K of [24, 64, 127]) {
      const v = approxHeapBytes(varied(K))
      const f = approxHeapBytes(fixed(K))
      assert.ok(v > 1.5 * f, `K=${K}: varied ${(v / n).toFixed(0)}/obj vs fixed ${(f / n).toFixed(0)}/obj`)
    }
  })

  it('counts two different key lists as two shapes, whatever characters the names hold', () => {
    // Names that hold the separator character must not make different ordered
    // key lists look alike: every one is its own hidden class in V8. Each
    // object here uses names of different run lengths of 'a' joined by U+0000,
    // in an order of its own, all from the same small pool of names.
    const name = (r) => Array(r).fill('a').join('\u0000')
    const lists = []
    const walk = (left, used, cur) => {
      if (lists.length >= 2000) return
      if (left === 0) { lists.push(cur.slice()); return }
      for (let p = 1; p <= left; p++) {
        if (used.has(p)) continue
        used.add(p); cur.push(p)
        walk(left - p, used, cur)
        cur.pop(); used.delete(p)
      }
    }
    walk(20, new Set(), [])
    const build = (list) => { const o = {}; for (const r of list) o[name(r)] = 0; return o }
    const distinct = approxHeapBytes(lists.map(build))
    // the same objects, all with the first list: one hidden class shared
    const shared = approxHeapBytes(lists.map(() => build(lists[0])))
    assert.ok(lists.length >= 1000, `${lists.length} lists`)
    assert.ok(distinct > shared + 400 * lists.length, `${(distinct / lists.length).toFixed(0)}/obj vs ${(shared / lists.length).toFixed(0)}/obj shared`)
    // and two lists that join to the same text are still two shapes: once one
    // order has counted all its chains, the other still counts one of its own
    const x = { 'a\u0000b': 0, c: 0 }
    const y = { a: 0, 'b\u0000c': 0 }
    const base = Array.from({ length: 100 }, () => x)
    const withY = approxHeapBytes([...base, y]) - approxHeapBytes(base)
    const withX = approxHeapBytes([...base, x]) - approxHeapBytes(base)
    assert.ok(withY > withX + 300, `${withY} vs ${withX}`)
  })

  it('stays at or above the heap a stored bundle really keeps (measured along the relay path, --expose-gc)', async () => {
    // tests/helpers/heapShapes.js takes each case in a fresh process along the
    // relay's own path (parse, depth and bundle checks, relayEvents, the
    // estimate) and compares the heap that stays after a full GC with
    // approxHeapBytes. Every budget gate and the per-room cap read this
    // estimate, so it must stay at or above real heap for any layout a socket
    // can choose: fresh key orders, a decimal planted first in a fixed order
    // (every later small integer boxed), fields that widen one by one (V8
    // rebuilds the hidden classes and keeps the old ones), copies made by
    // relayEvents, many small objects, long arrays, short and long strings.
    const cases = [
      'varied-8', 'varied-16', 'varied-64', 'varied-127', 'fixed-16', 'fixed-200',
      'dblfirst-4', 'dblfirst-8', 'dblfirst-16', 'reprmix-16', 'reprfull-16', 'prefixdep-16',
      'strip-16', 'stripdbl-16', 'inmatch-dblfirst-16', 'inmatch-reprmix-16', 'inmatch-prefixdep-16',
      'separator', 'tiny', 'arrays', 'numbers', 'mixed', 'shortstr', 'longstr', 'indexkeys', 'scorer'
    ]
    const run = (c) => new Promise((resolve) => {
      execFile(process.execPath, ['--expose-gc', HEAP_SHAPES, c], { encoding: 'utf8', maxBuffer: 1 << 20 }, (err, stdout, stderr) => resolve({ c, err, stdout, stderr }))
    })
    const results = []
    // four processes at a time (each measures its own heap only)
    for (let i = 0; i < cases.length; i += 4) {
      for (const { c, err, stdout, stderr } of await Promise.all(cases.slice(i, i + 4).map(run))) {
        assert.equal(err, null, `${c}: ${stderr}`)
        results.push([c, JSON.parse(stdout)])
      }
    }
    const MB = (b) => (b / 1048576).toFixed(2)
    const under = results.filter(([, r]) => r.real > r.est).map(([c, r]) => `${c}: real ${MB(r.real)} MB > estimate ${MB(r.est)} MB (${r.events} events)`)
    assert.deepEqual(under, [])
    // the layouts that kept far more than the estimate before (it counted 3.2 and
    // 8.0 MB for these) are within it now, and the bound still lets a real match through
    const of = Object.fromEntries(results)
    assert.ok(of['dblfirst-16'].real > 6 * 1048576, `decimal first: ${MB(of['dblfirst-16'].real)} MB real`)
    assert.ok(of['inmatch-reprmix-16'].real > 15 * 1048576, `rebuilt hidden classes: ${MB(of['inmatch-reprmix-16'].real)} MB real`)
    const scorer = of.scorer
    assert.equal(scorer.tooLarge, false)
    assert.ok(scorer.est < 2 * scorer.real, `a scorer's bundle: estimate ${MB(scorer.est)} MB for ${MB(scorer.real)} MB real`)
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

  it('a long five-set bundle with 14 signatures counts at most twice its JSON size and fits many times', () => {
    const signature = 'data:image/png;base64,' + Buffer.alloc(30000, 3).toString('base64')
    const events = Array.from({ length: 1200 }, (_, i) => ({ id: i + 1, matchId: 1, seq: i % 50 ? i + 1 : i + 0.1, setIndex: 1 + (i % 5), type: 'point', payload: { team: i % 2 ? 'home' : 'away', homePoints: i % 25, awayPoints: (i * 7) % 25 }, ts: '2026-10-06T18:00:00.000Z' }))
    const match = { seed_key: 'm', status: 'live', id: 1, homeTeamId: 1, awayTeamId: 2 }
    for (let i = 0; i < 14; i++) match[`signature${i}`] = signature
    const players = (teamId) => Array.from({ length: 14 }, (_, i) => ({ id: teamId * 100 + i, teamId, number: i + 1, firstName: 'First', lastName: `Last${i}`, dob: '2000-01-01', libero: i === 12, isCaptain: i === 0 }))
    const sets = [1, 2, 3, 4, 5].map((index) => ({ id: index, matchId: 1, index, homePoints: 25, awayPoints: 20, finished: true }))
    const bundle = [match, { id: 1, name: 'Home VC' }, { id: 2, name: 'Away VC' }, players(1), players(2), sets, events]
    const json = JSON.stringify(bundle).length
    const bytes = approxHeapBytes(bundle)
    assert.ok(bytes > json && bytes < 2 * json, `${bytes} for ${json} bytes of JSON`)
    // far under the per-room cap, and the default budget (--max-old-space-size=256)
    // holds well over the 39 matches of a regional league's peak
    assert.ok(bytes < MAX_RELAY_BUNDLE_BYTES / 4)
    const budget = relayMemoryBudget({ heapLimitBytes: 304 * 1024 * 1024 })
    assert.ok(budget.newRoomTotal / bytes > 60, `${Math.floor(budget.newRoomTotal / bytes)} such matches before new rooms are shed`)
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

describe('createFrameBudget', () => {
  const KB = 1024
  const make = (limits = {}) => {
    let t = 1000
    const budget = createFrameBudget({ windowMs: 60000, now: () => t, limits })
    return { budget, tick: (ms) => { t += ms } }
  }

  it('a socket without a claim sends small frames freely and a few large ones; then refused, then closed', () => {
    const { budget } = make()
    const sock = {}
    for (let i = 0; i < 100; i++) assert.equal(budget.check(sock, 'a', 60 * KB, false), 'ok')
    for (let i = 0; i < 4; i++) assert.equal(budget.check(sock, 'a', 200 * KB, false), 'ok', `large frame ${i + 1}`)
    assert.equal(budget.check(sock, 'a', 200 * KB, false), 'refused')
    assert.equal(budget.check(sock, 'a', 200 * KB, false), 'refused')
    assert.equal(budget.check(sock, 'a', 200 * KB, false), 'close')
  })

  it('a socket that owns a room is not limited by frame size, only by its bytes per window', () => {
    const { budget, tick } = make({ socketBytes: 10 * 1024 * KB })
    const sock = {}
    for (let i = 0; i < 9; i++) assert.equal(budget.check(sock, 'a', 1024 * KB, true), 'ok')
    assert.equal(budget.check(sock, 'a', 2 * 1024 * KB, true), 'refused')
    tick(61000)
    assert.equal(budget.check(sock, 'a', 2 * 1024 * KB, true), 'ok', 'a new window')
  })

  it("large frames of unproved sockets share their address's bytes; another address and loopback are apart", () => {
    const { budget } = make({ unprovedAddressBytes: 1024 * KB })
    for (let i = 0; i < 4; i++) assert.equal(budget.check({}, 'hall', 256 * KB, false), 'ok')
    assert.equal(budget.check({}, 'hall', 256 * KB, false), 'refused')
    assert.equal(budget.check({}, 'other', 256 * KB, false), 'ok')
    assert.equal(budget.check({}, null, 256 * KB, false), 'ok')
  })

  it('keeps at most maxAddresses address windows', () => {
    let t = 0
    const budget = createFrameBudget({ now: () => t, maxAddresses: 3 })
    for (let i = 0; i < 10; i++) budget.check({}, `a${i}`, 100 * KB, false)
    assert.equal(budget.addresses, 3)
    t += 120000
    budget.sweep()
    assert.equal(budget.addresses, 0)
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
