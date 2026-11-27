import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { handModelBytes, handNotice, ocrFiles, ortVersion, wasmScript } from '../../vite-plugin-ocr-assets.js'
import { HAND_MODEL, HAND_ORT_VERSION } from '../utils/rosterPhoto/handFiles'
import { handPaths } from '../utils/rosterPhoto/ocrFiles'
import pkg from '../../package.json'

const sha = (b) => createHash('sha256').update(b).digest('hex')

describe('vite-plugin-ocr-assets: the handwriting reader\'s files', () => {
  it('onnxruntime-web is the version handFiles.js names, pinned exactly in package.json', () => {
    expect(ortVersion()).toBe(HAND_ORT_VERSION)
    expect(pkg.dependencies['onnxruntime-web']).toBe(HAND_ORT_VERSION)
  })

  it('every file the reader loads is in the build, beside a notice; no .wasm and no .gz file (F-Droid\'s scanner)', () => {
    const files = ocrFiles({ model: Buffer.from('model') }).map((f) => f.fileName)
    const at = `ocr/hand-${HAND_ORT_VERSION}/`
    for (const url of handPaths(`/${at}`).urls) expect(files).toContain(url.slice(1))
    expect(files).toContain(`${at}NOTICE.txt`)
    expect(files.filter((f) => /\.(wasm|gz|tgz|zip|jar|so|bin)$/.test(f))).toEqual([])
    // without the model's bytes, no model file (never an empty one)
    expect(ocrFiles().map((f) => f.fileName)).not.toContain(`${at}${HAND_MODEL.file}`)
    const notice = handNotice().toString('utf8')
    expect(notice).toContain(HAND_MODEL.sha256)
    expect(notice).toContain('Apache License')
    expect(notice).toContain('MIT License')
  })

  it('the engine\'s WebAssembly goes into its script whole', () => {
    const wasm = readFileSync(join(__dirname, '..', '..', 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm'))
    const script = wasmScript(wasm).toString('utf8')
    const b64 = script.slice(script.indexOf('"') + 1, script.lastIndexOf('"'))
    expect(sha(Buffer.from(b64, 'base64'))).toBe(sha(wasm))
  })

  it('the model: a copy on disk or the cache when its SHA-256 is right, else downloaded once and cached; other bytes fail', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'ov-hand-model-'))
    try {
      // a download that gives other bytes: refused, three tries, nothing cached
      let calls = 0
      const wrong = async () => { calls++; return { ok: true, arrayBuffer: async () => new TextEncoder().encode('tampered').buffer } }
      await expect(handModelBytes({ cacheDir, local: undefined, fetchFn: wrong, log: () => {} })).rejects.toThrow(/could not be downloaded.*OV_HAND_MODEL/)
      expect(calls).toBe(3)
      expect(existsSync(join(cacheDir, `${HAND_MODEL.sha256}.onnx`))).toBe(false)
      // a copy on disk with other bytes: refused at once, no download
      const local = join(cacheDir, 'copy.onnx')
      writeFileSync(local, 'tampered')
      let fetched = 0
      await expect(handModelBytes({ cacheDir, local, fetchFn: async () => { fetched++ }, log: () => {} })).rejects.toThrow(/OV_HAND_MODEL/)
      expect(fetched).toBe(0)
      // an HTTP error: refused
      await expect(handModelBytes({ cacheDir, fetchFn: async () => ({ ok: false, status: 503 }), log: () => {} })).rejects.toThrow(/HTTP 503/)
      // the right bytes (a made-up file and its own pin): downloaded once, then from the cache
      const bytes = Buffer.from('a made-up model')
      const model = { file: 'x.onnx', url: 'https://example.invalid/x.onnx', sha256: sha(bytes), bytes: bytes.length }
      let downloads = 0
      const ok = async () => { downloads++; return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) } }
      expect((await handModelBytes({ cacheDir, fetchFn: ok, log: () => {}, model })).equals(bytes)).toBe(true)
      expect((await handModelBytes({ cacheDir, fetchFn: ok, log: () => {}, model })).equals(bytes)).toBe(true)
      expect(downloads).toBe(1)
      expect(readFileSync(join(cacheDir, `${model.sha256}.onnx`)).equals(bytes)).toBe(true)
      // a copy on disk with the right bytes: no download
      const copy = join(cacheDir, 'mine.onnx')
      writeFileSync(copy, bytes)
      expect((await handModelBytes({ cacheDir: join(cacheDir, 'empty'), local: copy, fetchFn: async () => { throw new Error('no network') }, log: () => {}, model })).equals(bytes)).toBe(true)
      // OV_HAND_MODEL=skip: no model (the marks by Tesseract), said loudly
      const said = []
      expect(await handModelBytes({ cacheDir, local: 'skip', fetchFn: ok, log: (m) => said.push(m), model })).toBeNull()
      expect(said.join(' ')).toMatch(/WITHOUT/)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })
})
