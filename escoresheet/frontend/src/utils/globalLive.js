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

/** "ABCD 2345": easier to read out and type */
export const formatLiveCode = (code) => (isLiveCode(code) ? `${code.slice(0, 4)} ${code.slice(4)}` : '')

/** The page for any screen, smart TVs included (plain HTML, old browsers fine). */
export const liveCodeUrl = (code) => (isLiveCode(code) ? `${TV_SITE}${code}` : null)

/** The same page on a venue relay (no internet needed): its HTTP base + /tv/<code>. */
export const localTvUrl = (base, code) => (isLiveCode(code) && typeof base === 'string' && /^https?:\/\//.test(base) ? `${base.replace(/\/+$/, '')}/tv/${code}` : null)

// A match's court token (backend isCourtToken): the first 32 hex characters of
// SHA-256 of its own secret key (globalKey, else seed key), so its court is
// one court on the page whether it comes over the relay, from a venue relay's
// forward or from the desktop app's push, and nobody can guess it.
const tokens = new Map()
export async function courtTokenFor(match, subtle = globalThis.crypto?.subtle) {
  const secret = match?.globalKey || match?.seed_key || match?.seedKey
  if (!secret || !subtle) return null
  if (tokens.has(secret)) return tokens.get(secret)
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(`court\0${secret}`))
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
  tokens.set(secret, hex)
  return hex
}
/** The token if already worked out (a live push cannot wait); starts the work otherwise. */
export function cachedCourtToken(match) {
  const secret = match?.globalKey || match?.seed_key || match?.seedKey
  if (!secret) return null
  if (tokens.has(secret)) return tokens.get(secret)
  courtTokenFor(match).catch(() => null)
  return null
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

/** The code a match's live push carries: any match on a device that opted in. */
export const liveCodeForMatch = (match) => (match ? getLiveCode() : null)

/** The tournament code a livescore URL asks for (?t=...), or null. */
export function liveCodeFromUrl(search = typeof window !== 'undefined' ? window.location.search : '') {
  try {
    return normalizeLiveCode(new URLSearchParams(search).get('t') || '')
  } catch { return null }
}
