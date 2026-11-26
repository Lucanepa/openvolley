/**
 * The text recognition of a photo import (docs/roster-photo-spec.md, plan A):
 * Tesseract.js on this device, with the app's own copy of its engine and of
 * the German, French and Italian language data (vite-plugin-ocr-assets.js,
 * ocr/<version>/). Nothing leaves the device and nothing needs a network,
 * except on the web, where the files load on the first photo import.
 *
 * readRosterPhoto(page) -> the imported roster (domain/importedRoster,
 * source 'ocr'), or an error with a code:
 *   ocr-load     the recognition could not start (the web offline before its
 *                first use; a WebView without WebAssembly)
 *   ocr-timeout  it took longer than OCR_TIMEOUT_MS
 *   ocr-empty    it read no player row
 *   ocr-blurry   it read the page too unsure to give a list (out of focus,
 *                shaken): the scorer takes the photo again
 *   ocr-cancelled  the scorer closed the dialog (opts.signal)
 */

import { version as TESSERACT_VERSION } from 'tesseract.js/package.json'
import { importedRosterOf } from '../../domain/importedRoster'
import { withTimeout, PDF_TIMEOUT_CODE } from '../parseRosterPdf'
import { rosterFromOcr, withHandReadings, HANDWRITTEN_MAX } from './ocrRoster'
import { handInk, ringInRegion, ringScore, struckThrough, turnGray } from './scan'

// a number counts as circled when ink rings it this fully (scan.js ringScore)
const CIRCLED_SCORE = 0.8

/** The page's grey pixels (and those before its rules went: scan.js scanPage), null for a Blob. */
function pixelsOf (page) {
  if (typeof page?.getContext !== 'function') return null
  const { width, height } = page
  const rgba = page.getContext('2d').getImageData(0, 0, width, height).data
  const gray = new Uint8ClampedArray(width * height)
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = rgba[j]
  const before = page.beforeRules?.length === gray.length ? page.beforeRules : gray
  return { gray, before, width, height }
}

/**
 * The page's pixels asked about what the words alone do not tell
 * (ocrRoster rosterFromOcr): whether a word is circled, a circle in a
 * region, whether a row is struck out; nothing for a Blob.
 */
function circlesOn (px) {
  if (!px) return {}
  const { gray, before, width, height } = px
  const ringAt = (region, line) => ringInRegion(gray, width, height, region, line)
  return {
    struck: (words) => struckThrough(before, width, height, words),
    // a ring round the number's box, or one the recognition took into the box
    circled: (w) => {
      if (ringScore(gray, width, height, w) >= CIRCLED_SCORE) return true
      const h = w.y1 - w.y0
      return !!ringAt({ x0: w.x0 - h * 0.3, y0: w.y0 - h * 0.3, x1: w.x1 + h * 0.3, y1: w.y1 + h * 0.3 }, h / 1.6)
    },
    ringAt
  }
}

/**
 * The number inside a circle the first reading skipped: that box alone, cut
 * out into a small canvas (Tesseract encodes a canvas it is given as PNG on
 * the main thread: the whole page again would take seconds on a tablet),
 * digits only.
 */
async function readCircledNumber (worker, page, box) {
  const pad = Math.max(4, Math.round((box.y1 - box.y0) * 0.25))
  const left = Math.max(0, Math.floor(box.x0 - pad))
  const top = Math.max(0, Math.floor(box.y0 - pad))
  const width = Math.min(page.width - left, Math.ceil(box.x1 - box.x0 + 2 * pad))
  const height = Math.min(page.height - top, Math.ceil(box.y1 - box.y0 + 2 * pad))
  const cut = document.createElement('canvas')
  // white round the digits, as on paper
  cut.width = width + 2 * pad
  cut.height = height + 2 * pad
  const ctx = cut.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, cut.width, cut.height)
  ctx.drawImage(page, left, top, width, height, pad, pad, width, height)
  const { data } = await worker.recognize(cut, {}, { text: true })
  const m = /^\D*(\d{1,2})\D*$/.exec(String(data?.text || '').trim())
  return m && Number(m[1]) >= 1 ? { number: Number(m[1]), conf: (data.confidence ?? 0) / 100 } : null
}

