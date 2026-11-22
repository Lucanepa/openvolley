// readHomeMatchStatus (utils/homeMatchStatus) gives the status App's
// matchStatus live query computed before the performance pass (22.11), for
// every kind of match, on the app's real database (Dexie 4 on fake-indexeddb).
// The oracle below is that querier's body, copied as it was (App.jsx at
// 1fa05852a), returning its status (null where it returned null).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { db } from '../../db/db'
import { isStaleClosedCopy } from '../matchReopen'
import { readHomeMatchStatus } from '../homeMatchStatus'

async function oracle(currentMatch) {
  if (!currentMatch) return null

  // For test matches that have been restarted (no signatures, only initial set, no events), don't show status
  if (currentMatch.test === true) {
    const hasSignatures = currentMatch.homeCoachSignature ||
      currentMatch.homeCaptainSignature ||
      currentMatch.awayCoachSignature ||
      currentMatch.awayCaptainSignature

    if (!hasSignatures) {
      const sets = await db.sets.where('matchId').equals(currentMatch.id).toArray()
      const events = await db.events.where('matchId').equals(currentMatch.id).toArray()
      // If only initial set exists and no events, it's been restarted - don't show status
      if (sets.length === 1 && events.length === 0) {
        return null
      }
    }
  }

  const homeTeamPromise = currentMatch.homeTeamId ? db.teams.get(currentMatch.homeTeamId) : Promise.resolve(null)
  const awayTeamPromise = currentMatch.awayTeamId ? db.teams.get(currentMatch.awayTeamId) : Promise.resolve(null)

  const setsPromise = db.sets.where('matchId').equals(currentMatch.id).toArray()
  const eventsPromise = db.events.where('matchId').equals(currentMatch.id).toArray()
  const homePlayersPromise = currentMatch.homeTeamId
    ? db.players.where('teamId').equals(currentMatch.homeTeamId).count()
    : Promise.resolve(0)
  const awayPlayersPromise = currentMatch.awayTeamId
    ? db.players.where('teamId').equals(currentMatch.awayTeamId).count()
    : Promise.resolve(0)

  const [homeTeam, awayTeam, sets, events, homePlayers, awayPlayers] = await Promise.all([
    homeTeamPromise,
    awayTeamPromise,
    setsPromise,
    eventsPromise,
    homePlayersPromise,
    awayPlayersPromise
  ])

  const signaturesComplete = Boolean(
    currentMatch.homeCoachSignature &&
    currentMatch.homeCaptainSignature &&
    currentMatch.awayCoachSignature &&
    currentMatch.awayCaptainSignature
  )

  const infoConfigured = Boolean(
    (currentMatch.scheduledAt && String(currentMatch.scheduledAt).trim() !== '') ||
    (currentMatch.city && String(currentMatch.city).trim() !== '') ||
    (currentMatch.hall && String(currentMatch.hall).trim() !== '') ||
    (currentMatch.league && String(currentMatch.league).trim() !== '')
  )

  const rostersReady = homePlayers >= 6 && awayPlayers >= 6
  const matchReadyForPlay = infoConfigured && signaturesComplete && rostersReady

  const hasActiveSet = sets.some(set => {
    return Boolean(
      set.finished ||
      set.startTime ||
      set.homePoints > 0 ||
      set.awayPoints > 0
    )
  })

  const hasEventActivity = events.some(event =>
    ['set_start', 'rally_start', 'point'].includes(event.type)
  )

  let status = 'No data'
  // A copy the server has closed is no match being recorded: the header
  // does not say so, and New match warns instead of doing nothing
  if (currentMatch.status === 'final' || (sets.length > 0 && sets.every(s => s.finished)) || isStaleClosedCopy(currentMatch)) {
    status = 'Match ended'
  } else if ((currentMatch.status === 'live' || hasActiveSet || hasEventActivity) && matchReadyForPlay) {
    status = 'Match recording'
  } else if (homePlayers > 0 || awayPlayers > 0 || currentMatch.homeCoachSignature || currentMatch.awayCoachSignature) {
    if (signaturesComplete) {
      status = 'Coin toss'
    } else {
      status = 'Setup'
    }
  }

  void homeTeam
  void awayTeam
  return status
}

