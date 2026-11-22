import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from '../../../domain/__tests__/fixtures/correctionsMatch'
import { applyPlanToEvents } from '../../../domain/manualCorrections'

const applied = vi.hoisted(() => ({ plans: [] }))
vi.mock('../../../services/corrections/applyCorrectionPlan', async (orig) => ({
  ...(await orig()),
  applyCorrectionPlan: async (plan) => { applied.plans.push(plan); return { addedIds: [], signaturesCleared: false } }
}))
// answer: null, the kit dialog as usual; true / false, answered here
const dialog = vi.hoisted(() => ({ answer: null, calls: [] }))
vi.mock('../../../ui/uiStore.js', async (orig) => {
  const real = await orig()
  return { ...real, confirmDialog: (opts) => (dialog.answer === null ? real.confirmDialog(opts) : (dialog.calls.push(opts), Promise.resolve(dialog.answer))) }
})

import CorrectionsPanel from '../CorrectionsPanel.jsx'
import { resetGhostClickGuard } from '../../../hooks/useConfirmAction'
import { db } from '../../../db/db'

const HOME_PLAYERS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ id: n, number: n, name: `Home ${n}` }))
const AWAY_PLAYERS = [11, 12, 13, 14, 15, 16, 17, 18].map(n => ({ id: 100 + n, number: n, name: `Away ${n}` }))

function setup({ events: evs, sets: st, mode = 'review', liveSetIndex = null, match = MATCH } = {}) {
  const built = buildMatch({
    sets: [{ points: pointsFor(25, 20), finished: true }, { points: pointsFor(25, 18), finished: true }]
  })
  const props = {
    mode,
    matchId: 1,
    events: evs || built.events,
    match,
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
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Team' })).getByRole('radio', { name: /Volley Talberg/ }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Sanction' })).getByRole('radio', { name: /Delay warning/ }))
    expect(screen.getByText(/^Delay warning — Team · Volley Talberg \(B\) · Set 2 · B 0:0 A$/)).toBeTruthy()
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
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Team' })).getByRole('radio', { name: /VC Seehafen/ }))
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
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Team' })).getByRole('radio', { name: /Volley Talberg/ }))
    const select = screen.getByLabelText('At score')
    const option = [...select.options].find(o => o.textContent === 'B 10:12 A')
    fireEvent.change(select, { target: { value: option.value } })
    expect(screen.getByText('"T" at B 10:12 A in the time-out box of Volley Talberg, set 1.')).toBeTruthy()
    expect(screen.getByText('Time-out · Volley Talberg (B) · Set 1 · B 10:12 A')).toBeTruthy()
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
    fireEvent.click(screen.getByRole('radio', { name: /\+1.*Volley Talberg/ }))
    // 25:21 keeps VC Seehafen the winner
    expect(screen.getByText('Final score A 25:20 B becomes A 25:21 B.')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /\+1.*VC Seehafen/ }))
    expect(screen.getByText('A 26:20 B is not a possible final score of set 1.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm' }).disabled).toBe(true)
  })
})

describe('CorrectionsPanel: a correction after the sheet was signed (fe-home-options-1)', () => {
  beforeEach(async () => {
    applied.plans = []; dialog.calls = []; resetGhostClickGuard()
    await db.open()
    await db.matches.clear()
  })
  afterEach(() => { dialog.answer = null })

  const addDelayWarning = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add sanction' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Set' })).getByRole('radio', { name: 'Set 1' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Team' })).getByRole('radio', { name: /VC Seehafen/ }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Sanction' })).getByRole('radio', { name: /Delay warning/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
  }

  it('asks first; declined, nothing is written', async () => {
    await db.matches.put({ id: 1, status: 'ended', accountApprovals: { referee1: { id: 'a1', slot: 'referee1' } } })
    dialog.answer = false
    setup()
    addDelayWarning()
    await vi.waitFor(() => expect(dialog.calls).toHaveLength(1))
    await new Promise(r => setTimeout(r, 20))
    expect(applied.plans).toHaveLength(0)
  })

  it('confirmed, the correction goes ahead', async () => {
    await db.matches.put({ id: 1, status: 'ended', ref1Signature: 'data:r1' })
    dialog.answer = true
    setup()
    addDelayWarning()
    await vi.waitFor(() => expect(applied.plans).toHaveLength(1))
    expect(dialog.calls).toHaveLength(1)
  })

  it('nothing signed: no question', async () => {
    await db.matches.put({ id: 1, status: 'ended' })
    dialog.answer = true
    setup()
    addDelayWarning()
    await vi.waitFor(() => expect(applied.plans).toHaveLength(1))
    expect(dialog.calls).toHaveLength(0)
  })
})

