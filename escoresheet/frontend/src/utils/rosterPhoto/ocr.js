/**
 * The text recognition of a photo import (docs/roster-photo-spec.md, plan A):
 * Tesseract.js on this device, with the app's own copy of its engine and of
 * the German, French and Italian language data (vite-plugin-ocr-assets.js,
 * ocr/<version>/). Nothing leaves the device and nothing needs a network,
 * except on the web, where the files load on the first photo import.
 *
 * startOcrEngine() starts the recognition ahead (RosterPhotoImport: while the
 * scorer takes the photo and sets its corners), a few workers at once on a
 * device with the cores and memory for them (ocrWorkerCount);
 * readRosterPhoto(page, { engine }) -> the imported roster (domain/importedRoster,
 * source 'ocr'), or an error with a code:
 *   ocr-load     the recognition could not start (the web offline before its
 *                first use; a WebView without WebAssembly)
 *   ocr-timeout  it took longer than OCR_TIMEOUT_MS
 *   ocr-empty    it read no player row
 *   ocr-blurry   it read the page too unsure to give a list (out of focus,
 *                shaken): the scorer takes the photo again
 *   ocr-cancelled  the scorer closed the dialog (opts.signal)
 */

import { OCR_LANGS, ocrDir, ocrPaths, simdSupported } from './ocrFiles'
import { importedRosterOf } from '../../domain/importedRoster'
import { withTimeout, PDF_TIMEOUT_CODE } from '../parseRosterPdf'
import { rosterFromOcr, withHandReadings, HANDWRITTEN_MAX } from './ocrRoster'
import { handInk, lineAcross, ringInRegion, ringScore, struckThrough, turnGray } from './scan'

// a number counts as circled when ink rings it this fully (scan.js ringScore)
const CIRCLED_SCORE = 0.8

const isCanvas = (page) => typeof page?.getContext === 'function'

/**
 * A canvas's grey pixels: the ones scan.js scanPage kept beside it (page.gray),
 * else read once from the canvas and kept.
 */
function grayOf (canvas) {
  const { width, height } = canvas
  if (canvas.gray?.length === width * height) return canvas.gray
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data
  const gray = new Uint8ClampedArray(width * height)
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = rgba[j]
  canvas.gray = gray
  return gray
}

/**
 * Grey pixels as a PGM file (a few header bytes, then the pixels): what the
 * recognition is handed instead of a canvas. Tesseract.js encodes a canvas
 * as PNG on the page (canvas.toBlob, which a busy page puts off) and decodes
 * it again in the worker; a PGM is the pixels as they are (2026-11-27: the
 * page read a fifth faster on a desktop, word for word the same).
 */