// Teams with 0, 3 and 7 players (rostersReady needs 6 on each side)
const teams = {}
const SIGS = {
  none: {},
  coach: { homeCoachSignature: 'h', awayCoachSignature: 'a' },
  all: { homeCoachSignature: 'h', homeCaptainSignature: 'hc', awayCoachSignature: 'a', awayCaptainSignature: 'ac' }
}
const INFO = { none: {}, blank: { city: '  ', league: '' }, set: { league: '3L', hall: 'Hall A' } }
const SETS = {
  none: [],
  initial: [{ index: 1, homePoints: 0, awayPoints: 0, finished: false }],
  playing: [{ index: 1, homePoints: 25, awayPoints: 20, finished: true }, { index: 2, homePoints: 3, awayPoints: 1, finished: false }],
  started: [{ index: 1, homePoints: 0, awayPoints: 0, finished: false, startTime: '2026-11-22T18:00:00Z' }],
  finished: [{ index: 1, homePoints: 25, awayPoints: 20, finished: true }, { index: 2, homePoints: 25, awayPoints: 22, finished: true }]
}
const EVENTS = {
  none: [],
  quiet: ['coin_toss', 'lineup'],
  rally: ['coin_toss', 'lineup', 'rally_start'],
  point: ['lineup', 'point'],
  setStart: ['set_start']
}

let seq = 0
async function addMatch({ kind = {}, sigs = 'none', info = 'none', players = [7, 7], status = 'scheduled', sets = 'none', events = 'none', extra = {} }) {
  const matchId = await db.matches.add({
    status,
    homeTeamId: teams[players[0]],
    awayTeamId: teams[players[1]],
    createdAt: '2026-11-22T17:00:00Z',
    ...kind,
    ...SIGS[sigs],
    ...INFO[info],
    ...extra
  })
  if (SETS[sets].length) await db.sets.bulkAdd(SETS[sets].map(s => ({ matchId, ...s })))
  if (EVENTS[events].length) await db.events.bulkAdd(EVENTS[events].map(type => ({ matchId, setIndex: 1, type, payload: {}, seq: ++seq, ts: '2026-11-22T18:00:00Z' })))
  return db.matches.get(matchId)
}

