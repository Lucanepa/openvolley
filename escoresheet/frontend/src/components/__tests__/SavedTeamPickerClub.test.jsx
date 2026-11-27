// "Load saved team" lists the saved teams of the club of the team being edited
// (owner 2026-11-27): by the club's id where the account's club lists know the
// saved team, else by the club's name; none of the club is said in one line;
// a club not known (guest, test match of no club) lists every saved team.
// Made-up clubs and teams.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (opts && typeof opts === 'object' && opts.club ? `${key}:${opts.club}` : key), i18n: { language: 'en' } })
}))

const cache = vi.hoisted(() => ({ rows: [], meta: null }))
vi.mock('../../db/savedTeams', () => ({
  SAVED_TEAMS_CHANGED_EVENT: 'ov-saved-teams-changed',
  getSavedTeams: vi.fn(async () => cache.rows),
  getSavedTeamsMeta: vi.fn(async () => cache.meta),
  refreshSavedTeams: vi.fn(async () => ({ status: 'offline', teams: cache.rows })),
  competitionsOf: (rows) => [...new Map(rows.map(r => [r.competition.id, r.competition])).values()]
}))

import SavedTeamPickerModal from '../SavedTeamPickerModal'

const competition = { id: 'c1', name: '2. Liga', season: '2026/27', vmLeagues: [], archived: false }
const row = (id, name, club, svrzTeamName = '') => ({
  id, name, club, svrzTeamName, competitionId: 'c1', competition,
  players: [{ number: 1, last_name: 'A', active: true }], staff: [], updatedAt: '2026-09-01'
})
const LISTS = { 'vbc seewiese 1': 'club-see', 'vbc seewiese 2': 'club-see' }
const clubIdOf = (name) => LISTS[String(name ?? '').trim().toLowerCase()] ?? null

const picker = (props) => render(
  <SavedTeamPickerModal open onClose={() => {}} onPick={() => {}} userId="u1" access={{ canReadTeams: true }} roster={[]} bench={[]} clubIdOf={clubIdOf} {...props} />
)
const names = () => within(screen.getByTestId('saved-team-results')).queryAllByTestId('saved-team-row').map(r => r.textContent)

describe('Load saved team: the same club only', () => {
  let onLine
  beforeEach(() => {
    cache.rows = [
      row('a1', 'Seewiese H1', 'VBC Seewiese', 'VBC Seewiese 1'),
      row('a2', 'Seewiese H2', 'VBC Seewiese', 'VBC Seewiese 2'),
      row('b1', 'Bergdorf', 'TV Bergdorf', 'TV Bergdorf'),
      row('n1', 'Ohne Verein', '')
    ]
    cache.meta = { key: 'bundle', userId: 'u1', fetchedAt: '2026-11-27T10:00:00Z', version: '1' }
    onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true)
  })
  afterEach(() => onLine.mockRestore())

  it('a club of the account\'s lists: its saved teams only, and the dialog says whose', async () => {
    picker({ club: { id: 'club-see', name: 'VBC Seewiese' } })
    expect(await screen.findByText('Seewiese H1')).toBeInTheDocument()
    expect(names()).toEqual([expect.stringContaining('Seewiese H1'), expect.stringContaining('Seewiese H2')])
    expect(screen.getByRole('dialog').textContent).toContain('savedTeams.pickerClubOnly:VBC Seewiese')
  })

  it('a club known by its name only (the opponent): the saved teams of that name', async () => {
    picker({ club: { id: null, name: 'tv bergdorf' } })
    expect(await screen.findByText('Bergdorf')).toBeInTheDocument()
    expect(names()).toHaveLength(1)
  })

  it('no saved team of the club: one line, no list', async () => {
    picker({ club: { id: null, name: 'VBC Fremd' } })
    expect(await screen.findByTestId('saved-teams-none-of-club')).toHaveTextContent('savedTeams.pickerNoneOfClub:VBC Fremd')
    expect(names()).toEqual([])
    expect(screen.queryByText('savedTeams.pickerEmpty')).toBeNull()
  })

  it('the club not known: every saved team, as before', async () => {
    picker({ club: null })
    expect(await screen.findByText('Ohne Verein')).toBeInTheDocument()
    expect(names()).toHaveLength(4)
    expect(screen.getByRole('dialog').textContent).not.toContain('savedTeams.pickerClubOnly')
  })

  it('no saved team on the device at all: the usual empty note, not the club line', async () => {
    cache.rows = []
    picker({ club: { id: 'club-see', name: 'VBC Seewiese' } })
    expect(await screen.findByText('savedTeams.pickerEmpty')).toBeInTheDocument()
    expect(screen.queryByTestId('saved-teams-none-of-club')).toBeNull()
  })
})
