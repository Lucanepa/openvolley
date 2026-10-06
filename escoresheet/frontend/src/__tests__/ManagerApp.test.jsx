import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
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
    listAudit: vi.fn(async () => ({ data: { entries: [], next_before: null }, error: null, status: 200 }))
  },
  savedTeamsApi: { fetchBundle: vi.fn(async () => ({ data: { version: '0', competitions: [], teams: [] }, error: null, status: 200 })) }
}))
vi.mock('../lib/accountApi', async (orig) => ({ ...(await orig()), admin: api.admin, savedTeamsApi: api.savedTeamsApi }))
vi.mock('../db/savedTeams', () => ({ storeSavedTeamsBundle: vi.fn(async () => []) }))
vi.mock('../lib/apiClient', () => ({
  apiFrom: () => {
    const b = { select: () => b, in: () => b, limit: () => b, then: (r) => Promise.resolve({ data: [], error: null }).then(r) }
    return b
  },
  apiRequest: vi.fn()
}))

import ManagerApp, { ACCOUNT_LOAD_TIMEOUT_MS, tabFromHash } from '../ManagerApp'
import { accessFromRoles, NO_ACCESS } from '../lib/access'

function setAuth({ user = { id: 'u-1', email: 'admin@club.ch' }, roles = [], known = true, loading = false, profile } = {}) {
  auth.value = {
    user,
    profile: profile ?? (user ? { user_id: user.id, first_name: 'Ada', last_name: 'Admin', roles } : null),
    access: user ? { ...accessFromRoles(roles), known } : NO_ACCESS,
    loading,
    signIn: vi.fn(async () => ({ error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    resetPassword: vi.fn(),
    fetchProfile: vi.fn(async () => null),
    redeemInvite: vi.fn(async () => ({ data: { roles: ['competition_manager'] }, error: null }))
  }
}

// jsdom runs on localhost: the dev server serves the app on this origin
const APP_URL = `${window.location.origin}/`
const railButtons = () => within(screen.getAllByRole('navigation')[0]).getAllByRole('button')

describe('ManagerApp (manager.openvolley.app)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/')
  })
  afterEach(() => vi.useRealTimers())

  it('waits for the session with a labelled spinner', () => {
    setAuth({ user: null, loading: true })
    render(<ManagerApp />)
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByTestId('manager-sign-in')).toBeNull()
  })

  it('signed out: the sign-in card opens the app sign-in dialog; sign up goes to the scorer app', () => {
    setAuth({ user: null })
    render(<ManagerApp />)
    const card = screen.getByTestId('manager-sign-in')
    expect(within(card).getByRole('heading', { name: 'managerSite.signInHeading' })).toBeInTheDocument()
    // the only way to an account is the link to the scorer app
    expect(within(card).getByRole('link', { name: 'managerSite.openAppLong' })).toHaveAttribute('href', APP_URL)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'managerSite.signIn' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Email')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Password')).toBeInTheDocument()
    expect(screen.queryByTestId('manage-console')).toBeNull()
  })

  it('admin: the full console, no "back to the app", a link to the app and sign out', async () => {
    setAuth({ roles: ['admin'] })
    render(<ManagerApp />)
    expect(screen.getByTestId('manage-console')).toBeInTheDocument()
    expect(railButtons().map(b => b.textContent)).toEqual([
      'manage.tabs.accounts', 'manage.tabs.invites', 'manage.tabs.games',
      'manage.tabs.matches', 'manage.tabs.audit', 'manage.tabs.teams'
    ])
    expect(screen.queryByRole('button', { name: 'manage.backToApp' })).toBeNull()
    expect(screen.getByRole('link', { name: 'managerSite.openAppLong' })).toHaveAttribute('href', APP_URL)
    expect(screen.getByTitle('Ada Admin')).toBeInTheDocument()
    await waitFor(() => expect(api.admin.listAccounts).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'managerSite.signOut' }))
    await waitFor(() => expect(auth.value.signOut).toHaveBeenCalled())
  })

  it('admin: the tab follows the URL hash both ways', async () => {
    window.history.replaceState(null, '', '/#audit')
    setAuth({ roles: ['admin'] })
    render(<ManagerApp />)
    expect(railButtons().find(b => b.getAttribute('aria-current') === 'page').textContent).toBe('manage.tabs.audit')
    await waitFor(() => expect(api.admin.listAudit).toHaveBeenCalled())
    fireEvent.click(railButtons().find(b => b.textContent === 'manage.tabs.invites'))
    expect(window.location.hash).toBe('#invites')
    expect(railButtons().find(b => b.getAttribute('aria-current') === 'page').textContent).toBe('manage.tabs.invites')
  })

  it('the hash is handed to the console as is: a tab added there is restored too', () => {
    // no copy of the console's tab ids in ManagerApp (they would go stale)
    window.history.replaceState(null, '', '/#competitions')
    expect(tabFromHash()).toBe('competitions')
    window.history.replaceState(null, '', '/#teams')
    expect(tabFromHash()).toBe('teams')
    window.history.replaceState(null, '', '/')
    expect(tabFromHash()).toBeNull()
  })

  it('admin: an unknown tab in the hash opens the first tab', async () => {
    window.history.replaceState(null, '', '/#no-such-tab')
    setAuth({ roles: ['admin'] })
    render(<ManagerApp />)
    expect(railButtons().find(b => b.getAttribute('aria-current') === 'page').textContent).toBe('manage.tabs.accounts')
    await waitFor(() => expect(api.admin.listAccounts).toHaveBeenCalled())
  })

  it('competition manager: saved teams only, whatever the hash asks', async () => {
    window.history.replaceState(null, '', '/#accounts')
    setAuth({ roles: ['competition_manager'] })
    render(<ManagerApp />)
    expect(railButtons().map(b => b.textContent)).toEqual(['manage.tabs.teams'])
    await waitFor(() => expect(api.savedTeamsApi.fetchBundle).toHaveBeenCalled())
    expect(api.admin.listAccounts).not.toHaveBeenCalled()
  })

  it('pending account: "no access, ask an admin", the invite code field and sign out', async () => {
    setAuth({ roles: [] })
    render(<ManagerApp />)
    const page = screen.getByTestId('manager-no-access')
    expect(within(page).getByText('managerSite.noAccessTitle')).toBeInTheDocument()
    expect(within(page).getByText('managerSite.pendingBody')).toBeInTheDocument()
    expect(within(page).getByLabelText('access.inviteCodeLabel')).toBeInTheDocument()
    expect(within(page).getByText('managerSite.signedInAs')).toBeInTheDocument()
    expect(screen.queryByTestId('manage-console')).toBeNull()
    fireEvent.click(within(page).getByRole('button', { name: 'managerSite.signOut' }))
    await waitFor(() => expect(auth.value.signOut).toHaveBeenCalled())
  })

  it('scorer-only account: no access either, with the "ask an admin" text', () => {
    setAuth({ roles: ['scorer', 'referee'] })
    render(<ManagerApp />)
    const page = screen.getByTestId('manager-no-access')
    expect(within(page).getByText('managerSite.noAccessBody')).toBeInTheDocument()
    expect(screen.queryByTestId('manage-console')).toBeNull()
  })

  it('signed in but roles not known yet: loading, then a retry that re-reads the profile', async () => {
    vi.useFakeTimers()
    setAuth({ roles: [], known: false, profile: null })
    render(<ManagerApp />)
    const page = screen.getByTestId('manager-account-loading')
    expect(within(page).getByRole('status')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(ACCOUNT_LOAD_TIMEOUT_MS) })
    expect(within(page).getByRole('alert')).toHaveTextContent('managerSite.accountNotLoaded')
    vi.useRealTimers()
    fireEvent.click(within(page).getByRole('button', { name: 'managerSite.retry' }))
    await waitFor(() => expect(auth.value.fetchProfile).toHaveBeenCalledWith('u-1'))
  })
})

describe('managerSite strings', () => {
  const locales = { en, de, 'de-CH': deCH, fr, it: it_ }
  it.each(Object.keys(locales))('%s has every managerSite key', (lng) => {
    expect(Object.keys(locales[lng].managerSite).sort()).toEqual(Object.keys(en.managerSite).sort())
    for (const [k, v] of Object.entries(locales[lng].managerSite)) expect(v, `${lng} ${k}`).toBeTruthy()
    expect(locales[lng].managerSite.openManager).toContain('{{host}}')
    expect(locales[lng].managerSite.signedInAs).toContain('{{name}}')
  })
  it('Swiss German writes ss', () => {
    expect(JSON.stringify(deCH.managerSite)).not.toContain('ß')
  })
})
