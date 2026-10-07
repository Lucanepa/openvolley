import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from '../../../domain/__tests__/fixtures/correctionsMatch'
import { applyPlanToEvents } from '../../../domain/manualCorrections'

const applied = vi.hoisted(() => ({ plans: [] }))
vi.mock('../../../services/corrections/applyCorrectionPlan', () => ({
  applyCorrectionPlan: async (plan) => { applied.plans.push(plan); return { addedIds: [], signaturesCleared: false } }
}))

import CorrectionsPanel from '../CorrectionsPanel.jsx'
import { resetGhostClickGuard } from '../../../hooks/useConfirmAction'

const HOME_PLAYERS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ id: n, number: n, name: `Home ${n}` }))
const AWAY_PLAYERS = [11, 12, 13, 14, 15, 16, 17, 18].map(n => ({ id: 100 + n, number: n, name: `Away ${n}` }))

function setup({ events: evs, sets: st, mode = 'review', liveSetIndex = null } = {}) {
  const built = buildMatch({
    sets: [{ points: pointsFor(25, 20), finished: true }, { points: pointsFor(25, 18), finished: true }]
  })
  const props = {
    mode,
    matchId: 1,
    events: evs || built.events,
    match: MATCH,
    sets: st || built.sets,
    homeTeam: HOME_TEAM,
    awayTeam: AWAY_TEAM,
    homePlayers: HOME_PLAYERS,
    awayPlayers: AWAY_PLAYERS,
    liveSetIndex
  }
  const utils = render(<CorrectionsPanel {...props} />)
  return { ...utils, props }
}

describe('CorrectionsPanel (review mode)', () => {
  // A confirm swallows the clicks of the next moment (useConfirmAction)
  beforeEach(() => { applied.plans = []; resetGhostClickGuard() })

  it('shows an Add button on every list, also when the list is empty', () => {
    setup()
    for (const label of ['Add time-out', 'Add substitution', 'Add sanction', 'Add remark']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
    expect(screen.getByText('No time-outs recorded.')).toBeTruthy()
    expect(screen.getByText('No sanctions recorded.')).toBeTruthy()
  })

  it('adds a sanction with an explicit set and lists it as "Delay warning — Team"', async () => {
    const { props, rerender } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Add sanction' }))
    // at the match end the set is chosen explicitly
    expect(screen.getByText('Fill in the fields above.')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Set' })).getByRole('radio', { name: 'Set 2' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Team' })).getByRole('radio', { name: /Volley Bern/ }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Sanction' })).getByRole('radio', { name: /Delay warning/ }))
    expect(screen.getByText(/^Delay warning — Team · Volley Bern \(B\) · Set 2 · B 0:0 A$/)).toBeTruthy()
    expect(screen.getByText('D in the Warning column · Team B · Set 2 · B 0:0 A')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await vi.waitFor(() => expect(applied.plans).toHaveLength(1))
    const plan = applied.plans[0]
    expect(plan.add[0]).toMatchObject({ type: 'sanction', setIndex: 2, payload: { team: 'away', type: 'delay_warning' } })

    // the host re-reads the log: the row reads in words, not "delay_warning : #"
    const after = applyPlanToEvents(props.events, plan).map(e => (e.tempKey ? { ...e, id: 999 } : e))
    rerender(<CorrectionsPanel {...props} events={after} />)
    const row = await screen.findByText('Delay warning — Team')
    expect(row).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/delay_warning|: #/)
  })

  it('a double tap on Confirm writes the correction once', async () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Add sanction' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Set' })).getByRole('radio', { name: 'Set 1' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Team' })).getByRole('radio', { name: /VC Smash/ }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Sanction' })).getByRole('radio', { name: /Delay warning/ }))
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await vi.waitFor(() => expect(applied.plans).toHaveLength(1))
    await new Promise(r => setTimeout(r, 20))
    expect(applied.plans).toHaveLength(1)
  })

  it('adding a time-out previews the score it is written at', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Add time-out' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Set' })).getByRole('radio', { name: 'Set 1' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Team' })).getByRole('radio', { name: /Volley Bern/ }))
    const select = screen.getByLabelText('At score')
    const option = [...select.options].find(o => o.textContent === 'B 10:12 A')
    fireEvent.change(select, { target: { value: option.value } })
    expect(screen.getByText('"T" at B 10:12 A in the time-out box of Volley Bern, set 1.')).toBeTruthy()
    expect(screen.getByText('Time-out · Volley Bern (B) · Set 1 · B 10:12 A')).toBeTruthy()
  })

  it('set times: kit time fields, nothing to save until a time changes, then the new times', async () => {
    setup()
    fireEvent.click(screen.getAllByRole('button', { name: 'Set times' })[0])
    const start = document.getElementById('ov-corr-start')
    expect(start.type).toBe('text')
    // the stored times have seconds: an untouched form is not a change
    expect(screen.getByText('Fill in the fields above.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm' }).disabled).toBe(true)
    // ten minutes before the recorded end, in whatever time zone the test runs
    const [eh, em] = document.getElementById('ov-corr-end').value.split(':').map(Number)
    const mins = eh * 60 + em - 10
    const want = [Math.floor(mins / 60), mins % 60]
    fireEvent.change(start, { target: { value: want.map(n => String(n).padStart(2, '0')).join(':') } })
    expect(screen.getByRole('button', { name: 'Confirm' }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await vi.waitFor(() => expect(applied.plans).toHaveLength(1))
    const changes = applied.plans[0].setUpdates[0].changes
    expect(Object.keys(changes)).toEqual(['startTime'])
    const d = new Date(changes.startTime)
    expect([d.getHours(), d.getMinutes()]).toEqual(want)
  })

  it('the score of a final-score correction is never typed: +1 / -1 at the set end only', () => {
    setup()
    const firstSet = screen.getAllByRole('button', { name: 'Correct final score' })[0]
    fireEvent.click(firstSet)
    fireEvent.click(screen.getByRole('radio', { name: /\+1.*Volley Bern/ }))
    // 25:21 keeps VC Smash the winner
    expect(screen.getByText('Final score A 25:20 B becomes A 25:21 B.')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /\+1.*VC Smash/ }))
    expect(screen.getByText('A 26:20 B is not a possible final score of set 1.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm' }).disabled).toBe(true)
  })
})
