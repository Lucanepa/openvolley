/**
 * "Saved on this device / on a drive": the backups a restore can take from
 * the app's own folder, every USB stick and the browser's backup folder.
 * onPick(parsedFile) hands the chosen file to the restore flow (which asks
 * for the PIN of an encrypted one). Cloud backups are listed by the dialogs
 * themselves.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../ui'
import { detectBackupPlatform, getNativeBackupEngine } from '../utils/nativeBackup'
import { createStickPlatform } from '../utils/stickBackup/platform'
import { getStoredDirectoryHandle, isFileSystemAccessSupported, queryDirectoryPermission, verifyDirectoryPermission } from '../utils/backupManager'
import { listDeviceBackups, listDriveBackups, listFolderBackups } from '../utils/savedBackups'

const SOURCE_KEYS = { device: 'savedBackups.device', drive: 'savedBackups.drive', folder: 'savedBackups.folder' }

export default function SavedBackupsList({ onPick, disabled = false, className }) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState(null) // null: loading
  const [reconnect, setReconnect] = useState(null) // a browser folder waiting for one tap
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(null)

  const load = useCallback(async () => {
    const platform = detectBackupPlatform()
    const out = []
    try {
      if (platform === 'tauri' || platform === 'capacitor') {
        const engine = await getNativeBackupEngine()
        out.push(...await listDeviceBackups(engine?.store))
        if (platform === 'tauri') out.push(...await listDriveBackups(createStickPlatform()))
      } else if (isFileSystemAccessSupported()) {
        const handle = await getStoredDirectoryHandle().catch(() => null)
        if (handle) {
          const permission = await queryDirectoryPermission(handle)
          if (permission === 'granted') out.push(...await listFolderBackups(handle))
          else if (permission === 'prompt') setReconnect(handle)
        }
      }
    } catch (e) {
      setError(e?.message || String(e))
    }
    setEntries(out)
  }, [])

  useEffect(() => { load() }, [load])

  const reconnectFolder = async () => {
    if (reconnect && await verifyDirectoryPermission(reconnect)) {
      setReconnect(null)
      setEntries(null)
      load()
    }
  }

  const pick = async (e) => {
    setBusy(e.key)
    setError('')
    try {
      const file = await e.read()
      await onPick(file, e)
    } catch (err) {
      setError(`${t('savedBackups.err_io')} ${err?.message || ''}`.trim())
    } finally {
      setBusy(null)
    }
  }

  if (entries === null) return null
  if (!entries.length && !reconnect && !error) {
    return <p className={cn('text-xs text-stone-500', className)} data-testid="saved-backups-none">{t('savedBackups.none')}</p>
  }

  return (
    <div className={className} data-testid="saved-backups">
      {reconnect && (
        <button type="button" onClick={reconnectFolder} className="mb-2 inline-flex h-10 items-center rounded-lg border border-stone-300 bg-white px-3 text-sm font-medium text-stone-700 hover:bg-stone-50">
          {t('backupTargets.reconnect')}
        </button>
      )}
      {!!entries.length && (
        <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200">
          {entries.map(e => (
            <li key={e.key} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-stone-900">{e.title}</div>
                <div className="truncate text-[11px] text-stone-500">
                  {[t(SOURCE_KEYS[e.source]), e.where, e.modifiedMs ? new Date(e.modifiedMs).toLocaleString() : '', e.encrypted ? t('savedBackups.pin') : ''].filter(Boolean).join(' · ')}
                </div>
              </div>
              <button
                type="button"
                disabled={disabled || busy != null}
                aria-busy={busy === e.key || undefined}
                onClick={() => pick(e)}
                className="inline-flex h-10 shrink-0 items-center rounded-lg border border-stone-300 bg-white px-3 text-sm font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
              >
                {t('savedBackups.restore')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  )
}
