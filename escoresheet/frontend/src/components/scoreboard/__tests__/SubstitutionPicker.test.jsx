// The SUB box's substitution picker (owner 23.11.2026, mockup v9) as a view,
// and its model: in first, then out; only what `legalIns` (the Scoreboard's
// getAvailableSubstitutes) allows; a player in one pair at most; never past 6.
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import '../../../i18n'
import { SubstitutionPicker } from '../SubstitutionPicker'
import { SUB_DIALOG_COURT, subDialogModel } from '../subDialogModel'

// Team B, set 1: #6 -> #10 and #4 -> #11 made, libero #12 in for #3 at I
const COURT = [
  { position: 'I', number: '12', isLibero: true },
  { position: 'II', number: '10' },
  { position: 'III', number: '7' },
  { position: 'IV', number: '11' },
  { position: 'V', number: '1', isCaptain: true },
  { position: 'VI', number: '2' }
]
const BENCH = [
  { number: '4', cameOutFor: '11' },
  { number: '6', cameOutFor: '10' },
  { number: '8' },
  { number: '9' }
]
// the Scoreboard's lists: a substitute only for his starter, a starter only
// back for his substitute, the libero nobody
const LEGAL = { 10: ['6'], 11: ['4'], 7: ['8', '9'], 1: ['8', '9'], 2: ['8', '9'] }

const ids = (prefix) => [...document.querySelectorAll(`[data-testid^="${prefix}"]`)].map(b => b.dataset.testid.slice(prefix.length))
const tid = (id) => screen.queryByTestId(id)

function renderPicker(props = {}) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  const onInjury = vi.fn()
  render(<SubstitutionPicker side="right" court={COURT} bench={BENCH} legalIns={LEGAL} made={2} max={6} madeList={[]} captainNumbers={['1']} onConfirm={onConfirm} onCancel={onCancel} onInjury={onInjury} {...props} />)
  return { onConfirm, onCancel, onInjury }
}

describe('subDialogModel', () => {
  it('who may come in and whom he may replace, a player in one pair at most', () => {
    const m = subDialogModel({ court: COURT, bench: BENCH, legalIns: LEGAL, made: 2 })
    expect(m.ins.map(b => b.number)).toEqual(['4', '6', '8', '9'])
    expect(m.outsFor('4')).toEqual(['11'])
    expect(m.outsFor('8')).toEqual(['7', '1', '2'])
    // the libero is never offered, whatever the list says
    expect(subDialogModel({ court: COURT, bench: BENCH, legalIns: { ...LEGAL, 12: ['8'] }, made: 2 }).outsFor('8')).not.toContain('12')
    const paired = subDialogModel({ court: COURT, bench: BENCH, legalIns: LEGAL, made: 2, pending: [{ in: '8', out: '1' }] })
    expect(paired.ins.map(b => b.number)).toEqual(['4', '6', '9'])
    expect(paired.outsFor('9')).toEqual(['7', '2'])
    expect(paired.courtNow.find(c => c.position === 'V')).toMatchObject({ number: '8', incoming: true })
    expect(paired.total).toBe(3)
  })

  it('never past the 6 with the pairs waiting', () => {
    const five = subDialogModel({ court: COURT, bench: BENCH, legalIns: LEGAL, made: 5 })
    expect(five.canAdd).toBe(true)
    const six = subDialogModel({ court: COURT, bench: BENCH, legalIns: LEGAL, made: 5, pending: [{ in: '8', out: '1' }] })
    expect(six.canAdd).toBe(false)
    expect(six.ins).toEqual([])
    expect(six.outsFor('9')).toEqual([])
    expect(six.full).toBe(false)
    expect(subDialogModel({ court: COURT, bench: BENCH, legalIns: LEGAL, made: 6 }).full).toBe(true)
  })

  it('the court as on the scoreboard, as rows of two with the front row by the net', () => {
    expect(SUB_DIALOG_COURT.right).toEqual(['II', 'I', 'III', 'VI', 'IV', 'V'])
    expect(SUB_DIALOG_COURT.left).toEqual(['V', 'IV', 'VI', 'III', 'I', 'II'])
  })
})

