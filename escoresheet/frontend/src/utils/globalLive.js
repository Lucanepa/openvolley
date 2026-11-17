/**
 * The Global tool's live page for TVs (backend lib/globalLive.js).
 *
 * A tournament opts in on its scorer devices with a shared tournament code:
 * one device makes it, the others type it in. While it is set, a Global
 * match's live updates to the relay carry it (Scoreboard live-state push),
 * and the livescore site shows every court of that code:
 *
 *   https://livescore.openvolley.app/?t=<code>   (a TV, a laptop on a beamer)
 *   GET  <backend>/api/global/live/<code>          (the same data as JSON)
 *
 * Only a score summary leaves the device (team names and colours, points,
 * sets, who serves): no players, no officials. Swiss matches do not use it;
 * they have the public livescore already.
 */
import { useSyncExternalStore } from 'react'

export const LIVE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/
const KEY = 'ov.globalLive.code'
const EVENT = 'ov-global-live'
export const LIVESCORE_SITE = 'https://livescore.openvolley.app/'

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

export const liveCodeUrl = (code) => (isLiveCode(code) ? `${LIVESCORE_SITE}?t=${code}` : null)

export function getLiveCode() {
  try {
    const v = localStorage.getItem(KEY)
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

/** The code a match's live push carries: a Global match on a device that opted in. */
export const liveCodeForMatch = (match) => (match?.global === true ? getLiveCode() : null)

/** The tournament code a livescore URL asks for (?t=...), or null. */
export function liveCodeFromUrl(search = typeof window !== 'undefined' ? window.location.search : '') {
  try {
    return normalizeLiveCode(new URLSearchParams(search).get('t') || '')
  } catch { return null }
}
