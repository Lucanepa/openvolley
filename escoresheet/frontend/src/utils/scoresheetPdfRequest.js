/**
 * The match-end approval's PDF: MatchEnd opens the scoresheet with
 * action=getBlob (an app window, a popup or the Android in-app view) and the
 * page answers by postMessage (deliverPdfToOpener in appWindowGuest.js):
 * the PDF, or that the capture failed.
 */

import { MSG_PDF_BLOB, MSG_PDF_BLOB_FAILED } from './appWindowGuest'

export const PDF_TIMEOUT_MS = 30000

/**
 * Opens the scoresheet through `open()` (an openAppWindow call) and resolves
 * with { blob, filename } when its PDF arrives. Rejects when the page says
 * the capture failed, or after `timeoutMs`; on a timeout the window / in-app
 * view is closed so it is not left behind.
 * @param {() => ({ window?: Window|null, close?: () => void } | undefined)} open
 */
export function waitForScoresheetPdf(open, { win = window, timeoutMs = PDF_TIMEOUT_MS } = {}) {
  let opened
  let fail
  const promise = new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer)
      win.removeEventListener('message', handler)
    }
    fail = (error) => { done(); reject(error) }
    const timer = setTimeout(() => {
      done()
      try {
        if (opened?.close) opened.close()
        else opened?.window?.close?.()
      } catch { /* already gone */ }
      reject(new Error('PDF generation timed out'))
    }, timeoutMs)

    function handler(event) {
      // only the app's own pages (same origin) answer
      if (event.origin !== win.location.origin) return
      const type = event.data?.type
      if (type === MSG_PDF_BLOB) {
        done()
        resolve({ blob: new Blob([event.data.arrayBuffer], { type: 'application/pdf' }), filename: event.data.filename })
      } else if (type === MSG_PDF_BLOB_FAILED) {
        done()
        reject(new Error('The scoresheet could not create the PDF'))
      }
    }
    win.addEventListener('message', handler)
  })
  try {
    opened = open()
    // nothing opened (a browser's popup blocker): no answer will come
    if (opened && opened.ok === false) fail(new Error('The scoresheet window could not be opened'))
  } catch (e) {
    fail(e)
  }
  return promise
}
