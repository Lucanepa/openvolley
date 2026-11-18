import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 17.11.2026, Galaxy Tab A7 Lite (Android app 3.3.6): importing an
// Einsatzliste spun for ever. pdf.js 5's modern build needs a recent engine
// (Uint8Array.prototype.toHex is Chrome 140) and its worker is an ES module.
// Now: the legacy build where the engine lacks the modern build's features,
// the main thread where module workers do not start, a time limit on every
// reading, one retry on the main thread, then a clear message.

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.min-TEST.mjs' }))
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.legacy-TEST.mjs' }))

// Two stand-ins: what each build is asked to do. `behaviour` per build:
// 'ok' (a page of text), 'hang' (never answers), 'throw' (an engine error)
const pdf = vi.hoisted(() => {
  const make = (name) => ({
    name,
    GlobalWorkerOptions: { workerSrc: '' },
    calls: [],
    behaviour: 'ok',
    getDocument (opts) {
      this.calls.push({ workerSrc: this.GlobalWorkerOptions.workerSrc, mainThread: !!globalThis.pdfjsWorker?.WorkerMessageHandler, bytes: opts.data?.byteLength })
      const b = this.behaviour
      const promise = b === 'hang'
        ? new Promise(() => {})
        : b === 'throw'
          ? Promise.reject(Object.assign(new Error('n.toHex is not a function'), { name: 'UnknownErrorException' }))
          : Promise.resolve({
            numPages: 1,
            getPage: async () => ({
              getTextContent: async () => ({
                items: [
                  { str: 'Einsatzliste', transform: [1, 0, 0, 1, 40, 800], width: 50 },
                  { str: 'Coach: Muster Carla 01.01.1980', transform: [1, 0, 0, 1, 40, 780], width: 120 }
                ]
              })
            })
          })
      return { promise, destroy: vi.fn() }
    }
  })
  return { modern: make('modern'), legacy: make('legacy') }
})
vi.mock('pdfjs-dist', () => pdf.modern)
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => pdf.legacy)

import {
  missingModernPdfFeatures, supportsModuleWorker, pdfReaderPlan, retryOnMainThread, withTimeout,
  parseRosterPdf, resetPdfReaderFallback, rosterPdfErrorText, pdfTimeoutError, PDF_TIMEOUT_CODE
} from '../parseRosterPdf'

// An engine with everything the modern build uses
const modernGlobal = () => ({
  Promise: { withResolvers () {}, try () {} },
  URL: { parse () {} },
  Uint8Array: Object.assign(function () {}, { fromBase64 () {}, prototype: { toHex () {} } }),
  Map: { prototype: { getOrInsertComputed () {} } }
})
// Workers: one that reads the `type` option (module workers), one that never does (Chrome < 80)
function ModuleWorker (url, opts) { void opts?.type; throw new DOMException('about:blank cannot be accessed', 'SecurityError') }
function ClassicWorker (url) { this.url = url; this.terminate = vi.fn() }

const file = () => ({ size: 100, arrayBuffer: async () => new ArrayBuffer(100) })

beforeEach(() => {
  resetPdfReaderFallback()
  delete globalThis.pdfjsWorker
  for (const b of [pdf.modern, pdf.legacy]) { b.calls = []; b.behaviour = 'ok'; b.GlobalWorkerOptions.workerSrc = '' }
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); delete globalThis.pdfjsWorker })

describe('choosing how to read the PDF', () => {
  it('lists the modern build features the engine lacks', () => {
    expect(missingModernPdfFeatures(modernGlobal())).toEqual([])
    const old = modernGlobal()
    delete old.Uint8Array.prototype.toHex
    delete old.Promise.withResolvers
    expect(missingModernPdfFeatures(old)).toEqual(['Promise.withResolvers', 'Uint8Array.prototype.toHex'])
    expect(missingModernPdfFeatures({})).toHaveLength(6)
  })

  it('tells module workers from classic ones without starting one', () => {
    expect(supportsModuleWorker(ModuleWorker)).toBe(true)
    expect(supportsModuleWorker(ClassicWorker)).toBe(false)
    expect(supportsModuleWorker(undefined)).toBe(false)
  })

  it('modern build in a module worker on a current engine', () => {
    expect(pdfReaderPlan({ globalObject: modernGlobal(), WorkerCtor: ModuleWorker })).toEqual({ build: 'modern', worker: 'module', missing: [] })
  })

  it('legacy build in a module worker on an engine without toHex (a Chrome 107–139 WebView)', () => {
    const g = modernGlobal()
    delete g.Uint8Array.prototype.toHex
    delete g.Uint8Array.fromBase64
    expect(pdfReaderPlan({ globalObject: g, WorkerCtor: ModuleWorker })).toEqual({ build: 'legacy', worker: 'module', missing: ['Uint8Array.prototype.toHex', 'Uint8Array.fromBase64'] })
  })

  it('legacy build on the main thread without module workers, or without workers at all', () => {
    expect(pdfReaderPlan({ globalObject: modernGlobal(), WorkerCtor: ClassicWorker })).toMatchObject({ build: 'legacy', worker: 'main-thread' })
    expect(pdfReaderPlan({ globalObject: {}, WorkerCtor: undefined })).toMatchObject({ build: 'legacy', worker: 'main-thread' })
  })

  it('a worker reading that failed or timed out is tried again on the main thread; a bad file is not', () => {
    const worker = { build: 'modern', worker: 'module' }
    expect(retryOnMainThread(pdfTimeoutError(1000), worker)).toBe(true)
    expect(retryOnMainThread(Object.assign(new Error('x'), { name: 'UnknownErrorException' }), worker)).toBe(true)
    expect(retryOnMainThread(Object.assign(new Error('x'), { name: 'InvalidPDFException' }), worker)).toBe(false)
    expect(retryOnMainThread(Object.assign(new Error('x'), { name: 'PasswordException' }), worker)).toBe(false)
    expect(retryOnMainThread(Object.assign(new Error('not a roster'), { notRoster: true }), worker)).toBe(false)
    expect(retryOnMainThread(pdfTimeoutError(1000), { build: 'legacy', worker: 'main-thread' })).toBe(false)
  })
})

