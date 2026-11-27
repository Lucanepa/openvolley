import { describe, it, expect, vi } from 'vitest'
import { readRosterPhoto, startOcrEngine, ocrWorkerCount, pgmOf, OCR_LANGS, ocrDir } from '../ocr'
import { version as TESSERACT_VERSION } from 'tesseract.js/package.json'
import vmShot from './fixtures/ocr-vm-de-screenshot.json'

// A stand-in for Tesseract's createWorker: records what it was given, answers recognize() as told.
function fakeTesseract ({ data = vmShot, recognize, failCreate = false } = {}) {
  const calls = { create: null, params: [], recognize: 0, terminated: 0 }
  const createWorker = vi.fn(async (langs, oem, options) => {
    calls.create = { langs, oem, options }
    if (failCreate) throw new Error('failed to fetch worker.min.js')
    return {
      setParameters: async (p) => { calls.params.push(p) },
      recognize: async (...args) => { calls.recognize++; return recognize ? recognize(...args) : { data } },
      terminate: async () => { calls.terminated++ }
    }
  })
  return { createWorker, calls }
}

describe('readRosterPhoto (Tesseract on this device)', () => {
  it('reads the roster from the app\'s own files, nothing from a CDN, nothing cached twice', async () => {
    const { createWorker, calls } = fakeTesseract()
    const roster = await readRosterPhoto(new Blob(['page']), { createWorker, dir: 'https://localhost/ocr/7.0.0/' })
    expect(roster.source).toBe('ocr')
    expect(roster.players).toHaveLength(10)
    expect(roster.coach).toMatchObject({ licence: '312977' })
    expect(calls.create.langs).toEqual(OCR_LANGS)
    expect(calls.create.oem).toBe(1)
    expect(calls.create.options).toMatchObject({
      workerPath: 'https://localhost/ocr/7.0.0/worker.min.js',
      langPath: 'https://localhost/ocr/7.0.0/lang',
      gzip: false,
      cacheMethod: 'none',
      workerBlobURL: false
    })
    expect(calls.create.options.corePath).toMatch(/^https:\/\/localhost\/ocr\/7\.0\.0\/tesseract-core-(simd-)?lstm\.wasm\.js$/)
    expect(calls.params[0]).toMatchObject({ tessedit_pageseg_mode: '6' })
    expect(calls.terminated).toBe(1)
  })

  it('ocrDir: ocr/<tesseract.js version>/ beside the pages', () => {
    expect(ocrDir('https://app.openvolley.app/')).toBe(`https://app.openvolley.app/ocr/${TESSERACT_VERSION}/`)
  })

  it('the recognition cannot start (the web offline before its first use): ocr-load', async () => {
    const { createWorker } = fakeTesseract({ failCreate: true })
    await expect(readRosterPhoto(new Blob(['page']), { createWorker, dir: '/ocr/x/' })).rejects.toMatchObject({ code: 'ocr-load' })
  })

  it('a page that may not run WebAssembly (its CSP) says so at once, without starting a worker', async () => {
    const { createWorker } = fakeTesseract()
    const Module = vi.spyOn(WebAssembly, 'Module').mockImplementation(() => { throw new Error('violates the Content Security policy') })
    try {
      await expect(readRosterPhoto(new Blob(['page']), { createWorker, dir: '/ocr/x/' })).rejects.toMatchObject({ code: 'ocr-load' })
      expect(createWorker).not.toHaveBeenCalled()
    } finally {
      Module.mockRestore()
    }
  })

  it('it takes too long: ocr-timeout, and the worker is ended', async () => {
    const { createWorker, calls } = fakeTesseract({ recognize: () => new Promise(() => {}) })
    await expect(readRosterPhoto(new Blob(['page']), { createWorker, dir: '/ocr/x/', timeoutMs: 30 })).rejects.toMatchObject({ code: 'ocr-timeout' })
    expect(calls.terminated).toBeGreaterThanOrEqual(1)
  })

  it('it stops with an error: ocr-load; it reads no player row: ocr-empty', async () => {
    const failing = fakeTesseract({ recognize: async () => { throw new Error('RuntimeError: memory access out of bounds') } })
    await expect(readRosterPhoto(new Blob(['page']), { createWorker: failing.createWorker, dir: '/ocr/x/' })).rejects.toMatchObject({ code: 'ocr-load' })
    const empty = fakeTesseract({ data: { blocks: [] } })
    await expect(readRosterPhoto(new Blob(['page']), { createWorker: empty.createWorker, dir: '/ocr/x/' })).rejects.toMatchObject({ code: 'ocr-empty' })
    expect(empty.calls.terminated).toBe(1)
  })

  it('closing the dialog cancels it and ends the worker at once', async () => {
    const controller = new AbortController()
    let release
    const { createWorker, calls } = fakeTesseract({ recognize: () => new Promise((resolve) => { release = resolve }) })
    const reading = readRosterPhoto(new Blob(['page']), { createWorker, dir: '/ocr/x/', signal: controller.signal })
    await vi.waitFor(() => expect(calls.recognize).toBe(1))
    controller.abort()
    expect(calls.terminated).toBe(1)
    release({ data: vmShot })
    await expect(reading).rejects.toMatchObject({ code: 'ocr-cancelled' })
  })

  it('a page read without certainty (out of focus) is "take it again", not a list', async () => {
    const { createWorker } = fakeTesseract({ data: { ...vmShot, confidence: 48 } })
    await expect(readRosterPhoto(new Blob(['page']), { createWorker, dir: '/ocr/x/' })).rejects.toMatchObject({ code: 'ocr-blurry' })
    const empty = fakeTesseract({ data: { blocks: [], confidence: 62 } })
    await expect(readRosterPhoto(new Blob(['page']), { createWorker: empty.createWorker, dir: '/ocr/x/' })).rejects.toMatchObject({ code: 'ocr-blurry' })
    const sharp = fakeTesseract({ data: { blocks: [], confidence: 90 } })
    await expect(readRosterPhoto(new Blob(['page']), { createWorker: sharp.createWorker, dir: '/ocr/x/' })).rejects.toMatchObject({ code: 'ocr-empty' })
  })

  it('a progress callback gets the share of the page read and the phase, to the end', async () => {
    const fake = fakeTesseract({
      recognize: async () => {
        fake.calls.create.options.logger({ status: 'recognizing text', progress: 0.5, workerId: 'w1' })
        return { data: vmShot }
      }
    })
    const { createWorker, calls } = fake
    const seen = []
    await readRosterPhoto(new Blob(['page']), { createWorker, dir: '/ocr/x/', onProgress: (share, status) => seen.push([share, status]) })
    expect(seen).toContainEqual([0.5, 'recognizing text'])
    expect(seen[seen.length - 1]).toEqual([1, 'reading marks'])
    // (nothing after the end)
    calls.create.options.logger({ status: 'recognizing text', progress: 0.7, workerId: 'w1' })
    expect(seen).not.toContainEqual([0.7, 'recognizing text'])
  })
})

