import { describe, it, expect } from 'vitest'
import { startHandReader } from '../handReader'
import { handDir, handPaths, HAND_ORT_VERSION } from '../ocrFiles'
import { HAND_MODEL } from '../handFiles'

// A stand-in for the reader's worker: answers 'init' and 'read' as told
function fakeWorker ({ init = 'ready', answer = (inputs) => inputs.map((i) => ({ text: String(i.w), conf: 0.9 })), silent = false } = {}) {
  const w = { sent: [], terminated: 0, onmessage: null, onerror: null }
  const reply = (data) => setTimeout(() => w.onmessage?.({ data }), 0)
  w.postMessage = (msg) => {
    w.sent.push(msg)
    if (silent) return
    if (msg.type === 'init') reply(init === 'ready' ? { type: 'ready' } : { type: 'error', message: init })
    if (msg.type === 'read') {
      try { reply({ type: 'read', id: msg.id, results: answer(msg.inputs) }) } catch (e) { reply({ type: 'read', id: msg.id, error: e.message }) }
    }
  }
  w.terminate = () => { w.terminated++ }
  return w
}
const yes = async () => true

describe('the handwriting reader (its worker)', () => {
  it('loads from the app\'s own files and reads crops, one answer a crop', async () => {
    const w = fakeWorker()
    const r = startHandReader({ dir: 'https://localhost/ocr/hand-x/', createWorker: () => w, simd: yes })
    await r.ready
    expect(r.loaded).toBe(true)
    expect(w.sent[0]).toEqual({
      type: 'init',
      glueUrl: 'https://localhost/ocr/hand-x/ort-wasm-simd-threaded.mjs',
      wasmJsUrl: 'https://localhost/ocr/hand-x/ort-wasm-simd-threaded.wasm.js',
      modelUrl: 'https://localhost/ocr/hand-x/PP-OCRv6_rec_tiny.onnx'
    })
    const got = await r.read([{ w: 20, data: new Float32Array(20 * 48) }, { w: 7, data: new Float32Array(7 * 48) }])
    expect(got).toEqual([{ text: '20', conf: 0.9 }, { text: '7', conf: 0.9 }])
    expect(await r.read([])).toEqual([])
    r.terminate()
    expect(w.terminated).toBe(1)
    await expect(r.read([{ w: 1, data: new Float32Array(48) }])).rejects.toMatchObject({ code: 'hand-ended' })
  })

  it('no WebAssembly SIMD (onnxruntime-web needs it): not loaded, no worker started', async () => {
    let made = 0
    const r = startHandReader({ dir: '/x/', createWorker: () => { made++; return fakeWorker() }, simd: async () => false })
    await expect(r.ready).rejects.toMatchObject({ code: 'hand-unsupported' })
    expect(made).toBe(0)
    expect(r.loaded).toBe(false)
  })

  it('a file missing or the memory short: the load fails (ocr.js reads the marks with Tesseract); a load that never ends times out', async () => {
    const w = fakeWorker({ init: 'model: 404' })
    const r = startHandReader({ dir: '/x/', createWorker: () => w, simd: yes })
    await expect(r.ready).rejects.toMatchObject({ code: 'hand-load', message: 'model: 404' })
    expect(w.terminated).toBe(1)
    const slow = startHandReader({ dir: '/x/', createWorker: () => fakeWorker({ silent: true }), simd: yes, loadTimeoutMs: 20 })
    await expect(slow.ready).rejects.toMatchObject({ code: 'hand-timeout' })
  })

  it('a reading that fails or never answers rejects (the marks go to Tesseract)', async () => {
    const r = startHandReader({ dir: '/x/', createWorker: () => fakeWorker({ answer: () => { throw new Error('memory access out of bounds') } }), simd: yes })
    await expect(r.read([{ w: 1, data: new Float32Array(48) }])).rejects.toMatchObject({ code: 'hand-read' })
    const w = fakeWorker()
    const quiet = startHandReader({ dir: '/x/', createWorker: () => w, simd: yes })
    await quiet.ready
    w.postMessage = (msg) => { w.sent.push(msg) }
    await expect(quiet.read([{ w: 1, data: new Float32Array(48) }], { timeoutMs: 20 })).rejects.toMatchObject({ code: 'hand-timeout' })
  })

  it('the worker dies: ready and the readings waiting reject', async () => {
    const w = fakeWorker({ silent: true })
    const r = startHandReader({ dir: '/x/', createWorker: () => w, simd: yes })
    await new Promise((res) => setTimeout(res, 0))
    w.onerror({ message: 'out of memory', preventDefault () {} })
    await expect(r.ready).rejects.toMatchObject({ code: 'hand-load' })
  })

  it('handDir / handPaths: ocr/hand-<onnxruntime-web version>/ beside the pages', () => {
    expect(handDir('https://app.openvolley.app/')).toBe(`https://app.openvolley.app/ocr/hand-${HAND_ORT_VERSION}/`)
    expect(handPaths('/o/').urls).toEqual(['/o/ort-wasm-simd-threaded.mjs', '/o/ort-wasm-simd-threaded.wasm.js', `/o/${HAND_MODEL.file}`])
  })
})
