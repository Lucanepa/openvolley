#!/usr/bin/env node
/**
 * The scoresheet PDF, checked by pixel (CI: .github/workflows/sheet-pixels.yml).
 *
 * Draws scoresheet_pdf/pixel-check (a synthetic best-of-3 whose deciding set goes
 * past the change of courts), saves its PDF through the real capture path
 * (App_Scoresheet getBlob: html-to-image, JPEG, jsPDF) and reads the picture
 * inside the PDF back. Checked, as they broke on 2026-11-16 (field-spec 17.13,
 * 17.16):
 *   - the rule under every column (DoB, No, Name) of every roster, LIBERO and
 *     BENCH OFFICIALS row;
 *   - the bottom border of both rosters and of SANCTIONS, REMARKS, APPROVAL and
 *     RESULT;
 *   - the deciding set's right rule on set 4's line (at most 1 image px apart);
 *   - the descenders (g, y) of the APPROVAL names (not clipped).
 * Engines and ratios where the rules got lost: Chromium launched with
 * --force-device-scale-factor 1.25 and 1.75 (a context deviceScaleFactor does
 * not reproduce it) and WebKit at deviceScaleFactor 1.5, plus Chromium at 1
 * (the deciding set's rule was 1 px off at 100 %); each on the standalone
 * page and under the manager's stylesheet (Rebuild PDF).
 *
 *   npx playwright@1.63.0 install chromium webkit   (once)
 *   node scripts/sheet-pixels.mjs [--only chromium-1.25,webkit-1.5] [--page standalone|manager] [--keep DIR]
 * Env: PLAYWRIGHT_MODULE (path of a playwright install to use), CHROMIUM_PATH.
 * Exit code 1 when a check fails.
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const RUNS = [
  { id: 'chromium-1', engine: 'chromium', forced: 1 },
  { id: 'chromium-1.25', engine: 'chromium', forced: 1.25 },
  { id: 'chromium-1.75', engine: 'chromium', forced: 1.75 },
  { id: 'webkit-1.5', engine: 'webkit', dpr: 1.5 }
].filter((r) => !opt('--only') || opt('--only').split(',').includes(r.id))
const PAGES = [
  { id: 'standalone', path: '/scoresheet_pdf/pixel-check/index.html' },
  { id: 'manager', path: '/scoresheet_pdf/pixel-check/manager.html' }
].filter((p) => !opt('--page') || opt('--page') === p.id)
const KEEP = opt('--keep')

/** The JPEG jsPDF embedded (DCTDecode): its bytes, from SOI to EOI. */
export function jpegOfPdf (pdf) {
  const at = pdf.indexOf('/DCTDecode')
  if (at < 0) throw new Error('no JPEG in the PDF')
  const start = pdf.indexOf(Buffer.from([0xff, 0xd8, 0xff]), at)
  const end = pdf.indexOf('endstream', start)
  if (start < 0 || end < 0) throw new Error('JPEG stream not found')
  const eoi = pdf.lastIndexOf(Buffer.from([0xff, 0xd9]), end)
  return pdf.subarray(start, eoi + 2)
}

