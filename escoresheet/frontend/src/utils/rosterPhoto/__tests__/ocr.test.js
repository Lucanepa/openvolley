import { describe, it, expect, vi } from 'vitest'
import { readRosterPhoto, startOcrEngine, ocrWorkerCount, pgmOf, mergeLanguages, OCR_LANGS, ocrDir } from '../ocr'
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
      reinitialize: async () => {},
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
    expect(seen).toContainEqual([0.4, 'recognizing text'])
    expect(seen[seen.length - 1]).toEqual([0.98, 'reading marks'])
    // never 100 % before the result is back (owner 27.11: "100 % = finished"), never backwards
    expect(seen.every(([share]) => share < 1)).toBe(true)
    for (let k = 1; k < seen.length; k++) expect(seen[k][0]).toBeGreaterThanOrEqual(seen[k - 1][0])
    // (nothing after the end)
    const before = seen.length
    calls.create.options.logger({ status: 'recognizing text', progress: 0.7, workerId: 'w1' })
    expect(seen.length).toBe(before)
  })
})

describe('the recognition started ahead (startOcrEngine)', () => {
  it('starts its workers before the photo is read; the reading uses them and leaves them to their owner', async () => {
    const { createWorker, calls } = fakeTesseract()
    const engine = startOcrEngine({ size: 3, createWorker, dir: '/ocr/x/' })
    const workers = await engine.ready
    expect(createWorker).toHaveBeenCalledTimes(3)
    expect(workers).toHaveLength(3)
    // what it notes for the activity log (photoReadLog): counts only
    const stats = { workers: 0, turned: false }
    const roster = await readRosterPhoto(new Blob(['page']), { engine, createWorker, stats })
    expect(roster.players).toHaveLength(10)
    expect(stats).toMatchObject({ workers: 3, turned: false, marksBy: 'tesseract' })
    // where the time went (photo.read): whole milliseconds
    for (const k of ['msEngine', 'msPage', 'msHand']) expect(Number.isInteger(stats[k]) && stats[k] >= 0).toBe(true)
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
      return { setParameters: async () => {}, recognize: async () => ({ data: vmShot }), terminate: async () => {}, reinitialize: async () => {} }
    })
    const short = startOcrEngine({ size: 3, createWorker: some, dir: '/ocr/x/' })
    expect(await short.ready).toHaveLength(2)
    // (one short: the page read by one worker with all three)
    expect(short.apart).toBe(false)
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

  it('ocrWorkerCount: one core left for the page, one worker a language, one alone on little memory', () => {
    expect(ocrWorkerCount({ cores: 8, memory: 8 })).toBe(3)
    // a Galaxy Tab A7 Lite: 8 cores, 3 GB (Chrome says 2)
    // a Galaxy Tab A7 Lite (Chrome reports 2 GB): one worker (3 took 36-42 s there, 1 ~20 s)
    expect(ocrWorkerCount({ cores: 8, memory: 2 })).toBe(1)
    expect(ocrWorkerCount({ cores: 8, memory: 4 })).toBe(3)
    expect(ocrWorkerCount({ cores: 8, memory: 1 })).toBe(1)
    expect(ocrWorkerCount({ cores: 3 })).toBe(2)
    expect(ocrWorkerCount({ cores: 2 })).toBe(1)
    expect(ocrWorkerCount({ cores: 0 })).toBe(1)
  })

  it('three workers read the page side by side, one language each, and the rest with all three', async () => {
    const created = []
    const switched = []
    let read = 0
    const createWorker = vi.fn(async (langs) => {
      const k = created.push(langs) - 1
      return {
        setParameters: async () => {},
        recognize: async () => { read++; return { data: vmShot } },
        terminate: async () => {},
        reinitialize: async (l) => { switched.push([k, l]) }
      }
    })
    const engine = startOcrEngine({ size: 3, createWorker, dir: '/ocr/x/' })
    await engine.ready
    expect(created).toEqual([OCR_LANGS, OCR_LANGS, OCR_LANGS])
    expect(engine.apart).toBe(true)
    const canvas = Object.assign(document.createElement('canvas'), { width: 4, height: 6 })
    canvas.gray = new Uint8ClampedArray(24).fill(255)
    await readRosterPhoto(canvas, { engine, createWorker })
    expect(read).toBeGreaterThanOrEqual(3)
    expect(switched.slice(0, 3).sort()).toEqual([[0, 'deu'], [1, 'fra'], [2, 'ita']])
    expect(switched.slice(3, 6).map(([, l]) => l)).toEqual([OCR_LANGS, OCR_LANGS, OCR_LANGS])
    await engine.terminate()
  })

  it('mergeLanguages: each line from the language that read it surest; a line one reading lost is kept', () => {
    const w = (text, x0, conf, y = 10) => ({ text, confidence: conf, bbox: { x0, y0: y, x1: x0 + 10 * text.length, y1: y + 20 } })
    const page = (...lines) => ({ blocks: [{ paragraphs: [{ lines: lines.map((words) => ({ words })) }] }] })
    const de = page([w('123456', 0, 95), w('Anna', 80, 60), w('Mustor', 140, 50)], [w('234567', 0, 95, 50), w('Paul', 80, 92), w('Beispiel', 140, 91, 50)])
    const fr = page([w('123456', 0, 95), w('Anna', 80, 93), w('Muster', 140, 90)])
    const it = page([w('123456', 0, 90), w('Anna', 80, 70), w('Muster', 140, 70)], [w('234567', 0, 80, 50), w('Paul', 80, 70), w('Beispiel', 140, 60, 50)])
    const merged = mergeLanguages([de, fr, it])
    const lines = merged.blocks[0].paragraphs[0].lines.map((l) => l.words.map((x) => x.text).join(' '))
    expect(lines).toEqual(['123456 Anna Muster', '234567 Paul Beispiel'])
    expect(merged.confidence).toBeGreaterThan(90)
  })

  it('pgmOf: the grey pixels as a PGM file (what the recognition reads instead of a canvas)', () => {
    const out = pgmOf(new Uint8ClampedArray([0, 128, 255, 7, 8, 9]), 3, 2)
    expect(new TextDecoder().decode(out.slice(0, 11))).toBe('P5\n3 2\n255\n')
    expect([...out.slice(11)]).toEqual([0, 128, 255, 7, 8, 9])
  })
})

