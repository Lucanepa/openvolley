import { describe, it, expect } from 'vitest'
import { recomputeMatch, finalizePlan, applyPlanToEvents, rotateState, matchIssues } from '../recompute'
import { emptyPlan } from '../manualCorrections'
import { compareBySeq } from '../describe'
import { scoreFromPointEvents } from '../rules'
import { getStartingLineup } from '../../../scoresheet_pdf/utils/scoresheetModel'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from './fixtures/correctionsMatch'

const HOME_PLAYERS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ id: n, number: n, libero: n === 9 ? 'libero1' : '' }))
const AWAY_PLAYERS = [11, 12, 13, 14, 15, 16, 17, 18, 20].map(n => ({ id: 100 + n, number: n, libero: n === 20 ? 'libero1' : '' }))
const LIVE_MATCH = { ...MATCH, status: 'live' }
const ctx = { match: LIVE_MATCH, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, matchId: 1, mode: 'review', players: { home: HOME_PLAYERS, away: AWAY_PLAYERS } }

// Set 1 25:20 with a substitution and a libero in and out (the rotation
// takes him off once), set 2 25:18 with a libero who stays on
function richMatch() {
  return buildMatch({
    sets: [
      {
        points: pointsFor(25, 20),
        finished: true,
        extras: [
          { at: 0, type: 'libero_entry', payload: { team: 'away', playerOut: 11, liberoIn: 20 } },
          { at: 3, type: 'timeout', payload: { team: 'away' } },
          { at: 0, type: 'libero_entry', payload: { team: 'home', playerOut: 5, liberoIn: 9 } },
          { at: 12, type: 'substitution', payload: { team: 'home', playerOut: 2, playerIn: 7 } },
          { at: 20, type: 'sanction', payload: { team: 'away', type: 'delay_warning' } },
          { at: 30, type: 'substitution', payload: { team: 'home', playerOut: 7, playerIn: 2 } }
        ]
      },
      {
        points: pointsFor(25, 18),
        finished: true,
        extras: [
          { at: 0, type: 'libero_entry', payload: { team: 'home', playerOut: 1, liberoIn: 9 } },
          { at: 1, type: 'libero_exit', payload: { team: 'home' } },
          { at: 10, type: 'substitution', payload: { team: 'away', playerOut: 13, playerIn: 17 } }
        ]
      }
    ]
  })
}

const lineupsOf = (events, setIndex, team) => events
  .filter(e => e.type === 'lineup' && (e.setIndex ?? 1) === setIndex && e.payload?.team === team)
  .sort(compareBySeq)
const lastLineup = (events, setIndex, team) => lineupsOf(events, setIndex, team).pop()?.payload?.lineup
const asStrings = (lu) => Object.fromEntries(Object.entries(lu || {}).map(([k, v]) => [k, String(v)]))

describe('recompute: a log the scoreboard wrote is left as it is', () => {
  it('plain sets: nothing to add, change or remove, no issue', () => {
    const { events } = buildMatch({ sets: [{ points: pointsFor(25, 20), finished: true }, { points: pointsFor(23, 25), finished: true }] })
    const rc = recomputeMatch(events, ctx)
    expect(rc.add).toEqual([])
    expect(rc.update).toEqual([])
    expect(rc.remove).toEqual([])
    expect(rc.issues).toEqual([])
  })

  it('substitutions, liberos and the automatic libero exit: still a no-op', () => {
    const { events } = richMatch()
    // the fixture's rotation took a libero to the front row at least once
    expect(events.some(e => e.type === 'libero_exit' && e.payload.reason === 'rotation_to_front_row')).toBe(true)
    const rc = recomputeMatch(events, ctx)
    expect(rc.add).toEqual([])
    expect(rc.update).toEqual([])
    expect(rc.remove).toEqual([])
    expect(rc.issues).toEqual([])
  })
})

describe('rotateState', () => {
  it('moves the libero record and takes the libero off at the front row', () => {
    const lineup = { I: 1, II: 2, III: 3, IV: 4, V: '9', VI: 6 }
    const r = rotateState({ lineup, ls: { position: 'V', liberoNumber: 9, playerNumber: 5 } })
    expect(asStrings(r.lineup)).toEqual({ I: '2', II: '3', III: '4', IV: '5', V: '6', VI: '1' })
    expect(r.ls).toBeNull()
    expect(r.exit).toMatchObject({ position: 'IV', liberoOut: 9, playerIn: 5 })
    const stay = rotateState({ lineup: { I: '9', II: 2, III: 3, IV: 4, V: 5, VI: 6 }, ls: { position: 'I', liberoNumber: 9, playerNumber: 1 } })
    expect(stay.ls).toMatchObject({ position: 'VI' })
    expect(stay.exit).toBeNull()
  })
})

