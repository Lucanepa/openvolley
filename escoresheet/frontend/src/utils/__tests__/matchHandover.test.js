import { describe, it, expect, beforeEach } from 'vitest'
import {
  retireSupersededMatches, retireIfSuperseded, retireStaleGameCopies, takeBackScoring,
  noteScorerMoved, scorerClaimJob, isScorerMoved, SCORER_MOVED, markScorerMoved, setAsideMovedJobs,
  hasUnsentClaim, closeMovedMatches
} from '../matchHandover'

// A Dexie table stand-in: what utils/matchHandover uses of it
function fakeTable(rows = []) {
  const map = new Map(rows.map(r => [r.id, { ...r }]))
  const collection = (pred) => ({
    toArray: async () => [...map.values()].filter(pred).sort((a, b) => a.id - b.id),
    first: async () => [...map.values()].filter(pred)[0]
  })
  return {
    map,
    get: async (id) => map.get(id),
    toArray: async () => [...map.values()],
    add: async (row) => {
      const id = Math.max(0, ...map.keys()) + 1
      map.set(id, { ...row, id })
      return id
    },
    update: async (id, changes) => {
      if (!map.has(id)) return 0
      map.set(id, { ...map.get(id), ...changes })
      return 1
    },
    where: (field) => ({
      equals: (v) => collection(r => r[field] === v),
      anyOf: (...vs) => collection(r => vs.flat().includes(r[field]))
    }),
    filter: (fn) => collection(fn)
  }
}

// 2026-10-20, game 406970: the phone's own copy (cs4qcg) and the PC's match (u2sbmb)
const OWN = 'match_1792518325315_cs4qcg'
const PCS = 'match_1792518507614_u2sbmb'
const takenBlock = (claim) => ({ code: 'OV_GAME_TAKEN', claim: { game_n: 406970, season: 2026, ...claim }, at: 1 })

let db
beforeEach(() => {
  db = {
    matches: fakeTable([
      { id: 1, seed_key: OWN, gameN: 406970, status: 'scheduled', matchInfoConfirmedAt: 'x', cloudBlock: takenBlock({ mine: true, status: 'live' }) },
      { id: 2, seed_key: PCS, gameN: 406970, status: 'live', importedFrom: 'supabase' },
      { id: 3, seed_key: 'match_9_other', gameN: 1234, status: 'scheduled', cloudBlock: takenBlock({ game_n: 1234, mine: true }) }
    ]),
    sync_queue: fakeTable([
      { id: 1, resource: 'match', action: 'insert', status: 'failed', payload: { external_id: OWN } },
      { id: 2, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: `${OWN}:e:1`, match_id: OWN } },
      { id: 3, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: `${PCS}:e:1`, match_id: PCS } },
      { id: 4, resource: 'match', action: 'insert', status: 'sent', payload: { external_id: OWN } }
    ])
  }
})

describe('retiring the refused copy of a game continued in its cloud match', () => {
  it('a join retires the refused copy of the same game: jobs dropped, marked final, kept on the device', async () => {
    const retired = await retireSupersededMatches(db, db.matches.map.get(2))
    expect(retired).toEqual([1])
    expect(db.matches.map.get(1)).toMatchObject({ status: 'final', supersededBy: PCS })
    expect(db.sync_queue.map.get(1).status).toBe('superseded')
    expect(db.sync_queue.map.get(2).status).toBe('superseded')
    expect(db.sync_queue.map.get(3).status).toBe('queued')
    expect(db.sync_queue.map.get(4).status).toBe('sent')
    // another game is left alone
    expect(db.matches.map.get(3).status).toBe('scheduled')
  })

  it('a claim that names another match keeps the copy', async () => {
    db.matches.map.get(1).cloudBlock = takenBlock({ mine: true, external_id: 'match_x_someoneelse' })
    expect(await retireSupersededMatches(db, db.matches.map.get(2))).toEqual([])
    expect(db.matches.map.get(1).status).toBe('scheduled')
  })

  it('a test match never retires anything', async () => {
    db.matches.map.get(2).test = true
    expect(await retireSupersededMatches(db, db.matches.map.get(2))).toEqual([])
  })

  it('the refusal after the join: the copy goes when the joined match is here, open or already final', async () => {
    for (const status of ['live', 'final']) {
      db.matches.map.get(1).status = 'scheduled'
      db.matches.map.get(2).status = status
      expect(await retireIfSuperseded(db, db.matches.map.get(1))).toBe(PCS)
      expect(db.matches.map.get(1).status).toBe('final')
    }
  })

  it('the account closed the game (its copy gone after Close Match): the refused copy goes too', async () => {
    db.matches.map.delete(2)
    db.matches.map.get(1).cloudBlock = takenBlock({ mine: true, status: 'approved' })
    expect(await retireIfSuperseded(db, db.matches.map.get(1))).toBeTruthy()
    expect(db.matches.map.get(1).status).toBe('final')
  })

  it('the game held by another account, or by the own match still scored elsewhere: the notice stays', async () => {
    db.matches.map.delete(2)
    for (const claim of [{ mine: false, status: 'approved' }, { mine: true, status: 'live' }]) {
      db.matches.map.get(1).cloudBlock = takenBlock(claim)
      expect(await retireIfSuperseded(db, db.matches.map.get(1))).toBeNull()
      expect(db.matches.map.get(1).status).toBe('scheduled')
    }
  })

  it('at app start every refused copy is checked again (copies refused before this version)', async () => {
    expect(await retireStaleGameCopies(db)).toBe(1)
    expect(db.matches.map.get(1).status).toBe('final')
    expect(db.matches.map.get(3).status).toBe('scheduled')
  })
})