export const OCR_LANGS = ['deu', 'fra', 'ita']
// A page in a few seconds on a desktop; a slow tablet takes far longer
// (Galaxy Tab A7 Lite). Past this the scorer gets a message, not a spinner.
export const OCR_TIMEOUT_MS = 120000
// Starting the worker: the engine and the three languages (~10 MB) read from the app's files
export const OCR_START_TIMEOUT_MS = 60000

const LSTM_ONLY = 1
// One block of text: the table's rows come out as lines across its columns
const PSM_SINGLE_BLOCK = '6'
// a circled number read again on its own
const PSM_SINGLE_WORD = '8'
// one line of text: the handwriting's sheet
const PSM_SINGLE_LINE = '7'
const CIRCLE_TIMEOUT_MS = 10000
// the team's handwriting read again: digits, C or K (captain), L (libero)
const HAND_CHARS = '0123456789CKL'
const HAND_TIMEOUT_MS = 20000
// at most this many groups of handwriting a row (a number, a mark, a circle)
const HAND_GROUPS = 4
// each scaled to letters about this high
const HAND_HEIGHT = 36
const HAND_GAP = 64
// a second reading below this is left out
const HAND_MIN_CONF = 0.3
// below this the whole page was read unsure (out of focus, shaken): no list
// comes of it, a "take it again" does (real photos, 2026-11-26: a blurry
// one read at 48, sharp ones at 66 or more)
export const BLURRY_CONFIDENCE = 55
// the page looked at small, to see which way up it is
const UPRIGHT_SIDE = 1100
// this many words read sure the way it lies: no need to try it turned
const UPRIGHT_ENOUGH = 12

/** The page (a canvas) turned a quarter clockwise per step and scaled, as a new canvas. */
function turnedCanvas (page, turns, scale = 1) {
  const n = ((turns % 4) + 4) % 4
  const w = Math.max(1, Math.round(page.width * scale))
  const h = Math.max(1, Math.round(page.height * scale))
  const out = document.createElement('canvas')
  out.width = n % 2 ? h : w
  out.height = n % 2 ? w : h
  const ctx = out.getContext('2d')
  ctx.translate(out.width / 2, out.height / 2)
  ctx.rotate((n * Math.PI) / 2)
  ctx.drawImage(page, -w / 2, -h / 2, w, h)
  return out
}

/** How many words of a reading came out sure (a word of three letters or four digits, 80 % or more). */
function sureWords (data) {
  let n = 0
  for (const b of data?.blocks || []) for (const para of b?.paragraphs || []) for (const l of para?.lines || []) {
    for (const w of l?.words || []) if ((w.confidence ?? 0) >= 80 && /\p{L}{3,}|\d{4,}/u.test(String(w.text || ''))) n++
  }
  return n
}

/**
 * How many quarter turns put the page's text the right way up, when the
 * page read as it lies gave few sure words (asIs): a small copy turned a
 * quarter either way, then upside down, until one reads well. The scorer
 * need not press Turn for a page photographed on its side (real photos,
 * 2026-11-26: four of thirteen); unsure, it stays as it is. A page the
 * right way up costs nothing: it is read once.
 */
async function uprightTurns (worker, page, asIs) {
  const scale = Math.min(1, UPRIGHT_SIDE / Math.max(page.width, page.height))
  const sure = async (turns) => sureWords((await worker.recognize(turnedCanvas(page, turns, scale), {}, { blocks: true, text: false })).data)
  let best = { turns: 0, n: asIs }
  for (const turns of [1, 3, 2]) {
    const n = await sure(turns)
    if (n > best.n) best = { turns, n }
    if (n >= UPRIGHT_ENOUGH) break
  }
  return best.n >= 2 * asIs + 3 ? best.turns : 0
}

