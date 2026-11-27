/**
 * Parse roster PDF to extract player and official information
 * Supports Italian, French, English, and German formats
 */

// The pdf.js worker is bundled with the app (emitted as a hashed .mjs asset and
// precached by the service worker), NOT loaded from a CDN: roster import must
// work offline and on a LAN-only venue box, and the backend CSP is script-src 'self'.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
// pdf.js 6's modern build needs a recent engine: Uint8Array.prototype.toHex
// (Chrome 140) for every document's fingerprint, Math.sumPrecise for its
// fonts, Promise.withResolvers (119), Promise.try (128), URL.parse (126). The
// app's build target is Chrome 107 (build-target.js), and Android tablets
// keep an old system WebView for years: there the modern build fails or never
// answers. Its legacy build carries the polyfills; it is used where the engine
// lacks any of them (pdfReaderPlan). That one is built for Chrome 125 (pdf.js
// 5's for 118): what it still takes from the engine, an older one gets from
// addLegacyPdfPolyfills, on the main thread.
import pdfLegacyWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

export const PDF_WORKER_URL = pdfWorkerUrl
export const PDF_LEGACY_WORKER_URL = pdfLegacyWorkerUrl

// A roster PDF is a page or two (an Einsatzliste, a club's list): a file far
// bigger, or with many pages or much text, is not one, and reading it would
// hold the device up (the scorer's tablet during setup). Checked before pdf.js
// parses it, and the text before the patterns run over it.
export const ROSTER_PDF_MAX_BYTES = 5 * 1024 * 1024
export const ROSTER_PDF_MAX_PAGES = 10
export const ROSTER_TEXT_MAX_CHARS = 100000
// (notRoster: a file error, not the engine's: never read a second time)
const tooBig = (what) => Object.assign(new Error(`This PDF is not a roster (${what})`), { notRoster: true })

// How long one reading may take before it is given up (17.11.2026: on a
// Galaxy Tab A7 Lite the import spun for ever). A roster reads in well under
// a second on a desktop and in a few on a slow tablet. Past the worker's
// time the same file is read once more on the main thread; past that the
// scorer gets a clear message, never an endless spinner.
export const PDF_WORKER_TIMEOUT_MS = 15000
export const PDF_MAIN_THREAD_TIMEOUT_MS = 30000
export const PDF_TIMEOUT_CODE = 'pdf-timeout'

// What pdf.js 6's modern build uses without a fallback of its own (5 still
// brought Math.sumPrecise along)
const MODERN_PDF_FEATURES = [
  ['Promise.withResolvers', (g) => typeof g.Promise?.withResolvers === 'function'],
  ['Promise.try', (g) => typeof g.Promise?.try === 'function'],
  ['URL.parse', (g) => typeof g.URL?.parse === 'function'],
  ['Uint8Array.prototype.toHex', (g) => typeof g.Uint8Array?.prototype?.toHex === 'function'],
  ['Uint8Array.fromBase64', (g) => typeof g.Uint8Array?.fromBase64 === 'function'],
  ['Map.prototype.getOrInsertComputed', (g) => typeof g.Map?.prototype?.getOrInsertComputed === 'function'],
  ['Map.prototype.getOrInsert', (g) => typeof g.Map?.prototype?.getOrInsert === 'function'],
  ['Math.sumPrecise', (g) => typeof g.Math?.sumPrecise === 'function']
]

// What pdf.js 6's legacy build still uses without a polyfill of its own: it
// is built for Chrome 125 / Safari 18, and 5's brought these along. A Chrome
// 107-118 WebView lacks them, and without them the import failed
// ("Promise.withResolvers is not a function"). The app adds them there
// (addLegacyPdfPolyfills), on the main thread only: a module worker's own
// global would still lack them, so such an engine reads on the main thread.
const LEGACY_PDF_FEATURES = [
  ['Promise.withResolvers', (g) => typeof g.Promise?.withResolvers === 'function'],
  ['ArrayBuffer.prototype.transferToFixedLength', (g) => typeof g.ArrayBuffer?.prototype?.transferToFixedLength === 'function']
]

const missingOf = (features, g) => features.filter(([, has]) => { try { return !has(g) } catch { return true } }).map(([name]) => name)

/** The features of the modern build the engine lacks (names; none: it can run it). */
export function missingModernPdfFeatures(g = globalThis) {
  return missingOf(MODERN_PDF_FEATURES, g)
}

/** What the legacy build takes from the engine and this one lacks (names). */
export function missingLegacyPdfFeatures(g = globalThis) {
  return missingOf(LEGACY_PDF_FEATURES, g)
}

