// Property test of chained corrections (audit round 3, LOG-05 / LOG-16): random
// chains of corrections, as the correction board stages them (each planned
// on the draft the previous ones made, a penalty given now with its point as
// one change), checked on every seed:
//  A. the combined plan (what Save writes) gives the draft the scorer reviewed;
//  B. the rebuild is a fixed point (recomputeMatch on the result changes nothing);
//  C. every penalty link (point.payload.penaltySeq) names a point-awarding
//     sanction of the opponent in the same set; no orphaned N.x row; one row
//     per base seq.
// C failed on 8 of 300 seeds before LOG-05 / LOG-16: a penalty moved to
// another set left its point naming a seq of the other set, and a penalty
// point given to the sanctioned team kept its link.
import { describe, it, expect } from 'vitest'
import {
  planAddTimeout, planAddSanction, planAddSubstitution, planMoveEvent, planRemoveEntry, planSetPointTeam,
  planEditEvent, planAddPoint, planRemovePoint, planRemoveSanction, scoreTimeline, courtAt, applyPlanToEvents
} from '../manualCorrections'
import { baseDraft, applyStep, combinedPlan, buildDraft } from '../correctionDraft'
import { recomputeMatch } from '../recompute'
import { awardsPoint } from '../sanctions'
import { compareBySeq } from '../describe'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from './fixtures/correctionsMatch'

// seeded random numbers (mulberry32): every run checks the same chains
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SEEDS = 300
const LIVE = { ...MATCH, status: 'live' }
const pick = (rnd, list) => list[Math.floor(rnd() * list.length)]
const setOf = (e) => e?.setIndex ?? 1
const norm = (events) => [...events].sort(compareBySeq).map(e => JSON.stringify([e.type, setOf(e), e.seq, e.payload]))

function randomMatch(rnd) {
  const loser = Math.floor(rnd() * 23)
  const s1 = rnd() < 0.5 ? pointsFor(25, loser) : pointsFor(loser, 25)
  const h = Math.floor(rnd() * 20)
  const a = Math.floor(rnd() * 20)
  const s2 = pointsFor(h + 1, a).slice(0, h + a) // set 2 in play at h:a
  return buildMatch({ match: LIVE, sets: [{ points: s1, finished: true }, { points: s2, finished: false }] })
}

const TEAM_TYPES = ['improper_request', 'delay_warning', 'delay_penalty']
const MEMBER_TYPES = ['warning', 'penalty', 'expulsion', 'disqualification']

function randomStep(rnd, d, ctx) {
  const events = d.events
  const setIndex = rnd() < 0.3 ? 1 : 2
  const tl = scoreTimeline(events, setIndex)
  if (!tl.length) return null
  const at = Math.floor(rnd() * tl.length)
  const team = rnd() < 0.5 ? 'home' : 'away'
  const r = rnd()
  if (r < 0.12) {
    // a penalty given now on the board: its point follows (CorrectionBoard stage)
    const tl2 = scoreTimeline(events, 2)
    const type = rnd() < 0.5 ? 'delay_penalty' : 'penalty'
    const court = courtAt(events, 2, team, tl2.length - 1)
    const target = type === 'penalty' ? { playerType: 'player', playerNumber: court.lineup ? pick(rnd, Object.values(court.lineup)) : 1 } : {}
    return planAddSanction(events, { setIndex: 2, team, type, at: tl2.length - 1, target, pointAlreadyGiven: false }, ctx)
  }
  if (r < 0.15) return planAddTimeout(events, { setIndex, team, at }, ctx)
  if (r < 0.35) {
    if (rnd() < 0.5) return planAddSanction(events, { setIndex, team, type: pick(rnd, TEAM_TYPES), at }, ctx)
    const court = courtAt(events, setIndex, team, at)
    const n = court.lineup ? pick(rnd, Object.values(court.lineup)) : (team === 'home' ? 1 : 11)
    return planAddSanction(events, { setIndex, team, type: pick(rnd, MEMBER_TYPES), at, target: { playerType: 'player', playerNumber: n } }, ctx)
  }
  if (r < 0.45) {
    const court = courtAt(events, setIndex, team, at)
    if (!court.lineup) return null
    const out = pick(rnd, Object.values(court.lineup))
    const bench = (team === 'home' ? [7, 8, 9, 10, 12] : [17, 18, 19, 20, 22]).filter(n => !Object.values(court.lineup).map(String).includes(String(n)))
    return planAddSubstitution(events, { setIndex, team, playerOut: out, playerIn: pick(rnd, bench), at }, ctx)
  }
  const movable = events.filter(e => ['timeout', 'sanction', 'substitution'].includes(e.type))
  if (r < 0.55 && movable.length) return planMoveEvent(events, pick(rnd, movable).id, { setIndex, at }, ctx)
  const sanctions = events.filter(e => e.type === 'sanction')
  if (r < 0.62 && sanctions.length) {
    const s = pick(rnd, sanctions)
    const p = s.payload || {}
    const isTeamS = TEAM_TYPES.includes(p.type)
    const type = isTeamS ? pick(rnd, TEAM_TYPES) : pick(rnd, MEMBER_TYPES)
    // the form keeps the score it was given at
    const sTl = scoreTimeline(events.filter(e => e.id !== s.id), setOf(s))
    const before = events.filter(e => e.type === 'point' && setOf(e) === setOf(s) && compareBySeq(e, s) < 0).length
    return planEditEvent(events, s.id, { at: Math.min(before, sTl.length - 1), type, target: { playerType: p.playerType, playerNumber: p.playerNumber, role: p.role } }, ctx)
  }
  if (r < 0.67 && sanctions.length) return planRemoveSanction(events, pick(rnd, sanctions).id, {}, ctx)
  const points = events.filter(e => e.type === 'point')
  if (r < 0.77 && points.length) return planRemoveEntry(events, pick(rnd, points).id, ctx)
  if (r < 0.85 && points.length) {
    const p = pick(rnd, points)
    return planSetPointTeam(events, p.id, p.payload?.team === 'home' ? 'away' : 'home', ctx)
  }
  if (r < 0.93) return planAddPoint(events, d.sets, { setIndex: 2, team }, ctx)
  return planRemovePoint(events, d.sets, { setIndex: 2, team }, ctx)
}