beforeAll(async () => {
  await db.open()
})
beforeEach(async () => {
  await Promise.all(db.tables.map(t => t.clear()))
  for (const n of [0, 3, 7]) {
    teams[n] = await db.teams.add({ name: `Team ${n}` })
    if (n) await db.players.bulkAdd(Array.from({ length: n }, (_, i) => ({ teamId: teams[n], number: i + 1 })))
  }
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('readHomeMatchStatus = the old matchStatus querier', () => {
  const named = {
    'a restarted test match': { kind: { test: true }, sets: 'initial' },
    'a test match restarted, with a quiet event': { kind: { test: true }, sets: 'initial', events: 'quiet' },
    'a test match with no set yet': { kind: { test: true } },
    'an easy match without signatures, playing': { kind: { test: true, easy: true }, sets: 'playing', events: 'point', status: 'live' },
    'an easy match without signatures, first set': { kind: { test: true, easy: true }, sets: 'initial', events: 'rally', status: 'live' },
    'a signed test match, restarted': { kind: { test: true }, sigs: 'all', info: 'set', sets: 'initial' },
    'setup: players, no signatures': { players: [3, 0] },
    'setup: coach signatures only': { sigs: 'coach', players: [0, 0] },
    'coin toss: all signed, no info': { sigs: 'all' },
    'coin toss: ready, nothing played': { sigs: 'all', info: 'set', sets: 'initial' },
    'coin toss: ready, only the coin toss and line-up recorded': { sigs: 'all', info: 'set', sets: 'initial', events: 'quiet' },
    'recording: ready, a rally started, not live': { sigs: 'all', info: 'set', sets: 'initial', events: 'rally' },
    'recording: ready, a set started (event), not live': { sigs: 'all', info: 'set', events: 'setStart' },
    'recording: ready, a set with a start time': { sigs: 'all', info: 'set', sets: 'started' },
    'recording: live': { sigs: 'all', info: 'set', status: 'live', sets: 'playing', events: 'point' },
    'live but a roster short: coin toss': { sigs: 'all', info: 'set', status: 'live', players: [7, 3], sets: 'playing', events: 'point' },
    'live, info blank: coin toss': { sigs: 'all', info: 'blank', status: 'live', sets: 'playing' },
    'ended: every set finished': { sigs: 'all', info: 'set', status: 'live', sets: 'finished', events: 'point' },
    'ended: final': { sigs: 'all', info: 'set', status: 'final', sets: 'playing' },
    'ended: a stale closed copy': { sigs: 'all', info: 'set', status: 'live', sets: 'playing', extra: { closed_at: '2026-11-21T20:00:00Z' } },
    'not stale: closed but moved': { sigs: 'all', info: 'set', status: 'live', sets: 'playing', extra: { closed_at: '2026-11-21T20:00:00Z', cloudBlock: { code: 'OV_SCORER_MOVED' } } },
    'no data': { players: [0, 0] },
    'no teams at all': { players: [undefined, undefined] }
  }
  it.each(Object.entries(named))('%s', async (_, fixture) => {
    const match = await addMatch(fixture)
    const want = await oracle(match)
    expect(await readHomeMatchStatus(db, match)).toBe(want)
  })

  it('no match: null', async () => {
    expect(await readHomeMatchStatus(db, null)).toBe(oracle(null) && null)
    expect(await readHomeMatchStatus(db, undefined)).toBeNull()
  })

  it('a sweep over the combinations gives the same status', async () => {
    // a fixed pseudo-random sample of every dimension (the full product is too slow on fake-indexeddb)
    const dims = {
      kind: [{}, { test: true }, { test: true, easy: true }],
      sigs: Object.keys(SIGS),
      info: Object.keys(INFO),
      players: [[0, 0], [3, 0], [7, 3], [7, 7]],
      status: ['scheduled', 'live', 'ended', 'final'],
      sets: Object.keys(SETS),
      events: Object.keys(EVENTS)
    }
    let x = 20261122
    const pick = (list) => {
      x = (x * 1103515245 + 12345) % 2147483648
      return list[Math.floor(x / 65536) % list.length] // the high bits: an LCG's low bits repeat
    }
    const seen = new Set()
    for (let i = 0; i < 1200; i++) {
      const fixture = Object.fromEntries(Object.entries(dims).map(([k, list]) => [k, pick(list)]))
      const match = await addMatch(fixture)
      const want = await oracle(match)
      seen.add(want)
      expect(await readHomeMatchStatus(db, match), JSON.stringify(fixture)).toBe(want)
    }
    // the sample reaches every status
    expect([...seen].sort()).toEqual(['Coin toss', 'Match ended', 'Match recording', 'No data', 'Setup', null].sort())
  })
})

describe('what it reads', () => {
  it("a live match's status does not read its events", async () => {
    const match = await addMatch({ sigs: 'all', info: 'set', status: 'live', sets: 'playing', events: 'point' })
    const where = vi.spyOn(db.events, 'where')
    expect(await readHomeMatchStatus(db, match)).toBe('Match recording')
    expect(where).not.toHaveBeenCalled()
  })

  it('an ended match does not read its events either', async () => {
    const match = await addMatch({ sigs: 'all', info: 'set', status: 'live', sets: 'finished', events: 'point' })
    const where = vi.spyOn(db.events, 'where')
    expect(await readHomeMatchStatus(db, match)).toBe('Match ended')
    expect(where).not.toHaveBeenCalled()
  })

  it('a match ready but not started reads its events up to the first activity, not all of them', async () => {
    const match = await addMatch({ sigs: 'all', info: 'set', sets: 'initial', events: 'rally' })
    // the rows each read returned (Dexie's first() is limit(1).toArray())
    const original = db.Collection.prototype.toArray
    const rows = []
    vi.spyOn(db.Collection.prototype, 'toArray').mockImplementation(function (cb) {
      return original.call(this).then(list => { rows.push(list.length); return cb ? cb(list) : list })
    })
    expect(await readHomeMatchStatus(db, match)).toBe('Match recording')
    // the one set, then one event (the match has three)
    expect(rows).toEqual([1, 1])
  })
})
