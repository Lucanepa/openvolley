// The correction board and the Advanced log on a penalty's point (audit
// LOG-05). A misconduct penalty or a delay penalty gives the opponent a
// point (FIVB 16.2.3, 21.3.1); the point names its sanction
// (payload.penaltySeq) and Undo takes the two back together. The board's
// "−", a typed score, "Last point went to the wrong team" and the Advanced
// Remove acted on that point alone: the sanction stayed without its point
// (or the sanctioned team got it), nothing was said, and the sheet circled a
// later rally point. Now "−" takes the team's latest rally point, Remove
// takes the sanction with its point, a penalty point never changes team, the
// check lists a sanction without its point and a broken link, and the sheet
// and the planners pick the same circled point.
import { describe, it, expect } from 'vitest'
import {
  planRemovePoint, planRemoveEntry, planLastPointOtherTeam, planSetPointTeam, planAddSanction,
  applyPlanToEvents, describeRemoval, errorText, scoreTimeline
} from '../manualCorrections'
import { baseDraft, applyStep, planScoreTo } from '../correctionDraft'
import { matchIssues } from '../recompute'
import { penaltyOfPoint, pointOfPenalty } from '../sanctions'
import { scoreFromPointEvents } from '../rules'
import { buildSetData, eventsBySet } from '../../../scoresheet_pdf/utils/setModel'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM } from './fixtures/correctionsMatch'

const LIVE = { ...MATCH, status: 'live' }
const ctx = { match: LIVE, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, matchId: 1, mode: 'live', liveSetIndex: 2 }

// set 1 25:20, set 2 live; a delay penalty of away after `at` points of set
// 2, and the next point (home's) is its point, written as the scoreboard
// writes it: it names the sanction and has no rally start of its own
function fixture(set2 = 'HAHAHHAA', at = 5) {
  const m = buildMatch({
    match: LIVE,
    sets: [
      { points: 'HHHHHAAAAA'.repeat(2) + 'HHHHHAAAAAHHHHH', finished: true },
      { points: set2, finished: false, extras: [{ at, type: 'sanction', payload: { team: 'away', type: 'delay_penalty' } }] }
    ]
  })
  const sanction = m.events.find(e => e.type === 'sanction')
  const pp = m.events.filter(e => e.type === 'point' && e.setIndex === 2 && e.seq > sanction.seq)[0]
  pp.payload = { ...pp.payload, penaltySeq: sanction.seq }
  const ownStart = m.events.filter(e => e.type === 'rally_start' && e.setIndex === 2 && e.seq < pp.seq && e.seq > sanction.seq)
  const events = m.events.filter(e => !ownStart.includes(e))
  return { ...m, events, sanction, pp }
}
const setsWith = (sets, events) => sets.map(s => ({ ...s, ...scoreFromPointEvents(events, s.index) }))
const circled = (events, sets, setIndex = 2) => {
  const d = buildSetData({ match: LIVE, sets: setsWith(sets, events), teamAKey: 'home', teamBKey: 'away', set5SwitchAt: 8, eventsOfSet: eventsBySet(events) }, setIndex, false)
  return { home: d.leftCircledPoints, away: d.rightCircledPoints }
}
const keys = (list) => (list || []).map(i => i.key)
const PENALTY_ISSUES = ['corrections.issue.penaltyWithoutPoint', 'corrections.issue.penaltyLinkBroken']

