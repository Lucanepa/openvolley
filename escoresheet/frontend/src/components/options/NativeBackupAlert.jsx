import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { detectBackupPlatform, isNativeBackupPlatform, useNativeBackupStatus } from '../../utils/nativeBackup'

/**
 * A small red dot in the scoreboard toolbar while the app's automatic backup
 * is failing (the folder is refused, the disk is full...). Never blocks
 * scoring; it goes away with the next backup that is saved. Tapping it opens
 * Options, where the error is shown in full.
 */
export default function NativeBackupAlert({ onOpen }) {
  const [native] = useState(() => isNativeBackupPlatform(detectBackupPlatform()))
  if (!native) return null
  return <NativeBackupAlertDot onOpen={onOpen} />
}

function NativeBackupAlertDot({ onOpen }) {
  const { t } = useTranslation()
  const { error } = useNativeBackupStatus()
  if (!error) return null
  const label = t('options.nativeBackupFailingShort')
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${label} ${error}`}
      aria-label={label}
      data-testid="native-backup-alert"
      className="ml-2 inline-flex h-6 items-center gap-1 rounded-full bg-red-600/90 px-2 text-[11px] font-medium leading-none text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-white" aria-hidden="true" />
      {t('options.nativeBackupFailingBadge')}
    </button>
  )
}
