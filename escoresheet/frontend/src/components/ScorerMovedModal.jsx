import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MonitorSmartphone } from 'lucide-react'
import Modal from './Modal'
import { Button } from '../ui'

// The platforms the server records (utils/identity platformName) -> a label key
const PLATFORM_KEYS = {
  android: 'android',
  ios: 'ios',
  'tauri-linux': 'linux',
  'tauri-windows': 'windows',
  'tauri-macos': 'macos',
  electron: 'desktop',
  web: 'web'
}

/**
 * "This match is now scored on another device (Android phone or tablet,
 * 19:54)": the device a scorer left, when another one took the match over
 * (server db/019, utils/matchHandover). It covers the scoring screens and
 * cannot be dismissed: this device must not go on scoring a match the other
 * device writes. Take back makes this device the scorer again (the other one
 * is told the same); Close goes back to the home screen.
 * @param {{ scorer: {platform?: string|null, at?: string|null}|null, onTakeBack: () => Promise<void>|void, onClose: () => void }} props
 */
export default function ScorerMovedModal({ scorer, onTakeBack, onClose }) {
  const { t, i18n } = useTranslation()
  const [busy, setBusy] = useState(false)
  const platformKey = PLATFORM_KEYS[scorer?.platform] || null
  const platform = platformKey ? t(`scorerMoved.platforms.${platformKey}`) : null
  const time = formatTakeOver(scorer?.at, i18n.language)
  const body = platform && time
    ? t('scorerMoved.body', { platform, time })
    : t('scorerMoved.bodyUnknown')

  const takeBack = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onTakeBack()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('scorerMoved.title')} open={true} hideCloseButton={true} width={460} zIndex={3000}>
      <div className="ov-kit" data-testid="scorer-moved-modal">
        <div role="alert" className="flex items-start gap-3 text-sm text-stone-700">
          <MonitorSmartphone size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-amber-700" />
          <p className="m-0">{body}</p>
        </div>
        <p className="mt-2 text-xs text-stone-500">{t('scorerMoved.takeBackHint')}</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>
            {t('scorerMoved.close')}
          </Button>
          <Button variant="dark" size="lg" onClick={takeBack} disabled={busy} aria-busy={busy || undefined}>
            {t('scorerMoved.takeBack')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** "19:54" today, "20.10. 19:54" another day (the device's language), null without a valid time. */
export function formatTakeOver(at, lang, now = new Date()) {
  const d = at ? new Date(at) : null
  if (!d || Number.isNaN(d.getTime())) return null
  const time = d.toLocaleTimeString(lang || undefined, { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return time
  return `${d.toLocaleDateString(lang || undefined, { day: '2-digit', month: '2-digit' })} ${time}`
}
