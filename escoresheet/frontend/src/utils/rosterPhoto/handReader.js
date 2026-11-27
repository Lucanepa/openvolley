/**
 * The handwriting reader of the photo import (option B of the handwriting
 * study, 2026-11-27): the team's marks beside the rows (shirt numbers, C or
 * K, L) read by PP-OCRv6 rec tiny on this device, in its own worker
 * (handReader.worker.js, onnxruntime-web's WebAssembly engine, the app's own
 * files: handFiles.js, ocrFiles.js handPaths). On the real photos it read 63
 * of 77 marks right where Tesseract's second reading read 34.
 *
 * startHandReader() starts it (with the recognition, ocr.js startOcrEngine,
 * while the scorer takes the photo); reader.ready resolves once the model
 * answered a first crop, and rejects where it cannot run (no WebAssembly
 * SIMD, no module worker, a file missing, too little memory): ocr.js then
 * reads the marks with Tesseract, as before. reader.read(inputs) -> one
 * { text, conf } a crop (handModel.js handInput). Never throws.
 */
import { handPaths } from './ocrFiles'

// loading: the engine (~15 MB) and the model (4.5 MB) from the app's files,
// compiled; seconds on a slow tablet. Past this it counts as not loaded.
export const HAND_LOAD_TIMEOUT_MS = 45000
// one page's crops (a few dozen, ~0.1 s each on a slow tablet)
export const HAND_READ_TIMEOUT_MS = 15000

const coded = (code, message) => Object.assign(new Error(message), { code })

/** The worker, from the app's own address (a module worker: Vite builds it beside the app). */
function handWorker () {
  return new Worker(new URL('./handReader.worker.js', import.meta.url), { type: 'module', name: 'ov-hand-reader' })
}

async function simdOk () {
  try {
    const { simd } = await import('wasm-feature-detect')
    return await simd()
  } catch {
    return false
  }
}

/**
 * @param {{ dir?: string, createWorker?: () => Worker, simd?: () => Promise<boolean>, loadTimeoutMs?: number }} [opts]
 *   createWorker / simd: tests hand in their own
 * @returns {{ ready: Promise<void>, read: (inputs: {w: number, data: Float32Array}[]) => Promise<{text: string, conf: number}[]>, terminate: () => void, ended: boolean, loaded: boolean, failed: string|null }}
 */
export function startHandReader ({ dir, createWorker = handWorker, simd = simdOk, loadTimeoutMs = HAND_LOAD_TIMEOUT_MS } = {}) {
  const reader = { ended: false, loaded: false, failed: null, worker: null }
  const pending = new Map()
  let nextId = 1
  const failAll = (err) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err) }
    pending.clear()
  }
  reader.terminate = () => {
    reader.ended = true
    failAll(coded('hand-ended', 'The handwriting reader was ended'))
    try { reader.worker?.terminate() } catch { /* gone */ }
    reader.worker = null
  }
  reader.ready = (async () => {
    // (onnxruntime-web's engine is built with SIMD only)
    if (typeof Worker !== 'function' && createWorker === handWorker) throw coded('hand-unsupported', 'No worker here')
    if (!(await simd())) throw coded('hand-unsupported', 'No WebAssembly SIMD here')
    if (reader.ended) throw coded('hand-ended', 'The handwriting reader was ended')
    const w = createWorker()
    reader.worker = w
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(coded('hand-timeout', 'The handwriting reader took too long to load')), loadTimeoutMs)
      w.onmessage = ({ data }) => {
        if (data?.type === 'ready') { clearTimeout(timer); resolve() } else if (data?.type === 'error') { clearTimeout(timer); reject(coded('hand-load', data.message)) } else if (data?.type === 'read') {
          const p = pending.get(data.id)
          if (!p) return
          pending.delete(data.id)
          clearTimeout(p.timer)
          if (data.error) p.reject(coded('hand-read', data.error))
          else p.resolve(data.results)
        }
      }
      w.onerror = (e) => {
        e?.preventDefault?.()
        const err = coded('hand-load', `The handwriting reader stopped (${e?.message || 'worker error'})`)
        clearTimeout(timer)
        reject(err)
        failAll(err)
        reader.failed = err.message
      }
      const { glueUrl, wasmJsUrl, modelUrl } = handPaths(dir)
      w.postMessage({ type: 'init', glueUrl, wasmJsUrl, modelUrl })
    })
  })()
  reader.ready.then(() => { reader.loaded = true }, (err) => {
    reader.failed = String(err?.message || err)
    try { reader.worker?.terminate() } catch { /* gone */ }
    reader.worker = null
  })
  reader.read = async (inputs, { timeoutMs = HAND_READ_TIMEOUT_MS } = {}) => {
    await reader.ready
    if (reader.ended || !reader.worker) throw coded('hand-ended', 'The handwriting reader was ended')
    if (!inputs.length) return []
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(coded('hand-timeout', 'The handwriting reader took too long')) }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      // (copies: the crops stay the caller's)
      reader.worker.postMessage({ type: 'read', id, inputs: inputs.map(({ w, data }) => ({ w, data })) })
    })
  }
  return reader
}
