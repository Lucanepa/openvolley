// Every entry is correctable (owner 2026-10-29): the panel offers Edit and
// Remove on every entry, a starting line-up after rallies, a point's team,
// a libero replacement, the coin toss and a player's number, lists what no
// longer fits and never refuses.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from '../../../domain/__tests__/fixtures/correctionsMatch'
import { applyPlanToEvents } from '../../../domain/manualCorrections'
import { compareBySeq } from '../../../domain/describe'

const applied = vi.hoisted(() => ({ plans: [] }))
vi.mock('../../../services/corrections/applyCorrectionPlan', () => ({
  applyCorrectionPlan: async (plan) => { applied.plans.push(plan); return { addedIds: [], signaturesCleared: false } }
}))
vi.mock('../../../ui/uiStore.js', async (importOriginal) => ({ ...(await importOriginal()), confirmDialog: async () => true }))

import CorrectionsPanel from '../CorrectionsPanel.jsx'
import { resetGhostClickGuard } from '../../../hooks/useConfirmAction'

const HOME_PLAYERS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ id: n, number: n, name: `Home ${n}`, libero: n === 9 ? 'libero1' : '' }))
const AWAY_PLAYERS = [11, 12, 13, 14, 15, 16, 17, 18, 20].map(n => ({ id: 100 + n, number: n, name: `Away ${n}`, libero: n === 20 ? 'libero1' : '' }))
const REVIEW_MATCH = { ...MATCH, status: 'live' }

function setup({ extras1 = [], mode = 'review', liveSetIndex = null } = {}) {
  const built = buildMatch({
    sets: [{ points: pointsFor(25, 20), finished: true, extras: extras1 }, { points: pointsFor(12, 10), finished: false }]
  })
  const props = {
    mode, matchId: 1, events: built.events, match: REVIEW_MATCH, sets: built.sets,
    homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, homePlayers: HOME_PLAYERS, awayPlayers: AWAY_PLAYERS, liveSetIndex,
    hooks: {}
  }
  const utils = render(<CorrectionsPanel {...props} />)
  return { ...utils, props }
}

function openLog() {
  const details = document.querySelector('details')
  details.open = true
  fireEvent(details, new Event('toggle'))
}

const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

