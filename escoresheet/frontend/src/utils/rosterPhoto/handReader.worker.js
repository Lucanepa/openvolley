/**
 * The handwriting reader's worker (handReader.js): onnxruntime-web's
 * WebAssembly engine, one thread (threads need a cross-origin isolated page;
 * no page of the app is), running PP-OCRv6 rec tiny on the crops it is sent.
 * Its files are the app's own (ocr/hand-<version>/, handFiles.js); the engine
 * comes as a script holding its WebAssembly (F-Droid), handed to
 * onnxruntime-web as bytes.
 *
 *   { type: 'init', glueUrl, wasmJsUrl, modelUrl }  -> { type: 'ready' } | { type: 'error', message }
 *   { type: 'read', id, inputs: [{ w, data }] }     -> { type: 'read', id, results: [{ text, conf }] } | { type: 'read', id, error }
 */
import * as ort from 'onnxruntime-web/wasm'
import { HAND_INPUT_HEIGHT, HAND_INPUT_MIN_WIDTH, batchesOf, batchTensor, decodeHand, wasmOfScript } from './handModel'

let session = null

async function fetchOk (url, as) {
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`${url.split('/').pop()}: ${res.status}`)
  return as === 'text' ? res.text() : res.arrayBuffer()
}

async function init ({ glueUrl, wasmJsUrl, modelUrl }) {
  const [script, model] = await Promise.all([fetchOk(wasmJsUrl, 'text'), fetchOk(modelUrl, 'bytes')])
  ort.env.wasm.wasmBinary = wasmOfScript(script)
  ort.env.wasm.wasmPaths = { mjs: glueUrl }
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  ort.env.logLevel = 'error'
  session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
  // the engine's first run is its slowest: done now, on a blank crop
  const W = HAND_INPUT_MIN_WIDTH
  await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * HAND_INPUT_HEIGHT * W), [1, 3, HAND_INPUT_HEIGHT, W]) })
}

async function read (inputs) {
  const results = new Array(inputs.length)
  for (const { width, items } of batchesOf(inputs)) {
    const x = new ort.Tensor('float32', batchTensor(inputs, items, width), [items.length, 3, HAND_INPUT_HEIGHT, width])
    const out = (await session.run({ [session.inputNames[0]]: x }))[session.outputNames[0]]
    const [, steps, classes] = out.dims
    items.forEach((k, j) => { results[k] = decodeHand(out.data, steps, classes, j * steps * classes) })
    out.dispose?.()
    x.dispose?.()
  }
  return results
}

// one message after the other (the engine runs one model at a time)
let queue = Promise.resolve()
self.onmessage = ({ data }) => { queue = queue.then(() => handle(data)) }

async function handle (data) {
  if (data?.type === 'init') {
    try {
      await init(data)
      self.postMessage({ type: 'ready' })
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err) })
    }
  } else if (data?.type === 'read') {
    try {
      if (!session) throw new Error('not loaded')
      self.postMessage({ type: 'read', id: data.id, results: await read(data.inputs) })
    } catch (err) {
      self.postMessage({ type: 'read', id: data.id, error: String(err?.message || err) })
    }
  }
}
