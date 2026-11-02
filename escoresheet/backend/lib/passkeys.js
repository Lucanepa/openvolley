/**
 * Passkey sign-in (WebAuthn): the ceremonies and their rules, free of the
 * database and of HTTP so a test can run them end to end against a software
 * authenticator (tests/passkeys.test.js). lib/auth.js keeps the I/O: the
 * rows, the session, the mail.
 *
 * A passkey is a key pair the user's device keeps; its fingerprint, face or
 * PIN unlocks the private key, and only the public key comes here. One
 * relying party for every OpenVolley and OpenBeach site: `openvolley.app`,
 * so a passkey set up on app.openvolley.app also signs in on
 * manager.openvolley.app and beach.openvolley.app — the same account, the
 * same key.
 *
 * Where it stands next to the password: a passkey is an extra way in to an
 * account that has one, never a replacement. Setting one up needs the
 * password (auth.js), so a stolen session cannot add its own key; setting a
 * new password (a reset link, the operator CLI) removes them all, like it
 * signs every device out; the account's address is mailed whenever one is
 * added.
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server'
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers'
import { randomBytes } from 'node:crypto'

/** How long the device's sheet may stay open. */
export const PASSKEY_CEREMONY_MS = 2 * 60 * 1000
/** A challenge waits a little longer than the sheet, for a slow network. */
export const PASSKEY_CHALLENGE_TTL_MS = PASSKEY_CEREMONY_MS + 60 * 1000
/** Outstanding challenges at most. The sign-in options need no session, so
 *  the map has a ceiling that does not depend on the rate limits; the oldest
 *  go first. */
export const PASSKEY_CHALLENGES_MAX = 5000
/** Passkeys one account may have: phones, tablets, laptops and their
 *  replacements fit; a script making thousands does not. */
export const PASSKEYS_PER_USER_MAX = 10

const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'])
const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{1,1024}$/

/**
 * The relying party and who may ask. `WEBAUTHN_RP_ID` defaults to
 * openvolley.app; a page may run a ceremony when it is served over https from
 * that host or one of its subdomains (every OpenVolley and OpenBeach site), or
 * from `WEBAUTHN_ORIGINS` when set (a local test: RP `localhost`, origin
 * http://localhost:5173). The apps' own schemes (capacitor, tauri, a local
 * relay) never match: their pages cannot hold a passkey for a web host.
 */
export function passkeyConfig(env = process.env) {
  const rpId = String(env.WEBAUTHN_RP_ID || 'openvolley.app').trim().toLowerCase()
  const explicit = String(env.WEBAUTHN_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean)
  return { rpId, rpName: 'OpenVolley', explicitOrigins: explicit }
}

/** May a page at `origin` run a ceremony for this relying party? */
export function originAllowed(origin, config) {
  if (typeof origin !== 'string' || !origin) return false
  if (config.explicitOrigins.length) return config.explicitOrigins.includes(origin)
  let url
  try { url = new URL(origin) } catch { return false }
  if (url.origin !== origin) return false // no paths, no trailing slash games
  const host = url.hostname
  if (host !== config.rpId && !host.endsWith(`.${config.rpId}`)) return false
  return url.protocol === 'https:' || (url.protocol === 'http:' && host === 'localhost')
}

/** The origin a browser wrote into the answer (clientDataJSON), or ''. */
export function originOf(response) {
  try {
    const json = isoUint8Array.toUTF8String(isoBase64URL.toBuffer(String(response?.response?.clientDataJSON || '')))
    const origin = JSON.parse(json)?.origin
    return typeof origin === 'string' ? origin : ''
  } catch { return '' }
}

/** "iPhone · Safari", "Android · Chrome", "Mac · Firefox": the list in the
 *  profile and the mail read as the user's own devices, nothing more. */
export function passkeyDeviceLabel(userAgent) {
  const ua = String(userAgent || '')
  const device =
    /iPad/.test(ua) ? 'iPad'
      : /iPhone/.test(ua) ? 'iPhone'
        : /Android/.test(ua) ? 'Android'
          : /Macintosh|Mac OS X/.test(ua) ? (/Mobile/.test(ua) ? 'iPad' : 'Mac')
            : /Windows/.test(ua) ? 'Windows'
              : /CrOS/.test(ua) ? 'Chromebook'
                : /Linux/.test(ua) ? 'Linux'
                  : ''
  const browser =
    /Edg\//.test(ua) ? 'Edge'
      : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
        : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
          : /OPR\//.test(ua) ? 'Opera'
            : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
              : /Safari\//.test(ua) ? 'Safari'
                : ''
  return [device, browser].filter(Boolean).join(' · ') || 'Device'
}

/** The device's transports, cut to the ones WebAuthn defines. */
export function cleanTransports(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(String).filter((t) => TRANSPORTS.has(t)))]
}

export class PasskeyError extends Error {
  /** code: 'challenge' (unknown, used or expired), 'unknown' (no such key),
   *  'mismatch' (issued to someone else), 'origin', 'invalid' (signature,
   *  RP, user verification). */
  constructor(code, message) {
    super(message)
    this.name = 'PasskeyError'
    this.code = code
  }
}

/**
 * The two ceremonies with their challenges, held in this process: a restart
 * costs whoever had the sheet open one more tap. Each challenge is taken out
 * of the map before it is checked, so an answer sent twice finds nothing.
 */
