/**
 * The Global tool's opt-in cloud copy (owner 2026-11-17): a Global match whose
 * scorer switched on "Save in the cloud" (Match setup) is also kept readable
 * in the database, without an account (backend lib/globalMatches.js,
 * table global_matches). The match's key (the backup code) finds it and its
 * PIN guards it; the server keeps only hashes of both. It gives:
 *
 * - a share link (read-only: result, sets, the PDF scoresheet), which the
 *   scorer turns on and off: livescore.openvolley.app/?s=<token>
 * - an organizer list: every match saved with the same tournament code, on
 *   livescore.openvolley.app/?o=<code>
 * - continuing on another device: restore by backup code + PIN (the encrypted
 *   backup, utils/globalCloud); the newest device's saves win
 *
 * Deleted 180 days after its last save, or with "Delete from the cloud".
 * Nothing of it goes through the sync queue or the league's tables
 * (domain/matchKind isLocalOnly). Best effort and never throws: courtside
 * offline is normal, the next save catches up.
 */
import { getCloudApiUrl } from './backendConfig'
import { redactMatch } from './nativeBackup/redact'
import { isGlobalKey } from './globalCloud'
import { LIVE_CODE_ALPHABET } from './globalLive'
import { isRetryableRefusal, keepGlobalPending, retryAfterOf } from './globalPending'

const ORG_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/
export const isOrganizerCode = (c) => typeof c === 'string' && ORG_RE.test(c)
export const SHARE_SITE = 'https://livescore.openvolley.app/'

/** A new tournament code: 10 characters, about 50 random bits, no look-alikes. */
export function newOrganizerCode(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(10)
  cryptoImpl.getRandomValues(bytes)
  return [...bytes].map((b) => LIVE_CODE_ALPHABET[b % LIVE_CODE_ALPHABET.length]).join('')
}
/** What a person typed as a tournament code, or null. */
export function normalizeOrganizerCode(input) {
  if (typeof input !== 'string') return null
  const c = input.toUpperCase().replace(/[\s-]/g, '')
  return isOrganizerCode(c) ? c : null
}
/** "ABCDE 23456" */
export const formatOrganizerCode = (c) => (isOrganizerCode(c) ? `${c.slice(0, 5)} ${c.slice(5)}` : '')

export const shareUrl = (token) => (typeof token === 'string' && /^[A-Za-z0-9_-]{22}$/.test(token) ? `${SHARE_SITE}?s=${token}` : null)
export const organizerUrl = (code) => (isOrganizerCode(code) ? `${SHARE_SITE}?o=${code}` : null)

/** The match takes part: a Global match with its key and PIN, and the scorer switched it on. */
export const savesToGlobalCloud = (match) => match?.global === true && match.cloud === true && isGlobalKey(match.globalKey) && /^[0-9]{4,8}$/.test(String(match.refereePin || ''))

// The tablets' undo snapshots (about 90% of the events' size): no reader needs them
const EVENT_OMIT = ['stateSnapshot', 'stateBefore']

/**
 * The readable copy: the match without PINs, session ids, its key, its
 * tournament code or signature images (the PDF has the signed sheet), the
 * teams, players, sets and events without their undo snapshots.
 */
export function cloudBundle(data) {
  if (!data?.match) return null
  const match = redactMatch(data.match)
  for (const k of Object.keys(match)) if (/signature/i.test(k)) delete match[k]
  delete match.globalKey
  delete match.globalOrganizer
  delete match.cloudShareToken
  const events = (Array.isArray(data.events) ? data.events : []).map((e) => {
    if (!e || typeof e !== 'object') return e
    const out = { ...e }
    for (const k of EVENT_OMIT) delete out[k]
    return out
  })
  return {
    version: 1,
    match,
    homeTeam: data.homeTeam ?? null,
    awayTeam: data.awayTeam ?? null,
    homePlayers: Array.isArray(data.homePlayers) ? data.homePlayers : [],
    awayPlayers: Array.isArray(data.awayPlayers) ? data.awayPlayers : [],
    sets: Array.isArray(data.sets) ? data.sets : [],
    events
  }
}

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const colour = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim() : null)

/** The list and share page's summary (backend sanitizeSummary keeps the same fields). */
export function cloudSummary(data) {
  const m = data?.match || {}
  const team = (t) => ({ name: str(t?.name, 80), short: str(t?.shortName ?? t?.short_name, 12), color: colour(t?.color) })
  const finished = (Array.isArray(data?.sets) ? data.sets : [])
    .filter((s) => s && s.finished === true)
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .slice(0, 5)
    .map((s) => ({ home: Number(s.homePoints) || 0, away: Number(s.awayPoints) || 0 }))
  const setsWon = { home: finished.filter((s) => s.home > s.away).length, away: finished.filter((s) => s.away > s.home).length }
  const status = m.status === 'final' || m.approved === true ? 'final' : m.status === 'ended' ? 'ended' : m.status === 'live' ? 'live' : 'scheduled'
  return {
    home: team(data?.homeTeam),
    away: team(data?.awayTeam),
    setsWon,
    sets: finished,
    status,
    hall: str(m.hall, 120),
    league: str(m.league, 120),
    scheduledAt: str(m.scheduledAt, 40),
    gameNumber: m.gameN != null ? String(m.gameN).slice(0, 20) : null
  }
}

