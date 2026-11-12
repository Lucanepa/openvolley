/**
 * What an anonymous client may send the backend: nothing it sends may end the
 * process or fill its memory (one backend holds every relay room, PIN budget
 * and sign session in memory, and loses them all with a restart). Boots
 * server.js as a venue relay (--local), as a cloud relay behind Cloudflare
 * (IS_CLOUD, TRUST_PROXY) and, with PG_TEST_URL, in DATABASE_URL mode.
 *
 *   - /api/official-matches looks up federation and league as own keys only
 *   - a synced PIN that is not text or a number is refused at the sync, so no
 *     PIN header on GET /api/match/:id can make it throw
 *   - bundles: array lengths, a heap estimate per room (lib/relayLimits.js)
 *     and a relay memory budget per address and in total; live states over
 *     256 KB are refused before they are stored or relayed
 *   - a long five-set match from an older scorer (undo snapshots, signatures)
 *     is kept whole
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { bootServer, openSocket, provisionDatabase, subscribe, sleep, SKIP } from './helpers/e2eServer.js'

const POISON = { toString: 1 } // JSON {"toString":1}: String() of it throws
const PIN = '314159'

async function alive(base) {
  try {
    return (await fetch(`${base}/health/live`, { signal: AbortSignal.timeout(3000) })).ok
  } catch { return false }
}

async function get(base, path, headers = {}) {
  try {
    const r = await fetch(base + path, { headers, signal: AbortSignal.timeout(5000) })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: r.status, json, text }
  } catch (err) {
    return { status: null, error: err?.cause?.code || err?.message }
  }
}

/** Send a ping and wait for its pong: every earlier message of this socket was handled. */
async function settle(c) {
  const n = c.messages.filter((m) => m.type === 'pong').length
  c.send({ type: 'ping' })
  await c.waitFor(() => c.messages.filter((m) => m.type === 'pong').length > n, 8000, 'pong')
}
const errorsOf = (c) => c.messages.filter((m) => m.type === 'error')
const lastError = (c) => errorsOf(c).at(-1)

function syncMessage(room, { match = {}, ...extra } = {}) {
  return {
    type: 'sync-match-data',
    matchId: room,
    match: { id: 1, seed_key: room, status: 'live', gamePin: '987654', refereePin: PIN, refereeConnectionEnabled: true, ...match },
    homeTeam: { id: 1, name: 'Home VC' },
    awayTeam: { id: 2, name: 'Away VC' },
    homePlayers: [],
    awayPlayers: [],
    sets: [],
    events: [],
    ...extra
  }
}

