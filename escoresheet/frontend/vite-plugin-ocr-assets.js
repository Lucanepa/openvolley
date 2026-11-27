import { readFileSync } from 'fs'
import { gunzipSync } from 'zlib'
import { createHash } from 'crypto'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { HAND_GLUE_FILE, HAND_MODEL, HAND_NOTICE_FILE, HAND_ORT_VERSION, HAND_WASM_JS_FILE } from './src/utils/rosterPhoto/handFiles.js'

/**
 * The files the photo import's text recognition needs (Tesseract.js, plan A
 * of docs/roster-photo-spec.md), copied from node_modules into the build as
 * ocr/<tesseract.js version>/ (OCR_DIR in src/utils/rosterPhoto/ocr.js):
 *
 *   worker.min.js                       the recognition worker
 *   tesseract-core-simd-lstm.wasm.js    the engine, for a WebView with WASM SIMD
 *   tesseract-core-lstm.wasm.js         the engine without SIMD (older WebKit)
 *   lang/deu.traineddata (fra, ita)     the three languages of an Einsatzliste
 *
 * and those of the handwriting reader (src/utils/rosterPhoto/handFiles.js,
 * handReader.js) as ocr/hand-<onnxruntime-web version>/:
 *
 *   ort-wasm-simd-threaded.mjs          onnxruntime-web's loader of its engine
 *   ort-wasm-simd-threaded.wasm.js      its engine, the WebAssembly as base64 in a script
 *   PP-OCRv6_rec_tiny.onnx              the model, committed in vendor/ppocr/ (no network
 *                                       at build time), checked by its SHA-256
 *   NOTICE.txt                          vendor/ppocr/NOTICE.txt: the model's attribution,
 *                                       its licence and the engine's
 *
 * Bundled with the app, never from a CDN: the import works offline, on a
 * LAN-only venue box, and under the pages' script-src 'self'. Only the LSTM
 * engine (OEM 1) and the "best_int" models: the smallest pair that reads
 * printed lists well. The language data is written decompressed and both
 * engines as .wasm.js (the WebAssembly inside a script): F-Droid's scanner
 * refuses .gz and .wasm files in the build (fdroidserver scanner.py; .onnx,
 * .mjs and .traineddata pass).
 *
 * Kept out of the web app's precache (pwa-workbox.js PRECACHE_GLOB_IGNORES,
 * OCR_FILES_ROUTE): the web loads them at the first Match setup
 * (ocrWarmup.js). The Android and desktop apps carry them in their files.
 *
 * The model: vendor/ppocr/PP-OCRv6_rec_tiny.onnx, or the file OV_HAND_MODEL
 * names (an override); bytes other than handFiles.js HAND_MODEL.sha256 fail
 * the build. Nothing is downloaded.
 */

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))

export const OCR_LANGS = Object.freeze(['deu', 'fra', 'ita'])
export const OCR_CORE_FILES = Object.freeze(['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'])

/** The tesseract.js version: the folder's name, so a new version is a new address (no stale cache). */
export function ocrVersion () {
  return require('tesseract.js/package.json').version
}

// onnxruntime-web's dist folder (its package exports no package.json: found through its entry)
const ortDist = () => dirname(require.resolve('onnxruntime-web'))

/** onnxruntime-web's version, which must be handFiles.js HAND_ORT_VERSION (the folder's name). */
export function ortVersion () {
  const { version } = JSON.parse(readFileSync(join(ortDist(), '..', 'package.json'), 'utf8'))
  if (version !== HAND_ORT_VERSION) throw new Error(`onnxruntime-web is ${version}, src/utils/rosterPhoto/handFiles.js says ${HAND_ORT_VERSION}: set both to the same version`)
  return version
}

/**
 * The handwriting reader's worker imports onnxruntime-web/wasm: its build that
 * loads the engine from the addresses it is given (ocr/hand-<version>/), not the
 * default one that has Vite copy ort-wasm-simd-threaded.wasm into assets/ (a
 * .wasm file in the build: F-Droid). For vite.config.js and build-subdomains.js.
 */
export const ORT_WASM_ALIAS = Object.freeze({ find: /^onnxruntime-web\/wasm$/, replacement: join(HERE, 'node_modules', 'onnxruntime-web', 'dist', 'ort.wasm.min.mjs') })

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** onnxruntime-web's WebAssembly as a script (F-Droid): `export default "<base64>"` (handModel.js wasmOfScript). */
export function wasmScript (wasm, version = HAND_ORT_VERSION) {
  return Buffer.from(`/*! onnxruntime-web ${version} (MIT, Microsoft Corporation): ort-wasm-simd-threaded.wasm, base64 (vite-plugin-ocr-assets.js) */\nexport default "${Buffer.from(wasm).toString('base64')}"\n`)
}

