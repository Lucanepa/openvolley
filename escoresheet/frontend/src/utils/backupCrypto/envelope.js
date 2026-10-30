/**
 * The encrypted backup file ("envelope"): the app backup files (nativeBackup)
 * today, the USB copy, the cloud backups and the downloads of later phases.
 *
 *   {
 *     "format": "openvolley-encrypted-backup", "formatVersion": 1,
 *     "about": "…",                                   what the file is, for a person
 *     "readable": { gameN, homeTeam, awayTeam, scheduledAt,
 *                   sets: [{ index, home, away }], lastUpdated },
 *     "cipher": { "alg": "AES-256-GCM", "iv": b64 },
 *     "slots": [ { "kind": "pin", "pin": "game" | "referee",
 *                  "kdf": { alg: "argon2id", memoryKiB, iterations, parallelism, salt: b64 },
 *                  "iv": b64, "wrappedKey": b64 }, … ],
 *     "ciphertext": b64                                the backup file's own JSON
 *   }
 *
 * One random AES-256-GCM data key per match encrypts the backup JSON (a fresh
 * IV per file). Each slot holds that key wrapped (AES-GCM) by a key derived
 * from one PIN (kdf.js), so either PIN alone opens the file. A reader skips
 * slot kinds it does not know: a later { kind: 'recovery', … } (a server key)
 * is added beside the PIN slots without touching them.
 *
 * `readable` is public anyway on the livescore: what a file list shows before
 * the file is opened. It is the GCM additional data of the ciphertext, so an
 * edited header no longer opens. Everything else (names, birth dates,
 * officials, signatures, the events) is in the ciphertext, and the file never
 * holds its own key: the backup JSON has no PINs (nativeBackup/redact).
 *
 * The envelope has no `version`, `match`, `matches`, `sets` or `events` at the
 * top: an app from before it says "not a match backup" instead of restoring
 * half of it.
 */

import { checkKdfParams, derivePinKey, KDF_PARAMS, SALT_BYTES } from './kdf'

export const ENVELOPE_FORMAT = 'openvolley-encrypted-backup'
export const ENVELOPE_VERSION = 1
const ABOUT = 'OpenVolley match backup, encrypted. Restore it in OpenVolley (Restore match, Restore from a backup file) with the game PIN or the referee PIN of the match.'
const AES = 'AES-256-GCM'

// The errors the restore dialogs tell apart (BackupUnlockDialog)
export const BACKUP_WRONG_PIN = 'OV_BACKUP_WRONG_PIN'
export const BACKUP_DAMAGED = 'OV_BACKUP_DAMAGED' // the PIN was right, the content is not
export const BACKUP_NEWER = 'OV_BACKUP_NEWER' // a format this app does not know yet
export const BACKUP_NO_CRYPTO = 'OV_BACKUP_NO_CRYPTO' // no WebCrypto (a page on plain http)

// The PIN slots, in the order a restore tries them, and the match field each
// one's PIN restores into (backupManager.pinsForRestore)
export const PIN_SLOTS = [
  { pin: 'game', field: 'gamePin' },
  { pin: 'referee', field: 'refereePin' }
]

// A file has one slot per PIN (two); a crafted one with hundreds must not
// make a restore derive for minutes: the first ones are tried, the rest ignored
export const MAX_PIN_SLOTS = 8

const fail = (code, message) => Object.assign(new Error(message), { code })

function stopIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' })
}

function subtle() {
  const s = globalThis.crypto?.subtle
  if (!s) throw fail(BACKUP_NO_CRYPTO, 'This device cannot encrypt or open encrypted backups (no secure context)')
  return s
}

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))

/* ── base64 (a 1 MB match: chunks, never one huge argument list) ────── */

export function toBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64()
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(text) {
  if (typeof text !== 'string') throw new Error('Not base64')
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text)
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

const utf8 = (text) => new TextEncoder().encode(text)

/* ── the header ─────────────────────────────────────────────────────── */

/** True for an encrypted backup file (parsed JSON). */
export function isEncryptedBackup(json) {
  return !!json && typeof json === 'object' && json.format === ENVELOPE_FORMAT
}

/**
 * The readable part of a backup's envelope: game number, team names,
 * scheduled date, set scores and the time it was written. Nothing else.
 * @param {object} data a backup (exportMatchData's shape)
 * @param {string} [lastUpdated] ISO time the file is written
 */