const offline = () => {
  try { return localStorage.getItem('offlineMode') === 'true' || (typeof navigator !== 'undefined' && navigator.onLine === false) } catch { return false }
}

async function call(path, { method = 'POST', body, fetchImpl = (...a) => fetch(...a) } = {}) {
  const url = getCloudApiUrl(path)
  if (!url || offline()) return { ok: false, reason: 'offline' }
  try {
    const res = await fetchImpl(url, {
      method,
      credentials: 'omit',
      cache: 'no-store',
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    })
    const json = await res.json().catch(() => null)
    if (!res.ok || json?.error) return { ok: false, reason: json?.error?.code || `HTTP ${res.status}`, status: res.status, retryAfter: retryAfterOf(res) }
    return { ok: true, data: json?.data ?? null }
  } catch (err) {
    return { ok: false, reason: err?.message || 'network' }
  }
}

const blobBase64 = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

const auth = (match) => ({ key: match.globalKey, pin: String(match.refereePin) })

/**
 * Save the match's readable copy (with its PDF when given). Returns
 * { ok, shareToken } and keeps the share token the server answers on the match.
 * `keepIfRefused` (the closed match's copy): a refusal for now (429, 5xx, no
 * connection) is kept and sent again later (utils/globalPending, SR-4).
 */
export async function saveGlobalCloud(data, { pdfBlob = null, fetchImpl, database = null, keepIfRefused = false } = {}) {
  const match = data?.match
  if (!savesToGlobalCloud(match)) return { ok: false, reason: 'off' }
  const body = {
    ...auth(match),
    bundle: cloudBundle(data),
    summary: cloudSummary(data),
    organizer: isOrganizerCode(match.globalOrganizer) ? match.globalOrganizer : null
  }
  if (pdfBlob) body.pdf = await blobBase64(pdfBlob)
  const r = await call('/api/global/cloud/save', { body, fetchImpl })
  if (r.ok && database && match.id != null && (r.data?.shareToken ?? null) !== (match.cloudShareToken ?? null)) {
    try { await database.matches.update(match.id, { cloudShareToken: r.data?.shareToken ?? null }) } catch { /* the next save tries again */ }
  }
  if (!r.ok && r.reason !== 'offline') console.warn('[Global cloud] Not saved:', r.reason)
  if (!r.ok && keepIfRefused && isRetryableRefusal(r.status)) {
    const kept = await keepGlobalPending({ id: `${match.globalKey}|cloud`, path: '/api/global/cloud/save', body, retryAfterSec: r.retryAfter, ...(database ? { database } : {}) })
    return { ...r, pending: kept }
  }
  return r.ok ? { ok: true, shareToken: r.data?.shareToken ?? null } : r
}

/** Share link on or off: { ok, shareToken } */
export async function setGlobalShare(match, on, { fetchImpl } = {}) {
  if (!savesToGlobalCloud(match)) return { ok: false, reason: 'off' }
  const r = await call('/api/global/cloud/share', { body: { ...auth(match), on: on === true }, fetchImpl })
  return r.ok ? { ok: true, shareToken: r.data?.shareToken ?? null } : r
}

/** Remove the cloud copy (the match stays on the device). */
export async function deleteGlobalCloud(match, { fetchImpl } = {}) {
  if (match?.global !== true || !isGlobalKey(match.globalKey)) return { ok: false, reason: 'off' }
  return call('/api/global/cloud/delete', { body: auth(match), fetchImpl })
}

/** The cloud copy for a restore on another device: { ok, data: { bundle, summary, updatedAt, shareToken } } */
export function loadGlobalCloud(key, pin, { fetchImpl } = {}) {
  if (!isGlobalKey(key)) return Promise.resolve({ ok: false, reason: 'key' })
  return call('/api/global/cloud/load', { body: { key, pin: String(pin || '') }, fetchImpl })
}

/** A shared match (public): { ok, data: { summary, updatedAt, hasPdf } } */
export const fetchSharedMatch = (token, { fetchImpl } = {}) => call(`/api/global/shared/${encodeURIComponent(token)}`, { method: 'GET', fetchImpl })
export const sharedPdfUrl = (token) => getCloudApiUrl(`/api/global/shared/${encodeURIComponent(token)}/pdf`)

/** A tournament's matches (whoever has the code): { ok, data: { matches: [...] } } */
export const fetchOrganizerMatches = (code, { fetchImpl } = {}) => call(`/api/global/organizer/${encodeURIComponent(code)}`, { method: 'GET', fetchImpl })
export const organizerPdfUrl = (code, id) => getCloudApiUrl(`/api/global/organizer/${encodeURIComponent(code)}/${encodeURIComponent(id)}/pdf`)

/** The share token or organizer code a livescore URL asks for (?s= / ?o=). */
export function cloudPageFromUrl(search = typeof window !== 'undefined' ? window.location.search : '') {
  try {
    const p = new URLSearchParams(search)
    const s = p.get('s')
    if (s && /^[A-Za-z0-9_-]{22}$/.test(s)) return { share: s }
    const o = normalizeOrganizerCode(p.get('o') || '')
    if (o) return { organizer: o }
  } catch { /* no URL */ }
  return null
}
