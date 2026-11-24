import { useCallback, useEffect, useRef, useState } from 'react'
import BackupUnlockDialog from '../components/BackupUnlockDialog'
import { isEncryptedBackup } from '../utils/backupCrypto/envelope'

/**
 * Opens a picked backup file that is encrypted (the app's backup files of a
 * match with a PIN, utils/backupCrypto): `await unlock(file)` shows the PIN
 * dialog and resolves to the backup inside, with `unlockedWith` (the PIN
 * that opened it, which the restore keeps on the match: backupManager
 * pinsForRestore), or null when the scorer cancels. Any other file resolves
 * as it is, at once. Render `dialog` in the component.
 *
 *   const { unlock, dialog } = useBackupUnlock()
 *   const data = await unlock(matchBackupFromFile(picked))
 *   if (!data) return // cancelled
 */
export function useBackupUnlock({ zIndex } = {}) {
  const [asking, setAsking] = useState(null) // { envelope, resolve }
  const askingRef = useRef(null)
  askingRef.current = asking

  // A component that goes away while asking: the caller gets "cancelled"
  useEffect(() => () => askingRef.current?.resolve(null), [])

  const unlock = useCallback((file) => {
    if (!isEncryptedBackup(file)) return Promise.resolve(file)
    return new Promise(resolve => {
      askingRef.current?.resolve(null)
      setAsking({ envelope: file, resolve })
    })
  }, [])

  const settle = (value) => {
    asking?.resolve(value)
    setAsking(null)
  }

  const dialog = asking ? (
    <BackupUnlockDialog
      envelope={asking.envelope}
      zIndex={zIndex}
      onOpened={(data) => settle(data)}
      onCancel={() => settle(null)}
    />
  ) : null

  return { unlock, dialog }
}

export default useBackupUnlock