/**
 * SV numbers read again, digits only, where the first reading was unsure of
 * them (ocrRoster licenceAt): one that starts right of its column, a digit
 * lost at the page's edge or under a pen ("23456" for 123456), read from the
 * column's start, taken only as the same number with one digit more in
 * front (read again as a whole, a handwritten SV number came out worse:
 * real photos, 2026-11-26). It stays to check.
 */
async function readLicencesAgain (worker, page, players) {
  await worker.setParameters({ tessedit_pageseg_mode: PSM_SINGLE_LINE, tessedit_char_whitelist: '0123456789' })
  const out = []
  for (const p of players) {
    const at = p.licenceAt
    if (!at) { out.push(p); continue }
    const pad = Math.max(3, Math.round((at.y1 - at.y0) * 0.25))
    const x = Math.max(0, Math.floor(at.x0))
    const y = Math.max(0, Math.floor(at.y0 - pad))
    const w = Math.min(page.width - x, Math.ceil(at.x1 - at.x0 + pad))
    const h = Math.min(page.height - y, Math.ceil(at.y1 - at.y0 + 2 * pad))
    if (w < 4 || h < 4) { out.push(p); continue }
    const cut = document.createElement('canvas')
    cut.width = w + 2 * pad
    cut.height = h + 2 * pad
    const ctx = cut.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, cut.width, cut.height)
    ctx.drawImage(page, x, y, w, h, pad, pad, w, h)
    const { data } = await worker.recognize(cut, {}, { text: true })
    const digits = String(data?.text || '').replace(/\D/g, '')
    const conf = Math.min((data?.confidence ?? 0) / 100, 0.6)
    const now = String(p.licence || '')
    const take = digits.length === now.length + 1 && digits.endsWith(now) && /^\d{6}$/.test(digits)
    out.push(take ? { ...p, licence: digits, confidence: { ...p.confidence, licence: Math.min(p.confidence?.licence ?? conf, conf) } } : p)
  }
  return out
}

/**
 * The team's handwriting on each player row (scan.js handInk: ink the print
 * does not explain, left of the SV number up to the date and right of the
 * table), cut out and stacked on one small sheet, one group a line, and read
 * at once with digits, C, K and L only: Tesseract reads a whole page with
 * the print's eyes and makes letters of a "99" or a "3K" between the
 * columns (real photos, 2026-11-26). A circled group: what is inside the
 * circle, and the captain. Each player then gets what its groups read
 * (ocrRoster withHandReadings).
 */
