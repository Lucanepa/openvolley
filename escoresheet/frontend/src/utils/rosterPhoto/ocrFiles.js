/**
 * Where the photo import's text recognition files are, and which of them a
 * device loads (vite-plugin-ocr-assets.js puts them in the build as
 * ocr/<tesseract.js version>/): the worker, the engine this device runs
 * (with or without WebAssembly SIMD) and the German, French and Italian
 * language data; and the handwriting reader's (handFiles.js). ocr.js starts
 * Tesseract and handReader.js the reader from exactly these addresses, and
 * ocrWarmup.js loads the same ones ahead of time on the web, so a photo
 * import works offline later. Small on purpose: Match Setup imports it
 * without the recognition.
 */

import { version as TESSERACT_VERSION } from 'tesseract.js/package.json'
import { HAND_GLUE_FILE, HAND_MODEL, HAND_ORT_VERSION, HAND_WASM_JS_FILE } from './handFiles'

export { TESSERACT_VERSION, HAND_ORT_VERSION }
export const OCR_LANGS = ['deu', 'fra', 'ita']

/**
 * The language of the list, as the scorer picks it before the photo (owner
 * 27.11.2026: no default, a conscious pick), and the languages Tesseract
 * reads it with: fewer are faster, above all on a device with one worker
 * (measured on the real photos, docs/roster-photo-spec.md 3.3). German stays
 * beside French and Italian: the names on those lists are often
 * German-Swiss. 'other' (or a choice not known here): all three, as before.
 */
export const LIST_LANGUAGES = Object.freeze(['de', 'fr', 'it', 'other'])
const LANGS_OF = Object.freeze({ de: ['deu'], fr: ['fra', 'deu'], it: ['ita', 'deu'], other: OCR_LANGS })
export const ocrLangsFor = (choice) => [...(LANGS_OF[choice] || OCR_LANGS)]
export const OCR_CORE_SIMD = 'tesseract-core-simd-lstm.wasm.js'
export const OCR_CORE_PLAIN = 'tesseract-core-lstm.wasm.js'

const appBase = () => (typeof document !== 'undefined' ? document.baseURI : 'http://localhost/')
const ocrRoot = () => (import.meta.env?.BASE_URL || '/').replace(/^\.\//, '').replace(/\/?$/, '/')

/** Where the recognition's files are: ocr/<tesseract.js version>/ beside the app's pages. */
export function ocrDir (base = appBase()) {
  return new URL(`${ocrRoot()}ocr/${TESSERACT_VERSION}/`, base).href
}

/** Where the handwriting reader's files are (handFiles.js): ocr/hand-<onnxruntime-web version>/. */
export function handDir (base = appBase()) {
  return new URL(`${ocrRoot()}ocr/hand-${HAND_ORT_VERSION}/`, base).href
}

/** The handwriting reader's addresses (handReader.js loads them): { glueUrl, wasmJsUrl, modelUrl, urls }. */
export function handPaths (dir = handDir()) {
  const at = dir.replace(/\/?$/, '/')
  const glueUrl = `${at}${HAND_GLUE_FILE}`
  const wasmJsUrl = `${at}${HAND_WASM_JS_FILE}`
  const modelUrl = `${at}${HAND_MODEL.file}`
  return { glueUrl, wasmJsUrl, modelUrl, urls: [glueUrl, wasmJsUrl, modelUrl] }
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
