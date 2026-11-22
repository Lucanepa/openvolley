// Helpers for the browser checks in this folder (small-screens.mjs): the
// scorer app served by a running dev server, driven by Playwright in Chromium.
// No npm dependency of the app: playwright-core is taken from PLAYWRIGHT_CORE
// (a path), else resolved normally (npm i -g playwright-core, or one in a
// parent folder). The browser is CHROME_PATH, else Playwright's own Chromium.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function loadPlaywright () {
  const tried = []
  for (const id of [process.env.PLAYWRIGHT_CORE, 'playwright-core', 'playwright'].filter(Boolean)) {
    try { return require(id) } catch (err) { tried.push(`${id}: ${err.code || err.message}`) }
  }
  throw new Error(`playwright-core not found (${tried.join('; ')}). Set PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core`)
}

export const BASE_URL = process.env.OV_URL || 'http://127.0.0.1:5173/'
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A fresh browser context at one viewport. `dpr` 2 for screenshots meant for
 * people; `screen` is window.screen (defaults to the viewport).
 */
export async function launch ({ width, height, dpr = 1, touch = true, screen = null }) {
  const { chromium } = loadPlaywright()
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true })
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, hasTouch: touch, ...(screen ? { screen } : {}) })
  // The first-run chooser (Swiss or Global, utils/toolMode.js) would cover the home screen
  await ctx.addInitScript(() => { try { if (!localStorage.getItem('ov-tool-mode')) localStorage.setItem('ov-tool-mode', 'swiss') } catch { /* private */ } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e?.stack || e).slice(0, 500)))
  return { browser, ctx, page, errors }
}

export const help = (page, id) => page.locator(`[data-help-id="${id}"]`)
export const visible = async (loc) => { try { return await loc.isVisible() } catch { return false } }

export async function waitUntil (fn, { timeoutMs = 30000, intervalMs = 100, what = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`)
    await sleep(intervalMs)
  }
}

/** Visible dialogs ([role=dialog] and the scoring screen's fixed pop-ups), top-most last. */
export async function dialogs (page) {
  return page.evaluate(() => {
    const shown = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' }
    const text = (e) => (e.innerText || e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()
    const out = [...document.querySelectorAll('[role=dialog], [role=alertdialog]')]
      .filter(shown)
      .filter((d) => !d.closest('[data-menu-modal]') && !d.matches('[data-menu-popover]'))
      .map((d) => ({ text: text(d).slice(0, 300), buttons: [...d.querySelectorAll('button')].filter(shown).map(text).filter(Boolean) }))
    for (const e of document.querySelectorAll('body div')) {
      const cs = getComputedStyle(e)
      if (cs.position !== 'fixed' || !(Number(cs.zIndex) >= 500) || !shown(e) || e.closest('[role=dialog], [role=alertdialog]') || e.querySelector('[role=dialog], [role=alertdialog]')) continue
      if (e.matches('[data-menu-popover]')) continue
      const r = e.getBoundingClientRect()
      if (r.width < 120 || r.height < 60) continue
      const btns = [...e.querySelectorAll('button')].filter(shown)
      if (!btns.length) continue
      const b = btns[0].getBoundingClientRect()
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
      if (!hit || !e.contains(hit)) continue
      out.push({ text: text(e).slice(0, 300), buttons: btns.map(text).filter(Boolean), custom: true })
      break
    }
    return out
  })
}

/** Click the top-most visible button whose text matches `re` (at its centre). */
export async function clickTopButton (page, re) {
  return page.evaluate((src) => {
    const re = new RegExp(src)
    const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const btns = [...document.querySelectorAll('button')].filter(shown).filter((b) => re.test((b.innerText || '').trim()))
    for (const b of btns.reverse()) {
      const r = b.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      if (hit && b.contains(hit)) { b.click(); return (b.innerText || '').trim() }
    }
    return null
  }, re.source)
}

/** Answer whatever dialog is open with a neutral answer. */
export async function answerDialogs (page, { prefer = /^(Continue|Confirm|OK|Not now)$/, rounds = 6 } = {}) {
  const answered = []
  for (let i = 0; i < rounds; i++) {
    const ds = await dialogs(page)
    if (!ds.length) break
    const top = ds[ds.length - 1]
    const pick = top.buttons.find((b) => prefer.test(b))
    if (!pick) break
    const done = await clickTopButton(page, new RegExp(`^${pick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
    answered.push(`${top.text.slice(0, 60)} -> ${done}`)
    await sleep(600) // the scoring screen's ghost-click guard after a confirm
  }
  return answered
}

/** Close the start-up dialogs (Connecting..., What's new) wherever they are in the stack. */
async function dismissStartup (page) {
  let closed = 0
  for (let i = 0; i < 6; i++) {
    const ds = await dialogs(page)
    const d = ds.find((x) => /Connecting|What's new|Update/i.test(x.text) && x.buttons.some((b) => /^(Dismiss|Close|Later|Not now)$/.test(b)))
    if (!d) return closed
    const b = d.buttons.find((x) => /^(Dismiss|Close|Later|Not now)$/.test(x))
    await page.getByRole('button', { name: b, exact: true }).last().click({ timeout: 5000 }).catch(() => {})
    closed++
    await sleep(300)
  }
  return closed
}

/** Home screen, with the start-up dialogs closed. `fullscreen`: below 800x600 the scoring screen needs it (size gate). */
export async function openApp (page, { fullscreen = false } = {}) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await waitUntil(async () => visible(help(page, 'home-new-match-button')) || visible(page.locator('button:text-is("Test match")')), { timeoutMs: 60000, intervalMs: 300, what: 'home screen' })
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    if (await dismissStartup(page)) break
    await sleep(300)
  }
  await dismissStartup(page)
  if (fullscreen) await page.evaluate(() => document.documentElement.requestFullscreen().catch(() => {}))
}

