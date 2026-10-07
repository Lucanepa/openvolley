import { describe, it, expect } from 'vitest'
import {
  sanitizeActivityData, matchUpdateEntries, setUpdateEntry, stackFrames, eventActivityData, historyKind,
  activityCategory, ACTIVITY_KINDS, ACTIVITY_KIND_RE, activityLine
} from '../activitySummary'

describe('sanitizeActivityData', () => {
  it('keeps the allowlisted keys of the kind only', () => {
    expect(sanitizeActivityData('event.add', { type: 'point', team: 'home', scoreA: 3, scoreB: 2, stateSnapshot: { x: 1 }, extra: 1 }))
      .toEqual({ type: 'point', team: 'home', scoreA: 3, scoreB: 2 })
    expect(sanitizeActivityData('nope.kind', { a: 1 })).toEqual({})
  })

  it('never keeps PINs, tokens, signatures, dates of birth or data URLs, at any depth', () => {
    const out = sanitizeActivityData('match.manual_change', {
      category: 'roster',
      field: 'name',
      before: 'data:image/png;base64,AAAA',
      after: ['header', 'claims', 'signature'].map(p => `${p}${'x'.repeat(12)}`).join('.') // a JWT shape
    })
    expect(out).toEqual({ category: 'roster', field: 'name' })
    expect(sanitizeActivityData('sync.error', { resource: 'match', code: { gamePin: '1234', ok: 1 } })).toEqual({ resource: 'match', code: { ok: 1 } })
  })

  it('a manual change of a date of birth (or any sensitive field) says "changed"', () => {
    expect(sanitizeActivityData('match.manual_change', { category: 'player', field: 'dob', before: '01.02.2003', after: '02.02.2003' }))
      .toEqual({ category: 'player', field: 'dob', before: 'changed', after: 'changed' })
  })

  it('cuts strings to 200 characters and the whole data to 4 KB', () => {
    const out = sanitizeActivityData('app.error', { message: 'x'.repeat(500), frames: Array.from({ length: 50 }, (_, i) => `a${i}.js:${i}`) })
    expect(out.message).toHaveLength(200)
    expect(out.frames).toHaveLength(20)
    expect(new TextEncoder().encode(JSON.stringify(out)).length).toBeLessThanOrEqual(4096)
  })

  it('every kind is a dotted lower-case name', () => {
    for (const k of Object.keys(ACTIVITY_KINDS)) expect(k).toMatch(ACTIVITY_KIND_RE)
  })
})

describe('match row entries', () => {
  it('status, close, signature, remarks length, approval method, forfeit', () => {
    const row = { status: 'live', remarks: 'a', homeCoachSignature: null, accountApprovals: null, updatedAt: 1 }
    expect(matchUpdateEntries({ status: 'ended', updatedAt: 2 }, row)).toEqual([{ kind: 'match.status', data: { from: 'live', to: 'ended' } }])
    expect(matchUpdateEntries({ status: 'approved' }, { status: 'ended' })[0].kind).toBe('match.close')
    expect(matchUpdateEntries({ homeCoachSignature: 'data:image/png;base64,xx' }, row)).toEqual([{ kind: 'match.signature', data: { role: 'homeCoach', signed: true } }])
    expect(matchUpdateEntries({ remarks: 'secret words here' }, row)).toEqual([{ kind: 'match.remarks', data: { length: 17 } }])
    expect(matchUpdateEntries({ accountApprovals: { scorer: { method: 'pin', pin: '1234' } } }, row))
      .toEqual([{ kind: 'match.approval', data: { role: 'scorer', approved: true, method: 'pin' } }])
    expect(matchUpdateEntries({ forfeitTeam: 'away', forfeitReason: 'no show' }, row))
      .toEqual([{ kind: 'match.forfeit', data: { team: 'away', forfeit: true, stopped: false } }])
    // bookkeeping and unchanged values are nothing
    expect(matchUpdateEntries({ updatedAt: 3, refereeHeartbeat: 4, status: 'live' }, row)).toEqual([])
  })

  it('one entry per new manual change, one coin toss entry', () => {
    const row = { manualChanges: [{ category: 'a', field: 'f', before: 1, after: 2 }] }
    const mods = { manualChanges: [...row.manualChanges, { category: 'roster', field: 'number', before: '7', after: '8' }, { category: 'set', field: 'score', before: '25:20', after: '25:21' }] }
    expect(matchUpdateEntries(mods, row).map(e => e.data.field)).toEqual(['number', 'score'])
    const ct = matchUpdateEntries({ coinTossTeamA: 'home', coinTossServeA: true, coinTossConfirmed: true }, {})
    expect(ct).toEqual([{ kind: 'match.coin_toss', data: { keys: ['coinTossTeamA', 'coinTossServeA', 'coinTossConfirmed'], confirmed: true } }])
  })

  it('set end and reopen', () => {
    expect(setUpdateEntry({ finished: true, homePoints: 25 }, { index: 2, finished: false, homePoints: 24, awayPoints: 20 }))
      .toEqual({ kind: 'set.end', data: { set: 2, home: 25, away: 20 } })
    expect(setUpdateEntry({ finished: false }, { index: 2, finished: true }).kind).toBe('set.reopen')
    expect(setUpdateEntry({ homePoints: 3 }, { index: 1 })).toBeNull()
  })
})

describe('events and errors', () => {
  it('event data from the row and its snapshot', () => {
    expect(eventActivityData({ type: 'substitution', seq: 12, setIndex: 2, payload: { team: 'away', playerIn: 9, playerOut: 4 }, stateSnapshot: { pointsA: 10, pointsB: 12 } }))
      .toEqual({ type: 'substitution', seq: 12, set: 2, team: 'away', playerIn: 9, playerOut: 4, scoreA: 10, scoreB: 12 })
    expect(eventActivityData({ type: 'sanction', seq: 3, setIndex: 1, payload: { team: 'home', type: 'warning', playerNumber: 5 } }))
      .toMatchObject({ sanction: 'warning', player: 5 })
    expect(historyKind({ op: 'void', reason: 'undo' })).toBe('event.undo')
    expect(historyKind({ op: 'void', reason: 'decision_change' })).toBe('event.delete')
    expect(historyKind({ op: 'edit' })).toBe('event.edit')
  })

  it('stack frames are file:line only', () => {
    const stack = 'TypeError: x\n    at f (https://app.openvolley.app/assets/Scoreboard-abc.js?v=1:12:34)\n    at g (webpack:///src/App.jsx:99:1)'
    expect(stackFrames(stack)).toEqual(['Scoreboard-abc.js:12', 'App.jsx:99'])
  })

  it('categories and list lines', () => {
    expect(activityCategory('event.undo')).toBe('correction')
    expect(activityCategory('sync.state', 'error')).toBe('error')
    expect(activityLine({ kind: 'event.add', data: { type: 'point', team: 'home', scoreA: 3, scoreB: 1 } })).toBe('point home 3:1')
  })
})
