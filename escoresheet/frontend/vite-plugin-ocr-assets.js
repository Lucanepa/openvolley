import { readFileSync } from 'fs'
import { gunzipSync } from 'zlib'
import { createRequire } from 'module'

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
 * Bundled with the app, never from a CDN: the import works offline, on a
 * LAN-only venue box, and under the pages' script-src 'self'. Only the LSTM
 * engine (OEM 1) and the "best_int" models: the smallest pair that reads
 * printed lists well. The language data is written decompressed and the
 * engine as .wasm.js (the WebAssembly inside a script): F-Droid's scanner
 * refuses .gz and .wasm files in the build (fdroidserver scanner.py).
 *
 * Kept out of the web app's precache (pwa-workbox.js PRECACHE_GLOB_IGNORES,
 * OCR_FILES_ROUTE): about 12 MB the web downloads on the first photo import
 * only. The Android and desktop apps carry them in their files.
 */

const require = createRequire(import.meta.url)

export const OCR_LANGS = Object.freeze(['deu', 'fra', 'ita'])
export const OCR_CORE_FILES = Object.freeze(['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'])

/** The tesseract.js version: the folder's name, so a new version is a new address (no stale cache). */
export function ocrVersion () {
  return require('tesseract.js/package.json').version
}

/** [{ fileName, read() }] of every file, fileName relative to the build's root. */
export function ocrFiles () {
  const dir = `ocr/${ocrVersion()}`
  return [
    { fileName: `${dir}/worker.min.js`, read: () => readFileSync(require.resolve('tesseract.js/dist/worker.min.js')) },
    ...OCR_CORE_FILES.map((name) => ({ fileName: `${dir}/${name}`, read: () => readFileSync(require.resolve(`tesseract.js-core/${name}`)) })),
    ...OCR_LANGS.map((lang) => ({
      fileName: `${dir}/lang/${lang}.traineddata`,
      read: () => gunzipSync(readFileSync(require.resolve(`@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`)))
    }))
  ]
}

/**
 * Vite plugin: the files in the build (emitted as they are, no hash: the
 * worker asks for the engine and the languages by name), and served by the
 * dev server under the same addresses.
 * @param {{ enabled?: boolean }} [opts] false: a build without the scorer's Match Setup
 */
export function ocrAssets ({ enabled = true } = {}) {
  let files = null
  const all = () => (files ??= ocrFiles())
  return {
    name: 'ov-ocr-assets',
    configureServer (server) {
      if (!enabled) return
      server.middlewares.use((req, res, next) => {
        const path = String(req.url || '').split('?')[0].replace(/^\/+/, '')
        const file = all().find((f) => f.fileName === path)
        if (!file) return next()
        res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
        res.end(file.read())
      })
    },
    generateBundle () {
      if (!enabled) return
      for (const f of all()) this.emitFile({ type: 'asset', fileName: f.fileName, source: f.read() })
    }
  }
}