/**
 * Adds to `g` what the legacy build takes from the engine and `g` lacks
 * (LEGACY_PDF_FEATURES). Nothing on an engine that has them.
 */
export function addLegacyPdfPolyfills(g = globalThis) {
  const define = (obj, name, value) => Object.defineProperty(obj, name, { value, writable: true, configurable: true })
  if (g.Promise && typeof g.Promise.withResolvers !== 'function') {
    define(g.Promise, 'withResolvers', function withResolvers() {
      let resolve
      let reject
      const promise = new this((res, rej) => { resolve = res; reject = rej })
      return { promise, resolve, reject }
    })
  }
  const AB = g.ArrayBuffer
  if (AB?.prototype && typeof AB.prototype.transferToFixedLength !== 'function') {
    // a copy of the first `length` bytes (pdf.js calls it on a buffer of its
    // own, never used again: that it is not detached changes nothing)
    define(AB.prototype, 'transferToFixedLength', function transferToFixedLength(length = this.byteLength) {
      const out = new AB(length)
      new Uint8Array(out).set(new Uint8Array(this, 0, Math.min(length, this.byteLength)))
      return out
    })
  }
}

/**
 * Whether the engine starts module workers (pdf.js's worker is an ES module):
 * Chrome 80+, Safari 15+, Firefox 114+. Older engines never read the `type`
 * option (they start a classic worker, which cannot run the module). No
 * worker is started: about:blank is refused after the options are read.
 */
export function supportsModuleWorker(WorkerCtor = globalThis.Worker) {
  if (typeof WorkerCtor !== 'function') return false
  let read = false
  try {
    const w = new WorkerCtor('about:blank', { get type() { read = true; return 'module' } })
    try { w?.terminate?.() } catch { /* never started */ }
  } catch { /* refused: what we wanted, the options were read first */ }
  return read
}

/**
 * How this engine reads a roster PDF: { build: 'modern'|'legacy', worker:
 * 'module'|'main-thread', missing } (missing: the modern build's features
 * the engine lacks). Without module workers it reads on the main thread,
 * with the legacy build (with addLegacyPdfPolyfills it runs on every engine
 * the app does); also where the legacy build itself needs a polyfill.
 */
export function pdfReaderPlan({ globalObject = globalThis, WorkerCtor = globalObject?.Worker } = {}) {
  const missing = missingModernPdfFeatures(globalObject)
  if (!supportsModuleWorker(WorkerCtor)) return { build: 'legacy', worker: 'main-thread', missing }
  if (missingLegacyPdfFeatures(globalObject).length) return { build: 'legacy', worker: 'main-thread', missing }
  return { build: missing.length ? 'legacy' : 'modern', worker: 'module', missing }
}

// After a reading that failed or never answered in a worker: the rest of the
// session reads on the main thread (pdf.js keeps that choice anyway)
const MAIN_THREAD_PLAN = { build: 'legacy', worker: 'main-thread', missing: [] }
let fallbackPlan = null

/** For tests: forget the main-thread fallback of an earlier reading. */
export function resetPdfReaderFallback() {
  fallbackPlan = null
}

/** The error a reading that took too long ends with (code PDF_TIMEOUT_CODE). */
export function pdfTimeoutError(ms) {
  const err = new Error(`Reading the PDF took longer than ${Math.round(ms / 1000)} s`)
  err.code = PDF_TIMEOUT_CODE
  return err
}

// Errors about the file itself: reading it again elsewhere changes nothing
const FILE_ERRORS = new Set(['InvalidPDFException', 'PasswordException', 'MissingPDFException', 'ResponseException'])
/** Whether a failed reading is worth a second try on the main thread. */
export function retryOnMainThread(err, plan) {
  if (!plan || plan.worker === 'main-thread') return false
  if (err?.code === PDF_TIMEOUT_CODE) return true
  if (err?.notRoster || FILE_ERRORS.has(err?.name)) return false
  return true
}

async function loadPdfjs(plan) {
  // (before the build runs: its main-thread half uses them in every plan)
  if (plan.build === 'legacy') addLegacyPdfPolyfills()
  const pdfjsLib = plan.build === 'legacy'
    ? await import('pdfjs-dist/legacy/build/pdf.mjs')
    : await import('pdfjs-dist')
  const workerUrl = plan.build === 'legacy' ? PDF_LEGACY_WORKER_URL : PDF_WORKER_URL
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl
  if (plan.worker === 'main-thread' && !globalThis.pdfjsWorker?.WorkerMessageHandler) {
    // pdf.js then runs its worker's code on this thread (its "fake worker")
    globalThis.pdfjsWorker = await import(/* @vite-ignore */ workerUrl)
  }
  return pdfjsLib
}

