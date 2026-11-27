import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { HAND_MODEL_PATH, handModelBytes, handNotice, ocrFiles, ortVersion, wasmScript } from '../../vite-plugin-ocr-assets.js'
import { HAND_MODEL, HAND_ORT_VERSION } from '../utils/rosterPhoto/handFiles'
import { handPaths } from '../utils/rosterPhoto/ocrFiles'
import pkg from '../../package.json'

const sha = (b) => createHash('sha256').update(b).digest('hex')

describe('vite-plugin-ocr-assets: the handwriting reader\'s files', () => {
  it('onnxruntime-web is the version handFiles.js names, pinned exactly in package.json', () => {
    expect(ortVersion()).toBe(HAND_ORT_VERSION)
    expect(pkg.dependencies['onnxruntime-web']).toBe(HAND_ORT_VERSION)
  })

  it('every file the reader loads is in the build, beside its notice; no .wasm and no .gz file (F-Droid\'s scanner)', () => {
    const files = ocrFiles().map((f) => f.fileName)
    const at = `ocr/hand-${HAND_ORT_VERSION}/`
    for (const url of handPaths(`/${at}`).urls) expect(files).toContain(url.slice(1))
    expect(files).toContain(`${at}NOTICE.txt`)
    expect(files.filter((f) => /\.(wasm|gz|tgz|zip|jar|so|bin)$/.test(f))).toEqual([])
    const notice = handNotice().toString('utf8')
    expect(notice).toContain(HAND_MODEL.sha256)
    expect(notice).toContain('Apache License')
    expect(notice).toContain('MIT License')
    // (a new onnxruntime-web: vendor/ppocr/NOTICE.txt names it too)
    expect(notice).toContain(`ONNX Runtime Web ${HAND_ORT_VERSION}`)
  })

  it('the engine\'s WebAssembly goes into its script whole', () => {
    const wasm = readFileSync(join(__dirname, '..', '..', 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm'))
    const script = wasmScript(wasm).toString('utf8')
    const b64 = script.slice(script.indexOf('"') + 1, script.lastIndexOf('"'))
    expect(sha(Buffer.from(b64, 'base64'))).toBe(sha(wasm))
  })

  it('the model is committed (vendor/ppocr/, no network at build time) and checked by its SHA-256; OV_HAND_MODEL only overrides the file', () => {
    expect(sha(readFileSync(HAND_MODEL_PATH))).toBe(HAND_MODEL.sha256)
    expect(handModelBytes().length).toBe(HAND_MODEL.bytes)
    const dir = mkdtempSync(join(tmpdir(), 'ov-hand-model-'))
    try {
      const other = join(dir, 'other.onnx')
      writeFileSync(other, 'tampered')
      expect(() => handModelBytes({ path: other })).toThrow(/is not PP-OCRv6_rec_tiny\.onnx: SHA-256/)
      expect(() => handModelBytes({ path: join(dir, 'missing.onnx') })).toThrow(/missing/)
      // an override with its own right bytes is taken
      const bytes = Buffer.from('a made-up model')
      const mine = join(dir, 'mine.onnx')
      writeFileSync(mine, bytes)
      expect(handModelBytes({ path: mine, model: { file: 'mine.onnx', sha256: sha(bytes) } }).equals(bytes)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
