// A passkey refusal in words (lib/passkeys.js, backend/lib/passkeys.js). The
// server's refusals carry a code; the device's own failures come thrown with
// no status, and are not the network.
export function passkeyErrorText(t, error) {
  const code = error?.code
  if (code === 'passkey_unknown') return t('passkeys.errors.unknown')
  if (code === 'passkey_invalid') return t('passkeys.errors.invalid')
  if (code === 'passkey_expired') return t('passkeys.errors.expired')
  if (code === 'passkey_limit') return t('passkeys.errors.limit')
  if (code === 'passkey_duplicate') return t('passkeys.errors.alreadyHere')
  if (code === 'invalid_password') return t('passkeys.errors.wrongPassword')
  if (code === 'account_locked' || error?.status === 429) return t('authEmail.tooManyAttempts')
  if (code === 'passkeys_unavailable' || error?.status === 503) return t('passkeys.errors.unavailable')
  if (error?.network || error?.status === 0) return t('authEmail.offline')
  if (typeof error?.status === 'number') return error?.message || t('authEmail.genericError')
  return t('passkeys.errors.device')
}
