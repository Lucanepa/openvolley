/**
 * The encrypted backup file ("envelope"): every match backup file the app
 * writes (the app backup files, the USB copy, the browser's folder and
 * downloads, the set-end download and the cloud copy: utils/backupFile).
 *
 *   {
 *     "format": "openvolley-encrypted-backup", "formatVersion": 2,
 *     "about": "…",                                   what the file is, for a person
 *     "readable": { gameN, homeTeam, awayTeam, scheduledAt,
 *                   sets: [{ index, home, away }], lastUpdated },
 *     "cipher": { "alg": "AES-256-GCM", "iv": b64 },
 *     "slots": [ { "kind": "pin", "pin": "game" | "referee",
 *                  "kdf": { alg: "argon2id", memoryKiB, iterations, parallelism, salt: b64 },
 *                  "iv": b64, "wrappedKey": b64 },
 *                { "kind": "recovery", "key": key id, "alg": RECOVERY_ALG,
 *                  "epk": b64, "iv": b64, "wrappedKey": b64 } ],
 *     "ciphertext": b64                                the backup file's own JSON
 *   }
 *
 * One random AES-256-GCM data key per match encrypts the backup JSON (a fresh
 * IV per file). Each slot holds that key wrapped (AES-GCM):
 *  - a PIN slot by a key derived from one PIN (kdf.js), so either PIN alone
 *    opens the file. A 6-digit PIN is a speed bump only;
 *  - the recovery slot by a key agreed (ECDH P-256, HKDF-SHA-256) between a
 *    one-off key of the file and the recovery public key of the build
 *    (recovery.js). Its private half is kept offline: no PIN guessing opens
 *    it, and the recovery tool (scripts/backup-recovery.mjs) opens any file.
 * A reader skips slot kinds it does not know.
 *
 * Authenticated (version 2): each slot's wrap has the slot's own fields
 * (kind, label, KDF parameters and salt, or key id and one-off key) as its
 * additional data, so a slot whose label or parameters were edited opens
 * with no PIN (the restore never takes the game PIN for the referee PIN);
 * the ciphertext's additional data is the format, the readable header and
 * every slot, so an edited header or slot list no longer opens. Version 1
 * files (written by 3.0.9 to 3.1.4: the readable header only, wraps without
 * additional data) still open.
 *
 * `readable` is public anyway on the livescore: what a file list shows before
 * the file is opened. Everything else (names, birth dates, officials,
 * signatures, the events) is in the ciphertext, and the file never holds its
 * own key: the backup JSON has no PINs (nativeBackup/redact).
 *
 * The envelope has no `version`, `match`, `matches`, `sets` or `events` at the
 * top: an app from before it says "not a match backup" instead of restoring
 * half of it.
 */

import { checkKdfParams, derivePinKey, KDF_PARAMS, SALT_BYTES } from './kdf.js'

export const ENVELOPE_FORMAT = 'openvolley-encrypted-backup'
export const ENVELOPE_VERSION = 2
// The versions this app opens: 1 (slots not authenticated) and 2
const OPENS_VERSIONS = [1, 2]
const ABOUT = 'OpenVolley match backup, encrypted. Restore it in OpenVolley (Restore match, Restore from a backup file) with the game PIN or the referee PIN of the match.'
const AES = 'AES-256-GCM'
// The recovery slot: ECDH P-256 between the file's one-off key and the
// recovery public key, HKDF-SHA-256 over the shared secret, AES-256-GCM wrap
export const RECOVERY_ALG = 'ECDH-P256+HKDF-SHA256+A256GCM'
const RECOVERY_INFO = 'openvolley-backup-recovery-v2'

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
// make a restore derive for long: the first ones are tried, the rest ignored
// (with the KDF cap of kdf.js: at most 4 x twice the app's derivation)
export const MAX_PIN_SLOTS = 4

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

// The ciphertext's additional data as written (JSON.parse + JSON.stringify
// gives the same text back): version 1 the format and the readable header,
// version 2 also every slot
const headerBytes = (format, formatVersion, readable, slots) => utf8(JSON.stringify(
  formatVersion === 1 ? { format, formatVersion, readable } : { format, formatVersion, readable, slots }
))

// A slot without its wrapped key: what the wrap authenticates (version 2)
const slotFields = (slot) => (slot?.kind === 'recovery'
  ? { kind: slot.kind, key: slot.key, alg: slot.alg, epk: slot.epk }
  : { kind: slot?.kind, pin: slot?.pin, kdf: slot?.kdf })

// The wrap's additional data of a slot; none in version 1
const slotAad = (formatVersion, slot) => (formatVersion === 1
  ? {}
  : { additionalData: utf8(JSON.stringify({ format: ENVELOPE_FORMAT, formatVersion, slot: slotFields(slot) })) })

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

/** A PIN slot: the data key wrapped by that PIN's key, bound to the slot's label and KDF. */
export async function pinSlot(pin, dataKey, { kek, kdf }) {
  const iv = randomBytes(12)
  const fields = { kind: 'pin', pin, kdf }
  const wrapped = await subtle().wrapKey('raw', dataKey, kek, { name: 'AES-GCM', iv, ...slotAad(ENVELOPE_VERSION, fields) })
  return { ...fields, iv: toBase64(iv), wrappedKey: toBase64(new Uint8Array(wrapped)) }
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' }

// The key-wrapping key of a recovery slot: HKDF over the ECDH secret, the
// one-off public key as salt
async function recoveryKek(privateKey, publicKey, epkBytes) {
  const s = subtle()
  const secret = await s.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256)
  const ikm = await s.importKey('raw', secret, 'HKDF', false, ['deriveKey'])
  return s.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: epkBytes, info: utf8(RECOVERY_INFO) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']
  )
}

