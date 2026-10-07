// The corrections executor against the real app database (Dexie 4 on
// fake-indexeddb): one transaction writes the rows, the derived set score,
// the match row (sanction flags, remarks, correction log, signatures) and
// the sync jobs.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../../db/db'
import { applyCorrectionPlan } from '../applyCorrectionPlan'
import {
  scoreTimeline, planAddTimeout, planAddSanction, planAdjustFinalScore, planRemoveGroup, planAddSubstitution, courtAt
} from '../../../domain/manualCorrections'
import { scoreBeforeEvent } from '../../../domain/describe'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from '../../../domain/__tests__/fixtures/correctionsMatch'

const SEED = 'match_1759740000000_ab12cd'

async function seed({ signed = false, test = false } = {}) {
  await db.open()
  await Promise.all(db.tables.map(t => t.clear()))
  const { events, sets } = buildMatch({
    sets: [{ points: pointsFor(25, 22), finished: true }, { points: pointsFor(25, 20), finished: true }]
  })
  const matchId = await db.matches.add({
    ...MATCH, id: undefined, seed_key: SEED, test, remarks: 'Existing remark',
    ...(signed ? { scorerSignature: 'data:sig', ref1Signature: 'data:sig' } : {})
  })
  for (const s of sets) await db.sets.add({ ...s, id: undefined, matchId })
  for (const e of events) await db.events.add({ ...e, id: undefined, matchId })
  // a queued insert job of an event that is going to be removed
  const all = await db.events.where('matchId').equals(matchId).toArray()
  return { matchId, events: all, sets: await db.sets.where('matchId').equals(matchId).toArray() }
}

const ctx = (matchId) => ({ match: MATCH, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, matchId, mode: 'review' })

describe('applyCorrectionPlan', () => {
  beforeEach(async () => { await db.open() })

  it('adds a time-out at a past score: renumbered rows, log entry, upsert jobs', async () => {
    const { matchId, events } = await seed()
    const tl = scoreTimeline(events, 1)
    const at = tl.findIndex(x => x.home === 12)
    const away = tl[at].away
    const plan = planAddTimeout(events, { setIndex: 1, team: 'away', at }, ctx(matchId))
    const res = await applyCorrectionPlan(plan, { matchId, db, mode: 'review' })
    expect(res.addedIds).toHaveLength(1)
    const after = await db.events.where('matchId').equals(matchId).toArray()
    const to = after.find(e => e.id === res.addedIds[0])
    expect(scoreBeforeEvent(after, to)).toEqual({ home: 12, away })
    expect(after).toHaveLength(events.length + 1)

    const match = await db.matches.get(matchId)
    expect(match.manualChanges.at(-1)).toMatchObject({ action: 'addTimeout', setIndex: 1, team: 'away', by: 'scorer' })
    expect(match.manualChanges.at(-1).text).toBe(`Added: Time-out · Volley Bern (B) · Set 1 · B ${away}:12 A (entered after the match)`)

    const jobs = await db.sync_queue.toArray()
    const inserts = jobs.filter(j => j.resource === 'event' && j.action === 'insert')
    // the new row + every renumbered row is re-sent (upsert on external_id)
    expect(inserts.length).toBe(1 + plan.update.length)
    expect(inserts.every(j => j.payload.external_id.startsWith(`${SEED}:e:`))).toBe(true)
    expect(jobs.some(j => j.resource === 'match' && j.action === 'update' && j.payload.manual_changes)).toBe(true)
  })

  it('a final-score correction re-derives the set row and set_end, clears signatures at the match end', async () => {
    const { matchId, events, sets } = await seed({ signed: true })
    const plan = planAdjustFinalScore(events, sets, { setIndex: 1, team: 'away', delta: 1 }, ctx(matchId))
    expect(plan.error).toBeUndefined()
    const res = await applyCorrectionPlan(plan, { matchId, db, mode: 'review' })
    expect(res.signaturesCleared).toBe(true)
    const set1 = (await db.sets.where('matchId').equals(matchId).toArray()).find(s => s.index === 1)
    expect([set1.homePoints, set1.awayPoints]).toEqual([25, 23])
    const end = (await db.events.where('matchId').equals(matchId).toArray()).find(e => e.type === 'set_end' && e.setIndex === 1)
    expect([end.payload.homePoints, end.payload.awayPoints]).toEqual([25, 23])
    const match = await db.matches.get(matchId)
    expect(match.scorerSignature).toBeNull()
    expect(match.ref1Signature).toBeNull()
    const setJob = (await db.sync_queue.toArray()).find(j => j.resource === 'set' && j.action === 'update')
    expect(setJob.payload).toMatchObject({ home_points: 25, away_points: 23 })
  })

  it('removes a group: delete jobs, queued inserts of the removed rows dropped', async () => {
    const { matchId, events } = await seed()
    // the loser's last point of set 2 (25:20 -> 25:19 stays a possible result)
    const lastPoint = events.filter(e => e.type === 'point' && e.setIndex === 2 && e.payload.team === 'away').sort((a, b) => b.seq - a.seq)[0]
    await db.sync_queue.add({ resource: 'event', action: 'insert', status: 'queued', payload: { external_id: `${SEED}:e:${lastPoint.id}`, match_id: SEED } })
    const plan = planRemoveGroup(events, lastPoint.id, ctx(matchId))
    await applyCorrectionPlan(plan, { matchId, db, mode: 'review' })
    const jobs = await db.sync_queue.toArray()
    expect(jobs.some(j => j.action === 'insert' && j.payload.external_id === `${SEED}:e:${lastPoint.id}`)).toBe(false)
    const deletes = jobs.filter(j => j.resource === 'event' && j.action === 'delete').map(j => j.payload.external_id)
    expect(deletes).toContain(`${SEED}:e:${lastPoint.id}`)
    const set2 = (await db.sets.where('matchId').equals(matchId).toArray()).find(s => s.index === 2)
    expect([set2.homePoints, set2.awayPoints]).toEqual([25, 19])
  })

  it('writes the sanction flags and the automatic remark; a test match queues nothing', async () => {
    const { matchId, events } = await seed({ test: true })
    let plan = planAddSanction(events, { setIndex: 1, team: 'home', type: 'delay_warning', at: 5 }, ctx(matchId))
    await applyCorrectionPlan(plan, { matchId, db, mode: 'review' })
    let match = await db.matches.get(matchId)
    expect(match.sanctions).toMatchObject({ delayWarningHome: true, improperRequestHome: false })

    const now = await db.events.where('matchId').equals(matchId).toArray()
    const tl = scoreTimeline(now, 2)
    const at = tl.findIndex(x => x.home === 10 && x.away === 8)
    const out = courtAt(now, 2, 'away', at).lineup.IV
    plan = planAddSubstitution(now, { setIndex: 2, team: 'away', playerOut: out, playerIn: 7, at, exceptional: true, reason: 'illness' }, ctx(matchId))
    await applyCorrectionPlan(plan, { matchId, db, mode: 'review' })
    match = await db.matches.get(matchId)
    expect(match.remarks).toBe(`Existing remark\nTeam B, Set 2, Result 8:10: player no. ${out} is exceptionally substituted by player no. 7 due to illness.`)
    expect(await db.sync_queue.count()).toBe(0)
  })
})
