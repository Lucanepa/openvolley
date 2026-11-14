// A correction at the match end after the sheet was signed or approved
// (audit fe-home-options-1, fe-home-options-2). The account approvals are
// bound to the set scores alone, so a removed sanction kept them valid when
// no signature had been drawn, and the server kept its rows: they were undone
// only online, by a call made once, and came back with the next refresh.
// Now any change of the sheet after the first post-match signature or
// approval clears both, and the undo goes through the sync queue.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../../db/db'
import { applyCorrectionPlan, signedAfterMatch } from '../applyCorrectionPlan'
import { planRemoveGroup, emptyPlan } from '../../../domain/manualCorrections'
import { resultKey, slotComplete } from '../../../domain/accountApproval'
import { APPROVAL_RESOURCE } from '../../../utils/syncIds'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from '../../../domain/__tests__/fixtures/correctionsMatch'

const SEED = 'match_1759740000000_so0001'
const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']

async function seed({ drawn = false, approvals = true, test = false } = {}) {
  await db.open()
  await Promise.all(db.tables.map(t => t.clear()))
  const { events, sets } = buildMatch({
    sets: [
      { points: pointsFor(25, 22), finished: true, extras: [{ at: 6, type: 'sanction', payload: { team: 'home', type: 'penalty', playerType: 'player', playerNumber: 5 } }] },
      { points: pointsFor(25, 20), finished: true },
      { points: pointsFor(25, 18), finished: true }
    ]
  })
  const key = resultKey(sets)
  const approval = (slot, id) => ({ id, short_id: id.slice(0, 8).toUpperCase(), slot, name: `Official ${slot}`, approved_at: '2026-11-09T20:00:00Z', result_key: key })
  const matchId = await db.matches.add({
    ...MATCH, id: undefined, status: 'ended', seed_key: SEED, test, remarks: '',
    ...(approvals ? { accountApprovals: { referee1: approval('referee1', IDS[0]), referee2: approval('referee2', IDS[1]), scorer: approval('scorer', IDS[2]) } } : {}),
    ...(drawn ? { homePostGameCaptainSignature: 'data:a', awayPostGameCaptainSignature: 'data:b' } : {})
  })
  for (const s of sets) await db.sets.add({ ...s, id: undefined, matchId })
  for (const e of events) await db.events.add({ ...e, id: undefined, matchId })
  return { matchId, events: await db.events.where('matchId').equals(matchId).toArray() }
}

const ctx = (matchId) => ({ match: MATCH, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, matchId, mode: 'review' })
const undoJobs = async () => (await db.sync_queue.toArray()).filter(j => j.resource === APPROVAL_RESOURCE)