/** The PDF's text and positioned items, read with `plan`; gives up after `timeoutMs`. */
async function readPdfText(bytes, plan, timeoutMs) {
  let loadingTask = null
  const read = (async () => {
    const pdfjsLib = await loadPdfjs(plan)
    loadingTask = pdfjsLib.getDocument({ data: bytes })
    const pdf = await loadingTask.promise
    if (pdf.numPages > ROSTER_PDF_MAX_PAGES) throw tooBig(`more than ${ROSTER_PDF_MAX_PAGES} pages`)

    let fullText = ''
    // All positioned text items: the columns of the rows (playersFromColumns)
    const allPositionedItems = []

    // Extract text from all pages
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const textContent = await page.getTextContent()
      const pageText = textContent.items.map(item => item.str).join(' ')
      fullText += pageText + '\n'
      if (fullText.length > ROSTER_TEXT_MAX_CHARS) throw tooBig('too much text')

      // Store items with position info (transform[4]=x, transform[5]=y)
      for (const item of textContent.items) {
        if (item.str.trim()) {
          allPositionedItems.push({
            str: item.str.trim(),
            x: item.transform[4],
            y: item.transform[5],
            width: item.width,
            page: i
          })
        }
      }
    }
    return { fullText, allPositionedItems }
  })()
  try {
    return await withTimeout(read, timeoutMs)
  } finally {
    try { loadingTask?.destroy?.() } catch { /* already gone */ }
  }
}

/** `promise`, or an error of code PDF_TIMEOUT_CODE once `ms` have passed. */
export async function withTimeout(promise, ms) {
  let timer = null
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(pdfTimeoutError(ms)), ms) })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
    Promise.resolve(promise).catch(() => { /* given up: its late failure is not ours */ })
  }
}

/**
 * The roster in a PDF (players, coach, assistants). Never waits for ever: a
 * worker that fails or does not answer is retried once on the main thread,
 * and a reading past its time ends with an error of code PDF_TIMEOUT_CODE.
 * @param {File|Blob} file
 * @param {{ plan?: object, workerTimeoutMs?: number, mainThreadTimeoutMs?: number }} [options]
 */
export async function parseRosterPdf(file, { plan, workerTimeoutMs = PDF_WORKER_TIMEOUT_MS, mainThreadTimeoutMs = PDF_MAIN_THREAD_TIMEOUT_MS } = {}) {
  try {
    if (typeof file?.size === 'number' && file.size > ROSTER_PDF_MAX_BYTES) throw tooBig('more than 5 MB')

    // (a file a cloud drive has not downloaded yet can keep this waiting)
    const arrayBuffer = await withTimeout(file.arrayBuffer(), mainThreadTimeoutMs)
    if (arrayBuffer.byteLength > ROSTER_PDF_MAX_BYTES) throw tooBig('more than 5 MB')

    const first = plan || fallbackPlan || pdfReaderPlan()
    const timeoutOf = (p) => (p.worker === 'main-thread' ? mainThreadTimeoutMs : workerTimeoutMs)
    let read
    try {
      // a copy: pdf.js hands the bytes to its worker (the buffer is detached)
      read = await readPdfText(new Uint8Array(arrayBuffer.slice(0)), first, timeoutOf(first))
    } catch (err) {
      if (!retryOnMainThread(err, first)) throw err
      console.warn(`[parseRosterPdf] reading in a worker failed (${err?.message}); reading on the main thread`)
      fallbackPlan = MAIN_THREAD_PLAN
      read = await readPdfText(new Uint8Array(arrayBuffer.slice(0)), MAIN_THREAD_PLAN, timeoutOf(MAIN_THREAD_PLAN))
    }
    return parseRosterContent(read.fullText, read.allPositionedItems)
  } catch (error) {
    console.error('Error parsing PDF:', error)
    // Callers show rosterPdfErrorText (a reading past its time) or prefix the message
    throw error
  }
}

/**
 * The text a caller shows for a failed roster PDF import: the reading took
 * too long (PDF_TIMEOUT_CODE), or the PDF could not be read and why.
 */
export function rosterPdfErrorText(err, t) {
  if (err?.code === PDF_TIMEOUT_CODE) return t('rosterPdf.tooSlow')
  return t('rosterPdf.failed', { reason: err?.message || String(err) })
}

/**
 * A roster from the PDF's text and its positioned items: the players from
 * the rows' columns when the items have them (playersFromColumns), else the
 * text's patterns; the officials from the text.
 */