describe('Corrections: every entry correctable', () => {
  beforeEach(() => { cleanup(); applied.plans = []; resetGhostClickGuard(); localStorage.clear() })

  it('the advanced log offers Edit and Remove on the coin toss, starting line-ups and points; derived rows are automatic', () => {
    setup()
    openLog()
    expect(screen.getByRole('button', { name: 'Edit Coin toss' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove Coin toss' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Edit Starting line-up' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Remove Starting line-up' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: /^Edit Point for / }).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('switch'))
    expect(screen.getAllByText('Automatic').length).toBeGreaterThan(0)
  })

  it('changes the team of a point; the rotations after it are recalculated in the same plan', async () => {
    const { props } = setup()
    openLog()
    // oldest first: the first point of set 1
    fireEvent.click(screen.getByRole('button', { name: 'Oldest first' }))
    fireEvent.click(screen.getAllByRole('button', { name: /^Edit Point for / })[0])
    expect(screen.getByRole('heading', { name: 'Edit point' })).toBeTruthy()
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Point to' })).getByRole('radio', { name: /Volley Bern/ }))
    expect(screen.getByText(/goes to Volley Bern \(B\); the serve, the rotations and the score after it are recalculated\./)).toBeTruthy()
    confirm()
    await vi.waitFor(() => expect(applied.plans).toHaveLength(1))
    const plan = applied.plans[0]
    const first = props.events.filter(e => e.type === 'point' && e.setIndex === 1).sort(compareBySeq)[0]
    expect(plan.update.find(u => u.id === first.id).changes.payload.team).toBe('away')
    // later rows were rewritten too (the serve order changed)
    expect(plan.update.length + plan.add.length + plan.remove.length).toBeGreaterThan(3)
    expect(plan.log.text).toMatch(/^Changed: Point for Volley Bern/)
  })

  it('a starting line-up after rallies: six position pickers, every later rotation follows', async () => {
    const { props } = setup()
    // set 1, VC Smash: the first "Fix the line-up" of the Line-up card
    fireEvent.click(screen.getAllByRole('button', { name: 'Fix the line-up' })[0])
    expect(screen.getByRole('heading', { name: 'Starting line-up' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('VI'), { target: { value: '8' } })
    confirm()
    await vi.waitFor(() => expect(applied.plans).toHaveLength(1))
    const after = applyPlanToEvents(props.events, applied.plans[0])
    const homeSet1 = after.filter(e => e.type === 'lineup' && e.setIndex === 1 && e.payload.team === 'home')
    expect(homeSet1.every(e => Object.values(e.payload.lineup).map(String).includes('8'))).toBe(true)
    expect(homeSet1.some(e => Object.values(e.payload.lineup).map(String).includes('6'))).toBe(false)
    expect(applied.plans[0].log.text).toBe('Line-up of VC Smash in set 1 changed: 1 · 2 · 3 · 4 · 5 · 6 → 1 · 2 · 3 · 4 · 5 · 8 (entered after the match)')
  })

  it('a player number: a number of the same team is refused with its owner, a free one goes through', async () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Change a number' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Team' })).getByRole('radio', { name: /VC Smash/ }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Player' })).getByRole('radio', { name: /#5/ }))
    const input = screen.getByLabelText('New number')
    fireEvent.change(input, { target: { value: '6' } })
    expect(screen.getByText('#6 is already the number of Home 6 (VC Smash). Choose another number.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm' }).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '15' } })
    expect(screen.getByText(/^#5 becomes #15 in the roster and in every entry of the match/)).toBeTruthy()
    confirm()
    await vi.waitFor(() => expect(applied.plans).toHaveLength(1))
    expect(applied.plans[0].log.text).toBe('Player #5 of VC Smash renumbered to #15 (entered after the match)')
    expect(applied.plans[0].playerUpdates).toEqual([{ id: 5, changes: { number: 15 } }])
  })

  it('removing a substitution whose player comes back lists the later one under "Check these entries"', async () => {
    const extras1 = [
      { at: 5, type: 'substitution', payload: { team: 'home', playerOut: 2, playerIn: 7 } },
      { at: 15, type: 'substitution', payload: { team: 'home', playerOut: 7, playerIn: 2 } }
    ]
    const { props, rerender } = setup({ extras1 })
    const firstSub = props.events.find(e => e.type === 'substitution' && e.payload.playerIn === 7)
    fireEvent.click(screen.getAllByRole('button', { name: /^Remove Substitution/ })[0])
    await vi.waitFor(() => expect(applied.plans).toHaveLength(1))
    const plan = applied.plans[0]
    expect(plan.remove).toContain(firstSub.id)
    expect(plan.newIssues.map(i => i.key)).toContain('corrections.issue.subOutNotOnCourt')
    // the host re-reads the log: the panel lists the entry to fix, with its Edit
    rerender(<CorrectionsPanel {...props} events={applyPlanToEvents(props.events, plan)} />)
    const list = await screen.findByTestId('corrections-issues')
    expect(within(list).getByText(/substitution of VC Smash, #2 for #7: #7 is not on court\./)).toBeTruthy()
    expect(within(list).getByRole('button', { name: /^Edit Substitution/ })).toBeTruthy()
  })

  it('a libero replacement has Edit and Remove; the edit picks the replaced player on court', async () => {
    const { props } = setup({ extras1: [{ at: 0, type: 'libero_entry', payload: { team: 'home', playerOut: 5, liberoIn: 9 } }] })
    const card = screen.getByText('Libero').closest('.ov-kit')
    fireEvent.click(within(card).getByRole('button', { name: /^Edit Libero #9 in for #5/ }))
    expect(screen.getByRole('heading', { name: 'Edit libero replacement' })).toBeTruthy()
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Player replaced (on court)' })).getByRole('radio', { name: /#6/ }))
    confirm()
    await vi.waitFor(() => expect(applied.plans).toHaveLength(1))
    const entry = props.events.find(e => e.type === 'libero_entry')
    expect(applied.plans[0].update.find(u => u.id === entry.id).changes.payload).toMatchObject({ playerOut: 6, position: 'VI' })
  })

  it('the coin toss: who serves first changed, every rotation rebuilt', async () => {
    setup()
    const card = screen.getByText('Coin toss').closest('.ov-kit')
    expect(within(card).getByText('Team A: VC Smash · Serves first in set 1: VC Smash (A)')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Serves first in set 1' })).getByRole('radio', { name: /Volley Bern/ }))
    confirm()
    await vi.waitFor(() => expect(applied.plans).toHaveLength(1))
    const plan = applied.plans[0]
    expect(plan.matchPatch).toMatchObject({ firstServe: 'away', coinTossServeA: false })
    expect(plan.update.length).toBeGreaterThan(10)
  })

  it('live: "Change who serves first" is a planned correction with the rotations rebuilt', async () => {
    setup({ mode: 'live', liveSetIndex: 2 })
    fireEvent.click(screen.getByRole('button', { name: 'Change who serves first' }))
    await vi.waitFor(() => expect(applied.plans).toHaveLength(1))
    expect(applied.plans[0].matchPatch).toMatchObject({ firstServe: 'away' })
    expect(applied.plans[0].log.action).toBe('coinToss')
  })
})
