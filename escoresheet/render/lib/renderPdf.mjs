/**
 * The vector scoresheet PDF (field-spec 17.19): headless Chromium opens the
 * scoresheet page built from the web app's own code (frontend/render, built
 * into dist-render/), hands it the match record and prints it with page.pdf()
 * under the SCREEN media, so the sheet is laid out exactly as the standalone
 * /scoresheet/ page draws it. A3 landscape, 5 mm margins: the 410 x 287 mm
 * sheet fills the page box, where the raster PDF placed its picture.
 *
 * No network: the page and its assets are served from dist-render/ under a
 * made-up origin by request interception; every other request is refused
 * (the match record comes in through window.ovRender; signatures and stamps
 * are data: URLs inside it).
 *
 * One browser for the process, relaunched when it dies; a fresh context per
 * render (no state shared between two matches); one render at a time
 * (queue.mjs) so a 2-CPU / 4 GB host never runs two Chromium pages at once.
 */
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'

export const ORIGIN = 'http://ov-render.invalid'
const PAGE = `${ORIGIN}/render/index.html`

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
}

/** The file under `root` a URL of ORIGIN names, or null (outside the root, another origin). */
export function fileFor (root, url) {
  if (typeof url !== 'string' || !url.startsWith(`${ORIGIN}/`)) return null
  let path
  try {
    path = decodeURIComponent(new URL(url).pathname)
  } catch {
    return null
  }
  const full = normalize(join(root, path))
  const base = normalize(root.endsWith(sep) ? root : root + sep)
  return full.startsWith(base) ? full : null
}

/** The launch arguments: the container is the sandbox (no network, no capabilities, read-only). */
export const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--no-first-run',
  '--mute-audio',
  '--font-render-hinting=none'
]

/**
 * @param {object} o
 * @param {string} o.distDir      dist-render/ of the frontend build
 * @param {() => Promise<import('playwright-core').Browser>} o.launch  starts Chromium
 * @param {number} [o.timeoutMs]  one render, end to end
 */
export function createRenderer ({ distDir, launch, timeoutMs = 60_000, logger = console } = {}) {
  let browser = null
  let launching = null

  async function getBrowser () {
    if (browser?.isConnected()) return browser
    if (!launching) {
      launching = launch().then((b) => {
        browser = b
        b.on('disconnected', () => { if (browser === b) browser = null })
        return b
      }).finally(() => { launching = null })
    }
    return launching
  }

  async function serve (route) {
    const req = route.request()
    const file = fileFor(distDir, req.url())
    if (!file || req.method() !== 'GET') return route.abort('blockedbyclient')
    try {
      const body = await readFile(file)
      return route.fulfill({ status: 200, body, headers: { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' } })
    } catch {
      return route.fulfill({ status: 404, body: 'not found' })
    }
  }

  /**
   * @param {{ record: object, rebuildReason?: string|null, rebuiltAt?: string|null, withText?: boolean }} payload
   * @returns {Promise<{ pdf: Buffer, info: object, ms: number }>}
   */
  async function render (payload) {
    const t0 = Date.now()
    const b = await getBrowser()
    const context = await b.newContext({
      viewport: { width: 1700, height: 1200 },
      deviceScaleFactor: 1,
      locale: 'en-US',
      // the sheet's clocks: the match's own zone (match_info.tz) first, else
      // the tool zone; this is the tool zone of a Swiss server
      timezoneId: process.env.OV_TIMEZONE || 'Europe/Zurich',
      javaScriptEnabled: true,
      serviceWorkers: 'block',
      acceptDownloads: false
    })
    const timer = setTimeout(() => { context.close().catch(() => {}) }, timeoutMs)
    try {
      await context.route('**/*', serve)
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(String(e?.message || e).slice(0, 200)))
      await page.emulateMedia({ media: 'screen' })
      await page.goto(PAGE, { waitUntil: 'load', timeout: timeoutMs })
      await page.waitForFunction(() => typeof window.ovRender === 'function', null, { timeout: timeoutMs })
      const info = await page.evaluate((p) => window.ovRender(p), payload)
      if (!info?.ok) {
        const err = new Error(`the sheet could not be drawn: ${info?.error || errors[0] || 'unknown'}`)
        err.code = 'OV_RENDER_SHEET'
        throw err
      }
      const pdf = await page.pdf({
        width: '420mm',
        height: '297mm',
        margin: { top: '5mm', right: '5mm', bottom: '5mm', left: '5mm' },
        printBackground: true,
        preferCSSPageSize: false,
        // the sheet is one page; REMARKS that do not fit go on the next ones
        pageRanges: info.remarksPages ? '' : '1',
        tagged: true,
        outline: false
      })
      if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw Object.assign(new Error('not a PDF'), { code: 'OV_RENDER_PDF' })
      return { pdf, info: { ...info, pageErrors: errors }, ms: Date.now() - t0 }
    } finally {
      clearTimeout(timer)
      await context.close().catch(() => {})
    }
  }

  async function close () {
    const b = browser
    browser = null
    if (b) await b.close().catch(() => {})
  }

  return { render, close, connected: () => !!browser?.isConnected() }
}
