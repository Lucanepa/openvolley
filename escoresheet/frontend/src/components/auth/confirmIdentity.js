// "Confirm it is you" for the account's sensitive actions (backend
// lib/auth.js reauth): deleting the account, removing a passkey, removing
// every passkey with "sign out everywhere". The server wants the password
// or a passkey of the account besides the session, so a device left signed
// in (or a copied token) cannot do them.

import { apiAuth } from '../../lib/apiClient'
import { runPasskeySignIn } from '../../lib/passkeys'
import { passkeyErrorText } from './passkeyErrors'

/**
 * Runs `action({ password })` with the confirmation the person gave: the
 * typed password goes with the request; a passkey confirms first (reauth),
 * and the action then rides on that confirmation (5 minutes on the server).
 * Throws what the device throws (isPasskeyCancel: say nothing).
 */
export async function withConfirmation({ password, usePasskey = false }, action) {
  if (usePasskey) {
    const confirmed = await apiAuth.reauth({}, runPasskeySignIn)
    if (confirmed.error) return confirmed
    return action({})
  }
  return action({ password })
}

/** A refusal of a confirmed action in words. */
export function confirmErrorText(t, error) {
  if (error?.code === 'reauth_required') return t('accountSecurity.reauthRequired')
  if (error?.code === 'weak_password') return error.message || t('auth.passwordTooShort')
  if (error?.code === 'password_required') return t('accountSecurity.reauthRequired')
  return passkeyErrorText(t, error)
}
