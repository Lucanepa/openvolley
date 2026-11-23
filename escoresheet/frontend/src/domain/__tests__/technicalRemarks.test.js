// Technical remarks (owner 22.11.2026): what a match keeps off its scoresheet,
// how it is listed, and the corrections' "where is this noted?" choice.
import { describe, it, expect } from 'vitest'
import {
  REMARKS_MODEL, technicalRemarksOn, remarksModelOf, technicalRemarkTo, technicalChange, technicalRemarks,
  remarkDestination, withRemarkDestination, sheetLineOf, oneLine
} from '../technicalRemarks'
import { isSheetRemark, TECHNICAL } from '../remarks'

const NEW = { remarksModel: REMARKS_MODEL, coinTossTeamA: 'home', bestOf: 5 }
const OLD = { coinTossTeamA: 'home', bestOf: 5 }

describe('the remarks model of a match', () => {
  it('only a match of this model keeps technical remarks off its sheet', () => {
    expect(REMARKS_MODEL).toBe(2)
    expect(technicalRemarksOn(NEW)).toBe(true)
    expect(technicalRemarksOn(OLD)).toBe(false)
    expect(technicalRemarksOn({ remarksModel: null })).toBe(false)
    expect(technicalRemarksOn(null)).toBe(false)
    expect(technicalRemarkTo(NEW)).toBe(TECHNICAL)
    expect(technicalRemarkTo(OLD)).toBe('sheet')
  })
  it('a stored match brings its own model, none for an older one', () => {
    expect(remarksModelOf(2)).toBe(2)
    expect(remarksModelOf(undefined)).toBe(null)
    expect(remarksModelOf(null)).toBe(null)
    expect(remarksModelOf('x')).toBe(null)
    expect(remarksModelOf(0)).toBe(null)
  })
})

describe('isSheetRemark', () => {
  it('an event line is a sheet line unless it says technical', () => {
    expect(isSheetRemark({ autoRemark: 'x' })).toBe(true)
    expect(isSheetRemark(undefined)).toBe(true)
    expect(isSheetRemark({ autoRemark: 'x', remarkTo: 'technical' })).toBe(false)
  })
})

describe('technicalChange', () => {
  it('a correction-log entry of category technical, one line', () => {
    const at = new Date('2026-11-22T13:05:00Z')
    expect(technicalChange({ action: 'resigned', text: 'Captain signature\nof Team V  replaced', by: 'app', now: at })).toEqual({
      ts: '2026-11-22T13:05:00.000Z', category: 'technical', action: 'resigned', setIndex: null, team: null,
      before: null, after: null, text: 'Captain signature of Team V replaced', description: 'Captain signature of Team V replaced', by: 'app'
    })
    expect(oneLine('a'.repeat(600)).length).toBe(500)
  })
})

describe('technicalRemarks: the list Match End and Corrections show', () => {
  it('every correction-log entry and every technical event line, oldest first; sheet lines are not listed', () => {
    const match = {
      ...NEW,
      manualChanges: [
        { ts: '2026-11-22T13:10:00Z', category: 'correction', action: 'removePoint', text: 'Point removed: A 3:2' },
        { ts: '2026-11-22T13:00:00Z', category: 'player', field: 'removed', description: 'Removed player #7 (Team V)' },
        { category: 'Set', field: 'Reopen', description: 'Reopened set 1' }
      ]
    }
    const events = [
      { ts: '2026-11-22T13:05:00Z', type: 'bench_injury', payload: { team: 'home', playerNumber: 4, autoRemark: 'Set 1, 14:05, A 3:2, #4 injured (bench)', remarkTo: 'technical' } },
      { ts: '2026-11-22T13:06:00Z', type: 'substitution', payload: { team: 'home', autoRemark: 'Set 1, 14:06, A 3:2, #8 exceptionally substituted by #3' } },
      { ts: '2026-11-22T13:07:00Z', type: 'point', payload: { team: 'home' } }
    ]
    expect(technicalRemarks({ match, events })).toEqual([
      { ts: '2026-11-22T13:00:00Z', text: 'Removed player #7 (Team V)', source: 'log' },
      { ts: '2026-11-22T13:05:00Z', text: 'Set 1, 14:05, A 3:2, #4 injured (bench)', source: 'event' },
      { ts: '2026-11-22T13:10:00Z', text: 'Point removed: A 3:2', source: 'log' },
      { ts: null, text: 'Reopened set 1', source: 'log' }
    ])
    expect(technicalRemarks({ match: {}, events: null })).toEqual([])
  })
})