// the model and its notice, committed (vendor/ppocr/: the model as RapidOCR 3.10.0 distributes it)
export const HAND_MODEL_PATH = join(HERE, 'vendor', 'ppocr', HAND_MODEL.file)
export const HAND_NOTICE_PATH = join(HERE, 'vendor', 'ppocr', HAND_NOTICE_FILE)

/** The notice beside the model (vendor/ppocr/NOTICE.txt): where it comes from, its licence (Apache-2.0) and the engine's (MIT). */
export function handNotice () {
  return readFileSync(HAND_NOTICE_PATH)
}

/**
 * The model's bytes: vendor/ppocr/'s, or OV_HAND_MODEL's file (an override),
 * checked against the pinned SHA-256 (another file fails the build).
 * @param {{ path?: string, model?: { file: string, sha256: string } }} [opts]
 */
export function handModelBytes ({ path = process.env.OV_HAND_MODEL || HAND_MODEL_PATH, model = HAND_MODEL } = {}) {
  let buf
  try { buf = readFileSync(path) } catch (err) { throw new Error(`The handwriting model ${model.file} is missing (${path}): ${err.message}`) }
  const got = sha256(buf)
  if (got !== model.sha256) throw new Error(`${path} is not ${model.file}: SHA-256 ${got}, not ${model.sha256}`)
  return buf
}

/** [{ fileName, read() }] of every file, fileName relative to the build's root. */
export function ocrFiles () {
  const dir = `ocr/${ocrVersion()}`
  const hand = `ocr/hand-${ortVersion()}`
  return [
    { fileName: `${dir}/worker.min.js`, read: () => readFileSync(require.resolve('tesseract.js/dist/worker.min.js')) },
    ...OCR_CORE_FILES.map((name) => ({ fileName: `${dir}/${name}`, read: () => readFileSync(require.resolve(`tesseract.js-core/${name}`)) })),
    ...OCR_LANGS.map((lang) => ({
      fileName: `${dir}/lang/${lang}.traineddata`,
      read: () => gunzipSync(readFileSync(require.resolve(`@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`)))
    })),
    { fileName: `${hand}/${HAND_GLUE_FILE}`, read: () => readFileSync(join(ortDist(), HAND_GLUE_FILE)) },
    { fileName: `${hand}/${HAND_WASM_JS_FILE}`, read: () => wasmScript(readFileSync(join(ortDist(), 'ort-wasm-simd-threaded.wasm'))) },
    { fileName: `${hand}/${HAND_MODEL.file}`, read: () => handModelBytes() },
    { fileName: `${hand}/${HAND_NOTICE_FILE}`, read: () => handNotice() }
  ]
}

const TYPES = { js: 'text/javascript', mjs: 'text/javascript', txt: 'text/plain; charset=utf-8' }

/**
 * Vite plugin: the files in the build (emitted as they are, no hash: the
 * worker asks for the engine and the languages by name), and served by the
 * dev server under the same addresses.
 * @param {{ enabled?: boolean }} [opts] false: a build without the scorer's Match Setup
 */
export function ocrAssets ({ enabled = true } = {}) {
  let files = null
  const all = () => (files ??= ocrFiles())
  // (a file read once: the base64 engine is ~20 MB)
  const cache = new Map()
  const bytesOf = (f) => { if (!cache.has(f.fileName)) cache.set(f.fileName, f.read()); return cache.get(f.fileName) }
  return {
    name: 'ov-ocr-assets',
    configureServer (server) {
      if (!enabled) return
      server.middlewares.use((req, res, next) => {
        const path = String(req.url || '').split('?')[0].replace(/^\/+/, '')
        const file = path.startsWith('ocr/') && all().find((f) => f.fileName === path)
        if (!file) return next()
        let body
        try { body = bytesOf(file) } catch (err) { res.statusCode = 500; res.end(String(err.message)); return }
        res.setHeader('Content-Type', TYPES[path.split('.').pop()] || 'application/octet-stream')
        res.end(body)
      })
    },
    buildStart () {
      if (!enabled) return
      // the model's SHA-256 checked before anything is built
      handModelBytes()
    },
    generateBundle () {
      if (!enabled) return
      for (const f of all()) this.emitFile({ type: 'asset', fileName: f.fileName, source: bytesOf(f) })
    }
  }
}
