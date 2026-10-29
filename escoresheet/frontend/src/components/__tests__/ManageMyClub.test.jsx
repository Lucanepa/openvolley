import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// db/020: club managers. The My club tab (contact address, members, the
// club's invite codes) and the admin's managers / contact fields

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))

const api = vi.hoisted(() => ({
  club: { get: vi.fn(), setContact: vi.fn(), members: vi.fn(), removeMember: vi.fn(), listInvites: vi.fn(), createInvite: vi.fn(), revokeInvite: vi.fn() },
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

const KSC = { id: 'c1', name: 'KSC Wiedikon' }
const okRes = (data, status = 200) => ({ data, error: null, status })

beforeEach(() => {
  vi.clearAllMocks()
  ui.toasts = []
  ui.confirm.mockResolvedValue(true)
  api.club.get.mockResolvedValue(okRes({ club: { ...KSC, teams: ['KSC Wiedikon H1'], contact_email: 'info@ksc.ch', managers: [], scorers: 1 } }))
  api.club.members.mockResolvedValue(okRes({ members: [
    { id: 'u1', email: 'ada@example.ch', name: 'Ada Scorer', roles: ['scorer'], manager: false, joined_at: '2026-10-20T10:00:00Z' },
    { id: 'u2', email: 'new@example.ch', name: null, roles: [], manager: false, joined_at: '2026-10-28T10:00:00Z' }
  ] }))
  api.club.listInvites.mockResolvedValue(okRes({ invites: [] }))
})

describe('the My club tab', () => {
  it('is there for a club manager whatever its roles, next to an admin\'s tabs, never in OpenBeach\'s console', () => {
    const manager = { ...accessFromRoles([]), managedClubs: [KSC] }
    expect(manageTabsFor(manager)).toEqual(['myclub'])
    expect(manageTabsFor({ ...accessFromRoles(['admin']), managedClubs: [KSC] })).toContain('myclub')
    expect(manageTabsFor(accessFromRoles(['admin']))).not.toContain('myclub')
    expect(manageTabsFor({ ...accessFromRoles(['beach:competition_manager']), managedClubs: [KSC] }, MANAGER_BRANDS.beach)).not.toContain('myclub')
  })
})

describe('MyClubPanel', () => {
  it('saves the contact address', async () => {
    api.club.setContact.mockResolvedValue(okRes({ club: {} }))
    render(<MyClubPanel clubs={[KSC]} />)
    const input = await screen.findByTestId('my-club-contact')
    expect(input).toHaveValue('info@ksc.ch')
    fireEvent.change(input, { target: { value: 'sekretariat@ksc.ch' } })
    fireEvent.click(screen.getByTestId('my-club-contact-save'))
    await waitFor(() => expect(api.club.setContact).toHaveBeenCalledWith('c1', 'sekretariat@ksc.ch'))
    expect(ui.toasts).toContainEqual(['ok', 'manage.myClub.contactSaved'])
  })

  it('lists the members; removing one asks first and takes the club link only', async () => {
    api.club.removeMember.mockResolvedValue(okRes({ removed: 'u1' }))
    render(<MyClubPanel clubs={[KSC]} />)
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
    api.club.createInvite.mockResolvedValue(okRes({ code: 'ABCD-EFGH-JKMN', invite: { label: 'H1', club: 'KSC Wiedikon', role: 'referee' } }, 201))
    render(<MyClubPanel clubs={[KSC]} />)
    await waitFor(() => expect(api.club.listInvites).toHaveBeenCalledWith('c1'))
    expect(api.admin.listInvites).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: /manage\.invites\.new/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByTestId('invite-fixed-club')).toHaveValue('KSC Wiedikon')
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

  it('an account that manages several clubs picks one', async () => {
    const other = { id: 'c2', name: 'VBC Other' }
    render(<MyClubPanel clubs={[KSC, other]} />)
    await waitFor(() => expect(api.club.members).toHaveBeenCalledWith('c1'))
    fireEvent.change(screen.getByTestId('my-club-pick'), { target: { value: 'c2' } })
    await waitFor(() => expect(api.club.members).toHaveBeenCalledWith('c2'))
  })
})

describe('ClubsPanel: managers and contact', () => {
  it('an admin names the club\'s managers by address and sets its contact', async () => {
    api.clubs.list.mockResolvedValue(okRes({ clubs: [{ ...KSC, teams: [], scorers: 0, managers: [], contact_email: null }], rule: { enabled: false } }))
    api.clubs.vmTeams.mockResolvedValue(okRes({ teams: [] }))
    api.clubs.update.mockResolvedValue(okRes({ club: KSC }))
    api.clubs.setManagers.mockResolvedValue(okRes({ club: KSC }))
    render(<ClubsPanel />)
    await screen.findByText('KSC Wiedikon')
    fireEvent.click(screen.getByRole('button', { name: 'manage.clubs.edit' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByTestId('club-contact'), { target: { value: 'info@ksc.ch' } })
    fireEvent.change(within(dialog).getByTestId('club-managers'), { target: { value: 'boss@ksc.ch\nvice@ksc.ch' } })
    fireEvent.click(within(dialog).getByTestId('save-club'))
    await waitFor(() => expect(api.clubs.setManagers).toHaveBeenCalledWith('c1', ['boss@ksc.ch', 'vice@ksc.ch']))
    expect(api.clubs.update).toHaveBeenCalledWith('c1', expect.objectContaining({ contact_email: 'info@ksc.ch' }))
  })

  it('an unknown address is named', async () => {
    api.clubs.list.mockResolvedValue(okRes({ clubs: [{ ...KSC, teams: [], scorers: 0, managers: [], contact_email: null }], rule: { enabled: false } }))
    api.clubs.vmTeams.mockResolvedValue(okRes({ teams: [] }))
    api.clubs.update.mockResolvedValue(okRes({ club: KSC }))
    api.clubs.setManagers.mockResolvedValue({ data: null, error: { code: 'OV_ACCOUNT_NOT_FOUND', details: 'nobody@ksc.ch', status: 404 }, status: 404 })
    render(<ClubsPanel />)
    await screen.findByText('KSC Wiedikon')
    fireEvent.click(screen.getByRole('button', { name: 'manage.clubs.edit' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByTestId('club-managers'), { target: { value: 'nobody@ksc.ch' } })
    fireEvent.click(within(dialog).getByTestId('save-club'))
    expect(await within(dialog).findByText('manage.clubs.managerUnknown')).toBeInTheDocument()
  })
})
