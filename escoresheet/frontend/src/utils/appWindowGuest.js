/**
 * The page side of openAppWindow.js: a page (the scoresheet) opened as a
 * popup / app window (browser, desktop app) or inside the in-app view of the
 * Android app.
 */

import { MSG_CLOSE, MSG_SAVE_PDF, PDF_BUSY_FLAG, isInAppView } from './openAppWindow'

export { isInAppView }

/** The window that opened this page: the opener, or the app under the in-app view. */
export function getOpenerWindow(win = window) {
  try {
    if (win.opener && !win.opener.closed) return win.opener
  } catch { /* ignore */ }
  return isInAppView(win) ? win.parent : null
}

/**
 * This page is making / saving a PDF (true) or done (false). The desktop
 * app's quit question reads it from the scoretable (openAppWindow.js
 * pdfBusyInAppWindows): "A PDF is still being saved in the scoresheet window".
 */
export function setPdfBusy(busy, win = window) {
  try {
    win[PDF_BUSY_FLAG] = !!busy
  } catch { /* ignore */ }
}

/** Closes this page: the popup / app window, or the in-app view. */
export function closeAppWindow(win = window) {
  if (isInAppView(win)) {
    win.parent.postMessage({ type: MSG_CLOSE }, win.location.origin)
    return
  }
  win.close()
}

/**
 * In the in-app view, hands a PDF to the app to save (the WebView cannot
 * download a blob). Returns false elsewhere: the page saves it itself.
 */
export async function savePdfThroughApp(blob, filename, win = window) {
  if (!isInAppView(win)) return false
  const arrayBuffer = await blob.arrayBuffer()
  win.parent.postMessage({ type: MSG_SAVE_PDF, arrayBuffer, filename }, win.location.origin)
  return true
}

/** Messages to the window that asked for the PDF (MatchEnd's approval). */
export const MSG_PDF_BLOB = 'pdfBlob'
export const MSG_PDF_BLOB_FAILED = 'pdfBlobFailed'
/** The heartbeat while the PDF is made (scoresheetPdfRequest.js): { step }. */
export const MSG_PDF_PROGRESS = 'pdfProgress'
/**
 * The approval's request id in this page's URL (`pdfReq`, scoresheetPdfRequest.js).
 * Every answer carries it, so the approval ignores a window of an earlier
 * attempt (its late "closed" ended the new wait).
 */
export const PDF_REQUEST_PARAM = 'pdfReq'

function withRequestId(message, win) {
  let req = null
  try {
    req = new URLSearchParams(win.location?.search || '').get(PDF_REQUEST_PARAM)
  } catch { /* no URL: no id */ }
  return req ? { ...message, req } : message
}

/** Tells the opener the PDF is still being made. */
export function reportPdfProgress(progress = {}, win = window) {
  const opener = getOpenerWindow(win)
  if (!opener) return false
  try {
    opener.postMessage(withRequestId({ type: MSG_PDF_PROGRESS, step: progress.step ?? null }, win), win.location.origin)
    return true
  } catch {
    return false
  }
}

/**
 * While `isBusy()` (the approval's PDF is being made), closing this window
 * tells the opener at once ('pdfBlobFailed', reason 'closed'), so the
 * approval does not wait for a PDF that will never come. Returns the cleanup.
 */
export function watchPdfWindowClose(isBusy, win = window) {
  let sent = false
  const onLeave = () => {
    if (sent || !isBusy()) return
    const opener = getOpenerWindow(win)
    if (!opener) return
    sent = true
    try {
      opener.postMessage(withRequestId({ type: MSG_PDF_BLOB_FAILED, reason: 'closed' }, win), win.location.origin)
    } catch { /* opener gone */ }
  }
  win.addEventListener('pagehide', onLeave)
  win.addEventListener('beforeunload', onLeave)
  return () => {
    win.removeEventListener('pagehide', onLeave)
    win.removeEventListener('beforeunload', onLeave)
  }
}

/**
 * The end of a getBlob scoresheet (the match-end approval): hands the PDF to
 * the opener, or says it could not be made so the opener stops waiting, and
 * closes this window / in-app view either way. Without an opener nobody
 * waits: the page stays as it is.
 * @param {{ blob: Blob, filename: string } | null | undefined} result
 */
export async function deliverPdfToOpener(result, win = window) {
  const opener = getOpenerWindow(win)
  if (!opener) return false
  const origin = win.location.origin
  try {
    if (!result) throw new Error('no PDF')
    const arrayBuffer = await result.blob.arrayBuffer()
    opener.postMessage(withRequestId({ type: MSG_PDF_BLOB, arrayBuffer, filename: result.filename }, win), origin)
  } catch {
    // capture failed (e.g. the WebKitGTK data-URL limit of the desktop app)
    try { opener.postMessage(withRequestId({ type: MSG_PDF_BLOB_FAILED }, win), origin) } catch { /* opener gone */ }
  }
  closeAppWindow(win)
  return true
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether an `ov-download-finished` event (desktop app, src-tauri/src/popups.rs)
 * is about the file this page saved as `filename`. On Linux every window
 * hears every download (the match-end ZIP of the scoretable too); the saved
 * name may carry " (1)" when the file already existed. A failure without a
 * path counts while this page waits for its own download.
 * @param {{ path?: string|null, fileName?: string|null, success?: boolean }} detail
 * @param {string|null|undefined} filename the name this page asked to save
 */
export function isOwnDownload(detail, filename) {
  if (!filename || !detail) return false
  const name = detail.fileName || (detail.path ? String(detail.path).split(/[\\/]/).pop() : '')
  if (!name) return !detail.success
  if (name === filename) return true
  const dot = filename.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [filename.slice(0, dot), filename.slice(dot)] : [filename, '']
  return new RegExp(`^${escapeRegExp(stem)} \\(\\d+\\)${escapeRegExp(ext)}$`).test(name)
}
