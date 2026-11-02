// The offer to set up a passkey after a password sign-in, held outside the
// sign-in dialog: the dialogs that sign in (the header's, the manager's) are
// shown only while nobody is signed in, so they are gone the moment the
// sign-in succeeds. LoginModal hands the offer here and closes; the host
// (PasskeyOfferHost, rendered by AuthProvider) shows it.
let pending = null
const listeners = new Set()

/** { userId, password } — the password just typed: setting one up needs it. */
export function showPasskeyOffer(offer) {
  pending = offer
  for (const l of listeners) l(pending)
}

export function clearPasskeyOffer() {
  pending = null
  for (const l of listeners) l(null)
}

export function currentPasskeyOffer() {
  return pending
}

export function subscribePasskeyOffer(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
