/**
 * Where this match is backed up: Cloud, This device, Removable drive.
 * Match Setup shows it (collapsed), Options can reuse it.
 *
 *  - Cloud: always on while online (no switch; offline it waits and says so).
 *    A test match never reaches the cloud.
 *  - This device: the apps back up every scoring event into their own folder
 *    (made on first use, no question asked). A browser with folder access
 *    (Chrome, Edge) writes into a folder the scorer picks once; a folder from
 *    an earlier session is kept and asks one tap ("Reconnect folder").
 *    Safari and Firefox download a file at set end and match end.
 *  - Removable drive: the desktop app copies every backup file to every USB
 *    stick plugged in (OpenVolley/ made when missing). In Chrome and Edge,
 *    pick a folder on the drive as the folder above. Android: not yet.
 *
 * `backup` is what hooks/useAutoBackup returns in App.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Switch, cn } from '../ui'
import { useStickBackup, getStickAutoEnabled, setStickAutoEnabled } from '../utils/stickBackup'
import { useNativeBackupStatus } from '../utils/nativeBackup'

const BTN = 'inline-flex h-10 items-center justify-center rounded-lg border border-stone-300 bg-white px-3 text-sm font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50'

function useOnline() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false))
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

function Line({ title, hint, status, children }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-stone-100 py-3 first:border-t-0">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-stone-900">{title}</div>
          {status && <div className="text-xs text-stone-600">{status}</div>}
        </div>
        {children}
      </div>
      {hint && <div className="text-[11px] leading-snug text-stone-500">{hint}</div>}
    </div>
  )
}

export default function BackupTargetsPanel({ backup, test = false, className }) {
  const { t } = useTranslation()
  const online = useOnline()
  const nativeStatus = useNativeBackupStatus()
  const stick = useStickBackup({ poll: !!backup?.platform && backup.platform === 'tauri' })
  const [stickOn, setStickOn] = useState(() => getStickAutoEnabled())
  if (!backup) return null

  const tauri = backup.platform === 'tauri'
  const capacitor = backup.platform === 'capacitor'
  const folderMode = backup.hasFileSystemAccess
  const sticks = stick.sticks || []
  const auto = stick.auto

  const localStatus = backup.nativeMode
    ? (backup.autoBackupEnabled ? (nativeStatus.folder || t('backupTargets.preparing')) : t('backupTargets.off'))
    : folderMode
      ? (backup.needsReconnect ? t('backupTargets.folderReconnect', { name: backup.backupDirName })
        : backup.backupDirName ? t('backupTargets.folderIs', { name: backup.backupDirName }) : t('backupTargets.folderNone'))
      : t('backupTargets.downloads')

  return (
    <details className={cn('rounded-xl border border-stone-200 bg-white px-4 shadow-sm', className)} data-testid="backup-targets">
      <summary className="flex min-h-12 cursor-pointer items-center justify-between gap-3 text-sm font-semibold text-stone-900">
        <span>{t('backupTargets.title')}</span>
        <span className="text-xs font-normal text-stone-500">{t('backupTargets.summary')}</span>
      </summary>
      <div className="pb-2">
        <Line
          title={t('backupTargets.cloud')}
          status={test ? t('backupTargets.cloudTest') : online ? t('backupTargets.cloudOn') : t('backupTargets.cloudOffline')}
          hint={t('backupTargets.cloudHint')}
        />

        <Line title={t('backupTargets.device')} status={localStatus} hint={capacitor ? t('backupTargets.deviceAndroid') : undefined}>
          {backup.nativeMode ? (
            <Switch size="lg" checked={!!backup.autoBackupEnabled} onCheckedChange={(v) => backup.toggleAutoBackup(!!v)} aria-label={t('backupTargets.device')} />
          ) : folderMode ? (
            <div className="flex shrink-0 gap-2">
              {backup.needsReconnect ? (
                <button type="button" className={BTN} onClick={backup.reconnectBackupDir} data-testid="backup-reconnect">{t('backupTargets.reconnect')}</button>
              ) : null}
              <button type="button" className={BTN} onClick={backup.selectBackupDir} data-testid="backup-pick-folder">
                {backup.backupDirName ? t('options.changeFolder') : t('options.selectBackupFolder')}
              </button>
            </div>
          ) : null}
        </Line>

        <Line
          title={t('backupTargets.drive')}
          status={
            tauri
              ? !stickOn ? t('backupTargets.off')
                : sticks.length ? sticks.map(s => s.label).join(', ') + (auto?.status === 'ok' ? ` · ${t('backupTargets.driveCopied', { time: auto.at.toLocaleTimeString() })}` : '')
                  : t('backupTargets.driveNone')
              : folderMode ? t('backupTargets.driveBrowser')
                : capacitor ? t('backupTargets.driveAndroid') : t('backupTargets.driveDownload')
          }
          hint={tauri ? t('backupTargets.driveHint') : undefined}
        >
          {tauri && (
            <Switch
              size="lg"
              checked={stickOn}
              onCheckedChange={(v) => { setStickOn(!!v); setStickAutoEnabled(!!v) }}
              aria-label={t('backupTargets.drive')}
            />
          )}
        </Line>
        {backup.backupError && (
          <div role="alert" className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{backup.backupError}</div>
        )}
        {tauri && auto && auto.status !== 'ok' && auto.status !== 'noStick' && stickOn && (
          <div role="alert" className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700" data-testid="stick-auto-error">
            {t('backupTargets.driveFailed')} {auto.error || auto.results?.find(r => !r.ok)?.message || ''}
          </div>
        )}
      </div>
    </details>
  )
}