describe('SubstitutionPicker', () => {
  it('in first: only the number, the substituted starter with the ↑ ↓ box of his substitute', () => {
    renderPicker()
    expect(tid('sub-dialog-step').textContent).toMatch(/Tap who comes in/)
    expect(ids('sub-dialog-in-')).toEqual(['4', '6', '8', '9'])
    expect(tid('sub-dialog-in-8').textContent).toBe('8')
    expect(tid('sub-dialog-in-4').textContent.replace(/\s/g, '')).toBe('4↑↓11')
    expect(tid('sub-dialog-count').textContent).toBe('2 of 6')
    // the court of the team on the right: II I / III VI / IV V, the net on its left
    const places = [...tid('sub-dialog-court').children].map(el => el.textContent.replace(/\s/g, ''))
    expect(places).toEqual(['10II', '12I', '7III', '2VI', '11IV', '1V'])
    expect(tid('sub-dialog-court').className).toMatch(/border-l-4/)
    expect(tid('sub-dialog-confirm').disabled).toBe(true)
  })

  it('the team on the left: V IV / VI III / I II, the net on its right', () => {
    renderPicker({ side: 'left' })
    const places = [...tid('sub-dialog-court').children].map(el => el.textContent.replace(/\s/g, ''))
    expect(places).toEqual(['1V', '11IV', '2VI', '7III', '12I', '10II'])
    expect(tid('sub-dialog-court').className).toMatch(/border-r-4/)
  })

  it('then out: only whom he may replace, the others and the libero leave empty places', () => {
    renderPicker()
    fireEvent.click(tid('sub-dialog-in-6'))
    expect(tid('sub-dialog-step').textContent).toMatch(/Tap who goes out for #6/)
    expect(ids('sub-dialog-out-')).toEqual(['10'])
    expect(tid('sub-dialog-court').children).toHaveLength(6)
    expect(tid('sub-dialog-court-12')).toBeNull()
    // another choice instead
    fireEvent.click(tid('sub-dialog-in-9'))
    expect(ids('sub-dialog-out-')).toEqual(['7', '2', '1'])
  })

  it('pairs: back to "who comes in" after each, Remove, Confirm hands them all over with their positions', () => {
    const { onConfirm } = renderPicker()
    fireEvent.click(tid('sub-dialog-in-8'))
    fireEvent.click(tid('sub-dialog-out-1'))
    expect(tid('sub-dialog-step').textContent).toMatch(/Tap who comes in/)
    expect(tid('sub-dialog-pair-8-1').textContent).toMatch(/3 ·#8 in for #1 out/)
    // the captain goes out
    expect(tid('sub-dialog-captain-note').textContent).toBe('after “Confirm”: pick the game captain')
    // #8 is in a pair, #1's place shows him coming in, not tappable
    expect(ids('sub-dialog-in-')).toEqual(['4', '6', '9'])
    fireEvent.click(tid('sub-dialog-in-9'))
    expect(ids('sub-dialog-out-')).toEqual(['7', '2'])
    fireEvent.click(tid('sub-dialog-out-2'))
    fireEvent.click(tid('sub-dialog-in-6'))
    fireEvent.click(tid('sub-dialog-out-10'))
    expect(tid('sub-dialog-count').textContent).toBe('2 of 6 · 3 to confirm')
    fireEvent.click(tid('sub-dialog-remove-9-2'))
    expect(tid('sub-dialog-count').textContent).toBe('2 of 6 · 2 to confirm')
    // with a pair waiting, Injury / exceptional waits
    expect(tid('sub-dialog-injury').disabled).toBe(true)
    fireEvent.click(tid('sub-dialog-confirm'))
    expect(onConfirm).toHaveBeenCalledWith([
      { in: '8', out: '1', position: 'V' },
      { in: '6', out: '10', position: 'II' }
    ])
  })

  it('5 made: one pair, then the bench says 6 of 6 and the court locks', () => {
    renderPicker({ made: 5 })
    fireEvent.click(tid('sub-dialog-in-8'))
    fireEvent.click(tid('sub-dialog-out-7'))
    expect(tid('sub-dialog-in-full').textContent).toBe('6 of 6 with the one below.')
    expect(ids('sub-dialog-in-').filter(n => /^\d+$/.test(n))).toEqual([])
    expect(ids('sub-dialog-out-')).toEqual([])
    expect(tid('sub-dialog-step')).toBeNull()
    expect(tid('sub-dialog-count').className).toMatch(/bg-red-100/)
    expect(tid('sub-dialog-confirm').disabled).toBe(false)
  })

  it('6 of 6: the note and Injury / exceptional, which takes the injured player', () => {
    const { onInjury } = renderPicker({ made: 6 })
    expect(tid('sub-dialog-full-note').textContent).toMatch(/^6 of 6: no regular substitution left this set/)
    expect(tid('sub-dialog-in-full').textContent).toBe('No regular substitution left.')
    fireEvent.click(tid('sub-dialog-injury'))
    expect(tid('sub-dialog-step').textContent).toMatch(/Tap the injured player/)
    // the libero's injury is his own ("unable to play" on the court menu)
    expect(tid('sub-dialog-injury-12')).toBeNull()
    fireEvent.click(tid('sub-dialog-injury-7'))
    expect(onInjury).toHaveBeenCalledWith({ position: 'III', number: '7' })
  })

  it('a replay pending: no regular substitution, the note', () => {
    renderPicker({ blockReason: 'replay_pending' })
    expect(tid('sub-dialog-block-note').textContent).toMatch(/Replay pending/)
    expect(ids('sub-dialog-in-').filter(n => /^\d+$/.test(n))).toEqual([])
    expect(tid('sub-dialog-confirm').disabled).toBe(true)
    expect(tid('sub-dialog-injury').disabled).toBe(false)
  })

  it('Made: the substitutions of the set', () => {
    renderPicker({ madeList: [{ index: 1, score: '4:9', position: 'II', playerOut: 6, playerIn: 10 }, { index: 2, score: '7:13', position: 'IV', playerOut: 4, playerIn: 11, exceptional: true }] })
    fireEvent.click(screen.getByRole('button', { name: 'Made (2)' }))
    expect(tid('sub-dialog-made').textContent).toMatch(/Substitution 1.*4:9.*Substitution 2/)
    expect(tid('sub-dialog-made').querySelectorAll('[data-sub-exceptional]')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'New' }))
    expect(tid('sub-dialog-step')).toBeTruthy()
  })

  it('Cancel', () => {
    const { onCancel, onConfirm } = renderPicker()
    fireEvent.click(tid('sub-dialog-in-8'))
    fireEvent.click(tid('sub-dialog-out-1'))
    fireEvent.click(tid('sub-dialog-cancel'))
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
