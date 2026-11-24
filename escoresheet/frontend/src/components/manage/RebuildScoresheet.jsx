import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, X } from 'lucide-react'
import { Button } from '../../ui/Button.jsx'
import { AppSpinner } from '../../ui/AppSpinner.jsx'
import { reloadWithReason } from '../../diagnostics/reload'
import { PDF_TIMEOUT_MS } from '../../utils/scoresheetPdfRequest'

// The paper form loads only when an admin rebuilds a sheet (its own chunk)
const ScoresheetView = lazy(() => import('../../../scoresheet_pdf/App_Scoresheet'))

/** The bar's height in px: the sheet's Fit leaves it room. */
const BAR_PX = 56

/**
 * How long the rebuild may take, from opening to the PDF: the approval's own
 * limit (scoresheetPdfRequest). A capture that hangs (html-to-image has no
 * limit of its own) ends as "could not be made", never as a black screen.
 */
export const REBUILD_TIMEOUT_MS = PDF_TIMEOUT_MS

/** A lazy chunk of a build that is no longer on the site (a tab left open across a deploy). */
export const isChunkLoadError = (error) => {
  const text = `${error?.name || ''} ${error?.message || ''}`
  return /ChunkLoadError|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(text)
}

/**
 * The sheet's own failures (its chunk could not be loaded, or it threw while
 * drawing an odd record) stay in this dialog: without it they replaced the
 * whole manager (managerRoot's boundary).
 */
class SheetBoundary extends Component {
  constructor (props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError (error) {
    return { error }
  }

  componentDidCatch (error, info) {
    console.warn('[Scoresheets] rebuild: the sheet could not be drawn', error, info?.componentStack)
    this.props.onError(error)
  }

  render () {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children
  }
}

/**
 * "Rebuild PDF" (owner 2026-11-16): the scoresheet drawn again from the
 * match's data on the server (ScoresheetsPanel loads it), with the remark
 * "Rebuilt after the match: <when> - <reason>", made into a PDF with the
 * approval's own code (App_Scoresheet getBlob) and handed to `onDone` as
 * { blob, filename }, or null when it could not be made (with
 * { timedOut: true } after REBUILD_TIMEOUT_MS). The signatures and the account
 * approvals are the match's, as stored. Shown full screen while it works.
 *
 * Cancel stops it, also while the PDF is being made (the sheet's "Generating
 * PDF" cover leaves this bar free): `onDone` is never called after it, and
 * the sheet drops a capture still running, so a PDF that comes out late is
 * not stored. A sheet that cannot be drawn says so here (with Reload when the
 * app was updated meanwhile) and waits for Close.
 *
 * @param {object} props
 * @param {object} props.matchData  scoresheetDataFromCloud's result
 * @param {string} props.remark  the rebuild's remark line
 * @param {string} props.title  what the bar says (the game)
 * @param {(out: { blob: Blob, filename: string } | null, info?: { timedOut?: boolean }) => void} props.onDone
 * @param {() => void} props.onCancel
 * @param {number} [props.timeoutMs]
 */
export default function RebuildScoresheet({ matchData, remark, title, onDone, onCancel, timeoutMs = REBUILD_TIMEOUT_MS }) {
  const { t } = useTranslation()
  const cancelRef = useRef(null)
  const doneRef = useRef(false)
  const [failed, setFailed] = useState(null)
  const extraRemarks = useMemo(() => [remark], [remark])
  useEffect(() => { cancelRef.current?.focus({ preventScroll: true }) }, [])
  const done = (out, info) => {
    if (doneRef.current) return
    doneRef.current = true
    onDone(out, info)
  }
  const doneLatest = useRef(done)
  doneLatest.current = done
  useEffect(() => {
    const timer = setTimeout(() => {
      console.warn(`[Scoresheets] rebuild: no PDF after ${timeoutMs} ms`)
      doneLatest.current(null, { timedOut: true })
    }, timeoutMs)
    return () => clearTimeout(timer)
  }, [timeoutMs])
  const cancel = () => {
    doneRef.current = true
    onCancel()
  }
  const sheetFailed = (error) => {
    doneRef.current = true
    setFailed(error || new Error('unknown'))
  }
  const failure = (error) => {
    const chunk = isChunkLoadError(error)
    return (
      <div role="alert" className="ov-kit flex h-full flex-col items-center justify-center gap-3 px-4 text-center" data-testid="rebuild-scoresheet-failed">
        <p className="max-w-md text-sm font-medium text-stone-900">
          {chunk
            ? t('manage.scoresheets.rebuildUpdated', 'The app was updated meanwhile. Reload the page, then rebuild the PDF again.')
            : t('manage.scoresheets.rebuildDrawFailed', 'The sheet could not be drawn from this match data. Nothing was stored.')}
        </p>
        {!chunk && error?.message && (
          <p className="max-w-md break-words text-[11px] text-stone-500" data-testid="rebuild-scoresheet-error">{String(error.message).slice(0, 300)}</p>
        )}
        {chunk && (
          <Button variant="primary" size="lg" icon={RefreshCw} onClick={() => reloadWithReason('rebuild-chunk')} data-testid="rebuild-scoresheet-reload">
            {t('manage.scoresheets.rebuildReload', 'Reload')}
          </Button>
        )}
      </div>
    )
  }
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="rebuild-scoresheet-title"
      data-testid="rebuild-scoresheet"
      className="no-print"
      style={{ position: 'fixed', inset: 0, zIndex: 990, display: 'flex', flexDirection: 'column', background: '#f3f4f6' }}
    >
      <div className="ov-kit flex shrink-0 items-center gap-3 border-b border-stone-200/70 bg-white px-3" style={{ height: BAR_PX }}>
        <Button ref={cancelRef} variant="secondary" size="lg" icon={X} onClick={cancel} data-testid="rebuild-scoresheet-cancel" className="shrink-0">
          {failed ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}
        </Button>
        <div className="min-w-0 flex-1">
          <h2 id="rebuild-scoresheet-title" className="truncate text-sm font-semibold text-stone-900">{title}</h2>
          {!failed && <p className="truncate text-[11px] font-medium text-stone-500">{t('manage.scoresheets.rebuilding', 'Making the new PDF from the match data…')}</p>}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <SheetBoundary onError={sheetFailed} fallback={failure}>
          <Suspense fallback={<div className="ov-kit flex h-full items-center justify-center"><AppSpinner label={t('manage.scoresheets.rebuilding', 'Making the new PDF from the match data…')} /></div>}>
            <ScoresheetView matchData={matchData} autoAction="getBlob" readOnly embedded reservedTop={BAR_PX} extraRemarks={extraRemarks} onBlob={done} />
          </Suspense>
        </SheetBoundary>
      </div>
    </div>
  )
}

/** A Blob as base64 (no data: prefix), for a JSON upload. */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = String(reader.result || '')
      resolve(s.slice(s.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}