export function readableHeader(data, lastUpdated) {
  const m = data?.match || {}
  const sets = (Array.isArray(data?.sets) ? data.sets : [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map(s => ({ index: s.index ?? null, home: s.homePoints ?? s.home_points ?? 0, away: s.awayPoints ?? s.away_points ?? 0 }))
  return {
    gameN: m.gameN ?? m.game_n ?? null,
    homeTeam: data?.homeTeam?.name ?? null,
    awayTeam: data?.awayTeam?.name ?? null,
    scheduledAt: m.scheduledAt ?? m.scheduled_at ?? null,
    sets,
    lastUpdated: lastUpdated ?? data?.lastUpdated ?? null
  }
}

// The ciphertext's additional data: the format and the readable header as
// written (JSON.parse + JSON.stringify gives the same text back)
const headerBytes = (format, formatVersion, readable) => utf8(JSON.stringify({ format, formatVersion, readable }))

/* ── keys and slots ─────────────────────────────────────────────────── */

/** A new data key (extractable: it is wrapped into the slots). */
export function newDataKey() {
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

/**
 * The key-wrapping key of one PIN with a new salt (or the given one).
 * @returns {Promise<{ kek: CryptoKey, kdf: object }>} kdf as the slot stores it
 */
export async function pinKey(pin, { salt = randomBytes(SALT_BYTES), params = KDF_PARAMS, derive = derivePinKey } = {}) {
  const checked = checkKdfParams(params)
  const raw = await derive(String(pin), salt, checked)
  const kek = await subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['wrapKey', 'unwrapKey'])
  return { kek, kdf: { ...checked, salt: toBase64(salt) } }
}

/** A PIN slot: the data key wrapped by that PIN's key. */
export async function pinSlot(pin, dataKey, { kek, kdf }) {
  const iv = randomBytes(12)
  const wrapped = await subtle().wrapKey('raw', dataKey, kek, { name: 'AES-GCM', iv })
  return { kind: 'pin', pin, kdf, iv: toBase64(iv), wrappedKey: toBase64(new Uint8Array(wrapped)) }
}

/* ── seal / open ────────────────────────────────────────────────────── */

/**
 * The envelope text of a backup.
 * @param {string} plainText the backup file's JSON
 * @param {object} readable readableHeader()
 * @param {{ dataKey: CryptoKey, slots: object[] }} keyring
 */
export async function sealText(plainText, readable, { dataKey, slots }) {
  const iv = randomBytes(12)
  const additionalData = headerBytes(ENVELOPE_FORMAT, ENVELOPE_VERSION, readable)
  const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData }, dataKey, utf8(plainText))
  return JSON.stringify({
    format: ENVELOPE_FORMAT,
    formatVersion: ENVELOPE_VERSION,
    about: ABOUT,
    readable,
    cipher: { alg: AES, iv: toBase64(iv) },
    slots,
    ciphertext: toBase64(new Uint8Array(ciphertext))
  })
}

async function unwrapWith(slot, pin, derive) {
  let salt
  let params
  try {
    salt = fromBase64(slot.kdf?.salt)
    params = checkKdfParams(slot.kdf)
    if (salt.length < 8 || salt.length > 64) throw new Error('Bad salt')
  } catch {
    return null // a slot this app cannot use
  }
  // a failing derivation (out of memory) is an error, not a wrong PIN
  const { kek } = await pinKey(pin, { salt, params, derive })
  try {
    return await subtle().unwrapKey('raw', fromBase64(slot.wrappedKey), kek, { name: 'AES-GCM', iv: fromBase64(slot.iv) }, { name: 'AES-GCM' }, false, ['decrypt'])
  } catch {
    return null // not this slot's PIN
  }
}

/**
 * Opens an encrypted backup with a PIN (the game PIN or the referee PIN).
 * Throws BACKUP_WRONG_PIN when no slot takes it, BACKUP_DAMAGED when one does
 * but the content does not decrypt or parse, BACKUP_NEWER for a format this
 * app does not know. Tries the first MAX_PIN_SLOTS PIN slots of the file;
 * an aborted signal (the scorer cancelled) stops it before the next slot.
 * @param {object} envelope parsed envelope
 * @param {string} pin
 * @param {{ derive?: typeof derivePinKey, signal?: AbortSignal }} [options]
 * @returns {Promise<{ data: object, unlockedWith: { pin: 'game'|'referee', field: string, value: string } }>}
 */
export async function openEnvelope(envelope, pin, { derive = derivePinKey, signal } = {}) {
  if (!isEncryptedBackup(envelope)) throw fail(BACKUP_DAMAGED, 'Not an encrypted backup')
  if (envelope.formatVersion !== ENVELOPE_VERSION || envelope.cipher?.alg !== AES) {
    throw fail(BACKUP_NEWER, 'This backup was written by a newer version of OpenVolley')
  }
  subtle()
  const typed = String(pin ?? '').trim()
  const slots = (Array.isArray(envelope.slots) ? envelope.slots : []).filter(s => s?.kind === 'pin').slice(0, MAX_PIN_SLOTS)
  let dataKey = null
  let opened = null
  if (typed) {
    for (const { pin: kind, field } of PIN_SLOTS) {
      for (const slot of slots.filter(s => s.pin === kind)) {
        stopIfAborted(signal)
        dataKey = await unwrapWith(slot, typed, derive)
        if (dataKey) { opened = { pin: kind, field, value: typed }; break }
      }
      if (dataKey) break
    }
  }
  stopIfAborted(signal)
  if (!dataKey) throw fail(BACKUP_WRONG_PIN, 'Wrong PIN: neither the game PIN nor the referee PIN of this match')

  let text
  try {
    const additionalData = headerBytes(envelope.format, envelope.formatVersion, envelope.readable)
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.cipher.iv), additionalData }, dataKey, fromBase64(envelope.ciphertext))
    text = new TextDecoder().decode(plain)
  } catch {
    throw fail(BACKUP_DAMAGED, 'The backup file is damaged')
  }
  try {
    return { data: JSON.parse(text), unlockedWith: opened }
  } catch {
    throw fail(BACKUP_DAMAGED, 'The backup file is damaged')
  }
}
