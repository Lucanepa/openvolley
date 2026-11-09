import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// db/025: OpenVolley's sign-up says what the account does ("What do you
// do?"), so an approver only approves: scorer of clubs, referee, team manager
// of a club's teams, club manager. Optional; nothing is granted at sign-up.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : opts?.name ? `${key}|${opts.name}` : key), i18n: { language: 'en' } })
}))

const auth = vi.hoisted(() => ({ signUp: vi.fn(), signIn: vi.fn() }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }))
const api = vi.hoisted(() => ({ fetchPublicClubs: vi.fn() }))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), fetchPublicClubs: api.fetchPublicClubs }))

import SignUpForm from '../auth/SignUpForm'
import { emptyRequestChoice, requestChoiceProblem, requestPartLabel, signUpRequestsOf, sortRequestParts } from '../../domain/signUpRequests'

const CLUBS = [
  { id: 'c-must', name: 'VBC Musterdorf', teams: [{ id: 't-h1', name: 'VBC Musterdorf H1' }, { id: 't-d2', name: 'VBC Musterdorf D2' }] },
  { id: 'c-msh', name: 'VBC Mustershausen', teams: [] }
]

const fill = (form) => {
  const input = (label) => within(form).getByLabelText(label)
  fireEvent.change(input('First name'), { target: { value: 'Lea' } })
  fireEvent.change(input('Last name'), { target: { value: 'Muster' } })
  fireEvent.change(input('Email'), { target: { value: 'lea@example.ch' } })
  fireEvent.change(input('Password'), { target: { value: 'secret12' } })
  fireEvent.change(input('Confirm password'), { target: { value: 'secret12' } })
}
const submit = (form) => fireEvent.click(within(form).getByRole('button', { name: 'Create account' }))

beforeEach(() => {
  vi.clearAllMocks()
  auth.signUp.mockResolvedValue({ data: { user: { id: 'u-new', email_confirmed_at: '2026-11-09T08:00:00Z' } }, error: null })
  auth.signIn.mockResolvedValue({ error: null })
  api.fetchPublicClubs.mockResolvedValue({ data: { clubs: CLUBS }, error: null, status: 200 })
})

describe('the request a sign-up sends', () => {
  it('one part per club and team, nothing for an unticked kind', () => {
    const c = emptyRequestChoice()
    expect(signUpRequestsOf(c)).toEqual([])
    c.scorer = { on: true, clubIds: ['c-must', 'c-msh', 'c-must'] }
    c.referee = { on: true }
    c.team_manager = { on: true, clubId: 'c-must', teamIds: ['t-h1', 't-d2'] }
    c.club_manager = { on: false, clubId: 'c-msh' }
    expect(signUpRequestsOf(c)).toEqual([
      { kind: 'scorer', club_id: 'c-must' },
      { kind: 'scorer', club_id: 'c-msh' },
      { kind: 'referee' },
      { kind: 'team_manager', club_id: 'c-must', team_id: 't-h1' },
      { kind: 'team_manager', club_id: 'c-must', team_id: 't-d2' }
    ])
  })

  it('a ticked kind needs its club (and team)', () => {
    const c = emptyRequestChoice()
    expect(requestChoiceProblem(c)).toBe(null)
    expect(requestChoiceProblem({ ...c, scorer: { on: true, clubIds: [] } })?.key).toBe('access.requests.needScorerClub')
    expect(requestChoiceProblem({ ...c, team_manager: { on: true, clubId: '', teamIds: [] } })?.key).toBe('access.requests.needTeamClub')
    expect(requestChoiceProblem({ ...c, team_manager: { on: true, clubId: 'c-must', teamIds: [] } })?.key).toBe('access.requests.needTeam')
    expect(requestChoiceProblem({ ...c, club_manager: { on: true, clubId: '' } })?.key).toBe('access.requests.needManagedClub')
    expect(requestChoiceProblem({ ...c, referee: { on: true } })).toBe(null)
  })

  it('a part reads as its kind and its club or team, in the approvers\' order', () => {
    const t = (k) => k.split('.').pop()
    expect(requestPartLabel({ kind: 'scorer', club_name: 'VBC Musterdorf' }, t)).toBe('scorer · VBC Musterdorf')
    expect(requestPartLabel({ kind: 'team_manager', club_name: 'VBC Musterdorf', team_name: 'VBC Musterdorf H1' }, t)).toBe('team_manager · VBC Musterdorf H1')
    expect(requestPartLabel({ kind: 'referee' }, t)).toBe('referee')
    expect(sortRequestParts([{ kind: 'club_manager' }, { kind: 'referee' }, { kind: 'scorer', club_name: 'B' }, { kind: 'scorer', club_name: 'A' }]).map((p) => p.kind + (p.club_name || '')))
      .toEqual(['scorerA', 'scorerB', 'referee', 'club_manager'])
  })
})

