import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// db/020: club managers. The My club tab (contact address, members, the
// club's invite codes) and the admin's managers / contact fields

const tr = vi.hoisted(() => vi.fn((key, opts) => (typeof opts === 'string' ? opts : key)))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tr, i18n: { language: 'en' } })
}))

const api = vi.hoisted(() => ({
  club: { get: vi.fn(), setContact: vi.fn(), members: vi.fn(), removeMember: vi.fn(), listInvites: vi.fn(), createInvite: vi.fn(), revokeInvite: vi.fn(), teams: vi.fn(), createTeamLink: vi.fn(), removeTeamManager: vi.fn() },
  clubs: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), vmTeams: vi.fn(), setRule: vi.fn(), setManagers: vi.fn() },
  admin: { listInvites: vi.fn(), createInvite: vi.fn(), revokeInvite: vi.fn() }
}))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), clubApi: api.club, clubsApi: api.clubs, admin: api.admin }))
const ui = vi.hoisted(() => ({ confirm: vi.fn(async () => true), toasts: [] }))
vi.mock('../../ui', async (orig) => {
  const real = await orig()
  return {
    ...real,
    confirmDialog: (...a) => ui.confirm(...a),
    toast: { ...real.toast, success: (m) => ui.toasts.push(['ok', m]), error: (m) => ui.toasts.push(['error', m]) }
  }
})

import MyClubPanel from '../manage/MyClubPanel'
import ClubsPanel from '../manage/ClubsPanel'
import { manageTabsFor } from '../manage/ManageConsole'
import { accessFromRoles } from '../../lib/access'
import { MANAGER_BRANDS } from '../../managerBrand'

const VBCM = { id: 'c1', name: 'VBC Musterdorf' }
const okRes = (data, status = 200) => ({ data, error: null, status })

beforeEach(() => {
  vi.clearAllMocks()
  ui.toasts = []
  ui.confirm.mockResolvedValue(true)
  api.club.get.mockResolvedValue(okRes({ club: { ...VBCM, teams: ['VBC Musterdorf H1'], contact_email: 'info@vbc-musterdorf.ch', managers: [], scorers: 1 } }))
  // db/023: the club's teams and their team links
  api.club.teams.mockResolvedValue(okRes({ teams: [{ id: 'team-h1', name: 'VBC Musterdorf H1', managers: [], open_links: 0 }] }))
  api.club.members.mockResolvedValue(okRes({ members: [
    { id: 'u1', email: 'ada@example.ch', name: 'Ada Scorer', roles: ['scorer'], manager: false, joined_at: '2026-10-20T10:00:00Z' },
    { id: 'u2', email: 'new@example.ch', name: null, roles: [], manager: false, joined_at: '2026-10-28T10:00:00Z' }
  ] }))
  api.club.listInvites.mockResolvedValue(okRes({ invites: [] }))
})

describe('the My club tab', () => {
  it('is there for a club manager whatever its roles, next to an admin\'s tabs, never in OpenBeach\'s console', () => {
    const manager = { ...accessFromRoles([]), managedClubs: [VBCM] }
    expect(manageTabsFor(manager)).toEqual(['myclub'])
    expect(manageTabsFor({ ...accessFromRoles(['admin']), managedClubs: [VBCM] })).toContain('myclub')
    expect(manageTabsFor(accessFromRoles(['admin']))).not.toContain('myclub')
    expect(manageTabsFor({ ...accessFromRoles(['beach:competition_manager']), managedClubs: [VBCM] }, MANAGER_BRANDS.beach)).not.toContain('myclub')
  })
})