// Owner 22.11.2026: in a match with technical remarks the scorer is asked
// where a correction is noted (domain/technicalRemarks remarkDestination)
describe('CorrectionsPanel: where a correction is noted (technical remarks)', () => {
  beforeEach(() => { applied.plans = []; resetGhostClickGuard() })
  const TECH = { ...MATCH, remarksModel: 2 }
  const addDelayWarning = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add sanction' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Set' })).getByRole('radio', { name: 'Set 2' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Team' })).getByRole('radio', { name: /Volley Talberg/ }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Sanction' })).getByRole('radio', { name: /Delay warning/ }))
  }
  const destination = () => within(screen.getByTestId('remark-destination')).getByRole('radiogroup', { name: 'Where is this noted?' })

  it('a correction is a technical remark by default: nothing on the sheet', async () => {
    setup({ match: TECH })
    addDelayWarning()
    expect(within(destination()).getByRole('radio', { name: 'Technical remark (not printed)' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByTestId('remark-destination-line')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await vi.waitFor(() => expect(applied.plans).toHaveLength(1))
    expect(applied.plans[0].remarkAdd).toEqual([])
    expect(applied.plans[0].log.remarkTo).toBe('technical')
  })

  it('"Remark on the scoresheet": an editable line goes on the sheet with it', async () => {
    setup({ match: TECH })
    addDelayWarning()
    fireEvent.click(within(destination()).getByRole('radio', { name: 'Remark on the scoresheet' }))
    const line = screen.getByTestId('remark-destination-line')
    expect(line.value).toMatch(/^Team B, Set 2: Added: Delay warning .* \(manual correction\)\.$/)
    fireEvent.change(line, { target: { value: 'Team B, Set 2: delay warning added after the match (manual correction).' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await vi.waitFor(() => expect(applied.plans).toHaveLength(1))
    expect(applied.plans[0].remarkAdd).toEqual(['Team B, Set 2: delay warning added after the match (manual correction).'])
    expect(applied.plans[0].log).toMatchObject({ remarkTo: 'sheet', sheetLine: 'Team B, Set 2: delay warning added after the match (manual correction).' })
  })

  it('the scorer\'s own remark: on the sheet by default, or a technical remark', async () => {
    setup({ match: TECH })
    fireEvent.click(screen.getByRole('button', { name: 'Add remark' }))
    fireEvent.change(document.getElementById('ov-corr-remark'), { target: { value: 'Ball pump broken' } })
    expect(within(destination()).getByRole('radio', { name: 'Remark on the scoresheet' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(destination()).getByRole('radio', { name: 'Technical remark (not printed)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await vi.waitFor(() => expect(applied.plans).toHaveLength(1))
    expect(applied.plans[0].remarkAdd).toEqual([])
    expect(applied.plans[0].log).toMatchObject({ action: 'technicalRemark', category: 'technical', text: 'Technical remark: "Ball pump broken"' })
  })

  it('a remark the rules want is locked to the sheet', async () => {
    setup({ match: TECH })
    fireEvent.click(screen.getByRole('button', { name: 'Add remark' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Kind of remark' })).getByRole('radio', { name: 'Protest' }))
    expect(screen.getByTestId('remark-destination-locked').textContent).toBe('The rules require this on the scoresheet.')
    expect(screen.queryByTestId('remark-destination')).toBeNull()
  })

  it('an older match (no remarks model) is not asked', () => {
    setup()
    addDelayWarning()
    expect(screen.queryByTestId('remark-destination')).toBeNull()
    expect(screen.queryByTestId('remark-destination-locked')).toBeNull()
  })

  it('the correction log is the list of the technical remarks', () => {
    const built = buildMatch({ sets: [{ points: pointsFor(25, 20), finished: true }] })
    const events = [...built.events, { id: 'b1', setIndex: 1, seq: 999, ts: '2026-11-22T19:00:00Z', type: 'bench_injury', payload: { team: 'home', playerNumber: 4, autoRemark: 'Set 1, 20:00, A 3:2, #4 injured (bench)', remarkTo: 'technical' } }]
    setup({ match: { ...TECH, manualChanges: [{ ts: '2026-11-22T18:00:00Z', category: 'technical', action: 'technicalRemark', text: 'Ball pump broken' }] }, events, sets: built.sets })
    expect(screen.getByText('Technical remarks')).toBeTruthy()
    expect(screen.getAllByTestId('technical-remark').map(n => n.textContent.replace(/^\d{2}:\d{2}/, ''))).toEqual(['Set 1, 20:00, A 3:2, #4 injured (bench)', 'Ball pump broken'])
  })
})
