import { getCloudApiUrl } from './backendConfig'
import { db } from '../db/db'

/**
 * The Global tool's server side (backend lib/globalStore.js): a match's backup
 * and its finished scoresheet, no account, no database row. The match keeps a
 * random key (`globalKey`, made when the match is created, 128 bits); the key
 * is the only way to the files, so it is also the "backup code" a scorer can
 * restore from. Everything here is best effort and never throws: courtside
 * offline is normal, the match stays on the device.
 */

/** 22 base64url characters = 128 random bits. */
export function newGlobalKey() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const isGlobalKey = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(k)

const toBase64 = async (body) => {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(await body.arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

const offline = () => {
  try { return localStorage.getItem('offlineMode') === 'true' || (typeof navigator !== 'undefined' && navigator.onLine === false) } catch { return false }
}

async function post(action, payload) {
  const url = getCloudApiUrl(`/api/global/${action}`)
  if (!url || offline()) return { ok: false, reason: 'offline' }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    const json = await res.json().catch(() => null)
    if (!res.ok || json?.error) return { ok: false, reason: json?.error?.code || `HTTP ${res.status}`, permanent: res.status >= 400 && res.status < 500 && res.status !== 429 }
    return { ok: true, data: json?.data ?? null }
  } catch (err) {
    return { ok: false, reason: err?.message || 'network' }
  }
}

/** Store a file ('backup' JSON string, 'scoresheet' / 'scoresheet-final' PDF blob). */
export async function saveGlobal(key, kind, body, contentType) {
  if (!isGlobalKey(key)) return { ok: false, reason: 'key' }
  return post('save', { key, kind, contentType, fileBase64: await toBase64(body) })
}

/** The stored file as text (backup) or a Blob (PDF), or null when there is none. */
export async function loadGlobal(key, kind) {
  if (!isGlobalKey(key)) return null
  const r = await post('load', { key, kind })
  if (!r.ok || !r.data?.fileBase64) return null
  const bin = atob(r.data.fileBase64)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return kind === 'backup' ? new TextDecoder().decode(bytes) : new Blob([bytes], { type: r.data.contentType })
}

/** Is this match a Global match? (cached: the continuous backup asks on every action) */
const globalIds = new Map()
export async function isGlobalMatchId(matchId) {
  if (matchId == null) return false
  if (globalIds.has(matchId)) return globalIds.get(matchId)
  try {
    const m = await db.matches.get(matchId)
    const g = m?.global === true && isGlobalKey(m.globalKey)
    globalIds.set(matchId, g)
    return g
  } catch { return false }
}
/** Known answer without a read: true | false | undefined (not asked yet). */
export const peekGlobalMatch = (matchId) => globalIds.get(matchId)
export const markGlobalMatch = (matchId, isGlobal = true) => { globalIds.set(matchId, isGlobal) }
export const forgetGlobalMatchIds = () => globalIds.clear()

/** The every-action / set-end backup of a Global match (the newest copy replaces the last). */
export async function uploadGlobalBackup(backupData) {
  const m = backupData?.match
  if (m?.global !== true || !isGlobalKey(m.globalKey)) return null
  const r = await saveGlobal(m.globalKey, 'backup', JSON.stringify(backupData), 'application/json')
  if (!r.ok && r.reason !== 'offline') console.warn('[Global] Backup not stored:', r.reason)
  return r.ok ? `global/${m.globalKey}/backup` : null
}

/** The closed match: its PDF and its final backup, retried a few times (never queued: nothing of a Global match goes through the sync queue). */
export async function uploadGlobalFinal({ match, pdfBlob, backupData }, { retries = 3, waitMs = 4000 } = {}) {
  if (match?.global !== true || !isGlobalKey(match.globalKey)) return { ok: false, reason: 'not-global' }
  const jobs = []
  if (pdfBlob) jobs.push(['scoresheet-final', pdfBlob, 'application/pdf'])
  if (backupData) jobs.push(['backup', JSON.stringify(backupData), 'application/json'])
  let allOk = jobs.length > 0
  for (const [kind, body, type] of jobs) {
    let r
    for (let i = 0; i <= retries; i++) {
      r = await saveGlobal(match.globalKey, kind, body, type)
      if (r.ok || r.permanent || r.reason === 'offline') break
      if (i < retries) await new Promise((res) => setTimeout(res, waitMs * (i + 1)))
    }
    if (!r.ok) allOk = false
  }
  return { ok: allOk }
}
