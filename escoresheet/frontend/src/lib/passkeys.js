// Passkeys: sign in with the device's fingerprint, face or PIN instead of the
// password. The device keeps the key and checks the person; the server
// (backend/lib/passkeys.js) checks the signature. One relying party,
// openvolley.app, for every OpenVolley and OpenBeach site, so a key set up on
// app.openvolley.app also works on manager.openvolley.app and on OpenBeach.
//
// Web only. The installed apps' pages are not on openvolley.app (Capacitor
// serves https://localhost, the desktop app a local server), and a passkey
// belongs to the site — the device would refuse, and the Linux desktop app's
// web view has no passkey support at all. There the password stays the way in.

import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration
} from '@simplewebauthn/browser'
import { platformName } from '../utils/identity'

/** This page can run a passkey ceremony at all. */
export function passkeysPossible(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win || platformName(win) !== 'web') return false
  try { return browserSupportsWebAuthn() } catch { return false }
}

/** This device can keep a passkey itself (the offer after a password
 *  sign-in asks only then). A laptop without a sensor can still sign in with
 *  a phone's passkey; it is just not asked to keep one. */
export async function deviceCanHoldPasskey() {
  if (!passkeysPossible()) return false
  try { return await platformAuthenticatorIsAvailable() } catch { return false }
}

/** The person closed the device's sheet or let it time out: nothing to say. */
export function isPasskeyCancel(error) {
  const e = error || {}
  return e.name === 'NotAllowedError' || e.name === 'AbortError' || e.code === 'ERROR_CEREMONY_ABORTED'
    || e.cause?.name === 'NotAllowedError' || e.cause?.name === 'AbortError'
}

/** The device already holds a key for this account (it refused a second). */
export function isPasskeyAlreadyHere(error) {
  return error?.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || error?.name === 'InvalidStateError'
}

/** The device's sheet for signing in: server options in, answer out. */
export function runPasskeySignIn(options) {
  return startAuthentication({ optionsJSON: options })
}

/** The device's sheet for setting one up. */
export function runPasskeySetUp(options) {
  return startRegistration({ optionsJSON: options })
}

// What this browser remembers, per account: hints only — the server is the
// authority on what signs in. `on`: a key was set up here (the sign-in
// screen leads with the passkey button, the offer is not repeated).
// `dismissed`: "not now" to the offer.
const HINT_KEY = 'ov_passkey_hints'

function readHints() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HINT_KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

function writeHint(userId, patch) {
  try {
    const hints = readHints()
    hints[userId] = { ...hints[userId], ...patch }
    localStorage.setItem(HINT_KEY, JSON.stringify(hints))
  } catch { /* private mode: the offer may come again, nothing worse */ }
}

export const anyPasskeyHere = () => Object.values(readHints()).some((h) => h?.on)
export const passkeyHere = (userId) => Boolean(readHints()[userId]?.on)
export const passkeyOfferDismissed = (userId) => Boolean(readHints()[userId]?.dismissed)
export const markPasskeyHere = (userId, on) => writeHint(userId, { on })
export const dismissPasskeyOffer = (userId) => writeHint(userId, { dismissed: true })
