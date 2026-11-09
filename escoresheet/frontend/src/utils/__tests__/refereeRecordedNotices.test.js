import { describe, it, expect } from 'vitest'
import { createRecordedNoticeTracker, describeNotice, noticeKeys } from '../refereeRecordedNotices.js'

const T0 = Date.parse('2026-11-09T18:00:00Z')
const ev = (seq, type, payload = {}, setIndex = 1) => ({ seq, type, setIndex, ts: new Date(T0 + seq * 1000).toISOString(), payload })
const point = (seq, team) => ev(seq, 'point', { team })
const base = [ev(1, 'lineup', { team: 'home' }), point(2, 'home'), point(3, 'away')]
const ctx = {
  match: { coinTossTeamA: 'home', bestOf: 5 },
  homeTeam: { name: 'VC Smash', color: '#ef4444' },
  awayTeam: { name: 'Volley Bern', color: '#3b82f6' }
}

describe('noticeKeys', () => {
  it('keeps time-outs, substitutions and sanctions only', () => {
    const keys = noticeKeys([...base, ev(4, 'timeout', { team: 'home' }), ev(5, 'libero_entry', { team: 'home' }),
      ev(6, 'substitution', { team: 'away', playerIn: 12, playerOut: 7 }), ev(7, 'sanction', { team: 'home', type: 'warning', playerNumber: 8 })])
    expect([...keys.values()].map(e => e.type)).toEqual(['timeout', 'substitution', 'sanction'])
  })

  it('numbers equal events (legacy time-out counts carry no time)', () => {
    const keys = noticeKeys([{ type: 'timeout', payload: { team: 'home' } }, { type: 'timeout', payload: { team: 'home' } }])
    expect(keys.size).toBe(2)
  })
})

describe('createRecordedNoticeTracker', () => {
  it('announces nothing on the first list (opening or reloading the match)', () => {
    const tr = createRecordedNoticeTracker()
    expect(tr.update([...base, ev(4, 'timeout', { team: 'home' })], { scope: 'm|relay', setIndex: 1 }).added).toEqual([])
  })

  it('announces what is new, in recording order, all of it in one update', () => {
    const tr = createRecordedNoticeTracker()
    tr.update(base, { scope: 'm|relay', setIndex: 1 })
    const { added } = tr.update([...base,
      ev(5, 'sanction', { team: 'away', type: 'delay_warning' }),
      ev(4, 'timeout', { team: 'home' }),
      ev(6, 'substitution', { team: 'home', playerIn: 9, playerOut: 3, isExceptional: true })
    ], { scope: 'm|relay', setIndex: 1 })
    expect(added.map(a => a.event.type)).toEqual(['timeout', 'sanction', 'substitution'])
  })

  it('announces an event once, however often the list is loaded again', () => {
    const tr = createRecordedNoticeTracker()
    tr.update(base, { scope: 'm|relay', setIndex: 1 })
    const list = [...base, ev(4, 'timeout', { team: 'home' })]
    expect(tr.update(list, { scope: 'm|relay', setIndex: 1 }).added).toHaveLength(1)
    // the same list again, its times now epoch ms (another copy of the bundle)
    const again = list.map(e => ({ ...e, ts: Date.parse(e.ts) }))
    expect(tr.update(again, { scope: 'm|relay', setIndex: 1 }).added).toEqual([])
  })

  it('reports an undone event as removed', () => {
    const tr = createRecordedNoticeTracker()
    tr.update(base, { scope: 'm|relay', setIndex: 1 })
    const { added } = tr.update([...base, ev(4, 'timeout', { team: 'home' })], { scope: 'm|relay', setIndex: 1 })
    expect(tr.update(base, { scope: 'm|relay', setIndex: 1 }).removed).toEqual([added[0].key])
  })

  it('removes nothing when the set changed (a live-state row empties its time-outs)', () => {
    const tr = createRecordedNoticeTracker()
    tr.update([...base, ev(4, 'timeout', { team: 'home' })], { scope: 'm|live_state', setIndex: 1 })
    expect(tr.update(base, { scope: 'm|live_state', setIndex: 2 }).removed).toEqual([])
  })

  it('does not re-announce the match sanctions of a live-state row at a new set', () => {
    const tr = createRecordedNoticeTracker()
    const sanction = (set) => ({ type: 'sanction', setIndex: set, ts: T0, payload: { team: 'home', type: 'warning', playerNumber: 8 } })
    tr.update([...base, sanction(1)], { scope: 'm|live_state', setIndex: 1 })
    expect(tr.update([...base, sanction(2)], { scope: 'm|live_state', setIndex: 2 }).added).toEqual([])
  })

  it('starts a new baseline when the source changes, and skips an empty list', () => {
    const tr = createRecordedNoticeTracker()
    tr.update(base, { scope: 'm|relay', setIndex: 1 })
    expect(tr.update([], { scope: 'm|relay', setIndex: 1 }).added).toEqual([])
    expect(tr.update([...base, ev(4, 'timeout', { team: 'home' })], { scope: 'm|live_state', setIndex: 1 }).added).toEqual([])
  })
})