async function readHandwriting (worker, page, px, players, debug) {
  const items = []
  players.forEach((p, i) => {
    const at = p.handAt
    if (!at) return
    for (const g of handInk(px.gray, px.width, px.height, at, { leftOf: at.left }).slice(0, HAND_GROUPS)) {
      const pad = 0.25 * at.line
      const ring = ringInRegion(px.gray, px.width, px.height, { x0: g.x0 - pad, y0: g.y0 - pad, x1: g.x1 + pad, y1: g.y1 + pad }, at.line)
      items.push({ i, box: ring ? ring.inner : g, ringed: !!ring, skip: at.skip, line: at.line })
    }
  })
  if (!items.length) return players
  const cuts = items.map((it) => {
    const pad = Math.max(3, Math.round(0.2 * it.line))
    const x = Math.max(0, Math.floor(it.box.x0 - pad))
    const y = Math.max(0, Math.floor(it.box.y0 - pad))
    const w = Math.min(page.width - x, Math.ceil(it.box.x1 - it.box.x0 + 2 * pad))
    const h = Math.min(page.height - y, Math.ceil(it.box.y1 - it.box.y0 + 2 * pad))
    const scale = Math.min(2, Math.max(0.5, HAND_HEIGHT / Math.max(1, it.box.y1 - it.box.y0)))
    return { x, y, w, h, scale }
  })
  // laid out on one canvas first (cut, scaled, made black on white)
  let left = HAND_GAP
  const at = cuts.map((c) => {
    const box = { x: left, y: Math.round(HAND_GAP / 2 + (HAND_HEIGHT * 2 - c.h * c.scale) / 2), w: Math.ceil(c.w * c.scale), h: Math.ceil(c.h * c.scale) }
    left += box.w + HAND_GAP
    return box
  })
  const sheet = document.createElement('canvas')
  sheet.width = left
  sheet.height = HAND_HEIGHT * 2 + HAND_GAP
  const ctx = sheet.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, sheet.width, sheet.height)
  cuts.forEach((c, k) => {
    const to = at[k]
    ctx.drawImage(page, c.x, c.y, c.w, c.h, to.x, to.y, to.w, to.h)
    // no piece of a printed word beside it
    for (const b of items[k].skip) {
      const x0 = Math.max(b.x0, c.x)
      const x1 = Math.min(b.x1, c.x + c.w)
      const y0 = Math.max(b.y0, c.y)
      const y1 = Math.min(b.y1, c.y + c.h)
      if (x1 > x0 && y1 > y0) ctx.fillRect(to.x + (x0 - c.x) * c.scale, to.y + (y0 - c.y) * c.scale, (x1 - x0) * c.scale, (y1 - y0) * c.scale)
    }
    // black on white by its own ink (a thin pen reads pale grey, and its
    // strokes break when cut at one grey for all), a pixel bolder: the
    // recognition wants ink, not a hairline (real photos, 2026-11-26)
    const img = ctx.getImageData(to.x, to.y, to.w, to.h)
    const d = img.data
    const dark = []
    for (let j = 0; j < d.length; j += 4) if (d[j] < 235) dark.push(d[j])
    dark.sort((a, b) => a - b)
    const level = dark.length ? dark[Math.floor(dark.length * 0.2)] : 0
    const cut = Math.min(225, Math.max(110, (level + 255) / 2))
    const { w, h } = to
    const on = new Uint8Array(w * h)
    for (let i = 0; i < on.length; i++) on[i] = d[i * 4] < cut ? 1 : 0
    for (let i = 0; i < on.length; i++) {
      const x = i % w
      const y = (i - x) / w
      let v = on[i]
      for (let dy = -1; dy <= 1 && !v; dy++) for (let dx = -1; dx <= 1 && !v; dx++) { const nx = x + dx; const ny = y + dy; if (nx >= 0 && ny >= 0 && nx < w && ny < h && on[ny * w + nx]) v = 1 }
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v ? 0 : 255
    }
    ctx.putImageData(img, to.x, to.y)
  })
  // each read alone, as one line of text (one sheet read at once came out
  // run together or dropped: tried on real photos, 2026-11-26), a few
  // milliseconds each
  const texts = items.map(() => ({ words: [], conf: 1 }))
  await worker.setParameters({ tessedit_pageseg_mode: PSM_SINGLE_LINE, tessedit_char_whitelist: HAND_CHARS })
  for (let k = 0; k < items.length; k++) {
    const to = at[k]
    const one = document.createElement('canvas')
    one.width = to.w + HAND_GAP
    one.height = to.h + HAND_GAP
    const c1 = one.getContext('2d')
    c1.fillStyle = '#fff'
    c1.fillRect(0, 0, one.width, one.height)
    c1.drawImage(sheet, to.x, to.y, to.w, to.h, HAND_GAP / 2, HAND_GAP / 2, to.w, to.h)
    const { data } = await worker.recognize(one, {}, { blocks: true, text: false })
    for (const b of data?.blocks || []) {
      for (const para of b?.paragraphs || []) {
        for (const l of para?.lines || []) {
          for (const w of l?.words || []) {
            if (!String(w.text || '').trim()) continue
            texts[k].words.push({ x: w.bbox.x0, text: String(w.text).trim() })
            texts[k].conf = Math.min(texts[k].conf, (w.confidence ?? 0) / 100)
          }
        }
      }
    }
  }
  if (debug) debug.sheet = sheet
  if (debug) debug.rows = players.map((p) => ({ licence: p.licence, handAt: p.handAt && { ...p.handAt, skip: p.handAt.skip.length } }))
  if (debug) debug.hand = items.map((it, k) => ({ ...it, skip: undefined, text: texts[k].words.map((w) => w.text).join(' '), conf: texts[k].conf, cut: cuts[k] }))
  const reads = players.map(() => [])
  items.forEach((it, k) => {
    const text = texts[k].words.sort((a, b) => a.x - b.x).map((w) => w.text).join(' ')
    // (a reading it was barely sure of is no mark: a stroke of a letter, a speck)
    if ((text && texts[k].conf >= HAND_MIN_CONF) || it.ringed) reads[it.i].push({ text: texts[k].conf >= HAND_MIN_CONF ? text : '', conf: text ? texts[k].conf : 0.5, ringed: it.ringed })
  })
  return players.map((p, i) => withHandReadings(p, reads[i]))
}

