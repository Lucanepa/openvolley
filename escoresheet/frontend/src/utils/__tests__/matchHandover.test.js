import { describe, it, expect, beforeEach } from 'vitest'
import {
  retireSupersededMatches, retireIfSuperseded, retireStaleGameCopies, takeBackScoring, requeueScorerMovedJobs,
  noteScorerMoved, scorerClaimJob, isScorerMoved, SCORER_MOVED
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

  it('Take back queues the claim and clears the notice at once', async () => {
    db.matches.map.get(2).cloudBlock = { code: SCORER_MOVED, scorer: { platform: 'android' } }
    expect(isScorerMoved(db.matches.map.get(2))).toBe(true)
    const jobId = await takeBackScoring(db, 2)
    expect(db.sync_queue.map.get(jobId)).toMatchObject({ action: 'scorer', payload: { id: PCS } })
    expect(db.matches.map.get(2).cloudBlock).toBeNull()
  })

  it('after the claim: only the jobs refused as moved, of that match, go again', async () => {
    db.sync_queue.map.get(3).status = 'failed'
    db.sync_queue.map.get(3).last_error = { code: SCORER_MOVED }
    db.sync_queue.map.get(1).last_error = { code: 'OV_GAME_TAKEN' }
    expect(await requeueScorerMovedJobs(db, PCS)).toBe(1)
    expect(db.sync_queue.map.get(3).status).toBe('queued')
    expect(db.sync_queue.map.get(1).status).toBe('failed')
  })

  it('the relay nudge marks the match only when the server answers "not mine"', async () => {
    expect(await noteScorerMoved(db, PCS, { check: async () => ({ data: { mine: true } }) })).toBe(false)
    expect(await noteScorerMoved(db, PCS, { check: async () => ({ data: { mine: null } }) })).toBe(false)
    expect(await noteScorerMoved(db, PCS, { check: async () => ({ error: { status: 0, network: true } }) })).toBe(false)
    expect(db.matches.map.get(2).cloudBlock).toBeUndefined()
    expect(await noteScorerMoved(db, PCS, { check: async () => ({ data: { mine: false, scorer: { platform: 'android', at: 'T' } } }), now: 5 })).toBe(true)
    expect(db.matches.map.get(2).cloudBlock).toEqual({ code: SCORER_MOVED, claim: null, scorer: { platform: 'android', at: 'T' }, at: 5 })
  })
})
