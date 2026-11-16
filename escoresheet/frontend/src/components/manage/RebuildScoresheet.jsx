import { lazy, Suspense, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Button } from '../../ui/Button.jsx'
import { AppSpinner } from '../../ui/AppSpinner.jsx'

// The paper form loads only when an admin rebuilds a sheet (its own chunk)
const ScoresheetView = lazy(() => import('../../../scoresheet_pdf/App_Scoresheet'))

/** The bar's height in px: the sheet's Fit leaves it room. */
const BAR_PX = 56

/**
 * "Rebuild PDF" (owner 2026-11-16): the scoresheet drawn again from the
 * match's data on the server (ScoresheetsPanel loads it), with the remark
 * "Rebuilt after the match: <when> - <reason>", made into a PDF with the
 * approval's own code (App_Scoresheet getBlob) and handed to `onDone` as
 * { blob, filename }, or null when it could not be made. The signatures are
 * the match's, as stored. Shown full screen while it works; Cancel stops it.
 *
 * @param {object} props
 * @param {object} props.matchData  scoresheetDataFromCloud's result
 * @param {string} props.remark  the rebuild's remark line
 * @param {string} props.title  what the bar says (the game)
 * @param {(out: { blob: Blob, filename: string } | null) => void} props.onDone
 * @param {() => void} props.onCancel
 */
export default function RebuildScoresheet({ matchData, remark, title, onDone, onCancel }) {
  const { t } = useTranslation()
  const cancelRef = useRef(null)
  const doneRef = useRef(false)
  const extraRemarks = useMemo(() => [remark], [remark])
  useEffect(() => { cancelRef.current?.focus({ preventScroll: true }) }, [])
  const done = (out) => {
    if (doneRef.current) return
    doneRef.current = true
    onDone(out)
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
        <Button ref={cancelRef} variant="secondary" size="lg" icon={X} onClick={onCancel} data-testid="rebuild-scoresheet-cancel" className="shrink-0">
          {t('common.cancel', 'Cancel')}
        </Button>
        <div className="min-w-0 flex-1">
          <h2 id="rebuild-scoresheet-title" className="truncate text-sm font-semibold text-stone-900">{title}</h2>
          <p className="truncate text-[11px] font-medium text-stone-500">{t('manage.scoresheets.rebuilding', 'Making the new PDF from the match data…')}</p>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense fallback={<div className="ov-kit flex h-full items-center justify-center"><AppSpinner label={t('manage.scoresheets.rebuilding', 'Making the new PDF from the match data…')} /></div>}>
          <ScoresheetView matchData={matchData} autoAction="getBlob" readOnly embedded reservedTop={BAR_PX} extraRemarks={extraRemarks} onBlob={done} />
        </Suspense>
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
