import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

// "Edit home / away roster" after the coin toss: one row per player and
// official (2026-10-20). Save still hands the Scoreboard the edited lists with
// the snapshots taken on opening; nothing about the data changed.

const tr = (key, a, b) => {
  const opts = typeof a === 'object' ? a : b
  const fallback = typeof a === 'string' ? a : opts?.defaultValue
  return String(fallback ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? ''))
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: tr, i18n: { language: 'en' } }) }))

import ReopenRosterModal from '../rosters/ReopenRosterModal'

const players = [
  { id: 2, number: 7, lastName: 'Fischer', firstName: 'Erik', dob: '09.02.1996', libero: '', isCaptain: false },
  { id: 1, number: 1, lastName: 'Keller', firstName: 'Luca', dob: '05.01.1998', libero: '', isCaptain: true },
  { id: 3, number: 12, lastName: 'Huber', firstName: 'Mauro', dob: '', libero: 'redesignated', isCaptain: false }
]
const bench = [{ role: 'Coach', firstName: 'Marco', lastName: 'Frei', dob: '15.05.1975' }]
const benchRoles = [{ value: 'Coach', key: 'coach' }, { value: 'Medic', key: 'medic' }]

function open(onSave = vi.fn(), idMode = 'dob') {
  render(
    <ReopenRosterModal
      teamKey="home" teamName="VBC Musterdorf" players={players} bench={bench}
      onSave={onSave} onClose={() => {}} t={tr} benchRoles={benchRoles}
      toISODate={(d) => (d ? d.split('.').reverse().join('-') : '')}
      idMode={idMode}
    />
  )
  return onSave
}

