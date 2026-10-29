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
 * old PIN.
 */

import { derivePinKey } from './kdf'
import { newDataKey, pinKey, pinSlot, readableHeader, sealText } from './envelope'

const pinValue = (v) => (v === undefined || v === null ? '' : String(v).trim())

/**
 * The PINs that open a match's backups: its game PIN and its referee PIN
 * (local and cloud spellings), [] for a match with neither.
 * @param {object} match the match row WITH its PINs (before redaction)
 * @returns {{ pin: 'game'|'referee', value: string }[]}
 */
export function backupPins(match) {
  const game = pinValue(match?.gamePin ?? match?.game_pin)
  const referee = pinValue(match?.refereePin ?? match?.referee_pin ?? match?.connection_pins?.referee ?? match?.connectionPins?.referee)
  const out = []
  if (game) out.push({ pin: 'game', value: game })
  if (referee) out.push({ pin: 'referee', value: referee })
  return out
}

/**
 * @param {{ derive?: typeof derivePinKey, params?: object }} [options] the KDF (tests)
 */
export function createBackupSealer({ derive = derivePinKey, params } = {}) {
  const pinKeys = new Map() // `${scope}\n${pin}\n${value}` -> Promise<{ kek, kdf }>
  const keyrings = new Map() // scope -> { signature, promise: Promise<{ dataKey, slots }> }

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
      return { dataKey, slots }
    })()
    const entry = { signature, promise }
    keyrings.set(scope, entry)
    promise.catch(() => { if (keyrings.get(scope) === entry) keyrings.delete(scope) })
    return promise
  }

  return {
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
