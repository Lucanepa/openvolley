import { describe, it, expect } from 'vitest'
import { HAND_BATCH, HAND_INPUT_HEIGHT, batchTensor, batchesOf, decodeHand, handInput, paddedWidth, resampleGray, wasmOfScript } from '../handModel'
import { HAND_CLASSES, HAND_CLASS_COUNT } from '../handFiles'
import { wasmScript } from '../../../../vite-plugin-ocr-assets.js'

// a grey image w x h from f(x, y)
const img = (w, h, f) => Uint8ClampedArray.from({ length: w * h }, (_, i) => f(i % w, Math.floor(i / w)))

describe('handModel: what the handwriting reader is handed', () => {
  it('resampleGray: a flat grey stays flat; half the size averages pairs; outside the image is white paper', () => {
    const flat = resampleGray(img(40, 20, () => 90), 40, 20, { x0: 0, y0: 0, w: 40, h: 20 }, 13, 7)
    expect([...flat].every((v) => Math.abs(v - 90) < 1e-3)).toBe(true)
    // as Pillow's BILINEAR (the study's resize): columns 0 / 255 halved, and a pattern scaled
    // both ways (values from Pillow, which rounds between its two passes: within 1)
    const half = resampleGray(img(8, 2, (x) => (x % 2 ? 255 : 0)), 8, 2, { x0: 0, y0: 0, w: 8, h: 2 }, 4, 1)
    expect([...half].map((v) => Math.round(v))).toEqual([109, 128, 128, 146])
    const pattern = resampleGray(img(37, 23, (x, y) => (x * 7 + y * 13) % 256), 37, 23, { x0: 0, y0: 0, w: 37, h: 23 }, 20, 48)
    const pillow = [[0, 0, 4], [0, 5, 68], [0, 19, 248], [10, 0, 63], [10, 5, 127], [10, 19, 51], [47, 0, 34], [47, 5, 98], [47, 19, 22]]
    for (const [y, x, v] of pillow) expect(Math.abs(pattern[y * 20 + x] - v)).toBeLessThanOrEqual(1)
    const outside = resampleGray(img(4, 4, () => 0), 4, 4, { x0: -8, y0: 0, w: 4, h: 4 }, 4, 4)
    expect([...outside].every((v) => v === 255)).toBe(true)
  })

  it('handInput: 48 high, as wide as the crop keeps its shape (16 at least), -1 (ink) .. 1 (paper)', () => {
    const g = img(100, 50, (x) => (x < 50 ? 0 : 255))
    const inp = handInput(g, 100, 50, { x0: 0, y0: 0, w: 100, h: 50 })
    expect(inp.w).toBe(96)
    expect(inp.data).toHaveLength(96 * HAND_INPUT_HEIGHT)
    expect(inp.data[10]).toBeCloseTo(-1, 5)
    expect(inp.data[90]).toBeCloseTo(1, 5)
    expect(handInput(g, 100, 50, { x0: 0, y0: 0, w: 2, h: 50 }).w).toBe(16)
  })

  it('batchesOf: the same padded width together, HAND_BATCH at most; batchTensor: three channels, 0 to the right', () => {
    expect(HAND_BATCH).toBe(8)
    expect(paddedWidth(20)).toBe(128)
    expect(paddedWidth(400)).toBe(400)
    const inputs = [{ w: 20 }, { w: 400 }, { w: 300 }, ...Array.from({ length: 8 }, () => ({ w: 50 }))]
    expect(batchesOf(inputs)).toEqual([
      { width: 128, items: [0, 3, 4, 5, 6, 7, 8, 9] },
      { width: 128, items: [10] },
      { width: 400, items: [1] },
      { width: 300, items: [2] }
    ])
    const two = [{ w: 2, data: Float32Array.from({ length: 2 * 48 }, () => 0.5) }, { w: 3, data: Float32Array.from({ length: 3 * 48 }, () => -0.5) }]
    const t = batchTensor(two, [0, 1], 4)
    expect(t).toHaveLength(2 * 3 * 48 * 4)
    // crop 0, channel 2, row 47: 0.5 0.5 0 0; crop 1, channel 0, row 0: -0.5 x3, 0
    expect([...t.slice((0 * 3 + 2) * 192 + 47 * 4, (0 * 3 + 2) * 192 + 48 * 4)]).toEqual([0.5, 0.5, 0, 0])
    expect([...t.slice((1 * 3 + 0) * 192, (1 * 3 + 0) * 192 + 4)]).toEqual([-0.5, -0.5, -0.5, 0])
  })

  it('decodeHand: only blank, digits, C K L; repeats merged, blanks dropped; small c k l as capitals; the least sure letter', () => {
    const C = HAND_CLASS_COUNT
    // classes: 34 '1', 35 '2', 40 '7', 45 'C', 46 a letter not allowed, 54 'L', 71 'c'
    expect(HAND_CLASSES.filter(([k]) => [34, 35, 40, 45, 54, 71].includes(k)).map(([, ch]) => ch)).toEqual(['1', '2', '7', 'C', 'L', 'C'])
    // a step: probabilities for some classes, the rest a little each
    const step = (probs) => { const p = new Float32Array(C).fill(0.0001); for (const [k, v] of Object.entries(probs)) p[k] = v; return p }
    const steps = [
      step({ 46: 0.9, 34: 0.08 }), // a letter not allowed is likeliest: the 1 among the allowed
      step({ 34: 0.5, 0: 0.1 }), // the same 1 again: merged
      step({ 0: 0.9 }), // blank
      step({ 35: 0.3, 40: 0.2 }),
      step({ 71: 0.6 }), // a small c: the captain's C
      step({ 54: 0.7 })
    ]
    const probs = new Float32Array(steps.length * C)
    steps.forEach((p, t) => probs.set(p, t * C))
    const { text, conf } = decodeHand(probs, steps.length, C)
    expect(text).toBe('12CL')
    // the 2 was the least sure: 0.3 of what the allowed classes had at that step
    expect(conf).toBeGreaterThan(0.55)
    expect(conf).toBeLessThan(0.6)
    expect(decodeHand(new Float32Array(2 * C).fill(0), 2, C)).toEqual({ text: '', conf: 0 })
    // a crop further along a batch (offset)
    const two = new Float32Array(2 * steps.length * C)
    two.set(probs, steps.length * C)
    expect(decodeHand(two, steps.length, C, steps.length * C).text).toBe('12CL')
  })

  it('wasmOfScript: the bytes the build wrote into its .wasm.js (vite-plugin-ocr-assets.js)', () => {
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 37) & 255)
    const script = wasmScript(bytes, '0.0.0').toString('utf8')
    expect(script).toMatch(/^\/\*! onnxruntime-web 0\.0\.0 .*\*\/\nexport default "/)
    expect([...wasmOfScript(script)]).toEqual([...bytes])
    expect(() => wasmOfScript('export default 1')).toThrow()
  })
})
