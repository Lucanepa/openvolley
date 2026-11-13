// Run as `node --expose-gc tests/helpers/heapShapes.js <case>` (from
// tests/relayLimits.test.js): builds one sync-match-data frame and takes it
// along the relay's own path (server.js handleSocketMessage ->
// handleSyncMatchData): frameTooLarge, JSON.parse, jsonTooDeep,
// relayBundleProblem, relayEvents, approxHeapBytes of what the relay keeps.
// Everything else of the frame is dropped, as the relay drops it. Prints
// { events, real, est, json, tooLarge } -- `real` the heap that stays (heapUsed
// after a full GC, from just before the frame is parsed to after those steps),
// `est` what approxHeapBytes counts, `tooLarge` whether the per-room cap
// refuses it. Cases (K = keys per object):
//   varied-<K>     every event a different order of the same K names
//   fixed-<K>      every event the same K names in the same order
//   dblfirst-<K>   one key order; the first event holds decimals, every later
//                  one small integers (V8 then keeps every field boxed)
//   reprmix-<K>    per key order, K + 1 events with decimals in the first 0..K
//                  fields (the fields widen one by one)
//   reprfull-<K>   reprmix-<K>, then the same fields widened again to text
//   prefixdep-<K>  key orders sharing their first K/2 names; a field of that
//                  prefix widened, then the same orders again, field by field
//   strip-<K>      varied-<K> with an undo snapshot, so relayEvents copies them
//   stripdbl-<K>   dblfirst-<K> with an undo snapshot
//   inmatch-<case> the objects of <case> in a list inside the match instead
//                  (a path relayEvents never touches)
//   separator      every object a different list of names that hold the
//                  separator character, from a small pool of names
//   tiny           one event holding a long list of empty objects
//   arrays         one event holding a long list of empty arrays
//   numbers        one event holding a long list of numbers (a decimal first)
//   mixed          one event holding a long list of decimals and empty strings
//   shortstr       one event holding a long list of distinct short strings
//   longstr        the same with ASCII strings just too long to count two
//                  bytes per character, as many as a frame holds
//   indexkeys      events with integer-like keys and a decimal
//   scorer         a long five-set match as a scorer sends it (events of a
//                  fixed shape per type, rosters, sets, 14 signatures)
import { Buffer } from 'node:buffer'
import { approxHeapBytes, frameTooLarge, relayBundleProblem, relayEvents, MAX_FRAME_VALUES, MAX_RELAY_BUNDLE_BYTES, MAX_RELAY_EVENTS } from '../../lib/relayLimits.js'
import { jsonTooDeep } from '../../lib/realtimeHub.js'

const [, , name] = process.argv
if (typeof global.gc !== 'function') throw new Error('run with --expose-gc')

// server.js MATCH_PIN_FIELDS / MATCH_PIN_TYPE_ONLY_FIELDS / MATCH_CARRIED_PIN_FIELDS
// (the frames hold valid PINs, so only the order of the checks matters here)
const PIN_FIELDS = ['refereePin', 'homeTeamPin', 'awayTeamPin', 'gamePin', 'game_pin', 'team1Pin', 'team2Pin']
const TYPE_ONLY_FIELDS = ['matchPin']
const CARRIED_FIELDS = ['connection_pins', 'connectionPins', 'matchPin']
// Room for the frame around the case's values, under MAX_FRAME_VALUES
const VALUES = MAX_FRAME_VALUES - 400
// The relay's frame limit (server.js wss maxPayload)
const MAX_FRAME_BYTES = 10 * 1024 * 1024

let seed = 7
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const shuffled = (list) => {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1));[out[i], out[j]] = [out[j], out[i]] }
  return out
}
const objectText = (pairs) => '{' + pairs.map(([k, v]) => JSON.stringify(k) + ':' + v).join(',') + '}'

