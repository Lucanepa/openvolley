// manager.openvolley.app/#reset?token= and #confirm?token=: the pages behind
// the links of the account emails (components/auth/AuthLinkPages.jsx).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'

const i18nMock = vi.hoisted(() => ({ language: 'en', changeLanguage: vi.fn() }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => (opts && typeof opts === 'object' ? `${key} ${JSON.stringify(opts)}` : key),
    i18n: i18nMock
  })
}))

const auth = vi.hoisted(() => ({ value: null }))
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth.value }))

const api = vi.hoisted(() => ({
  confirmPasswordReset: vi.fn(),
  confirmEmail: vi.fn()
}))
vi.mock('../lib/apiClient', () => ({
  apiAuth: api,
  apiFrom: () => {
    const b = { select: () => b, in: () => b, limit: () => b, then: (r) => Promise.resolve({ data: [], error: null }).then(r) }
    return b
  },
  apiRequest: vi.fn()
}))
vi.mock('../lib/accountApi', async (orig) => ({ ...(await orig()) }))

import ManagerApp, { tabFromHash } from '../ManagerApp'
import { NO_ACCESS } from '../lib/access'

const TOKEN = 'Ab3_-'.repeat(8) + 'xyz'

function setAuth({ user = null } = {}) {
  auth.value = {
    user,
    profile: null,
    access: NO_ACCESS,
    loading: false,
    signIn: vi.fn(async () => ({ error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    resetPassword: vi.fn(async () => ({ data: { requested: true }, error: null })),
    fetchProfile: vi.fn(async () => null),
    redeemInvite: vi.fn(),
    refreshUser: vi.fn(async () => null)
  }
}

const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe('manager email-link pages', () => {
  let logSpy
  beforeEach(() => {
    vi.clearAllMocks()
    i18nMock.language = 'en'
    setAuth()
    window.history.replaceState(null, '', '/')
    logSpy = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
  })
  afterEach(() => {
    // The token is never logged, whatever happened
    for (const spy of logSpy) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(TOKEN)
      spy.mockRestore()
    }
  })

  describe('#reset', () => {
    it('sets a new password once both fields match, then offers the app and sign-in', async () => {
      api.confirmPasswordReset.mockResolvedValue({ data: { password_updated: true }, error: null, status: 200 })
      render(<ManagerApp authLink={{ page: 'reset', token: TOKEN, lang: 'de' }} />)
      expect(screen.getByTestId('reset-form')).toBeInTheDocument()
      expect(document.body.innerHTML).not.toContain(TOKEN)
      type('authEmail.newPassword', 'new-password-1')
      type('authEmail.repeatPassword', 'new-password-2')
      fireEvent.click(screen.getByRole('button', { name: 'authEmail.savePassword' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('auth.passwordsDoNotMatch')
      expect(api.confirmPasswordReset).not.toHaveBeenCalled()

      type('authEmail.repeatPassword', 'new-password-1')
      fireEvent.click(screen.getByRole('button', { name: 'authEmail.savePassword' }))
      expect(await screen.findByTestId('reset-done')).toBeInTheDocument()
      expect(api.confirmPasswordReset).toHaveBeenCalledWith(TOKEN, 'new-password-1', 'de')
      expect(screen.getByRole('link', { name: 'managerSite.openAppLong' })).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'managerSite.signIn' }))
      expect(await screen.findByTestId('manager-sign-in')).toBeInTheDocument()
      expect(screen.getByRole('dialog')).toBeInTheDocument() // the sign-in dialog opens at once
    })

    it('refuses a short password before calling the server', async () => {
      render(<ManagerApp authLink={{ page: 'reset', token: TOKEN, lang: null }} />)
      type('authEmail.newPassword', '123')
      type('authEmail.repeatPassword', '123')
      fireEvent.click(screen.getByRole('button', { name: 'authEmail.savePassword' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('auth.passwordTooShort')
      expect(api.confirmPasswordReset).not.toHaveBeenCalled()
    })

    it('a used or expired link shows "does not work" and leads to a new request', async () => {
      api.confirmPasswordReset.mockResolvedValue({ data: null, error: { code: 'invalid_link', message: 'x', status: 400 }, status: 400 })
      render(<ManagerApp authLink={{ page: 'reset', token: TOKEN, lang: null }} />)
      type('authEmail.newPassword', 'new-password-1')
      type('authEmail.repeatPassword', 'new-password-1')
      fireEvent.click(screen.getByRole('button', { name: 'authEmail.savePassword' }))
      expect(await screen.findByTestId('auth-link-invalid')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'authEmail.requestNewLink' }))
      // the sign-in dialog opens on "Reset password"
      expect(await screen.findByRole('button', { name: 'auth.sendResetLink' })).toBeInTheDocument()
    })

    it('a link without a usable token is invalid at once', () => {
      render(<ManagerApp authLink={{ page: 'reset', token: null, lang: null }} />)
      expect(screen.getByTestId('auth-link-invalid')).toBeInTheDocument()
    })

    it('rate limits and network errors stay on the form', async () => {
      api.confirmPasswordReset.mockResolvedValueOnce({ data: null, error: { status: 429, message: 'x' }, status: 429 })
        .mockResolvedValueOnce({ data: null, error: { status: 0, network: true, message: 'x' } })
      render(<ManagerApp authLink={{ page: 'reset', token: TOKEN, lang: null }} />)
      type('authEmail.newPassword', 'new-password-1')
      type('authEmail.repeatPassword', 'new-password-1')
      fireEvent.click(screen.getByRole('button', { name: 'authEmail.savePassword' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('authEmail.tooManyAttempts')
      fireEvent.click(screen.getByRole('button', { name: 'authEmail.savePassword' }))
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('authEmail.offline'))
      expect(screen.getByTestId('reset-form')).toBeInTheDocument()
    })

    it('signs this device out after the reset when someone was signed in', async () => {
      setAuth({ user: { id: 'u-1', email: 'a@b.ch' } })
      api.confirmPasswordReset.mockResolvedValue({ data: { password_updated: true }, error: null, status: 200 })
      render(<ManagerApp authLink={{ page: 'reset', token: TOKEN, lang: null }} />)
      type('authEmail.newPassword', 'new-password-1')
      type('authEmail.repeatPassword', 'new-password-1')
      fireEvent.click(screen.getByRole('button', { name: 'authEmail.savePassword' }))
      await screen.findByTestId('reset-done')
      fireEvent.click(screen.getByRole('button', { name: 'managerSite.signIn' }))
      await waitFor(() => expect(auth.value.signOut).toHaveBeenCalled())
    })

    it('follows the language of the email unless the site already shows it', () => {
      render(<ManagerApp authLink={{ page: 'reset', token: TOKEN, lang: 'fr' }} />)
      expect(i18nMock.changeLanguage).toHaveBeenCalledWith('fr')
    })

    it('keeps Swiss German for a German link', () => {
      i18nMock.language = 'de-CH'
      render(<ManagerApp authLink={{ page: 'reset', token: TOKEN, lang: 'de' }} />)
      expect(i18nMock.changeLanguage).not.toHaveBeenCalled()
    })
  })

  describe('#confirm', () => {
    it('confirms on a click, not on load', async () => {
      api.confirmEmail.mockResolvedValue({ data: { confirmed: true, already_confirmed: false }, error: null, status: 200 })
      render(<ManagerApp authLink={{ page: 'confirm', token: TOKEN, lang: null }} />)
      expect(screen.getByTestId('confirm-ask')).toBeInTheDocument()
      expect(api.confirmEmail).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'authEmail.confirmButton' }))
      expect(await screen.findByTestId('confirm-done')).toHaveTextContent('authEmail.confirmed')
      expect(api.confirmEmail).toHaveBeenCalledWith(TOKEN)
    })

    it('says so when the address was already confirmed', async () => {
      api.confirmEmail.mockResolvedValue({ data: { confirmed: true, already_confirmed: true }, error: null, status: 200 })
      render(<ManagerApp authLink={{ page: 'confirm', token: TOKEN, lang: null }} />)
      fireEvent.click(screen.getByRole('button', { name: 'authEmail.confirmButton' }))
      expect(await screen.findByTestId('confirm-done')).toHaveTextContent('authEmail.alreadyConfirmed')
    })

    it('an invalid link points to the profile in the scorer app', async () => {
      api.confirmEmail.mockResolvedValue({ data: null, error: { code: 'invalid_link', status: 400, message: 'x' }, status: 400 })
      render(<ManagerApp authLink={{ page: 'confirm', token: TOKEN, lang: null }} />)
      fireEvent.click(screen.getByRole('button', { name: 'authEmail.confirmButton' }))
      expect(await screen.findByTestId('auth-link-invalid')).toHaveTextContent('authEmail.confirmInvalid')
      expect(screen.getByRole('link', { name: 'managerSite.openAppLong' })).toBeInTheDocument()
    })
  })

  describe('next to the #signup route', () => {
    const openLinkInThisTab = (hash) => act(() => {
      // An email link opened in a tab already on the site: only the hash changes
      window.history.pushState(null, '', `/${hash}`)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    it('a link is no route and no console tab', () => {
      window.history.replaceState(null, '', `/#reset?token=${TOKEN}`)
      expect(tabFromHash()).toBeNull()
      window.history.replaceState(null, '', '/#signup')
      expect(tabFromHash()).toBe('signup')
    })

    it('a link opened in a tab on the sign-up page: taken out of the URL, its page shows', () => {
      window.history.replaceState(null, '', '/#signup')
      render(<ManagerApp />)
      expect(screen.getByTestId('manager-sign-up')).toBeInTheDocument()
      openLinkInThisTab(`#confirm?token=${TOKEN}`)
      expect(screen.getByTestId('confirm-ask')).toBeInTheDocument()
      expect(window.location.hash).toBe('')
      expect(window.location.href).not.toContain(TOKEN)
    })

    it('a link opened in a tab where someone is signed in: its page shows over the account', async () => {
      setAuth({ user: { id: 'u-1', email: 'a@b.ch' } })
      api.confirmEmail.mockResolvedValue({ data: { confirmed: true, already_confirmed: false }, error: null, status: 200 })
      render(<ManagerApp />)
      expect(screen.queryByTestId('confirm-ask')).toBeNull()
      openLinkInThisTab(`#confirm?token=${TOKEN}`)
      expect(window.location.hash).toBe('')
      fireEvent.click(screen.getByRole('button', { name: 'authEmail.confirmButton' }))
      expect(await screen.findByTestId('confirm-done')).toBeInTheDocument()
      expect(api.confirmEmail).toHaveBeenCalledWith(TOKEN)
      // Back to the account: the session's user is re-read (now confirmed)
      fireEvent.click(screen.getByRole('button', { name: 'managerSite.signIn' }))
      await waitFor(() => expect(auth.value.refreshUser).toHaveBeenCalledTimes(1))
      expect(auth.value.signOut).not.toHaveBeenCalled()
    })

    it('after a link page, the sign-in dialog\'s "Create account" opens #signup; "back" shows the card only', async () => {
      api.confirmPasswordReset.mockResolvedValue({ data: { password_updated: true }, error: null, status: 200 })
      render(<ManagerApp authLink={{ page: 'reset', token: TOKEN, lang: null }} />)
      type('authEmail.newPassword', 'new-password-1')
      type('authEmail.repeatPassword', 'new-password-1')
      fireEvent.click(screen.getByRole('button', { name: 'authEmail.savePassword' }))
      await screen.findByTestId('reset-done')
      fireEvent.click(screen.getByRole('button', { name: 'managerSite.signIn' }))
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'auth.createAccount' }))
      expect(screen.getByTestId('manager-sign-up')).toBeInTheDocument()
      expect(window.location.hash).toBe('#signup')
      fireEvent.click(screen.getByRole('button', { name: 'managerSite.backToSignIn' }))
      expect(screen.getByTestId('manager-sign-in')).toBeInTheDocument()
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  it('without a link the manager starts as before', () => {
    render(<ManagerApp />)
    expect(screen.getByTestId('manager-sign-in')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