// What an older scorer (before 2026-10-26) sends at the end of a long five-set
// match: every event with its undo snapshot (about what
// Scoreboard.captureFullStateSnapshot stores), the rosters and the 14
// signature images (PNG data URLs) on the match.
function longFiveSetBundle(room) {
  const snapshot = (setIndex, a, b, seq) => ({
    currentSetIndex: setIndex, pointsA: a, pointsB: b, setsWonA: 2, setsWonB: 2, teamAKey: 'home', sideA: 'left', servingTeam: seq % 2 ? 'A' : 'B',
    lineupA: { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }, lineupB: { I: 11, II: 12, III: 13, IV: 14, V: 15, VI: 16 },
    liberoA: { libero1: 12, replaced: 5, position: 'V' }, liberoB: { libero1: 18, replaced: 15, position: 'V' },
    timeoutsA: [{ at: '2026-10-06T18:10:00.000Z', score: '8:6' }], timeoutsB: [],
    substitutionsA: [{ in: 7, out: 3, score: '12:10' }, { in: 3, out: 7, score: '18:15' }], substitutionsB: [{ in: 17, out: 13, score: '14:14' }],
    sanctionsA: [], sanctionsB: [{ type: 'warning', role: 'coach' }],
    rotationHistoryA: [1, 2, 3, 4, 5, 6], rotationHistoryB: [11, 12, 13, 14, 15, 16], matchStatus: 'live', set5CourtSwitched: false, notes: 'x'.repeat(2500)
  })
  const events = []
  const sets = []
  let seq = 0
  ;[[30, 28], [23, 25], [27, 25], [22, 25], [18, 16]].forEach(([home, away], i) => {
    const setIndex = i + 1
    const set = { id: setIndex, matchId: 1, index: setIndex, homePoints: 0, awayPoints: 0, finished: false }
    sets.push(set)
    const ev = (type, payload, withSnapshot = true) => {
      seq++
      const e = { id: seq, matchId: 1, seq, setIndex, type, payload, ts: new Date(Date.UTC(2026, 9, 6, 18) + seq * 20000).toISOString() }
      if (withSnapshot) e.stateSnapshot = snapshot(setIndex, set.homePoints, set.awayPoints, seq)
      events.push(e)
    }
    ev('set_start', {})
    ev('lineup', { team: 'home', lineup: { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 } })
    ev('lineup', { team: 'away', lineup: { I: 11, II: 12, III: 13, IV: 14, V: 15, VI: 16 } })
    for (let k = 0; k < home + away; k++) {
      ev('rally_start', {}, false)
      const team = k % 2 ? 'home' : 'away'
      set[team === 'home' ? 'homePoints' : 'awayPoints']++
      ev('point', { team })
      if (k % 6 === 0) ev('substitution', { team, playerIn: 7, playerOut: 3 })
      if (k === 10 || k === 30) ev('timeout', { team })
    }
    set.finished = true
    ev('set_end', { winner: 'home' })
  })
  const signature = 'data:image/png;base64,' + Buffer.alloc(60000, 7).toString('base64')
  const signatures = {}
  for (const k of ['homeCoachSignature', 'homeCaptainSignature', 'awayCoachSignature', 'awayCaptainSignature', 'homePostGameCaptainSignature',
    'awayPostGameCaptainSignature', 'asstScorerSignature', 'scorerSignature', 'ref2Signature', 'ref1Signature']) signatures[k] = signature
  const player = (n, teamId) => ({ id: n, teamId, number: n, firstName: 'First', lastName: `Last${n}`, dob: '2000-01-01', isCaptain: n === 1 })
  return syncMessage(room, {
    match: { ...signatures, remarksSignatures: Array.from({ length: 4 }, () => ({ role: 'captain', signature })), remarks: 'r'.repeat(3000) },
    homePlayers: Array.from({ length: 14 }, (_, i) => player(i + 1, 1)),
    awayPlayers: Array.from({ length: 14 }, (_, i) => player(i + 21, 2)),
    sets,
    events
  })
}