/**
 * The recovery slot: the data key wrapped for the recovery public key
 * (recovery.js importRecoveryPublicKey), with a one-off key pair of its own.
 * @param {CryptoKey} dataKey
 * @param {{ id: string, publicKey: CryptoKey }} recovery
 */
export async function recoverySlot(dataKey, { id, publicKey }) {
  const s = subtle()
  const oneOff = await s.generateKey(ECDH, true, ['deriveBits'])
  const epkBytes = new Uint8Array(await s.exportKey('raw', oneOff.publicKey))
  const kek = await recoveryKek(oneOff.privateKey, publicKey, epkBytes)
  const iv = randomBytes(12)
  const fields = { kind: 'recovery', key: id, alg: RECOVERY_ALG, epk: toBase64(epkBytes) }
  const wrapped = await s.wrapKey('raw', dataKey, kek, { name: 'AES-GCM', iv, ...slotAad(ENVELOPE_VERSION, fields) })
  return { ...fields, iv: toBase64(iv), wrappedKey: toBase64(new Uint8Array(wrapped)) }
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
  const additionalData = headerBytes(ENVELOPE_FORMAT, ENVELOPE_VERSION, readable, slots)
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

async function unwrapWith(slot, pin, derive, formatVersion) {
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
    return await subtle().unwrapKey('raw', fromBase64(slot.wrappedKey), kek, { name: 'AES-GCM', iv: fromBase64(slot.iv), ...slotAad(formatVersion, slot) }, { name: 'AES-GCM' }, false, ['decrypt'])
  } catch {
    return null // not this slot's PIN, or the slot was edited
  }
}

function checkFormat(envelope) {
  if (!isEncryptedBackup(envelope)) throw fail(BACKUP_DAMAGED, 'Not an encrypted backup')
  if (!OPENS_VERSIONS.includes(envelope.formatVersion) || envelope.cipher?.alg !== AES) {
    throw fail(BACKUP_NEWER, 'This backup was written by a newer version of OpenVolley')
  }
  subtle()
}

// The backup inside, with the data key one slot gave
async function decryptWith(envelope, dataKey) {
  let text
  try {
    const additionalData = headerBytes(envelope.format, envelope.formatVersion, envelope.readable, envelope.slots)
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.cipher.iv), additionalData }, dataKey, fromBase64(envelope.ciphertext))
    text = new TextDecoder().decode(plain)
  } catch {
    throw fail(BACKUP_DAMAGED, 'The backup file is damaged')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw fail(BACKUP_DAMAGED, 'The backup file is damaged')
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
  checkFormat(envelope)
  const typed = String(pin ?? '').trim()
  const slots = (Array.isArray(envelope.slots) ? envelope.slots : []).filter(s => s?.kind === 'pin').slice(0, MAX_PIN_SLOTS)
  let dataKey = null
  let opened = null
  if (typed) {
    for (const { pin: kind, field } of PIN_SLOTS) {
      for (const slot of slots.filter(s => s.pin === kind)) {
        stopIfAborted(signal)
        dataKey = await unwrapWith(slot, typed, derive, envelope.formatVersion)
        if (dataKey) { opened = { pin: kind, field, value: typed }; break }
      }
      if (dataKey) break
    }
  }
  stopIfAborted(signal)
  if (!dataKey) throw fail(BACKUP_WRONG_PIN, 'Wrong PIN: neither the game PIN nor the referee PIN of this match')
  return { data: await decryptWith(envelope, dataKey), unlockedWith: opened }
}

/**
 * Opens an encrypted backup with the recovery private key (the recovery
 * tool, scripts/backup-recovery.mjs; never on a scoring device). Throws
 * BACKUP_WRONG_PIN when the file has no recovery slot this key opens
 * (a version 1 file, a build without a recovery key, another key),
 * BACKUP_DAMAGED / BACKUP_NEWER as openEnvelope.
 * @param {object} envelope parsed envelope
 * @param {{ id?: string, privateKey: CryptoKey }} recovery recovery.js importRecoveryPrivateKey
 * @returns {Promise<{ data: object, unlockedWith: { recovery: string } }>}
 */
export async function openEnvelopeWithRecoveryKey(envelope, { id, privateKey }) {
  checkFormat(envelope)
  const slots = (Array.isArray(envelope.slots) ? envelope.slots : [])
    .filter(s => s?.kind === 'recovery' && s.alg === RECOVERY_ALG && (!id || s.key === id))
  if (envelope.formatVersion !== 1) {
    for (const slot of slots) {
      try {
        const epkBytes = fromBase64(slot.epk)
        const epk = await subtle().importKey('raw', epkBytes, ECDH, false, [])
        const kek = await recoveryKek(privateKey, epk, epkBytes)
        const dataKey = await subtle().unwrapKey('raw', fromBase64(slot.wrappedKey), kek, { name: 'AES-GCM', iv: fromBase64(slot.iv), ...slotAad(envelope.formatVersion, slot) }, { name: 'AES-GCM' }, false, ['decrypt'])
        return { data: await decryptWith(envelope, dataKey), unlockedWith: { recovery: slot.key } }
      } catch (e) {
        if (e?.code === BACKUP_DAMAGED) throw e
        // not this key's slot, or an edited one: the next
      }
    }
  }
  throw fail(BACKUP_WRONG_PIN, 'This backup has no recovery slot this key opens')
}
