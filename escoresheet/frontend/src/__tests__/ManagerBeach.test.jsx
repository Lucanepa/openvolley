// OpenBeach's manager (manager-beach.openvolley.app): the same ManagerApp with
// the OpenBeach brand (src/managerBrand.js, plan S2). Beach roles, beach
// lists (?app=beach), "Join OpenBeach" for accounts that have not joined.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import en from '../i18n/locales/en.json'
import de from '../i18n/locales/de.json'
import deCH from '../i18n/locales/de-CH.json'
import fr from '../i18n/locales/fr.json'
import it_ from '../i18n/locales/it.json'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => (typeof opts === 'string' ? opts : key),
    i18n: { language: 'en', changeLanguage: vi.fn() }
  })
}))

const auth = vi.hoisted(() => ({ value: null }))
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth.value }))

const api = vi.hoisted(() => ({
  admin: {
    listAccounts: vi.fn(async () => ({ data: { accounts: [] }, error: null, status: 200 })),
    listInvites: vi.fn(async () => ({ data: { invites: [] }, error: null, status: 200 })),
    listOfficialGames: vi.fn(async () => ({ data: { games: [] }, error: null, status: 200 })),
    listMatches: vi.fn(async () => ({ data: { matches: [] }, error: null, status: 200 })),
    listAudit: vi.fn(async () => ({ data: { entries: [], next_before: null }, error: null, status: 200 })),
    setRoles: vi.fn(async () => ({ data: { roles: ['beach:scorer'] }, error: null, status: 200 })),
    createInvite: vi.fn(async () => ({ data: { code: 'ABCD-EFGH-JKLM', invite: { label: 'Tour', role: 'scorer', sport: 'beach' } }, error: null, status: 200 }))
  },
  savedTeamsApi: { fetchBundle: vi.fn(async () => ({ data: { version: '0', competitions: [], teams: [] }, error: null, status: 200 })) },
  fetchMe: vi.fn(async () => ({ data: { apps: { indoor: { member: true }, beach: { member: true } } }, error: null, status: 200 })),
  joinApp: vi.fn(async () => ({ data: { app: 'beach', member: true, already_member: false }, error: null, status: 200 }))
}))
vi.mock('../lib/accountApi', async (orig) => ({
  ...(await orig()),
  admin: api.admin,
  savedTeamsApi: api.savedTeamsApi,
  fetchMe: api.fetchMe,
  joinApp: api.joinApp
}))
const store = vi.hoisted(() => ({ storeSavedTeamsBundle: vi.fn(async () => []) }))
vi.mock('../db/savedTeams', () => store)
vi.mock('../lib/apiClient', () => ({
  apiFrom: () => {
    const b = { select: () => b, in: () => b, limit: () => b, then: (r) => Promise.resolve({ data: [], error: null }).then(r) }
    return b
  },
  apiRequest: vi.fn(),
  apiAuth: { confirmPasswordReset: vi.fn(async () => ({ data: { password_updated: true }, error: null })), confirmEmail: vi.fn() }
}))

import ManagerApp from '../ManagerApp'
import ManageConsole, { manageTabsFor } from '../components/manage/ManageConsole'
import AccountsPanel from '../components/manage/AccountsPanel'
import AuditPanel, { auditDetailsLine } from '../components/manage/AuditPanel'
import { ManagerBrandProvider, MANAGER_BRANDS, managerBrandOf } from '../managerBrand'
import { accessFromRoles, accessForApp, NO_ACCESS } from '../lib/access'
import { apiAuth } from '../lib/apiClient'
import { ResetPasswordPage } from '../components/auth/AuthLinkPages'

const BEACH_APP = 'https://beach.openvolley.app/'

