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

function open(onSave = vi.fn()) {
  render(
    <ReopenRosterModal
      teamKey="home" teamName="VBC Zürich" players={players} bench={bench}
      onSave={onSave} onClose={() => {}} t={tr} benchRoles={benchRoles}
      toISODate={(d) => (d ? d.split('.').reverse().join('-') : '')}
    />
  )
  return onSave
}

describe('ReopenRosterModal', () => {
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

  it('every control in a row is 44 px tall', () => {
    open()
    const row = within(screen.getAllByRole('list')[0]).getAllByRole('listitem')[0]
    for (const el of row.querySelectorAll('input, select')) expect(el.className).toMatch(/\bh-11\b/)
    expect(within(row).getByRole('button', { name: 'Remove' }).className).toMatch(/\bh-11\b/)
  })
})