describe('describeNotice', () => {
  it('a time-out: the team, its set and the score with that team first', () => {
    const e = ev(4, 'timeout', { team: 'away' })
    const n = describeNotice('k', e, [...base, e], ctx)
    expect(n).toMatchObject({ kind: 'timeout', title: 'Time-out', detail: '', setLabel: 'Set 1', score: 'B 1:1 A', tone: 'timeout' })
    expect(n.team).toMatchObject({ name: 'Volley Bern', letter: 'B' })
  })

  it('an exceptional substitution, from a relay event or a live-state one', () => {
    const relay = describeNotice('k', ev(4, 'substitution', { team: 'home', playerIn: 9, playerOut: 3, isExceptional: true }), base, ctx)
    expect(relay).toMatchObject({ title: 'Exceptional substitution', detail: '#9 in for #3', exceptional: true, tone: 'exceptional' })
    const row = describeNotice('k', { type: 'substitution', setIndex: 2, payload: { team: 'home', playerIn: 9, playerOut: 3, exceptional: true } }, [], { ...ctx, score: { home: 4, away: 2 } })
    expect(row).toMatchObject({ title: 'Exceptional substitution', setLabel: 'Set 2', score: 'A 4:2 B' })
  })

  it('a penalty: the card, who got it and the point to the other team', () => {
    const n = describeNotice('k', ev(4, 'sanction', { team: 'home', type: 'penalty', playerType: 'player', playerNumber: 8 }), base, ctx)
    expect(n).toMatchObject({ title: 'Penalty', detail: 'Player #8 · +1 point to Volley Bern', tone: 'red' })
  })

  it('team sanctions name no person', () => {
    expect(describeNotice('k', ev(4, 'sanction', { team: 'away', type: 'delay_warning' }), base, ctx)).toMatchObject({ title: 'Delay warning', detail: '', tone: 'yellow' })
    expect(describeNotice('k', ev(4, 'sanction', { team: 'away', type: 'improper_request' }), base, ctx)).toMatchObject({ title: 'Improper request', detail: '' })
  })

  it('an official, an expulsion and a disqualification', () => {
    expect(describeNotice('k', ev(4, 'sanction', { team: 'home', type: 'warning', playerType: 'official', role: 'Coach' }), base, ctx)).toMatchObject({ detail: 'Coach', tone: 'yellow' })
    expect(describeNotice('k', ev(4, 'sanction', { team: 'home', type: 'expulsion', playerNumber: 5 }), base, ctx).tone).toBe('redYellow')
    expect(describeNotice('k', ev(4, 'sanction', { team: 'home', type: 'disqualification', playerNumber: 5 }), base, ctx).tone).toBe('redYellowApart')
  })
})