// A canvas for jsdom (which draws nothing): RGBA pixels, white or black fills, nearest-neighbour drawImage
function fakeCanvas (w = 300, h = 150) {
  const c = { _w: w, _h: h, buf: new Uint8ClampedArray(w * h * 4) }
  Object.defineProperty(c, 'width', { get: () => c._w, set: (v) => { c._w = v; c.buf = new Uint8ClampedArray(v * c._h * 4) } })
  Object.defineProperty(c, 'height', { get: () => c._h, set: (v) => { c._h = v; c.buf = new Uint8ClampedArray(c._w * v * 4) } })
  const ctx = {
    fillStyle: '#000',
    fillRect (x, y, fw, fh) {
      const v = /^#f{3,6}$/i.test(ctx.fillStyle) ? 255 : 0
      for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(c._h, Math.ceil(y + fh)); yy++) for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(c._w, Math.ceil(x + fw)); xx++) c.buf.set([v, v, v, 255], (yy * c._w + xx) * 4)
    },
    drawImage (src, sx, sy, sw, sh, dx, dy, dw, dh) {
      if (dx === undefined) { [dx, dy, dw, dh] = [sx, sy, sw ?? src.width, sh ?? src.height]; [sx, sy, sw, sh] = [0, 0, src.width, src.height] }
      for (let yy = 0; yy < Math.round(dh); yy++) {
        for (let xx = 0; xx < Math.round(dw); xx++) {
          const tx = Math.round(dx) + xx; const ty = Math.round(dy) + yy
          if (tx < 0 || ty < 0 || tx >= c._w || ty >= c._h) continue
          const fx = Math.floor(sx + (xx * sw) / dw); const fy = Math.floor(sy + (yy * sh) / dh)
          if (fx < 0 || fy < 0 || fx >= src.width || fy >= src.height) continue
          c.buf.set(src.buf.subarray((fy * src.width + fx) * 4, (fy * src.width + fx) * 4 + 4), (ty * c._w + tx) * 4)
        }
      }
    },
    getImageData (x, y, gw, gh) {
      const data = new Uint8ClampedArray(gw * gh * 4)
      for (let yy = 0; yy < gh; yy++) for (let xx = 0; xx < gw; xx++) if (x + xx < c._w && y + yy < c._h) data.set(c.buf.subarray(((y + yy) * c._w + x + xx) * 4, ((y + yy) * c._w + x + xx) * 4 + 4), (yy * gw + xx) * 4)
      return { data, width: gw, height: gh }
    },
    putImageData (img, x, y) { for (let yy = 0; yy < img.height; yy++) for (let xx = 0; xx < img.width; xx++) c.buf.set(img.data.subarray((yy * img.width + xx) * 4, (yy * img.width + xx) * 4 + 4), ((y + yy) * c._w + x + xx) * 4) },
    createImageData: (iw, ih) => ({ data: new Uint8ClampedArray(iw * ih * 4), width: iw, height: ih }),
    translate () {},
    rotate () {}
  }
  c.getContext = () => ctx
  return c
}