describe('ReopenRosterModal', () => {
  // Owner 2026-11-19: a Swiss match carries the licence (or a date of birth)
  it('a Swiss match: a Licence column of text fields, a licence or a date typed with its dots', () => {
    const onSave = open(vi.fn(), 'licence')
    const rows = within(screen.getAllByRole('list')[0]).getAllByRole('listitem')
    const value = within(rows[0]).getByLabelText('Licence')
    expect(value).toHaveAttribute('inputMode', 'text')
    expect(value).toHaveValue('05.01.1998')
    fireEvent.change(value, { target: { value: '123456' } })
    const coach = within(screen.getAllByRole('list')[1]).getByLabelText('Licence')
    fireEvent.change(coach, { target: { value: '1.2.1975' } })
    fireEvent.blur(coach)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    const [, edited, editedBench] = onSave.mock.calls[0]
    expect(edited.find(p => p.number === 1).dob).toBe('123456')
    expect(editedBench[0].dob).toBe('01.02.1975')
  })

  // Owner 2026-11-25 (tester: scorers looked for dates of birth): an (i) says
  // what the Licence column holds
  it('a Swiss match: the (i) beside Licence explains the column; not beside a date of birth', () => {
    open(vi.fn(), 'licence')
    const info = screen.getByRole('button', { name: 'What goes in the licence column' })
    fireEvent.click(info)
    expect(screen.getByTestId('licence-info').textContent).toMatch(/licence number identifies the player/)
    expect(screen.getByTestId('licence-info').textContent).toMatch(/dd\.mm\.yyyy/)
  })

  it('a match with dates of birth: no licence (i)', () => {
    open(vi.fn(), 'dob')
    expect(screen.queryByRole('button', { name: 'What goes in the licence column' })).toBeNull()
  })

  it('lists each player as one row, by number, and the officials', () => {
    open()
    const [playerList, benchList] = screen.getAllByRole('list')
    const rows = within(playerList).getAllByRole('listitem')
    expect(rows.map(r => within(r).getByLabelText('Player number').value)).toEqual(['1', '7', '12'])
    expect(within(rows[0]).getByRole('button', { name: 'Team captain #1' })).toHaveAttribute('aria-pressed', 'true')
    // a re-designated libero keeps its state
    expect(within(rows[2]).getByLabelText('Libero').value).toBe('redesignated')
    expect(within(benchList).getAllByRole('listitem')).toHaveLength(1)
  })

  it('saves the edited rows with the snapshots taken on opening', () => {
    const onSave = open()
    const rows = within(screen.getAllByRole('list')[0]).getAllByRole('listitem')
    fireEvent.change(within(rows[1]).getByLabelText('Last name'), { target: { value: 'Fischer-Meier' } })
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Team captain #1' }))
    fireEvent.click(within(rows[2]).getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Add bench official' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    const [teamKey, edited, editedBench, snapPlayers, snapBench] = onSave.mock.calls[0]
    expect(teamKey).toBe('home')
    expect(edited.map(p => [p.number, p.lastName, p.isCaptain])).toEqual([[1, 'Keller', false], [7, 'Fischer-Meier', false]])
    expect(editedBench).toHaveLength(2)
    expect(editedBench[1]).toEqual({ role: 'Coach', firstName: '', lastName: '', dob: '' })
    expect(snapPlayers).toEqual(players)
    expect(snapBench).toEqual(bench)
  })

  it('keeps Cancel / Save outside the scrolling lists', () => {
    open()
    const list = screen.getAllByRole('list')[0]
    const scroller = list.closest('.overflow-y-auto')
    expect(scroller).not.toBeNull()
    expect(scroller.contains(screen.getByRole('button', { name: 'Save changes' }))).toBe(false)
  })

  it('names a bench role by its code first (AC1 / AC2 stay apart when cut)', () => {
    open()
    const role = within(screen.getAllByRole('list')[1]).getByLabelText('Role')
    expect([...role.options].map(o => o.value)).toEqual(['Coach', 'Medic'])
    expect(role.options[0].textContent).toMatch(/^benchRolesShort\.coach - Coach$/)
  })

  it('every control in a row is 44 px tall', () => {
    open()
    const row = within(screen.getAllByRole('list')[0]).getAllByRole('listitem')[0]
    for (const el of row.querySelectorAll('input, select')) expect(el.className).toMatch(/\bh-11\b/)
    expect(within(row).getByRole('button', { name: 'Remove' }).className).toMatch(/\bh-11\b/)
    const official = within(screen.getAllByRole('list')[1]).getAllByRole('listitem')[0]
    for (const el of official.querySelectorAll('input, select')) expect(el.className).toMatch(/\bh-11\b/)
  })

  // A player who is also a bench official (a playing coach, domain/playerOfficials)
  it('"Plays as": the coach plays as #7 by choice, or is not a player', () => {
    const onSave = open()
    const playsAs = within(screen.getAllByRole('list')[1]).getByLabelText('Plays as')
    // Marco Frei is no player of the team: nothing found
    expect(playsAs).toHaveValue('')
    expect([...playsAs.options].map(o => o.textContent)).toEqual(['–', 'Not a player', '#1 Keller', '#7 Fischer', '#12 Huber'])
    fireEvent.change(playsAs, { target: { value: '7' } })
    expect(playsAs).toHaveValue('7')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(onSave.mock.calls[0][2][0]).toEqual({ ...bench[0], plays: 7 })
  })

  it('"Plays as" shows the player found by licence or name, and "Not a player" undoes it', () => {
    const onSave = vi.fn()
    render(
      <ReopenRosterModal
        teamKey="home" teamName="VBC Musterdorf" players={players}
        bench={[{ role: 'Coach', firstName: 'Erik', lastName: 'Fischer', dob: '09.02.1996' }]}
        onSave={onSave} onClose={() => {}} t={tr} benchRoles={benchRoles}
        toISODate={(d) => (d ? d.split('.').reverse().join('-') : '')}
      />
    )
    const playsAs = within(screen.getAllByRole('list')[1]).getByLabelText('Plays as')
    expect(playsAs).toHaveValue('7')
    fireEvent.change(playsAs, { target: { value: 'none' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(onSave.mock.calls[0][2][0].plays).toBe(false)
  })
})
