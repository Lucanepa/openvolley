// @vitest-environment-options {"url": "https://app.openvolley.app/"}
// The scorer apps make no accounts: "Don't have an account?" opens
// manager.openvolley.app/#signup outside the app, the right way per platform.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => (typeof opts === 'string' ? opts : (opts?.defaultValue ? opts.defaultValue.replace('{{host}}', opts.host) : key))
  })
}))

const auth = vi.hoisted(() => ({ value: null }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }))

// The real openAppWindow, on a stand-in window when a test sets one: jsdom's
// location.assign (Capacitor's external link) cannot be watched.
const fakeWin = vi.hoisted(() => ({ value: null }))
const openSpy = vi.hoisted(() => ({ fn: null }))
vi.mock('../../utils/openAppWindow', async (orig) => {
  const real = await orig()
  openSpy.fn = vi.fn((url, opts = {}) => real.openAppWindow(url, { ...opts, win: fakeWin.value || window }))
  return { ...real, openAppWindow: (...args) => openSpy.fn(...args) }
})

import LoginModal from '../auth/LoginModal'
import UserButton from '../auth/UserButton'
import CreateAccountLink from '../auth/CreateAccountLink'

const SIGN_UP = 'https://manager.openvolley.app/#signup'
const NEEDS_INTERNET = 'Needs an internet connection. Scoring works without an account.'

function signedOut() {
  auth.value = { user: null, profile: null, access: null, loading: false, signIn: vi.fn(), resetPassword: vi.fn(), signOut: vi.fn() }
}

describe('CreateAccountLink (scorer apps: accounts are made on the manager site)', () => {
  let windowOpen
  beforeEach(() => {
    signedOut()
    fakeWin.value = null
    openSpy.fn.mockClear()
    windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete window.__TAURI_INTERNALS__
    delete window.Capacitor
  })

  it('web: opens manager.openvolley.app/#signup in a new tab, no "needs internet" on the public site', () => {
    render(<CreateAccountLink />)
    const link = screen.getByRole('button', { name: 'Create one at manager.openvolley.app' })
    expect(screen.getByTestId('create-account-link')).toHaveTextContent("Don't have an account?")
    expect(screen.queryByText(NEEDS_INTERNET)).toBeNull()
    fireEvent.click(link)
    expect(windowOpen).toHaveBeenCalledWith(SIGN_UP, '_blank', 'noopener,noreferrer')
  })

  it('web, offline: the link stays and says it needs internet', () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    render(<CreateAccountLink />)
    expect(screen.getByText(NEEDS_INTERNET)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create one at manager.openvolley.app' }))
    expect(windowOpen).toHaveBeenCalledWith(SIGN_UP, '_blank', 'noopener,noreferrer')
  })

  it('desktop app (Tauri): window.open, which the app hands to the system browser', () => {
    window.__TAURI_INTERNALS__ = {}
    render(<CreateAccountLink />)
    expect(screen.getByText(NEEDS_INTERNET)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create one at manager.openvolley.app' }))
    expect(windowOpen).toHaveBeenCalledWith(SIGN_UP, '_blank', expect.any(String))
    expect(openSpy.fn.mock.results.at(-1).value).toMatchObject({ ok: true, mode: 'external', platform: 'tauri' })
  })

  it('Android app (Capacitor): a navigation Capacitor hands to the Android browser, no in-app view', () => {
    const native = { isNativePlatform: () => true }
    window.Capacitor = native
    const assign = vi.fn()
    fakeWin.value = {
      Capacitor: native,
      location: { href: 'https://localhost/', origin: 'https://localhost', assign },
      open: vi.fn()
    }
    render(<CreateAccountLink />)
    expect(screen.getByText(NEEDS_INTERNET)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create one at manager.openvolley.app' }))
    expect(assign).toHaveBeenCalledWith(SIGN_UP)
    expect(fakeWin.value.open).not.toHaveBeenCalled()
    expect(openSpy.fn.mock.results.at(-1).value).toMatchObject({ ok: true, mode: 'external', platform: 'capacitor' })
  })
})

describe('the scorer app sign-in dialog', () => {
  beforeEach(() => {
    signedOut()
    fakeWin.value = null
  })
  afterEach(() => vi.restoreAllMocks())

  it('LoginModal without onSwitchToSignUp: the manager link instead of an in-app sign-up', () => {
    render(<LoginModal open onClose={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByTestId('create-account-link')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Sign up' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Create account' })).toBeNull()
  })

  it('LoginModal with onSwitchToSignUp (the manager site): its own "Create account" button', () => {
    const onSwitch = vi.fn()
    render(<LoginModal open onClose={() => {}} onSwitchToSignUp={onSwitch} />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByTestId('create-account-link')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create account' }))
    expect(onSwitch).toHaveBeenCalled()
  })

  it('UserButton (signed out): Login opens the sign-in dialog; no sign-up form anywhere', () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<UserButton />)
    fireEvent.click(screen.getByRole('button', { name: /Login/ }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create one at manager.openvolley.app' }))
    expect(windowOpen).toHaveBeenCalledWith(SIGN_UP, '_blank', 'noopener,noreferrer')
    // the dialog stays: nothing in the app changes, the account is made in the browser
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByLabelText('Confirm password')).toBeNull()
  })
})
