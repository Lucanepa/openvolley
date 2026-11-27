import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
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
 *   PP-OCRv6_rec_tiny.onnx              the model, downloaded once from RapidOCR's
 *                                       release record and checked by its SHA-256
 *   NOTICE.txt                          the model's attribution, its licence and the engine's
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
 * The model: from OV_HAND_MODEL (a copy on disk, for a build without
 * network) when its SHA-256 is right, else from the cache in
 * node_modules/.cache/ov-hand-model, else downloaded (and cached). Other
 * bytes fail the build. OV_HAND_MODEL=skip builds without it (an emergency:
 * the handwriting reader then cannot load and Tesseract reads the marks).
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

const MIT_ORT = `MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

/** The notice beside the model: where it comes from, its licence (Apache-2.0) and the engine's (MIT). */
export function handNotice () {
  const apache = readFileSync(require.resolve('tesseract.js-core/LICENSE'), 'utf8')
  return Buffer.from(`${HAND_MODEL.file}

PP-OCRv6 rec tiny, the text recognition model of PaddleOCR
(https://github.com/PaddlePaddle/PaddleOCR), converted to ONNX by RapidOCR
(https://github.com/RapidAI/RapidOCR) and distributed by it (release 3.10.0,
${HAND_MODEL.url},
SHA-256 ${HAND_MODEL.sha256}), unchanged.

Converted from an official PaddleOCR model to the indicated inference format
and packaged for use with RapidOCR. The upstream model weights are copyright
Baidu and/or the applicable PaddleOCR rights holders and are licensed under
the Apache License, Version 2.0 (below).

${HAND_GLUE_FILE}, ${HAND_WASM_JS_FILE}

ONNX Runtime Web ${HAND_ORT_VERSION} (https://github.com/microsoft/onnxruntime),
its WebAssembly engine (written into a script as base64, unchanged otherwise),
under the MIT License (below).

-------------------------------------------------------------------------------

${apache}
-------------------------------------------------------------------------------

${MIT_ORT}`)
}

/**
 * The model's bytes (see above): checked against its SHA-256; null with
 * OV_HAND_MODEL=skip.
 * @param {{ cacheDir?: string, local?: string, fetchFn?: typeof fetch, log?: (msg: string) => void, model?: { file: string, url: string, sha256: string, bytes: number } }} [opts]
 */
export async function handModelBytes ({
  cacheDir = process.env.OV_HAND_MODEL_CACHE || join(HERE, 'node_modules', '.cache', 'ov-hand-model'),
  local = process.env.OV_HAND_MODEL,
  fetchFn = globalThis.fetch,
  log = (msg) => console.log(msg),
  model = HAND_MODEL
} = {}) {
  if (local === 'skip') {
    log(`[ocr-assets] OV_HAND_MODEL=skip: built WITHOUT ${model.file}, the marks are read by Tesseract`)
    return null
  }
  const cached = join(cacheDir, `${model.sha256}.onnx`)
  for (const p of [local, cached].filter(Boolean)) {
    if (!existsSync(p)) continue
    const buf = readFileSync(p)
    if (sha256(buf) === model.sha256) return buf
    if (p === local) throw new Error(`OV_HAND_MODEL (${p}) is not ${model.file} (SHA-256 ${model.sha256})`)
  }
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log(`[ocr-assets] downloading ${model.file} (${(model.bytes / 1e6).toFixed(1)} MB, attempt ${attempt})`)
      const res = await fetchFn(model.url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const got = sha256(buf)
      if (got !== model.sha256) throw new Error(`SHA-256 ${got}, not ${model.sha256}`)
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(`${cached}.part`, buf)
      renameSync(`${cached}.part`, cached)
      return buf
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`The handwriting model ${model.file} could not be downloaded from ${model.url} (${lastErr?.message || lastErr}); put a copy on disk and set OV_HAND_MODEL to its path`)
}

/**
 * [{ fileName, read() }] of every file, fileName relative to the build's root.
 * @param {{ model?: Buffer }} [opts] the handwriting model's bytes (handModelBytes); without, no model file
 */
export function ocrFiles ({ model = null } = {}) {
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
    ...(model ? [{ fileName: `${hand}/${HAND_MODEL.file}`, read: () => model }] : []),
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
  let model = null
  const loadModel = () => (model ??= handModelBytes())
  let files = null
  const all = async () => (files ??= ocrFiles({ model: await loadModel() }))
  // (a file read once: the base64 engine is ~20 MB)
  const cache = new Map()
  const bytesOf = (f) => { if (!cache.has(f.fileName)) cache.set(f.fileName, f.read()); return cache.get(f.fileName) }
  return {
    name: 'ov-ocr-assets',
    configureServer (server) {
      if (!enabled) return
      // (fetched while the server starts; a failure shows when a photo is read)
      loadModel().catch((err) => server.config.logger.warn(`[ocr-assets] ${err.message}`))
      server.middlewares.use(async (req, res, next) => {
        const path = String(req.url || '').split('?')[0].replace(/^\/+/, '')
        if (!path.startsWith('ocr/')) return next()
        let list
        try { list = await all() } catch (err) { res.statusCode = 503; res.end(String(err.message)); return }
        const file = list.find((f) => f.fileName === path)
        if (!file) return next()
        res.setHeader('Content-Type', TYPES[path.split('.').pop()] || 'application/octet-stream')
        res.end(bytesOf(file))
      })
    },
    async buildStart () {
      if (!enabled) return
      await all()
    },
    async generateBundle () {
      if (!enabled) return
      for (const f of await all()) this.emitFile({ type: 'asset', fileName: f.fileName, source: bytesOf(f) })
    }
  }
}