/** New test match up to the coin toss. */
export async function openCoinToss (page) {
  const test = page.locator('button:text-is("Test match")')
  if (!(await visible(test))) await help(page, 'home-new-match-button').click()
  await test.waitFor({ state: 'visible', timeout: 15000 })
  await test.click()
  await waitUntil(async () => {
    const ds = await dialogs(page)
    const top = ds[ds.length - 1]
    if (top && top.buttons.some((b) => /^(Yes|Continue|Confirm|OK)$/.test(b))) {
      await clickTopButton(page, /^(Yes|Continue|Confirm|OK)$/)
      await sleep(500)
      return false
    }
    return visible(help(page, 'setup-proceed-cointoss'))
  }, { timeoutMs: 45000, intervalMs: 200, what: 'test match setup' })
  const coin = help(page, 'setup-proceed-cointoss')
  await waitUntil(async () => coin.isEnabled(), { timeoutMs: 15000, what: 'coin toss enabled' })
  await coin.click()
  await help(page, 'cointoss-team-selector').waitFor({ state: 'visible', timeout: 15000 })
}

/** Coin toss confirmed, scoring screen shown (set not started). */
export async function confirmCoinToss (page) {
  await page.getByRole('button', { name: 'Confirm coin toss result', exact: true }).click({ timeout: 15000 })
  await sleep(600)
  await waitUntil(async () => {
    const ds = await dialogs(page)
    const top = ds[ds.length - 1]
    if (top && top.buttons.some((b) => /^(Continue|Yes|Confirm|OK|Proceed anyway)$/.test(b))) { await clickTopButton(page, /^(Continue|Yes|Confirm|OK|Proceed anyway)$/); await sleep(500) }
    // under 900 px wide with touch: "Small screen detected! Enable tablet mode ...?" (kept as it is)
    if (top && top.buttons.includes('Not now')) { await clickTopButton(page, /^Not now$/); await sleep(400); return false }
    return (await visible(help(page, 'scoreboard-start-rally'))) && ds.length === 0
  }, { timeoutMs: 45000, intervalMs: 200, what: 'scoring screen' })
}

