/**
 * The match-end scoresheet PDF in the activity log (kind `scoresheet.pdf`,
 * docs/activity-log-spec.md): asked for, received, failed, cancelled, not
 * queued, or the match approved without it. A PDF lost at the approval (its
 * window closed before the PDF arrived, 3.2.6) left no trace before.
 *
 * Data: step, purpose ('approval' | 'missing'), attempt, reason (PDF_FAIL),
 * bytes, ms. No personal data. Never throws.
 *
 * `timing` (after `received`): where the PDF's time went on this device, as
 * numbers in `reason` (pdfTimingText), so the activity catalog (the app's,
 * the server's and OpenBeach's copy) stays as it is.
 */
import { emitActivity } from './activity/bus'

export const PDF_LOG_KIND = 'scoresheet.pdf'

/** Level of each step: a failure the scorer can retry is a warning, the approval without the PDF an error. */
export const PDF_LOG_LEVEL = Object.freeze({
  requested: 'info',
  received: 'info',
  timing: 'info',
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

// The capture's steps as the scoresheet page reports them (App_Scoresheet
// reportStep), each with the time it took there
const PAGE_STEPS = ['styles', 'canvas', 'retry', 'jpeg', 'pdf']

const num = (v, digits = 0) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const f = 10 ** digits
  return Math.round(v * f) / f
}

/**
 * Where an approval PDF's time went, as `key=value` numbers (at most ~150
 * characters; no personal data):
 * - load: from the request until the page began the capture (heard here),
 *   capture: from then until the PDF came, page: the page's own time until
 *   it began (its load, read and first render);
 * - styles, canvas, retry, jpeg, pdf: each capture step, as the page timed
 *   it (heard late on the Android in-app view, which shares this thread);
 * - events: the match's events; dpr: devicePixelRatio; zoom: the text zoom
 *   (measuredTextZoom).
 * @param {Record<string, { at: number, ms?: number }>} heard  each step when first heard (ms since the request) and its own ms
 * @param {number} totalMs  from the request until the PDF came
 * @param {{ events?: number, dpr?: number, zoom?: number|null }} [device]
 */
export function pdfTimingText(heard, totalMs, { events, dpr, zoom } = {}) {
  const parts = []
  const put = (key, value) => { if (value != null) parts.push(`${key}=${value}`) }
  const capture = heard?.capture
  if (capture && Number.isFinite(capture.at)) {
    put('load', num(capture.at))
    put('capture', num(totalMs - capture.at))
    put('page', num(capture.ms))
  }
  for (const step of PAGE_STEPS) put(step, num(heard?.[step]?.ms))
  put('events', num(events))
  put('dpr', num(dpr, 2))
  put('zoom', num(zoom, 2))
  return parts.join(' ')
}

/**
 * The text zoom this window's browser applies (the Android app's WebView:
 * the system font size): the computed size of a 100px span / 100, else null.
 */
export function measuredTextZoom(doc = typeof document !== 'undefined' ? document : null) {
  try {
    const win = doc?.defaultView
    if (!doc?.body || typeof win?.getComputedStyle !== 'function') return null
    const span = doc.createElement('span')
    span.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;font-size:100px;line-height:1'
    span.textContent = 'x'
    doc.body.appendChild(span)
    try {
      const px = parseFloat(win.getComputedStyle(span).fontSize)
      return Number.isFinite(px) && px > 0 ? px / 100 : null
    } finally {
      span.remove()
    }
  } catch {
    return null
  }
}
