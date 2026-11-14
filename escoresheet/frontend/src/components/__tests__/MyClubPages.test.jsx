import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { UiHost } from '../../ui'

// Owner 2026-11-10: "make sure every page there gets their own page (team,
// club, game, player etc)". My club: the club at #myclub/<club id>, a person
// of its licence lists at #myclub/<club id>/person/<row id> (db/037: never the
// licence number, which a shared laptop's history keeps), a team opens in My
// teams. Made-up people of VBC Musterdorf.

const tr = vi.hoisted(() => vi.fn((key, opts) => (typeof opts === 'string' ? opts : key)))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: tr, i18n: { language: 'en' } }) }))
const okRes = (data, status = 200) => ({ data, error: null, status })
const api = vi.hoisted(() => ({
  club: { get: vi.fn(), setContact: vi.fn(), members: vi.fn(), removeMember: vi.fn(), listInvites: vi.fn(), createInvite: vi.fn(), revokeInvite: vi.fn(), teams: vi.fn(), createTeamLink: vi.fn(), removeTeamManager: vi.fn(), licences: vi.fn(), putLicences: vi.fn(), deleteLicenceRow: vi.fn(), requests: vi.fn(), decideRequests: vi.fn() }
}))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), clubApi: api.club }))

import MyClubPanel from '../manage/MyClubPanel'

const VBCM = { id: 'c1', name: 'VBC Musterdorf' }
const OTHER = { id: 'c2', name: 'VBC Other' }
const MARCO = { id: 'r-marco', sv_number: '100003', last_name: 'Probe', first_name: 'Marco', dob: '2001-11-02', gender: 'm', lists: ['players', 'coaches'], manual: false, teams: [{ id: 't-h1', name: 'VBC Musterdorf H1' }], hand_rows: [] }
const HANS = { id: 'r-hans', sv_number: '400001', last_name: 'Hand', first_name: 'Hans', dob: null, gender: 'm', lists: ['players'], manual: true, teams: [], hand_rows: [{ id: 'r-hans', list: 'players' }] }

beforeEach(() => {
  vi.clearAllMocks()
  api.club.get.mockResolvedValue(okRes({ club: { ...VBCM, teams: ['VBC Musterdorf H1'], contact_email: null, managers: [] } }))
  api.club.members.mockResolvedValue(okRes({ members: [] }))
  api.club.teams.mockResolvedValue(okRes({ teams: [{ id: 't-h1', name: 'VBC Musterdorf H1', open_links: 0, managers: [] }] }))
  api.club.licences.mockResolvedValue(okRes({ season: '2026/27', lists: { players: { count: 2, manual: 1 }, scorers: { count: 0 }, coaches: { count: 1 } }, people: [MARCO, HANS] }))
  api.club.requests.mockResolvedValue(okRes({ requests: [] }))
  api.club.listInvites.mockResolvedValue(okRes({ invites: [] }))
})

