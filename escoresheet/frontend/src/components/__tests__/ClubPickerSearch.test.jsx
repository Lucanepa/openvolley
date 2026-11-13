// Owner decision 2: a team manager finds an official of the club by name on
// the server (a few rows) instead of reading the whole lists, and Match
// Setup asks for the dates of birth of the people it adds only (the
// tablet's copy has none). Made-up people.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } }) }))

import ClubPlayerPickerModal from '../ClubPlayerPickerModal'

const NOAH = { sv_number: '100004', last_name: 'Testmann', first_name: 'Noah', dob: null, gender: 'm', lists: ['players'] }
const TINA = { sv_number: '200001', last_name: 'Trainer', first_name: 'Tina', dob: null, gender: 'f', lists: ['coaches'] }
const roles = [{ value: 'Coach', label: 'Coach' }, { value: 'Medic', label: 'Medic' }]

beforeEach(() => vi.clearAllMocks())

describe('the club picker', () => {
  it('asks the server from three characters on and offers what it finds after the local ones', async () => {
    const search = vi.fn(async () => ({ data: { people: [TINA], more: true }, error: null }))
    const onPick = vi.fn()
    render(<ClubPlayerPickerModal open mode="officials" players={[NOAH]} roles={roles} onPick={onPick} onClose={vi.fn()} search={search} />)
    expect(screen.getByTestId('club-picker-search-hint')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('club-picker-search'), { target: { value: 'tr' } })
    await new Promise((r) => setTimeout(r, 400))
    expect(search).not.toHaveBeenCalled()
    fireEvent.change(screen.getByTestId('club-picker-search'), { target: { value: 'Trai' } })
    await waitFor(() => expect(search).toHaveBeenCalledWith('Trai'))
    await waitFor(() => expect(screen.getAllByTestId('club-picker-row').map((r) => r.textContent)).toEqual([expect.stringContaining('Trainer Tina')]))
    expect(screen.getByTestId('club-picker-search-more')).toBeInTheDocument()
    fireEvent.click(within(screen.getAllByTestId('club-picker-row')[0]).getByRole('radio'))
    fireEvent.click(screen.getByTestId('club-picker-add'))
    await waitFor(() => expect(onPick).toHaveBeenCalledWith([TINA], 'Coach'))
  })

  it('a failed search leaves the local ones', async () => {
    const search = vi.fn(async () => { throw new Error('offline') })
    render(<ClubPlayerPickerModal open mode="officials" players={[NOAH]} roles={roles} onPick={vi.fn()} onClose={vi.fn()} search={search} />)
    fireEvent.change(screen.getByTestId('club-picker-search'), { target: { value: 'test' } })
    await waitFor(() => expect(search).toHaveBeenCalled())
    await waitFor(() => expect(screen.getAllByTestId('club-picker-row').map((r) => r.textContent)).toEqual([expect.stringContaining('Testmann Noah')]))
  })

  it('hands the chosen people through `resolve` first (the dates of birth), as they are when it fails', async () => {
    const onPick = vi.fn()
    const resolve = vi.fn(async (people) => people.map((p) => ({ ...p, dob: '2003-03-03' })))
    const { unmount } = render(<ClubPlayerPickerModal open players={[NOAH, TINA]} onPick={onPick} onClose={vi.fn()} resolve={resolve} />)
    fireEvent.click(within(screen.getAllByTestId('club-picker-row')[0]).getByRole('checkbox'))
    fireEvent.click(screen.getByTestId('club-picker-add'))
    await waitFor(() => expect(onPick).toHaveBeenCalledWith([{ ...NOAH, dob: '2003-03-03' }]))
    expect(resolve).toHaveBeenCalledWith([NOAH])
    unmount()
    const failing = vi.fn(async () => { throw new Error('offline') })
    render(<ClubPlayerPickerModal open players={[NOAH]} onPick={onPick} onClose={vi.fn()} resolve={failing} />)
    fireEvent.click(within(screen.getAllByTestId('club-picker-row')[0]).getByRole('checkbox'))
    fireEvent.click(screen.getByTestId('club-picker-add'))
    await waitFor(() => expect(onPick).toHaveBeenLastCalledWith([NOAH]))
  })
})