describe('the scoring device', () => {
  it('the claim job: official matches with a seed key only', () => {
    expect(scorerClaimJob({ seed_key: PCS })).toMatchObject({ resource: 'match', action: 'scorer', payload: { id: PCS }, status: 'queued' })
    expect(scorerClaimJob({ seed_key: PCS, test: true })).toBeNull()
    expect(scorerClaimJob({})).toBeNull()
  })

  // review 2026-10-21: the PC's writes made while the phone scored stayed
  // 'failed' and went out over the phone's score after a take-back
  it('a device that lost the match sets its unsent writes aside (never sent over the other device\'s score)', async () => {
    db.sync_queue.map.set(5, { id: 5, resource: 'set', action: 'update', status: 'failed', last_error: { code: SCORER_MOVED }, payload: { external_id: `${PCS}:s:5`, home_points: 11, away_points: 8 } })
    db.sync_queue.map.set(6, { id: 6, resource: 'user_match', action: 'upsert', status: 'queued', payload: { match_external_id: PCS } })
    db.sync_queue.map.set(7, { id: 7, resource: 'event', action: 'insert', status: 'sending', payload: { external_id: `${PCS}:e:2`, match_id: PCS } })
    const n = await markScorerMoved(db, db.matches.map.get(2), { scorer: { platform: 'android', at: 'T' }, now: 5 })
    expect(n).toBe(2)
    expect(db.sync_queue.map.get(3)).toMatchObject({ status: 'superseded', superseded_by: 'scorer-moved' })
    expect(db.sync_queue.map.get(5)).toMatchObject({ status: 'superseded', superseded_by: 'scorer-moved' })
    // "My Matches" is not scoring; a write in flight is left to its sender
    expect(db.sync_queue.map.get(6).status).toBe('queued')
    expect(db.sync_queue.map.get(7).status).toBe('sending')
    // other matches untouched
    expect(db.sync_queue.map.get(2).status).toBe('queued')
    expect(db.matches.map.get(2)).toMatchObject({ status: 'live', cloudBlock: { code: SCORER_MOVED, scorer: { platform: 'android', at: 'T' }, at: 5 } })
    expect(await setAsideMovedJobs(db, PCS)).toBe(0)
  })

  it('closed on the other device: the local copy is final, the notice stays (no stale scoreboard comes back)', async () => {
    db.matches.map.get(2).cloudBlock = { code: SCORER_MOVED, scorer: { platform: 'android', at: 'T' }, at: 5 }
    await markScorerMoved(db, db.matches.map.get(2), { closed: true, now: 9 })
    expect(db.matches.map.get(2)).toMatchObject({ status: 'final', cloudBlock: { code: SCORER_MOVED, scorer: { platform: 'android', at: 'T' }, at: 5, closed: true } })
  })

  it('at app start a moved match is asked about: closed there, final here', async () => {
    db.matches.map.get(2).cloudBlock = { code: SCORER_MOVED, at: 5 }
    const asked = []
    expect(await closeMovedMatches(db, { check: async (k) => { asked.push(k); return { data: { mine: false, closed: false } } } })).toBe(0)
    expect(db.matches.map.get(2).status).toBe('live')
    expect(await closeMovedMatches(db, { check: async () => ({ error: { network: true } }) })).toBe(0)
    expect(await closeMovedMatches(db, { check: async () => ({ data: { mine: false, closed: true, scorer: { platform: 'android' } } }) })).toBe(1)
    expect(db.matches.map.get(2)).toMatchObject({ status: 'final', cloudBlock: { code: SCORER_MOVED, closed: true } })
    expect(asked).toEqual([PCS])
  })

  it('Take back loads the cloud copy first (the other device\'s score), then the import claims', async () => {
    db.matches.map.get(2).cloudBlock = { code: SCORER_MOVED, scorer: { platform: 'android' } }
    db.matches.map.get(2).gamePin = '583920'
    const cloud = { match: { external_id: PCS, status: 'live' }, sets: [{ index: 1, home_points: 25, away_points: 20, finished: true }], events: [] }
    const fetched = []
    const imported = []
    const r = await takeBackScoring(db, 2, {
      fetchCloud: async (pin, gameN) => { fetched.push([pin, gameN]); return cloud },
      importCloud: async (data) => { imported.push(data); return 42 }
    })
    expect(r).toEqual({ ok: true, matchId: 42, cloud })
    expect(fetched).toEqual([['583920', 406970]])
    expect(imported).toEqual([cloud])
  })

  it('Take back refuses what it cannot do safely: offline, no game PIN, another match, a failed load', async () => {
    const m = db.matches.map.get(2)
    m.cloudBlock = { code: SCORER_MOVED }
    const importCloud = async () => { throw new Error('must not import') }
    expect(await takeBackScoring(db, 2, { fetchCloud: async () => ({}), importCloud })).toEqual({ ok: false, reason: 'noPin' })
    m.gamePin = '583920'
    expect(await takeBackScoring(db, 2, { fetchCloud: async () => ({}), importCloud, online: false })).toEqual({ ok: false, reason: 'offline' })
    expect(await takeBackScoring(db, 2, { fetchCloud: async () => ({ match: { external_id: 'match_x' } }), importCloud })).toEqual({ ok: false, reason: 'otherMatch' })
    expect(await takeBackScoring(db, 2, { fetchCloud: async () => { throw new Error('Match not found') }, importCloud })).toMatchObject({ ok: false, reason: 'failed' })
    expect(await takeBackScoring(db, 2, { fetchCloud: async () => { throw Object.assign(new Error('x'), { network: true }) }, importCloud })).toMatchObject({ ok: false, reason: 'offline' })
    expect(await takeBackScoring(db, 2, { fetchCloud: async () => null, importCloud })).toEqual({ ok: false, reason: 'notFound' })
    // nothing changed here
    expect(db.matches.map.get(2).cloudBlock).toEqual({ code: SCORER_MOVED })
  })

  it('an unsent claim (queued, in flight, backing off) is known; a refused or sent one is not', async () => {
    expect(await hasUnsentClaim(db, PCS)).toBe(false)
    for (const status of ['queued', 'sending', 'error']) {
      db.sync_queue.map.set(9, { id: 9, resource: 'match', action: 'scorer', status, payload: { id: PCS } })
      expect(await hasUnsentClaim(db, PCS)).toBe(true)
      expect(await hasUnsentClaim(db, OWN)).toBe(false)
    }
    for (const status of ['failed', 'sent']) {
      db.sync_queue.map.set(9, { id: 9, resource: 'match', action: 'scorer', status, payload: { id: PCS } })
      expect(await hasUnsentClaim(db, PCS)).toBe(false)
    }
  })

  it('the relay nudge marks the match only when the server answers "not mine"', async () => {
    expect(await noteScorerMoved(db, PCS, { check: async () => ({ data: { mine: true } }) })).toBe(false)
    expect(await noteScorerMoved(db, PCS, { check: async () => ({ data: { mine: null } }) })).toBe(false)
    expect(await noteScorerMoved(db, PCS, { check: async () => ({ error: { status: 0, network: true } }) })).toBe(false)
    expect(db.matches.map.get(2).cloudBlock).toBeUndefined()
    // this device's own claim not answered yet: the nudge is about its predecessor
    db.sync_queue.map.set(9, { id: 9, resource: 'match', action: 'scorer', status: 'queued', payload: { id: PCS } })
    const never = async () => { throw new Error('not asked') }
    expect(await noteScorerMoved(db, PCS, { check: never })).toBe(false)
    db.sync_queue.map.delete(9)
    expect(await noteScorerMoved(db, PCS, { check: async () => ({ data: { mine: false, scorer: { platform: 'android', at: 'T' } } }), now: 5 })).toBe(true)
    expect(db.matches.map.get(2).cloudBlock).toEqual({ code: SCORER_MOVED, claim: null, scorer: { platform: 'android', at: 'T' }, at: 5 })
    // and its unsent writes are set aside
    expect(db.sync_queue.map.get(3).status).toBe('superseded')
  })
})
