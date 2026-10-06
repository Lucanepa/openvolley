/**
 * The page side of openAppWindow.js: a page (the scoresheet) opened as a
 * popup / app window (browser, desktop app) or inside the in-app view of the
 * Android app.
 */

import { APP_VIEW_ATTR, MSG_CLOSE, MSG_SAVE_PDF } from './openAppWindow'

/** True inside the Android app's in-app view (an iframe of the app). */
export function isInAppView(win = window) {
  try {
    return win.parent !== win && !!win.frameElement?.hasAttribute?.(APP_VIEW_ATTR)
  } catch {
    return false // a cross-origin parent: not ours
  }
}

/** The window that opened this page: the opener, or the app under the in-app view. */
export function getOpenerWindow(win = window) {
  try {
    if (win.opener && !win.opener.closed) return win.opener
  } catch { /* ignore */ }
  return isInAppView(win) ? win.parent : null
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
