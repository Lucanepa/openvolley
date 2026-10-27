import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CloudOff, FileText } from 'lucide-react'
import Modal from './Modal'
import { Button, FormError } from '../ui'

/**
 * "Closed on the server": a copy this device was still scoring whose match
 * the server has closed (utils/matchReopen isStaleClosedCopy). It can no
 * longer be scored or synced, so it takes the place of the scoring screen
 * and cannot be dismissed. A phone reopened such a copy of match 406970 on
 * its scoring screen at every start and kept a sync error that Retry could
 * not clear (2026-10-23).
 * - Load the official version: the server's copy replaces this one (the
 *   take-back path of ScorerMovedModal); needs a connection and the game PIN
 *   this device kept. When that PIN does not load it, the game number and
 *   game PIN can be entered instead.
 * - Remove from this device: the delete dialog (game PIN); the server keeps
 *   its record.
 * - Scoresheet: this copy's scoresheet in its own window, to view, print or
 *   save (the copy opens read-only, the owner 2026-10-27: no scoring
 *   controls, the sheet stays reachable).
 * - Close: back to the home screen, the copy stays.
 * @param {{ onLoadOfficial: () => Promise<{ok?: boolean, error?: string}|void>|void,
 *   onRemove: () => void, onUsePin: () => void, onClose: () => void, onScoresheet?: () => void }} props
 */
export default function ClosedOnServerModal({ onLoadOfficial, onRemove, onUsePin, onClose, onScoresheet = null }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const loadOfficial = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await onLoadOfficial()
      if (r?.error) setError(LOAD_ERRORS[r.error] || 'failed')
    } catch {
      setError('failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('cloudBlock.closedCopy.title')} open={true} hideCloseButton={true} width={460} zIndex={3000}>
      <div className="ov-kit" data-testid="closed-copy-modal">
        <div role="alert" className="flex items-start gap-3 text-sm text-stone-700">
          <CloudOff size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-amber-700" />
          <p className="m-0">{t('cloudBlock.closedCopy.body')}</p>
        </div>
        {error && (
          <div className="mt-3" data-testid="closed-copy-error">
            <FormError size="md">{t(`cloudBlock.closedCopy.errors.${error}`)}</FormError>
          </div>
        )}
        {/* Wraps: on a phone the buttons go on two rows instead of out of the dialog */}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>
            {t('common.close')}
          </Button>
          {onScoresheet && (
            <Button variant="secondary" size="lg" icon={FileText} onClick={onScoresheet} disabled={busy}>
              {t('header.scoresheet')}
            </Button>
          )}
          <Button variant="danger-soft" size="lg" onClick={onRemove} disabled={busy}>
            {t('cloudBlock.closedCopy.remove')}
          </Button>
          {/* the PIN this device kept did not load it (or a restore by PIN
              answered 404, which reads as 'failed'): the restore dialog */}
          {error && error !== 'offline' && (
            <Button variant="secondary" size="lg" onClick={onUsePin} disabled={busy}>
              {t('cloudBlock.closedCopy.usePin')}
            </Button>
          )}
          <Button variant="dark" size="lg" onClick={loadOfficial} disabled={busy} aria-busy={busy || undefined}>
            {t('cloudBlock.closedCopy.loadOfficial')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// takeBackScoring's reasons (utils/matchHandover) -> the message shown
const LOAD_ERRORS = {
  offline: 'offline',
  noPin: 'needsPin',
  notFound: 'needsPin',
  otherMatch: 'needsPin',
  failed: 'failed'
}
