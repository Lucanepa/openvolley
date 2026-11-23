import { getCloudApiUrl } from './backendConfig'
import { db } from '../db/db'
import { usesKeyStore } from '../domain/matchKind'

/**
 * The Global tool's server side (backend lib/globalStore.js): a match's backup
 * and its finished scoresheet, no account, no database row. The match keeps a
 * random key (`globalKey`, made when the match is created, 128 bits); the key
 * is the only way to the files, so it is also the "backup code" a scorer can
 * restore from. Everything here is best effort and never throws: courtside
 * offline is normal, the match stays on the device.
 */

/**
 * Whether a match's backups go to the cloud: every match but a test match,
 * and a Global match (stored as a test match, with its own store by its key).
 */
export const sendsCloudBackup = (match) => !!match && (match.test !== true || usesKeyStore(match))

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
    const g = usesKeyStore(m) && isGlobalKey(m.globalKey)
    globalIds.set(matchId, g)
    return g
  } catch { return false }
}
/** Known answer without a read: true | false | undefined (not asked yet). */
export const peekGlobalMatch = (matchId) => globalIds.get(matchId)
export const markGlobalMatch = (matchId, isGlobal = true) => { globalIds.set(matchId, isGlobal) }
export const forgetGlobalMatchIds = () => globalIds.clear()

/**
 * The backup file of a Global match as every other backup file is written
 * (utils/backupFile, the cloud copy's options): no PINs or session ids in the
 * clear, encrypted so the match's referee PIN (or the league's recovery key)
 * opens it; the connection PINs ride inside the encryption for a restore on
 * another device. Throws when it cannot be sealed: never stored in the clear.
 */
async function globalBackupText(matchId, backupData) {
  const [{ backupFileText }, { isEncryptedBackup }] = await Promise.all([import('./backupFile'), import('./backupCrypto/envelope')])
  const text = await backupFileText(matchId ?? backupData?.match?.id, backupData, new Date(), { keepConnectionPins: true })
  // a match with no PIN gets a plain file (names, birth dates in the clear):
  // the Global store keeps only an encrypted one (backend lib/globalStore.js)
  let sealed = false
  try { sealed = isEncryptedBackup(JSON.parse(text)) } catch { /* not JSON */ }
  if (!sealed) throw new Error('the match has no PIN to encrypt its backup')
  return text
}

/**
 * A backup read by its code, as Restore match takes it back: only a match
 * that keeps its files in this store (domain/matchKind usesKeyStore), a
 * Global match or a guest match (the Swiss "New match" signed out), each
 * kept as the kind it is (audit LOG-07: a guest backup was stored but never
 * restored). A real match that stays local (isLocalOnly: the sync queue and
 * the restore never send it to the league's server). A backup made before
 * 2026-11-17 holds test: true, dropped here. null for anything else: a code
 * that holds an official match, or a file someone with the code replaced, is
 * not restored into this device's official matches.
 */
export function globalRestoreData(data) {
  if (!data || typeof data !== 'object' || !data.match || !usesKeyStore(data.match)) return null
  const kind = data.match.global === true ? { global: true } : { guest: true }
  return { ...data, match: { ...data.match, ...kind, test: false } }
}

/**
 * A Global match made before 2026-11-17 was stored test-flagged, so its
 * tablets, livescore and TV took it for practice. It is a real match that
 * stays local (domain/matchKind): the flag goes. Returns how many changed.
 */
export async function upgradeGlobalMatches(database) {
  return database.matches.filter(m => m?.global === true && m.test === true).modify({ test: false })
}

/** The every-action / set-end backup of a Global match (the newest copy replaces the last). */
export async function uploadGlobalBackup(backupData, matchId = null) {
  const m = backupData?.match
  if (!usesKeyStore(m) || !isGlobalKey(m.globalKey)) return null
  let text
  try {
    text = await globalBackupText(matchId, backupData)
  } catch (err) {
    console.warn('[Global] Backup not sealed, not stored:', err?.message)
    return null
  }
  const r = await saveGlobal(m.globalKey, 'backup', text, 'application/json')
  if (!r.ok && r.reason !== 'offline') console.warn('[Global] Backup not stored:', r.reason)
  // "Save in the cloud" on: the readable copy too (utils/globalCloudDb), not awaited
  saveCloudCopy(backupData, matchId)
  return r.ok ? `global/${m.globalKey}/backup` : null
}

/** The opt-in readable copy in the database (utils/globalCloudDb), best effort. */
function saveCloudCopy(backupData, matchId, pdfBlob = null) {
  const m = backupData?.match
  if (m?.global !== true || m.cloud !== true) return Promise.resolve(null)
  const data = matchId != null && m.id == null ? { ...backupData, match: { ...m, id: matchId } } : backupData
  return import('./globalCloudDb')
    .then(({ saveGlobalCloud }) => saveGlobalCloud(data, { pdfBlob, database: db }))
    .catch(() => null)
}

/** The closed match: its PDF and its final backup, retried a few times (never queued: nothing of a Global match goes through the sync queue). */
export async function uploadGlobalFinal({ match, matchId = null, pdfBlob, backupData }, { retries = 3, waitMs = 4000 } = {}) {
  if (!usesKeyStore(match) || !isGlobalKey(match.globalKey)) return { ok: false, reason: 'not-global' }
  const jobs = []
  let allOk = true
  if (pdfBlob) jobs.push(['scoresheet-final', pdfBlob, 'application/pdf'])
  if (backupData) {
    try {
      jobs.push(['backup', await globalBackupText(matchId ?? match.id, backupData), 'application/json'])
    } catch (err) {
      console.warn('[Global] Final backup not sealed, not stored:', err?.message)
      allOk = false
    }
  }
  allOk = allOk && jobs.length > 0
  // the cloud copy with the final PDF (not part of allOk: the store above is the scorer's safety net)
  if (backupData) saveCloudCopy(backupData, matchId ?? match.id, pdfBlob)
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