export function parseRosterContent(text, items = []) {
  const result = parseRosterText(String(text ?? '').slice(0, ROSTER_TEXT_MAX_CHARS), lfpLicences(items))
  const fromColumns = playersFromColumns(items)
  if (fromColumns.length > 0 && fromColumns.length >= result.players.length) {
    result.players = fromColumns.map(p => ({ ...p, ...moveNameParticles(p.firstName, p.lastName) }))
  }
  return result
}

// ---------------------------------------------------------------- columns
const Y_TOLERANCE = 3 // same row: y within this (PDF units)
const X_TOLERANCE = 2 // same column start
const LFP_TOLERANCE = 15 // an "X" under the LFP header
const LICENCE_RE = /^\d{5,6}$/
const SHIRT_RE = /^\d{1,2}$/
const GENDER_RE = /^[MFH]$/
const DATE_IN_RE = /^(\d{1,2})\s*[./]\s*(\d{1,2})\s*[./]\s*(\d{4})/
const LEAGUE_RE = /^(LLR|NLR|LLA|NLA|LLB|NLB|1L|2L|3L|4L)$/i
const LFP_HEADER_RE = /^(GFL|LAS|JFL|LFP)$/i
// Header words of the name columns (Italian "Nome" is the first name, French "Nom" the last)
const FIRST_NAME_HEADER = /^(vorname|prénom|prenom|nome|first ?name|given ?name)$/i
const LAST_NAME_HEADER = /^(name|nachname|nom|cognome|last ?name|family ?name|surname)$/i
const HAS_LETTER = /\p{L}/u

/** The items in rows: same page, y within Y_TOLERANCE; top to bottom, each row left to right. */
function textRows(items) {
  const sorted = (items || []).filter(it => it && typeof it.str === 'string' && Number.isFinite(it.x) && Number.isFinite(it.y))
    .slice().sort((a, b) => ((a.page || 0) - (b.page || 0)) || (b.y - a.y) || (a.x - b.x))
  const rows = []
  for (const it of sorted) {
    const row = rows[rows.length - 1]
    if (row && row.page === (it.page || 0) && Math.abs(row.y - it.y) < Y_TOLERANCE) row.items.push(it)
    else rows.push({ page: it.page || 0, y: it.y, items: [it] })
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x)
  return rows
}