function setAuth({ user = { id: 'u-1', email: 'bea@club.ch', email_confirmed_at: '2026-10-01T08:00:00Z' }, roles = [], known = true } = {}) {
  auth.value = {
    user,
    profile: user ? { user_id: user.id, first_name: 'Bea', last_name: 'Beach', roles } : null,
    access: user ? { ...accessFromRoles(roles), known } : NO_ACCESS,
    loading: false,
    signIn: vi.fn(async () => ({ error: null })),
    signUp: vi.fn(async () => ({ data: { user: { id: 'u-new' } }, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    resetPassword: vi.fn(),
    fetchProfile: vi.fn(async () => null),
    redeemInvite: vi.fn(async () => ({ data: { roles: ['beach:scorer'] }, error: null })),
    resendConfirmation: vi.fn(async () => ({ data: { sent: true }, error: null })),
    refreshUser: vi.fn(async () => null)
  }
}

const renderBeach = (ui = <ManagerApp />) => render(<ManagerBrandProvider app="beach">{ui}</ManagerBrandProvider>)
const railButtons = () => within(screen.getAllByRole('navigation')[0]).getAllByRole('button')

describe('managerBrand', () => {
  it('two brands; anything but beach is OpenVolley', () => {
    expect(managerBrandOf('beach')).toBe(MANAGER_BRANDS.beach)
    for (const v of [undefined, null, 'indoor', 'snow']) expect(managerBrandOf(v)).toBe(MANAGER_BRANDS.indoor)
    expect(MANAGER_BRANDS.beach).toMatchObject({ name: 'OpenBeach', siteUrl: 'https://manager-beach.openvolley.app', scope: 'beach' })
    expect(MANAGER_BRANDS.indoor).toMatchObject({ name: 'OpenVolley', tabs: null, scope: 'indoor' })
  })

  it('tabs: OpenBeach has no official games or closed matches; roles of its own app', () => {
    const beach = MANAGER_BRANDS.beach
    expect(manageTabsFor(accessFromRoles(['admin']), beach)).toEqual(['accounts', 'invites', 'audit', 'teams'])
    expect(manageTabsFor(accessFromRoles(['beach:competition_manager']), beach)).toEqual(['teams'])
    // an indoor competition manager manages nothing in OpenBeach, and the reverse
    expect(manageTabsFor(accessFromRoles(['competition_manager']), beach)).toEqual([])
    expect(manageTabsFor(accessFromRoles(['beach:competition_manager']))).toEqual([])
    // OpenVolley's console: as before
    expect(manageTabsFor(accessFromRoles(['admin']))).toEqual(['accounts', 'invites', 'games', 'matches', 'audit', 'teams'])
    expect(manageTabsFor(accessFromRoles(['admin']), MANAGER_BRANDS.indoor)).toEqual(['accounts', 'invites', 'games', 'matches', 'audit', 'teams'])
  })

  it('accessForApp: the beach flags; indoor is the access itself', () => {
    const a = { ...accessFromRoles(['scorer', 'beach:competition_manager']), known: true }
    expect(accessForApp(a, 'indoor')).toBe(a)
    expect(accessForApp(a, 'beach')).toMatchObject({ roles: ['beach:competition_manager'], canScore: false, canManageTeams: true, canReadTeams: true, isPending: false, isAdmin: false, known: true })
    expect(accessForApp({ ...accessFromRoles(['scorer']), known: true }, 'beach')).toMatchObject({ isPending: true, canScore: false })
    expect(accessForApp({ ...accessFromRoles(['admin']), known: true }, 'beach')).toMatchObject({ isPending: false, canScore: true, isAdmin: true })
    // the indoor flags never count a beach role
    expect(accessFromRoles(['beach:scorer'])).toMatchObject({ canScore: false, isPending: true })
  })
})

describe('ManagerApp as OpenBeach\'s manager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/')
  })

  it('signed out: OpenBeach\'s name, logo and texts', () => {
    setAuth({ user: null })
    renderBeach()
    const card = screen.getByTestId('manager-sign-in')
    expect(within(card).getByRole('heading', { name: 'managerBeach.signInHeading' })).toBeInTheDocument()
    expect(within(card).getByText('managerBeach.signInBody')).toBeInTheDocument()
    expect(within(card).getByText('managerBeach.noAccountYet')).toBeInTheDocument()
    expect(screen.getByAltText('OpenBeach')).toBeInTheDocument()
    expect(screen.queryByAltText('OpenVolley')).toBeNull()
    expect(screen.getByText(/^OpenBeach/)).toBeInTheDocument()
    expect(api.fetchMe).not.toHaveBeenCalled()
  })

  it('admin: four tabs, every list asked for ?app=beach, a link to OpenBeach', async () => {
    setAuth({ roles: ['admin'] })
    renderBeach()
    expect(railButtons().map(b => b.textContent)).toEqual(['manage.tabs.accounts', 'manage.tabs.invites', 'manage.tabs.audit', 'manage.tabs.teams'])
    expect(screen.getByRole('link', { name: 'managerBeach.openAppLong' })).toHaveAttribute('href', BEACH_APP)
    expect(screen.getByAltText('OpenBeach')).toBeInTheDocument()
    await waitFor(() => expect(api.admin.listAccounts).toHaveBeenCalledWith({ filter: 'pending', q: undefined, app: 'beach' }))
    expect(api.admin.listAccounts).toHaveBeenCalledWith({ filter: 'pending', app: 'beach' })
    for (const tab of ['invites', 'audit', 'teams']) fireEvent.click(railButtons().find(b => b.textContent === `manage.tabs.${tab}`))
    await waitFor(() => expect(api.admin.listInvites).toHaveBeenCalledWith({ app: 'beach' }))
    await waitFor(() => expect(api.admin.listAudit).toHaveBeenCalledWith({ limit: 50, before: undefined, app: 'beach' }))
    await waitFor(() => expect(api.savedTeamsApi.fetchBundle).toHaveBeenCalledWith({ sport: 'beach' }))
    // no indoor/beach switch, and OpenVolley's offline team cache is left alone
    expect(screen.queryByRole('radiogroup', { name: 'savedTeams.sport' })).toBeNull()
    expect(store.storeSavedTeamsBundle).not.toHaveBeenCalled()
    expect(api.admin.listOfficialGames).not.toHaveBeenCalled()
    expect(api.fetchMe).not.toHaveBeenCalled()
  })

  it('beach competition manager: saved teams only', async () => {
    window.history.replaceState(null, '', '/#accounts')
    setAuth({ roles: ['beach:competition_manager'] })
    renderBeach()
    expect(railButtons().map(b => b.textContent)).toEqual(['manage.tabs.teams'])
    await waitFor(() => expect(api.savedTeamsApi.fetchBundle).toHaveBeenCalledWith({ sport: 'beach' }))
    expect(api.admin.listAccounts).not.toHaveBeenCalled()
  })

  it('an OpenVolley account that has not joined: "Join OpenBeach", then the invite step', async () => {
    api.fetchMe.mockResolvedValueOnce({ data: { apps: { indoor: { member: true }, beach: { member: false } } }, error: null, status: 200 })
    setAuth({ roles: ['competition_manager'] })
    renderBeach()
    const page = await screen.findByTestId('manager-join-app')
    expect(within(page).getByRole('heading', { name: 'managerBeach.joinTitle' })).toBeInTheDocument()
    expect(within(page).getByText('managerBeach.joinBody')).toBeInTheDocument()
    expect(screen.queryByTestId('manage-console')).toBeNull()
    fireEvent.click(within(page).getByRole('button', { name: 'managerBeach.joinButton' }))
    await waitFor(() => expect(api.joinApp).toHaveBeenCalledWith('beach'))
    const step = await screen.findByTestId('manager-invite-step')
    expect(within(step).getByText('managerBeach.inviteStepBody')).toBeInTheDocument()
    expect(within(step).getByRole('link', { name: 'managerBeach.openAppLong' })).toHaveAttribute('href', BEACH_APP)
  })

  it('a failed join says so and stays', async () => {
    api.fetchMe.mockResolvedValueOnce({ data: { apps: { beach: { member: false } } }, error: null, status: 200 })
    api.joinApp.mockResolvedValueOnce({ data: null, error: { status: 0, network: true }, status: 0 })
    setAuth({ roles: [] })
    renderBeach()
    fireEvent.click(within(await screen.findByTestId('manager-join-app')).getByRole('button', { name: 'managerBeach.joinButton' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('managerBeach.joinFailed')
    expect(screen.getByTestId('manager-join-app')).toBeInTheDocument()
  })

  it('a member without a beach role: the invite step (an indoor scorer is pending here)', async () => {
    setAuth({ roles: ['scorer'] })
    renderBeach()
    const step = await screen.findByTestId('manager-invite-step')
    expect(within(step).getByText('managerBeach.inviteStepBody')).toBeInTheDocument()
    expect(within(step).getByText('managerBeach.nativeAppsNote')).toBeInTheDocument()
    expect(api.fetchMe).toHaveBeenCalledTimes(1)
  })

  it('/api/me unreadable: the invite step (a beach code joins too)', async () => {
    api.fetchMe.mockResolvedValueOnce({ data: null, error: { status: 503 }, status: 503 })
    setAuth({ roles: [] })
    renderBeach()
    expect(await screen.findByTestId('manager-invite-step')).toBeInTheDocument()
  })

  it('beach scorer: "you\'re all set" with OpenBeach\'s text and link, no /api/me', () => {
    setAuth({ roles: ['beach:scorer'] })
    renderBeach()
    const page = screen.getByTestId('manager-all-set')
    expect(within(page).getByText('managerBeach.allSetBody')).toBeInTheDocument()
    expect(within(page).getByRole('link', { name: 'managerBeach.openAppLong' })).toHaveAttribute('href', BEACH_APP)
    expect(api.fetchMe).not.toHaveBeenCalled()
  })

  it('beach referee: no access', () => {
    setAuth({ roles: ['beach:referee'] })
    renderBeach()
    expect(screen.getByTestId('manager-no-access')).toBeInTheDocument()
  })

  it('#signup: OpenBeach\'s text; an existing address is told to sign in and join', async () => {
    window.history.replaceState(null, '', '/#signup')
    setAuth({ user: null })
    auth.value.signUp = vi.fn(async () => ({ data: null, error: { message: 'A user with this email address has already been registered', code: 'user_already_exists', status: 422 } }))
    renderBeach()
    const page = screen.getByTestId('manager-sign-up')
    expect(within(page).getByText('managerBeach.signUpBody')).toBeInTheDocument()
    for (const [label, value] of Object.entries({ Email: 'ivo@club.ch', Password: 'secret1', 'Confirm password': 'secret1' })) {
      fireEvent.change(within(page).getByLabelText(label), { target: { value } })
    }
    fireEvent.click(within(page).getByRole('button', { name: 'Create account' }))
    expect(await within(page).findByRole('alert')).toHaveTextContent('managerBeach.existingAccount')
    window.history.replaceState(null, '', '/')
  })

  it('OpenVolley\'s manager never asks /api/me and keeps its texts', () => {
    setAuth({ roles: [] })
    render(<ManagerApp />)
    expect(screen.getByTestId('manager-invite-step')).toBeInTheDocument()
    expect(screen.getByText('managerSite.inviteStepBody')).toBeInTheDocument()
    expect(api.fetchMe).not.toHaveBeenCalled()
  })
})

describe('OpenBeach\'s console panels', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accounts: approve grants beach:scorer; the roles dialog offers the beach roles only', async () => {
    api.admin.listAccounts.mockResolvedValue({
      data: { accounts: [{ id: 'a-1', email: 'ivo@club.ch', first_name: 'Ivo', roles: ['scorer'], pending: true, created_at: '2026-10-01T08:00:00Z' }] },
      error: null,
      status: 200
    })
    render(<AccountsPanel selfId="u-1" app="beach" />)
    // the indoor role is not shown here: the account is pending in OpenBeach
    expect(await screen.findByText('access.roles.pending')).toBeInTheDocument()
    expect(screen.queryByText('access.roles.scorer')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'manage.accounts.approve' }))
    await waitFor(() => expect(api.admin.setRoles).toHaveBeenCalledWith('a-1', { add: ['beach:scorer'], remove: [] }))
    fireEvent.click(screen.getByRole('button', { name: 'manage.accounts.editRoles' }))
    const dialog = screen.getByRole('dialog')
    const boxes = within(dialog).getAllByRole('checkbox')
    expect(boxes.map(b => b.closest('label')?.textContent)).toEqual(['access.roles.scorer', 'access.roles.referee', 'access.roles.competition_manager'])
    fireEvent.click(boxes[2])
    fireEvent.click(within(dialog).getByRole('button', { name: 'manage.accounts.save' }))
    await waitFor(() => expect(api.admin.setRoles).toHaveBeenLastCalledWith('a-1', { add: ['beach:competition_manager'], remove: [] }))
    api.admin.listAccounts.mockReset()
    api.admin.listAccounts.mockImplementation(async () => ({ data: { accounts: [] }, error: null, status: 200 }))
  })

  it('the console without a brand (the main app) is OpenVolley\'s: its lists ask ?app=indoor (S2 review)', async () => {
    setAuth({ roles: ['admin'] })
    render(<ManageConsole tab="accounts" onTab={() => {}} />)
    await waitFor(() => expect(api.admin.listAccounts).toHaveBeenCalledWith({ filter: 'pending', q: undefined, app: 'indoor' }))
    expect(api.admin.listAccounts).toHaveBeenCalledWith({ filter: 'pending', app: 'indoor' })
    expect(api.admin.listAccounts.mock.calls.every(([o]) => o.app === 'indoor')).toBe(true)
    expect(screen.getByAltText('OpenVolley')).toBeInTheDocument()
  })

  it('audit: "Joined this app" has a label, and OpenBeach\'s console names beach roles plainly', async () => {
    const entries = [
      { id: 2, at: '2026-10-02T08:00:00Z', action: 'account.roles', details: { added: ['beach:scorer'], removed: ['beach:referee'] } },
      { id: 1, at: '2026-10-01T08:00:00Z', action: 'account.join', details: { app: 'beach' } }
    ]
    api.admin.listAudit.mockResolvedValue({ data: { entries, next_before: null }, error: null, status: 200 })
    render(<AuditPanel app="beach" />)
    // (this file's t() answers the fallback: the role's plain name)
    expect(await screen.findByText('+ scorer · − referee')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('beach:')
    api.admin.listAudit.mockReset()
    api.admin.listAudit.mockImplementation(async () => ({ data: { entries: [], next_before: null }, error: null, status: 200 }))
  })
})