describe('the recognition started ahead (startOcrEngine)', () => {
  it('starts its workers before the photo is read; the reading uses them and leaves them to their owner', async () => {
    const { createWorker, calls } = fakeTesseract()
    const engine = startOcrEngine({ size: 3, createWorker, dir: '/ocr/x/' })
    const workers = await engine.ready
    expect(createWorker).toHaveBeenCalledTimes(3)
    expect(workers).toHaveLength(3)
    const roster = await readRosterPhoto(new Blob(['page']), { engine, createWorker })
    expect(roster.players).toHaveLength(10)
    // no second start, not ended by the reading
    expect(createWorker).toHaveBeenCalledTimes(3)
    expect(calls.terminated).toBe(0)
    await engine.terminate()
    expect(calls.terminated).toBe(3)
  })

  it('goes on with the workers that started (little memory); none started: ocr-load', async () => {
    let n = 0
    const some = vi.fn(async () => {
      if (++n === 2) throw new Error('out of memory')
      return { setParameters: async () => {}, recognize: async () => ({ data: vmShot }), terminate: async () => {} }
    })
    expect(await startOcrEngine({ size: 3, createWorker: some, dir: '/ocr/x/' }).ready).toHaveLength(2)
    const none = startOcrEngine({ size: 2, createWorker: async () => { throw new Error('failed to fetch') }, dir: '/ocr/x/' })
    await expect(none.ready).rejects.toMatchObject({ code: 'ocr-load' })
  })

  it('ended while it starts (the dialog closed): its workers end as they come', async () => {
    const { createWorker, calls } = fakeTesseract()
    const engine = startOcrEngine({ size: 2, createWorker, dir: '/ocr/x/' })
    await engine.terminate()
    await expect(engine.ready).rejects.toMatchObject({ code: 'ocr-cancelled' })
    expect(calls.terminated).toBe(2)
  })

  it('ocrWorkerCount: one core left for the page, at most four, fewer on little memory', () => {
    expect(ocrWorkerCount({ cores: 8, memory: 8 })).toBe(4)
    // a Galaxy Tab A7 Lite: 8 cores, 3 GB (Chrome says 2)
    expect(ocrWorkerCount({ cores: 8, memory: 2 })).toBe(3)
    expect(ocrWorkerCount({ cores: 8, memory: 1 })).toBe(1)
    expect(ocrWorkerCount({ cores: 2 })).toBe(1)
    expect(ocrWorkerCount({ cores: 4 })).toBe(3)
    expect(ocrWorkerCount({ cores: 0 })).toBe(1)
  })

  it('pgmOf: the grey pixels as a PGM file (what the recognition reads instead of a canvas)', () => {
    const out = pgmOf(new Uint8ClampedArray([0, 128, 255, 7, 8, 9]), 3, 2)
    expect(new TextDecoder().decode(out.slice(0, 11))).toBe('P5\n3 2\n255\n')
    expect([...out.slice(11)]).toEqual([0, 128, 255, 7, 8, 9])
  })
})
