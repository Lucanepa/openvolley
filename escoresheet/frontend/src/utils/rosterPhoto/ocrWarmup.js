/**
 * The photo import's recognition files loaded ahead on the web (owner,
 * 2026-11-26): at the first Match Setup, not at the first photo import, so a
 * photo import works offline even when the scorer never tried one online.
 * The service worker's OCR_FILES_ROUTE (pwa-workbox.js) keeps what is loaded
 * here, from the very addresses ocr.js starts Tesseract with (ocrFiles.js):
 * the worker, the engine this device runs and the three languages, ~12 MB;
 * and the handwriting reader's (handReader.js: its engine and model, ~25 MB),
 * on a device that can run it (WebAssembly SIMD).
 *
 * Only on the web with a service worker in charge (the Android, iOS and
 * desktop apps carry the files in their build), online, the page visible,
 * Data Saver off, and once per tesseract.js and onnxruntime-web version: a flag after all files
 * came, or the files already in the cache. One file after another, at low
 * priority, once the page is idle; a failure is only logged, and tried again
 * at the next Match Setup.
 */

import { isNativeApp } from '../backendConfig'
import { isDesktopApp } from '../../diagnostics/popupForward'
import { HAND_ORT_VERSION, TESSERACT_VERSION, handPaths, ocrDir, ocrPaths, simdSupported } from './ocrFiles'

export const WARM_FLAG = `ov-ocr-files-${TESSERACT_VERSION}-hand-${HAND_ORT_VERSION}`
// after Match Setup is on screen: its own work first
const WARM_DELAY_MS = 4000
const IDLE_TIMEOUT_MS = 10000

const flagSet = (storage) => {
  try { return storage?.getItem(WARM_FLAG) === '1' } catch { return false }
}

/**
 * Whether to load the files now: the reasons not to, in order (null: go).
 * @returns {null | 'native' | 'no-service-worker' | 'offline' | 'hidden' | 'save-data' | 'done'}
 */
export function warmUpBlocker ({
  win = typeof window !== 'undefined' ? window : undefined,
  nav = typeof navigator !== 'undefined' ? navigator : undefined,
  storage = (() => { try { return win?.localStorage } catch { return null } })()
} = {}) {
  if (!win || !nav) return 'native'
  if (isNativeApp() || isDesktopApp(win) || win.electronAPI) return 'native'
  // (without a service worker in charge nothing would keep the files)
  if (!nav.serviceWorker?.controller) return 'no-service-worker'
  if (nav.onLine === false) return 'offline'
  if (win.document?.visibilityState && win.document.visibilityState !== 'visible') return 'hidden'
  if (nav.connection?.saveData) return 'save-data'
  if (flagSet(storage)) return 'done'
  return null
}

/** The addresses ocr.js will load on this device (the handwriting reader's only with SIMD: it needs it). */
export async function warmUpUrls ({ dir = ocrDir(), handDir, simd } = {}) {
  const withSimd = simd ?? await simdSupported()
  return [...ocrPaths(dir, withSimd).urls, ...(withSimd ? handPaths(handDir).urls : [])]
}

let running = null

/**
 * Load the files (unless they are in the cache already) and set the flag.
 * Resolves 'cached', 'loaded' or 'failed'; never throws.
 */
export function warmUpOcrFiles ({
  urls,
  fetchFn = typeof fetch === 'function' ? fetch : null,
  cachesApi = typeof caches !== 'undefined' ? caches : null,
  storage = (() => { try { return window.localStorage } catch { return null } })(),
  log = (...a) => console.debug('[RosterPhoto] OCR files', ...a)
} = {}) {
  if (running) return running
  running = (async () => {
    try {
      const list = urls || await warmUpUrls()
      if (cachesApi) {
        const found = await Promise.all(list.map((u) => cachesApi.match(u).catch(() => undefined)))
        if (found.every(Boolean)) {
          try { storage?.setItem(WARM_FLAG, '1') } catch { /* private mode: the cache check does it next time */ }
          return 'cached'
        }
      }
      for (const u of list) {
        const res = await fetchFn(u, { priority: 'low', credentials: 'same-origin' })
        if (!res?.ok) throw new Error(`${u}: ${res?.status}`)
        // read to the end (the service worker keeps the response); a Blob, not held as an array
        await res.blob()
      }
      try { storage?.setItem(WARM_FLAG, '1') } catch { /* see above */ }
      log('loaded for offline use')
      return 'loaded'
    } catch (err) {
      log('not loaded, next Match setup tries again:', err?.message || err)
      return 'failed'
    } finally {
      running = null
    }
  })()
  return running
}

/**
 * At Match Setup's mount: the warm-up when the page is idle, if it is
 * needed. Returns a function that cancels what has not started yet.
 */
export function scheduleOcrWarmUp ({ delayMs = WARM_DELAY_MS, blocker = warmUpBlocker, start = warmUpOcrFiles } = {}) {
  if (blocker()) return () => {}
  let idle = null
  const timer = setTimeout(() => {
    const go = () => { idle = null; if (!blocker()) start() }
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(go, { timeout: IDLE_TIMEOUT_MS })
    else go()
  }, delayMs)
  return () => {
    clearTimeout(timer)
    if (idle !== null && typeof window !== 'undefined') window.cancelIdleCallback?.(idle)
  }
}
