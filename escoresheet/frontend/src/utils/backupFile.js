/**
 * The one way a match backup file is written, whatever it goes to: the app
 * backup files (nativeBackup engine), the browser's folder and downloads, the
 * set-end download, the cloud copy and the USB stick copy. Every one is the
 * app backup format: no PINs or session ids inside (nativeBackup/redact),
 * encrypted so the game PIN, the referee PIN or the league's recovery key
 * opens it (backupCrypto); a match with neither PIN (a test match) stays
 * plain. Such a file may end up on a USB stick, in a shared Downloads folder
 * or in the cloud, so the PINs and player data are never left in the clear.
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

/**
 * The text of a backup file of `data` (exportMatchData's shape, WITH the
 * match's PINs: they choose the key, and are left out of the file). Throws
 * when a match with PINs cannot be encrypted: it is never written in the
 * clear.
 * @param {string|number} matchId the match (local id): its keys are kept per match
 * @param {object} data
 * @param {Date} [at] the time the file is written (its lastUpdated)
 */
export async function backupFileText(matchId, data, at = new Date()) {
  const [{ serializeBackup }, sealer] = await Promise.all([
    import('./nativeBackup/engine'),
    sessionSealer()
  ])
  const iso = at.toISOString()
  const { build } = serializeBackup(data)
  const { text } = await sealer.seal(matchId, data, build(iso), iso)
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