export function createPasskeyCeremonies(config, now = Date.now) {
  const challenges = new Map()

  function sweep() {
    const t = now()
    for (const [id, entry] of challenges) if (entry.expiresAt < t) challenges.delete(id)
  }

  function issue(entry) {
    sweep()
    while (challenges.size >= PASSKEY_CHALLENGES_MAX) {
      const oldest = challenges.keys().next().value
      if (oldest === undefined) break
      challenges.delete(oldest)
    }
    const id = randomBytes(18).toString('base64url')
    challenges.set(id, { ...entry, expiresAt: now() + PASSKEY_CHALLENGE_TTL_MS })
    return id
  }

  function take(id, purpose) {
    const entry = typeof id === 'string' ? challenges.get(id) : undefined
    if (entry) challenges.delete(id)
    if (!entry || entry.purpose !== purpose || entry.expiresAt < now()) {
      throw new PasskeyError('challenge', 'challenge unknown, used or expired')
    }
    return entry
  }

  /** The answer's origin, checked against the rule before the library sees it. */
  function allowedOrigin(response) {
    const origin = originOf(response)
    if (!originAllowed(origin, config)) throw new PasskeyError('origin', `origin not allowed: ${origin.slice(0, 80)}`)
    return origin
  }

  return {
    config,
    sweep,
    get pending() { return challenges.size },

    /**
     * Options for setting up a passkey. The user handle is the account id (a
     * UUID, nothing personal), so a device that already holds a key for the
     * account replaces it instead of keeping two. Discoverable and
     * user-verified, both required: sign-in starts with no address typed,
     * and "fingerprint or face" is the point.
     */
    async registrationOptions({ userId, email, existing }) {
      const options = await generateRegistrationOptions({
        rpName: config.rpName,
        rpID: config.rpId,
        userID: isoUint8Array.fromUTF8String(String(userId)),
        userName: String(email || userId),
        userDisplayName: String(email || ''),
        timeout: PASSKEY_CEREMONY_MS,
        attestationType: 'none',
        excludeCredentials: (existing || []).map((p) => ({ id: p.credentialId, transports: p.transports })),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        preferredAuthenticatorType: 'localDevice'
      })
      const challengeId = issue({ challenge: options.challenge, purpose: 'register', userId: String(userId) })
      return { challengeId, options }
    },

    async finishRegistration({ challengeId, userId, response }) {
      const entry = take(challengeId, 'register')
      if (entry.userId !== String(userId)) throw new PasskeyError('mismatch', 'challenge issued for another account')
      const origin = allowedOrigin(response)
      let verification
      try {
        verification = await verifyRegistrationResponse({
          response,
          expectedChallenge: entry.challenge,
          expectedOrigin: origin,
          expectedRPID: config.rpId,
          requireUserVerification: true
        })
      } catch (err) {
        throw new PasskeyError('invalid', err?.message || String(err))
      }
      if (!verification.verified || !verification.registrationInfo) throw new PasskeyError('invalid', 'registration not verified')
      const info = verification.registrationInfo
      return {
        credentialId: info.credential.id,
        publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
        counter: info.credential.counter,
        transports: cleanTransports(info.credential.transports ?? response?.response?.transports),
        backedUp: info.credentialBackedUp === true
      }
    },

    /** Options for signing in: no list of keys — the device offers what it
     *  has for openvolley.app, and the answer says whose it was. */
    async authenticationOptions() {
      const options = await generateAuthenticationOptions({
        rpID: config.rpId,
        timeout: PASSKEY_CEREMONY_MS,
        userVerification: 'required'
      })
      const challengeId = issue({ challenge: options.challenge, purpose: 'login', userId: '' })
      return { challengeId, options }
    },

    /** lookup(credentialId) -> { id, userId, credentialId, publicKey, counter, transports } | null */
    async finishAuthentication({ challengeId, response, lookup }) {
      const entry = take(challengeId, 'login')
      const credentialId = typeof response?.id === 'string' ? response.id : ''
      // Checked before it goes anywhere near a query.
      if (!CREDENTIAL_ID_RE.test(credentialId)) throw new PasskeyError('invalid', 'no usable credential id')
      const origin = allowedOrigin(response)
      const passkey = await lookup(credentialId)
      if (!passkey) throw new PasskeyError('unknown', 'no such passkey')
      // The user handle, when the device sends one, must be the account the
      // key is filed under; the row is the authority either way.
      const handle = response?.response?.userHandle
      if (handle) {
        let claimed = ''
        try { claimed = isoUint8Array.toUTF8String(isoBase64URL.toBuffer(handle)) } catch { claimed = '' }
        if (claimed !== String(passkey.userId)) throw new PasskeyError('invalid', 'user handle does not match the passkey')
      }
      let verification
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: entry.challenge,
          expectedOrigin: origin,
          expectedRPID: config.rpId,
          credential: {
            id: passkey.credentialId,
            publicKey: isoBase64URL.toBuffer(passkey.publicKey),
            counter: Number(passkey.counter) || 0,
            transports: passkey.transports
          },
          requireUserVerification: true
        })
      } catch (err) {
        throw new PasskeyError('invalid', err?.message || String(err))
      }
      if (!verification.verified) throw new PasskeyError('invalid', 'authentication not verified')
      return { passkey, newCounter: verification.authenticationInfo.newCounter }
    }
  }
}