export function pgmOf (gray, width, height) {
  const head = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`)
  const out = new Uint8Array(head.length + width * height)
  out.set(head)
  out.set(gray.subarray(0, width * height), head.length)
  return out
}

/** What the recognition reads: a canvas as PGM, anything else (a Blob) as it is. */
const imageOf = (page) => (isCanvas(page) ? pgmOf(grayOf(page), page.width, page.height) : page)

/** The page's grey pixels (and those before its rules went: scan.js scanPage), null for a Blob. */
function pixelsOf (page) {
  if (!isCanvas(page)) return null
  const { width, height } = page
  const gray = grayOf(page)
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
 * out into a small canvas, digits only.
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
  const { data } = await worker.recognize(imageOf(cut), {}, { text: true })
  const m = /^\D*(\d{1,2})\D*$/.exec(String(data?.text || '').trim())
  return m && Number(m[1]) >= 1 ? { number: Number(m[1]), conf: (data.confidence ?? 0) / 100 } : null
}

export { OCR_LANGS, ocrDir }
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

/**
 * The page (a canvas) turned a quarter clockwise per step and scaled, as a
 * new canvas; at full size with its grey pixels (and those before the rules
 * went) turned along.
 */
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
  if (scale === 1) {
    const size = page.width * page.height
    if (page.gray?.length === size) out.gray = turnGray(page.gray, page.width, page.height, n).gray
    if (page.beforeRules?.length === size) out.beforeRules = turnGray(page.beforeRules, page.width, page.height, n).gray
  }
  return out
}

/**
 * Items read side by side, as many at once as there are workers: item k by
 * worker k mod n, always the same one (the workers may hold different
 * languages: the same photo reads the same each time); the answers in the
 * items' order.
 */
async function onWorkers (workers, items, read) {
  const out = new Array(items.length)
  await Promise.all(workers.map(async (w, j) => {
    for (let k = j; k < items.length; k += workers.length) out[k] = await read(w, items[k], k)
  }))
  return out
}

const setAll = (workers, params) => Promise.all(workers.map((w) => w.setParameters(params)))

/**
 * Three readings of one page, one language each (German, French, Italian:
 * the same lines, read side by side on three workers), as one: for each
 * line the language that read it surest (its words' confidence per letter),
 * as Tesseract itself picks a language for each word it was unsure of when
 * it reads with all three in turn.
 */
export function mergeLanguages (readings) {
  const sets = readings.map((data) => {
    const lines = []
    for (const b of data?.blocks || []) for (const para of b?.paragraphs || []) for (const l of para?.lines || []) {
      const words = (l?.words || []).filter((w) => w?.bbox && String(w.text || '').trim())
      if (!words.length) continue
      const y0 = Math.min(...words.map((w) => w.bbox.y0))
      const y1 = Math.max(...words.map((w) => w.bbox.y1))
      let n = 0
      let sum = 0
      for (const w of words) { const len = String(w.text).length; n += len; sum += len * (Number(w.confidence) || 0) }
      lines.push({ line: { ...l, words }, y0, y1, mid: (y0 + y1) / 2, h: y1 - y0, score: n ? sum / n : 0, letters: n })
    }
    return lines
  })
  const chosen = []
  const used = sets.map((lines) => lines.map(() => false))
  sets.forEach((lines, a) => lines.forEach((l, i) => {
    if (used[a][i]) return
    // the same line in the other readings (their middles within half a line)
    const group = [l]
    used[a][i] = true
    sets.forEach((other, b) => {
      if (b === a) return
      let best = -1
      other.forEach((o, k) => {
        if (used[b][k] || Math.abs(o.mid - l.mid) > 0.5 * Math.min(o.h, l.h)) return
        if (best < 0 || Math.abs(o.mid - l.mid) < Math.abs(other[best].mid - l.mid)) best = k
      })
      if (best >= 0) { used[b][best] = true; group.push(other[best]) }
    })
    // (a reading that lost words of the line is not the surer one)
    const most = Math.max(...group.map((g) => g.letters))
    group.sort((x, y) => y.score * Math.min(1, y.letters / most) - x.score * Math.min(1, x.letters / most))
    chosen.push(group[0])
  }))
  chosen.sort((x, y) => x.mid - y.mid)
  let sum = 0
  let n = 0
  for (const c of chosen) for (const w of c.line.words) { sum += Number(w.confidence) || 0; n++ }
  return { blocks: [{ paragraphs: [{ lines: chosen.map((c) => c.line) }] }], confidence: n ? sum / n : 0 }
}

/**
 * The page read once: on the three workers side by side, one language each,
 * merged line by line (mergeLanguages), when the engine has them; else on
 * one worker with the three languages in turn.
 */
async function readPage (workers, page, { apart = false } = {}) {
  const img = imageOf(page)
  if (!apart) return (await workers[0].recognize(img, {}, { blocks: true, text: false })).data
  return mergeLanguages(await Promise.all(OCR_LANGS.map((_, k) => workers[k].recognize(img, {}, { blocks: true, text: false }).then((r) => r.data))))
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
async function uprightTurns (workers, page, asIs, order = [1, 3, 2]) {
  const scale = Math.min(1, UPRIGHT_SIDE / Math.max(page.width, page.height))
  const sure = async (worker, turns) => sureWords((await worker.recognize(imageOf(turnedCanvas(page, turns, scale)), {}, { blocks: true, text: false })).data)
  let best = { turns: 0, n: asIs ?? 0 }
  // the two quarter turns side by side (a page on its side is one of them),
  // then the others, until one reads well
  const rounds = workers.length > 1 ? [order.filter((t) => t % 2), order.filter((t) => !(t % 2))].filter((r) => r.length) : order.map((t) => [t])
  search: for (const round of rounds) {
    for (let i = 0; i < round.length; i += workers.length) {
      const tried = round.slice(i, i + workers.length)
      // done as soon as one reads well: the other reading goes on in its
      // worker, unwaited for (what that worker reads next waits behind it)
      const found = await new Promise((resolve) => {
        const got = tried.map(() => -1)
        let left = tried.length
        const one = (k, n) => { got[k] = n; left--; if (n >= UPRIGHT_ENOUGH || !left) resolve(got) }
        tried.forEach((turns, k) => sure(workers[k], turns).then((n) => one(k, n), () => one(k, -1)))
      })
      tried.forEach((turns, k) => { if (found[k] > best.n) best = { turns, n: found[k] } })
      if (found.some((n) => n >= UPRIGHT_ENOUGH)) break search
    }
  }
  return best.n >= 2 * (asIs ?? 0) + 3 ? best.turns : 0
}

/**
 * SV numbers read again, digits only, where the first reading was unsure of
 * them (ocrRoster licenceAt): one that starts right of its column, a digit
 * lost at the page's edge or under a pen ("23456" for 123456), read from the
 * column's start, taken only as the same number with one digit more in
 * front (read again as a whole, a handwritten SV number came out worse:
 * real photos, 2026-11-26). It stays to check.
 */
async function readLicencesAgain (workers, page, players) {
  await setAll(workers, { tessedit_pageseg_mode: PSM_SINGLE_LINE, tessedit_char_whitelist: '0123456789' })
  return onWorkers(workers, players, async (worker, p) => {
    const at = p.licenceAt
    if (!at) return p
    const pad = Math.max(3, Math.round((at.y1 - at.y0) * 0.25))
    const x = Math.max(0, Math.floor(at.x0))
    const y = Math.max(0, Math.floor(at.y0 - pad))
    const w = Math.min(page.width - x, Math.ceil(at.x1 - at.x0 + pad))
    const h = Math.min(page.height - y, Math.ceil(at.y1 - at.y0 + 2 * pad))
    if (w < 4 || h < 4) return p
    const cut = document.createElement('canvas')
    cut.width = w + 2 * pad
    cut.height = h + 2 * pad
    const ctx = cut.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, cut.width, cut.height)
    ctx.drawImage(page, x, y, w, h, pad, pad, w, h)
    const { data } = await worker.recognize(imageOf(cut), {}, { text: true })
    const digits = String(data?.text || '').replace(/\D/g, '')
    const conf = Math.min((data?.confidence ?? 0) / 100, 0.6)
    const now = String(p.licence || '')
    const take = digits.length === now.length + 1 && digits.endsWith(now) && /^\d{6}$/.test(digits)
    return take ? { ...p, licence: digits, confidence: { ...p.confidence, licence: Math.min(p.confidence?.licence ?? conf, conf) } } : p
  })
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
async function readHandwriting (workers, page, px, players, debug) {
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
  // (side by side on the workers there are)
  await setAll(workers, { tessedit_pageseg_mode: PSM_SINGLE_LINE, tessedit_char_whitelist: HAND_CHARS })
  const texts = await onWorkers(workers, at, async (worker, to) => {
    const text = { words: [], conf: 1 }
    const one = document.createElement('canvas')
    one.width = to.w + HAND_GAP
    one.height = to.h + HAND_GAP
    const c1 = one.getContext('2d')
    c1.fillStyle = '#fff'
    c1.fillRect(0, 0, one.width, one.height)
    c1.drawImage(sheet, to.x, to.y, to.w, to.h, HAND_GAP / 2, HAND_GAP / 2, to.w, to.h)
    const { data } = await worker.recognize(imageOf(one), {}, { blocks: true, text: false })
    for (const b of data?.blocks || []) {
      for (const para of b?.paragraphs || []) {
        for (const l of para?.lines || []) {
          for (const w of l?.words || []) {
            if (!String(w.text || '').trim()) continue
            text.words.push({ x: w.bbox.x0, text: String(w.text).trim() })
            text.conf = Math.min(text.conf, (w.confidence ?? 0) / 100)
          }
        }
      }
    }
    return text
  })
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

/**
 * Rows the first reading lost between two player rows (a gap of two rows or
 * more) with a pen line across them: struck out (owner: not playing), so
 * named on the confirm screen with what a reading of that band alone gives
 * (a line through a row can make Tesseract skip it: real photo, 2026-11-27).
 */
async function lostStruckRows (workers, page, px, players) {
  const rows = players.filter((p) => p.handAt).map((p) => p.handAt).sort((a, b) => a.y - b.y)
  if (rows.length < 3) return []
  const gaps = rows.slice(1).map((r, i) => r.y - rows[i].y).sort((a, b) => a - b)
  const pitch = gaps[gaps.length >> 1]
  const line = rows[rows.length >> 1].line
  const x0 = Math.min(...rows.map((r) => r.left))
  const x1 = Math.max(...rows.map((r) => r.x1))
  const bands = []
  for (let i = 1; i < rows.length; i++) {
    const missing = Math.round((rows[i].y - rows[i - 1].y) / pitch) - 1
    for (let k = 1; k <= missing && missing <= 3; k++) {
      const y = rows[i - 1].y + (k * (rows[i].y - rows[i - 1].y)) / (missing + 1)
      if (lineAcross(px.before, px.width, px.height, { x0, x1, y, line })) bands.push(y)
    }
  }
  if (!bands.length) return []
  await setAll(workers, { tessedit_pageseg_mode: PSM_SINGLE_LINE, tessedit_char_whitelist: '' })
  return onWorkers(workers, bands.slice(0, 3), async (worker, y) => {
    const top = Math.max(0, Math.round(y - 0.75 * pitch))
    const bottom = Math.min(px.height, Math.round(y + 0.75 * pitch))
    const { data } = await worker.recognize(pgmOf(px.gray.subarray(top * px.width, bottom * px.width), px.width, bottom - top), {}, { text: true })
    const words = String(data?.text || '').split(/\s+/).filter(Boolean)
    const names = words.filter((w) => /^\p{Lu}\p{Ll}{2,}[\p{L}'’-]*$/u.test(w))
    const licence = words.map((w) => w.replace(/\D/g, '')).find((d) => /^\d{5,6}$/.test(d)) || ''
    return { firstName: names[0] || '', lastName: names.slice(1, 3).join(' '), licence }
  })
}

const coded = (code, message, cause) => Object.assign(new Error(message), { code, cause })

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


/** Tesseract's createWorker (tests hand in their own). */
async function loadCreateWorker () {
  const mod = await import('tesseract.js/dist/tesseract.esm.min.js')
  return (mod.default || mod).createWorker
}

// at most this many workers: one a language (mergeLanguages)
export const MAX_WORKERS = OCR_LANGS.length

/**
 * How many workers read a page at once on this device: one core left for
 * the page itself, at most one a language, one alone on a device with
 * little memory (Chrome's deviceMemory below 2; a Galaxy Tab A7 Lite has 8
 * cores and 3 GB, which Chrome reports as 2: three workers).
 */
export function ocrWorkerCount ({
  cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined,
  memory = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined
} = {}) {
  let n = Number.isFinite(cores) && cores > 1 ? Math.min(MAX_WORKERS, cores - 1) : 1
  if (Number.isFinite(memory) && memory > 0 && memory < 2) n = 1
  return Math.max(1, n)
}

/**
 * The recognition started ahead (RosterPhotoImport: while the scorer takes
 * the photo and drags its corners, so "Read the list" does not wait for it),
 * from the app's own files, each worker with the three languages. With
 * three, the page is read by the three side by side, one language each
 * (readRosterPhoto: engine.apart), everything else with all three. Never
 * throws: engine.ready rejects (ocr-load) when none could start, and goes
 * on with the workers that did (little memory). engine.terminate() ends
 * them at once (the dialog closed, the list read).
 * @returns {{ size: number, apart: boolean, ready: Promise<object[]>, listeners: Set<Function>, terminate: () => Promise<void>, ended: boolean }}
 */
export function startOcrEngine ({ size = ocrWorkerCount(), createWorker, dir, startTimeoutMs = OCR_START_TIMEOUT_MS } = {}) {
  const count = Math.max(1, Math.min(MAX_WORKERS, size))
  const engine = { size: count, apart: count === OCR_LANGS.length, listeners: new Set(), workers: [], ended: false }
  engine.ready = (async () => {
    if (!wasmAllowed()) throw coded('ocr-load', 'This page may not run WebAssembly (its Content-Security-Policy, or the engine)')
    try {
      const create = createWorker || await loadCreateWorker()
      // (ocrFiles.js: the same addresses the web loads ahead, ocrWarmup.js)
      const { workerPath, corePath, langPath } = ocrPaths(dir || ocrDir(), await simdSupported())
      const one = async (k) => {
        const w = await create(OCR_LANGS, LSTM_ONLY, {
          workerPath,
          corePath,
          langPath,
          gzip: false,
          // the files are the app's own (or the service worker's on the web): no second copy in IndexedDB
          cacheMethod: 'none',
          // a worker from the app's own address, not a blob: URL
          workerBlobURL: false,
          logger: (m) => { for (const f of engine.listeners) f(m) }
        })
        // (ended while it started: its memory back at once)
        if (engine.ended) { try { await w.terminate?.() } catch { /* gone */ } } else engine.workers[k] = w
        return w
      }
      const started = await withTimeout(Promise.allSettled(Array.from({ length: count }, (_, k) => one(k))), startTimeoutMs)
      if (engine.ended) throw coded('ocr-cancelled', 'The reading was cancelled')
      const workers = engine.workers.filter(Boolean)
      if (!workers.length) throw started.find((r) => r.status === 'rejected')?.reason || new Error('no worker')
      // (one short: the page read by one worker with all three)
      engine.apart = workers.length === OCR_LANGS.length
      engine.workers = workers
      return [...workers]
    } catch (err) {
      if (err?.code === 'ocr-cancelled' || err?.code === 'ocr-load') throw err
      throw coded('ocr-load', `The text recognition could not start (${err?.message || err})`, err)
    }
  })()
  // (whoever reads awaits it; a start nobody waited for fails quietly)
  engine.ready.catch(() => {})
  engine.terminate = async () => {
    engine.ended = true
    const all = engine.workers.splice(0).filter(Boolean)
    await Promise.all(all.map(async (w) => { try { await w.terminate?.() } catch { /* already gone */ } }))
  }
  return engine
}

/**
 * The roster in the flat page of a photo (scan.js scanPage, as a canvas or
 * a Blob).
 *
 * engine: the recognition started ahead (startOcrEngine), left to its owner
 * to end; without one, readRosterPhoto starts its own and ends it.
 * tuning (measurements): { workers: how many of its own (ocrWorkerCount) }.
 * @param {HTMLCanvasElement|Blob} page
 * @param {{ engine?: object, onProgress?: (share: number, status: string) => void, signal?: AbortSignal, createWorker?: Function, timeoutMs?: number, startTimeoutMs?: number, dir?: string, tuning?: object }} [opts]
 */
export async function readRosterPhoto (page, { engine = null, onProgress, signal, createWorker, timeoutMs = OCR_TIMEOUT_MS, startTimeoutMs = OCR_START_TIMEOUT_MS, dir, debug, tuning = {} } = {}) {
  // (a Blob: read as it is, by one worker)
  const own = engine ? null : startOcrEngine({ size: isCanvas(page) ? (tuning.workers ?? ocrWorkerCount()) : 1, createWorker, dir, startTimeoutMs })
  const eng = engine || own
  // progress: the page's share read (by each language, side by side), then the marks read again
  let phase = null
  const shares = new Map()
  const report = (share, status) => { if (onProgress && !signal?.aborted) onProgress(Math.max(0, Math.min(1, share)), status) }
  const listener = (m) => {
    if (phase !== 'page' || typeof m?.progress !== 'number' || !String(m.status || '').startsWith('recognizing')) return
    shares.set(m.workerId ?? 0, m.progress)
    let sum = 0
    for (const v of shares.values()) sum += v
    report(sum / Math.max(1, phaseCount), 'recognizing text')
  }
  let phaseCount = 1
  eng.listeners.add(listener)
  // closing the dialog ends the workers at once (their memory and the tablet's CPU back)
  const cancelled = () => coded('ocr-cancelled', 'The reading was cancelled')
  const onAbort = () => { eng.terminate() }
  signal?.addEventListener?.('abort', onAbort)
  try {
    if (signal?.aborted) throw cancelled()
    let workers
    try {
      workers = await withTimeout(eng.ready, startTimeoutMs)
      await setAll(workers, { tessedit_pageseg_mode: PSM_SINGLE_BLOCK, preserve_interword_spaces: '1' })
    } catch (err) {
      if (signal?.aborted || err?.code === 'ocr-cancelled') throw cancelled()
      if (err?.code === 'ocr-load') throw err
      throw coded('ocr-load', `The text recognition could not start (${err?.message || err})`, err)
    }
    if (signal?.aborted) throw cancelled()
    // the page by the three side by side, one language each (a few
    // milliseconds to switch); everything else with all three, as before
    const languages = async (apart) => {
      await Promise.all(workers.map((w, k) => w.reinitialize(apart ? OCR_LANGS[k] : OCR_LANGS, LSTM_ONLY)))
      await setAll(workers, { tessedit_pageseg_mode: PSM_SINGLE_BLOCK, preserve_interword_spaces: '1' })
    }
    const read = async (p) => {
      phase = 'page'
      shares.clear()
      phaseCount = eng.apart ? OCR_LANGS.length : 1
      if (eng.apart) await languages(true)
      const data = await withTimeout(readPage(workers, p, { apart: eng.apart }), timeoutMs)
      if (eng.apart) await languages(false)
      phase = null
      return data
    }
    let data
    try {
      // a page wider than high is an A4 list photographed on its side, most
      // likely: the small copy's quarter turns first (and as it lies), not a
      // whole reading of sideways text first (seconds on a tablet)
      let turnedFirst = false
      if (isCanvas(page) && page.width > 1.15 * page.height) {
        const turns = await withTimeout(uprightTurns(workers, page, null, [1, 3, 0]), timeoutMs)
        turnedFirst = true
        if (debug) debug.turned = turns
        if (turns) page = turnedCanvas(page, turns)
        if (signal?.aborted) throw cancelled()
      }
      data = await read(page)
      // few words read sure: the page on its side or upside down? (a canvas
      // only: a Blob is read as it is)
      const asIs = sureWords(data)
      if (!turnedFirst && asIs < UPRIGHT_ENOUGH && isCanvas(page) && !signal?.aborted) {
        const turns = await withTimeout(uprightTurns(workers, page, asIs), timeoutMs)
        if (debug) debug.turned = turns
        if (turns) {
          page = turnedCanvas(page, turns)
          if (signal?.aborted) throw cancelled()
          data = await read(page)
        }
      }
    } catch (err) {
      if (signal?.aborted || err?.code === 'ocr-cancelled') throw cancelled()
      if (err?.code === PDF_TIMEOUT_CODE) throw coded('ocr-timeout', 'The text recognition took too long', err)
      throw coded('ocr-load', `The text recognition stopped (${err?.message || err})`, err)
    }
    phase = null
    report(1, 'recognizing text')
    const confidence = Number(data?.confidence)
    if (Number.isFinite(confidence) && confidence < BLURRY_CONFIDENCE) throw coded('ocr-blurry', 'The photo is too blurry to read')
    const px = pixelsOf(page)
    const parsed = rosterFromOcr(data, circlesOn(px))
    if (parsed.players.some((p) => p.licenceAt) && isCanvas(page) && !signal?.aborted) {
      try {
        parsed.players = await withTimeout(readLicencesAgain(workers, page, parsed.players), HAND_TIMEOUT_MS)
      } catch { /* the SV numbers as first read (to check) */ }
    }
    if (px && parsed.players.some((p) => p.handAt) && !signal?.aborted) {
      report(0.5, 'reading marks')
      try {
        parsed.players = await withTimeout(readHandwriting(workers, page, px, parsed.players, debug), HAND_TIMEOUT_MS)
      } catch { /* the first reading's marks stay (all of them to check) */ }
    }
    if (px && !signal?.aborted) {
      try {
        const lost = (await withTimeout(lostStruckRows(workers, page, px, parsed.players), HAND_TIMEOUT_MS)).filter((r) => r.firstName || r.lastName || r.licence)
        if (lost.length) parsed.struck = [...(parsed.struck || []), ...lost]
      } catch { /* a lost row stays lost (it is not imported either way) */ }
    }
    const ringed = parsed.players.filter((p) => p.ringAt).slice(0, 4)
    if (ringed.length && !signal?.aborted) {
      try {
        await setAll(workers, { tessedit_pageseg_mode: PSM_SINGLE_WORD, tessedit_char_whitelist: '0123456789' })
        const reads = await withTimeout(onWorkers(workers, ringed, (w, p) => readCircledNumber(w, page, p.ringAt)), CIRCLE_TIMEOUT_MS)
        ringed.forEach((p, k) => {
          const got = reads[k]
          if (got && !parsed.players.some((q) => q.number === got.number)) {
            p.number = got.number
            p.confidence = { ...p.confidence, number: Math.min(got.conf, HANDWRITTEN_MAX) }
          }
        })
      } catch { /* the captain stays marked; the number is the scorer's (or the saved team's) */ }
    }
    if (signal?.aborted) throw cancelled()
    report(1, 'reading marks')
    const roster = importedRosterOf(parsed, 'ocr')
    if (!roster.players.length && !roster.struck?.length) {
      // a page read without much certainty and no row: the photo, not the list
      throw Number.isFinite(confidence) && confidence < 70 ? coded('ocr-blurry', 'The photo is too blurry to read') : coded('ocr-empty', 'No player row was read in the photo')
    }
    return roster
  } finally {
    signal?.removeEventListener?.('abort', onAbort)
    eng.listeners.delete(listener)
    // its memory (the three languages) back at once; a worker that never answers is ended too
    if (own) await own.terminate()
  }
}
