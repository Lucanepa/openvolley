#!/usr/bin/env node
/**
 * roster.openvolley.app scrolls to its last control (CI: .github/workflows/roster-scroll.yml).
 *
 * On 2026-11-17 the page could not be scrolled on a phone or a PC: the app's
 * locked frame (styles.css: html, body, #root { overflow: hidden }) held it
 * too, and everything below the fold was out of reach. The frontend suite
 * (vitest, jsdom) has no layout, so it cannot see this.
 *
 * In Chromium at a phone (390×844), a tablet (1005×600, the Galaxy Tab A7
 * Lite's landscape CSS size) and a desktop (1440×900): opens the page, starts
 * its test mode (six taps on "No active games"), picks Home, types the test
 * PIN, reads a made-up Einsatzliste (16 players, built here with jsPDF; the
 * real pdf.js path) and then scrolls with the mouse wheel / a touch swipe
 * until the last control (Confirm, then the last legal link) is on screen.
 * Checked: the page is taller than the window, it scrolls, the last control
 * ends up inside the window, and there is no sideways scroll.
 *
 *   npx playwright@1.63.0 install chromium   (once)
 *   node scripts/roster-scroll.mjs [--only phone,tablet,desktop] [--keep DIR]
 * Env: PLAYWRIGHT_MODULE (path of a playwright install to use), CHROMIUM_PATH.
 * Exit code 1 when a check fails.
 */
import { createServer } from 'vite'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { jsPDF } from 'jspdf'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
export const VIEWPORTS = [
  { id: 'phone', width: 390, height: 844, touch: true, mobile: true },
  { id: 'tablet', width: 1005, height: 600, touch: true, mobile: false },
  { id: 'desktop', width: 1440, height: 900, touch: false, mobile: false }
].filter((v) => !opt('--only') || opt('--only').split(',').includes(v.id))
const KEEP = opt('--keep')

/** A made-up Einsatzliste: SV number | first name | last name | gender | date of birth. */
export function einsatzlistePdf (players = 16) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  doc.setFontSize(10)
  doc.text('Einsatzliste', 40, 40)
  doc.text('VBC Musterdorf', 140, 40)
  for (const [x, s] of [[40, 'SV-Nr'], [100, 'Vorname'], [200, 'Name'], [330, 'G'], [360, 'Geburtsdatum']]) doc.text(s, x, 80)
  for (let i = 0; i < players; i++) {
    const y = 100 + i * 20
    doc.text(String(100000 + i * 111), 40, y)
    doc.text(`Vorname${String.fromCharCode(65 + i)}`, 100, y)
    doc.text(`Muster${String.fromCharCode(65 + i)}`, 200, y)
    doc.text('F', 330, y)
    doc.text(`${String(1 + i).padStart(2, '0')}.0${1 + (i % 9)}.200${i % 10}`, 360, y)
  }
  return Buffer.from(doc.output('arraybuffer'))
}

/** Runs in the page: where the last control is, and how the page scrolls. */
function measure () {
  const se = document.scrollingElement || document.documentElement
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const controls = [...document.querySelectorAll('button, a[href], input:not([type=hidden]):not([type=file]), select, textarea')].filter(visible)
  const last = controls[controls.length - 1]
  const confirm = document.querySelector('[data-testid="roster-confirm"]')
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, label: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40) } }
  return {
    scrollY: se.scrollTop,
    scrollHeight: se.scrollHeight,
    scrollWidth: se.scrollWidth,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    last: box(last),
    confirm: box(confirm)
  }
}

async function swipeUp (page, cdp, vp) {
  if (cdp && vp.touch) {
    // a finger dragged up (CDP touch events; synthesizeScrollGesture does
    // nothing in headless Chromium). Near the left edge: off the roster
    // table, which scrolls sideways on a phone
    const x = 24
    const y0 = Math.round(vp.height * 0.75)
    const steps = 10
    const dy = Math.round((vp.height * 0.5) / steps)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] })
    for (let i = 1; i <= steps; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 - i * dy }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await page.mouse.move(vp.width / 2, vp.height / 2)
    await page.mouse.wheel(0, Math.round(vp.height * 0.6))
  }
  await page.waitForTimeout(250)
}