const coded = (code, message, cause) => Object.assign(new Error(message), { code, cause })

/** Where the recognition's files are: ocr/<tesseract.js version>/ beside the app's pages. */
export function ocrDir (base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/') {
  const root = (import.meta.env?.BASE_URL || '/').replace(/^\.\//, '')
  return new URL(`${root.replace(/\/?$/, '/')}ocr/${TESSERACT_VERSION}/`, base).href
}

/**
 * Whether this page may run WebAssembly at all: an empty module compiled
 * here (8 bytes). A page whose Content-Security-Policy forbids it, or an
 * engine without it, fails at once instead of after OCR_START_TIMEOUT_MS
 * (the worker dies inside, and Tesseract never answers).
 */
export function wasmAllowed () {
  try {
    // eslint-disable-next-line no-new
    new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))
    return true
  } catch {
    return false
  }
}

async function simdSupported () {
  try {
    const { simd } = await import('wasm-feature-detect')
    return await simd()
  } catch {
    return false
  }
}

/** Tesseract's createWorker (tests hand in their own). */
async function loadCreateWorker () {
  const mod = await import('tesseract.js/dist/tesseract.esm.min.js')
  return (mod.default || mod).createWorker
}

/**
 * The roster in the flat page of a photo (scan.js scanPage, as a canvas or
 * a Blob).
 * @param {HTMLCanvasElement|Blob} page
 * @param {{ onProgress?: (share: number, status: string) => void, signal?: AbortSignal, createWorker?: Function, timeoutMs?: number, startTimeoutMs?: number, dir?: string }} [opts]
 */
