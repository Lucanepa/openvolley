// Profile: the account's own security. Removing a passkey and signing out
// everywhere with the passkeys need a confirmation (the password, or a
// passkey of the account) that goes to the server; a new password needs the
// current one; the devices the account is signed in on are listed.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => (opts && typeof opts === 'object' ? `${key} ${JSON.stringify(opts)}` : key),
    i18n: { language: 'en', changeLanguage: vi.fn() }
  })
}))

vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', email: 'anna@example.ch' } }) }))

const pk = vi.hoisted(() => ({ possible: true }))
vi.mock('../../../lib/passkeys', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, passkeysPossible: () => pk.possible, runPasskeySignIn: vi.fn(async () => ({ id: 'answer' })) }
})

const api = vi.hoisted(() => ({
  listPasskeys: vi.fn(), removePasskey: vi.fn(), reauth: vi.fn(),
  listSessions: vi.fn(), signOutEverywhere: vi.fn(), changePassword: vi.fn()
}))
vi.mock('../../../lib/apiClient', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, apiAuth: { ...real.apiAuth, ...api } }
})

import PasskeySection from '../PasskeySection'
import AccountSecuritySection from '../AccountSecuritySection'
import { runPasskeySignIn } from '../../../lib/passkeys'

beforeEach(() => {
  pk.possible = true
  for (const fn of Object.values(api)) fn.mockReset()
  api.listPasskeys.mockResolvedValue({ data: { passkeys: [{ id: 'pk-1', label: 'iPhone · Safari', created_at: '2026-11-01T10:00:00Z', last_used_at: null }] }, error: null })
  api.listSessions.mockResolvedValue({ data: { sessions: [
    { id: 'aaaa', created_at: '2026-11-10T08:00:00Z', last_seen_at: '2026-11-14T09:00:00Z', current: true },
    { id: 'bbbb', created_at: '2026-11-02T18:00:00Z', last_seen_at: null, current: false }
  ] }, error: null })
})

describe('removing a passkey', () => {
  it('asks for the password and sends it; a refusal is said in words and nothing is removed', async () => {
    render(<PasskeySection />)
    fireEvent.click(await screen.findByRole('button', { name: 'passkeys.remove: iPhone · Safari' }))
    const remove = screen.getByRole('button', { name: 'passkeys.remove' })
    expect(remove).toBeDisabled()
    fireEvent.change(screen.getByLabelText('accountSecurity.confirmPassword'), { target: { value: 'pw-anna-123' } })
    api.removePasskey.mockResolvedValueOnce({ data: null, error: { code: 'invalid_password', status: 401 } })
    fireEvent.click(remove)
    expect(await screen.findByText('passkeys.errors.wrongPassword')).toBeTruthy()
    expect(api.removePasskey).toHaveBeenCalledWith('pk-1', { password: 'pw-anna-123' })
    expect(screen.getByText('iPhone · Safari')).toBeTruthy()

    api.removePasskey.mockResolvedValueOnce({ data: { removed: true, revoked_sessions: 1 }, error: null })
    fireEvent.click(screen.getByRole('button', { name: 'passkeys.remove' }))
    await waitFor(() => expect(screen.queryByText('iPhone · Safari')).toBeNull())
  })

  it('or confirms with a passkey first, then removes', async () => {
    api.reauth.mockResolvedValue({ data: { fresh_until: Date.now() + 300000 }, error: null })
    api.removePasskey.mockResolvedValue({ data: { removed: true }, error: null })
    render(<PasskeySection />)
    fireEvent.click(await screen.findByRole('button', { name: 'passkeys.remove: iPhone · Safari' }))
    fireEvent.click(screen.getByRole('button', { name: 'accountSecurity.usePasskey' }))
    await waitFor(() => expect(api.removePasskey).toHaveBeenCalledWith('pk-1', { password: undefined }))
    expect(api.reauth).toHaveBeenCalledWith({}, runPasskeySignIn)
  })
})

describe('sign-in and devices', () => {
  it('lists the devices, this one marked', async () => {
    render(<AccountSecuritySection />)
    const list = await screen.findByTestId('session-list')
    expect(list.textContent).toContain('accountSecurity.thisDevice')
    expect(list.textContent).toContain('accountSecurity.otherDevice')
  })

  it('sign out everywhere removes the passkeys too by default, with the password', async () => {
    api.signOutEverywhere.mockResolvedValue({ data: { revoked_sessions: 1, removed_passkeys: 1 }, error: null })
    render(<AccountSecuritySection />)
    fireEvent.click(screen.getByTestId('sign-out-everywhere'))
    const submit = screen.getAllByRole('button', { name: 'accountSecurity.signOutEverywhere' }).at(-1)
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('accountSecurity.confirmPassword'), { target: { value: 'pw-anna-123' } })
    fireEvent.click(submit)
    await waitFor(() => expect(api.signOutEverywhere).toHaveBeenCalledWith({ removePasskeys: true, password: 'pw-anna-123' }))
  })

  it('sessions only: no confirmation needed', async () => {
    api.signOutEverywhere.mockResolvedValue({ data: { revoked_sessions: 2, removed_passkeys: 0 }, error: null })
    render(<AccountSecuritySection />)
    fireEvent.click(screen.getByTestId('sign-out-everywhere'))
    fireEvent.click(screen.getByLabelText('accountSecurity.removePasskeysToo'))
    expect(screen.queryByLabelText('accountSecurity.confirmPassword')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'accountSecurity.signOutEverywhere' }).at(-1))
    await waitFor(() => expect(api.signOutEverywhere).toHaveBeenCalledWith({ removePasskeys: false, password: undefined }))
  })

  it('a new password needs the current one and the same one twice', async () => {
    api.changePassword.mockResolvedValue({ data: { session: { access_token: 'x' } }, error: null })
    render(<AccountSecuritySection />)
    fireEvent.click(screen.getByTestId('change-password'))
    fireEvent.change(screen.getByLabelText('accountSecurity.currentPassword'), { target: { value: 'old-password-1' } })
    fireEvent.change(screen.getByLabelText('authEmail.newPassword'), { target: { value: 'new-password-1' } })
    fireEvent.change(screen.getByLabelText('authEmail.repeatPassword'), { target: { value: 'new-password-2' } })
    const submit = screen.getAllByRole('button', { name: 'accountSecurity.changePassword' }).at(-1)
    fireEvent.click(submit)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(api.changePassword).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('authEmail.repeatPassword'), { target: { value: 'new-password-1' } })
    fireEvent.click(submit)
    await waitFor(() => expect(api.changePassword).toHaveBeenCalledWith({ password: 'old-password-1', newPassword: 'new-password-1' }))
  })
})
