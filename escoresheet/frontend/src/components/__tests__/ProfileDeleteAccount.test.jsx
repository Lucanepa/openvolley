import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import en from '../../i18n/locales/en.json'

// Real English copy, so the test reads what the user reads
const lookup = (key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), en)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => String(lookup(key) ?? (typeof fallback === 'string' ? fallback : key)) })
}))

const auth = vi.hoisted(() => ({ deleteAccount: null }))
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'scorer@example.ch' },
    profile: { first_name: 'Sam', last_name: 'Scorer' },
    updateProfile: async () => ({ error: null }),
    updateEmail: async () => ({ error: null }),
    deleteAccount: auth.deleteAccount
  })
}))

import ProfileModal from '../auth/ProfileModal'

function openDialog() {
  const onClose = vi.fn()
  render(<ProfileModal open onClose={onClose} />)
  fireEvent.click(screen.getByRole('button', { name: en.auth.deleteAccount }))
  return { onClose, dialog: screen.getByRole('alertdialog') }
}

describe('Profile: delete account dialog', () => {
  it('says what the server deletes and what it keeps; no "all your data" promise', () => {
    auth.deleteAccount = vi.fn(async () => ({ error: null }))
    const { dialog } = openDialog()
    const text = dialog.textContent
    expect(text).not.toMatch(/all your data/i)
    expect(text).toContain(en.auth.deleteAccountWhatGoesTitle)
    expect(text).toMatch(/cloud backups and logs/)
    expect(text).toMatch(/editor rights/)
    expect(text).toContain(en.auth.deleteAccountWhatStaysTitle)
    expect(text).toMatch(/matches you scored and their scoresheets/)
  })

  it('deletes only after the email is typed; a server failure is shown and the dialog stays', async () => {
    auth.deleteAccount = vi.fn(async () => ({ error: { message: 'Authentication service unavailable. Please try again.' } }))
    const { onClose } = openDialog()
    const confirm = screen.getByRole('button', { name: en.auth.deleteAccountConfirm })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText(en.auth.typeEmailToConfirm), { target: { value: 'scorer@example.ch' } })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    expect(await screen.findByRole('alert')).toHaveTextContent('Please try again')
    expect(auth.deleteAccount).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()

    auth.deleteAccount.mockResolvedValueOnce({ error: null })
    fireEvent.click(screen.getByRole('button', { name: en.auth.deleteAccountConfirm }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
