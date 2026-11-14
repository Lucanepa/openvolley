/**
 * The one way a match backup file is written, whatever it goes to: the app
 * backup files (nativeBackup engine), the browser's folder and downloads, the
 * set-end download, the cloud copy and the USB stick copy. Every one is the
 * app backup format: no PINs or session ids inside (nativeBackup/redact),
 * encrypted so the game PIN, the referee PIN or the league's recovery key
 * opens it (backupCrypto); a match with neither PIN (a test match) stays
 * plain. Such a file may end up on a USB stick, in a shared Downloads folder
 * or in the cloud, so the PINs and player data are never left in the clear.
 * The cloud copy alone also carries the referee, bench and upload PINs, inside
 * the encryption (keepConnectionPins below).
 *
 * One sealer per app session: each PIN is derived once per match, whichever
 * of these writes first.
 */

let sealerPromise = null

/** The app session's sealer (backupCrypto/sealer). */
export function sessionSealer() {
  if (!sealerPromise) {
    sealerPromise = import('./backupCrypto/sealer').then(({ createBackupSealer }) => createBackupSealer())
  }
  return sealerPromise
}

/** The file's own block of connection PINs (backupFileText keepConnectionPins). */
export const CARRIED_PINS = 'connectionPins'

// The referee, bench and upload PINs of a match row (connection_pins
// spelling), never its game PIN or session ids
function connectionPinsOf(match, buildConnectionPins) {
  const cloud = match?.connection_pins || match?.connectionPins || {}
  const out = {}
  for (const key of ['referee', 'bench_home', 'bench_away', 'upload_home', 'upload_away']) {
    const value = cloud[key] == null ? '' : String(cloud[key]).trim()
    if (value) out[key] = value
  }
  return { ...out, ...buildConnectionPins(match) }
}

/**
 * The text of a backup file of `data` (exportMatchData's shape, WITH the
 * match's PINs: they choose the key, and are left out of the file). Throws
 * when a match with PINs cannot be encrypted: it is never written in the
 * clear.
 *
 * keepConnectionPins (the cloud copy): the referee, bench and upload PINs go
 * into the file as its own block (CARRIED_PINS), inside the encryption only,
 * never in a plain file; never the game PIN or session ids. The cloud copy
 * is restored on another device when the scoring device fails: with them the
 * restore sends the server the PINs the referee and bench tablets hold
 * (backupManager.pinsForRestore), not new ones that would lock those tablets
 * out in the middle of the match.
 * @param {string|number} matchId the match (local id): its keys are kept per match
 * @param {object} data
 * @param {Date} [at] the time the file is written (its lastUpdated)
 * @param {{ keepConnectionPins?: boolean }} [options]
 */
export async function backupFileText(matchId, data, at = new Date(), { keepConnectionPins = false } = {}) {
  const [{ serializeBackup }, { backupPins }, { buildConnectionPins }, sealer] = await Promise.all([
    import('./nativeBackup/engine'),
    import('./backupCrypto/sealer'),
    import('./connectionPins'),
    sessionSealer()
  ])
  const iso = at.toISOString()
  // Only where a PIN encrypts the file (backupPins: the sealer's own rule)
  const carried = keepConnectionPins && backupPins(data?.match).length ? connectionPinsOf(data.match, buildConnectionPins) : {}
  const withPins = Object.keys(carried).length ? { ...data, [CARRIED_PINS]: carried } : null
  const { text, encrypted } = await sealer.seal(matchId, data, serializeBackup(withPins || data).build(iso), iso)
  if (withPins && !encrypted) {
    // never: the same rule chose both. A plain file never carries the PINs
    return (await sealer.seal(matchId, data, serializeBackup(data).build(iso), iso)).text
  }
  return text
}

// The PIN keys a list of backups shares (one session's files have one salt):
// derived once, not once per file
const derived = new Map()
const DERIVED_KEEP = 16
function derivedOnce(derivePinKey) {
  return (pin, salt, params) => {
    const id = `${pin}\n${Array.from(salt).join(',')}\n${JSON.stringify(params)}`
    if (!derived.has(id)) {
      const promise = derivePinKey(pin, salt, params)
      promise.catch(() => { if (derived.get(id) === promise) derived.delete(id) })
      derived.set(id, promise)
      if (derived.size > DERIVED_KEEP) derived.delete(derived.keys().next().value)
    }
    return derived.get(id)
  }
}

/**
 * A backup file read for a restore or a list: an encrypted one is opened with
 * the first of `pins` that opens it (the game PIN typed to list the cloud
 * backups, the open match's PINs), and comes back as the backup inside with
 * `unlockedWith`, like the PIN dialog's. Any other file, and an encrypted one
 * none of the PINs opens, comes back as it is: the PIN dialog asks
 * (hooks/useBackupUnlock). A damaged file throws.
 * @param {object} file parsed backup file
 * @param {Array<string|number|null|undefined>} pins
 */
export async function openWithKnownPins(file, pins = []) {
  const { isEncryptedBackup, openEnvelope, BACKUP_WRONG_PIN } = await import('./backupCrypto/envelope')
  if (!isEncryptedBackup(file)) return file
  const tries = [...new Set((pins || []).map(p => (p == null ? '' : String(p).trim())).filter(Boolean))]
  if (!tries.length) return file
  const { derivePinKey } = await import('./backupCrypto/kdf')
  const derive = derivedOnce(derivePinKey)
  for (const pin of tries) {
    try {
      const { data, unlockedWith } = await openEnvelope(file, pin, { derive })
      return { ...data, unlockedWith }
    } catch (e) {
      if (e?.code !== BACKUP_WRONG_PIN) throw e
    }
  }
  return file
}
