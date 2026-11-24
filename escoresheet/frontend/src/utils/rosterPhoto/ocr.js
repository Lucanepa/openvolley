/**
 * The text recognition of a photo import (docs/roster-photo-spec.md, plan A):
 * Tesseract.js on this device, with the app's own copy of its engine and of
 * the German, French and Italian language data (vite-plugin-ocr-assets.js,
 * ocr/<version>/). Nothing leaves the device and nothing needs a network,
 * except on the web, where the files load on the first photo import.
 *
 * readRosterPhoto(page) -> the imported roster (domain/importedRoster,
 * source 'ocr'), or an error with a code:
 *   ocr-load     the recognition could not start (the web offline before its
 *                first use; a WebView without WebAssembly)
 *   ocr-timeout  it took longer than OCR_TIMEOUT_MS
 *   ocr-empty    it read no player row
 *   ocr-cancelled  the scorer closed the dialog (opts.signal)
 */

import { version as TESSERACT_VERSION } from 'tesseract.js/package.json'
import { importedRosterOf } from '../../domain/importedRoster'
import { withTimeout, PDF_TIMEOUT_CODE } from '../parseRosterPdf'
import { rosterFromOcr, HANDWRITTEN_MAX } from './ocrRoster'
import { ringInRegion, ringScore } from './scan'

// a number counts as circled when ink rings it this fully (scan.js ringScore)
const CIRCLED_SCORE = 0.8

/**
 * The page's pixels asked about circles (ocrRoster rosterFromOcr): whether a
 * word is circled, and a circle in a region; nothing for a Blob.
 */
function circlesOn (page) {
  if (typeof page?.getContext !== 'function') return {}
  const { width, height } = page
  const rgba = page.getContext('2d').getImageData(0, 0, width, height).data
  const gray = new Uint8ClampedArray(width * height)
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = rgba[j]
  const ringAt = (region, line) => ringInRegion(gray, width, height, region, line)
  return {
    // a ring round the number's box, or one the recognition took into the box
    circled: (w) => {
      if (ringScore(gray, width, height, w) >= CIRCLED_SCORE) return true
      const h = w.y1 - w.y0
      return !!ringAt({ x0: w.x0 - h * 0.3, y0: w.y0 - h * 0.3, x1: w.x1 + h * 0.3, y1: w.y1 + h * 0.3 }, h / 1.6)
    },
    ringAt
  }
}

/**
 * The number inside a circle the first reading skipped: that box alone, cut
 * out into a small canvas (Tesseract encodes a canvas it is given as PNG on
 * the main thread: the whole page again would take seconds on a tablet),
 * digits only.
 */
async function readCircledNumber (worker, page, box) {
  const pad = Math.max(4, Math.round((box.y1 - box.y0) * 0.25))
  const left = Math.max(0, Math.floor(box.x0 - pad))
  const top = Math.max(0, Math.floor(box.y0 - pad))
  const width = Math.min(page.width - left, Math.ceil(box.x1 - box.x0 + 2 * pad))
  const height = Math.min(page.height - top, Math.ceil(box.y1 - box.y0 + 2 * pad))
  const cut = document.createElement('canvas')
  // white round the digits, as on paper
  cut.width = width + 2 * pad
  cut.height = height + 2 * pad
  const ctx = cut.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, cut.width, cut.height)
  ctx.drawImage(page, left, top, width, height, pad, pad, width, height)
  const { data } = await worker.recognize(cut, {}, { text: true })
  const m = /^\D*(\d{1,2})\D*$/.exec(String(data?.text || '').trim())
  return m && Number(m[1]) >= 1 ? { number: Number(m[1]), conf: (data.confidence ?? 0) / 100 } : null
}

export const OCR_LANGS = ['deu', 'fra', 'ita']
// A page in a few seconds on a desktop; a slow tablet takes far longer
// (Galaxy Tab A7 Lite). Past this the scorer gets a message, not a spinner.
export const OCR_TIMEOUT_MS = 120000
// Starting the worker: the engine and the three languages (~10 MB) read from the app's files
export const OCR_START_TIMEOUT_MS = 60000

const LSTM_ONLY = 1
// One block of text: the table's rows come out as lines across its columns
const PSM_SINGLE_BLOCK = '6'
// a circled number read again on its own
const PSM_SINGLE_WORD = '8'
const CIRCLE_TIMEOUT_MS = 10000

const coded = (code, message, cause) => Object.assign(new Error(message), { code, cause })