describe('board "−" and a typed score', () => {
  it('"−" takes the team\'s latest rally point, never the penalty point: the sanction keeps its point and the sheet circles it', () => {
    const { events, sets, sanction, pp } = fixture()
    expect(circled(events, sets).home).toEqual([4])
    const homeRallies = events.filter(e => e.type === 'point' && e.setIndex === 2 && e.payload.team === 'home' && e.id !== pp.id)
    const latestRally = homeRallies[homeRallies.length - 1]
    const plan = planRemovePoint(events, sets, { setIndex: 2, team: 'home' }, ctx)
    expect(plan.error).toBeUndefined()
    expect(plan.remove).toContain(latestRally.id)
    expect(plan.remove).not.toContain(pp.id)
    expect(plan.remove).not.toContain(sanction.id)
    const after = applyPlanToEvents(events, plan)
    const ppNow = after.find(e => e.id === pp.id)
    expect(penaltyOfPoint(after, ppNow)?.id).toBe(sanction.id)
    expect(scoreFromPointEvents(after, 2)).toEqual({ homePoints: 3, awayPoints: 4 })
    // the penalty point is home's 3rd point now, and it is the circled one
    expect(circled(after, sets).home).toEqual([3])
    expect(keys(plan.newIssues).filter(k => PENALTY_ISSUES.includes(k))).toEqual([])
  })

  it('"−" for a team whose only points of the set are penalty points: refused with why', () => {
    const { events, sets } = fixture('AAH', 2)
    const plan = planRemovePoint(events, sets, { setIndex: 2, team: 'home' }, ctx)
    expect(plan.error).toBe('corrections.error.onlyPenaltyPoints')
    expect(errorText(plan, null)).toBe('Every point of VC Seehafen in set 2 was given by a sanction of the opponent: remove that sanction instead.')
    // a team without any point: as before
    const none = events.filter(e => !(e.setIndex === 2 && (e.type === 'sanction' || (e.type === 'point' && e.payload.team === 'home'))))
    expect(planRemovePoint(none, sets, { setIndex: 2, team: 'home' }, ctx).error).toBe('corrections.error.noPointToRemove')
  })

  it('a typed score one lower: the same point as "−"', () => {
    const { events, sets, match, pp, sanction } = fixture()
    const draft = baseDraft({ events, match, sets, players: {} })
    const res = planScoreTo(draft, { setIndex: 2, team: 'home', target: 3 }, ctx)
    expect(res.error).toBeNull()
    const after = res.plans.reduce((d, p) => applyStep(d, p), draft)
    expect(after.events.some(e => e.id === pp.id)).toBe(true)
    expect(after.events.some(e => e.id === sanction.id)).toBe(true)
    expect(scoreFromPointEvents(after.events, 2).homePoints).toBe(3)
  })
})

describe('Advanced log: Remove on a penalty point', () => {
  it('takes the sanction with it (as Undo does), says so, and the confirmation lists both', () => {
    const { events, sanction, pp } = fixture()
    const plan = planRemoveEntry(events, pp.id, ctx)
    expect(plan.error).toBeUndefined()
    expect(plan.remove).toEqual(expect.arrayContaining([pp.id, sanction.id]))
    expect(keys(plan.notes)).toContain('corrections.note.penaltyWithPoint')
    const lines = describeRemoval(events, plan, ctx)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines.some(l => /delay penalty/i.test(l))).toBe(true)
    const after = applyPlanToEvents(events, plan)
    expect(scoreFromPointEvents(after, 2)).toEqual({ homePoints: 3, awayPoints: 4 })
    expect(keys(matchIssues(after, ctx)).filter(k => PENALTY_ISSUES.includes(k))).toEqual([])
    expect(circled(after, fixture().sets).home).toEqual([])
  })

  it('a rally point is removed alone, as before', () => {
    const { events, sanction, pp } = fixture()
    const rally = events.filter(e => e.type === 'point' && e.setIndex === 2 && e.id !== pp.id).pop()
    const plan = planRemoveEntry(events, rally.id, ctx)
    expect(plan.remove).not.toContain(sanction.id)
    expect(keys(plan.notes)).not.toContain('corrections.note.penaltyWithPoint')
  })
})

describe('"Last point went to the wrong team" and the point form on a penalty point', () => {
  it('refused: a penalty\'s point goes to the opponent of the sanctioned team', () => {
    const { events, pp } = fixture('HAHAHH', 5)
    const last = events.filter(e => e.type === 'point' && e.setIndex === 2).pop()
    expect(last.id).toBe(pp.id)
    const plan = planLastPointOtherTeam(events, { setIndex: 2 }, ctx)
    expect(plan.error).toBe('corrections.error.penaltyPoint')
    expect(errorText(plan, null)).toMatch(/^This point was given by a sanction of Volley Talberg \(Delay penalty\)/i)
    expect(planSetPointTeam(events, pp.id, 'away', ctx).error).toBe('corrections.error.penaltyPoint')
  })

  it('a rally point still changes team', () => {
    const { events, pp } = fixture('HAHAHHA', 5)
    const plan = planLastPointOtherTeam(events, { setIndex: 2 }, ctx)
    expect(plan.error).toBeUndefined()
    const after = applyPlanToEvents(events, plan)
    expect(after.filter(e => e.type === 'point' && e.setIndex === 2).pop().payload.team).toBe('home')
    expect(penaltyOfPoint(after, after.find(e => e.id === pp.id))).toBeTruthy()
  })
})

