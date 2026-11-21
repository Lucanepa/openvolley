import { lazy, Suspense, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Maximize2, TableProperties, ZoomIn, ZoomOut } from 'lucide-react'
import { Modal } from '../../ui/Modal.jsx'
import { Button } from '../../ui/Button.jsx'
import { IconButton } from '../../ui/IconButton.jsx'
import { SegmentedControl } from '../../ui/SegmentedControl.jsx'
import { AppSpinner } from '../../ui/AppSpinner.jsx'
import { displaySetNumber } from '../../utils/matchFormat'

// The set's drawing (the sheet's own components and model) loads when the
// scorer first opens the preview: the scoreboard's bundle stays as it was.
// The chunk is precached with every other script (pwa-workbox.js), so it
// opens offline too.
const SetPreview = lazy(() => import('../../../scoresheet_pdf/SetPreview'))

const ZOOM_STEP = 0.25
// SetPreview's ZOOM_MIN / ZOOM_MAX (not imported: that would pull the sheet into this chunk)
const ZOOM_MIN = 0.5
const ZOOM_MAX = 4
// a zoom button at its limit (the kit's outline icon button has no disabled look of its own)
const DIMMED = 'disabled:opacity-40 disabled:cursor-default disabled:hover:bg-white disabled:hover:border-stone-300'

/** The sets the preview offers: every set recorded so far, once per index, in order (set 1 before any). */
export function previewSetIndices(sets) {
  const indices = [...new Set((Array.isArray(sets) ? sets : [])
    .map(s => Number(s?.index))
    .filter(i => Number.isInteger(i) && i >= 1 && i <= 5))]
    .sort((a, b) => a - b)
  return indices.length > 0 ? indices : [1]
}

/** The set shown first: the one in play (the scoreboard's current set), else the last one recorded. */
export function currentPreviewSet(data, indices = previewSetIndices(data?.sets)) {
  const current = Number(data?.set?.index)
  return indices.includes(current) ? current : indices[indices.length - 1]
}

/**
 * The scorer's "Set preview" (Match menu): one set exactly as the paper
 * scoresheet prints it (scoresheet_pdf/SetPreview: the PDF's own components
 * and model), the set in play first, any set recorded so far a tap away.
 * Read only. It draws the scoreboard's live data, so every rally, time-out
 * and substitution shows as it is recorded. Fitted to the dialog's width;
 * the zoom buttons and two fingers zoom it (it then scrolls sideways).
 *
 * @param {object} props
 * @param {object} props.data the scoreboard's live data ({ match, homeTeam, awayTeam,
 *   homePlayers, awayPlayers, sets, events, set })
 * @param {() => void} props.onClose
 */
export default function SetPreviewModal({ data, onClose }) {
  const { t } = useTranslation()
  const bestOf = data?.match?.bestOf
  const indices = useMemo(() => previewSetIndices(data?.sets), [data?.sets])
  const current = currentPreviewSet(data, indices)
  // follows the set in play until the scorer picks one
  const [picked, setPicked] = useState(null)
  const setIndex = picked !== null && indices.includes(picked) ? picked : current
  const [zoom, setZoom] = useState(1)

  // The sheet's input (utils/matchData), as this device's scoresheet window reads it
  const matchData = useMemo(() => (data?.match
    ? {
        match: data.match,
        homeTeam: data.homeTeam,
        awayTeam: data.awayTeam,
        homePlayers: data.homePlayers,
        awayPlayers: data.awayPlayers,
        sets: data.sets,
        events: data.events
      }
    : null), [data])

  const setLabel = (index) => t('setPreview.setTab', 'Set {{n}}', { n: displaySetNumber(index, bestOf) })
  const zoomBy = (step) => setZoom(z => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((z + step) * 100) / 100)))

  return (
    // Over the scoreboard and its toolbar, as its other dialogs (Modal: 1000)
    <div className="ov-kit" style={{ position: 'relative', zIndex: 1000 }}>
      <Modal
        open
        onClose={onClose}
        layout="sections"
        size="xl"
        icon={TableProperties}
        title={t('setPreview.title', 'Set preview')}
        description={t('setPreview.description', 'The set as it prints on the scoresheet. It updates with every rally.')}
        closeLabel={t('common.close', 'Close')}
        className="max-w-[80rem]"
        bodyClassName="px-3 sm:px-5 [scrollbar-gutter:stable]"
        footer={(
          <Button variant="dark" size="lg" onClick={onClose} data-testid="set-preview-close">
            {t('common.close', 'Close')}
          </Button>
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2" data-testid="set-preview-controls">
          <SegmentedControl
            ariaLabel={t('setPreview.sets', 'Sets')}
            options={indices.map(i => ({ value: String(i), label: setLabel(i) }))}
            value={String(setIndex)}
            onChange={(v) => setPicked(Number(v))}
            className="min-w-0"
          />
          <div className="flex items-center gap-1.5">
            <IconButton label={t('setPreview.zoomOut', 'Zoom out')} icon={ZoomOut} onClick={() => zoomBy(-ZOOM_STEP)} disabled={zoom <= ZOOM_MIN} className={DIMMED} />
            <Button variant="secondary" icon={Maximize2} onClick={() => setZoom(1)} data-testid="set-preview-fit">
              {t('setPreview.fit', 'Fit to width')}
            </Button>
            <IconButton label={t('setPreview.zoomIn', 'Zoom in')} icon={ZoomIn} onClick={() => zoomBy(ZOOM_STEP)} disabled={zoom >= ZOOM_MAX} className={DIMMED} />
          </div>
        </div>
        {matchData ? (
          <Suspense
            fallback={(
              <div className="flex h-40 items-center justify-center">
                <AppSpinner size={56} label={t('setPreview.loading', 'Loading the set preview...')} />
              </div>
            )}
          >
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-2 sm:p-3">
              <SetPreview matchData={matchData} setIndex={setIndex} zoom={zoom} onZoomChange={setZoom} />
            </div>
          </Suspense>
        ) : null}
      </Modal>
    </div>
  )
}