describe('SignUpForm: "What do you do?"', () => {
  it('only on OpenVolley\'s sign-up (askRoles)', () => {
    render(<SignUpForm />)
    expect(screen.queryByTestId('signup-requests')).toBeNull()
    expect(api.fetchPublicClubs).not.toHaveBeenCalled()
  })

  it('nothing ticked: the account signs up as before, with no request', async () => {
    render(<SignUpForm askRoles />)
    await waitFor(() => expect(api.fetchPublicClubs).toHaveBeenCalled())
    const form = screen.getByTestId('signup-form')
    fill(form)
    submit(form)
    await waitFor(() => expect(auth.signUp).toHaveBeenCalled())
    expect(auth.signUp.mock.calls[0][3]).toEqual({ requests: [] })
  })

  it('scorer of two clubs, referee, team manager of a team, club manager: one request', async () => {
    render(<SignUpForm askRoles />)
    const box = screen.getByTestId('signup-requests')
    fireEvent.click(within(box).getByTestId('signup-request-scorer'))
    const scorerClub = await within(box).findByTestId('signup-scorer-club')
    await waitFor(() => expect(within(scorerClub).getAllByRole('option').map((o) => o.textContent)).toContain('VBC Musterdorf'))
    fireEvent.change(scorerClub, { target: { value: 'c-must' } })
    // a second club; the first shows as a chip that can be taken off
    fireEvent.change(within(box).getByTestId('signup-scorer-club'), { target: { value: 'c-msh' } })
    expect(within(box).getByRole('button', { name: 'access.requests.removeClub|VBC Mustershausen' })).toBeInTheDocument()
    // every club is chosen: no picker left
    expect(within(box).queryByTestId('signup-scorer-club')).toBeNull()
    fireEvent.click(within(box).getByTestId('signup-request-referee'))
    fireEvent.click(within(box).getByTestId('signup-request-team_manager'))
    fireEvent.change(within(box).getByTestId('signup-team-club'), { target: { value: 'c-must' } })
    fireEvent.click(within(within(box).getByTestId('signup-teams')).getByLabelText('VBC Musterdorf H1'))
    fireEvent.click(within(box).getByTestId('signup-request-club_manager'))
    fireEvent.change(within(box).getByTestId('signup-managed-club'), { target: { value: 'c-must' } })
    const form = screen.getByTestId('signup-form')
    fill(form)
    submit(form)
    await waitFor(() => expect(auth.signUp).toHaveBeenCalled())
    expect(auth.signUp.mock.calls[0][3]).toEqual({
      requests: [
        { kind: 'scorer', club_id: 'c-must' },
        { kind: 'scorer', club_id: 'c-msh' },
        { kind: 'referee' },
        { kind: 'team_manager', club_id: 'c-must', team_id: 't-h1' },
        { kind: 'club_manager', club_id: 'c-must' }
      ]
    })
  })

  it('a ticked kind without its club or team is not sent', async () => {
    render(<SignUpForm askRoles />)
    const box = screen.getByTestId('signup-requests')
    await waitFor(() => expect(within(box).getByTestId('signup-request-scorer')).not.toBeDisabled())
    fireEvent.click(within(box).getByTestId('signup-request-team_manager'))
    fireEvent.change(within(box).getByTestId('signup-team-club'), { target: { value: 'c-must' } })
    const form = screen.getByTestId('signup-form')
    fill(form)
    submit(form)
    expect(await within(box).findByText('access.requests.needTeam')).toBeInTheDocument()
    expect(auth.signUp).not.toHaveBeenCalled()
    // a club without teams says so
    fireEvent.change(within(box).getByTestId('signup-team-club'), { target: { value: 'c-msh' } })
    expect(within(box).getByText('access.requests.noTeams')).toBeInTheDocument()
  })

  it('clubs not loaded: it says so, referee still works, the club kinds wait', async () => {
    api.fetchPublicClubs.mockResolvedValue({ data: null, error: { message: 'offline', network: true }, status: 0 })
    render(<SignUpForm askRoles />)
    const box = screen.getByTestId('signup-requests')
    expect(await within(box).findByTestId('signup-clubs-failed')).toBeInTheDocument()
    expect(within(box).getByTestId('signup-request-scorer')).toBeDisabled()
    expect(within(box).getByTestId('signup-request-club_manager')).toBeDisabled()
    fireEvent.click(within(box).getByTestId('signup-request-referee'))
    const form = screen.getByTestId('signup-form')
    fill(form)
    submit(form)
    await waitFor(() => expect(auth.signUp).toHaveBeenCalled())
    expect(auth.signUp.mock.calls[0][3]).toEqual({ requests: [{ kind: 'referee' }] })
  })

  it('a club or team gone meanwhile: the sign-up is refused, the list reloads, the choice is cleared', async () => {
    auth.signUp.mockResolvedValue({ data: null, error: { message: 'A club you picked does not exist any more.', code: 'validation_failed' } })
    render(<SignUpForm askRoles />)
    const box = screen.getByTestId('signup-requests')
    fireEvent.click(within(box).getByTestId('signup-request-club_manager'))
    await waitFor(() => expect(within(within(box).getByTestId('signup-managed-club')).getAllByRole('option').length).toBeGreaterThan(1))
    fireEvent.change(within(box).getByTestId('signup-managed-club'), { target: { value: 'c-msh' } })
    const form = screen.getByTestId('signup-form')
    fill(form)
    submit(form)
    expect(await screen.findByText('access.requests.signUpRefused')).toBeInTheDocument()
    expect(api.fetchPublicClubs).toHaveBeenCalledTimes(2)
    expect(within(box).getByTestId('signup-request-club_manager')).not.toBeChecked()
  })
})