describe('parseRosterPdf never waits for ever', () => {
  it('reads with the plan it is given (the legacy worker URL for the legacy build)', async () => {
    const r = await parseRosterPdf(file(), { plan: { build: 'legacy', worker: 'module' } })
    expect(JSON.stringify(r.coach)).toContain('Muster')
    expect(pdf.legacy.calls).toEqual([{ workerSrc: '/assets/pdf.worker.legacy-TEST.mjs', mainThread: false, bytes: 100 }])
    expect(pdf.modern.calls).toHaveLength(0)
  })

  it('a worker that never answers: read again on the main thread (legacy), and the session stays there', async () => {
    pdf.modern.behaviour = 'hang'
    globalThis.pdfjsWorker = { WorkerMessageHandler: {} } // the legacy worker code, "loaded"
    const r = await parseRosterPdf(file(), { plan: { build: 'modern', worker: 'module' }, workerTimeoutMs: 30, mainThreadTimeoutMs: 1000 })
    expect(JSON.stringify(r.coach)).toContain('Muster')
    expect(pdf.modern.calls).toHaveLength(1)
    expect(pdf.legacy.calls).toHaveLength(1)
    expect(pdf.legacy.calls[0]).toMatchObject({ mainThread: true, bytes: 100 })
    // the next file: straight to the main thread
    await parseRosterPdf(file())
    expect(pdf.modern.calls).toHaveLength(1)
    expect(pdf.legacy.calls).toHaveLength(2)
  })

  it('an engine error in the worker: read again on the main thread', async () => {
    pdf.legacy.behaviour = 'throw'
    globalThis.pdfjsWorker = { WorkerMessageHandler: {} }
    const first = pdf.legacy.getDocument.bind(pdf.legacy)
    let n = 0
    pdf.legacy.getDocument = function (opts) { if (++n === 2) this.behaviour = 'ok'; return first(opts) }
    try {
      const r = await parseRosterPdf(file(), { plan: { build: 'legacy', worker: 'module' }, workerTimeoutMs: 1000 })
      expect(JSON.stringify(r.coach)).toContain('Muster')
      expect(n).toBe(2)
    } finally {
      pdf.legacy.getDocument = first
    }
  })

  it('nothing answers anywhere: an error of code PDF_TIMEOUT_CODE, the clear message, no spinner for ever', async () => {
    pdf.modern.behaviour = 'hang'
    pdf.legacy.behaviour = 'hang'
    globalThis.pdfjsWorker = { WorkerMessageHandler: {} }
    const err = await parseRosterPdf(file(), { plan: { build: 'modern', worker: 'module' }, workerTimeoutMs: 20, mainThreadTimeoutMs: 40 }).catch((e) => e)
    expect(err.code).toBe(PDF_TIMEOUT_CODE)
    const t = (key, vars) => `${key}${vars ? ` ${JSON.stringify(vars)}` : ''}`
    expect(rosterPdfErrorText(err, t)).toBe('rosterPdf.tooSlow')
    expect(rosterPdfErrorText(new Error('broken'), t)).toBe('rosterPdf.failed {"reason":"broken"}')
  })

  it('a file that never hands over its bytes ends too', async () => {
    const err = await parseRosterPdf({ size: 10, arrayBuffer: () => new Promise(() => {}) }, { mainThreadTimeoutMs: 20 }).catch((e) => e)
    expect(err.code).toBe(PDF_TIMEOUT_CODE)
  })

  it('withTimeout lets a quick answer through', async () => {
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7)
    await expect(withTimeout(new Promise(() => {}), 10)).rejects.toMatchObject({ code: PDF_TIMEOUT_CODE })
  })
})