/** Where the recognition's files are: ocr/<tesseract.js version>/ beside the app's pages. */
export function ocrDir (base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/') {
  const root = (import.meta.env?.BASE_URL || '/').replace(/^\.\//, '')
  return new URL(`${root.replace(/\/?$/, '/')}ocr/${TESSERACT_VERSION}/`, base).href
}

/**
 * Whether this page may run WebAssembly at all: an empty module compiled
 * here (8 bytes). A page whose Content-Security-Policy forbids it, or an
 * engine without it, fails at once instead of after OCR_START_TIMEOUT_MS
 * (the worker dies inside, and Tesseract never answers).
 */
export function wasmAllowed () {
  try {
    // eslint-disable-next-line no-new
    new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))
    return true
  } catch {
    return false
  }
}

async function simdSupported () {
  try {
    const { simd } = await import('wasm-feature-detect')
    return await simd()
  } catch {
    return false
  }
}

/** Tesseract's createWorker (tests hand in their own). */
async function loadCreateWorker () {
  const mod = await import('tesseract.js/dist/tesseract.esm.min.js')
  return (mod.default || mod).createWorker
}

/**
 * The roster in the flat page of a photo (scan.js scanPage, as a canvas or
 * a Blob).
 * @param {HTMLCanvasElement|Blob} page
 * @param {{ onProgress?: (share: number, status: string) => void, signal?: AbortSignal, createWorker?: Function, timeoutMs?: number, startTimeoutMs?: number, dir?: string }} [opts]
 */
export async function readRosterPhoto (page, { onProgress, signal, createWorker, timeoutMs = OCR_TIMEOUT_MS, startTimeoutMs = OCR_START_TIMEOUT_MS, dir } = {}) {
  let worker = null
  // closing the dialog ends the worker at once (its memory and the tablet's CPU back)
  const cancelled = () => coded('ocr-cancelled', 'The reading was cancelled')
  const onAbort = () => { try { worker?.terminate?.() } catch { /* gone */ } }
  signal?.addEventListener?.('abort', onAbort)
  try {
    if (signal?.aborted) throw cancelled()
    if (!wasmAllowed()) throw coded('ocr-load', 'This page may not run WebAssembly (its Content-Security-Policy, or the engine)')
    try {
      const create = createWorker || await loadCreateWorker()
      const at = dir || ocrDir()
      const core = (await simdSupported()) ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'
      worker = await withTimeout(create(OCR_LANGS, LSTM_ONLY, {
        workerPath: `${at}worker.min.js`,
        corePath: `${at}${core}`,
        langPath: `${at}lang`,
        gzip: false,
        // the files are the app's own (or the service worker's on the web): no second copy in IndexedDB
        cacheMethod: 'none',
        // a worker from the app's own address, not a blob: URL
        workerBlobURL: false,
        logger: (m) => { if (onProgress && typeof m?.progress === 'number') onProgress(m.progress, m.status || '') }
      }), startTimeoutMs)
      await worker.setParameters({ tessedit_pageseg_mode: PSM_SINGLE_BLOCK, preserve_interword_spaces: '1' })
    } catch (err) {
      if (signal?.aborted) throw cancelled()
      throw coded('ocr-load', `The text recognition could not start (${err?.message || err})`, err)
    }
    if (signal?.aborted) throw cancelled()
    let data
    try {
      ;({ data } = await withTimeout(worker.recognize(page, {}, { blocks: true, text: false }), timeoutMs))
    } catch (err) {
      if (signal?.aborted) throw cancelled()
      if (err?.code === PDF_TIMEOUT_CODE) throw coded('ocr-timeout', 'The text recognition took too long', err)
      throw coded('ocr-load', `The text recognition stopped (${err?.message || err})`, err)
    }
    const parsed = rosterFromOcr(data, circlesOn(page))
    const ringed = parsed.players.filter((p) => p.ringAt)
    if (ringed.length && !signal?.aborted) {
      try {
        await worker.setParameters({ tessedit_pageseg_mode: PSM_SINGLE_WORD, tessedit_char_whitelist: '0123456789' })
        for (const p of ringed.slice(0, 4)) {
          const read = await withTimeout(readCircledNumber(worker, page, p.ringAt), CIRCLE_TIMEOUT_MS)
          if (read && !parsed.players.some((q) => q.number === read.number)) {
            p.number = read.number
            p.confidence = { ...p.confidence, number: Math.min(read.conf, HANDWRITTEN_MAX) }
          }
        }
      } catch { /* the captain stays marked; the number is the scorer's (or the saved team's) */ }
    }
    if (signal?.aborted) throw cancelled()
    const roster = importedRosterOf(parsed, 'ocr')
    if (!roster.players.length) throw coded('ocr-empty', 'No player row was read in the photo')
    return roster
  } finally {
    signal?.removeEventListener?.('abort', onAbort)
    // its memory (the three languages) back at once; a worker that never answers is ended too
    try { await worker?.terminate?.() } catch { /* already gone */ }
  }
}
