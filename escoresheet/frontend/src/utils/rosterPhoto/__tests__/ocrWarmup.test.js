import { describe, it, expect, vi, afterEach } from 'vitest'
import { WARM_FLAG, warmUpBlocker, warmUpOcrFiles, warmUpUrls, scheduleOcrWarmUp } from '../ocrWarmup'
import { readRosterPhoto } from '../ocr'
import vmShot from './fixtures/ocr-vm-de-screenshot.json'

// a web page with a service worker in charge, online, visible, Data Saver off
const memory = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m }
}
const env = ({ controller = {}, onLine = true, visibility = 'visible', saveData = false, storage = memory(), win = {} } = {}) => ({
  win: { document: { visibilityState: visibility }, ...win },
  nav: { serviceWorker: { controller }, onLine, connection: { saveData } },
  storage
})

afterEach(() => {
  delete window.Capacitor
  delete window.__TAURI_INTERNALS__
  vi.useRealTimers()
})

describe('the recognition files loaded ahead on the web (first Match setup)', () => {
  it('goes on the web, online, visible, with a service worker, not done yet', () => {
    expect(warmUpBlocker(env())).toBeNull()
  })

  it('not in the native apps (their build carries the files)', () => {
    window.Capacitor = { isNativePlatform: () => true }
    expect(warmUpBlocker(env())).toBe('native')
    delete window.Capacitor
    expect(warmUpBlocker(env({ win: { __TAURI_INTERNALS__: { invoke: () => {} } } }))).toBe('native')
    expect(warmUpBlocker(env({ win: { electronAPI: {} } }))).toBe('native')
  })

  it('not offline, hidden, with Data Saver, without a service worker, or once done for this version', () => {
    expect(warmUpBlocker(env({ onLine: false }))).toBe('offline')
    expect(warmUpBlocker(env({ visibility: 'hidden' }))).toBe('hidden')
    expect(warmUpBlocker(env({ saveData: true }))).toBe('save-data')
    expect(warmUpBlocker(env({ controller: null }))).toBe('no-service-worker')
    expect(warmUpBlocker(env({ storage: memory({ [WARM_FLAG]: '1' }) }))).toBe('done')
    expect(WARM_FLAG).toMatch(/^ov-ocr-files-\d+\.\d+\.\d+/)
  })

  it('loads exactly the files ocr.js starts Tesseract with: the worker, this device\'s engine, the three languages', async () => {
    for (const simd of [true, false]) {
      const urls = await warmUpUrls({ dir: '/ocr/x/', simd })
      let options = null
      const createWorker = async (langs, oem, opts) => {
        options = { langs, ...opts }
        return { setParameters: async () => {}, recognize: async () => ({ data: vmShot }), terminate: async () => {} }
      }
      vi.resetModules()
      vi.doMock('wasm-feature-detect', () => ({ simd: async () => simd }))
      const { readRosterPhoto: read } = await import('../ocr')
      await read(new Blob(['page']), { createWorker, dir: '/ocr/x/' })
      vi.doUnmock('wasm-feature-detect')
      expect(options.corePath).toMatch(simd ? /tesseract-core-simd-lstm\.wasm\.js$/ : /tesseract-core-lstm\.wasm\.js$/)
      expect(urls).toEqual([options.workerPath, options.corePath, ...options.langs.map((l) => `${options.langPath}/${l}.traineddata`)])
    }
    expect(typeof readRosterPhoto).toBe('function')
  })

  it('one file after another at low priority; the flag once all came; nothing fetched when the cache has them', async () => {
    const urls = ['/ocr/x/worker.min.js', '/ocr/x/core.wasm.js', '/ocr/x/lang/deu.traineddata']
    const seen = []
    const fetchFn = vi.fn(async (u, opts) => { seen.push([u, opts.priority]); return { ok: true, blob: async () => new Blob(['x']) } })
    const storage = memory()
    expect(await warmUpOcrFiles({ urls, fetchFn, cachesApi: { match: async () => undefined }, storage, log: () => {} })).toBe('loaded')
    expect(seen).toEqual(urls.map((u) => [u, 'low']))
    expect(storage.getItem(WARM_FLAG)).toBe('1')
    const again = vi.fn()
    const s2 = memory()
    expect(await warmUpOcrFiles({ urls, fetchFn: again, cachesApi: { match: async () => ({}) }, storage: s2, log: () => {} })).toBe('cached')
    expect(again).not.toHaveBeenCalled()
    expect(s2.getItem(WARM_FLAG)).toBe('1')
  })

  it('a failure is quiet and leaves no flag: the next Match setup tries again', async () => {
    const storage = memory()
    const log = vi.fn()
    const fetchFn = vi.fn(async (u) => (u.endsWith('deu.traineddata') ? { ok: false, status: 503 } : { ok: true, blob: async () => new Blob(['x']) }))
    expect(await warmUpOcrFiles({ urls: ['/a.js', '/lang/deu.traineddata', '/lang/fra.traineddata'], fetchFn, cachesApi: null, storage, log })).toBe('failed')
    expect(storage.getItem(WARM_FLAG)).toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalled()
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    expect(await warmUpOcrFiles({ urls: ['/a.js'], fetchFn: offline, cachesApi: null, storage, log })).toBe('failed')
  })

  it('scheduled after Match setup is on screen, when idle; nothing when blocked; cancelled on leaving', () => {
    vi.useFakeTimers()
    const start = vi.fn()
    scheduleOcrWarmUp({ delayMs: 1000, blocker: () => 'offline', start })
    vi.advanceTimersByTime(5000)
    expect(start).not.toHaveBeenCalled()
    scheduleOcrWarmUp({ delayMs: 1000, blocker: () => null, start })
    vi.advanceTimersByTime(999)
    expect(start).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20000)
    expect(start).toHaveBeenCalledTimes(1)
    const cancel = scheduleOcrWarmUp({ delayMs: 1000, blocker: () => null, start })
    cancel()
    vi.advanceTimersByTime(20000)
    expect(start).toHaveBeenCalledTimes(1)
  })
})