describe('recompute after a correction', () => {
  it('a starting line-up changed after rallies: every rotation of the set follows', () => {
    const { events } = buildMatch({ sets: [{ points: pointsFor(25, 20), finished: true }] })
    const start = events.find(e => e.type === 'lineup' && e.payload.isInitial && e.payload.team === 'home')
    const plan = emptyPlan()
    plan.update = [{ id: start.id, changes: { payload: { ...start.payload, lineup: { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 8 } } } }]
    finalizePlan(events, plan, ctx)
    const after = applyPlanToEvents(events, plan)
    // #6 played nowhere; #8 is on court in every later line-up instead
    for (const lu of lineupsOf(after, 1, 'home')) {
      expect(Object.values(lu.payload.lineup).map(String)).toContain('8')
      expect(Object.values(lu.payload.lineup).map(String)).not.toContain('6')
    }
    expect(plan.update.length).toBeGreaterThan(5)
    expect(getStartingLineup(after, 1, 'home')).toEqual(['1', '2', '3', '4', '5', '8'])
    // the score and the other team are untouched
    expect(scoreFromPointEvents(after, 1)).toEqual({ homePoints: 25, awayPoints: 20 })
    expect(lineupsOf(after, 1, 'away').map(e => e.payload.lineup)).toEqual(lineupsOf(events, 1, 'away').map(e => e.payload.lineup))
    // and a second rebuild has nothing more to do
    const again = recomputeMatch(after, ctx)
    expect([again.add, again.update, again.remove]).toEqual([[], [], []])
  })

  it('a point removed in the middle of a set: the serve order and the rotations after it are rebuilt', () => {
    const { events } = buildMatch({ sets: [{ points: 'HAAHHA' + 'H'.repeat(20), finished: false }] })
    // remove the 2nd point (away's first side-out): away never rotated there
    const points = events.filter(e => e.type === 'point').sort(compareBySeq)
    const target = points[1]
    const plan = emptyPlan()
    plan.remove = events.filter(e => Math.floor(e.seq) === Math.floor(target.seq)).map(e => e.id)
    finalizePlan(events, plan, ctx)
    const after = applyPlanToEvents(events, plan)
    // rebuilt from scratch, the remaining points give exactly this log
    const expected = buildMatch({ sets: [{ points: 'HAHHA' + 'H'.repeat(20), finished: false }] }).events
    expect(asStrings(lastLineup(after, 1, 'home'))).toEqual(asStrings(lastLineup(expected, 1, 'home')))
    expect(asStrings(lastLineup(after, 1, 'away'))).toEqual(asStrings(lastLineup(expected, 1, 'away')))
    expect(lineupsOf(after, 1, 'away').length).toBe(lineupsOf(expected, 1, 'away').length)
    expect(plan.affectedSets).toEqual([1])
    // every point carries its new running score
    const scores = after.filter(e => e.type === 'point').sort(compareBySeq).map(e => `${e.payload.score.home}:${e.payload.score.away}`)
    expect(scores.slice(0, 5)).toEqual(['1:0', '1:1', '2:1', '3:1', '3:2'])
  })

  it('the first serve changed: who rotates on each point changes with it', () => {
    const { events } = buildMatch({ sets: [{ points: pointsFor(25, 20), finished: true }] })
    const plan = emptyPlan()
    plan.matchPatch = { firstServe: 'away', coinTossServeA: false, coinTossServeB: true }
    finalizePlan(events, plan, ctx)
    const after = applyPlanToEvents(events, plan)
    const expected = buildMatch({ sets: [{ points: pointsFor(25, 20), finished: true }], match: { ...LIVE_MATCH, firstServe: 'away' } }).events
    expect(asStrings(lastLineup(after, 1, 'home'))).toEqual(asStrings(lastLineup(expected, 1, 'home')))
    expect(asStrings(lastLineup(after, 1, 'away'))).toEqual(asStrings(lastLineup(expected, 1, 'away')))
  })

  it('a substitution removed while the player comes back later: allowed, the later one is flagged', () => {
    const { events } = richMatch()
    const first = events.find(e => e.type === 'substitution' && e.payload.playerIn === 7)
    const plan = emptyPlan()
    plan.remove = events.filter(e => Math.floor(e.seq) === first.seq).map(e => e.id)
    finalizePlan(events, plan, ctx)
    expect(plan.error).toBeUndefined()
    const keys = plan.newIssues.map(i => i.key)
    expect(keys).toContain('corrections.issue.subOutNotOnCourt')
    expect(plan.newIssues.find(i => i.key === 'corrections.issue.subOutNotOnCourt').text)
      .toMatch(/^Set 1, A \d+:\d+ B: substitution of VC Smash, #2 for #7: #7 is not on court\.$/)
    const after = applyPlanToEvents(events, plan)
    // #2 never left: he is on court in every later home line-up of set 1
    for (const lu of lineupsOf(after, 1, 'home').filter(e => e.seq > first.seq)) {
      expect(Object.values(lu.payload.lineup).map(String)).toContain('2')
    }
  })

  it('a libero entry corrected to another player: the exit and the automatic exit bring that player back', () => {
    const { events } = richMatch()
    const entry = events.find(e => e.type === 'libero_entry' && e.setIndex === 2)
    const plan = emptyPlan()
    plan.update = [{ id: entry.id, changes: { payload: { ...entry.payload, playerOut: 6 } } }]
    finalizePlan(events, plan, ctx)
    const after = applyPlanToEvents(events, plan)
    const exit = after.find(e => e.type === 'libero_exit' && e.setIndex === 2)
    expect(exit.payload.playerIn).toBe(6)
    const fixedEntry = after.find(e => e.id === entry.id)
    expect(fixedEntry.payload.position).toBe('VI')
    // #1 was never replaced: he stays on court, #6 comes back at the exit
    const atExit = after.find(e => e.type === 'lineup' && Math.floor(e.seq) === exit.seq)
    expect(Object.values(atExit.payload.lineup).map(String)).toEqual(expect.arrayContaining(['1', '6']))
  })

  it('lists a time-out beyond two and a second delay warning, never refusing', () => {
    const { events } = buildMatch({
      sets: [{
        points: pointsFor(25, 20),
        finished: true,
        extras: [
          { at: 1, type: 'timeout', payload: { team: 'home' } },
          { at: 2, type: 'timeout', payload: { team: 'home' } },
          { at: 3, type: 'timeout', payload: { team: 'home' } },
          { at: 4, type: 'sanction', payload: { team: 'away', type: 'delay_warning' } },
          { at: 6, type: 'sanction', payload: { team: 'away', type: 'delay_warning' } }
        ]
      }]
    })
    const issues = matchIssues(events, ctx)
    expect(issues.map(i => i.key)).toEqual(['corrections.issue.timeoutLimit', 'corrections.issue.sanctionLadder'])
    expect(issues[1].text).toBe('Set 1, B 3:3 A: Delay warning of Volley Bern: by the rules this is a delay penalty.')
  })

  it('a finished set whose last point changes team: the set end follows the new winner, the score is flagged', () => {
    const { events } = buildMatch({ sets: [{ points: pointsFor(25, 23), finished: true }] })
    const last = events.filter(e => e.type === 'point').sort(compareBySeq).pop()
    const plan = emptyPlan()
    plan.update = [{ id: last.id, changes: { payload: { ...last.payload, team: 'away' } } }]
    finalizePlan(events, plan, ctx)
    expect(plan.newIssues.map(i => i.key)).toContain('corrections.issue.setScoreInvalid')
    const after = applyPlanToEvents(events, plan)
    expect(scoreFromPointEvents(after, 1)).toEqual({ homePoints: 24, awayPoints: 24 })
    expect(plan.affectedSets).toEqual([1])
  })
})

describe('removing and editing the other entries', () => {
  it('a decision change removed gives the point back and rebuilds the rotations', async () => {
    const { planRemoveEntry } = await import('../manualCorrections')
    const { events } = buildMatch({ sets: [{ points: 'HAHH', finished: false }] })
    const points = events.filter(e => e.type === 'point').sort(compareBySeq)
    const swapped = points[1] // away's point, swapped to home by a decision change
    const changed = events.map(e => (e.id === swapped.id ? { ...e, payload: { ...e.payload, team: 'home', swappedFrom: 'away' } } : e))
      .filter(e => !(Math.floor(e.seq) === Math.floor(swapped.seq) && e.type === 'lineup'))
    const dc = { id: 999, matchId: 1, setIndex: 1, type: 'decision_change', seq: 100, ts: new Date().toISOString(), payload: { fromTeam: 'away', toTeam: 'home', pointEventId: swapped.id } }
    const log = [...changed, dc]
    const plan = planRemoveEntry(log, dc.id, ctx)
    expect(plan.error).toBeUndefined()
    const after = applyPlanToEvents(log, plan)
    expect(after.find(e => e.id === swapped.id).payload.team).toBe('away')
    expect(after.some(e => e.id === dc.id)).toBe(false)
    // away rotated on its side-out again
    expect(asStrings(lastLineup(after, 1, 'away'))).toEqual(asStrings(lastLineup(events, 1, 'away')))
    expect(asStrings(lastLineup(after, 1, 'home'))).toEqual(asStrings(lastLineup(events, 1, 'home')))
  })

  it('a game captain designation: edited, the match field follows; removed, the previous one comes back', async () => {
    const { planEditEntry, planRemoveEntry, planGameCaptain } = await import('../manualCorrections')
    const { events } = buildMatch({ sets: [{ points: pointsFor(10, 8), finished: false, extras: [{ at: 2, type: 'court_captain_designation', payload: { team: 'home', playerNumber: 3, previousCourtCaptain: 4 } }] }] })
    const des = events.find(e => e.type === 'court_captain_designation')
    const mctx = { ...ctx, match: { ...LIVE_MATCH, homeCourtCaptain: 3 } }
    const edit = planEditEntry(events, des.id, { playerNumber: 5 }, mctx)
    expect(edit.matchPatch).toEqual({ homeCourtCaptain: 5 })
    expect(edit.log.text).toMatch(/^Changed: Game captain: #5/)
    const removed = planRemoveEntry(events, des.id, mctx)
    expect(removed.matchPatch).toEqual({ homeCourtCaptain: 4 })
    const viaCard = planGameCaptain(events, { team: 'home', number: 6 }, mctx)
    expect(viaCard.matchPatch).toEqual({ homeCourtCaptain: 6 })
    expect(applyPlanToEvents(events, viaCard).find(e => e.id === des.id).payload.playerNumber).toBe(6)
  })

  it('a libero re-designation removed puts the roster libero marks back', async () => {
    const { planRemoveEntry } = await import('../manualCorrections')
    const { events } = buildMatch({ sets: [{ points: pointsFor(10, 8), finished: false, extras: [{ at: 3, type: 'libero_redesignation', payload: { team: 'home', unableLiberoNumber: 9, newLiberoNumber: 8, previousLiberoFlags: { unableLibero: { id: 9, libero: 'libero1' }, newLibero: { id: 8, libero: '' } } } }] }] })
    const r = events.find(e => e.type === 'libero_redesignation')
    const plan = planRemoveEntry(events, r.id, ctx)
    expect(plan.playerUpdates).toEqual([{ id: 9, changes: { libero: 'libero1' } }, { id: 8, changes: { libero: '' } }])
  })

  it('the deciding set\'s serve corrected: its rotations follow', async () => {
    const { planSet5CoinToss } = await import('../manualCorrections')
    const m5 = { ...LIVE_MATCH, set5FirstServe: 'A' }
    const sets = [1, 2, 3, 4].map(i => ({ index: i, points: i % 2 ? pointsFor(25, 20) : pointsFor(20, 25), finished: true }))
    const { events } = buildMatch({ sets: [...sets, { index: 5, points: 'HAAHAH', finished: false }], match: m5 })
    const plan = planSet5CoinToss(events, { firstServe: 'B' }, { ...ctx, match: m5 })
    expect(plan.error).toBeUndefined()
    expect(plan.matchPatch).toEqual({ set5FirstServe: 'B' })
    const after = applyPlanToEvents(events, plan)
    const expected = buildMatch({ sets: [...sets, { index: 5, points: 'HAAHAH', finished: false }], match: { ...m5, set5FirstServe: 'B' } }).events
    expect(asStrings(lastLineup(after, 5, 'home'))).toEqual(asStrings(lastLineup(expected, 5, 'home')))
    expect(asStrings(lastLineup(after, 5, 'away'))).toEqual(asStrings(lastLineup(expected, 5, 'away')))
    // sets 1-4 untouched
    expect(plan.update.every(u => after.find(e => e.id === u.id)?.setIndex === 5 || after.find(e => e.id === u.id)?.type === 'set5_coin_toss')).toBe(true)
  })
})
