/**
 * The live screen for TVs (backend lib/globalLive.js), for any event and any
 * match type (league, test, Easy, Global; OpenBeach has its own copy).
 *
 * An event opts in on its scorer devices with a shared live screen code: one
 * device makes it, the others type it in. While it is set, every match's live
 * updates to the relay carry it (Scoreboard live-state push), and every
 * screen with the code shows all courts of that code:
 *
 *   https://openvolley.app/tv/<code>             (any screen, smart TVs included)
 *   http://<venue relay>/tv/<code>               (the same at a venue without internet)
 *   https://livescore.openvolley.app/?t=<code>   (the livescore site's version)
 *   GET  <backend>/api/global/live/<code>          (the same data as JSON)
 *
 * Only a score summary leaves the device (team names and colours, points,
 * sets, who serves): no players, no officials.
 */
import { useSyncExternalStore } from 'react'

export const LIVE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/
const KEY = 'ov.liveScreen.code'
// the key of the first version (17.11, Global only): read once, moved to KEY
const OLD_KEY = 'ov.globalLive.code'
const EVENT = 'ov-global-live'
export const LIVESCORE_SITE = 'https://livescore.openvolley.app/'
// The TV page (backend lib/tvPage.js), short enough to type with a TV remote:
// openvolley.app/tv/<code> redirects to the backend, which serves it
export const TV_SITE = 'https://openvolley.app/tv/'

export const isLiveCode = (code) => typeof code === 'string' && CODE_RE.test(code)

/** What a person typed (spaces, dashes, lower case) as a code, or null. */
export function normalizeLiveCode(input) {
  if (typeof input !== 'string') return null
  const c = input.toUpperCase().replace(/[\s-]/g, '')
  return isLiveCode(c) ? c : null
}

/** A new code: 8 characters, about 40 random bits, no look-alikes (0/O, 1/I). */
export function newLiveCode(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(8)
  cryptoImpl.getRandomValues(bytes)
  return [...bytes].map((b) => LIVE_CODE_ALPHABET[b % LIVE_CODE_ALPHABET.length]).join('')
}

/**
 * The set number a court of the live page shows: a best-of-3 decider is
 * stored as set 5 (domain/describe.js), it is set 3 (audit LOG-20; the
 * backend's courtSummary maps it too, a venue relay before 26.11.6 not).
 */
export const setNumberOf = (court) => (Number(court?.bestOf) === 3 && Number(court?.currentSet) === 5 ? 3 : court?.currentSet)

/** "ABCD 2345": easier to read out and type */
export const formatLiveCode = (code) => (isLiveCode(code) ? `${code.slice(0, 4)} ${code.slice(4)}` : '')

/** The page for any screen, smart TVs included (plain HTML, old browsers fine). */
export const liveCodeUrl = (code) => (isLiveCode(code) ? `${TV_SITE}${code}` : null)

