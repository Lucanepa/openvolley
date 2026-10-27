/**
 * validate-connection-pin's lookup (lib/matchAccess.js findMatchByConnectionPin).
 *
 * At the national peak (404 matches in setup, coach roster uploads with their
 * signatures still in matches.connections, about 41 KB per match) the lookup
 * read every setup / live match of the sport with its whole connections JSON
 * as one json_agg datum (about 16 MB per check) and scanned it in Node: a few
 * concurrent referee / bench joins OOM-killed Postgres (and the backend). The
 * database must be asked only for the rows that hold the PIN.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createPinHasher } from '../lib/pinHash.js'
import { connectionPinType, findMatchByConnectionPin } from '../lib/matchAccess.js'

const SECRET = 'x'.repeat(40)
const BIG = 'data:image/png;base64,' + 'A'.repeat(20000)

/**
 * A matches table behind pgQuery's runQuery (internal select), with the
 * filter types the lookup may use. Records every row it hands out.
 */
function fakeDb (rows) {
  const handedOut = []
  const queries = []
  const valueOf = (row, column) => {
    const m = /^([a-z_0-9]+)->>([a-z_0-9]+)$/.exec(column)
    if (!m) return row[column]
    const v = row[m[1]]?.[m[2]]
    return v === undefined || v === null ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v))
  }
  const pass = (row, f) => {
    const v = valueOf(row, f.column)
    if (f.type === 'eq') return v != null && String(v) === String(f.value)
    if (f.type === 'in') return v != null && f.value.map(String).includes(String(v))
    throw new Error(`fake db: filter ${f.type} not supported`)
  }
  async function runQuery ({ table, action, params }, opts) {
    assert.equal(table, 'matches')
    assert.equal(action, 'select')
    assert.equal(opts.internal, true)
    queries.push(params)
    const cols = params.columns.split(',').map(s => s.trim())
    let out = rows.filter(r => params.filters.every(f => pass(r, f)))
    const at = (r) => (r.scheduled_at ? Date.parse(r.scheduled_at) : -Infinity)
    out.sort((a, b) => at(b) - at(a))
    out = out.slice(0, opts.maxRows || 1000)
    const data = out.map(r => Object.fromEntries(cols.map(c => [c, r[c] ?? null])))
    handedOut.push(...data)
    return { status: 200, body: { data, error: null } }
  }
  return { runQuery, handedOut, queries }
}

function match (i, pins, { sport = 'indoor', status = 'setup', conns = {}, scheduledAt } = {}) {
  return {
    id: `uuid-${i}`,
    external_id: `ext-${i}`,
    game_n: 1000 + i,
    status,
    sport_type: sport,
    scheduled_at: scheduledAt || new Date(Date.UTC(2026, 10, 29, 10, 0) + i * 60000).toISOString(),
    home_team: { name: `Home ${i}` },
    away_team: { name: `Away ${i}` },
    team1_data: { name: `T1 ${i}` },
    team2_data: { name: `T2 ${i}` },
    connections: {
      referee_enabled: true,
      home_bench_enabled: true,
      away_bench_enabled: true,
      team1_bench_enabled: true,
      team2_bench_enabled: true,
      pending_home_roster: { coachSignature: BIG },
      pending_away_roster: { coachSignature: BIG },
      ...conns
    },
    connection_pins: pins
  }
}

const lookup = (db, pins, sport, type, pin, matchExternalId = null) =>
  findMatchByConnectionPin({ runQuery: db.runQuery, pins, sport, cfg: connectionPinType(sport, type), pin, matchExternalId, maxRows: 20000 })

