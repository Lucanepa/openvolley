import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (opts && typeof opts === 'object' && opts.date ? `${key}:${opts.date}` : key), i18n: { language: 'en' } })
}))

const cache = vi.hoisted(() => ({ rows: [], meta: null }))
vi.mock('../../db/savedTeams', () => ({
  SAVED_TEAMS_CHANGED_EVENT: 'ov-saved-teams-changed',
  getSavedTeams: vi.fn(async () => cache.rows),
  getSavedTeamsMeta: vi.fn(async () => cache.meta),
  refreshSavedTeams: vi.fn(async () => ({ status: 'offline', teams: cache.rows })),
  competitionsOf: (rows) => [...new Map(rows.map(r => [r.competition.id, r.competition])).values()]
}))

const confirm = vi.hoisted(() => ({ fn: vi.fn(async () => true) }))
vi.mock('../../ui', async (orig) => ({ ...(await orig()), confirmDialog: (...a) => confirm.fn(...a) }))

import SavedTeamPickerModal from '../SavedTeamPickerModal'

const competition = { id: 'c1', name: '2. Liga', season: '2026/27', vmLeagues: [], archived: false }
const row = (id, name, over = {}) => ({
  id, name, club: 'VBC', svrzTeamName: '', competitionId: 'c1', competition,
  players: [{ number: 1, last_name: 'A', active: true }, { number: 2, last_name: 'B', active: false }], staff: [], updatedAt: '2026-09-01', ...over
})

describe('SavedTeamPickerModal', () => {
  let onLine
  beforeEach(() => {
    cache.rows = [row('t1', 'VBC Test'), row('t2', 'Archived team', { competition: { ...competition, id: 'c2', archived: true }, competitionId: 'c2' })]
    cache.meta = { key: 'bundle', userId: 'u1', fetchedAt: '2026-10-05T18:30:00Z', version: '1' }
    confirm.fn.mockClear()
    onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
  })
  afterEach(() => onLine.mockRestore())

  it('offline: shows the cached teams with their date and hides archived competitions', async () => {
    render(<SavedTeamPickerModal open onClose={() => {}} onPick={() => {}} userId="u1" access={{ canReadTeams: true }} roster={[]} bench={[]} />)
    expect(await screen.findByText('VBC Test')).toBeInTheDocument()
    expect(screen.queryByText('Archived team')).toBeNull()
    expect(screen.getByTestId('saved-teams-offline').textContent).toContain('savedTeams.pickerOffline:05.10.2026 20:30')
  })

  it('an empty roster loads without asking', async () => {
    const onPick = vi.fn()
    render(<SavedTeamPickerModal open onClose={() => {}} onPick={onPick} userId="u1" access={{ canReadTeams: true }} roster={[]} bench={[{ role: 'Coach', firstName: '', lastName: '' }]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'VBC Test' }))
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' })))
    expect(confirm.fn).not.toHaveBeenCalled()
  })

  it('a roster with players asks first, and a cancel loads nothing', async () => {
    const onPick = vi.fn()
    confirm.fn.mockResolvedValueOnce(false)
    render(<SavedTeamPickerModal open onClose={() => {}} onPick={onPick} userId="u1" access={{ canReadTeams: true }} roster={[{ number: 7, lastName: 'X' }]} bench={[]} teamLabel="Home" />)
    fireEvent.click(await screen.findByRole('button', { name: 'VBC Test' }))
    await waitFor(() => expect(confirm.fn).toHaveBeenCalledTimes(1))
    expect(onPick).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'VBC Test' }))
    await waitFor(() => expect(onPick).toHaveBeenCalled())
  })
})