describe('MyClubPanel', () => {
  it('saves the contact address', async () => {
    api.club.setContact.mockResolvedValue(okRes({ club: {} }))
    render(<MyClubPanel clubs={[VBCM]} />)
    const input = await screen.findByTestId('my-club-contact')
    expect(input).toHaveValue('info@vbc-musterdorf.ch')
    fireEvent.change(input, { target: { value: 'sekretariat@vbc-musterdorf.ch' } })
    fireEvent.click(screen.getByTestId('my-club-contact-save'))
    await waitFor(() => expect(api.club.setContact).toHaveBeenCalledWith('c1', 'sekretariat@vbc-musterdorf.ch'))
    expect(ui.toasts).toContainEqual(['ok', 'manage.myClub.contactSaved'])
  })

  it('lists the members; removing one asks first and takes the club link only', async () => {
    api.club.removeMember.mockResolvedValue(okRes({ removed: 'u1' }))
    render(<MyClubPanel clubs={[VBCM]} />)
    const list = await screen.findByTestId('my-club-members')
    expect(within(list).getByText('Ada Scorer')).toBeInTheDocument()
    expect(within(list).getByText('manage.myClub.pending')).toBeInTheDocument() // no role yet
    fireEvent.click(within(list).getAllByRole('button', { name: 'manage.myClub.remove' })[0])
    await waitFor(() => expect(api.club.removeMember).toHaveBeenCalledWith('c1', 'u1'))
    expect(ui.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'manage.myClub.removeTitle', tone: 'danger' }))

    // declined: nothing is removed
    api.club.removeMember.mockClear()
    ui.confirm.mockResolvedValueOnce(false)
    fireEvent.click(within(list).getAllByRole('button', { name: 'manage.myClub.remove' })[0])
    await waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(2))
    expect(api.club.removeMember).not.toHaveBeenCalled()
  })

  it('a new code is the club\'s: the club fixed, scorer or referee only, sent to the club endpoint', async () => {
    api.club.createInvite.mockResolvedValue(okRes({ code: 'ABCD-EFGH-JKMN', invite: { label: 'H1', club: 'VBC Musterdorf', role: 'referee' } }, 201))
    render(<MyClubPanel clubs={[VBCM]} />)
    await waitFor(() => expect(api.club.listInvites).toHaveBeenCalledWith('c1'))
    expect(api.admin.listInvites).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: /manage\.invites\.new/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByTestId('invite-fixed-club')).toHaveValue('VBC Musterdorf')
    const role = within(dialog).getAllByRole('combobox').find((s) => [...s.options].some((o) => o.value === 'referee'))
    expect([...role.options].map((o) => o.value)).toEqual(['scorer', 'referee'])
    fireEvent.change(within(dialog).getAllByRole('textbox')[0], { target: { value: 'H1' } })
    fireEvent.change(role, { target: { value: 'referee' } })
    fireEvent.change(within(dialog).getByRole('spinbutton'), { target: { value: '51' } })
    expect(within(dialog).getByTestId('create-invite')).toBeDisabled() // over the club's cap
    fireEvent.change(within(dialog).getByRole('spinbutton'), { target: { value: '12' } })
    fireEvent.click(within(dialog).getByTestId('create-invite'))
    await waitFor(() => expect(api.club.createInvite).toHaveBeenCalledWith('c1', expect.objectContaining({ label: 'H1', role: 'referee', max_uses: 12 })))
    expect(api.admin.createInvite).not.toHaveBeenCalled()
    expect(await screen.findByTestId('invite-code')).toHaveTextContent('ABCD-EFGH-JKMN')
  })

  it('a team link comes as an invitation: team, club, limits, then the link; Share keeps the link in the text', async () => {
    api.club.createTeamLink.mockResolvedValue(okRes({ code: 'ABCD-EFGH-JKMN', invite: { max_uses: 3, expires_at: '2026-12-09T12:00:00Z' } }, 201))
    // the test setup's navigator.clipboard (not redefinable); jsdom has no navigator.share
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    const share = vi.fn(async () => {})
    Object.defineProperty(navigator, 'share', { value: share, configurable: true })
    try {
      render(<MyClubPanel clubs={[VBCM]} />)
      fireEvent.click(await screen.findByTestId('club-team-link'))
      await waitFor(() => expect(api.club.createTeamLink).toHaveBeenCalledWith('c1', 'team-h1'))
      const box = await screen.findByTestId('team-link-message')
      const url = within(box).getByTestId('team-link-url').textContent
      expect(url).toMatch(/\/#team=ABCD-EFGH-JKMN$/)
      const call = tr.mock.calls.find(([key]) => key === 'manage.clubTeams.inviteText')
      // the team's name already says the club: no "(VBC Musterdorf)" after it
      expect(call[1]).toEqual(expect.objectContaining({ team: 'VBC Musterdorf H1', count: 3 }))
      expect(call[1].date).toBeTruthy()
      const message = `manage.clubTeams.inviteText\n${url}`
      fireEvent.click(screen.getByTestId('team-link-copy-message'))
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(message))
      fireEvent.click(screen.getByTestId('team-link-copy-link'))
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(url))
      fireEvent.click(screen.getByTestId('team-link-share'))
      await waitFor(() => expect(share).toHaveBeenCalledTimes(1))
      // the link inside the text, no separate url: WhatsApp on Android keeps only one of the two
      expect(share.mock.calls[0][0]).toEqual({ title: 'manage.clubTeams.shareTitle', text: message })
    } finally {
      delete navigator.share
      writeText.mockRestore()
    }
  })

  it('an account that manages several clubs picks one', async () => {
    const other = { id: 'c2', name: 'VBC Other' }
    render(<MyClubPanel clubs={[VBCM, other]} />)
    await waitFor(() => expect(api.club.members).toHaveBeenCalledWith('c1'))
    fireEvent.change(screen.getByTestId('my-club-pick'), { target: { value: 'c2' } })
    await waitFor(() => expect(api.club.members).toHaveBeenCalledWith('c2'))
  })
})

