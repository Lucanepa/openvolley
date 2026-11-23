import { describe, it, expect, vi } from 'vitest'
import { readRosterPhoto, OCR_LANGS, ocrDir } from '../ocr'
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

  it('a progress callback gets the share and the phase', async () => {
    const { createWorker, calls } = fakeTesseract()
    const seen = []
    await readRosterPhoto(new Blob(['page']), { createWorker, dir: '/ocr/x/', onProgress: (share, status) => seen.push([share, status]) })
    calls.create.options.logger({ status: 'recognizing text', progress: 0.5 })
    expect(seen).toContainEqual([0.5, 'recognizing text'])
  })
})