describe('the handwriting reader in the reading (option B)', () => {
  // the made-up screenshot's page with a number written left of one row's SV number
  // (Dora Muster's row: 323411 at x 211, y 480..497), nothing else on it
  function pageWithMark () {
    const W = 1080
    const H = 1600
    const page = fakeCanvas(W, H)
    const gray = new Uint8ClampedArray(W * H).fill(255)
    for (let y = 478; y <= 500; y++) for (let x = 160; x <= 176; x++) if (x - 160 < 3 || y - 478 < 3) gray[y * W + x] = 40
    for (let i = 0; i < gray.length; i++) page.buf.set([gray[i], gray[i], gray[i], 255], i * 4)
    page.gray = gray
    return page
  }
  // Tesseract: the page read as the screenshot; the marks read again (digits C K L) as `hand`, the rest nothing
  function tesseractFor ({ hand = '8' } = {}) {
    const calls = { hand: 0 }
    const createWorker = vi.fn(async () => {
      let p = {}
      return {
        setParameters: async (q) => { p = { ...p, ...q } },
        reinitialize: async () => {},
        recognize: async () => {
          if (p.tessedit_char_whitelist === '0123456789CKL') {
            calls.hand++
            return { data: { blocks: [{ paragraphs: [{ lines: [{ words: [{ text: hand, confidence: 80, bbox: { x0: 1, y0: 1, x1: 9, y1: 9 } }] }] }] }] } }
          }
          if (p.tessedit_pageseg_mode === '7' || p.tessedit_pageseg_mode === '8') return { data: { text: '', blocks: [] } }
          return { data: vmShot }
        },
        terminate: async () => {}
      }
    })
    return { createWorker, calls }
  }
  const handReader = (answer) => {
    const reader = { loaded: true, ended: false, seen: [], ready: Promise.resolve(), terminate () { reader.ended = true } }
    reader.read = async (inputs) => { reader.seen.push(inputs); return answer(inputs) }
    return reader
  }
  const withCanvases = async (fn) => {
    const real = document.createElement.bind(document)
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag, ...rest) => (tag === 'canvas' ? fakeCanvas() : real(tag, ...rest)))
    try { return await fn() } finally { spy.mockRestore() }
  }
  const dora = (roster) => roster.players.find((p) => p.licence === '323411')

  it('the margin read by the handwriting reader, as one crop 48 px high; Tesseract never reads the marks again', async () => {
    const { createWorker, calls } = tesseractFor()
    const hand = handReader((inputs) => inputs.map(() => ({ text: '12', conf: 0.93 })))
    const stats = {}
    const debug = {}
    const roster = await withCanvases(() => readRosterPhoto(pageWithMark(), { createWorker, dir: '/ocr/x/', tuning: { workers: 1 }, hand, stats, debug }))
    expect(calls.hand).toBe(0)
    expect(hand.seen).toHaveLength(1)
    expect(hand.seen[0].length).toBeGreaterThanOrEqual(1)
    expect(hand.seen[0].every((inp) => inp.data.length === inp.w * 48)).toBe(true)
    // one crop of the row's margin, round the mark, up to the SV column
    expect(debug.bands).toHaveLength(1)
    const box = debug.bands[0].box
    expect(box.x0).toBeLessThanOrEqual(160)
    expect(box.x0 + box.w).toBeGreaterThanOrEqual(177)
    expect(box.x0 + box.w).toBeLessThan(211)
    // the number taken, amber (a handwritten mark is never sure)
    expect(dora(roster).number).toBe(12)
    expect(dora(roster).confidence.number).toBeLessThanOrEqual(0.7)
    expect(stats.marksBy).toBe('onnx')
    expect(hand.ended).toBe(true)
  })

  it('the handwriting reader fails or did not load: Tesseract reads the marks, as before', async () => {
    const t1 = tesseractFor({ hand: '8' })
    const broken = handReader(() => { throw Object.assign(new Error('memory access out of bounds'), { code: 'hand-read' }) })
    const stats = {}
    const roster = await withCanvases(() => readRosterPhoto(pageWithMark(), { createWorker: t1.createWorker, dir: '/ocr/x/', tuning: { workers: 1 }, hand: broken, stats }))
    expect(t1.calls.hand).toBeGreaterThanOrEqual(1)
    expect(dora(roster).number).toBe(8)
    expect(stats.marksBy).toBe('tesseract')
    const t2 = tesseractFor({ hand: '8' })
    const never = { loaded: false, ended: false, ready: Promise.reject(Object.assign(new Error('no SIMD'), { code: 'hand-unsupported' })), read: vi.fn(), terminate () {} }
    never.ready.catch(() => {})
    const stats2 = {}
    const roster2 = await withCanvases(() => readRosterPhoto(pageWithMark(), { createWorker: t2.createWorker, dir: '/ocr/x/', tuning: { workers: 1 }, hand: never, stats: stats2 }))
    expect(never.read).not.toHaveBeenCalled()
    expect(dora(roster2).number).toBe(8)
    expect(stats2.marksBy).toBe('tesseract')
  })

  it('a reader still loading is waited for only when there is handwriting to read', async () => {
    const { createWorker } = tesseractFor()
    const loading = { loaded: false, ended: false, ready: new Promise(() => {}), read: vi.fn(), terminate () {} }
    const blank = pageWithMark()
    blank.gray.fill(255)
    const stats = {}
    const t0 = Date.now()
    await withCanvases(() => readRosterPhoto(blank, { createWorker, dir: '/ocr/x/', tuning: { workers: 1 }, hand: loading, stats }))
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(loading.read).not.toHaveBeenCalled()
    expect(stats.marksBy).toBe('tesseract')
  })

  it('the list\'s language: the workers start with its languages; two read the page side by side, one language each', async () => {
    const created = []
    const switched = []
    const createWorker = vi.fn(async (langs) => {
      const k = created.push(langs) - 1
      return { setParameters: async () => {}, recognize: async () => ({ data: vmShot }), terminate: async () => {}, reinitialize: async (l) => { switched.push([k, l]) } }
    })
    const engine = startOcrEngine({ size: 3, createWorker, dir: '/ocr/x/', langs: ['fra', 'deu'], hand: false })
    await engine.ready
    expect(created).toEqual([['fra', 'deu'], ['fra', 'deu'], ['fra', 'deu']])
    expect(engine.apart).toBe(true)
    expect(engine.hand).toBeNull()
    const canvas = Object.assign(document.createElement('canvas'), { width: 4, height: 6 })
    canvas.gray = new Uint8ClampedArray(24).fill(255)
    await readRosterPhoto(canvas, { engine, createWorker })
    expect(switched.slice(0, 3).sort()).toEqual([[0, 'fra'], [1, 'deu'], [2, ['fra', 'deu']]])
    await engine.terminate()
    // one language: one worker reads the page, no switching
    const one = fakeTesseract()
    const roster = await readRosterPhoto(new Blob(['page']), { createWorker: one.createWorker, dir: '/ocr/x/', langs: ['deu'] })
    expect(one.calls.create.langs).toEqual(['deu'])
    expect(roster.players).toHaveLength(10)
  })
})