describe('a correction after the sheet was approved with accounts', () => {
  beforeEach(async () => { await db.open() })

  it('a removed penalty clears the approvals although nothing was drawn, and queues their undo', async () => {
    const { matchId, events } = await seed()
    const plan = planRemoveGroup(events, events.find(e => e.type === 'sanction').id, ctx(matchId))
    const res = await applyCorrectionPlan(plan, { matchId, db, mode: 'review' })
    expect(res.signaturesCleared).toBe(true)
    const match = await db.matches.get(matchId)
    expect(match.accountApprovals).toBeNull()
    const sets = await db.sets.where('matchId').equals(matchId).toArray()
    for (const role of ['ref1', 'ref2', 'scorer']) expect(slotComplete(match, role, sets)).toBe(false)
    // the server's rows go through the sync queue (retried offline), one job each
    const jobs = await undoJobs()
    expect(jobs.map(j => [j.action, j.status, j.payload.id, j.payload.match_external_id])).toEqual(
      IDS.map(id => ['undo', 'queued', id, SEED])
    )
    // and the cleared signatures with them
    const sigJob = (await db.sync_queue.toArray()).find(j => j.resource === 'match' && j.payload?.signatures)
    expect(sigJob.payload.signatures).toMatchObject({ scorer: null, ref1: null, ref2: null })
  })

  it('offline with drawn signatures: the undo is queued, not left to a call made only online', async () => {
    const { matchId, events } = await seed({ drawn: true })
    const plan = planRemoveGroup(events, events.find(e => e.type === 'sanction').id, ctx(matchId))
    await applyCorrectionPlan(plan, { matchId, db, mode: 'review' })
    expect((await db.matches.get(matchId)).homePostGameCaptainSignature).toBeNull()
    expect((await undoJobs()).map(j => j.payload.id)).toEqual(IDS)
  })

  it('a test match clears locally and queues nothing', async () => {
    const { matchId, events } = await seed({ test: true })
    const plan = planRemoveGroup(events, events.find(e => e.type === 'sanction').id, ctx(matchId))
    const res = await applyCorrectionPlan(plan, { matchId, db, mode: 'review' })
    expect(res.signaturesCleared).toBe(true)
    expect(await db.sync_queue.count()).toBe(0)
  })

  it('nothing signed and nothing approved: no clearing, no undo', async () => {
    const { matchId, events } = await seed({ approvals: false })
    const plan = planRemoveGroup(events, events.find(e => e.type === 'sanction').id, ctx(matchId))
    const res = await applyCorrectionPlan(plan, { matchId, db, mode: 'review' })
    expect(res.signaturesCleared).toBe(false)
    expect(await undoJobs()).toHaveLength(0)
  })

  it('signedAfterMatch: a drawn post-match signature or an account approval', () => {
    expect(signedAfterMatch(null)).toBe(false)
    expect(signedAfterMatch({ homeCaptainSignature: 'data:pre' })).toBe(false)
    expect(signedAfterMatch({ ref1Signature: 'data:x' })).toBe(true)
    expect(signedAfterMatch({ accountApprovals: { referee1: { id: IDS[0] } } })).toBe(true)
    expect(signedAfterMatch({ accountApprovals: {} })).toBe(false)
  })
})

describe('the correction log marks what was changed after the match', () => {
  beforeEach(async () => { await db.open() })

  it('a correction at the match end is marked afterMatch, one during the match is not', async () => {
    const { matchId, events } = await seed({ approvals: false })
    const sanction = events.find(e => e.type === 'sanction')
    await applyCorrectionPlan(planRemoveGroup(events, sanction.id, ctx(matchId)), { matchId, db, mode: 'review' })
    expect((await db.matches.get(matchId)).manualChanges.at(-1)).toMatchObject({ category: 'correction', afterMatch: true })

    const { matchId: m2, events: e2 } = await seed({ approvals: false })
    await applyCorrectionPlan(planRemoveGroup(e2, e2.find(e => e.type === 'sanction').id, { ...ctx(m2), mode: 'live' }), { matchId: m2, db, mode: 'live' })
    expect((await db.matches.get(m2)).manualChanges.at(-1).afterMatch).toBeUndefined()
  })

  it('a remark written at the match end before anyone signed is no correction of the match', async () => {
    const { matchId } = await seed({ approvals: false })
    const p = emptyPlan()
    p.remarkAdd = ['Team B protests the line-up check.']
    p.log = { action: 'addRemark', setIndex: null, team: null, before: null, after: p.remarkAdd[0], text: 'Remark added' }
    await applyCorrectionPlan(p, { matchId, db, mode: 'review' })
    expect((await db.matches.get(matchId)).manualChanges.at(-1).afterMatch).toBeUndefined()
  })

  it('the same remark after the sheet was signed clears the signatures and is marked', async () => {
    const { matchId } = await seed({ drawn: true, approvals: false })
    const p = emptyPlan()
    p.remarkAdd = ['Team B protests the line-up check.']
    p.log = { action: 'addRemark', setIndex: null, team: null, before: null, after: p.remarkAdd[0], text: 'Remark added' }
    const res = await applyCorrectionPlan(p, { matchId, db, mode: 'review' })
    expect(res.signaturesCleared).toBe(true)
    expect((await db.matches.get(matchId)).manualChanges.at(-1).afterMatch).toBe(true)
  })
})
