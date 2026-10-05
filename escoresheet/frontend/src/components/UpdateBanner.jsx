import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import useServiceWorker from '../hooks/useServiceWorker'
import { Download, RefreshCw } from 'lucide-react'
import { Button } from '../ui/Button.jsx'

// Get current version from package.json (injected by Vite at build time)
const currentVersion = __APP_VERSION__

/**
 * Modal popup that shows when a new version of the app is available
 */
export default function UpdateBanner() {
  const { t } = useTranslation()
  const { needRefresh, updateServiceWorker, dismissUpdate } = useServiceWorker()
  const [newVersion, setNewVersion] = useState(null)

  // Fetch the new version from server when update is detected (label only).
  // Relative to the app's base: sub-apps are served under /referee/, /bench/...
  useEffect(() => {
    if (needRefresh) {
      fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`)
        .then(res => res.json())
        .then(data => setNewVersion(data.version))
        .catch(() => setNewVersion(null))
    }
  }, [needRefresh])

  // The waiting service worker decides whether an update exists; version.json
  // is only the label (a deploy without a version bump still needs activating).
  if (!needRefresh) return null

  // Kit content dialog (UpdateNotice look): stone scrim with blur, white
  // rounded-2xl panel, sky info disc, the version change as a mono chip, and
  // Later (outline) / Refresh (dark: this can open over the scoreboard, where
  // chrome takes no brand-red fill, RESTYLE-SPEC R4). Both h-11.
  // Behaviour unchanged: a tap on the scrim still means "Later".
  return (
    <div
      onClick={dismissUpdate}
      className="no-print fixed inset-0 flex items-center justify-center p-4 bg-stone-900/50 backdrop-blur-sm"
      style={{ zIndex: 10000 }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ov-update-title"
        onClick={(e) => e.stopPropagation()}
        className="ov-kit w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-2xl bg-white p-6 text-center shadow-2xl"
      >
        {/* Icon */}
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-sky-50 text-sky-600" aria-hidden="true">
          <Download size={22} />
        </div>

        {/* Title */}
        <h3 id="ov-update-title" className="mb-2 text-lg font-bold text-stone-900">
          {t('options.updateAvailable', 'Update Available!')}
        </h3>

        {/* Version info */}
        {newVersion && newVersion !== currentVersion && (
          <div className="mb-4 inline-flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-1 font-mono text-sm tabular-nums text-stone-600">
            <span>{currentVersion}</span>
            <span className="text-stone-400" aria-hidden="true">→</span>
            <span className="font-semibold text-emerald-700">{newVersion}</span>
          </div>
        )}

        {/* Description */}
        <p className="mb-6 text-sm leading-relaxed text-stone-600">
          {t('options.updateDescription', 'A new version is available. Refresh to get the latest features and fixes.')}
        </p>

        {/* Buttons: side by side from sm; on a phone stacked full width, Refresh
            on top, so long labels (FR "Actualiser pour mettre à jour") stay on one line */}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-center">
          <Button variant="secondary" size="xl" onClick={dismissUpdate} className="w-full sm:w-auto">
            {t('common.later', 'Later')}
          </Button>
          <Button variant="dark" size="xl" icon={RefreshCw} onClick={() => updateServiceWorker()} className="w-full sm:w-auto">
            {t('options.refreshToUpdate', 'Refresh to Update')}
          </Button>
        </div>
      </div>
    </div>
  )
}