/** A date of birth of a player (born 1900 up to 4 years ago), 'DD/MM/YYYY', or null. */
function birthDate(day, month, year, now = new Date()) {
  const d = Number(day)
  const m = Number(month)
  const y = Number(year)
  if (!(d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 1900 && y <= now.getFullYear() - 4)) return null
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`
}

// The headers a row goes by are those of the closest row above it that has
// them (the table's header row, repeated on the next page or not), never the
// first such word of the file: a "Name" or "LFP" label in a team block above
// the table is no column header.

/** The x of the row's LFP header (GFL, LAS, JFL or LFP), or null. */
function lfpHeaderX(row) {
  return row.items.find(it => LFP_HEADER_RE.test(it.str.trim()))?.x ?? null
}

/** The x of the two name headers when the row holds both (a header row), or null. */
function nameHeaderXs(row) {
  const first = row.items.find(it => FIRST_NAME_HEADER.test(it.str.trim()))
  const last = row.items.find(it => LAST_NAME_HEADER.test(it.str.trim()))
  return first && last ? { first: first.x, last: last.x } : null
}

/**
 * The SV numbers (licences) of the rows with an "X" in the LFP column (its
 * header GFL, LAS, JFL or LFP, the closest above the row): the mark goes with
 * the licence, whatever the name's words.
 */
function lfpLicences(items) {
  const out = new Set()
  let lfpX = null
  for (const row of textRows(items)) {
    lfpX = lfpHeaderX(row) ?? lfpX
    if (lfpX == null) continue
    const licence = row.items.find(it => LICENCE_RE.test(it.str))
    if (licence && row.items.some(it => it.str === 'X' && Math.abs(it.x - lfpX) < LFP_TOLERANCE)) out.add(licence.str)
  }
  return out
}

/**
 * The players of a roster PDF from its columns: the rows that start with an
 * SV number (an Einsatzliste: no shirt number) or a shirt number 1 to 99 and
 * hold a date of birth. The two name cells are told apart by their x position
 * (where the columns start: the header row's, else the one the rows share),
 * never by how many words a name has: "Sofia | Garcia Lopez" stays so. The
 * header row is the closest row above the first player that holds both name
 * headers; without one the format decides the order. A row without a date of
 * birth (a header, a team line, a date of the match) is no player. [] when
 * the items have no such rows, or the names cannot be split.
 */
export function playersFromColumns(items) {
  const rows = textRows(items)
  const parsed = { licence: [], shirt: [] }
  let nameHeaders = null
  let lfpX = null
  for (const row of rows) {
    nameHeaders = nameHeaderXs(row) ?? nameHeaders
    lfpX = lfpHeaderX(row) ?? lfpX
    const [key, ...rest] = row.items
    const kind = LICENCE_RE.test(key.str) ? 'licence' : SHIRT_RE.test(key.str) && Number(key.str) >= 1 ? 'shirt' : null
    if (!kind) continue
    const names = []
    let i = 0
    while (i < rest.length && HAS_LETTER.test(rest[i].str) && !GENDER_RE.test(rest[i].str) && !LEAGUE_RE.test(rest[i].str) && rest[i].str !== 'X') names.push(rest[i++])
    let gender = false
    if (i < rest.length && GENDER_RE.test(rest[i].str)) { gender = true; i++ }
    const date = DATE_IN_RE.exec(rest.slice(i).map(it => it.str).join(''))
    const dob = date ? birthDate(date[1], date[2], date[3]) : null
    if (!names.length || !dob) continue
    parsed[kind].push({
      kind, key: key.str, names, gender, dob, nameHeaders,
      isLfp: lfpX != null && row.items.some(it => it.str === 'X' && Math.abs(it.x - lfpX) < LFP_TOLERANCE)
    })
  }
  // One format per file: the one with more rows (as the text patterns)
  const list = parsed.licence.length >= parsed.shirt.length ? parsed.licence : parsed.shirt
  if (!list.length) return []
  const headers = list[0].nameHeaders
  const boundary = nameColumnStart(list, headers ? Math.max(headers.first, headers.last) : null)
  if (boundary == null) return []
  // The order of the two cells: the header row's, else first name first in an
  // Einsatzliste row (with its gender letter) and last name first otherwise
  const firstNameFirst = headers ? headers.first < headers.last : list[0].gender || list[0].kind === 'licence'
  const out = []
  for (const r of list) {
    const left = r.names.filter(it => it.x < boundary - X_TOLERANCE).map(it => it.str).join(' ').trim()
    const right = r.names.filter(it => it.x >= boundary - X_TOLERANCE).map(it => it.str).join(' ').trim()
    if (!left || !right) return []
    const [firstName, lastName] = firstNameFirst ? [left, right] : [right, left]
    out.push(r.kind === 'licence'
      ? { number: null, licence: r.key, firstName, lastName, dob: r.dob, isLfp: r.isLfp }
      : { number: Number(r.key), firstName, lastName, dob: r.dob, isLfp: r.isLfp })
  }
  return out
}

/**
 * Where the second name column starts: the x most rows have a name cell
 * starting at (not counting each row's first), else the second name
 * header's x, else, for a single row, the widest gap between its name items.
 * null when there is none (every row one item: the cells are not apart).
 */
function nameColumnStart(list, headerX = null) {
  const counts = new Map()
  for (const r of list) {
    const seen = new Set()
    for (const it of r.names.slice(1)) {
      const x = Math.round(it.x)
      for (const k of [x - 1, x, x + 1]) {
        if (seen.has(k)) continue
        seen.add(k)
        counts.set(k, (counts.get(k) || 0) + 1)
      }
    }
  }
  let best = null
  for (const [x, n] of counts) if (n >= 2 && (!best || n > best.n || (n === best.n && x < best.x))) best = { x, n }
  if (best) return best.x
  if (headerX != null) return headerX
  if (list.length !== 1 || list[0].names.length < 2) return null
  const names = list[0].names
  let at = 1
  let widest = -Infinity
  for (let k = 1; k < names.length; k++) {
    const prev = names[k - 1]
    const gap = names[k].x - (prev.x + (Number.isFinite(prev.width) ? prev.width : 0))
    if (gap > widest) { widest = gap; at = k }
  }
  return names[at].x
}

/**
 * A roster from the text alone (the PDF's items joined): players, coach and
 * assistants. lfp: the SV numbers marked LFP (lfpLicences). Names are told
 * apart by the patterns' words only, so playersFromColumns' answer is
 * preferred where the PDF has columns.
 */
export function parseRosterText(text, lfp = new Set()) {
  const result = {
    players: [],
    coach: null,
    ac1: null,
    ac2: null
  }

  // Removed console.log('[parseRosterText] Raw text (first 1000 chars):', text.substring(0, 1000))

  // Normalize text - remove extra whitespace
  const normalizedText = text.replace(/\s+/g, ' ').trim()
  
  // Removed console.log('[parseRosterText] Normalized text (first 1000 chars):', normalizedText.substring(0, 1000))
  
  // Helper: name word pattern with hyphen and apostrophe support
  // Supports: Jean-Pierre, O'Brien, D'Angelo, Müller, François
  // Pattern breakdown:
  //   - Capital letter (including accented: Ä, Ö, Ü, etc.)
  //   - MUST have either: lowercase letters OR apostrophe+content (prevents matching single letters like M/F)
  //   - Zero or more: hyphen + capital + lowercase+ (for Jean-Pierre)
  // Latin Extended-A and -B too (U+0100–U+024F): "Krawczyńsk", "Dvořák", "Ștefan"
  // were dropped whole (both cases: the two blocks mix upper and lower letters)
  const upper = 'A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß\u0100-\u024F'
  const lower = 'a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ\u0100-\u024F'
  // Either: lowercase+ (optionally with apostrophe after), OR apostrophe+content (for O'Brien, D'Angelo)
  const nameWord = `[${upper}](?:[${lower}]+(?:'[${upper}]?[${lower}]+)?|'[${upper}]?[${lower}]+)(?:-[${upper}][${lower}]+)*`
  // Full name: one to six name words separated by spaces. Bounded: unbounded,
  // two names in a row backtracked over every split of a long run of words
  // (a minute for a page of short words)
  const fullName = `${nameWord}(?:\\s+${nameWord}){0,5}`

  // A shirt number: one or two digits on their own, never part of a longer
  // number or of a date ("Saison 2026", a licence 123456). No lookbehind:
  // older Safari and WebViews refuse the whole pattern
  const shirt = '(?:^|[^\\d./])(\\d{1,2})(?!\\d|[./]\\d)'
  const date = '(\\d{1,2}[./]\\d{1,2}[./]\\d{4})'
  // Format variations: "1. LastName FirstName DD/MM/YYYY" or "1 LastName FirstName DD/MM/YYYY"
  const playerPattern = new RegExp(`${shirt}[.\\s]+(${fullName})\\s+(${fullName})\\s+${date}`, 'gi')

  // Extract players: a shirt number 1-99 and a date of birth (a header line
  // "Runde 3 Volley Musterdorf 01.09.2026" carries the match's date)
  let match
  while ((match = playerPattern.exec(normalizedText)) !== null) {
    const number = parseInt(match[1], 10)
    const dob = dobOf(match[4])
    if (number < 1 || !dob) continue
    result.players.push({
      number,
      firstName: match[3].trim(),
      lastName: match[2].trim(),
      dob
    })
  }

  // The officials written "<role>: <first> <last> [date]". The assistants
  // first, each taken out of the text, so "Assistant Coach: …" never reads as
  // the head coach; a name stops at the next label word ("Coach: Hans Muster
  // Assistant Coach 1: …" is Hans Muster)
  if (!hasLabelledOfficials(normalizedText)) {
    const labelWord = `(?:assist[${lower}]*|adjoint[${lower}]*|coach|trainer[${lower}]*|entra[iî]neur[${lower}]*|allenator[${lower}]*)(?![${lower}])`
    const officialName = `(?!${labelWord})${nameWord}(?:\\s+(?!${labelWord})${nameWord}){0,5}`
    // the label starts a word: "Trainer" inside "Assistenttrainer" is none
    const official = (label) => new RegExp(`(?:^|[^${upper}${lower}])(${label})[:\\s]+(${officialName})\\s+(${officialName})(?:\\s+${date})?`, 'gi')
    const assistant = 'Assistant\\s+Coach|Entraîneur\\s+adjoint|Allenatore\\s+assistente|Assistenttrainer|Assistenztrainer'
    let rest = normalizedText
    // The first match `skip` does not refuse, taken out of the text
    const take = (re, skip = () => false) => {
      let m
      while ((m = re.exec(rest)) !== null && skip(m[1])) { /* the next one */ }
      if (!m) return null
      rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`
      return { firstName: m[2].trim(), lastName: m[3].trim(), dob: m[4] ? (dobOf(m[4]) || '') : '' }
    }
    result.ac1 = take(official(`(?:${assistant})\\s+1`))
    result.ac2 = take(official(`(?:${assistant})\\s+2`))
    // an assistant without its number takes the first free slot
    const anyAssistant = take(official(`(?:${assistant})(?!\\s*\\d)`))
    if (anyAssistant) {
      if (!result.ac1) result.ac1 = anyAssistant
      else if (!result.ac2) result.ac2 = anyAssistant
    }
    // "Coach" right after "Assistant" is an assistant's label
    result.coach = take(official('(?:assist[a-z]*\\s+)?(?:Coach|Entraîneur|Allenatore|Trainer)(?!\\s*(?:adjoint|assistente|\\d))'), (label) => /^assist/i.test(label))
  }

    // Try Italian/German SV number format (even if some players were found, as the first pattern might miss some)
    // This format is common in Swiss Volleyball rosters
    // Store SV format players separately to avoid duplicates
    const svFormatPlayers = []

      // Try Italian/German/French format: SV number (5-6 digits), First Name, Last Name, M/F/H, Date
      // Pattern: 5-6 digit number, name, name, M/F/H, date (DD.MM.YYYY or DD/MM/YYYY, may have spaces)
      // The SV number is the player's Swiss Volley licence number: kept as `licence`.
      // Example Italian: "123456   Marco   Muster   M   14.03.2004"   (made-up rows)
      // Example German: "98765 | Anna | Beispiel | F | 07.10 .2007"
      // Example French: "234567 | Léa | Exemple | F | 19.08.1999"
      // Use normalized text for consistent spacing, but also try original text for dates with spaces
      // Note: H = Homme (French for Male), M = Male, F = Female
    const svPlayerPattern = new RegExp(`(\\d{5,6})\\s+(${fullName})\\s+(${fullName})\\s+[MFH]\\s+(\\d{1,2}[./]\\s*\\d{1,2}[./]\\s*\\d{4})`, 'gi')

    // Reset regex lastIndex to avoid issues
    svPlayerPattern.lastIndex = 0
    while ((match = svPlayerPattern.exec(normalizedText)) !== null) {
      const firstName = match[2].trim()
      const lastName = match[3].trim()
      const dob = dobOf(match[4])
      if (!dob) continue
      // The LFP column's mark, by the licence (lfpLicences)
      const isLfp = lfp.has(match[1])

      svFormatPlayers.push({
        number: null,
        licence: match[1],
        firstName,
        lastName,
        dob,
        isLfp
      })
    }

    // If still no SV format players, try with original text (not normalized) to catch dates with spaces
    if (svFormatPlayers.length === 0) {
      const svPlayerPatternOriginal = new RegExp(`(\\d{5,6})\\s+(${fullName})\\s+(${fullName})\\s+[MFH]\\s+(\\d{1,2}\\s*[./]\\s*\\d{1,2}\\s*[./]\\s*\\d{4})`, 'gi')

      let matchOriginal
      while ((matchOriginal = svPlayerPatternOriginal.exec(text)) !== null) {
        const firstName = matchOriginal[2].trim()
        const lastName = matchOriginal[3].trim()
        const dob = dobOf(matchOriginal[4])
        if (!dob) continue
        // The LFP column's mark, by the licence (lfpLicences)
        const isLfp = lfp.has(matchOriginal[1])

        svFormatPlayers.push({
          number: null,
          licence: matchOriginal[1],
          firstName,
          lastName,
          dob,
          isLfp
        })
      }
    }
    
    // If we found SV format players and they outnumber the original pattern results, use SV format
    // This handles cases where the first pattern only found a few players incorrectly
    if (svFormatPlayers.length > result.players.length) {
      result.players = svFormatPlayers
    } else if (result.players.length === 0 && svFormatPlayers.length > 0) {
      result.players = svFormatPlayers
    }
    
    // If still no players, try simpler patterns in the full text
    if (result.players.length === 0) {
      // Try pattern: number, firstname, lastname, M/F, date (with hyphen/apostrophe support)
      // Must have lowercase+ OR apostrophe+content (prevents matching single letters like M/F)
      const simpleNameWord = "[A-Z](?:[a-z]+(?:'[A-Z]?[a-z]+)?|'[A-Z]?[a-z]+)(?:-[A-Z][a-z]+)*"
      const simpleFullName = `${simpleNameWord}(?:\\s+${simpleNameWord}){0,5}`
      const simplePattern = new RegExp(`${shirt}\\s+(${simpleFullName})\\s+(${simpleFullName})\\s+[MF]\\s+${date}`, 'gi')
      simplePattern.lastIndex = 0
      while ((match = simplePattern.exec(text)) !== null) {
          const number = parseInt(match[1], 10)
          const firstName = match[2].trim()
          const lastName = match[3].trim()
          const dob = dobOf(match[4])
          if (number < 1 || !dob) continue

          result.players.push({
            number,
            firstName,
            lastName,
            dob
          })
        }
      }
      
      // Removed console.log('[parseRosterText] Total players found:', result.players.length)
    
    // VolleyManager's officials, in any language: "<role>: #<SV number> | <first> <last> (<year>)",
    // e.g. "Allenatore: #10001 | …", "1. Assistant Coach: #10002 | …" (made-up numbers).
    // The role is told by its words (officialRoleOf), the SV number is kept as the licence and a
    // year alone is no date of birth (birthYear).
    for (const o of parseLabelledOfficials(normalizedText, fullName)) {
      if (!result[o.slot]) result[o.slot] = o.person
    }
  // The text has no column borders, so "Tim von Muster" comes out as first name
  // "Noel von": a name particle belongs to the last name
  for (const p of result.players) Object.assign(p, moveNameParticles(p.firstName, p.lastName))
  for (const k of OFFICIAL_SLOTS) {
    if (result[k]) Object.assign(result[k], moveNameParticles(result[k].firstName, result[k].lastName))
  }
  return result
}

