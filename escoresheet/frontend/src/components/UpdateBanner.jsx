import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import useServiceWorker, { autoApplyAllowed, noteAutoApply, holdTapsUntilReload, releaseTaps, useAppUpdateNeeded, UPDATE_DEFERRED } from '../hooks/useServiceWorker'
import { UPDATE_NEEDED_SERVER } from '../utils/appUpdate'
import { Download, RefreshCw } from 'lucide-react'
import { Button } from '../ui/Button.jsx'
import { backdropDismiss } from '../ui/backdropDismiss.js'
import { isDesktopScoretable, resolveDesktopWindow } from '../utils/appLifecycle'

// Get current version from package.json (injected by Vite at build time)
const currentVersion = __APP_VERSION__

/**
 * Modal popup that shows when a new version of the app is available.
 * `whenUpdateNeeded` (the match screens): only while this build cannot do
 * its work ("Update needed", utils/appUpdate: the server refuses its writes,
 * or its files are gone from the site), with that reason as its text; a
 * scorer mid-match is never asked otherwise.
 */
export default function UpdateBanner({ whenUpdateNeeded = false } = {}) {
  const { t } = useTranslation()
  const { needRefresh, updateServiceWorker, dismissUpdate } = useServiceWorker()
  const updateNeeded = useAppUpdateNeeded()
  const [newVersion, setNewVersion] = useState(null)
  // Another tab or window has a match open: the update waits for it
  const [deferred, setDeferred] = useState(false)
  // The desktop app's binary IS the update: its first start still runs the
  // previous build from the service worker, with the new one waiting. Apply it
  // at once (on the home screen only: never mid-match, so not on the match
  // screens' banner). Not a second time within a short while
  // (autoApplyAllowed): an update that did not take reloaded into itself
  // every few seconds; then the banner asks.
  // The scoretable only, as the app says (a Linux pop-up's own metadata says
  // "main"): a pop-up asks too.
  const [applyAtOnce, setApplyAtOnce] = useState(() => !whenUpdateNeeded && isDesktopScoretable() && autoApplyAllowed())
  const appliedRef = useRef(false)

  useEffect(() => {
    if (!needRefresh || !applyAtOnce || appliedRef.current) return
    let live = true
    resolveDesktopWindow().then((scoretable) => {
      if (!live || appliedRef.current) return
      if (!scoretable) {
        setApplyAtOnce(false)
        return
      }
      appliedRef.current = true
      noteAutoApply()
      // the scorer may be tapping (a tap closed applyUpdateAtStart's grace):
      // nothing they start may be cut by the reload
      holdTapsUntilReload()
      Promise.resolve(updateServiceWorker()).then((r) => {
        if (r !== UPDATE_DEFERRED) return
        releaseTaps()
        if (!live) return
        setApplyAtOnce(false)
        setDeferred(true)
      }).catch(() => {})
    }).catch(() => { if (live) setApplyAtOnce(false) })
    return () => { live = false }
  }, [needRefresh, applyAtOnce, updateServiceWorker])

  // Fetch the new version from server when update is detected (label only).
  // Relative to the app's base: sub-apps are served under /referee/, /bench/...
  // (the match screens' banner: only once it is to be shown)
  const shown = needRefresh && !applyAtOnce && (!whenUpdateNeeded || !!updateNeeded)
  useEffect(() => {
    if (shown) {
      fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`)
        .then(res => res.json())
        .then(data => setNewVersion(data.version))
        .catch(() => setNewVersion(null))
    }
  }, [shown])

  // The waiting service worker decides whether an update exists; version.json
  // is only the label (a deploy without a version bump still needs activating).
  if (!shown) return null

  const refresh = () => {
    setDeferred(false)
    Promise.resolve(updateServiceWorker()).then((r) => { if (r === UPDATE_DEFERRED) setDeferred(true) }).catch(() => {})
  }
  const title = updateNeeded ? t('update.neededTitle', 'Update needed') : t('options.updateAvailable', 'Update available!')
  const description = updateNeeded === UPDATE_NEEDED_SERVER
    ? t('update.neededServer', 'This version is too old for the server: your changes stay on this device and are sent after the update. Refresh after this rally.')
    : updateNeeded
      ? t('update.neededFiles', 'A newer version of OpenVolley is out, and a part of this one could not be loaded. Refresh after this rally.')
      : t('options.updateDescription', 'A new version is available. Refresh to get the latest features and fixes.')

  // Kit content dialog (UpdateNotice look): stone scrim with blur, white
  // rounded-2xl panel, sky info disc, the version change as a mono chip, and
  // Later (outline) / Refresh (dark: this can open over the scoreboard, where
  // chrome takes no brand-red fill, RESTYLE-SPEC R4). Both h-11.
  // Behaviour unchanged: a tap on the scrim still means "Later".
  return (
    <div
      {...backdropDismiss(dismissUpdate)}
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
          {title}
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
          {description}
        </p>

        {deferred && (
          <p role="status" className="-mt-3 mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {t('update.waitsForOtherWindow', 'A match is open in another window of OpenVolley. The update waits until it is closed there.')}
          </p>
        )}

        {/* Buttons: side by side from sm; on a phone stacked full width, Refresh
            on top, so long labels (FR "Actualiser pour mettre à jour") stay on one line */}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-center">
          <Button variant="secondary" size="xl" onClick={dismissUpdate} className="w-full sm:w-auto">
            {t('common.later', 'Later')}
          </Button>
          <Button variant="dark" size="xl" icon={RefreshCw} onClick={refresh} className="w-full sm:w-auto">
            {t('options.refreshToUpdate', 'Refresh to update')}
          </Button>
        </div>
      </div>
    </div>
  )
}
