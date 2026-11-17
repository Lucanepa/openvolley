/**
 * The match-end approval's PDF: MatchEnd opens the scoresheet with
 * action=getBlob (an app window, a popup or the Android in-app view) and the
 * page answers by postMessage (appWindowGuest.js):
 *
 * - `pdfProgress` while it works (a heartbeat, once a second),
 * - `pdfBlob` with the PDF, or
 * - `pdfBlobFailed` when it could not make it (`reason: 'closed'` when its
 *   window is closed while the PDF is being made).
 *
 * Closing the scoresheet window while it made the PDF left the scorer
 * waiting up to 30 s with nothing to press (OpenBeach video 2026-10-08, the
 * same code here). Now the wait ends at once when the page says on pagehide
 * that it was closed, soon when the window is seen gone (polled; its PDF may
 * still be on the way: PDF_CLOSED_GRACE_MS), when the page stops sending
 * its heartbeat, on the scorer's Cancel (an AbortSignal) or after a hard
 * timeout, and the error says which (`error.reason`, one of PDF_FAIL).
 *
 * The stall and the hard timeout count only the time this window could
 * have heard the page. The Android app's in-app view (openAppWindow.js) is
 * an iframe of this page: same origin, same renderer, ONE main thread. While
 * the scoresheet captures its sheet (html-to-image's style copy, toDataURL)
 * that thread runs nothing else: no heartbeat leaves the page and no timer
 * runs here. On a slow tablet (Galaxy Tab A7 Lite, league match 2026-11-17)
 * the capture held it longer than PDF_STALL_MS; once free, the expired stall
 * timer ran before the page's next heartbeat, closed the view and threw the
 * almost finished PDF away ("The scoresheet window stopped answering", then
 * "Approve without PDF"). Reproduced on the emulator with the CPU slowed
 * 20x: one 48 s block, failed as stalled after 58 s. So a watchdog ticks
 * every PDF_CLOSED_POLL_MS and a tick that comes more than PDF_BLOCKED_TICK_MS
 * late (the thread was busy: the page is working, or the tablet slept)
 * counts as one tick only. A popup or desktop window (its own thread) is
 * timed as before: every tick comes on time.
 *
 * Each wait has a request id: `open(requestId)` puts it in the window's URL
 * (`pdfReq`, PDF_REQUEST_PARAM) and the page echoes it as `req`. An answer
 * for another request (a window of an earlier attempt, closed by Cancel or a
 * stall, whose pagehide comes late) is ignored; one without `req` counts.
 */

import { MSG_PDF_BLOB, MSG_PDF_BLOB_FAILED, MSG_PDF_PROGRESS, PDF_REQUEST_PARAM } from './appWindowGuest'

export { PDF_REQUEST_PARAM }

let requestSeq = 0
function newRequestId() {
  requestSeq += 1
  return `${Date.now().toString(36)}-${requestSeq}-${Math.random().toString(36).slice(2, 8)}`
}

/** Hard limit for the whole PDF (a closed window or a lost heartbeat ends a stuck wait first). */
export const PDF_TIMEOUT_MS = 90000
/**
 * No heartbeat for this long after the first one: the page is gone or stuck.
 * Generous: the one-page capture (html-to-image, toDataURL) can hold the
 * window's main thread for seconds in the Linux desktop app (WebKitGTK).
 */
export const PDF_STALL_MS = 20000
/** How often the opened window is checked for being closed. */
export const PDF_CLOSED_POLL_MS = 500
/**
 * Seen closed by that check: how long its answer may still come. The page
 * posts its PDF and closes itself at once (deliverPdfToOpener), and WebKit
 * (the Linux and macOS desktop apps, Safari, iPad) can show the window as
 * closed before the PDF message, a large ArrayBuffer, is delivered: failed
 * at once, the approval said "The scoresheet window was closed before the
 * PDF was ready" and dropped the PDF that came a moment later (reproduced in
 * Playwright WebKit, 2026-11-15). A window the scorer closes while the PDF
 * is made still fails at once: its page says so on pagehide.
 */
export const PDF_CLOSED_GRACE_MS = 2000
/**
 * A watchdog tick this much later than due: this window's main thread was
 * blocked meanwhile (the in-app view's page shares it), so that time does
 * not count toward the stall or the hard timeout.
 */
export const PDF_BLOCKED_TICK_MS = 2000

/** Why no PDF came. */
export const PDF_FAIL = Object.freeze({
  CLOSED: 'closed',
  STALLED: 'stalled',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  BLOCKED: 'blocked',
  FAILED: 'failed'
})

function pdfError(reason, message) {
  const e = new Error(message)
  e.reason = reason
  return e
}

/** Whether the window / in-app view openAppWindow returned has gone away. */
export function openedWindowClosed(opened) {
  if (!opened) return false
  try {
    if (typeof opened.isClosed === 'function') return opened.isClosed() === true
    return opened.window ? opened.window.closed === true : false
  } catch {
    return false // not readable: unknown, the heartbeat decides
  }
}

function closeOpened(opened) {
  try {
    if (opened?.close) opened.close()
    else opened?.window?.close?.()
  } catch { /* already gone */ }
}