// An Einsatzliste names the coach and the two assistants, never a physiotherapist or medic
export const OFFICIAL_SLOTS = ['coach', 'ac1', 'ac2']

const LABELLED_OFFICIAL = /:\s*#\s*\d{3,7}\s*\|/
const hasLabelledOfficials = (text) => LABELLED_OFFICIAL.test(text)

// Lowercase, accents off: "Entraîneur" -> "entraineur"
const foldLabel = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')

/**
 * The slot of an official's role label in VolleyManager's languages (German,
 * French, Italian): 'coach', 'ac1', 'ac2', 'ac' (an assistant without its
 * number) or null (not the coach or an assistant). By its words, not by one
 * language's exact text.
 */
export function officialRoleOf(label) {
  const l = foldLabel(label)
  if (/assist|adjoint|aiuto|vice|\bco-?(coach|trainer|entra|allena)/.test(l)) {
    if (/(^|[^\d])2(?!\d)|\b(second|seconda|secondo|zweit|deuxieme|2nd)/.test(l)) return 'ac2'
    if (/(^|[^\d])1(?!\d)|\b(first|primo|prima|erst|premier|1st)/.test(l)) return 'ac1'
    return 'ac'
  }
  if (/coach|trainer|allenat|entrain|head/.test(l)) return 'coach'
  return null
}

