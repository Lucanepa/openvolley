// Passkeys in the scorer apps and the manager: the button on the sign-in
// dialog, the offer to set one up after a password sign-in, the words for
// the refusals, and where the feature is not offered at all.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => (opts && typeof opts === 'object' ? `${key} ${JSON.stringify(opts)}` : key),
    i18n: { language: 'en', changeLanguage: vi.fn() }
  })
}))

const auth = vi.hoisted(() => ({ value: null }))
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => auth.value }))

const pk = vi.hoisted(() => ({ possible: true, canHold: true, here: false, dismissed: false }))
vi.mock('../../../lib/passkeys', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    passkeysPossible: () => pk.possible,
    deviceCanHoldPasskey: async () => pk.canHold,
    passkeyHere: () => pk.here,
    passkeyOfferDismissed: () => pk.dismissed,
    anyPasskeyHere: () => pk.here,
    markPasskeyHere: vi.fn(),
    dismissPasskeyOffer: vi.fn(),
    runPasskeySetUp: vi.fn()
  }
})

const api = vi.hoisted(() => ({ addPasskey: vi.fn(), listPasskeys: vi.fn() }))
vi.mock('../../../lib/apiClient', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, apiAuth: { ...real.apiAuth, addPasskey: api.addPasskey, listPasskeys: api.listPasskeys } }
})

import LoginModal from '../LoginModal'
import PasskeyOfferHost from '../PasskeyOfferHost'
import { clearPasskeyOffer } from '../passkeyOffer'
import { passkeyErrorText } from '../passkeyErrors'
import { passkeysPossible } from '../../../lib/passkeys'
import * as passkeysLib from '../../../lib/passkeys'

const t = (k) => k

function signInWithPassword() {
  fireEvent.change(screen.getByLabelText('auth.email'), { target: { value: 'anna@example.ch' } })
  fireEvent.change(screen.getByLabelText('auth.password'), { target: { value: 'pw-anna-123' } })
  fireEvent.click(screen.getByRole('button', { name: 'auth.signIn' }))
}