/** Runs in the page: decodes the JPEG and checks it against the geometry. */
async function checkInPage ({ jpegBase64, g }) {
  const bin = atob(jpegBase64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
  const W = bmp.width
  const H = bmp.height
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bmp, 0, 0)
  const px = ctx.getImageData(0, 0, W, H).data
  const L = (x, y) => { const i = (y * W + x) * 4; return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] }
  const k = W / g.cssW
  const fails = []
  const notes = []
  let checks = 0
  // a dark line under [x0, x1] near ybot (CSS px): the best row's share of dark pixels
  const lineUnder = (x0, x1, ybot, up, down, inset) => {
    const a = Math.round(x0 * k) + inset
    const b = Math.round(x1 * k) - inset
    const yb = Math.round(ybot * k)
    let best = 0
    for (let y = Math.max(0, yb - up); y <= Math.min(H - 1, yb + down); y++) {
      let dark = 0
      for (let x = a; x < b; x++) if (L(x, y) < 170) dark++
      best = Math.max(best, b > a ? dark / (b - a) : 0)
    }
    return best
  }
  for (const it of g.items) {
    const bottom = it.y + it.h
    if (it.kind === 'row') {
      it.cols.forEach((col, ci) => {
        checks++
        const share = lineUnder(col.x, col.x + col.w, bottom, 4, 3, 3)
        if (share < 0.9) fails.push(`${it.name}: no rule under column ${['DoB', 'No', 'Name'][ci]} (${Math.round(share * 100)} % dark)`)
      })
    } else {
      checks++
      const share = lineUnder(it.x, it.x + it.w, bottom, 4, 1, 4)
      if (share < 0.9) fails.push(`${it.name}: no bottom border (${Math.round(share * 100)} % dark)`)
    }
  }
  // vertical rules (image px) within [xa, xb] over the middle half of a box's height
  const verticalRules = (box, xa, xb) => {
    const ys = []
    for (let i = 0; i < 40; i++) ys.push(Math.round((box.y + box.h * (0.25 + 0.5 * i / 39)) * k))
    const xs = []
    for (let x = Math.max(0, xa); x <= Math.min(W - 1, xb); x++) {
      let dark = 0
      for (const y of ys) if (L(x, y) < 110) dark++
      if (dark / ys.length >= 0.8) xs.push(x)
    }
    return xs
  }
  // the centres of the rules among those columns (contiguous dark columns = one rule)
  const centres = (xs) => {
    const out = []
    let run = []
    for (const x of xs) {
      if (run.length && x !== run[run.length - 1] + 1) { out.push((run[0] + run[run.length - 1]) / 2); run = [] }
      run.push(x)
    }
    if (run.length) out.push((run[0] + run[run.length - 1]) / 2)
    return out
  }
  if (g.set5) {
    // the deciding set's right border sits on set 4's line between its teams
    // (field-spec 17.16): the set box above whose span holds that x
    checks++
    const edge = Math.round((g.set5.x + g.set5.w) * k)
    const own = centres(verticalRules(g.set5, edge - 12, edge + 2)) // not the roster box beside it
    const a = own.length ? own[own.length - 1] : null
    const set4 = g.sets.find((s) => s.y + s.h <= g.set5.y + 1 && s.x * k < edge && (s.x + s.w) * k > edge)
    const near = set4 && a !== null ? centres(verticalRules(set4, Math.floor(a) - 8, Math.ceil(a) + 8)) : []
    const b = near.length ? near.reduce((m, x) => (Math.abs(x - a) < Math.abs(m - a) ? x : m)) : null
    notes.push(`deciding set's right rule x ${a}, set 4's line x ${b}`)
    if (a === null || b === null || Math.abs(a - b) > 0.5) fails.push(`deciding set's right rule at x ${a}, set 4's line at x ${b}: not on one line`)
  }
  for (const d of g.descender) {
    checks++
    const x0 = Math.round((d.x + 2) * k)
    const x1 = Math.round((d.x + d.w - 2) * k)
    const y0 = Math.round((d.y + 1.5) * k)
    const y1 = Math.round((d.y + d.h - 1.5) * k)
    let top = null
    let bot = null
    for (let y = y0; y <= y1; y++) {
      let ink = false
      for (let x = x0; x < x1 && !ink; x++) if (L(x, y) < 110) ink = true
      if (ink) { if (top === null) top = y; bot = y }
    }
    const inkH = top === null ? 0 : bot - top + 1
    const need = 0.89 * d.fontPx * k // cap + descender ≈ 0.97 em in Inter; cut off at line height 1: ≈ 0.85 em
    notes.push(`APPROVAL "${d.name}": ink ${inkH} px, needs ${need.toFixed(1)}`)
    if (inkH < need) fails.push(`APPROVAL "${d.name}": ink ${inkH} px high, a name with descenders needs ${need.toFixed(1)} (cut off?)`)
  }
  return { checks, fails, notes, size: [W, H] }
}

async function main () {
  process.env.WS_PORT = process.env.WS_PORT || '0'
  const server = await createServer({ root, configFile: join(root, 'vite.config.js'), logLevel: 'warn', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } })
  await server.listen()
  const base = server.resolvedUrls.local[0].replace(/\/$/, '')
  const pw = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(join(process.env.PLAYWRIGHT_MODULE, 'index.mjs')).href : 'playwright')
  if (KEEP) mkdirSync(KEEP, { recursive: true })
  let failed = 0
  try {
    for (const run of RUNS) {
      const browser = run.engine === 'chromium'
        ? await pw.chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: [`--force-device-scale-factor=${run.forced}`, '--window-size=1700,1200'] })
        : await pw.webkit.launch()
      try {
        for (const page of PAGES) {
          const ctx = await browser.newContext(run.engine === 'chromium' ? { viewport: null } : { viewport: { width: 1700, height: 1200 }, deviceScaleFactor: run.dpr })
          const tab = await ctx.newPage()
          const errors = []
          tab.on('pageerror', (e) => errors.push(e.message))
          const t0 = Date.now()
          await tab.goto(base + page.path)
          await tab.waitForFunction(() => window.__sheetPixels?.pdfBase64 || window.__sheetPixels?.error, null, { timeout: 120000 })
          const out = await tab.evaluate(() => window.__sheetPixels)
          const label = `${run.id} ${page.id}`
          if (out.error) {
            failed++
            console.log(`FAIL ${label}: the PDF was not made: ${out.error} ${errors.join(' | ')}`)
          } else {
            const pdf = Buffer.from(out.pdfBase64, 'base64')
            const jpeg = jpegOfPdf(pdf)
            if (KEEP) {
              writeFileSync(join(KEEP, `${run.id}-${page.id}.pdf`), pdf)
              writeFileSync(join(KEEP, `${run.id}-${page.id}.jpg`), jpeg)
              writeFileSync(join(KEEP, `${run.id}-${page.id}.json`), JSON.stringify(out.geometry, null, 1))
            }
            const r = await tab.evaluate(checkInPage, { jpegBase64: jpeg.toString('base64'), g: out.geometry })
            const secs = ((Date.now() - t0) / 1000).toFixed(1)
            if (r.fails.length) {
              failed++
              console.log(`FAIL ${label} (dpr ${out.geometry.dpr}, ${r.size.join('x')}, ${secs} s): ${r.fails.length} of ${r.checks} checks`)
              for (const f of r.fails) console.log(`   - ${f}`)
            } else {
              console.log(`ok   ${label} (dpr ${out.geometry.dpr}, ${r.size.join('x')}, ${secs} s): ${r.checks} checks`)
            }
            if (args.includes('--verbose')) {
              for (const n of r.notes) console.log(`   · ${n}`)
            }
          }
          await ctx.close()
        }
      } finally {
        await browser.close()
      }
    }
  } finally {
    await server.close()
  }
  process.exit(failed ? 1 : 0)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1) })
}
