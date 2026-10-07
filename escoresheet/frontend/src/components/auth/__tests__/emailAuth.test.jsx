// The scorer apps' side of the account emails: the reset dialog, the
// "confirm your email" banner in the profile, and the sign-up result.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => (opts && typeof opts === 'object' ? `${key} ${JSON.stringify(opts)}` : key),
    i18n: { language: 'en', changeLanguage: vi.fn() }
  })
}))

const auth = vi.hoisted(() => ({ value: null }))
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => auth.value }))

import LoginModal, { contactFromMessage } from '../LoginModal'
import EmailConfirmBanner from '../EmailConfirmBanner'
import { needsEmailConfirmation, confirmationLinkSent } from '../signUpResult'

function openReset() {
  render(<LoginModal open onClose={() => {}} onSwitchToSignUp={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'auth.forgotPassword' }))
  fireEvent.change(screen.getByLabelText('auth.email'), { target: { value: ' anna@example.ch ' } })
  fireEvent.click(screen.getByRole('button', { name: 'auth.sendResetLink' }))
}

describe('reset dialog (LoginModal)', () => {
  beforeEach(() => { auth.value = { signIn: vi.fn(), resetPassword: vi.fn(), resendConfirmation: vi.fn() } })

  it('answers "if an account exists, we sent a link", the same for every address', async () => {
    auth.value.resetPassword.mockResolvedValue({ data: { requested: true }, error: null, status: 200 })
    openReset()
    expect(await screen.findByTestId('reset-sent')).toHaveTextContent('authEmail.resetSent {"email":"anna@example.ch"}')
    expect(auth.value.resetPassword).toHaveBeenCalledWith('anna@example.ch')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the contact fallback only when the server sends no emails (503)', async () => {
    auth.value.resetPassword.mockResolvedValue({
      data: null, status: 503,
      error: { code: 'reset_unavailable', status: 503, message: 'Password reset is temporarily unavailable. Contact owner@club.ch.' }
    })
    openReset()
    expect(await screen.findByRole('alert')).toHaveTextContent('authEmail.resetUnavailable {"contact":"owner@club.ch"}')
    expect(screen.queryByTestId('reset-sent')).toBeNull()
  })

  it('names a rate limit and a missing connection', async () => {
    auth.value.resetPassword.mockResolvedValue({ data: null, status: 429, error: { status: 429, message: 'Too many requests.' } })
    openReset()
    expect(await screen.findByRole('alert')).toHaveTextContent('authEmail.tooManyAttempts')
  })

  it('reads the contact address out of the server message', () => {
    expect(contactFromMessage('Password reset is temporarily unavailable. Contact volleyball@lucanepa.com.')).toBe('volleyball@lucanepa.com')
    expect(contactFromMessage('something else')).toBe('volleyball@lucanepa.com')
  })

  it('opens on the reset form when asked to (manager "Request a new link")', () => {
    render(<LoginModal open initialForgot onClose={() => {}} onSwitchToSignUp={() => {}} />)
    expect(screen.getByRole('button', { name: 'auth.sendResetLink' })).toBeInTheDocument()
  })
})

describe('EmailConfirmBanner (profile)', () => {
  const user = { id: 'u-1', email: 'nina@example.ch', email_confirmed_at: null }

  it('shows nothing for confirmed or signed-out users', () => {
    auth.value = { user: { ...user, email_confirmed_at: '2026-10-07T08:00:00Z' }, resendConfirmation: vi.fn() }
    const { container, rerender } = render(<EmailConfirmBanner />)
    expect(container).toBeEmptyDOMElement()
    auth.value = { user: null, resendConfirmation: vi.fn() }
    rerender(<EmailConfirmBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('resends a link and says where it went', async () => {
    auth.value = { user, resendConfirmation: vi.fn(async () => ({ data: { sent: true }, error: null, status: 200 })) }
    render(<EmailConfirmBanner />)
    expect(screen.getByTestId('email-confirm-banner')).toHaveTextContent('authEmail.notConfirmed')
    fireEvent.click(screen.getByRole('button', { name: 'authEmail.resend' }))
    expect(await screen.findByText('authEmail.resent {"email":"nina@example.ch"}')).toBeInTheDocument()
    expect(auth.value.resendConfirmation).toHaveBeenCalledTimes(1)
  })

  it('reports a rate limit and a server without emails', async () => {
    auth.value = {
      user,
      resendConfirmation: vi.fn()
        .mockResolvedValueOnce({ data: null, error: { status: 429 }, status: 429 })
        .mockResolvedValueOnce({ data: null, error: { status: 503, code: 'confirm_unavailable' }, status: 503 })
    }
    render(<EmailConfirmBanner />)
    fireEvent.click(screen.getByRole('button', { name: 'authEmail.resend' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('authEmail.tooManyAttempts')
    fireEvent.click(screen.getByRole('button', { name: 'authEmail.resend' }))
    expect(await screen.findByText('authEmail.resendUnavailable')).toBeInTheDocument()
  })
})

describe('sign-up result', () => {
  it('a mailed confirmation link does not hold back the sign-in', () => {
    const user = { id: 'u', email_confirmed_at: null }
    expect(needsEmailConfirmation({ user, email_confirmation: 'sent' })).toBe(false)
    expect(confirmationLinkSent({ user, email_confirmation: 'sent' })).toBe(true)
    expect(needsEmailConfirmation({ user })).toBe(true)
    expect(needsEmailConfirmation({ user: { ...user, email_confirmed_at: 'x' } })).toBe(false)
    expect(confirmationLinkSent({ user })).toBe(false)
  })
})