describe('validate-connection-pin lookup', () => {
  it('asks the database for the rows holding the PIN only, not every match with its rosters', async () => {
    const pins = createPinHasher(SECRET)
    const rows = Array.from({ length: 404 }, (_, i) => match(i, pins.hashMatchRow({ connection_pins: { referee: String(100000 + i), bench_home: String(300000 + i), bench_away: String(500000 + i) } }).connection_pins))
    const db = fakeDb(rows)
    const found = await lookup(db, pins, 'indoor', 'referee', '100217')
    assert.equal(found.ok, true)
    assert.equal(found.row.external_id, 'ext-217')
    assert.deepEqual(db.handedOut.map(r => r.external_id), ['ext-217'])
    // a wrong PIN reads nothing at all
    db.handedOut.length = 0
    const wrong = await lookup(db, pins, 'indoor', 'referee', '999999')
    assert.deepEqual(wrong, { ok: true, row: null })
    assert.equal(db.handedOut.length, 0)
  })

  it('finds hashed and legacy plaintext PINs (also stored as a number), each under its own key', async () => {
    const pins = createPinHasher(SECRET)
    const rows = [
      match(1, pins.hashMatchRow({ connection_pins: { referee: '111111', bench_home: '222222' } }).connection_pins),
      match(2, { referee: '333333', bench_away: 444444 }),
      match(3, { bench_home: '555555' })
    ]
    const db = fakeDb(rows)
    assert.equal((await lookup(db, pins, 'indoor', 'referee', '111111')).row.external_id, 'ext-1')
    assert.equal((await lookup(db, pins, 'indoor', 'bench_home', ' 222222 ')).row.external_id, 'ext-1')
    assert.equal((await lookup(db, pins, 'indoor', 'referee', '333333')).row.external_id, 'ext-2')
    assert.equal((await lookup(db, pins, 'indoor', 'bench_away', '444444')).row.external_id, 'ext-2')
    // the referee PIN is not a bench PIN, and a bench PIN of one team not the other's
    assert.equal((await lookup(db, pins, 'indoor', 'bench_home', '111111')).row, null)
    assert.equal((await lookup(db, pins, 'indoor', 'bench_away', '555555')).row, null)
    // without the secret a hashed PIN cannot be checked; plaintext still can
    const plain = createPinHasher(null)
    assert.equal((await lookup(db, plain, 'indoor', 'referee', '111111')).row, null)
    assert.equal((await lookup(db, plain, 'indoor', 'referee', '333333')).row.external_id, 'ext-2')
  })

  it('keeps the rules: connection on, setup / live, the sport and the bound match; newest scheduled first', async () => {
    const pins = createPinHasher(SECRET)
    const p = (pin) => pins.hashMatchRow({ connection_pins: { referee: pin, bench_team1: pin, team1_data: '777777' } }).connection_pins
    const rows = [
      match(1, p('123456'), { conns: { referee_enabled: false } }),
      match(2, p('123456'), { status: 'final' }),
      match(3, p('123456'), { sport: 'beach' }),
      match(4, p('123456'), { scheduledAt: '2026-11-29T09:00:00.000Z' }),
      match(5, p('123456'), { status: 'live', scheduledAt: '2026-11-29T11:00:00.000Z' }),
      match(6, p('654321'), { sport: 'beach', conns: { team1_bench_enabled: false } })
    ]
    const db = fakeDb(rows)
    // 1 is off, 2 finished, 3 beach: of 4 and 5 the newest scheduled
    assert.equal((await lookup(db, pins, 'indoor', 'referee', '123456')).row.external_id, 'ext-5')
    assert.equal((await lookup(db, pins, 'indoor', 'referee', '123456', 'ext-4')).row.external_id, 'ext-4')
    assert.equal((await lookup(db, pins, 'indoor', 'referee', '123456', 'ext-1')).row, null)
    assert.equal((await lookup(db, pins, 'beach', 'referee', '123456')).row.external_id, 'ext-3')
    // beach bench PINs under either key (team1_data: older openbeach builds)
    assert.equal((await lookup(db, pins, 'beach', 'bench_team1', '123456')).row.external_id, 'ext-3')
    assert.equal((await lookup(db, pins, 'beach', 'bench_team1', '777777')).row.external_id, 'ext-3')
    assert.equal((await lookup(db, pins, 'beach', 'bench_team1', '654321')).row, null)
    // the roster upload PINs have no connection flag
    const up = fakeDb([match(9, pins.hashMatchRow({ connection_pins: { upload_home: '246810' } }).connection_pins, { conns: { home_bench_enabled: false } })])
    assert.equal((await lookup(up, pins, 'indoor', 'upload_home', '246810')).row.external_id, 'ext-9')
  })

  it('a database error is no "wrong PIN"', async () => {
    const pins = createPinHasher(SECRET)
    const runQuery = async () => ({ status: 503, body: { data: null, error: { code: 'OV_DB_UNAVAILABLE' } } })
    const found = await findMatchByConnectionPin({ runQuery, pins, sport: 'indoor', cfg: connectionPinType('indoor', 'referee'), pin: '123456', maxRows: 10 })
    assert.equal(found.ok, false)
  })
})
