/**
 * Encrypts the backup files of one app session (envelope.js), cheaply enough
 * for a file per rally.
 *
 * Per match: one data key and its slots, kept while the match's PINs stay
 * the same. Per match and PIN: the PIN's key, derived ONCE per session
 * (Argon2id, about half a second on a tablet, kdf.js) with its own salt.
 * When a PIN changes (or one is added), the match gets a new data key,
 * wrapped by the PIN keys it already has plus the new one's: only the new
 * PIN is derived, and the files written from then on do not open with the
 * old PIN. warm() derives them when the match is opened, so the first file
 * (maybe the last one before the app quits) only encrypts.
 *
 * With a recovery key in the build (recovery.js), every data key is also
 * wrapped for it (the recovery slot): the strong key, kept offline by the
 * league. A key that does not import, or that this device's WebCrypto cannot
 * wrap for (ECDH, HKDF), is logged once and left out; the files still get
 * their PIN slots.
 */

import { derivePinKey } from './kdf.js'
import { newDataKey, pinKey, pinSlot, readableHeader, recoverySlot, sealText } from './envelope.js'
import { configuredRecoveryKey, importRecoveryPublicKey } from './recovery.js'

const pinValue = (v) => (v === undefined || v === null ? '' : String(v).trim())

// The first spelling that holds a PIN: a row can carry an empty local field
// beside the cloud one (gamePin: '' and game_pin: '123456')
const firstPin = (...values) => values.map(pinValue).find(Boolean) || ''

/**
 * The PINs that open a match's backups: its game PIN and its referee PIN
 * (local and cloud spellings), [] for a match with neither.
 * @param {object} match the match row WITH its PINs (before redaction)
 * @returns {{ pin: 'game'|'referee', value: string }[]}
 */
export function backupPins(match) {
  const game = firstPin(match?.gamePin, match?.game_pin)
  const referee = firstPin(match?.refereePin, match?.referee_pin, match?.connection_pins?.referee, match?.connectionPins?.referee)
  const out = []
  if (game) out.push({ pin: 'game', value: game })
  if (referee) out.push({ pin: 'referee', value: referee })
  return out
}

/**
 * @param {{ derive?: typeof derivePinKey, params?: object, recoveryKey?: string }} [options]
 *   the KDF (tests); the recovery public key (SPKI, base64; default: the build's, '' for none)
 */
export function createBackupSealer({ derive = derivePinKey, params, recoveryKey = configuredRecoveryKey() } = {}) {
  const pinKeys = new Map() // `${scope}\n${pin}\n${value}` -> Promise<{ kek, kdf }>
  const keyrings = new Map() // scope -> { signature, promise: Promise<{ dataKey, slots }> }
  let recovery = null // Promise<{ id, publicKey } | null>, imported once
  let recoveryUnusable = false // its slot failed once: left out for this session

  function recoveryOf() {
    if (!recovery) {
      recovery = recoveryKey
        ? importRecoveryPublicKey(recoveryKey).catch((e) => {
          console.error('[BackupCrypto] the recovery key of this build cannot be used, files get PIN slots only:', e?.message || e)
          return null
        })
        : Promise.resolve(null)
    }
    return recovery
  }

  // The recovery slot of a new data key, or null: never a reason to write no file
  async function recoverySlotOf(dataKey) {
    const strong = recoveryUnusable ? null : await recoveryOf()
    if (!strong) return null
    try {
      return await recoverySlot(dataKey, strong)
    } catch (e) {
      if (!recoveryUnusable) {
        recoveryUnusable = true
        console.error('[BackupCrypto] this device cannot use the recovery key of this build, files get PIN slots only:', e?.message || e)
      }
      return null
    }
  }

  // Forgotten when it fails, so the next file tries again
  function remember(map, key, promise) {
    map.set(key, promise)
    promise.catch(() => { if (map.get(key) === promise) map.delete(key) })
    return promise
  }

  function keyOf(scope, { pin, value }) {
    const id = `${scope}\n${pin}\n${value}`
    return pinKeys.get(id) || remember(pinKeys, id, pinKey(value, { derive, ...(params ? { params } : {}) }))
  }

  function keyring(scope, pins) {
    const signature = pins.map(p => `${p.pin}:${p.value}`).join('\n')
    const cached = keyrings.get(scope)
    if (cached?.signature === signature) return cached.promise
    const promise = (async () => {
      const dataKey = await newDataKey()
      const slots = []
      for (const p of pins) slots.push(await pinSlot(p.pin, dataKey, await keyOf(scope, p)))
      const strong = await recoverySlotOf(dataKey)
      if (strong) slots.push(strong)
      return { dataKey, slots }
    })()
    const entry = { signature, promise }
    keyrings.set(scope, entry)
    promise.catch(() => { if (keyrings.get(scope) === entry) keyrings.delete(scope) })
    return promise
  }

  return {
    /**
     * Derives the keys of a match's PINs ahead of its first file, writing
     * nothing (nativeBackup engine: when it first sees the match). Resolves
     * to true when the next file of these PINs only encrypts; never throws
     * (a failed derivation is tried again by the next file).
     * @param {string|number} scope the match (local id)
     * @param {object} match the match row WITH its PINs
     */
    async warm(scope, match) {
      const pins = backupPins(match)
      if (!pins.length) return false
      try {
        await keyring(scope, pins)
        return true
      } catch {
        return false
      }
    },
    /**
     * The text of one backup file: the envelope, or the plain JSON for a match
     * with no game PIN and no referee PIN (test matches, some unofficial ones:
     * nothing could open it). Throws when it cannot encrypt: a match with PINs
     * is never written in the clear.
     * @param {string|number} scope the match (local id)
     * @param {object} data the backup with the match's PINs (exportMatchData)
     * @param {string} plainText the backup file's JSON (without the PINs)
     * @param {string} lastUpdated ISO time of the file
     * @returns {Promise<{ text: string, encrypted: boolean }>}
     */
    async seal(scope, data, plainText, lastUpdated) {
      const pins = backupPins(data?.match)
      if (!pins.length) return { text: plainText, encrypted: false } // PLAIN: no PIN to open it with
      const ring = await keyring(scope, pins)
      return { text: await sealText(plainText, readableHeader(data, lastUpdated), ring), encrypted: true }
    }
  }
}