describe('ClubsPanel: managers and contact', () => {
  it('an admin names the club\'s managers by address and sets its contact', async () => {
    api.clubs.list.mockResolvedValue(okRes({ clubs: [{ ...VBCM, teams: [], scorers: 0, managers: [], contact_email: null }], rule: { enabled: false } }))
    api.clubs.vmTeams.mockResolvedValue(okRes({ teams: [] }))
    api.clubs.update.mockResolvedValue(okRes({ club: VBCM }))
    api.clubs.setManagers.mockResolvedValue(okRes({ club: VBCM }))
    render(<ClubsPanel />)
    await screen.findByText('VBC Musterdorf')
    fireEvent.click(screen.getByRole('button', { name: 'manage.clubs.edit' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByTestId('club-contact'), { target: { value: 'info@vbc-musterdorf.ch' } })
    fireEvent.change(within(dialog).getByTestId('club-managers'), { target: { value: 'boss@vbc-musterdorf.ch\nvice@vbc-musterdorf.ch' } })
    fireEvent.click(within(dialog).getByTestId('save-club'))
    await waitFor(() => expect(api.clubs.setManagers).toHaveBeenCalledWith('c1', ['boss@vbc-musterdorf.ch', 'vice@vbc-musterdorf.ch']))
    expect(api.clubs.update).toHaveBeenCalledWith('c1', expect.objectContaining({ contact_email: 'info@vbc-musterdorf.ch' }))
  })

  it('an unknown address is named', async () => {
    api.clubs.list.mockResolvedValue(okRes({ clubs: [{ ...VBCM, teams: [], scorers: 0, managers: [], contact_email: null }], rule: { enabled: false } }))
    api.clubs.vmTeams.mockResolvedValue(okRes({ teams: [] }))
    api.clubs.update.mockResolvedValue(okRes({ club: VBCM }))
    api.clubs.setManagers.mockResolvedValue({ data: null, error: { code: 'OV_ACCOUNT_NOT_FOUND', details: 'nobody@vbc-musterdorf.ch', status: 404 }, status: 404 })
    render(<ClubsPanel />)
    await screen.findByText('VBC Musterdorf')
    fireEvent.click(screen.getByRole('button', { name: 'manage.clubs.edit' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByTestId('club-managers'), { target: { value: 'nobody@vbc-musterdorf.ch' } })
    fireEvent.click(within(dialog).getByTestId('save-club'))
    expect(await within(dialog).findByText('manage.clubs.managerUnknown')).toBeInTheDocument()
  })
})
