/**
 * The files of the photo import's handwriting reader (handReader.js, option B
 * of the handwriting study, 2026-11-27): PP-OCRv6 rec tiny (PaddleOCR, as
 * RapidOCR converts it to ONNX) run by onnxruntime-web's WebAssembly engine.
 * They are the app's own files, in the build as ocr/hand-<ORT version>/
 * beside Tesseract's (vite-plugin-ocr-assets.js), never from a CDN:
 *
 *   ort-wasm-simd-threaded.mjs       onnxruntime-web's loader of its engine
 *   ort-wasm-simd-threaded.wasm.js   its engine: the WebAssembly inside a script
 *                                    (F-Droid's scanner refuses .wasm files)
 *   PP-OCRv6_rec_tiny.onnx           the model (Apache-2.0), pinned below
 *   NOTICE.txt                       the model's attribution and licence
 *
 * Plain constants (no import): the Vite plugin reads them in Node too.
 */

// onnxruntime-web, exactly the version in package.json (the plugin checks it):
// a new version is a new folder, so no device keeps a stale engine
export const HAND_ORT_VERSION = '1.31.1'
export const HAND_GLUE_FILE = 'ort-wasm-simd-threaded.mjs'
export const HAND_WASM_JS_FILE = 'ort-wasm-simd-threaded.wasm.js'
export const HAND_NOTICE_FILE = 'NOTICE.txt'

// The model as RapidOCR 3.10.0 records it (rapidocr/default_models.yaml in its
// PyPI wheel, multi_PP-OCRv6_rec_tiny: the release record of the URL and the
// SHA-256): the build downloads it from there and refuses any other bytes
export const HAND_MODEL = Object.freeze({
  file: 'PP-OCRv6_rec_tiny.onnx',
  url: 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/rec/PP-OCRv6_rec_tiny.onnx',
  sha256: 'e16e242de5937ad92609223f19bc2aff3727ee40b095f996907c24749bad251b',
  bytes: 4489813
})

// The model's output classes (its own dictionary, in the file's metadata
// "character": index 0 is CTC's blank, then the dictionary, 6906 in all) that
// a team writes beside a row: the digits, C or K (captain), L (libero); the
// small c, k, l read as the capitals. Fixed by the SHA-256 above.
export const HAND_CLASSES = Object.freeze([
  [33, '0'], [34, '1'], [35, '2'], [36, '3'], [37, '4'], [38, '5'], [39, '6'], [40, '7'], [41, '8'], [42, '9'],
  [45, 'C'], [53, 'K'], [54, 'L'], [71, 'C'], [79, 'K'], [80, 'L']
])
export const HAND_CLASS_COUNT = 6906
