/**
 * Where the photo import's text recognition files are, and which of them a
 * device loads (vite-plugin-ocr-assets.js puts them in the build as
 * ocr/<tesseract.js version>/): the worker, the engine this device runs
 * (with or without WebAssembly SIMD) and the German, French and Italian
 * language data. ocr.js starts Tesseract from exactly these addresses, and
 * ocrWarmup.js loads the same ones ahead of time on the web, so a photo
 * import works offline later. Small on purpose: Match Setup imports it
 * without the recognition.
 */

import { version as TESSERACT_VERSION } from 'tesseract.js/package.json'

export { TESSERACT_VERSION }
export const OCR_LANGS = ['deu', 'fra', 'ita']
export const OCR_CORE_SIMD = 'tesseract-core-simd-lstm.wasm.js'
export const OCR_CORE_PLAIN = 'tesseract-core-lstm.wasm.js'

/** Where the recognition's files are: ocr/<tesseract.js version>/ beside the app's pages. */
export function ocrDir (base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/') {
  const root = (import.meta.env?.BASE_URL || '/').replace(/^\.\//, '')
  return new URL(`${root.replace(/\/?$/, '/')}ocr/${TESSERACT_VERSION}/`, base).href
}

/** Whether this device's WebAssembly has SIMD (the faster engine). */
export async function simdSupported () {
  try {
    const { simd } = await import('wasm-feature-detect')
    return await simd()
  } catch {
    return false
  }
}

/**
 * The files Tesseract asks for, as ocr.js starts it: { workerPath, corePath,
 * langPath } (createWorker's options) and every address it then loads.
 */
export function ocrPaths (dir, simd) {
  const at = dir.replace(/\/?$/, '/')
  const workerPath = `${at}worker.min.js`
  const corePath = `${at}${simd ? OCR_CORE_SIMD : OCR_CORE_PLAIN}`
  const langPath = `${at}lang`
  return { workerPath, corePath, langPath, urls: [workerPath, corePath, ...OCR_LANGS.map((l) => `${langPath}/${l}.traineddata`)] }
}
