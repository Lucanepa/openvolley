/**
 * What the handwriting reader's model is handed and what it answers
 * (handReader.js; PP-OCRv6 rec tiny, handFiles.js), as the handwriting study
 * measured it on the real photos (2026-11-27): a crop of grey pixels scaled
 * to 48 pixels high (antialiased bilinear, as Pillow's BILINEAR), its three
 * colour channels the same grey, (v / 255 - 0.5) / 0.5, padded on the right
 * with 0 to at least 128 wide (RapidOCR pads to 320: the same marks, slower);
 * the answer decoded
 * greedily (CTC) with only blank, the digits, C, K and L allowed, the
 * reading's confidence its least sure letter. Pure: the worker and the tests
 * use it as it is.
 */
import { HAND_CLASSES } from './handFiles'

export const HAND_INPUT_HEIGHT = 48
// narrower inputs are padded to this width, as RapidOCR does (3x48x320). 128 was
// tried (27.11): in the app's own reading of the real photos it read 1-3 marks
// fewer right and saved only a quarter of the marks' time (~0.25 s on an A7 Lite)
export const HAND_INPUT_MIN_WIDTH = 320
// a crop is never narrower than this before the padding
const MIN_WIDTH = 16
// at most this many crops in one run of the model (a few MB each on a tablet)
export const HAND_BATCH = 8

const CHAR_OF = new Map(HAND_CLASSES)
// blank first, then the allowed classes in their order (ties go to the lower class)
const ALLOWED = Int32Array.from([0, ...HAND_CLASSES.map(([k]) => k)].sort((a, b) => a - b))

/** The 1-D weights of an antialiased bilinear resize of `inSize` samples to `outSize` (Pillow's precompute_coeffs). */
function coefficients (inSize, outSize) {
  const scale = inSize / outSize
  const filterScale = Math.max(scale, 1)
  const support = filterScale
  const out = []
  for (let x = 0; x < outSize; x++) {
    const center = (x + 0.5) * scale
    const min = Math.max(0, Math.trunc(center - support + 0.5))
    const max = Math.min(inSize, Math.trunc(center + support + 0.5))
    const w = []
    let sum = 0
    for (let i = min; i < max; i++) {
      const t = Math.abs((i - center + 0.5) / filterScale)
      const v = t < 1 ? 1 - t : 0
      w.push(v)
      sum += v
    }
    out.push({ min, w: sum > 0 ? w.map((v) => v / sum) : w })
  }
  return out
}

/**
 * A region of grey pixels (row stride `stride`) resized to outW x outH,
 * antialiased bilinear: horizontally, then vertically (as Pillow does).
 * Pixels outside `gray` count as white paper.
 * @returns {Float32Array} outW * outH grey values 0..255
 */
export function resampleGray (gray, stride, rows, { x0, y0, w, h }, outW, outH) {
  const at = (x, y) => (x < 0 || y < 0 || x >= stride || y >= rows ? 255 : gray[y * stride + x])
  const cx = coefficients(w, outW)
  const cy = coefficients(h, outH)
  const mid = new Float32Array(outW * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < outW; x++) {
      const { min, w: k } = cx[x]
      let v = 0
      for (let i = 0; i < k.length; i++) v += k[i] * at(x0 + min + i, y0 + y)
      mid[y * outW + x] = v
    }
  }
  const out = new Float32Array(outW * outH)
  for (let y = 0; y < outH; y++) {
    const { min, w: k } = cy[y]
    for (let x = 0; x < outW; x++) {
      let v = 0
      for (let i = 0; i < k.length; i++) v += k[i] * mid[(min + i) * outW + x]
      out[y * outW + x] = v
    }
  }
  return out
}

/**
 * One crop as the model reads it: { w, data } with data the crop's grey
 * pixels scaled to HAND_INPUT_HEIGHT x w, normalised to -1..1 (one channel;
 * the worker repeats it three times and pads it).
 * @param {{ x0, y0, w, h }} region page pixels (outside the page: white)
 */
export function handInput (gray, width, height, region) {
  const w = Math.max(MIN_WIDTH, Math.ceil((HAND_INPUT_HEIGHT * region.w) / Math.max(1, region.h)))
  const px = resampleGray(gray, width, height, region, w, HAND_INPUT_HEIGHT)
  const data = new Float32Array(px.length)
  for (let i = 0; i < px.length; i++) data[i] = (Math.min(255, Math.max(0, px[i])) / 255 - 0.5) / 0.5
  return { w, data }
}

/** The width an input is run at: itself, padded to HAND_INPUT_MIN_WIDTH at least. */
export const paddedWidth = (w) => Math.max(w, HAND_INPUT_MIN_WIDTH)

/**
 * The inputs in runs of the model: those of the same padded width together,
 * at most HAND_BATCH a run (a crop alone gives the same answer: nothing in
 * the model looks across a batch). [{ width, items: [index...] }]
 */
export function batchesOf (inputs) {
  const byWidth = new Map()
  inputs.forEach((inp, k) => {
    const W = paddedWidth(inp.w)
    if (!byWidth.has(W)) byWidth.set(W, [])
    byWidth.get(W).push(k)
  })
  const out = []
  for (const [width, ks] of byWidth) for (let i = 0; i < ks.length; i += HAND_BATCH) out.push({ width, items: ks.slice(i, i + HAND_BATCH) })
  return out
}

/** A run's input tensor data: n x 3 x 48 x width, each crop's grey in the three channels, 0 to its right. */
export function batchTensor (inputs, items, width) {
  const H = HAND_INPUT_HEIGHT
  const plane = H * width
  const out = new Float32Array(items.length * 3 * plane)
  items.forEach((k, j) => {
    const { w, data } = inputs[k]
    for (let c = 0; c < 3; c++) {
      const base = (j * 3 + c) * plane
      for (let y = 0; y < H; y++) out.set(data.subarray(y * w, y * w + w), base + y * width)
    }
  })
  return out
}

/**
 * The model's answer for one crop (probabilities, T steps x C classes from
 * `offset`), decoded greedily with only blank, 0-9, C, K and L: each step's
 * likeliest of those (their probabilities made to sum to 1), repeats merged,
 * blanks dropped. conf: the least sure letter (0 with none).
 * @returns {{ text: string, conf: number }}
 */
export function decodeHand (probs, steps, classes, offset = 0) {
  let text = ''
  const confs = []
  let last = -1
  for (let t = 0; t < steps; t++) {
    const row = offset + t * classes
    let sum = 0
    let best = 0
    let bestP = -1
    for (let i = 0; i < ALLOWED.length; i++) {
      const p = probs[row + ALLOWED[i]]
      sum += p
      if (p > bestP) { bestP = p; best = ALLOWED[i] }
    }
    const p = sum > 0 ? bestP / sum : 0
    if (best !== last && best !== 0) {
      text += CHAR_OF.get(best)
      confs.push(p)
    } else if (best === last && best !== 0 && confs.length) {
      confs[confs.length - 1] = Math.max(confs[confs.length - 1], p)
    }
    last = best
  }
  return { text, conf: confs.length ? Math.min(...confs) : 0 }
}

/** The WebAssembly of a `.wasm.js` file (vite-plugin-ocr-assets.js: `export default "<base64>"`) as bytes. */
export function wasmOfScript (source) {
  const s = String(source)
  const a = s.indexOf('"')
  const b = s.lastIndexOf('"')
  if (a < 0 || b <= a) throw new Error('No WebAssembly in the file')
  const b64 = s.slice(a + 1, b)
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
