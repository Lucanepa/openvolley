// A correction at the match end after the sheet was signed (audit
// fe-home-options-1, fe-home-options-2): any change of the sheet after the
// first post-match signature clears the signatures, here and on the server.
// (Approval with a PIN was removed 27.11.2026: officials sign by hand.)
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../../db/db'
import { applyCorrectionPlan, signedAfterMatch } from '../applyCorrectionPlan'
import { planRemoveGroup, emptyPlan } from '../../../domain/manualCorrections'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from '../../../domain/__tests__/fixtures/correctionsMatch'

const SEED = 'match_1759740000000_so0001'

async function seed({ drawn = false, test = false } = {}) {
  await db.open()
  await Promise.all(db.tables.map(t => t.clear()))
  const { events, sets } = buildMatch({
    sets: [
      { points: pointsFor(25, 22), finished: true, extras: [{ at: 6, type: 'sanction', payload: { team: 'home', type: 'penalty', playerType: 'player', playerNumber: 5 } }] },
      { points: pointsFor(25, 20), finished: true },
      { points: pointsFor(25, 18), finished: true }
    ]
  })
  const matchId = await db.matches.add({
    ...MATCH, id: undefined, status: 'ended', seed_key: SEED, test, remarks: '',
    ...(drawn ? { homePostGameCaptainSignature: 'data:a', awayPostGameCaptainSignature: 'data:b' } : {})
  })
  for (const s of sets) await db.sets.add({ ...s, id: undefined, matchId })
  for (const e of events) await db.events.add({ ...e, id: undefined, matchId })
  return { matchId, events: await db.events.where('matchId').equals(matchId).toArray() }
}

const ctx = (matchId) => ({ match: MATCH, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, matchId, mode: 'review' })

describe('a correction after the sheet was signed', () => {
  beforeEach(async () => { await db.open() })

  it('a removed penalty clears the post-match signatures and queues the cleared ones', async () => {
    const { matchId, events } = await seed({ drawn: true })
    const plan = planRemoveGroup(events, events.find(e => e.type === 'sanction').id, ctx(matchId))
    const res = await applyCorrectionPlan(plan, { matchId, db, mode: 'review' })
    expect(res.signaturesCleared).toBe(true)
    expect((await db.matches.get(matchId)).homePostGameCaptainSignature).toBeNull()
    const sigJob = (await db.sync_queue.toArray()).find(j => j.resource === 'match' && j.payload?.signatures)
    expect(sigJob.payload.signatures).toMatchObject({ scorer: null, ref1: null, ref2: null })
    expect((await db.sync_queue.toArray()).some(j => j.resource === 'approval')).toBe(false)
  })

  it('a test match clears locally and queues nothing', async () => {
    const { matchId, events } = await seed({ drawn: true, test: true })
    const plan = planRemoveGroup(events, events.find(e => e.type === 'sanction').id, ctx(matchId))
    const res = await applyCorrectionPlan(plan, { matchId, db, mode: 'review' })
    expect(res.signaturesCleared).toBe(true)
    expect(await db.sync_queue.count()).toBe(0)
  })

  it('nothing signed: no clearing', async () => {
    const { matchId, events } = await seed()
    const plan = planRemoveGroup(events, events.find(e => e.type === 'sanction').id, ctx(matchId))
    const res = await applyCorrectionPlan(plan, { matchId, db, mode: 'review' })
    expect(res.signaturesCleared).toBe(false)
  })

  it('signedAfterMatch: a drawn post-match signature only', () => {
    expect(signedAfterMatch(null)).toBe(false)
    expect(signedAfterMatch({ homeCaptainSignature: 'data:pre' })).toBe(false)
    expect(signedAfterMatch({ ref1Signature: 'data:x' })).toBe(true)
    // an account approval an older version stored no longer counts
    expect(signedAfterMatch({ accountApprovals: { referee1: { id: 'a' } } })).toBe(false)
  })
})

describe('the correction log marks what was changed after the match', () => {
  beforeEach(async () => { await db.open() })

  it('a correction at the match end is marked afterMatch, one during the match is not', async () => {
    const { matchId, events } = await seed()
    const sanction = events.find(e => e.type === 'sanction')
    await applyCorrectionPlan(planRemoveGroup(events, sanction.id, ctx(matchId)), { matchId, db, mode: 'review' })
    expect((await db.matches.get(matchId)).manualChanges.at(-1)).toMatchObject({ category: 'correction', afterMatch: true })

    const { matchId: m2, events: e2 } = await seed()
    await applyCorrectionPlan(planRemoveGroup(e2, e2.find(e => e.type === 'sanction').id, { ...ctx(m2), mode: 'live' }), { matchId: m2, db, mode: 'live' })
    expect((await db.matches.get(m2)).manualChanges.at(-1).afterMatch).toBeUndefined()
  })

  it('a remark written at the match end before anyone signed is no correction of the match', async () => {
    const { matchId } = await seed()
    const p = emptyPlan()
    p.remarkAdd = ['Team B protests the line-up check.']
    p.log = { action: 'addRemark', setIndex: null, team: null, before: null, after: p.remarkAdd[0], text: 'Remark added' }
    await applyCorrectionPlan(p, { matchId, db, mode: 'review' })
    expect((await db.matches.get(matchId)).manualChanges.at(-1).afterMatch).toBeUndefined()
  })

  it('the same remark after the sheet was signed clears the signatures and is marked', async () => {
    const { matchId } = await seed({ drawn: true })
    const p = emptyPlan()
    p.remarkAdd = ['Team B protests the line-up check.']
    p.log = { action: 'addRemark', setIndex: null, team: null, before: null, after: p.remarkAdd[0], text: 'Remark added' }
    const res = await applyCorrectionPlan(p, { matchId, db, mode: 'review' })
    expect(res.signaturesCleared).toBe(true)
    expect((await db.matches.get(matchId)).manualChanges.at(-1).afterMatch).toBe(true)
  })
})