describe('anonymous input on a venue relay (--local)', () => {
  // A server per test: one that ends must not take the next test with it
  let srv
  const sockets = []
  beforeEach(async () => {
    srv = await bootServer({}, ['--local'])
  })
  afterEach(async () => {
    for (const c of sockets.splice(0)) { try { c.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
  })
  const open = async () => {
    const c = await openSocket(srv.wsUrl)
    sockets.push(c)
    return c
  }

  it('/api/official-matches answers 400 to an inherited federation or league name and stays up', async () => {
    // one GET with federation=constructor ended the process (TypeError on .leagues)
    const tried = []
    for (const federation of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      tried.push([federation, (await get(srv.base, `/api/official-matches?federation=${federation}&league=x`)).status])
    }
    // a real federation with an inherited league name: refused, nothing fetched
    for (const league of ['constructor', 'toString', 'valueOf']) {
      tried.push([`SV/${league}`, (await get(srv.base, `/api/official-matches?federation=SV&league=${league}`)).status])
    }
    assert.deepEqual(tried.filter(([, status]) => status !== 400), [], srv.output.join('').slice(-2000))
    assert.equal(await alive(srv.base), true)
  })

  it('a synced PIN that is not text or a number is refused; no PIN header can end the server', async () => {
    // one socket per room (a socket that syncs another room leaves its last one)
    const rooms = {
      'poison-pin': { refereePin: POISON, homeTeamPin: POISON, homeTeamConnectionEnabled: true },
      'poison-game': { gamePin: POISON },
      'poison-array': { refereePin: [PIN] },
      'poison-long': { refereePin: '1'.repeat(65) }
    }
    const refused = []
    for (const [room, match] of Object.entries(rooms)) {
      const evil = await open()
      evil.send(syncMessage(room, { match }))
      await settle(evil)
      refused.push(...errorsOf(evil).map((m) => [m.code, m.matchId]))
    }
    const answers = []
    for (const room of Object.keys(rooms)) answers.push((await get(srv.base, `/api/match/${room}`, { 'X-OV-Match-Pin': '1' })).status)
    assert.equal(await alive(srv.base), true, srv.output.join('').slice(-2000))
    assert.deepEqual(answers, [404, 404, 404, 404], 'none of them was stored')
    assert.deepEqual(refused, Object.keys(rooms).map((room) => ['bad-request', room]))

    // A PIN stored as a number (older scorers) still proves the match
    const scorer = await open()
    scorer.send(syncMessage('numeric-pin', { match: { refereePin: 314159, gamePin: 987654 } }))
    await settle(scorer)
    assert.deepEqual(errorsOf(scorer), [])
    const full = await get(srv.base, '/api/match/numeric-pin', { 'X-OV-Match-Pin': PIN })
    assert.equal(full.json?.access, 'full')
  })

  it('refuses a bundle over the relay limits with too-large and keeps the room\'s last one', async () => {
    const scorer = await open()
    scorer.send(syncMessage('limits-1', { sets: [{ id: 1, index: 1, homePoints: 3, awayPoints: 1 }] }))
    await settle(scorer)
    assert.deepEqual(errorsOf(scorer), [])

    // more events than any match has (a restore takes 20000)
    scorer.send(syncMessage('limits-1', { events: Array.from({ length: 20001 }, (_, i) => ({ id: i })) }))
    // one event holding many small values (12 MB of heap from a 600 KB frame)
    scorer.send(syncMessage('limits-1', { events: [{ id: 1, type: 'remark', payload: { notes: Array.from({ length: 200000 }, () => ({})) } }] }))
    // a frame with more values than a five-set bundle has, refused before it is parsed
    scorer.ws.send('{"type":"sync-match-data","matchId":"limits-1","match":{"seed_key":"limits-1","status":"live"},"events":[' + new Array(400000).fill('0').join(',') + ']}')
    await settle(scorer)
    assert.deepEqual(errorsOf(scorer).map((m) => m.code), ['too-large', 'too-large', 'too-large'])
    assert.match(lastError(scorer).message, /too large/i)

    const kept = await get(srv.base, '/api/match/limits-1', { 'X-OV-Match-Pin': PIN })
    assert.equal(kept.status, 200)
    assert.deepEqual(kept.json.sets.map((s) => s.homePoints), [3], 'the last accepted bundle stays')
    assert.equal(kept.json.events.length, 0)
    assert.equal(await alive(srv.base), true)
  })

  it('keeps a long five-set match from an older scorer whole (undo snapshots dropped)', async () => {
    const scorer = await open()
    const bundle = longFiveSetBundle('five-sets')
    const frame = JSON.stringify(bundle)
    assert.ok(frame.length > 2 * 1024 * 1024, `a realistic worst case (${frame.length} bytes)`)
    scorer.ws.send(frame)
    await settle(scorer)
    assert.deepEqual(errorsOf(scorer), [])
    const full = await get(srv.base, '/api/match/five-sets', { 'X-OV-Match-Pin': PIN })
    assert.equal(full.json?.access, 'full')
    assert.equal(full.json.events.length, bundle.events.length)
    assert.equal(full.json.sets.length, 5)
    assert.equal(full.text.includes('stateSnapshot'), false)
  })

  it('refuses a live state over 256 KB before it is stored or relayed', async () => {
    const scorer = await open()
    const viewer = await open()
    scorer.send(syncMessage('live-big'))
    await settle(scorer)
    viewer.send({ type: 'subscribe-match', matchId: 'live-big', device: 'livescore' })
    await viewer.waitFor((m) => m.type === 'match-full-data')

    scorer.send({ type: 'live-state-update', matchId: 'live-big', liveState: { points_a: 1, junk: 'j'.repeat(300 * 1024) } })
    await settle(scorer)
    assert.equal(lastError(scorer)?.code, 'too-large')
    assert.equal(lastError(scorer)?.matchId, 'live-big')
    const summary = await get(srv.base, '/api/match/live-big')
    assert.equal(summary.json.liveState, undefined, 'not stored')

    // a real one goes through
    scorer.send({ type: 'live-state-update', matchId: 'live-big', liveState: { points_a: 2, points_b: 0 } })
    const live = await viewer.waitFor((m) => m.type === 'live-state-update')
    assert.deepEqual(live.liveState, { points_a: 2, points_b: 0 })
    await settle(viewer)
    assert.equal(viewer.messages.filter((m) => m.type === 'live-state-update').length, 1, 'the big one never reached the viewer')
    assert.equal(await alive(srv.base), true)
  })
})

describe('relay memory budget on the cloud relay (new rooms shed first, matches in play kept)', () => {
  let srv
  const sockets = []
  before(async () => {
    // a small budget (5 MB total, 2.5 MB per address, new rooms shed at 4 MB /
    // 2 MB) so the test needs little memory
    srv = await bootServer({ IS_CLOUD: '1', TRUST_PROXY: 'cloudflare', OV_RELAY_MAX_MB: '5' }, ['--local'])
  })
  after(async () => {
    for (const c of sockets) { try { c.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
  })
  const open = async (ip) => {
    const c = await openSocket(srv.wsUrl, { headers: { 'cf-connecting-ip': ip } })
    sockets.push(c)
    return c
  }
  // about 0.9 MB in the relay's memory each
  const big = (room) => syncMessage(room, { match: { remarks: 'r'.repeat(900 * 1024) } })
  const syncFrom = async (ip, room) => {
    const c = await open(ip)
    c.send(big(room))
    await settle(c)
    return c
  }

  it('refuses a new room with relay-full at the new-room mark, per address and in total', async () => {
    const A = '203.0.113.10'
    const B = '198.51.100.20'
    const C = '192.0.2.30'
    const a1 = await syncFrom(A, 'budget-a1')
    const a2 = await syncFrom(A, 'budget-a2')
    const a3 = await syncFrom(A, 'budget-a3')
    assert.deepEqual([a1, a2].flatMap(errorsOf), [])
    assert.equal(lastError(a3)?.code, 'relay-full', 'a third new room from one address is over its share')
    // the room a sync replaces is not counted twice (an existing room may grow)
    a1.send(big('budget-a1'))
    await settle(a1)
    assert.deepEqual(errorsOf(a1), [])

    // other addresses fill the rest up to the relay-wide new-room mark (4 MB)
    const b1 = await syncFrom(B, 'budget-b1')
    const b2 = await syncFrom(B, 'budget-b2')
    assert.deepEqual([b1, b2].flatMap(errorsOf), [])
    const c1 = await syncFrom(C, 'budget-c1')
    assert.equal(lastError(c1)?.code, 'relay-full', 'a new room over the relay-wide new-room mark')
    assert.equal((await get(srv.base, '/api/match/budget-c1')).status, 404)

    // the rooms of A's and B's closed sockets give their memory back
    for (const c of [a1, a2, a3, b1, b2]) c.ws.close()
    await sleep(300)
    const before = errorsOf(c1).length
    c1.send(big('budget-c1'))
    await settle(c1)
    assert.equal(errorsOf(c1).length, before, 'accepted now (no new refusal)')
    assert.equal((await get(srv.base, '/api/match/budget-c1', { 'X-OV-Match-Pin': PIN })).json?.access, 'full')

    // small bundles of a hall behind one address are never in the way
    const hall = []
    for (let i = 0; i < 10; i++) {
      const c = await open(C)
      c.send(syncMessage(`budget-hall-${i}`))
      hall.push(c)
    }
    for (const c of hall) await settle(c)
    assert.deepEqual(hall.flatMap(errorsOf), [])
  })

  it('keeps a match already in play syncing and publishing after new rooms fill the relay', async () => {
    // an in-play match, owned, with a referee watching, before the relay fills
    const hall = await open('203.0.113.70')
    const referee = await open('203.0.113.71')
    hall.send(syncMessage('in-play', { sets: [{ id: 1, index: 1, homePoints: 10, awayPoints: 8 }] }))
    await settle(hall)
    assert.deepEqual(errorsOf(hall), [])
    referee.send({ type: 'subscribe-match', matchId: 'in-play', pin: PIN })
    await referee.waitFor((m) => m.type === 'match-full-data')

    // other addresses open new rooms until one is refused at the new-room mark
    let refused = false
    for (let i = 0; i < 8 && !refused; i++) {
      const c = await open(`198.51.100.${100 + i}`)
      c.send(big(`in-play-fill-${i}`))
      await settle(c)
      if (lastError(c)?.code === 'relay-full') refused = true
    }
    assert.equal(refused, true, 'the relay reached its new-room mark')

    // the in-play match plays on: a bigger bundle (another rally, a set) and a
    // live state, both into the headroom kept for matches in play
    hall.send(syncMessage('in-play', { sets: [{ id: 1, index: 1, homePoints: 11, awayPoints: 8 }, { id: 2, index: 2, homePoints: 3, awayPoints: 1 }] }))
    hall.send({ type: 'live-state-update', matchId: 'in-play', liveState: { points_a: 11, points_b: 8, serving: 'home' } })
    await settle(hall)
    assert.deepEqual(errorsOf(hall), [], 'the match in play must not be frozen')
    const live = await referee.waitFor((m) => m.type === 'live-state-update')
    assert.deepEqual(live.liveState, { points_a: 11, points_b: 8, serving: 'home' })
    const kept = await get(srv.base, '/api/match/in-play', { 'X-OV-Match-Pin': PIN })
    assert.deepEqual(kept.json.sets.map((s) => s.homePoints), [11, 3], 'the newer bundle is held')
  })
})

describe('anonymous input in DATABASE_URL mode', { skip: SKIP }, () => {
  let db
  let srv
  let storageRoot
  let statusDir
  const sockets = []
  before(async () => {
    db = await provisionDatabase()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-relaylimits-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-relaylimits-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1'
    })
  })
  after(async () => {
    for (const c of sockets) { try { c.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
    if (db) await db.drop()
    for (const d of [storageRoot, statusDir]) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }
  })

  it('neither an inherited federation name nor a poisoned PIN ends the backend', async () => {
    const ip = { 'cf-connecting-ip': '203.0.113.66' }
    assert.equal((await get(srv.base, '/api/official-matches?federation=__proto__&league=x', ip)).status, 400)
    assert.equal((await get(srv.base, '/api/official-matches?federation=constructor&league=x', ip)).status, 400)
    const evil = await openSocket(srv.wsUrl, { headers: ip })
    sockets.push(evil)
    evil.send(syncMessage('db-poison', { match: { refereePin: POISON } }))
    await settle(evil)
    assert.equal(lastError(evil)?.code, 'bad-request')
    assert.equal((await get(srv.base, '/api/match/db-poison', { 'X-OV-Match-Pin': '1', ...ip })).status, 404)
    assert.equal((await get(srv.base, '/api/server/connections?matchId=db-poison', { 'X-OV-Match-Pin': '1', ...ip })).status, 200)
    assert.equal(await alive(srv.base), true, srv.output.join('').slice(-2000))
  })
})

// A storage root and status dir the backend accepts (a cloud boot needs them)
function tempStorage() {
  const storageRoot = mkdtempSync(join(tmpdir(), 'ov-relaylimits-storage-'))
  writeFileSync(join(storageRoot, '.ovdata'), '')
  const statusDir = mkdtempSync(join(tmpdir(), 'ov-relaylimits-status-'))
  writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
  return { storageRoot, statusDir }
}
const CLOUD_ENV = (db, extra = {}) => ({
  DATABASE_URL: db.url,
  TRUST_PROXY: 'cloudflare',
  TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
  STORAGE_BACKUP_MIN_FREE_MB: '1',
  STORAGE_SCORESHEETS_MIN_FREE_MB: '1',
  ...extra
})
async function seedOfficialMatch(url, { id = null, externalId, gamePin = '987654' }) {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    if (id) {
      await client.query("INSERT INTO matches (id, external_id, game_n, game_pin, status, sport_type) VALUES ($1,$2,$3,$4,'live','indoor')", [id, externalId, 9000, gamePin])
    } else {
      await client.query("INSERT INTO matches (external_id, game_n, game_pin, status, sport_type) VALUES ($1,$2,$3,'live','indoor')", [externalId, 9000, gamePin])
    }
  } finally { await client.end() }
}

describe('official matches keep priority over an anonymous flood (DATABASE_URL)', { skip: SKIP }, () => {
  let db, srv, storageRoot, statusDir
  const sockets = []
  before(async () => {
    db = await provisionDatabase()
    await seedOfficialMatch(db.url, { externalId: 'off-1' }) // the database knows it, game PIN 987654
    ;({ storageRoot, statusDir } = tempStorage())
    // 6 MB total: anonymous rooms may hold at most 60% of it (about 3.77 MB)
    srv = await bootServer(CLOUD_ENV(db, { STORAGE_ROOT: storageRoot, STATUS_DIR: statusDir, OV_RELAY_MAX_MB: '6' }))
  })
  after(async () => {
    for (const c of sockets) { try { c.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
    if (db) await db.drop()
    for (const d of [storageRoot, statusDir]) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }
  })
  const open = async (ip) => {
    const c = await openSocket(srv.wsUrl, { headers: { 'cf-connecting-ip': ip } })
    sockets.push(c)
    return c
  }
  // ~0.9 MB each, a room the database does not know (its own game PIN)
  const anonBig = (room) => syncMessage(room, { match: { remarks: 'r'.repeat(900 * 1024), gamePin: `x-${room}` } })

  it('caps the rooms the database does not know, so an official match still syncs and grows', async () => {
    // fill rooms the database does not know, across two /64s, up to the reserved share
    const anon = []
    for (const net of ['2001:db8:a::1', '2001:db8:b::1']) {
      for (let i = 0; i < 2; i++) {
        const c = await open(net)
        c.send(anonBig(`anon-${net}-${i}`))
        await settle(c)
        anon.push(c)
      }
    }
    assert.deepEqual(anon.flatMap(errorsOf), [], 'the anonymous rooms up to the cap are kept')
    // one more anonymous room, from a fresh /64 (per-address and new-room marks
    // are not reached): only the anonymous share stops it
    const over = await open('2001:db8:c::1')
    over.send(anonBig('anon-over'))
    await settle(over)
    assert.equal(lastError(over)?.code, 'relay-full', 'an anonymous room over the reserved share is refused')

    // the official match (the database knows it, matching game PIN) still syncs
    const scorer = await open('203.0.113.200')
    scorer.send(syncMessage('off-1'))
    await settle(scorer)
    assert.deepEqual(errorsOf(scorer), [], 'the official match must not be frozen by the anonymous flood')
    assert.equal((await get(srv.base, '/api/match/off-1', { 'X-OV-Match-Pin': PIN })).json?.access, 'full')
    // and it grows into the space reserved for official matches
    scorer.send(syncMessage('off-1', { match: { remarks: 'r'.repeat(900 * 1024) }, sets: [{ id: 1, index: 1, homePoints: 7, awayPoints: 5 }] }))
    await settle(scorer)
    assert.deepEqual(errorsOf(scorer), [], 'an official match in play grows past the anonymous cap')
    const kept = await get(srv.base, '/api/match/off-1', { 'X-OV-Match-Pin': PIN })
    assert.deepEqual(kept.json.sets.map((s) => s.homePoints), [7])

    // another anonymous room is still refused
    const more = await open('2001:db8:d::1')
    more.send(anonBig('anon-more'))
    await settle(more)
    assert.equal(lastError(more)?.code, 'relay-full')
    assert.equal(await alive(srv.base), true)
  })
})

describe('a live state the relay memory cannot keep still reaches the livescore (DATABASE_URL)', { skip: SKIP }, () => {
  let db, srv, storageRoot, statusDir
  const MATCH_UUID = '11111111-1111-4111-8111-111111111111'
  const sockets = []
  before(async () => {
    db = await provisionDatabase()
    await seedOfficialMatch(db.url, { id: MATCH_UUID, externalId: 'off-live' })
    ;({ storageRoot, statusDir } = tempStorage())
    // a tiny budget (0.4 MB total, 0.2 MB per address) so one real-sized live
    // state (about 0.25 MB) is more than an address may keep
    srv = await bootServer(CLOUD_ENV(db, { STORAGE_ROOT: storageRoot, STATUS_DIR: statusDir, OV_RELAY_MAX_MB: '0.4' }))
  })
  after(async () => {
    for (const c of sockets) { try { c.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
    if (db) await db.drop()
    for (const d of [storageRoot, statusDir]) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }
  })
  const open = async (ip) => {
    const c = await openSocket(srv.wsUrl, { headers: { 'cf-connecting-ip': ip } })
    sockets.push(c)
    return c
  }

  it('on relay-full the scorer is told, but the realtime hub still publishes the update', async () => {
    const scorer = await open('203.0.113.210')
    scorer.send(syncMessage('off-live')) // proves the match (game PIN 987654)
    await settle(scorer)
    assert.deepEqual(errorsOf(scorer), [])

    // a livescore client subscribed to this match's live state on the realtime hub
    const live = await openSocket(`${srv.wsUrl}/?purpose=live`)
    sockets.push(live)
    await subscribe(live, 'ls', [{ table: 'match_live_state', event: '*', column: 'match_id', value: MATCH_UUID }])

    // a live state larger than this address may keep: the relay refuses to store
    // or broadcast it, but the database live-state path must still publish it
    scorer.send({ type: 'live-state-update', matchId: 'off-live', liveState: { points_a: 12, points_b: 9, match_status: 'live', junk: 'j'.repeat(255000) } })
    const err = await scorer.waitFor((m) => m.type === 'error', 8000, 'relay-full')
    assert.equal(err.code, 'relay-full')
    const change = await live.waitFor((m) => m.type === 'db-change' && m.table === 'match_live_state', 8000, 'live-state db-change')
    assert.equal(change.new?.points_a, 12, JSON.stringify(change))
    assert.equal(await alive(srv.base), true)
  })
})
