import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// db/023: an admin makes a team link for any club's team from Invite codes
// (owner 2026-11-11: "as admin I can create a link for everything").

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))
const api = vi.hoisted(() => ({
  clubs: { list: vi.fn() },
  admin: { listInvites: vi.fn(), createInvite: vi.fn() },
  club: { teams: vi.fn(), createTeamLink: vi.fn(), listInvites: vi.fn(), createInvite: vi.fn() }
}))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), clubsApi: api.clubs, admin: api.admin, clubApi: api.club }))

import InvitesPanel from '../manage/InvitesPanel'

beforeEach(() => {
  vi.clearAllMocks()
  api.clubs.list.mockResolvedValue({ data: { clubs: [{ id: 'c1', name: 'VBC Limmattal' }, { id: 'c2', name: 'VBC Other' }] }, error: null, status: 200 })
  api.admin.listInvites.mockResolvedValue({ data: { invites: [] }, error: null, status: 200 })
  api.club.listInvites.mockResolvedValue({ data: { invites: [] }, error: null, status: 200 })
  api.club.teams.mockResolvedValue({ data: { teams: [{ id: 't2', name: 'VBC Limmattal HU23' }, { id: 't1', name: 'VBC Limmattal D1' }] }, error: null, status: 200 })
  api.club.createTeamLink.mockResolvedValue({ data: { code: 'ABCDEFGHJKMN', invite: { id: 'i1', role: 'team_manager' } }, error: null, status: 201 })
})

describe('InvitesPanel: an admin\'s team link', () => {
  it('Team manager: no label, a club then one of its teams; makes the team link and shows it', async () => {
    render(<InvitesPanel app="indoor" />)
    fireEvent.click(await screen.findByRole('button', { name: /manage\.invites\.new/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByTestId('invite-role'), { target: { value: 'team_manager' } })
    expect(within(dialog).queryByText('manage.invites.label')).toBeNull() // no label field
    const create = within(dialog).getByTestId('create-invite')
    expect(create.disabled).toBe(true)
    expect(within(dialog).getByTestId('invite-team').disabled).toBe(true)
    fireEvent.change(await within(dialog).findByTestId('invite-club'), { target: { value: 'c1' } })
    await waitFor(() => expect(api.club.teams).toHaveBeenCalledWith('c1'))
    const team = within(dialog).getByTestId('invite-team')
    await waitFor(() => expect(within(team).getAllByRole('option').map((o) => o.textContent)).toEqual(['manage.invites.pickTeam', 'VBC Limmattal D1', 'VBC Limmattal HU23']))
    expect(within(dialog).getByTestId('invite-max-uses').value).toBe('3')
    fireEvent.change(team, { target: { value: 't2' } })
    expect(create.disabled).toBe(false)
    fireEvent.click(create)
    await waitFor(() => expect(api.club.createTeamLink).toHaveBeenCalled())
    const [clubId, teamId, body] = api.club.createTeamLink.mock.calls[0]
    expect([clubId, teamId, body.max_uses]).toEqual(['c1', 't2', 3])
    expect(typeof body.expires_at).toBe('string')
    expect(api.admin.createInvite).not.toHaveBeenCalled()
    const link = await screen.findByTestId('invite-link')
    expect(link.textContent).toContain('ABCDEFGHJKMN')
  })

  it('more than 10 uses cannot be sent for a team link', async () => {
    render(<InvitesPanel app="indoor" />)
    fireEvent.click(await screen.findByRole('button', { name: /manage\.invites\.new/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByTestId('invite-role'), { target: { value: 'team_manager' } })
    fireEvent.change(await within(dialog).findByTestId('invite-club'), { target: { value: 'c1' } })
    await waitFor(() => expect(within(within(dialog).getByTestId('invite-team')).getAllByRole('option').length).toBe(3))
    fireEvent.change(within(dialog).getByTestId('invite-team'), { target: { value: 't1' } })
    fireEvent.change(within(dialog).getByTestId('invite-max-uses'), { target: { value: '11' } })
    expect(within(dialog).getByTestId('create-invite').disabled).toBe(true)
  })

  it('OpenBeach\'s console and a club manager\'s codes offer no team manager', async () => {
    const { unmount } = render(<InvitesPanel app="beach" />)
    fireEvent.click(await screen.findByRole('button', { name: /manage\.invites\.new/ }))
    expect(within(await screen.findByRole('dialog')).queryByRole('option', { name: 'access.roles.team_manager' })).toBeNull()
    unmount()
    render(<InvitesPanel app="indoor" club={{ id: 'c1', name: 'VBC Limmattal' }} />)
    fireEvent.click(await screen.findByRole('button', { name: /manage\.invites\.new/ }))
    expect(within(await screen.findByRole('dialog')).queryByRole('option', { name: 'access.roles.team_manager' })).toBeNull()
  })
})
