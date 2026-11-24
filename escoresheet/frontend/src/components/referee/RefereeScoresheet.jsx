import { lazy, Suspense, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Button } from '../../ui/Button.jsx'
import { AppSpinner } from '../../ui/AppSpinner.jsx'
import { timeLabel } from '../../ui/format.js'
import { scoresheetInputFromBundle } from './scoresheetInput.js'

// The scoresheet viewer (paper form, pinch zoom, Fit) loads when the referee
// first opens it: the referee page itself stays small. The chunk is
// precached with every other script (pwa-workbox.js), so it opens offline too.
const ScoresheetView = lazy(() => import('../../../scoresheet_pdf/App_Scoresheet'))

/** The bar's height in px: the sheet's Fit leaves it room. */
export const SCORESHEET_BAR_PX = 56

const pad = (n) => String(n).padStart(2, '0')

/** "17:24:18" on the Zürich clock (seconds: the view visibly moves with each rally). */
export function updatedLabel(ms) {
  if (!Number.isFinite(ms)) return ''
  const hm = timeLabel(ms)
  return hm ? `${hm}:${pad(new Date(ms).getSeconds())}` : ''
}

/**
 * The referee tablet's live scoresheet: the official paper form as the scorer
 * sees it, drawn from the relay bundle this tablet holds (no request of its
 * own), redrawn with every bundle while it is open. A view only: no Save PDF,
 * no signing, nothing to edit. Close (or Escape) goes back to the dashboard.
 *
 * @param {object} props
 * @param {object} props.bundle the last 'full' relay bundle (scoresheetInput.js)
 * @param {number|null} [props.receivedAt] when that bundle arrived (ms)
 * @param {() => void} props.onClose
 */
export default function RefereeScoresheet({ bundle, receivedAt = null, onClose }) {
  const { t } = useTranslation()
  const matchData = useMemo(() => scoresheetInputFromBundle(bundle), [bundle])
  const closeRef = useRef(null)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    closeRef.current?.focus({ preventScroll: true })
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const updated = updatedLabel(receivedAt)
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="referee-scoresheet-title"
      data-testid="referee-scoresheet-view"
      className="no-print"
      // Over the dashboard, under its dialogs (Modal: 1000): the "Recorded by
      // the scorer" popup and "Scorer needs attention" still show over the sheet
      style={{ position: 'fixed', inset: 0, zIndex: 990, display: 'flex', flexDirection: 'column', background: '#f3f4f6' }}
    >
      <div
        className="ov-kit flex shrink-0 items-center gap-3 border-b border-stone-200/70 bg-white"
        style={{ height: SCORESHEET_BAR_PX, padding: '0 max(12px, env(safe-area-inset-right, 0px)) 0 max(12px, env(safe-area-inset-left, 0px))' }}
      >
        <Button ref={closeRef} variant="dark" size="xl" icon={X} onClick={onClose} data-testid="referee-scoresheet-close" className="shrink-0">
          {t('refereeDashboard.scoresheet.close', 'Close')}
        </Button>
        <div className="min-w-0 flex-1">
          <h2 id="referee-scoresheet-title" className="truncate text-sm font-semibold text-stone-900">
            {t('refereeDashboard.scoresheet.title', 'Scoresheet')}
          </h2>
          <p className="flex min-w-0 items-center gap-1.5 truncate text-[11px] font-medium text-stone-500">
            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
            <span className="truncate">
              {t('refereeDashboard.scoresheet.readOnly', 'Live, read only')}
              {updated && <> · <span className="tabular-nums" data-testid="referee-scoresheet-updated">{t('refereeDashboard.scoresheet.updated', 'updated {{time}}', { time: updated })}</span></>}
            </span>
          </p>
        </div>
        <p className="hidden max-w-[22rem] text-right text-[11px] leading-snug text-stone-500 md:block">
          {t('refereeDashboard.scoresheet.notSent', 'Signatures, officials and dates of birth stay on the scorer\'s device.')}
        </p>
      </div>
      <div className="min-h-0 flex-1">
        {matchData ? (
          <Suspense fallback={<div className="ov-kit flex h-full items-center justify-center"><AppSpinner label={t('refereeDashboard.scoresheet.loading', 'Loading scoresheet...')} /></div>}>
            <ScoresheetView matchData={matchData} readOnly embedded reservedTop={SCORESHEET_BAR_PX} />
          </Suspense>
        ) : (
          <div className="ov-kit flex h-full items-center justify-center p-6 text-center text-sm text-stone-600">
            {t('refereeDashboard.scoresheet.waiting', 'Waiting for the scorer\'s data...')}
          </div>
        )}
      </div>
    </div>
  )
}