/** The newest match's current set from IndexedDB: index, points, events. */
export async function dbState (page) {
  return page.evaluate(async () => {
    const open = () => new Promise((resolve, reject) => { const r = indexedDB.open('escoresheet'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    const db = await open()
    const all = (store) => new Promise((resolve, reject) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error) })
    const m = (await all('matches')).filter((x) => x.coinTossTeamA).sort((a, b) => (b.id || 0) - (a.id || 0))[0]
    if (!m) { db.close(); return null }
    const sets = (await all('sets')).filter((s) => s.matchId === m.id)
    const byIndex = new Map()
    for (const s of sets) { const ex = byIndex.get(s.index); if (!ex || s.id > ex.id) byIndex.set(s.index, s) }
    const ordered = [...byIndex.values()].sort((a, b) => a.index - b.index)
    const cur = ordered.find((s) => !s.finished) || ordered[ordered.length - 1]
    const events = (await all('events')).filter((e) => e.matchId === m.id)
    db.close()
    return {
      matchId: m.id,
      status: m.status,
      teamA: m.coinTossTeamA,
      set: cur?.index,
      finished: !!cur?.finished,
      home: cur?.homePoints || 0,
      away: cur?.awayPoints || 0,
      setsWon: ordered.filter((s) => s.finished).map((s) => (s.homePoints > s.awayPoints ? 'home' : 'away')),
      substitutions: events.filter((e) => e.type === 'substitution').length,
      timeouts: events.filter((e) => e.type === 'timeout').length
    }
  })
}

/** Six players of team A or B: the captain first, then the lowest non-libero numbers. */
async function defaultLineup (page, letter) {
  return page.evaluate(async (letter) => {
    const open = () => new Promise((resolve, reject) => { const r = indexedDB.open('escoresheet'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    const db = await open()
    const all = (store) => new Promise((resolve, reject) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error) })
    const m = (await all('matches')).filter((x) => x.coinTossTeamA).sort((a, b) => (b.id || 0) - (a.id || 0))[0]
    const teamA = m.coinTossTeamA || 'home'
    const key = letter === 'A' ? teamA : (teamA === 'home' ? 'away' : 'home')
    const teamId = key === 'home' ? m.homeTeamId : m.awayTeamId
    const players = (await all('players')).filter((p) => p.teamId === teamId)
    db.close()
    const field = players.filter((p) => !p.libero && p.number != null)
    const cap = field.filter((p) => p.isCaptain || p.captain)
    const rest = field.filter((p) => !(p.isCaptain || p.captain)).sort((a, b) => Number(a.number) - Number(b.number))
    return [...cap, ...rest].slice(0, 6).map((p) => Number(p.number))
  }, letter)
}

/** Enter the line-ups still missing (both, the first time; set 5 may ask for its setup first). */
export async function enterLineups (page) {
  for (let i = 0; i < 3; i++) {
    const set5 = page.locator('button:visible').filter({ hasText: /^Confirm set \d setup$/ })
    if (await set5.count()) { await set5.first().click(); await sleep(700); await answerDialogs(page) }
    const btn = page.locator('button:visible').filter({ hasText: /^Line-?up\s*[AB]\s*[-·]/ })
    if (!(await btn.count())) break
    const b = btn.first()
    const letter = /Line-?up\s*([AB])/.exec(await b.innerText())[1]
    const lineup = await defaultLineup(page, letter)
    await b.click()
    const dlg = page.locator('[role=dialog]:visible').last()
    await dlg.locator('input[aria-label="Player at position I"]').waitFor({ state: 'visible', timeout: 15000 })
    const POS = ['I', 'II', 'III', 'IV', 'V', 'VI']
    for (let k = 0; k < 6; k++) await dlg.locator(`input[aria-label="Player at position ${POS[k]}"]`).fill(String(lineup[k]))
    await dlg.getByRole('button', { name: 'Confirm', exact: true }).click()
    await sleep(700)
    await answerDialogs(page)
  }
}

/** The side ('left' | 'right') of team 'home' | 'away' on the scoring screen (desktop / tablet layout). */
export async function sideOf (page, team) {
  return page.evaluate((team) => {
    const players = [...document.querySelectorAll('.court-player[data-team]')]
      .map((e) => ({ team: e.dataset.team, x: e.getBoundingClientRect().left }))
      .filter((p) => p.x > 0)
    if (!players.length) return null
    const mid = players.reduce((s, p) => s + p.x, 0) / players.length
    const mine = players.filter((p) => p.team === team)
    if (!mine.length) return null
    return mine.reduce((s, p) => s + p.x, 0) / mine.length < mid ? 'left' : 'right'
  }, team)
}