/** The same page on a venue relay (no internet needed): its HTTP base + /tv/<code>. */
export const localTvUrl = (base, code) => (isLiveCode(code) && typeof base === 'string' && /^https?:\/\//.test(base) ? `${base.replace(/\/+$/, '')}/tv/${code}` : null)

// A match's court token (backend isCourtToken): 32 hex characters that every
// scoring device of the match works out alike and the public cannot, so its
// court is one court on the page whether it comes over the relay, from a
// venue relay's forward or from the desktop app's push, and whichever device
// scores it (2611 review, SR-3: a random secret per device gave a second,
// frozen court on every TV after a device switch or a restore):
//   - a Global or guest match: SHA-256 of 'court' and its globalKey (the
//     backup code every device of it holds);
//   - a match with a game PIN and a seed key: HMAC-SHA256 keyed with the game
//     PIN (every scoring device knows it: the scorer sets it, a takeover or a
//     restore proves it; never relayed or public) of 'court' and the seed key;
//   - else its liveSecret (random, 128 bits, made on this device, never
//     relayed: serverDataSync NEVER_RELAYED).
// Never the seed key alone: that is a league or OpenBeach match's public id,
// and its hash let anyone take over the court on every TV (audit SEC-07). No
// source: no token (the relay then keeps one court per room).
const LIVE_SECRET_RE = /^[A-Za-z0-9_-]{22,64}$/
export const isLiveSecret = (v) => typeof v === 'string' && LIVE_SECRET_RE.test(v)
/** A new liveSecret: 16 random bytes, base64url. */
export function newLiveSecret(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(16)
  cryptoImpl.getRandomValues(bytes)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const GAME_PIN_RE = /^[0-9]{4,8}$/
const seedKeyOf = (match) => [match?.seed_key, match?.seedKey].find((k) => typeof k === 'string' && k.trim()) || null
const gamePinOf = (match) => {
  const v = match?.gamePin ?? match?.game_pin
  const pin = v == null ? '' : String(v).trim()
  return GAME_PIN_RE.test(pin) ? pin : null
}
/**
 * What the match's court token comes from: { kind: 'key', secret } (a
 * Global or guest match's globalKey), { kind: 'pin', pin, seedKey } or
 * { kind: 'secret', secret } (its liveSecret); null when none.
 */
export function courtSourceOf(match) {
  if (typeof match?.globalKey === 'string' && match.globalKey) return { kind: 'key', secret: match.globalKey }
  const pin = gamePinOf(match)
  const seedKey = seedKeyOf(match)
  if (pin && seedKey) return { kind: 'pin', pin, seedKey }
  if (isLiveSecret(match?.liveSecret)) return { kind: 'secret', secret: match.liveSecret }
  return null
}
/** The match's secret for its court token when it has no game PIN, or null (kept for the callers of before). */
export function liveSecretOf(match) {
  const src = courtSourceOf(match)
  return src && src.kind !== 'pin' ? src.secret : null
}
const tokens = new Map()
const sourceKey = (src) => (src.kind === 'pin' ? `pin\0${src.pin}\0${src.seedKey}` : `s\0${src.secret}`)
const hex32 = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
export async function courtTokenFor(match, subtle = globalThis.crypto?.subtle) {
  const src = courtSourceOf(match)
  if (!src || !subtle) return null
  const k = sourceKey(src)
  if (tokens.has(k)) return tokens.get(k)
  const enc = new TextEncoder()
  let digest
  if (src.kind === 'pin') {
    const key = await subtle.importKey('raw', enc.encode(src.pin), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    digest = await subtle.sign('HMAC', key, enc.encode(`court\0${src.seedKey}`))
  } else {
    digest = await subtle.digest('SHA-256', enc.encode(`court\0${src.secret}`))
  }
  const hex = hex32(digest)
  if (tokens.size >= 500) tokens.clear()
  tokens.set(k, hex)
  return hex
}
/** The token if already worked out; starts the work otherwise. */
export function cachedCourtToken(match) {
  const src = courtSourceOf(match)
  if (!src) return null
  const k = sourceKey(src)
  if (tokens.has(k)) return tokens.get(k)
  courtTokenFor(match).catch(() => null)
  return null
}

// One liveSecret per match, also when two pushes ask at once
const making = new Map()
/**
 * The match with its liveSecret: made and stored once (Dexie matches row),
 * the first time a match without a game PIN goes to a live screen. Unchanged
 * when it has one, a globalKey or a game PIN with its seed key (courtSourceOf),
 * or when it cannot be stored (no token then rather than a new one with
 * every push).
 * @param {import('dexie').Dexie} database
 * @param {number|string} matchId
 * @param {object} match
 */
export async function ensureLiveSecret(database, matchId, match) {
  // a globalKey, or a game PIN with a seed key: the token needs no secret of this device
  if (!match || courtSourceOf(match) || matchId == null || !database?.matches) return match
  if (!making.has(matchId)) {
    making.set(matchId, (async () => {
      try {
        return await database.transaction('rw', database.matches, async () => {
          const row = await database.matches.get(matchId)
          if (!row) return null
          if (isLiveSecret(row.liveSecret)) return row.liveSecret
          const liveSecret = newLiveSecret()
          await database.matches.update(matchId, { liveSecret })
          return liveSecret
        })
      } catch {
        return null
      } finally {
        making.delete(matchId)
      }
    })())
  }
  const liveSecret = await making.get(matchId)
  return liveSecret ? { ...match, liveSecret } : match
}

/**
 * What a live-state push to the relay carries for the live screen: the code,
 * the match's court token (worked out first: the first push of a page load
 * went without it and made a second, frozen court on every TV, audit
 * LOG-11), the court number and the livescore opt-in. {} without a code.
 * `match` is the match with its liveSecret (the desktop app's push needs it).
 * @returns {Promise<{ fields: object, match: object }>}
 */
export async function liveScreenFieldsFor({ match, db: database, matchId }) {
  const code = liveCodeForMatch(match)
  if (!code) return { fields: {}, match }
  const withSecret = await ensureLiveSecret(database, matchId, match)
  const court = await courtTokenFor(withSecret).catch(() => null)
  const screen = getLiveCourt()
  return {
    fields: {
      globalLive: code,
      ...(court ? { globalLiveCourt: court } : {}),
      ...(screen ? { globalLiveScreen: screen } : {}),
      ...(liveListedForMatch(withSecret) ? { globalLiveListed: true } : {})
    },
    match: withSecret
  }
}

export function getLiveCode() {
  try {
    let v = localStorage.getItem(KEY)
    if (v == null) {
      const old = localStorage.getItem(OLD_KEY)
      if (isLiveCode(old)) { localStorage.setItem(KEY, old); v = old }
      localStorage.removeItem(OLD_KEY)
    }
    return isLiveCode(v) ? v : null
  } catch { return null }
}

/** null switches the live page off on this device. */
export function setLiveCode(code) {
  try {
    if (code == null) localStorage.removeItem(KEY)
    else if (isLiveCode(code)) localStorage.setItem(KEY, code)
    else return
  } catch { /* private window: lasts until reload */ }
  try { window.dispatchEvent(new Event(EVENT)) } catch { /* no window */ }
}

const subscribe = (cb) => {
  window.addEventListener(EVENT, cb)
  window.addEventListener('storage', cb)
  return () => { window.removeEventListener(EVENT, cb); window.removeEventListener('storage', cb) }
}

export function useLiveCode() {
  return useSyncExternalStore(subscribe, getLiveCode, () => null)
}

// The court this device scores (optional, 1-99): a TV can show that court
// alone at /tv/<code>/<court> (backend screenNumber)
const COURT_KEY = 'ov.liveScreen.court'
export const isCourtNumber = (n) => Number.isInteger(n) && n >= 1 && n <= 99
export function getLiveCourt() {
  try {
    const n = Number(localStorage.getItem(COURT_KEY))
    return isCourtNumber(n) ? n : null
  } catch { return null }
}
/** null: no court number on this device. */
export function setLiveCourt(n) {
  try {
    if (n == null || n === '') localStorage.removeItem(COURT_KEY)
    else if (isCourtNumber(Number(n))) localStorage.setItem(COURT_KEY, String(Number(n)))
    else return
  } catch { /* private window */ }
  try { window.dispatchEvent(new Event(EVENT)) } catch { /* no window */ }
}
export function useLiveCourt() {
  return useSyncExternalStore(subscribe, getLiveCourt, () => null)
}
/** The TV address of one court of a code. */
export const liveCourtUrl = (code, court) => (isLiveCode(code) && isCourtNumber(court) ? `${TV_SITE}${code}/${court}` : null)

// The public livescore (livescore.openvolley.app) lists a Global match's
// court too, unless this device turned it off (owner 2026-11-17: a Global
// match has no database row, so the livescore's game list cannot have it;
// backend lib/globalLive.js list). Only a Global match: a league match is on
// the livescore anyway, a test or Easy match is practice.
const LISTED_KEY = 'ov.liveScreen.listed'
export function getLiveListed() {
  try { return localStorage.getItem(LISTED_KEY) !== '0' } catch { return true }
}
export function setLiveListed(on) {
  try { localStorage.setItem(LISTED_KEY, on ? '1' : '0') } catch { /* private window */ }
  try { window.dispatchEvent(new Event(EVENT)) } catch { /* no window */ }
}
export function useLiveListed() {
  return useSyncExternalStore(subscribe, getLiveListed, () => true)
}
/** The live push asks the cloud to list this match's court on the livescore. */
export const liveListedForMatch = (match) => match?.global === true && getLiveListed()

/** The code a match's live push carries: any match on a device that opted in. */
export const liveCodeForMatch = (match) => (match ? getLiveCode() : null)

/** The tournament code a livescore URL asks for (?t=...), or null. */
export function liveCodeFromUrl(search = typeof window !== 'undefined' ? window.location.search : '') {
  try {
    return normalizeLiveCode(new URLSearchParams(search).get('t') || '')
  } catch { return null }
}
