// The manager's #confirm page: the sign-up password binds the confirmation to
// whoever signed up; without it the clicker chooses a new password.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key) => key, i18n: { language: 'en' } }) }))
vi.mock('../../../managerBrand', () => ({ useManagerBrand: () => ({ app: 'indoor' }) }))
const confirmEmail = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/apiClient', () => ({ apiAuth: { confirmEmail } }))

import { ConfirmEmailPage } from '../AuthLinkPages'

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
})