/**
 * The officials written "<role>: #<SV number> | <first> <last> (<year>)":
 * [{ slot, person: { firstName, lastName, dob: '', birthYear, licence } }],
 * each slot once; an assistant without its number takes the first free one.
 */
export function parseLabelledOfficials(text, fullName) {
  const re = new RegExp(`([^:()|#]{1,80}):\\s*#\\s*(\\d{3,7})\\s*\\|\\s*(${fullName})\\s+(${fullName})\\s*\\((\\d{4})\\)`, 'gu')
  const out = []
  const taken = new Set()
  let m
  while ((m = re.exec(text)) !== null) {
    // the label is the last words before the colon ("… 14.03.2004 1. Assistant Coach")
    const label = m[1].split(/\d{1,2}[./]\s*\d{1,2}[./]\s*\d{4}/).pop().trim().split(/\s+/).slice(-4).join(' ')
    let slot = officialRoleOf(label)
    if (slot === 'ac' || (slot === 'coach' && taken.has('coach'))) slot = ['ac1', 'ac2'].find((s) => !taken.has(s)) || null
    if (!slot || taken.has(slot)) continue
    taken.add(slot)
    out.push({ slot, person: { firstName: m[3].trim(), lastName: m[4].trim(), dob: '', birthYear: m[5], licence: m[2] } })
  }
  return out
}