// Objects (as JSON text) for an order-based case, as many as fit in `values`
// and `max` objects
function orderObjects(kind, K, values, max) {
  const names = Array.from({ length: K }, (_, i) => 'field' + i)
  const snapshot = kind.startsWith('strip') ? [['stateSnapshot', '0']] : []
  const per = K + 1 + snapshot.length
  const out = []
  const push = (pairs) => {
    if (out.length >= max || (out.length + 1) * per > values) return false
    out.push(objectText(pairs.concat(snapshot)))
    return true
  }
  for (;;) {
    let ok
    if (kind === 'varied' || kind === 'strip') ok = push(shuffled(names).map((k) => [k, '0']))
    else if (kind === 'fixed') ok = push(names.map((k) => [k, '0']))
    else if (kind === 'dblfirst' || kind === 'stripdbl') ok = push(names.map((k) => [k, out.length === 0 ? '1.5' : '1']))
    else if (kind === 'reprmix') {
      const order = shuffled(names)
      ok = true
      for (let f = 0; f <= K && ok; f++) ok = push(order.map((k, i) => [k, i < f ? '1.5' : '1']))
    } else if (kind === 'reprfull') {
      // every field of an order widened in turn: small integer, decimal, text
      const order = shuffled(names)
      ok = true
      for (let f = 0; f <= K && ok; f++) ok = push(order.map((k, i) => [k, i < f ? '1.5' : '1']))
      for (let f = 1; f <= K && ok; f++) ok = push(order.map((k, i) => [k, i < f ? '"x"' : '1.5']))
    } else if (kind === 'prefixdep') {
      // a fixed prefix of half the names, the rest in a new order per object;
      // then, field by field of the prefix, one object that makes it a decimal
      // (then text) followed by the same orders again with small integers
      const P = K >> 1
      const rounds = 2 * P + 1
      const m = Math.floor(Math.min(max, values / per) / rounds) - 2
      const rest = names.slice(P)
      const orders = Array.from({ length: m }, () => names.slice(0, P).concat(shuffled(rest)))
      const round = () => { for (const o of orders) push(o.map((k) => [k, '1'])) }
      round()
      for (let d = 0; d < P; d++) {
        for (const rep of ['1.5', '"x"']) {
          push(orders[0].map((k, i) => [k, i === d ? rep : '1']))
          round()
        }
      }
      return out
    } else throw new Error(`unknown case ${kind}-${K}`)
    if (!ok) return out
  }
}

function separatorObjects(values) {
  // Names made of 'a' runs joined by the separator: an object holding the
  // names of run lengths r1, r2, ... (all different, in that order) is its own
  // key list, while the plain joined text of every list summing to the same
  // total is one and the same.
  const nameOf = (r) => Array(r).fill('a').join('\u0000')
  const lists = []
  const walk = (left, used, cur) => {
    if (lists.length >= MAX_RELAY_EVENTS) return
    if (left === 0) { lists.push(cur.slice()); return }
    for (let p = 1; p <= left; p++) {
      if (used.has(p)) continue
      used.add(p); cur.push(p)
      walk(left - p, used, cur)
      cur.pop(); used.delete(p)
    }
  }
  walk(28, new Set(), [])
  const out = []
  let used = 0
  for (const list of lists) {
    if (used + 1 + list.length > values) break
    used += 1 + list.length
    out.push(objectText(list.map((r) => [nameOf(r), '0'])))
  }
  return out
}

// One event holding a list of items made by item(i), each `per` JSON values
// as frameTooLarge counts them
const oneList = (values, per, item) => ['{"type":"note","payload":[' + Array.from({ length: Math.floor((values - 3) / per) }, (_, i) => item(i)).join(',') + ']}']
// A distinct short string per index: 4 one-byte letters, or 2 two-byte characters
const shortString = (i) => (i % 2
  ? Array.from({ length: 4 }, (_, d) => String.fromCharCode(0x61 + (Math.floor(i / 26 ** d) % 26))).join('')
  : String.fromCharCode(0x4e00 + (i >> 8), 0x100 + (i & 0xff)))

function scorerFrame() {
  const signature = JSON.stringify('data:image/png;base64,' + Buffer.alloc(30000, 3).toString('base64'))
  const match = { id: 1, seed_key: 'room-1', status: 'live', gamePin: '987654', refereePin: '314159', homeTeamId: 1, awayTeamId: 2, scheduledAt: '2026-10-06T18:00:00.000Z', hall: 'Sports hall', league: 'Regional league', gameN: 1234 }
  for (let i = 0; i < 14; i++) match[`signature${i}`] = '__SIG__'
  const player = (teamId, i) => ({ id: teamId * 100 + i, teamId, number: i + 1, name: `Player ${i}`, firstName: 'First', lastName: `Last${i}`, dob: '2000-01-01', libero: i === 12, isCaptain: i === 0, licence: `L${teamId}${i}` })
  const payloads = [
    () => ({ team: rnd() < 0.5 ? 'home' : 'away' }),
    () => ({}),
    () => ({ team: 'home', playerOut: 7, playerIn: 12, position: 4 }),
    () => ({ team: 'away', reason: 'timeout' })
  ]
  const types = ['point', 'rally_start', 'substitution', 'timeout']
  const events = []
  for (let i = 0; i < 1200; i++) {
    const t = i % 40 === 0 ? 2 : i % 60 === 0 ? 3 : i % 2
    events.push({ matchId: 1, setIndex: 1 + Math.floor(i / 240), type: types[t], payload: payloads[t](), ts: new Date(Date.UTC(2026, 9, 6, 18) + i * 20000).toISOString(), seq: i % 50 === 0 ? i + 0.1 : i + 1, id: i + 1 })
  }
  const sets = [1, 2, 3, 4, 5].map((index) => ({ id: index, matchId: 1, index, homePoints: 25, awayPoints: 20 + index, finished: true, startTime: '2026-10-06T18:00:00.000Z' }))
  const frame = {
    type: 'sync-match-data',
    matchId: 'room-1',
    match,
    homeTeam: { id: 1, name: 'Home VC' },
    awayTeam: { id: 2, name: 'Away VC' },
    homePlayers: Array.from({ length: 14 }, (_, i) => player(1, i)),
    awayPlayers: Array.from({ length: 14 }, (_, i) => player(2, i)),
    sets,
    events
  }
  return JSON.stringify(frame).replaceAll('"__SIG__"', () => signature)
}

