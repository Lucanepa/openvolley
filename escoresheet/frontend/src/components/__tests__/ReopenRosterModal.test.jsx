import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'

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

// The libero select (owner 27.11.2026): "it is either nothing, Libero 1,
// Libero 2. one libero -> only Libero 1" (domain/liberoChoices)
describe('ReopenRosterModal: the libero select', () => {
  const team = [
    { id: 1, number: 1, lastName: 'Keller', firstName: 'Luca', dob: '', libero: '', isCaptain: true },
    { id: 9, number: 9, lastName: 'Brunner', firstName: 'Nico', dob: '', libero: 'libero1', isCaptain: false },
    { id: 10, number: 10, lastName: 'Meier', firstName: 'Tim', dob: '', libero: 'libero2', isCaptain: false }
  ]
  function openTeam(props = {}) {
    const onSave = vi.fn()
    render(
      <ReopenRosterModal
        teamKey="home" teamName="VBC Musterdorf" players={props.players || team} bench={[]}
        onSave={onSave} onClose={() => {}} t={tr} benchRoles={benchRoles}
        toISODate={(d) => (d ? d.split('.').reverse().join('-') : '')}
        {...props}
      />
    )
    return onSave
  }
  const rows = () => within(screen.getAllByRole('list')[0]).getAllByRole('listitem')
  const liberoOf = (n) => within(rows().find(r => within(r).getByLabelText('Player number').value === String(n))).getByLabelText('Libero')
  const options = (select) => [...select.options].map(o => [o.value, o.textContent])
  const save = (onSave) => {
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    return onSave.mock.calls[0][1]
  }

  it('offers none, L1 and L2 only: L1 keeps L1, L2 keeps L2, the others none; the none option reads "No libero" without the column head', () => {
    openTeam()
    expect(options(liberoOf(9))).toEqual([['', 'No libero'], ['libero1', 'L1']])
    expect(options(liberoOf(10))).toEqual([['', 'No libero'], ['libero2', 'L2']])
    expect(options(liberoOf(1))).toEqual([['', 'No libero']])
  })

  it('an added player: L2 only once the team has its L1, none when it has both', () => {
    openTeam({ players: team.slice(0, 2) })
    fireEvent.click(screen.getByRole('button', { name: '+ Add player' }))
    expect(options(within(rows()[2]).getByLabelText('Libero'))).toEqual([['', 'No libero'], ['libero2', 'L2']])
    cleanup()
    openTeam()
    fireEvent.click(screen.getByRole('button', { name: '+ Add player' }))
    expect(options(within(rows()[3]).getByLabelText('Libero'))).toEqual([['', 'No libero']])
  })

  it('the none option by the list width: blank under the column head (560 px and wider), "No libero" without it, "–" in the narrow phone column', () => {
    const saved = { RO: globalThis.ResizeObserver, rect: HTMLElement.prototype.getBoundingClientRect }
    let listWidth = 700
    globalThis.ResizeObserver = class { observe () {} disconnect () {} }
    HTMLElement.prototype.getBoundingClientRect = function () { return { width: this.getAttribute('role') === 'list' ? listWidth : 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 } }
    try {
      for (const [width, none] of [[700, ''], [560, ''], [520, 'No libero'], [400, '–']]) {
        listWidth = width
        openTeam()
        expect(options(liberoOf(1))).toEqual([['', none]])
        expect(options(liberoOf(9))).toEqual([['', none], ['libero1', 'L1']])
        cleanup()
      }
    } finally {
      globalThis.ResizeObserver = saved.RO
      HTMLElement.prototype.getBoundingClientRect = saved.rect
    }
  })

  it('no libero recorded yet: the L1 set to none or removed, the L2 left becomes L1', () => {
    let onSave = openTeam({ liberosInRecord: false })
    fireEvent.change(liberoOf(9), { target: { value: '' } })
    expect(liberoOf(10)).toHaveValue('libero1')
    expect(options(liberoOf(9))).toEqual([['', 'No libero'], ['libero2', 'L2']])
    expect(screen.queryByTestId('libero-slots-kept')).toBeNull()
    expect(save(onSave).map(p => [p.number, p.libero])).toEqual([[1, ''], [9, ''], [10, 'libero1']])
    cleanup()

    onSave = openTeam({ liberosInRecord: false })
    fireEvent.click(within(rows()[1]).getByRole('button', { name: 'Remove' }))
    expect(liberoOf(10)).toHaveValue('libero1')
    expect(save(onSave).map(p => [p.number, p.libero])).toEqual([[1, ''], [10, 'libero1']])
  })

  it('the record names the liberos: L1 / L2 stay as they are and a line says so', () => {
    const onSave = openTeam({ liberosInRecord: true })
    fireEvent.change(liberoOf(9), { target: { value: '' } })
    expect(liberoOf(10)).toHaveValue('libero2')
    // the lone L2 keeps its own value and may still become L1 by hand
    expect(options(liberoOf(10))).toEqual([['', 'No libero'], ['libero1', 'L1'], ['libero2', 'L2']])
    expect(screen.getByTestId('libero-slots-kept').textContent).toMatch(/keep L1 and L2: the match record already refers to them/)
    expect(save(onSave).map(p => [p.number, p.libero])).toEqual([[1, ''], [9, ''], [10, 'libero2']])
  })

  it('no line while the team keeps its L1', () => {
    openTeam({ liberosInRecord: true })
    fireEvent.change(liberoOf(10), { target: { value: '' } })
    expect(liberoOf(9)).toHaveValue('libero1')
    expect(screen.queryByTestId('libero-slots-kept')).toBeNull()
  })
})