// Lowercase only: as VolleyManager writes them ("von Allmen", "de Weck", "van der Berg")
const NAME_PARTICLES = new Set(['von', 'vom', 'van', 'zu', 'zur', 'zum', 'de', 'des', 'du', 'di', 'da', 'del',
  'della', 'dalla', 'dello', 'degli', 'dei', 'dos', 'das', 'le', 'la', 'lo', 'ten', 'ter', 'den', 'der', 'af', 'av', 'y'])

/** Lowercase name particles at the end of a first name move to the front of the last name. */
export function moveNameParticles(firstName, lastName) {
  const words = String(firstName ?? '').trim().split(/\s+/).filter(Boolean)
  const moved = []
  while (words.length > 1 && NAME_PARTICLES.has(words[words.length - 1])) moved.unshift(words.pop())
  if (!moved.length) return { firstName, lastName }
  return { firstName: words.join(' '), lastName: [...moved, String(lastName ?? '').trim()].filter(Boolean).join(' ') }
}

/** A date of birth as written ('14.03.2008', '07.10 .2007') -> 'DD/MM/YYYY', or null when it is none (birthDate). */
function dobOf(raw) {
  const m = DATE_IN_RE.exec(String(raw ?? '').replace(/\s+/g, ''))
  return m ? birthDate(m[1], m[2], m[3]) : null
}
