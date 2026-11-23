// "Your licence number?" for an account that has none (owner 23.11.2026: sign-up
// needs it now; the accounts made before are asked at their next sign-in).
// Held outside the sign-in dialogs like the passkey offer (passkeyOffer.js):
// AuthContext asks after a sign-in, the manager when it opens with a signed-in
// account; LicenceAskHost (rendered by AuthProvider) shows it once the
// profile is known to lack a licence number and no passkey offer is open.
//
// "Later" is remembered for the account in this browser until its next
// sign-in, which asks again.

const LATER_KEY = 'ov.licenceAsk.later.'

let pending = null
const listeners = new Set()

const emit = () => { for (const l of listeners) l(pending) }

function readLater (userId) {
  try { return !!globalThis.localStorage?.getItem(LATER_KEY + userId) } catch { return false }
}

function writeLater (userId, on) {
  try {
    if (on) globalThis.localStorage?.setItem(LATER_KEY + userId, String(Date.now()))
    else globalThis.localStorage?.removeItem(LATER_KEY + userId)
  } catch { /* private mode: asked again next time */ }
}

/** Ask `userId` unless it said "Later" in this browser (the manager opening). */
export function askLicence (userId) {
  if (!userId || readLater(userId)) return
  pending = { userId }
  emit()
}

/** A sign-in just happened: an earlier "Later" no longer counts. */
export function askLicenceAfterSignIn (userId) {
  if (!userId) return
  writeLater(userId, false)
  askLicence(userId)
}

/** "Later": not again for this account in this browser until it signs in again. */
export function postponeLicenceAsk (userId) {
  if (userId) writeLater(userId, true)
  clearLicenceAsk()
}

export function clearLicenceAsk () {
  pending = null
  emit()
}

export function currentLicenceAsk () {
  return pending
}

export function subscribeLicenceAsk (listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function licenceAskPostponed (userId) {
  return readLater(userId)
}