async function runViewport (browser, base, vp, pdf) {
  const fails = []
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.mobile, locale: 'en-GB' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(base + '/upload_roster/')
    const noGames = page.getByTestId('roster-no-games')
    await noGames.waitFor({ timeout: 60000 })
    for (let i = 0; i < 6; i++) await noGames.click()
    await page.getByTestId('roster-team-home').click()
    await page.getByTestId('roster-pin').fill('123456')
    await page.getByTestId('roster-pdf-input').setInputFiles({ name: 'einsatzliste.pdf', mimeType: 'application/pdf', buffer: pdf })
    await page.getByTestId('roster-pdf-parse').click()
    await page.getByTestId('roster-confirm').waitFor({ state: 'attached', timeout: 60000 })
    await page.waitForTimeout(300)
    const before = await page.evaluate(measure)
    if (before.scrollHeight <= before.innerHeight) fails.push(`the page is not taller than the window (${before.scrollHeight} ≤ ${before.innerHeight}): nothing to check`)
    if (before.last && before.last.bottom <= before.innerHeight) fails.push('the last control is already on screen before scrolling: nothing to check')
    const cdp = vp.touch ? await ctx.newCDPSession(page) : null
    let now = before
    for (let i = 0; i < 40; i++) {
      if (now.last && now.last.bottom <= now.innerHeight && now.last.top >= 0) break
      await swipeUp(page, cdp, vp)
      now = await page.evaluate(measure)
    }
    if (KEEP) await page.screenshot({ path: join(KEEP, `roster-${vp.id}-${vp.width}x${vp.height}.png`) })
    if (!(now.scrollY > 0)) fails.push(`the page did not scroll (scrollTop ${now.scrollY})`)
    if (!now.last || now.last.bottom > now.innerHeight || now.last.top < 0) fails.push(`the last control (${now.last?.label}) is out of reach: top ${now.last?.top}, bottom ${now.last?.bottom}, window ${now.innerHeight}`)
    if (!now.confirm || now.confirm.bottom > now.innerHeight + 0.5) {
      // Confirm sits just above the legal links: on screen at the bottom too
      fails.push(`Confirm is out of reach (bottom ${now.confirm?.bottom}, window ${now.innerHeight})`)
    }
    if (now.scrollWidth > now.innerWidth + 1) fails.push(`sideways scroll: ${now.scrollWidth} > ${now.innerWidth}`)
    if (errors.length) fails.push(`page errors: ${errors.join(' | ')}`)
    return { fails, before, after: now }
  } finally {
    await ctx.close()
  }
}

async function main () {
  process.env.WS_PORT = process.env.WS_PORT || '0'
  // nothing of the page may reach a real server
  process.env.VITE_BACKEND_URL = process.env.VITE_BACKEND_URL || 'http://127.0.0.1:9'
  process.env.VITE_CLOUD_API_URL = process.env.VITE_CLOUD_API_URL || 'http://127.0.0.1:9'
  const server = await createServer({ root, configFile: join(root, 'vite.config.js'), logLevel: 'warn', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } })
  await server.listen()
  const base = server.resolvedUrls.local[0].replace(/\/$/, '')
  const pw = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(join(process.env.PLAYWRIGHT_MODULE, 'index.mjs')).href : 'playwright')
  if (KEEP) mkdirSync(KEEP, { recursive: true })
  const pdf = einsatzlistePdf()
  let failed = 0
  const browser = await pw.chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) })
  try {
    for (const vp of VIEWPORTS) {
      const label = `${vp.id} ${vp.width}x${vp.height}`
      try {
        const r = await runViewport(browser, base, vp, pdf)
        if (r.fails.length) {
          failed++
          console.log(`FAIL ${label}`)
          for (const f of r.fails) console.log(`   - ${f}`)
        } else {
          console.log(`ok   ${label}: page ${r.after.scrollHeight} px in a ${r.after.innerHeight} px window, scrolled to ${Math.round(r.after.scrollY)}, last control «${r.after.last.label}» on screen`)
        }
      } catch (err) {
        failed++
        console.log(`FAIL ${label}: ${err.message.split('\n')[0]}`)
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
  process.exit(failed ? 1 : 0)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1) })
}
