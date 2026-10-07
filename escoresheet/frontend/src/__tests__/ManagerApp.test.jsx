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
    signUp: vi.fn(async () => ({ data: { user: { id: 'u-new', email_confirmed_at: '2026-10-07T08:00:00Z' } }, error: null })),
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

  it('signed out: the sign-in card opens the app sign-in dialog; "Create account" opens #signup', () => {
    setAuth({ user: null })
    render(<ManagerApp />)
    const card = screen.getByTestId('manager-sign-in')
    expect(within(card).getByRole('heading', { name: 'managerSite.signInHeading' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'managerSite.signIn' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Email')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Password')).toBeInTheDocument()
    expect(screen.queryByTestId('manage-console')).toBeNull()
    // the dialog's "Don't have an account?" stays on this site (no link to the scorer app)
    expect(within(dialog).queryByTestId('create-account-link')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create account' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('manager-sign-up')).toBeInTheDocument()
    expect(window.location.hash).toBe('#signup')
  })

  it('signed out: the card\'s own "Create account" button opens the sign-up page, "back" returns', () => {
    setAuth({ user: null })
    render(<ManagerApp />)
    fireEvent.click(screen.getByRole('button', { name: 'managerSite.createAccount' }))
    expect(window.location.hash).toBe('#signup')
    const page = screen.getByTestId('manager-sign-up')
    fireEvent.click(within(page).getByRole('button', { name: 'managerSite.backToSignIn' }))
    expect(window.location.hash).toBe('')
    expect(screen.getByTestId('manager-sign-in')).toBeInTheDocument()
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

  it('pending account: the next step is the club\'s invite code, with the way without one', async () => {
    setAuth({ roles: [] })
    render(<ManagerApp />)
    const page = screen.getByTestId('manager-invite-step')
    expect(within(page).getByRole('heading', { name: 'managerSite.inviteStepTitle' })).toBeInTheDocument()
    expect(within(page).getByText('managerSite.inviteStepBody')).toBeInTheDocument()
    expect(within(page).getByText('managerSite.inviteStepNoCode')).toBeInTheDocument()
    expect(within(page).getByLabelText('access.inviteCodeLabel')).toBeInTheDocument()
    // the web app, and a word for the desktop / Android apps
    expect(within(page).getByRole('link', { name: 'managerSite.openAppLong' })).toHaveAttribute('href', APP_URL)
    expect(within(page).getByText('managerSite.nativeAppsNote')).toBeInTheDocument()
    expect(within(page).getByText('managerSite.signedInAs')).toBeInTheDocument()
    // "account created" belongs to a sign-up made just now only
    expect(within(page).queryByText('managerSite.accountCreated')).toBeNull()
    expect(screen.queryByTestId('manager-no-access')).toBeNull()
    expect(screen.queryByTestId('manage-console')).toBeNull()
    fireEvent.click(within(page).getByRole('button', { name: 'managerSite.signOut' }))
    await waitFor(() => expect(auth.value.signOut).toHaveBeenCalled())
  })

  it('pending account: a redeemed invite code sends the code to the server', async () => {
    setAuth({ roles: [] })
    render(<ManagerApp />)
    const page = screen.getByTestId('manager-invite-step')
    fireEvent.change(within(page).getByLabelText('access.inviteCodeLabel'), { target: { value: 'ABCD-EFGH-JKLM' } })
    fireEvent.click(within(page).getByRole('button', { name: 'access.redeem' }))
    await waitFor(() => expect(auth.value.redeemInvite).toHaveBeenCalledWith('ABCD-EFGH-JKLM'))
  })

  it('approved scorer without a manage role: "you\'re all set", not "no access"', () => {
    setAuth({ roles: ['scorer', 'referee'] })
    render(<ManagerApp />)
    const page = screen.getByTestId('manager-all-set')
    expect(within(page).getByRole('heading', { name: 'managerSite.allSetTitle' })).toBeInTheDocument()
    expect(within(page).getByRole('link', { name: 'managerSite.openAppLong' })).toHaveAttribute('href', APP_URL)
    expect(within(page).getByText('managerSite.nativeAppsNote')).toBeInTheDocument()
    expect(screen.queryByTestId('manager-no-access')).toBeNull()
    expect(screen.queryByTestId('manage-console')).toBeNull()
    // a code for a manage role can still be entered, behind a quiet button
    expect(within(page).queryByLabelText('access.inviteCodeLabel')).toBeNull()
    fireEvent.click(within(page).getByRole('button', { name: 'managerSite.haveManagerCode' }))
    expect(within(page).getByLabelText('access.inviteCodeLabel')).toBeInTheDocument()
  })

  it('referee-only account: no access, with the "ask an admin" text and the invite code', () => {
    setAuth({ roles: ['referee'] })
    render(<ManagerApp />)
    const page = screen.getByTestId('manager-no-access')
    expect(within(page).getByText('managerSite.noAccessBody')).toBeInTheDocument()
    expect(within(page).getByLabelText('access.inviteCodeLabel')).toBeInTheDocument()
    expect(screen.queryByTestId('manage-console')).toBeNull()
  })

  it('signed in on #signup: the hash is dropped and the console opens its first tab', async () => {
    window.history.replaceState(null, '', '/#signup')
    setAuth({ roles: ['admin'] })
    render(<ManagerApp />)
    expect(screen.getByTestId('manage-console')).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe(''))
    expect(railButtons().find(b => b.getAttribute('aria-current') === 'page').textContent).toBe('manage.tabs.accounts')
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

describe('ManagerApp #signup (accounts are made here)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/#signup')
  })
  afterEach(() => window.history.replaceState(null, '', '/'))

  const fill = (page, values) => {
    for (const [label, value] of Object.entries(values)) {
      fireEvent.change(within(page).getByLabelText(label), { target: { value } })
    }
  }
  const valid = {
    'First name': 'Lea',
    'Last name': 'Muster',
    Email: 'lea@club.ch',
    Password: 'secret1',
    'Confirm password': 'secret1'
  }

  it('the page: every field of the sign-up, the date of birth empty, a way back to sign in', () => {
    setAuth({ user: null })
    render(<ManagerApp />)
    const page = screen.getByTestId('manager-sign-up')
    expect(within(page).getByRole('heading', { name: 'managerSite.signUpHeading' })).toBeInTheDocument()
    for (const label of ['First name', 'Last name', 'Country', 'Date of birth', 'Email', 'Password', 'Confirm password']) {
      expect(within(page).getByLabelText(label)).toBeInTheDocument()
    }
    expect(within(page).getByLabelText('Country')).toHaveValue('CHE')
    // never today's date: a text field, empty until the user types
    const dob = within(page).getByLabelText('Date of birth')
    expect(dob).toHaveValue('')
    expect(dob).toHaveAttribute('type', 'text')
    expect(within(page).getByText('access.signUpPendingNote')).toBeInTheDocument()
    // "Already have an account? Sign in" opens the sign-in dialog here
    fireEvent.click(within(page).getByRole('button', { name: 'Sign in' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('checks the passwords and the date of birth before asking the server', async () => {
    setAuth({ user: null })
    render(<ManagerApp />)
    const page = screen.getByTestId('manager-sign-up')
    const submit = () => fireEvent.click(within(page).getByRole('button', { name: 'Create account' }))

    fill(page, { ...valid, 'Confirm password': 'other12' })
    submit()
    expect(await within(page).findByRole('alert')).toHaveTextContent('Passwords do not match')

    fill(page, { ...valid, Password: 'abc', 'Confirm password': 'abc' })
    submit()
    expect(await within(page).findByRole('alert')).toHaveTextContent('Password must be at least 6 characters')

    fill(page, { ...valid, 'Date of birth': '31.02.1990' })
    submit()
    expect(await within(page).findByText('Enter the date of birth as DD.MM.YYYY.')).toBeInTheDocument()
    expect(within(page).getByLabelText('Date of birth')).toHaveAttribute('aria-invalid', 'true')
    expect(auth.value.signUp).not.toHaveBeenCalled()
  })

  it('a new account is signed in and lands on the invite code step, "account created" on top', async () => {
    setAuth({ user: null })
    // The backend confirms at sign-up: the form signs in, and the app follows the session
    auth.value.signIn = vi.fn(async () => {
      const prev = auth.value
      setAuth({ user: { id: 'u-new', email: 'lea@club.ch' }, roles: [] })
      auth.value.signUp = prev.signUp
      return { error: null }
    })
    const { rerender } = render(<ManagerApp />)
    const page = screen.getByTestId('manager-sign-up')
    fill(page, { ...valid, 'Date of birth': '6.10.1990' })
    fireEvent.click(within(page).getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(screen.getByTestId('manager-invite-step')).toBeInTheDocument())
    rerender(<ManagerApp />)
    const step = screen.getByTestId('manager-invite-step')
    expect(within(step).getByRole('status')).toHaveTextContent('managerSite.accountCreated')
    expect(within(step).getByRole('heading', { name: 'managerSite.inviteStepTitle' })).toBeInTheDocument()
    expect(within(step).getByLabelText('access.inviteCodeLabel')).toBeInTheDocument()
    expect(window.location.hash).toBe('')
  })

  it('sends the trimmed fields, the ISO date of birth (null when left empty)', async () => {
    setAuth({ user: null })
    render(<ManagerApp />)
    const page = screen.getByTestId('manager-sign-up')
    fill(page, { ...valid, Email: ' lea@club.ch ', 'First name': ' Lea ' })
    fireEvent.click(within(page).getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(auth.value.signUp).toHaveBeenCalledWith('lea@club.ch', 'secret1', {
      firstName: 'Lea', lastName: 'Muster', country: 'CHE', dob: null
    }))
  })

  it('an account that must be confirmed by email: "check your email" and a sign-in button', async () => {
    setAuth({ user: null })
    auth.value.signUp = vi.fn(async () => ({ data: { user: { id: 'u-new', email_confirmed_at: null } }, error: null }))
    render(<ManagerApp />)
    const page = screen.getByTestId('manager-sign-up')
    fill(page, { ...valid, 'Date of birth': '06.10.1990' })
    fireEvent.click(within(page).getByRole('button', { name: 'Create account' }))
    const done = await within(page).findByTestId('signup-done')
    expect(done).toHaveTextContent('Check your email to confirm your account')
    expect(auth.value.signUp.mock.calls[0][2].dob).toBe('1990-10-06')
    expect(auth.value.signIn).not.toHaveBeenCalled()
    fireEvent.click(within(done).getByRole('button', { name: 'Sign in' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('a server error shows in the form', async () => {
    setAuth({ user: null })
    auth.value.signUp = vi.fn(async () => ({ data: null, error: { message: 'This email is already registered' } }))
    render(<ManagerApp />)
    const page = screen.getByTestId('manager-sign-up')
    fill(page, valid)
    fireEvent.click(within(page).getByRole('button', { name: 'Create account' }))
    expect(await within(page).findByRole('alert')).toHaveTextContent('This email is already registered')
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