export async function readRosterPhoto (page, { onProgress, signal, createWorker, timeoutMs = OCR_TIMEOUT_MS, startTimeoutMs = OCR_START_TIMEOUT_MS, dir, debug } = {}) {
  let worker = null
  // the handwriting read again after the page is quick: no second progress bar for it
  let quiet = false
  // closing the dialog ends the worker at once (its memory and the tablet's CPU back)
  const cancelled = () => coded('ocr-cancelled', 'The reading was cancelled')
  const onAbort = () => { try { worker?.terminate?.() } catch { /* gone */ } }
  signal?.addEventListener?.('abort', onAbort)
  try {
    if (signal?.aborted) throw cancelled()
    if (!wasmAllowed()) throw coded('ocr-load', 'This page may not run WebAssembly (its Content-Security-Policy, or the engine)')
    try {
      const create = createWorker || await loadCreateWorker()
      const at = dir || ocrDir()
      const core = (await simdSupported()) ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'
      worker = await withTimeout(create(OCR_LANGS, LSTM_ONLY, {
        workerPath: `${at}worker.min.js`,
        corePath: `${at}${core}`,
        langPath: `${at}lang`,
        gzip: false,
        // the files are the app's own (or the service worker's on the web): no second copy in IndexedDB
        cacheMethod: 'none',
        // a worker from the app's own address, not a blob: URL
        workerBlobURL: false,
        logger: (m) => { if (onProgress && !quiet && typeof m?.progress === 'number') onProgress(m.progress, m.status || '') }
      }), startTimeoutMs)
      await worker.setParameters({ tessedit_pageseg_mode: PSM_SINGLE_BLOCK, preserve_interword_spaces: '1' })
    } catch (err) {
      if (signal?.aborted) throw cancelled()
      throw coded('ocr-load', `The text recognition could not start (${err?.message || err})`, err)
    }
    if (signal?.aborted) throw cancelled()
    let data
    try {
      ;({ data } = await withTimeout(worker.recognize(page, {}, { blocks: true, text: false }), timeoutMs))
      // few words read sure: the page on its side or upside down? (a canvas
      // only: a Blob is read as it is)
      const asIs = sureWords(data)
      if (asIs < UPRIGHT_ENOUGH && typeof page?.getContext === 'function' && !signal?.aborted) {
        quiet = true
        const turns = await withTimeout(uprightTurns(worker, page, asIs), timeoutMs)
        quiet = false
        if (debug) debug.turned = turns
        if (turns) {
          const before = page.beforeRules
          const turned = turnedCanvas(page, turns)
          if (before?.length === page.width * page.height) turned.beforeRules = turnGray(before, page.width, page.height, turns).gray
          page = turned
          if (signal?.aborted) throw cancelled()
          ;({ data } = await withTimeout(worker.recognize(page, {}, { blocks: true, text: false }), timeoutMs))
        }
      }
    } catch (err) {
      if (signal?.aborted || err?.code === 'ocr-cancelled') throw cancelled()
      if (err?.code === PDF_TIMEOUT_CODE) throw coded('ocr-timeout', 'The text recognition took too long', err)
      throw coded('ocr-load', `The text recognition stopped (${err?.message || err})`, err)
    }
    const confidence = Number(data?.confidence)
    if (Number.isFinite(confidence) && confidence < BLURRY_CONFIDENCE) throw coded('ocr-blurry', 'The photo is too blurry to read')
    const px = pixelsOf(page)
    const parsed = rosterFromOcr(data, circlesOn(px))
    if (parsed.players.some((p) => p.licenceAt) && typeof page?.getContext === 'function' && !signal?.aborted) {
      quiet = true
      try {
        parsed.players = await withTimeout(readLicencesAgain(worker, page, parsed.players), HAND_TIMEOUT_MS)
      } catch { /* the SV numbers as first read (to check) */ }
      quiet = false
    }
    if (px && parsed.players.some((p) => p.handAt) && !signal?.aborted) {
      quiet = true
      try {
        parsed.players = await withTimeout(readHandwriting(worker, page, px, parsed.players, debug), HAND_TIMEOUT_MS)
      } catch { /* the first reading's marks stay (all of them to check) */ }
      quiet = false
    }
    const ringed = parsed.players.filter((p) => p.ringAt)
    if (ringed.length && !signal?.aborted) {
      try {
        await worker.setParameters({ tessedit_pageseg_mode: PSM_SINGLE_WORD, tessedit_char_whitelist: '0123456789' })
        for (const p of ringed.slice(0, 4)) {
          const read = await withTimeout(readCircledNumber(worker, page, p.ringAt), CIRCLE_TIMEOUT_MS)
          if (read && !parsed.players.some((q) => q.number === read.number)) {
            p.number = read.number
            p.confidence = { ...p.confidence, number: Math.min(read.conf, HANDWRITTEN_MAX) }
          }
        }
      } catch { /* the captain stays marked; the number is the scorer's (or the saved team's) */ }
    }
    if (signal?.aborted) throw cancelled()
    const roster = importedRosterOf(parsed, 'ocr')
    if (!roster.players.length && !roster.struck?.length) {
      // a page read without much certainty and no row: the photo, not the list
      throw Number.isFinite(confidence) && confidence < 70 ? coded('ocr-blurry', 'The photo is too blurry to read') : coded('ocr-empty', 'No player row was read in the photo')
    }
    return roster
  } finally {
    signal?.removeEventListener?.('abort', onAbort)
    // its memory (the three languages) back at once; a worker that never answers is ended too
    try { await worker?.terminate?.() } catch { /* already gone */ }
  }
}