/**
 * Opens the scoresheet through `open()` (an openAppWindow call) and resolves
 * with { blob, filename } when its PDF arrives. Rejects with an Error whose
 * `reason` is one of PDF_FAIL. On a stall, timeout or cancel the window is
 * closed, so none is left behind.
 * @param {(requestId: string) => ({ ok?: boolean, window?: Window|null, close?: () => void, isClosed?: () => boolean } | undefined)} open
 *   opens the page with `pdfReq=<requestId>` in its URL
 * @param {{ win?: Window, timeoutMs?: number, stallMs?: number, pollMs?: number, closedGraceMs?: number, blockedTickMs?: number, now?: () => number, signal?: AbortSignal, onProgress?: (p: { step: string|null }) => void, requestId?: string }} [opts]
 */
export function waitForScoresheetPdf(open, {
  win = window,
  timeoutMs = PDF_TIMEOUT_MS,
  stallMs = PDF_STALL_MS,
  pollMs = PDF_CLOSED_POLL_MS,
  closedGraceMs = PDF_CLOSED_GRACE_MS,
  blockedTickMs = PDF_BLOCKED_TICK_MS,
  now = () => Date.now(),
  signal,
  onProgress,
  requestId = newRequestId()
} = {}) {
  let opened
  let settled = false
  let watchdog = null
  let closedTimer = null
  let onAbort = null
  // Time this window could have heard the page (see the header): since the
  // start (hard timeout) and since the last heartbeat (stall; null until the
  // first one: the page's load time does not count, the hard timeout and the
  // closed-window check cover a page that never loads)
  let waited = 0
  let silent = null
  let lastTick = now()
  let watching = false // the window is open: check whether it closes
  let closedSeen = false

  return new Promise((resolve, reject) => {
    const done = () => {
      settled = true
      clearInterval(watchdog)
      clearTimeout(closedTimer)
      win.removeEventListener('message', handler)
      if (onAbort) signal?.removeEventListener?.('abort', onAbort)
    }
    const fail = (reason, message, { close = true } = {}) => {
      if (settled) return
      done()
      if (close) closeOpened(opened)
      reject(pdfError(reason, message))
    }
    const armStall = () => { silent = 0 }
    const tick = () => {
      if (settled) return
      const t = now()
      const late = t - lastTick
      lastTick = t
      // Late: this thread was blocked (the page capturing in the in-app view,
      // or the tablet asleep): one tick, not the whole gap
      const counted = late > blockedTickMs ? pollMs : Math.max(0, late)
      waited += counted
      if (silent != null) silent += counted
      if (waited >= timeoutMs) return fail(PDF_FAIL.TIMEOUT, 'PDF generation timed out')
      if (silent != null && silent >= stallMs) return fail(PDF_FAIL.STALLED, 'The scoresheet window stopped answering')
      if (!watching || closedSeen || !openedWindowClosed(opened)) return
      // Its PDF may still be on the way (PDF_CLOSED_GRACE_MS): the listener
      // stays, and the wait fails only if nothing comes
      closedSeen = true
      closedTimer = setTimeout(() => fail(PDF_FAIL.CLOSED, 'The scoresheet window was closed before the PDF was ready', { close: false }), closedGraceMs)
    }

    function handler(event) {
      // only the app's own pages (same origin) answer
      if (event.origin !== win.location.origin) return
      // an answer for another request: a window of an earlier attempt
      const req = event.data?.req
      if (req != null && req !== requestId) return
      const type = event.data?.type
      if (type === MSG_PDF_PROGRESS) {
        if (settled) return
        armStall()
        try { onProgress?.({ step: event.data.step ?? null }) } catch { /* ignore */ }
      } else if (type === MSG_PDF_BLOB) {
        if (settled) return
        done()
        resolve({ blob: new Blob([event.data.arrayBuffer], { type: 'application/pdf' }), filename: event.data.filename })
      } else if (type === MSG_PDF_BLOB_FAILED) {
        if (event.data.reason === PDF_FAIL.CLOSED) fail(PDF_FAIL.CLOSED, 'The scoresheet window was closed before the PDF was ready', { close: false })
        else fail(PDF_FAIL.FAILED, 'The scoresheet could not create the PDF')
      }
    }

    if (signal?.aborted) {
      settled = true
      reject(pdfError(PDF_FAIL.CANCELLED, 'Cancelled'))
      return
    }
    win.addEventListener('message', handler)
    if (signal) {
      onAbort = () => fail(PDF_FAIL.CANCELLED, 'Cancelled')
      signal.addEventListener('abort', onAbort, { once: true })
    }
    // one watchdog: hard timeout, stall, closed window
    watchdog = setInterval(tick, pollMs)

    try {
      opened = open(requestId)
    } catch (e) {
      fail(PDF_FAIL.BLOCKED, e?.message || 'The scoresheet window could not be opened', { close: false })
      return
    }
    if (settled) return // cancelled while opening
    // nothing opened (a browser's popup blocker): no answer will come
    if (opened && opened.ok === false) {
      fail(PDF_FAIL.BLOCKED, 'The scoresheet window could not be opened', { close: false })
      return
    }
    // (open() itself may have held the thread: that is not the page's time)
    lastTick = now()
    watching = true
  })
}
