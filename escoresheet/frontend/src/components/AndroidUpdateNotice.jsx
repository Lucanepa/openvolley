import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import useAndroidUpdate from '../hooks/useAndroidUpdate'
import { Button, Modal } from '../ui'

const currentVersion = __APP_VERSION__

// The opt-in question waits until no other dialog is open (the startup
// connectivity check, a restore prompt...), so it never stacks on one.
const ASK_DELAY_MS = 1500
const otherDialogOpen = () => !!document.querySelector('[aria-modal="true"]')

/**
 * Android app, home screen only (App.jsx mounts it next to UpdateBanner, so
 * it is gone while the scoreboard, setup or match end is on screen; the
 * referee and bench views are other pages). Nothing shows during a live
 * match: a version found then waits for the match to end.
 *
 * - The one-time question "Get notified about new versions?" for an app
 *   that F-Droid does not update (default off; Yes and No look the same;
 *   closing it counts as no).
 * - A newer version: {current} → {new}, get it from F-Droid (it updates
 *   itself from then on) or download the APK, or Later.
 */
export default function AndroidUpdateNotice() {
  const { t } = useTranslation()
  const update = useAndroidUpdate()
  const [askReady, setAskReady] = useState(false)

  const { showAsk } = update
  useEffect(() => {
    if (!showAsk || askReady) return undefined
    const id = setInterval(() => {
      if (!otherDialogOpen()) setAskReady(true)
    }, ASK_DELAY_MS)
    return () => clearInterval(id)
  }, [showAsk, askReady])

  if (!update.active) return null

  if (showAsk) {
    // .ov-kit around it: the legacy button and focus styles (styles.css)
    // stay out of the kit's dialog
    return (
      <div className="ov-kit">
        <Modal
          open={askReady}
          onClose={() => update.setNotify(false)}
          title={t('androidUpdate.askTitle')}
          size="sm"
          decision
          closeLabel={t('common.close')}
        >
          <p className="text-sm leading-relaxed text-stone-600">{t('androidUpdate.askBody')}</p>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Button variant="secondary" size="xl" onClick={() => update.setNotify(false)} data-testid="update-ask-no">
              {t('androidUpdate.askNo')}
            </Button>
            <Button variant="secondary" size="xl" onClick={() => update.setNotify(true)} data-testid="update-ask-yes">
              {t('androidUpdate.askYes')}
            </Button>
          </div>
        </Modal>
      </div>
    )
  }

  if (!update.showNotice) return null
  const fromFdroid = update.family === 'fdroid'
  return (
    <div
      role="status"
      aria-labelledby="ov-android-update-title"
      data-testid="android-update-notice"
      className="ov-kit no-print fixed inset-x-4 z-40 rounded-2xl border border-stone-200/70 bg-white p-4 shadow-xl sm:left-auto sm:right-4 sm:w-96"
      style={{ bottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-50 text-sky-600" aria-hidden="true">
          <Download size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 id="ov-android-update-title" className="text-sm font-semibold text-stone-900">
            {t('androidUpdate.available', { version: update.latest.versionName })}
          </h3>
          <div className="mt-1 inline-flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-2 py-0.5 font-mono text-xs tabular-nums text-stone-600">
            <span>{currentVersion}</span>
            <span className="text-stone-400" aria-hidden="true">→</span>
            <span className="font-semibold text-emerald-700">{update.latest.versionName}</span>
          </div>
          {/* the check reads the OpenVolley repo; an f-droid.org install
              gets the version only once f-droid.org has built it */}
          {fromFdroid && (
            <p className="mt-2 text-xs leading-relaxed text-stone-500">{t('androidUpdate.fdroidRepoHint')}</p>
          )}
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-2">
        {fromFdroid ? (
          <>
            <Button variant="dark" size="xl" onClick={() => update.openInFdroid()} className="w-full">
              {t('androidUpdate.openFdroid')}
            </Button>
            <Button variant="secondary" size="xl" onClick={() => update.getFromFdroid()} className="w-full">
              {t('androidUpdate.addRepo')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="dark" size="xl" onClick={() => update.getFromFdroid()} className="h-auto min-h-11 w-full py-2 text-center leading-snug">
              {t('androidUpdate.getFdroid')}
            </Button>
            <Button variant="secondary" size="xl" onClick={() => update.downloadApk()} className="w-full">
              {t('androidUpdate.downloadApk')}
            </Button>
          </>
        )}
        {/* quiet like a text link, but a full 44px courtside touch target */}
        <Button
          variant="text"
          size="xl"
          onClick={() => update.dismiss()}
          className="w-full px-4 text-sm font-medium"
          data-testid="android-update-later"
        >
          {t('common.later')}
        </Button>
      </div>
    </div>
  )
}
