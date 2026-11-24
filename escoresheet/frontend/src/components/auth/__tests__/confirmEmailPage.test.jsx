// The manager's #confirm page: the sign-up password binds the confirmation to
// whoever signed up; without it the clicker chooses a new password, and keeps
// or drops each detail the sign-up gave (audit 2611 SEC-15, review I-3).
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key) => key, i18n: { language: 'en' } }) }))
vi.mock('../../../managerBrand', () => ({ useManagerBrand: () => ({ app: 'indoor' }) }))
const confirmEmail = vi.hoisted(() => vi.fn())
const signUpDetails = vi.hoisted(() => vi.fn(async () => ({ data: { signup_details: null }, error: null })))
const confirmPasswordReset = vi.hoisted(() => vi.fn(async () => ({ data: { password_updated: true }, error: null })))
vi.mock('../../../lib/apiClient', () => ({ apiAuth: { confirmEmail, signUpDetails, confirmPasswordReset } }))

import { ConfirmEmailPage, ResetPasswordPage } from '../AuthLinkPages'

const DETAILS = {
  first_name: 'Anna', last_name: 'Muster', license_number: '123456',
  requests: [
    { id: 'r-scorer', kind: 'scorer', club_id: 'c1', club_name: 'VBC Musterdorf', team_id: null, team_name: null },
    { id: 'r-ref', kind: 'referee', club_id: null, club_name: null, team_id: null, team_name: null }
  ]
}
const typePassword = () => {
  const [pw, repeat] = screen.getAllByDisplayValue('')
    .filter((el) => el.getAttribute('type') === 'password')
  fireEvent.change(pw, { target: { value: 'new-password-1' } })
  fireEvent.change(repeat, { target: { value: 'new-password-1' } })
}

describe('ConfirmEmailPage', () => {
  it('sends the password when given; done', async () => {
    confirmEmail.mockResolvedValueOnce({ data: { confirmed: true, already_confirmed: false }, error: null })
    render(<ConfirmEmailPage token="t" onSignIn={() => {}} />)
    fireEvent.change(screen.getByTestId('confirm-password'), { target: { value: 'my-password-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'authEmail.confirmButton' }))
    await waitFor(() => expect(screen.getByTestId('confirm-done')).toBeTruthy())
    expect(confirmEmail).toHaveBeenCalledWith('t', 'my-password-1')
  })

  it('without it, the server keeps no password: the new password form follows', async () => {
    confirmEmail.mockResolvedValueOnce({ data: { confirmed: true, already_confirmed: false, set_password_token: 'r'.repeat(43) }, error: null })
    render(<ConfirmEmailPage token="t" onSignIn={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'authEmail.confirmButton' }))
    await waitFor(() => expect(screen.getByTestId('reset-form')).toBeTruthy())
  })

  it('the new password form shows what the sign-up gave: all kept unless unticked, sent with the password', async () => {
    confirmEmail.mockResolvedValueOnce({ data: { confirmed: true, already_confirmed: false, set_password_token: 's'.repeat(43) }, error: null })
    signUpDetails.mockResolvedValueOnce({ data: { signup_details: DETAILS }, error: null })
    render(<ConfirmEmailPage token="t" onSignIn={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'authEmail.confirmButton' }))
    await waitFor(() => expect(screen.getByTestId('signup-details')).toBeTruthy())
    expect(signUpDetails).toHaveBeenCalledWith('s'.repeat(43))
    expect(screen.getByTestId('signup-keep-name').checked).toBe(true)
    expect(screen.getByTestId('signup-keep-licence').checked).toBe(true)
    expect(screen.getByTestId('signup-keep-request-r-scorer').checked).toBe(true)
    expect(screen.getByTestId('signup-keep-request-r-ref').checked).toBe(true)
    fireEvent.click(screen.getByTestId('signup-keep-name'))
    fireEvent.click(screen.getByTestId('signup-keep-request-r-scorer'))
    typePassword()
    fireEvent.click(screen.getByRole('button', { name: 'authEmail.savePassword' }))
    await waitFor(() => expect(screen.getByTestId('reset-done')).toBeTruthy())
    expect(confirmPasswordReset).toHaveBeenCalledWith('s'.repeat(43), 'new-password-1', undefined, undefined, { name: false, licence: true, requests: ['r-ref'] })
  })

  it('a reset link without sign-up details sends the password as before', async () => {
    confirmPasswordReset.mockClear()
    render(<ResetPasswordPage token={'A'.repeat(43)} lang="de" onSignIn={() => {}} onRequestNew={() => {}} />)
    await waitFor(() => expect(signUpDetails).toHaveBeenCalledWith('A'.repeat(43)))
    expect(screen.queryByTestId('signup-details')).toBeNull()
    typePassword()
    fireEvent.click(screen.getByRole('button', { name: 'authEmail.savePassword' }))
    await waitFor(() => expect(screen.getByTestId('reset-done')).toBeTruthy())
    expect(confirmPasswordReset).toHaveBeenCalledWith('A'.repeat(43), 'new-password-1', 'de')
  })
})