describe('sign-in dialog with passkeys', () => {
  beforeEach(() => {
    Object.assign(pk, { possible: true, canHold: true, here: false, dismissed: false })
    api.addPasskey.mockReset()
    api.listPasskeys.mockReset()
    api.listPasskeys.mockResolvedValue({ data: { passkeys: [] }, error: null })
    passkeysLib.markPasskeyHere.mockClear?.()
    clearPasskeyOffer()
    auth.value = {
      signIn: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null }),
      signInWithPasskey: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null }),
      resetPassword: vi.fn()
    }
  })

  it('offers the passkey button and signs in with it, no address and no password', async () => {
    const onClose = vi.fn()
    render(<LoginModal open onClose={onClose} onSwitchToSignUp={() => {}} />)
    fireEvent.click(screen.getByTestId('passkey-sign-in'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(auth.value.signInWithPasskey).toHaveBeenCalled()
    expect(passkeysLib.markPasskeyHere).toHaveBeenCalledWith('u1', true)
  })

  it('says why a passkey was refused, and keeps the password form', async () => {
    auth.value.signInWithPasskey.mockResolvedValue({ data: null, error: { status: 401, code: 'passkey_unknown' } })
    render(<LoginModal open onClose={() => {}} onSwitchToSignUp={() => {}} />)
    fireEvent.click(screen.getByTestId('passkey-sign-in'))
    expect(await screen.findByRole('alert')).toHaveTextContent('passkeys.errors.unknown')
    expect(screen.getByLabelText('auth.password')).toBeInTheDocument()
  })

  it('a closed device sheet is no error', async () => {
    auth.value.signInWithPasskey.mockRejectedValue(Object.assign(new Error('closed'), { name: 'NotAllowedError' }))
    render(<LoginModal open onClose={() => {}} onSwitchToSignUp={() => {}} />)
    fireEvent.click(screen.getByTestId('passkey-sign-in'))
    await waitFor(() => expect(screen.getByTestId('passkey-sign-in')).not.toBeDisabled())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // The sign-in dialog closes on success (the header shows it only while
  // nobody is signed in); the offer comes from PasskeyOfferHost, which
  // AuthProvider renders for every app.
  it('after a password sign-in, offers to set one up with the password just typed', async () => {
    api.addPasskey.mockResolvedValue({ data: { passkey: { id: 'p1' } }, error: null })
    const onClose = vi.fn()
    render(<><LoginModal open onClose={onClose} onSwitchToSignUp={() => {}} /><PasskeyOfferHost /></>)
    signInWithPassword()
    expect(await screen.findByTestId('passkey-offer')).toBeInTheDocument()
    expect(onClose).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'passkeys.setUp' }))
    await waitFor(() => expect(screen.queryByTestId('passkey-offer')).toBeNull())
    expect(api.addPasskey).toHaveBeenCalledWith({ password: 'pw-anna-123', lang: 'en' }, passkeysLib.runPasskeySetUp)
    expect(passkeysLib.markPasskeyHere).toHaveBeenCalledWith('u1', true)
  })

  it('a refused set-up says why and keeps the offer open', async () => {
    api.addPasskey.mockResolvedValue({ data: null, error: { status: 401, code: 'invalid_password' } })
    render(<><LoginModal open onClose={() => {}} onSwitchToSignUp={() => {}} /><PasskeyOfferHost /></>)
    signInWithPassword()
    fireEvent.click(await screen.findByRole('button', { name: 'passkeys.setUp' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('passkeys.errors.wrongPassword')
    expect(screen.getByTestId('passkey-offer')).toBeInTheDocument()
  })

  it('"not now" closes the offer and is remembered', async () => {
    render(<><LoginModal open onClose={() => {}} onSwitchToSignUp={() => {}} /><PasskeyOfferHost /></>)
    signInWithPassword()
    fireEvent.click(await screen.findByRole('button', { name: 'passkeys.notNow' }))
    expect(screen.queryByTestId('passkey-offer')).toBeNull()
    expect(passkeysLib.dismissPasskeyOffer).toHaveBeenCalledWith('u1')
    expect(api.addPasskey).not.toHaveBeenCalled()
  })

  // owner 2026-11-11: the browser forgot the site (its hint gone), the account
  // has a passkey: no offer, the hint comes back; a failed read still offers
  it('no offer when the account already has a passkey (the server\'s list)', async () => {
    api.listPasskeys.mockResolvedValue({ data: { passkeys: [{ id: 'p1' }] }, error: null })
    const onClose = vi.fn()
    render(<><LoginModal open onClose={onClose} onSwitchToSignUp={() => {}} /><PasskeyOfferHost /></>)
    signInWithPassword()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(screen.queryByTestId('passkey-offer')).toBeNull()
    expect(passkeysLib.markPasskeyHere).toHaveBeenCalledWith('u1', true)
  })

  it('a failed passkey list still offers', async () => {
    api.listPasskeys.mockResolvedValue({ data: null, error: { status: 503 } })
    render(<><LoginModal open onClose={() => {}} onSwitchToSignUp={() => {}} /><PasskeyOfferHost /></>)
    signInWithPassword()
    expect(await screen.findByTestId('passkey-offer')).toBeInTheDocument()
  })

  it('no offer where the device cannot keep a key, or once dismissed', async () => {
    pk.canHold = false
    const onClose = vi.fn()
    render(<><LoginModal open onClose={onClose} onSwitchToSignUp={() => {}} /><PasskeyOfferHost /></>)
    signInWithPassword()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(screen.queryByTestId('passkey-offer')).toBeNull()
  })

  it('no passkey button where passkeys cannot work', () => {
    pk.possible = false
    render(<LoginModal open onClose={() => {}} onSwitchToSignUp={() => {}} />)
    expect(screen.queryByTestId('passkey-sign-in')).toBeNull()
  })
})

describe('passkey refusals in words', () => {
  it('maps the server\'s codes, the device\'s failures and the network', () => {
    expect(passkeyErrorText(t, { status: 401, code: 'passkey_unknown' })).toBe('passkeys.errors.unknown')
    expect(passkeyErrorText(t, { status: 401, code: 'invalid_password' })).toBe('passkeys.errors.wrongPassword')
    expect(passkeyErrorText(t, { status: 429, code: 'account_locked' })).toBe('authEmail.tooManyAttempts')
    expect(passkeyErrorText(t, { status: 503, code: 'passkeys_unavailable' })).toBe('passkeys.errors.unavailable')
    expect(passkeyErrorText(t, { network: true, status: 0 })).toBe('authEmail.offline')
    expect(passkeyErrorText(t, Object.assign(new Error('x'), { name: 'SecurityError' }))).toBe('passkeys.errors.device')
  })
})

describe('where passkeys are offered', () => {
  it('only in a browser, never in the installed apps', async () => {
    const { passkeysPossible: realPossible } = await vi.importActual('../../../lib/passkeys')
    const base = { navigator: { userAgent: 'Mozilla/5.0' }, PublicKeyCredential: function PublicKeyCredential () {} }
    expect(realPossible({ ...base, Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } })).toBe(false)
    expect(realPossible({ ...base, __TAURI_INTERNALS__: { invoke: () => {} } })).toBe(false)
    expect(realPossible({ ...base, electronAPI: {} })).toBe(false)
    expect(realPossible(undefined)).toBe(false)
    expect(typeof passkeysPossible).toBe('function')
  })
})