describe('the check: a penalty without its point, a link to no penalty', () => {
  it('a log as the scoreboard writes it: neither', () => {
    const { events } = fixture()
    expect(keys(matchIssues(events, ctx)).filter(k => PENALTY_ISSUES.includes(k))).toEqual([])
    // a penalty written before the link: its point is the opponent's next one
    const { events: old, pp } = fixture()
    const unlinked = old.map(e => (e.id === pp.id ? { ...e, payload: { team: e.payload.team, score: e.payload.score } } : e))
    expect(keys(matchIssues(unlinked, ctx)).filter(k => PENALTY_ISSUES.includes(k))).toEqual([])
  })

  it('the penalty point taken away alone: "the point it gives the opponent is missing"', () => {
    const { events, sanction, pp } = fixture()
    const issues = matchIssues(events.filter(e => e.id !== pp.id), ctx)
    const issue = issues.find(i => i.key === 'corrections.issue.penaltyWithoutPoint')
    expect(issue?.eventId).toBe(sanction.id)
    expect(issue.text).toMatch(/^Set 2, .*Volley Talberg: the point it gives the opponent is missing\.$/)
  })

  it('a penalty point given to the sanctioned team: "no penalty of the opponent gave it"', () => {
    const { events, pp } = fixture()
    const flipped = events.map(e => (e.id === pp.id ? { ...e, payload: { ...e.payload, team: 'away' } } : e))
    const issues = matchIssues(flipped, ctx)
    expect(issues.find(i => i.key === 'corrections.issue.penaltyLinkBroken')?.eventId).toBe(pp.id)
    expect(keys(issues)).toContain('corrections.issue.penaltyWithoutPoint')
  })

  it('a sanction whose point the correction gives next (live, "point now"): not listed', () => {
    const { events } = fixture('HAHAHHAA', 5)
    const tl = scoreTimeline(events, 2)
    const plan = planAddSanction(events, { setIndex: 2, team: 'home', type: 'delay_warning', at: tl.length - 1, pointAlreadyGiven: false }, ctx)
    expect(plan.error).toBeUndefined()
    const pen = planAddSanction(events, { setIndex: 2, team: 'home', type: 'penalty', target: { playerType: 'player', playerNumber: 2 }, at: tl.length - 1, pointAlreadyGiven: false }, ctx)
    expect(pen.error).toBeUndefined()
    expect(pen.followUp?.awardPointTo).toBe('away')
    expect(keys(pen.newIssues)).not.toContain('corrections.issue.penaltyWithoutPoint')
  })
})

describe('the circled point: the sheet and the board agree', () => {
  it('a second penalty added on the board at the same score circles the opponent\'s next free point, not the first penalty\'s', () => {
    // H A H A H | delay penalty of away (linked point H 4:2) | H 5:2
    const { events, sets, sanction, pp } = fixture('HAHAHHH', 5)
    const at = scoreTimeline(events, 2).findIndex(x => x.home === 3 && x.away === 2)
    const plan = planAddSanction(events, { setIndex: 2, team: 'away', type: 'penalty', target: { playerType: 'player', playerNumber: 12 }, at, pointAlreadyGiven: true }, ctx)
    expect(plan.error).toBeUndefined()
    const note = plan.notes.find(n => n.key === 'corrections.note.circledPoint')
    expect(note.text).toMatch(/5:2/)
    const after = applyPlanToEvents(events, plan)
    const added = after.find(e => e.type === 'sanction' && e.payload.type === 'penalty')
    expect(pointOfPenalty(after, added)?.payload.score).toEqual({ home: 5, away: 2 })
    expect(pointOfPenalty(after, after.find(e => e.id === sanction.id))?.id).toBe(pp.id)
    expect(circled(after, sets).home).toEqual([4, 5])
  })
})