describe('My club pages', () => {
  it('a person of the lists opens their page (the row id in the URL, not the licence); back returns to the club', async () => {
    const onRoute = vi.fn()
    const { rerender } = render(<MyClubPanel clubs={[VBCM]} route="" onRoute={onRoute} />)
    const rows = await screen.findAllByTestId('licence-person')
    fireEvent.click(within(rows.find((r) => r.textContent.includes('Probe Marco'))).getByRole('button'))
    expect(onRoute).toHaveBeenLastCalledWith('c1/person/r-marco', { push: true })
    expect(onRoute.mock.calls.flat().join(' ')).not.toContain('100003')
    rerender(<MyClubPanel clubs={[VBCM]} route="c1/person/r-marco" onRoute={onRoute} />)
    const page = await screen.findByTestId('club-person-page')
    expect(within(page).getByRole('heading', { name: 'Probe Marco' })).toBeInTheDocument()
    expect(page.textContent).toContain('100003')
    expect(page.textContent).toContain('manage.licences.lists.coaches')
    fireEvent.click(screen.getByTestId('club-person-back'))
    expect(onRoute).toHaveBeenLastCalledWith('c1', { push: true })
  })

  it('a person added by hand is tagged; one not in the lists (or a licence number) is a missing page', async () => {
    const { rerender } = render(<MyClubPanel clubs={[VBCM]} route="c1/person/r-hans" onRoute={vi.fn()} />)
    expect((await screen.findByTestId('club-person-page')).textContent).toContain('manage.licences.manual')
    rerender(<MyClubPanel clubs={[VBCM]} route="c1/person/400001" onRoute={vi.fn()} />)
    expect(await screen.findByTestId('page-missing')).toBeInTheDocument()
    rerender(<MyClubPanel clubs={[VBCM]} route="c1/person/r-nobody" onRoute={vi.fn()} />)
    expect(await screen.findByTestId('page-missing')).toBeInTheDocument()
  })

  it('a club manager removes one row added by hand from the person page (asked first); an uploaded person has no such button', async () => {
    api.club.deleteLicenceRow.mockResolvedValue(okRes({ deleted: true, list: 'players' }))
    const onRoute = vi.fn()
    const { rerender } = render(<><MyClubPanel clubs={[VBCM]} route="c1/person/r-marco" onRoute={onRoute} /><UiHost /></>)
    await screen.findByTestId('club-person-page')
    expect(screen.queryByTestId('club-person-remove-row')).toBeNull()
    rerender(<><MyClubPanel clubs={[VBCM]} route="c1/person/r-hans" onRoute={onRoute} /><UiHost /></>)
    fireEvent.click(await screen.findByTestId('club-person-remove-row'))
    // declined: nothing is removed
    fireEvent.click(await screen.findByTestId('confirm-cancel'))
    expect(api.club.deleteLicenceRow).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('club-person-remove-row'))
    fireEvent.click(await screen.findByTestId('confirm-accept'))
    await waitFor(() => expect(api.club.deleteLicenceRow).toHaveBeenCalledWith('c1', 'r-hans'))
    // the person was only that row: back to the club
    await waitFor(() => expect(onRoute).toHaveBeenLastCalledWith('c1', { push: true }))
  })

  it('a team of the club and of a person opens in My teams when the account has that tab', async () => {
    const navigate = vi.fn(() => true)
    const { rerender, unmount } = render(<MyClubPanel clubs={[VBCM]} route="" onRoute={vi.fn()} navigate={navigate} canOpen={(id) => id === 'myteams'} />)
    fireEvent.click(await screen.findByTestId('club-team-open'))
    expect(navigate).toHaveBeenLastCalledWith('myteams/t-h1')
    rerender(<MyClubPanel clubs={[VBCM]} route="c1/person/r-marco" onRoute={vi.fn()} navigate={navigate} canOpen={(id) => id === 'myteams'} />)
    fireEvent.click(await screen.findByTestId('club-person-team-open'))
    expect(navigate).toHaveBeenCalledTimes(2)
    unmount()
    // without My teams: no link
    render(<MyClubPanel clubs={[VBCM]} route="" onRoute={vi.fn()} navigate={navigate} canOpen={() => false} />)
    await screen.findByTestId('club-teams')
    expect(screen.queryByTestId('club-team-open')).toBeNull()
  })

  it('a club of the URL is the one shown; the picker opens another club page', async () => {
    const onRoute = vi.fn()
    render(<MyClubPanel clubs={[VBCM, OTHER]} route="c2" onRoute={onRoute} />)
    const pick = await screen.findByTestId('my-club-pick')
    expect(pick.value).toBe('c2')
    fireEvent.change(pick, { target: { value: 'c1' } })
    expect(onRoute).toHaveBeenLastCalledWith('c1', { push: true })
    await waitFor(() => expect(api.club.get).toHaveBeenCalledWith('c2'))
  })
})
