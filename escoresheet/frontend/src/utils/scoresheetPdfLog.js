/**
 * The match-end scoresheet PDF in the activity log (kind `scoresheet.pdf`,
 * docs/activity-log-spec.md): asked for, received, failed, cancelled, not
 * queued, or the match approved without it. A PDF lost at the approval (its
 * window closed before the PDF arrived, 3.2.6) left no trace before.
 *
 * Data: step, purpose ('approval' | 'missing'), attempt, reason (PDF_FAIL),
 * bytes, ms. No personal data. Never throws.
 */
import { emitActivity } from './activity/bus'

export const PDF_LOG_KIND = 'scoresheet.pdf'

/** Level of each step: a failure the scorer can retry is a warning, the approval without the PDF an error. */
export const PDF_LOG_LEVEL = Object.freeze({
  requested: 'info',
  received: 'info',
  cancelled: 'info',
  failed: 'warn',
  not_queued: 'warn',
  approved_without_pdf: 'error'
})

const KEYS = ['purpose', 'attempt', 'reason', 'bytes', 'ms']

/**
 * @param {keyof typeof PDF_LOG_LEVEL} step
 * @param {{ purpose?: string, attempt?: number, reason?: string, bytes?: number, ms?: number }} [data]
 * @param {{ matchId?: any }} [opts]
 */
export function logScoresheetPdf(step, data = {}, { matchId } = {}) {
  try {
    const out = { step }
    for (const k of KEYS) if (data?.[k] != null && data[k] !== '') out[k] = data[k]
    emitActivity(PDF_LOG_KIND, out, { level: PDF_LOG_LEVEL[step] || 'info', ...(matchId != null ? { matchId } : {}) })
  } catch {
    // logging never breaks the approval
  }
}
