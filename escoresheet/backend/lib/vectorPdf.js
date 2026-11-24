/**
 * The official scoresheet as a vector PDF (field-spec 17.20): the backend
 * hands a match record to the render service (escoresheet/render, compose
 * ov-render on a private network) and gets the PDF back. The service prints
 * the same scoresheet code the scorer's device and the manager draw, with
 * headless Chromium's page.pdf(): text, lines and the font in the file
 * instead of a 3100 x 2170 picture of the sheet.
 *
 * Off unless OV_RENDER_URL and OV_RENDER_TOKEN are set: every caller then
 * keeps today's raster PDF (the device's, or the manager's capture).
 *
 *   createVectorPdf({ url, token, timeoutMs, fetchImpl, logger })
 *     .enabled                         true when configured
 *     .render({ record, rebuildReason, rebuiltAt })
 *        -> { ok: true, pdf: Buffer, filename, ms, missingPictures (count) }
 *         | { ok: false, status, code, message }   (never throws)
 *
 * One request at a time from this process, at most `maxWaiting` waiting: the
 * service also renders one page at a time, and a 2-CPU host must never queue
 * up Chromium pages behind a burst of approvals.
 */

const DEFAULT_TIMEOUT_MS = 90_000

export function createVectorPdf ({ url, token, timeoutMs = DEFAULT_TIMEOUT_MS, maxWaiting = 6, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const base = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : ''
  const secret = typeof token === 'string' ? token.trim() : ''
  const enabled = !!base && secret.length >= 24 && typeof fetchImpl === 'function'
  let tail = Promise.resolve()
  let waiting = 0

  async function once ({ record, rebuildReason = null, rebuiltAt = null }) {
    const t0 = Date.now()
    let res
    try {
      res = await fetchImpl(`${base}/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ov-render-token': secret },
        body: JSON.stringify({ record, rebuildReason, rebuiltAt }),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      logger.error?.(`[vectorPdf] ${timedOut ? 'timed out' : 'unreachable'}: ${String(err?.message || err).slice(0, 200)}`)
      return { ok: false, status: timedOut ? 504 : 503, code: timedOut ? 'OV_RENDER_TIMEOUT' : 'OV_RENDER_UNREACHABLE', message: 'The PDF service did not answer' }
    }
    if (res.status !== 200) {
      let body = null
      try { body = await res.json() } catch { /* not JSON */ }
      logger.error?.(`[vectorPdf] render answered ${res.status} ${body?.code || ''} ${String(body?.error || '').slice(0, 200)}`)
      return { ok: false, status: res.status === 422 ? 422 : 503, code: body?.code || 'OV_RENDER_FAILED', message: 'The PDF service could not make the PDF' }
    }
    const pdf = Buffer.from(await res.arrayBuffer())
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      logger.error?.('[vectorPdf] the service answered something that is not a PDF')
      return { ok: false, status: 503, code: 'OV_RENDER_FAILED', message: 'The PDF service could not make the PDF' }
    }
    let filename = null
    try { filename = decodeURIComponent(res.headers.get('x-ov-filename') || '') || null } catch { /* keep null */ }
    // the pictures the print could not show (escoresheet/render: a signature that did not load)
    const missing = Number(res.headers.get('x-ov-missing-pictures'))
    return { ok: true, pdf, filename, ms: Date.now() - t0, missingPictures: Number.isInteger(missing) && missing > 0 ? missing : 0 }
  }

  function render (payload) {
    if (!enabled) return Promise.resolve({ ok: false, status: 503, code: 'OV_RENDER_UNAVAILABLE', message: 'The vector PDF is not set up on this server' })
    if (!payload?.record?.match) return Promise.resolve({ ok: false, status: 400, code: 'OV_INVALID', message: 'record.match required' })
    if (waiting >= maxWaiting) return Promise.resolve({ ok: false, status: 503, code: 'OV_RENDER_BUSY', message: 'The PDF service is busy' })
    waiting++
    const p = tail.then(() => { waiting--; return once(payload) })
    tail = p.catch(() => {})
    return p
  }

  return { enabled, render }
}