describe('remarkDestination: where a correction is noted', () => {
  const ctx = { match: NEW }
  const plan = (log, extra = {}) => ({ add: [], update: [], remove: [], remarkAdd: [], log, ...extra })
  it('nothing to ask in an older match, for an edit of the sheet\'s lines, or once decided', () => {
    expect(remarkDestination(plan({ action: 'removePoint', text: 'x' }), { match: OLD })).toBe(null)
    expect(remarkDestination(plan({ action: 'editRemark', text: 'x' }), ctx)).toBe(null)
    expect(remarkDestination(plan({ action: 'removeRemark', text: 'x' }, { remarksSet: '' }), ctx)).toBe(null)
    expect(remarkDestination(plan({ action: 'removePoint', text: 'x', remarkTo: 'technical' }), ctx)).toBe(null)
    expect(remarkDestination({ error: 'corrections.error.x' }, ctx)).toBe(null)
  })
  it('a line the rules want is locked to the sheet (an exceptional substitution, a set start, a rule template)', () => {
    expect(remarkDestination(plan({ action: 'addSubstitution', text: 'x' }, { remarkAdd: ['Team B, Set 3 …'] }), ctx)).toEqual({ default: 'sheet', locked: true })
    expect(remarkDestination(plan({ action: 'setTimes', text: 'x' }, { remarkAdd: ['Actual game start: 16:21'] }), ctx)).toEqual({ default: 'sheet', locked: true })
    for (const kind of ['exceptionalSub', 'liberoUnable', 'liberoRedesignated', 'delay', 'protest', 'missingSignature']) {
      expect(remarkDestination(plan({ action: 'addRemark', text: 'x', after: 'y' }, { remarkAdd: ['y'], remarkKind: kind }), ctx)).toEqual({ default: 'sheet', locked: true })
    }
  })
  it('the scorer\'s own remark: asked, the sheet by default; every other correction: asked, technical by default', () => {
    expect(remarkDestination(plan({ action: 'addRemark', text: 'x', after: 'y' }, { remarkAdd: ['y'], remarkKind: 'other' }), ctx)).toEqual({ default: 'sheet', locked: false })
    for (const action of ['addPoint', 'removePoint', 'addSanction', 'addTimeout', 'addSubstitution', 'editLineup', 'coinToss', 'renumberPlayer', 'editLiberoEntry']) {
      expect(remarkDestination(plan({ action, text: 'x' }), ctx)).toEqual({ default: 'technical', locked: false })
    }
  })
})

describe('withRemarkDestination: the plan with the scorer\'s choice', () => {
  const ctx = { match: NEW }
  const point = { add: [], update: [], remove: [], remarkAdd: [], log: { action: 'removePoint', setIndex: 2, team: 'away', text: 'Point removed: B 3:5.' } }
  it('kept technical: the log says it was decided, nothing on the sheet', () => {
    const out = withRemarkDestination(point, null, { ctx })
    expect(out.remarkAdd).toEqual([])
    expect(out.log.remarkTo).toBe('technical')
    expect(remarkDestination(out, ctx)).toBe(null)
  })
  it('on the sheet too: its line (proposed, or as the scorer edited it) and the log says so', () => {
    expect(sheetLineOf(point, ctx)).toBe('Team B, Set 2: Point removed: B 3:5 (manual correction).')
    const out = withRemarkDestination(point, 'sheet', { ctx })
    expect(out.remarkAdd).toEqual(['Team B, Set 2: Point removed: B 3:5 (manual correction).'])
    expect(out.log).toMatchObject({ remarkTo: 'sheet', sheetLine: 'Team B, Set 2: Point removed: B 3:5 (manual correction).' })
    expect(withRemarkDestination(point, 'sheet', { ctx, line: 'My own line' }).remarkAdd).toEqual(['My own line'])
    // with the score, the scorekeeper course's template
    expect(sheetLineOf({ log: { ...point.log, score: '3:5' } }, ctx)).toBe('Team B, Set 2, Result 3:5: Point removed: B 3:5 (manual correction).')
  })
  it('the scorer\'s own remark as a technical remark: off the sheet, logged as one', () => {
    const remark = { add: [], update: [], remove: [], remarkAdd: ['Team A, Set 1: ball pump broken'], remarkKind: 'other',
      log: { action: 'addRemark', setIndex: 1, team: 'home', before: null, after: 'Team A, Set 1: ball pump broken', text: 'Remark added: "Team A, Set 1: ball pump broken"' } }
    expect(withRemarkDestination(remark, 'sheet', { ctx })).toBe(remark)
    const out = withRemarkDestination(remark, 'technical', { ctx })
    expect(out.remarkAdd).toEqual([])
    expect(out.log).toMatchObject({ action: 'technicalRemark', category: 'technical', remarkTo: 'technical', text: 'Technical remark: "Team A, Set 1: ball pump broken"' })
  })
  it('a locked plan and an older match keep their plan as it is', () => {
    const sub = { ...point, remarkAdd: ['Team B …'], log: { action: 'addSubstitution', text: 'x' } }
    expect(withRemarkDestination(sub, 'technical', { ctx })).toBe(sub)
    expect(withRemarkDestination(point, 'sheet', { ctx: { match: OLD } })).toBe(point)
  })
})
