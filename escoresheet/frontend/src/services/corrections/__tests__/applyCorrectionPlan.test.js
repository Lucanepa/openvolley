// The corrections executor against the real app database (Dexie 4 on
// fake-indexeddb): one transaction writes the rows, the derived set score,
// the match row (sanction flags, remarks, correction log, signatures) and
// the sync jobs.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../../db/db'
import { applyCorrectionPlan, CORRECTION_REASON } from '../applyCorrectionPlan'
import { eventHistorySettled } from '../../../db/eventHistory'
import { LOCAL_ONLY_EVENT_TYPES } from '../../../domain/eventRevisions'
import {
  scoreTimeline, planAddTimeout, planAddSanction, planAdjustFinalScore, planRemoveGroup, planAddSubstitution, courtAt,
  planRenumberPlayer, planCoinToss
} from '../../../domain/manualCorrections'
import { referencedPlayerNumbers } from '../../../domain/roster'
import { getStartingLineup } from '../../../../scoresheet_pdf/utils/scoresheetModel'
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

const settle = async () => {
  await new Promise(r => setTimeout(r, 20))
  await eventHistorySettled()
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

  // Stress test 2026-10-25 (correction-clears-signatures-only-locally): the
  // signatures were cleared on the device only; the server kept all of them,
  // attached to the corrected sheet
  it('signatures cleared by a correction are cleared on the server too, the pre-match ones kept', async () => {
    const { matchId, events, sets } = await seed({ signed: true })
    await db.matches.update(matchId, { homeCoachSignature: 'data:coach' })
    const plan = planAdjustFinalScore(events, sets, { setIndex: 1, team: 'away', delta: 1 }, ctx(matchId))
    const res = await applyCorrectionPlan(plan, { matchId, db, mode: 'review' })
    expect(res.signaturesCleared).toBe(true)
    const job = (await db.sync_queue.toArray()).find(j => j.resource === 'match' && j.action === 'update' && j.payload.signatures)
    expect(job?.payload.signatures).toMatchObject({
      home_coach: 'data:coach',
      home_captain_post_game: null, away_captain_post_game: null, asst_scorer: null, scorer: null, ref2: null, ref1: null
    })
  })

  it('a correction that leaves the signatures alone sends none', async () => {
    const { matchId, events } = await seed({ signed: true })
    const tl = scoreTimeline(events, 1)
    const plan = planAddTimeout(events, { setIndex: 1, team: 'away', at: tl.findIndex(x => x.home === 12) }, ctx(matchId))
    const res = await applyCorrectionPlan(plan, { matchId, db, mode: 'live' })
    expect(res.signaturesCleared).toBeFalsy()
    expect((await db.sync_queue.toArray()).some(j => j.resource === 'match' && j.payload.signatures)).toBe(false)
  })

  it('removes a group: one void revision per removed row, no delete job, queued inserts of the removed rows dropped', async () => {
    const { matchId, events } = await seed()
    // the loser's last point of set 2 (25:20 -> 25:19 stays a possible result)
    const lastPoint = events.filter(e => e.type === 'point' && e.setIndex === 2 && e.payload.team === 'away').sort((a, b) => b.seq - a.seq)[0]
    await db.sync_queue.add({ resource: 'event', action: 'insert', status: 'queued', payload: { external_id: `${SEED}:e:${lastPoint.id}`, match_id: SEED } })
    const plan = planRemoveGroup(events, lastPoint.id, ctx(matchId))
    await applyCorrectionPlan(plan, { matchId, db, mode: 'review' })
    await settle()
    const jobs = await db.sync_queue.toArray()
    expect(jobs.some(j => j.action === 'insert' && j.payload.external_id === `${SEED}:e:${lastPoint.id}`)).toBe(false)
    // the server keeps the row, voided: never a hard delete
    expect(jobs.filter(j => j.resource === 'event' && j.action === 'delete')).toEqual([])
    const voids = jobs.filter(j => j.resource === 'event' && j.action === 'void')
    // (rally_start / replay rows never reach the server: their history stays local)
    const sent = plan.remove.filter(id => !LOCAL_ONLY_EVENT_TYPES.includes(events.find(e => e.id === id).type))
    expect(sent.length).toBeGreaterThan(0)
    expect(voids.map(j => j.payload.external_id).sort()).toEqual(sent.map(id => `${SEED}:e:${id}`).sort())
    expect(voids.every(j => j.payload.reason === CORRECTION_REASON && j.payload.op === 'void')).toBe(true)
    // one history row per removed row, one action id for the whole correction
    const hist = await db.event_history.where('matchId').equals(matchId).toArray()
    const voided = hist.filter(h => h.op === 'void')
    expect(voided.map(h => h.eventId).sort()).toEqual([...plan.remove].sort())
    expect(new Set(hist.map(h => h.actionId)).size).toBe(1)
    expect(hist.every(h => h.reason === 'correction')).toBe(true)
    const set2 = (await db.sets.where('matchId').equals(matchId).toArray()).find(s => s.index === 2)
    expect([set2.homePoints, set2.awayPoints]).toEqual([25, 19])
  })

  it('every edited row of a correction is an edit revision with the reason correction', async () => {
    const { matchId, events } = await seed()
    const tl = scoreTimeline(events, 1)
    const at = tl.findIndex(x => x.home === 12)
    const plan = planAddTimeout(events, { setIndex: 1, team: 'away', at }, ctx(matchId))
    expect(plan.update.length).toBeGreaterThan(0)
    await applyCorrectionPlan(plan, { matchId, db, mode: 'review' })
    await settle()
    const hist = await db.event_history.where('matchId').equals(matchId).toArray()
    const edits = hist.filter(h => h.op === 'edit')
    expect(edits.map(h => h.eventId).sort()).toEqual(plan.update.map(u => u.id).sort())
    expect(edits.every(h => h.reason === 'correction')).toBe(true)
    const jobs = (await db.sync_queue.toArray()).filter(j => j.resource === 'event' && j.action === 'edit')
    expect(jobs).toHaveLength(edits.filter(h => !LOCAL_ONLY_EVENT_TYPES.includes(h.type)).length)
    // the renumbered seq reaches the server with the edit
    const first = plan.update.find(u => !LOCAL_ONLY_EVENT_TYPES.includes(events.find(e => e.id === u.id).type))
    const job = jobs.find(j => j.payload.external_id === `${SEED}:e:${first.id}`)
    expect(job.payload.after.seq).toBe(first.changes.seq)
    expect(job.payload.reason).toBe('correction')
  })

  it('a correction does not drop the void jobs of earlier undos', async () => {
    const { matchId, events } = await seed()
    const lastPoint = events.filter(e => e.type === 'point' && e.setIndex === 2 && e.payload.team === 'away').sort((a, b) => b.seq - a.seq)[0]
    const earlierVoid = { resource: 'event', action: 'void', status: 'queued', payload: { external_id: `${SEED}:e:${lastPoint.id}`, op: 'void', rev_uid: 'r-1', reason: 'undo' } }
    await db.sync_queue.add(earlierVoid)
    await applyCorrectionPlan(planRemoveGroup(events, lastPoint.id, ctx(matchId)), { matchId, db, mode: 'review' })
    await settle()
    const voids = (await db.sync_queue.toArray()).filter(j => j.action === 'void' && j.payload.external_id === `${SEED}:e:${lastPoint.id}`)
    expect(voids.map(j => j.payload.reason).sort()).toEqual(['correction', 'undo'])
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

  it('a removed point that takes the live set 5 back below 8 undoes the court switch', async () => {
    await db.open()
    await Promise.all(db.tables.map(t => t.clear()))
    const { events, sets } = buildMatch({
      sets: [
        { index: 1, points: pointsFor(25, 20), finished: true },
        { index: 2, points: pointsFor(25, 20), finished: true },
        { index: 3, points: pointsFor(20, 25), finished: true },
        { index: 4, points: pointsFor(20, 25), finished: true },
        { index: 5, points: 'HHHHHHHHA', finished: false }
      ]
    })
    const matchId = await db.matches.add({ ...MATCH, id: undefined, status: 'live', seed_key: SEED, set5CourtSwitched: true })
    for (const s of sets) await db.sets.add({ ...s, id: undefined, matchId })
    for (const e of events) await db.events.add({ ...e, id: undefined, matchId })
    const all = await db.events.where('matchId').equals(matchId).toArray()
    const eighth = all.filter(e => e.type === 'point' && e.setIndex === 5 && e.payload.team === 'home').sort((a, b) => a.seq - b.seq)[7]
    const plan = planRemoveGroup(all, eighth.id, { ...ctx(matchId), mode: 'live', liveSetIndex: 5 })
    expect(plan.error).toBeUndefined()
    await applyCorrectionPlan(plan, { matchId, db, mode: 'live' })
    const match = await db.matches.get(matchId)
    expect(match.set5CourtSwitched).toBe(false)
    const set5 = (await db.sets.where('matchId').equals(matchId).toArray()).find(s => s.index === 5)
    expect([set5.homePoints, set5.awayPoints]).toEqual([7, 1])
  })

  it('a renumbered player: roster row, every event, remark line in place, game captain, cloud roster and log in one write', async () => {
    await db.open()
    await Promise.all(db.tables.map(t => t.clear()))
    const remark = 'Team A, Set 1, Result 9:6: player no. 5 is exceptionally substituted by player no. 7 due to injury.'
    const { events, sets } = buildMatch({
      sets: [{
        points: pointsFor(25, 20),
        finished: true,
        extras: [
          { at: 3, type: 'sanction', payload: { team: 'home', type: 'warning', playerType: 'player', playerNumber: 5 } },
          { at: 15, type: 'substitution', payload: { team: 'home', playerOut: 5, playerIn: 7, isExceptional: true, autoRemark: remark } }
        ]
      }]
    })
    const homeTeamId = await db.teams.add({ name: 'VC Smash' })
    const awayTeamId = await db.teams.add({ name: 'Volley Bern' })
    const matchId = await db.matches.add({
      ...MATCH, id: undefined, seed_key: SEED, homeTeamId, awayTeamId, homeCourtCaptain: 5,
      remarks: `First line\n${remark}\nLast line`
    })
    for (const s of sets) await db.sets.add({ ...s, id: undefined, matchId })
    for (const e of events) await db.events.add({ ...e, id: undefined, matchId })
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) await db.players.add({ teamId: homeTeamId, number: n, firstName: 'P', lastName: `Home${n}`, name: `Home${n} P` })
    for (const n of [11, 12, 13, 14, 15, 16]) await db.players.add({ teamId: awayTeamId, number: n, name: `Away${n}` })
    const home = await db.players.where('teamId').equals(homeTeamId).toArray()
    const away = await db.players.where('teamId').equals(awayTeamId).toArray()
    const all = await db.events.where('matchId').equals(matchId).toArray()
    const match0 = await db.matches.get(matchId)
    const five = home.find(p => p.number === 5)

    const plan = planRenumberPlayer(all, { team: 'home', playerId: five.id, to: 17 }, { ...ctx(matchId), match: match0, players: { home, away } })
    expect(plan.error).toBeUndefined()
    await applyCorrectionPlan(plan, { matchId, db, mode: 'review' })
    await settle()

    expect((await db.players.get(five.id)).number).toBe(17)
    const after = await db.events.where('matchId').equals(matchId).toArray()
    expect(referencedPlayerNumbers(after, 'home').has('5')).toBe(false)
    expect(getStartingLineup(after, 1, 'home')).toEqual(['1', '2', '3', '4', '17', '6'])
    const match = await db.matches.get(matchId)
    expect(match.homeCourtCaptain).toBe(17)
    // the line stays where it was, rewritten
    expect(match.remarks).toBe(`First line\n${remark.replace('no. 5', 'no. 17')}\nLast line`)
    expect(match.manualChanges.at(-1)).toMatchObject({ action: 'renumberPlayer', text: 'Player #5 of VC Smash renumbered to #17 (entered after the match)' })

    const jobs = await db.sync_queue.toArray()
    const matchJob = jobs.find(j => j.resource === 'match' && j.action === 'update' && j.payload.players_home)
    expect(matchJob.payload.players_home.map(p => p.number)).toEqual([1, 2, 3, 4, 6, 7, 8, 17])
    expect(matchJob.payload.players_away).toBeUndefined()
    expect(matchJob.payload.manual_changes.at(-1).text).toMatch(/renumbered to #17/)
    // every rewritten event reaches the server: an upsert and an edit revision
    const upserts = new Set(jobs.filter(j => j.resource === 'event' && j.action === 'insert').map(j => j.payload.external_id))
    for (const u of plan.update) expect(upserts.has(`${SEED}:e:${u.id}`)).toBe(true)
    expect(jobs.some(j => j.resource === 'event' && j.action === 'edit' && j.payload.reason === 'correction')).toBe(true)
  })

  it('a corrected first serve rebuilds the rotations on the device and queues the coin toss for the cloud', async () => {
    const { matchId, events } = await seed()
    const match0 = await db.matches.get(matchId)
    const plan = planCoinToss(events, { firstServe: 'away' }, { ...ctx(matchId), match: match0 })
    expect(plan.error).toBeUndefined()
    expect(plan.update.filter(u => events.find(e => e.id === u.id)?.type === 'lineup').length).toBeGreaterThan(10)
    await applyCorrectionPlan(plan, { matchId, db, mode: 'review' })
    const match = await db.matches.get(matchId)
    expect(match).toMatchObject({ firstServe: 'away', coinTossServeA: false, coinTossServeB: true })
    const ct = (await db.events.where('matchId').equals(matchId).toArray()).find(e => e.type === 'coin_toss')
    expect(ct.payload.firstServe).toBe('away')
    const job = (await db.sync_queue.toArray()).find(j => j.resource === 'match' && j.payload.coin_toss)
    expect(job.payload.coin_toss).toEqual({ team_a: 'home', team_b: 'away', serve_a: false, confirmed: true, first_serve: 'away' })
    expect(match.manualChanges.at(-1).text).toBe('Coin toss corrected: Team A is VC Smash, Volley Bern (B) serves first (entered after the match)')
  })
})