function invariants(events) {
  const bad = []
  const main = events.filter(e => Number.isInteger(e.seq))
  const bases = main.map(e => e.seq)
  if (new Set(bases).size !== bases.length) bad.push('duplicate base seq')
  for (const e of events) {
    if (!Number.isInteger(e.seq) && !main.some(m => m.seq === Math.floor(e.seq))) bad.push(`orphan sub-row ${e.type} ${e.seq}`)
    if (e.type === 'point' && e.payload?.penaltySeq != null) {
      const s = events.find(x => x.type === 'sanction' && x.seq === e.payload.penaltySeq && setOf(x) === setOf(e))
      if (!s) bad.push(`point ${e.seq} names no sanction at ${e.payload.penaltySeq}`)
      else if (!awardsPoint(s.payload?.type)) bad.push(`point ${e.seq} linked to a ${s.payload?.type}`)
      else if (s.payload?.team === e.payload?.team) bad.push(`point ${e.seq} is a penalty point for the sanctioned team`)
    }
  }
  return bad
}

describe('chained corrections (correction board), property test', () => {
  it(`${SEEDS} seeds: combined write = reviewed draft; the rebuild is a fixed point; penalty links hold`, () => {
    const failures = []
    let checked = 0
    let edits = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = mulberry32(seed)
      const m = randomMatch(rnd)
      const base = baseDraft({ events: m.events, match: m.match, sets: m.sets, players: {} })
      const ctx = { match: base.match, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, matchId: 1, mode: 'live', liveSetIndex: 2 }
      let d = base
      const steps = []
      const names = []
      for (let i = 0; i < 6; i++) {
        let plan
        try { plan = randomStep(rnd, d, { ...ctx, match: d.match }) } catch (err) { failures.push(`seed ${seed} step ${i}: THROW ${err.message}`); break }
        if (!plan || plan.error) continue
        steps.push({ plan })
        names.push(plan.log?.action)
        d = applyStep(d, plan)
        if (plan.followUp?.awardPointTo) {
          const sanctionSet = plan.add?.find(r => r.type === 'sanction')?.setIndex ?? 2
          const point = planAddPoint(d.events, d.sets, { setIndex: sanctionSet, team: plan.followUp.awardPointTo, penaltySeq: plan.followUp.penaltySeq ?? null }, { ...ctx, match: d.match })
          if (point.error) { steps.pop(); names.pop(); d = buildDraft(base, steps); continue }
          steps.push({ plan: point, withPrevious: true })
          names.push('penaltyPoint')
          d = applyStep(d, point)
        }
      }
      if (!steps.length) continue
      checked += 1
      edits += names.filter(n => n === 'editSanction').length
      const written = applyPlanToEvents(base.events, combinedPlan(base, steps))
      const a = norm(written)
      const b = norm(d.events)
      if (JSON.stringify(a) !== JSON.stringify(b)) failures.push(`seed ${seed} [${names.join(',')}]: combined != draft`)
      const rc = recomputeMatch(d.events, { ...ctx, match: d.match })
      if (rc.add.length || rc.update.length || rc.remove.length) {
        failures.push(`seed ${seed} [${names.join(',')}]: not a fixed point: add ${rc.add.length} update ${rc.update.length} remove ${rc.remove.length}`)
      }
      for (const x of invariants(d.events)) failures.push(`seed ${seed} [${names.join(',')}]: ${x}`)
    }
    // the chains really ran (and moved or changed sanctions)
    expect(checked).toBeGreaterThan(SEEDS * 0.8)
    expect(edits).toBeGreaterThan(20)
    expect(failures).toEqual([])
  }, 300000)
})