describe('the email-link pages on OpenBeach\'s manager', () => {
  it('a new password asks for OpenBeach\'s "password changed" mail and shows OpenBeach\'s text', async () => {
    renderBeach(<ResetPasswordPage token={'A'.repeat(43)} lang="de" onSignIn={() => {}} onRequestNew={() => {}} />)
    expect(screen.getByText('managerBeach.newPasswordBody')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('authEmail.newPassword'), { target: { value: 'secret12' } })
    fireEvent.change(screen.getByLabelText('authEmail.repeatPassword'), { target: { value: 'secret12' } })
    fireEvent.click(screen.getByRole('button', { name: 'authEmail.savePassword' }))
    await waitFor(() => expect(apiAuth.confirmPasswordReset).toHaveBeenCalledWith('A'.repeat(43), 'secret12', 'de', 'beach'))
  })
})

describe('managerBeach strings', () => {
  const locales = { en, de, 'de-CH': deCH, fr, it: it_ }
  it.each(Object.keys(locales))('%s has every managerBeach key, each naming OpenBeach where English does', (lng) => {
    expect(Object.keys(locales[lng].managerBeach).sort()).toEqual(Object.keys(en.managerBeach).sort())
    for (const [k, v] of Object.entries(locales[lng].managerBeach)) {
      expect(v, `${lng} ${k}`).toBeTruthy()
      if (en.managerBeach[k].includes('OpenBeach')) expect(v, `${lng} ${k}`).toContain('OpenBeach')
    }
  })
  it('Swiss German writes ss', () => {
    expect(JSON.stringify(deCH.managerBeach)).not.toContain('ß')
  })
  // The audit title key is built at run time (check:i18n cannot see it): every
  // action the backend writes has a label in every language (S2 review: account.join)
  it.each(Object.keys(locales))('%s labels every audit action of the backend', (lng) => {
    let src
    try { src = readFileSync(fileURLToPath(new URL('../../../backend/lib/accounts.js', import.meta.url)), 'utf8') } catch { return }
    const block = src.match(/export const AUDIT_ACTIONS = Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] || ''
    const actions = [...block.replace(/\/\/.*$/gm, '').matchAll(/'([a-z_.]+)'/g)].map(m => m[1])
    expect(actions).toContain('account.join')
    for (const a of actions) expect(locales[lng].manage.audit.actions[a.replace(/\./g, '_')], `${lng} ${a}`).toBeTruthy()
  })
})

describe('auditDetailsLine', () => {
  it('names roles with roleLabel, as stored without it', () => {
    const e = { details: { added: ['beach:scorer'], removed: [] } }
    expect(auditDetailsLine(e)).toBe('+ beach:scorer')
    expect(auditDetailsLine(e, { roleLabel: (r) => r.replace('beach:', '').toUpperCase() })).toBe('+ SCORER')
    expect(auditDetailsLine({ details: { label: 'Tour', role: 'scorer', sport: 'beach' } }, { roleLabel: () => 'Scorer' })).toBe('Tour · Scorer')
  })
})