function frameText(c) {
  if (c === 'scorer') return scorerFrame()
  let inMatch = false
  let kind = c
  if (c.startsWith('inmatch-')) { inMatch = true; kind = c.slice('inmatch-'.length) }
  let objects
  const order = /^(varied|fixed|dblfirst|reprmix|reprfull|strip|stripdbl|prefixdep)-(\d+)$/.exec(kind)
  if (order) objects = orderObjects(order[1], Number(order[2]), VALUES, inMatch ? Infinity : MAX_RELAY_EVENTS)
  else if (kind === 'separator') objects = separatorObjects(VALUES)
  else if (kind === 'tiny') objects = oneList(VALUES, 2, () => '{}')
  else if (kind === 'arrays') objects = oneList(VALUES, 2, () => '[]')
  else if (kind === 'numbers') objects = oneList(VALUES, 1, (i) => (i === 0 ? '1.5' : '1'))
  else if (kind === 'mixed') objects = oneList(VALUES, 1, (i) => (i % 2 ? '""' : '1.5'))
  else if (kind === 'shortstr') objects = oneList(VALUES, 1, (i) => JSON.stringify(shortString(i)))
  else if (kind === 'longstr') objects = oneList(Math.floor(MAX_FRAME_BYTES / 70), 1, (i) => JSON.stringify(String(i).padStart(65, 'a')))
  else if (kind === 'indexkeys') objects = Array.from({ length: Math.min(MAX_RELAY_EVENTS, Math.floor(VALUES / 5)) }, (_, i) => `{"7":1,"1000":2,"50000":3,"x":${i === 0 ? '1.5' : '1'}}`)
  else throw new Error(`unknown case ${c}`)
  const list = '[' + objects.join(',') + ']'
  const match = `{"id":1,"seed_key":"room-1","status":"live","gamePin":"987654","refereePin":"314159"${inMatch ? `,"notes":${list}` : ''}}`
  return `{"type":"sync-match-data","matchId":"room-1","match":${match},"homeTeam":{"id":1,"name":"Home VC"},"awayTeam":{"id":2,"name":"Away VC"},"homePlayers":[],"awayPlayers":[],"sets":[],"events":${inMatch ? '[]' : list}}`
}

// What the relay keeps of a sync (server.js handleSyncMatchData)
function keep(data) {
  if (data.length > MAX_FRAME_BYTES) throw new Error('frame over the frame limit')
  if (frameTooLarge(data)) throw new Error('frame refused before it is parsed (frameTooLarge)')
  const message = JSON.parse(data.toString())
  if (jsonTooDeep(message)) throw new Error('frame refused: nested too deeply')
  const problem = relayBundleProblem(message, PIN_FIELDS, TYPE_ONLY_FIELDS, CARRIED_FIELDS)
  if (problem) throw new Error(`frame refused: ${problem.message}`)
  const storedEvents = relayEvents(message.events)
  const kept = [message.match, message.homeTeam, message.awayTeam, message.homePlayers, message.awayPlayers, message.sets, storedEvents]
  return { kept, est: approxHeapBytes(kept), events: storedEvents.length }
}

// The heap after a full GC, once it stops shrinking: gc() runs inside a task,
// and what that task last held can stay until a later turn of the event loop
// (on Node 24 often one more). The measurement starts once this module has
// been evaluated, with the frame built in a function of its own.
const settled = async () => {
  let last = Infinity
  for (let turn = 0; turn < 10; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    global.gc(); global.gc()
    const used = process.memoryUsage().heapUsed
    if (used > last - 64 * 1024) return used
    last = used
  }
  return last
}
const frameOf = (c) => Buffer.from(frameText(c))

async function measure() {
  // Once on a small frame first, so the code of the path is compiled before
  // the measurement starts
  keep(Buffer.from('{"type":"sync-match-data","matchId":"w","match":{"id":1},"events":[{"id":1,"stateSnapshot":0}]}'))
  // The frame arrives as a Buffer (off the V8 heap), as from the socket
  let data = frameOf(name)
  const json = data.length
  const before = await settled()
  const result = keep(data)
  data = null
  const real = (await settled()) - before
  // `result` (with what the relay keeps) is in use up to here
  process.stdout.write(JSON.stringify({ events: result.events, real, est: result.est, json, tooLarge: result.est > MAX_RELAY_BUNDLE_BYTES, kept: result.kept.length }) + '\n')
}
setTimeout(measure, 0)
