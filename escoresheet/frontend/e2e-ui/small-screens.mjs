#!/usr/bin/env node
// Small-screen checks of the scorer app in Chromium (real match on a Galaxy
// Tab A7 Lite, 17.11.2026). Needs a running dev server with a dead backend:
//
//   VITE_BACKEND_URL=http://127.0.0.1:9 VITE_CLOUD_API_URL=http://127.0.0.1:9 \
//     WS_PORT=18731 npx vite --host 127.0.0.1 --port 5631 --strictPort
//   OV_URL=http://127.0.0.1:5631/ node e2e-ui/small-screens.mjs [--only menus,sets,sub]
//     [--viewports tab133,tab150,phone,desktop,laptop] [--shots DIR] [--throttle N]
//
// Checks, per viewport:
//   menus  every dropdown / popover menu of Home, the coin toss and the
//          scoring screen opens inside the window with every row reachable,
//          as a centred modal on phones and small tablets (ui/menuLayout.js)
//          and as a popover on larger screens;
//   sets   a test match played to the fifth set: after each set the rows of
//          both set tables (Set P W S T) stay inside their box, the box and
//          the rally buttons keep their size and place;
//   sub    a substitution confirmed while a time-out countdown runs: by tap,
//          and dragged in with the mouse and with a finger (--throttle N:
//          the CPU N times slower from the time-out on, a small tablet).
// --shots DIR saves screenshots at device scale 2 (for people).
// Environment: PLAYWRIGHT_CORE (path to playwright-core), CHROME_PATH.
import fs from 'node:fs'
import path from 'node:path'
import {
  launch, openApp, openCoinToss, confirmCoinToss, enterLineups, dialogs, answerDialogs,
  clickTopButton, dbState, sideOf, help, visible, sleep, waitUntil
} from './lib.mjs'

// Galaxy Tab A7 Lite: 1340x800 px; density 1.333 -> 1005x600 CSS px, 1.5 -> 893x533.
// 893x533 is a phone-sized screen for the app (short side < 600: the scoring
// screen asks to hold it upright, phoneLayout.js isPhoneScreen), so that
// viewport runs as a window of that size on a larger screen (window.screen
// 1005x600) and in fullscreen (the 800x600 size gate).
const VIEWPORTS = {
  tab133: { name: '1005x600', width: 1005, height: 600, touch: true },
  tab150: { name: '893x533', width: 893, height: 533, touch: true, screen: { width: 1005, height: 600 }, fullscreen: true },
  phone: { name: '390x844', width: 390, height: 844, touch: true, phone: true },
  desktop: { name: '1440x900', width: 1440, height: 900, touch: false },
  // a laptop in a short window: popovers, the Match menu scrolls inside its room
  laptop: { name: '1366x650', width: 1366, height: 650, touch: false, menusOnly: true }
}

const args = process.argv.slice(2)
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
const ONLY = new Set(arg('only', 'menus,sets,sub').split(','))
const VPS = arg('viewports', 'tab133,tab150,phone,desktop,laptop').split(',').map((k) => {
  if (!VIEWPORTS[k]) throw new Error(`unknown viewport ${k}`)
  return VIEWPORTS[k]
})
const SHOTS = arg('shots', '')
const THROTTLE = Number(arg('throttle', '1')) || 1
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })

const results = []
const record = (vp, check, ok, detail = '') => {
  results.push({ vp: vp.name, check, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${vp.name}] ${check}${detail ? ` - ${detail}` : ''}`)
}
const shot = async (page, vp, name) => {
  if (!SHOTS) return
  await page.screenshot({ path: path.join(SHOTS, `${vp.name}-${name}.png`) })
}
// ui/menuLayout.js MENU_MODAL_BELOW
const expectModal = (vp) => Math.min(vp.width, vp.height) < 700 && Math.max(vp.width, vp.height) < 1100

async function newPage (vp) {
  const env = await launch({ width: vp.width, height: vp.height, dpr: SHOTS ? 2 : 1, touch: vp.touch, screen: vp.screen || null })
  await openApp(env.page, { fullscreen: !!vp.fullscreen })
  return env
}

// ── menus ──────────────────────────────────────────────────────────────

/** The menu last opened: inside the window, every row reachable (scrolled to if needed). */
async function measureMenu (page) {
  return page.evaluate(() => {
    const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' }
    const panels = [...document.querySelectorAll('[data-menu-popover], [role=dialog][aria-modal=true]')].filter(shown)
    const panel = panels[panels.length - 1]
    if (!panel) return null
    const vw = window.innerWidth
    const vh = window.innerHeight
    const inside = (r) => r.top >= -0.5 && r.left >= -0.5 && r.bottom <= vh + 0.5 && r.right <= vw + 0.5
    const r = panel.getBoundingClientRect()
    const rows = [...panel.querySelectorAll('button, [role=menuitem], a[href]')].filter(shown).filter((e) => !e.closest('[aria-hidden="true"]'))
    const unreachable = []
    for (const row of rows) {
      row.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const b = row.getBoundingClientRect()
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
      if (!inside(b) || !hit || !(row === hit || row.contains(hit))) unreachable.push((row.innerText || row.getAttribute('aria-label') || '?').trim().replace(/\s+/g, ' ').slice(0, 40))
    }
    // back to the top for the screenshot
    for (const el of [panel, ...panel.querySelectorAll('*')]) if (el.scrollTop) el.scrollTop = 0
    return {
      mode: panel.getAttribute('data-menu-popover') || 'dialog',
      rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) },
      inViewport: inside(r),
      rows: rows.length,
      unreachable
    }
  })
}

async function checkMenu (page, vp, name, opener, { kitMenu = true } = {}) {
  // under 900 px wide with touch the scoring screen offers tablet mode in a banner over the toolbar
  if (await clickTopButton(page, /^Not now$/)) await sleep(400)
  const button = typeof opener === 'function' ? await opener() : opener
  if (!(await button.count()) || !(await visible(button.first()))) { record(vp, `menu ${name}`, false, 'button not found'); return }
  await button.first().click()
  await sleep(500)
  const m = await measureMenu(page)
  if (!m) { record(vp, `menu ${name}`, false, 'no menu opened'); return }
  await shot(page, vp, `menu-${name}`)
  const wantMode = expectModal(vp) ? 'modal' : 'popover'
  const problems = []
  if (!m.inViewport) problems.push(`outside the window ${JSON.stringify(m.rect)}`)
  if (m.unreachable.length) problems.push(`unreachable: ${m.unreachable.join(', ')}`)
  if (kitMenu && m.mode !== wantMode) problems.push(`opened as ${m.mode}, expected ${wantMode}`)
  record(vp, `menu ${name}`, problems.length === 0, problems.join('; ') || `${m.mode}, ${m.rows} rows, ${JSON.stringify(m.rect)}`)
  // Close it: the modal's close button, else Escape (not in fullscreen: Escape leaves it)
  const close = page.locator('[data-menu-popover]:visible [data-modal-close], [role=dialog][aria-modal=true]:visible button[aria-label="Close"]').first()
  if (await close.count()) await close.click().catch(() => {})
  else await page.keyboard.press('Escape')
  await sleep(400)
}

async function runMenus (vp) {
  const { browser, page, errors } = await newPage(vp)
  try {
    // Home
    await checkMenu(page, vp, 'home-header-menu', page.getByRole('button', { name: 'Menu', exact: true }))
    await checkMenu(page, vp, 'home-connection-status', page.locator('[data-connection-menu] button'))
    // Coin toss
    await openCoinToss(page)
    await checkMenu(page, vp, 'cointoss-sign-a', page.getByRole('button', { name: /^Sign A/ }))
    await checkMenu(page, vp, 'cointoss-sign-b', page.getByRole('button', { name: /^Sign B/ }))
    await checkMenu(page, vp, 'cointoss-scoresheet', page.locator('button[aria-haspopup="menu"]'))
    await checkMenu(page, vp, 'cointoss-match-chip', page.locator('button[data-match-info-menu]'))
    // Scoring screen
    await confirmCoinToss(page)
    if (vp.phone) {
      const menus = page.getByRole('button', { name: 'Menu', exact: true })
      await checkMenu(page, vp, 'scoring-phone-menu', menus.nth(1), { kitMenu: false })
      // the phone scoring screen starts with the header folded away
      const showHeader = page.getByRole('button', { name: 'Show header', exact: true })
      if (await visible(showHeader)) { await showHeader.click(); await sleep(500) }
      await checkMenu(page, vp, 'scoring-header-menu', menus.nth(0))
    } else {
      await checkMenu(page, vp, 'scoring-scoresheet', page.locator('button[title="Scoresheet"]'))
      await checkMenu(page, vp, 'scoring-match-menu', page.locator('button[title="Match"]'))
      await checkMenu(page, vp, 'scoring-header-menu', page.getByRole('button', { name: 'Menu', exact: true }))
    }
    await checkMenu(page, vp, 'scoring-match-chip', page.locator('button[data-match-info-menu]'))
    await checkMenu(page, vp, 'scoring-connection-status', page.locator('[data-connection-menu] button'))
    if (errors.length) record(vp, 'menus: no page errors', false, errors[0])
  } catch (err) {
    record(vp, 'menus run', false, err.message)
    await shot(page, vp, 'menus-error')
  } finally {
    await browser.close()
  }
}

// ── sets ───────────────────────────────────────────────────────────────

/** Both set tables: every row inside its box, the text size, the box size. */
async function measureSetTables (page) {
  return page.evaluate(() => {
    const rally = document.querySelector('.rally-controls')?.getBoundingClientRect()
    return {
      rallyTop: rally ? Math.round(rally.top) : null,
      rallyHeight: rally ? Math.round(rally.height) : null,
      cards: [...document.querySelectorAll('[data-set-summary]')].map((card) => {
        const c = card.getBoundingClientRect()
        const col = card.closest('.set-summary-col')?.getBoundingClientRect() || c
        const table = card.querySelector('table')
        const box = table.parentElement.getBoundingClientRect()
        const rows = [...table.querySelectorAll('tr')].map((tr) => tr.getBoundingClientRect())
        const out = rows.filter((r) => r.bottom > box.bottom + 0.5 || r.bottom > c.bottom + 0.5 || r.bottom > col.bottom + 0.5 || r.top < c.top - 0.5).length
        const td = table.querySelector('tbody td')
        return {
          side: card.dataset.setSummary,
          rows: rows.length - 1,
          out,
          cardHeight: Math.round(c.height),
          cardTop: Math.round(c.top),
          tableHeight: Math.round(table.getBoundingClientRect().height),
          boxHeight: Math.round(box.height),
          fontPx: td ? Math.round(parseFloat(getComputedStyle(td).fontSize) * 10) / 10 : null
        }
      })
    }
  })
}

/** One rally won by `team` ('home' | 'away'), answering whatever the screen asks on the way. */
async function rallyFor (page, team) {
  const ds = await dialogs(page)
  if (ds.length) {
    const answered = await answerDialogs(page, { prefer: /^(Continue|Confirm|OK|Yes|Confirm .+|Switch courts|Not now)$/ })
    if (!answered.length) throw new Error(`stuck on dialog: ${ds[ds.length - 1].text.slice(0, 120)} [${ds[ds.length - 1].buttons.join(' | ')}]`)
    return
  }
  if (await clickTopButton(page, /^End set interval$/)) { await sleep(700); return }
  if (await page.locator('button:visible').filter({ hasText: /^(Lineup\s*[AB]\s*[-·]|Confirm set \d setup$)/ }).count()) { await enterLineups(page); return }
  const start = help(page, 'scoreboard-start-rally')
  if (await visible(start)) {
    if (!(await start.isEnabled({ timeout: 1000 }).catch(() => false))) { await sleep(200); return }
    await start.click()
    await sleep(180)
  }
  const side = await sideOf(page, team)
  const point = help(page, `scoreboard-point-${side}`)
  if (side && await visible(point)) { await point.click(); await sleep(260) }
}

async function runSets (vp) {
  if (vp.phone) { record(vp, 'sets', true, 'skipped: the phone layout has no per-team set tables'); return }
  const { browser, page, errors } = await newPage(vp)
  try {
    await openCoinToss(page)
    await confirmCoinToss(page)
    await enterLineups(page)
    const s0 = await dbState(page)
    const teamA = s0.teamA || 'home'
    const teamB = teamA === 'home' ? 'away' : 'home'
    let baseline = null
    const check = async (label) => {
      await sleep(400)
      const m = await measureSetTables(page)
      await shot(page, vp, `sets-${label}`)
      if (m.cards.length !== 2) { record(vp, `set tables ${label}`, false, `${m.cards.length} tables shown`); return }
      if (!baseline) baseline = m
      const problems = []
      for (const c of m.cards) {
        if (c.out) problems.push(`${c.side}: ${c.out} row(s) outside the box`)
        const b = baseline.cards.find((x) => x.side === c.side)
        if (Math.abs(c.cardHeight - b.cardHeight) > 1 || Math.abs(c.cardTop - b.cardTop) > 1) problems.push(`${c.side}: box moved/resized ${b.cardTop}/${b.cardHeight} -> ${c.cardTop}/${c.cardHeight}`)
      }
      if (Math.abs(m.rallyTop - baseline.rallyTop) > 1) problems.push(`rally buttons moved ${baseline.rallyTop} -> ${m.rallyTop}`)
      record(vp, `set tables ${label}`, problems.length === 0, problems.join('; ') || m.cards.map((c) => `${c.side} ${c.rows} rows in ${c.boxHeight}px (table ${c.tableHeight}px, text ${c.fontPx}px)`).join(', '))
    }
    await check('set1-start')
    // A wins sets 1, 3 and 5, B sets 2 and 4: a five-set match
    for (let set = 1; set <= 5; set++) {
      const winner = set % 2 === 1 ? teamA : teamB
      const target = set === 5 ? 15 : 25
      const t0 = Date.now()
      for (;;) {
        if (Date.now() - t0 > 240000) throw new Error(`set ${set} did not finish`)
        const st = await dbState(page)
        if (st.set > set || st.status === 'final' || (st.set === set && st.finished)) break
        if (set === 5 && st.set === 5 && st[winner] === target - 1) break // keep the 5th set on screen
        await rallyFor(page, winner)
      }
      if (set < 5) {
        // the next set's screen: interval, line-ups, ready to start
        const t1 = Date.now()
        for (;;) {
          if (Date.now() - t1 > 60000) throw new Error(`set ${set + 1} did not get ready`)
          const ds = await dialogs(page)
          if (ds.length) { await answerDialogs(page, { prefer: /^(Continue|Confirm|OK|Yes|Confirm .+|Switch courts|Not now)$/ }); continue }
          if (await clickTopButton(page, /^End set interval$/)) { await sleep(700); continue }
          if (await page.locator('button:visible').filter({ hasText: /^(Lineup\s*[AB]\s*[-·]|Confirm set \d setup$)/ }).count()) { await enterLineups(page); continue }
          if (await visible(help(page, 'scoreboard-start-rally'))) break
          await sleep(200)
        }
        await check(`after-set${set}`)
      } else {
        await check('set5-match-point')
      }
    }
    if (errors.length) record(vp, 'sets: no page errors', false, errors[0])
  } catch (err) {
    record(vp, 'sets run', false, err.message)
    await shot(page, vp, 'sets-error')
  } finally {
    await browser.close()
  }
}

// ── substitution during a time-out ─────────────────────────────────────

/** Number buttons that appeared since `mark` ran (a player list just opened). */
async function markNumberButtons (page) {
  await page.evaluate(() => document.querySelectorAll('button').forEach((b) => b.setAttribute('data-e2e-seen', '')))
}
async function newNumberButton (page) {
  return page.evaluate(() => {
    const b = [...document.querySelectorAll('button:not([data-e2e-seen])')].find((x) => /^\d{1,2}$/.test((x.innerText || '').trim()) && x.getBoundingClientRect().width > 0 && !x.disabled)
    if (!b) return null
    b.setAttribute('data-e2e-pick', '')
    return b.innerText.trim()
  })
}

/** One rally on the phone layout, won by the team shown on the left. */
async function phoneRally (page) {
  const ds = await dialogs(page)
  if (ds.length) { await answerDialogs(page); return }
  const start = help(page, 'scoreboard-start-rally')
  if (await visible(start) && await start.isEnabled({ timeout: 1000 }).catch(() => false)) { await start.click(); await sleep(180) }
  const point = page.locator('[data-help-id="scoreboard-point-left"]:visible').first()
  if (await point.count()) { await point.click(); await sleep(260) }
}

/**
 * A substitution while a time-out countdown runs, three ways:
 *   tap         court player -> Substitution -> bench player (phone: SUB sheet)
 *   mouse-drag  a bench player dragged onto a court player (HTML5 drag)
 *   touch-drag  the same with a finger: hold 0.7 s, move, lift (Chrome touch
 *               events); "Yes" is tapped with a finger too
 * The owner dragged one on the Tab A7 Lite (17.11.2026) and could confirm it
 * only after the time-out: the countdown rendered the whole scoring screen
 * ten times a second and held up the touches. --throttle N slows the CPU
 * N times from the time-out on (a small tablet).
 */
async function runSubDuringTimeout (vp, method) {
  const label = `substitution during a time-out (${method}${THROTTLE > 1 ? `, CPU /${THROTTLE}` : ''})`
  const { browser, page, errors } = await newPage(vp)
  try {
    await openCoinToss(page)
    await confirmCoinToss(page)
    await enterLineups(page)
    const s0 = await dbState(page)
    // one rally (the time-out comes in an interruption)
    const t0 = Date.now()
    for (;;) {
      const st = await dbState(page)
      if (st.home + st.away >= 1 && !(await dialogs(page)).length) break
      if (Date.now() - t0 > 30000) throw new Error('first rally not played')
      if (vp.phone) await phoneRally(page)
      else await rallyFor(page, s0.teamA || 'home')
    }
    if (await clickTopButton(page, /^Not now$/)) await sleep(400)
    if (vp.phone) {
      await page.locator('button:visible', { hasText: /^time-out/i }).first().click()
    } else {
      await help(page, 'scoreboard-timeout-left').click()
    }
    await sleep(600)
    if (!(await clickTopButton(page, /^Confirm time-out$/))) throw new Error('no time-out confirmation')
    const timeoutAt = Date.now()
    await sleep(900)
    const stop = page.getByRole('button', { name: 'Stop timeout', exact: true })
    if (!(await visible(stop))) throw new Error('time-out countdown not shown')
    const cdp = await page.context().newCDPSession(page)
    if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
    const fingerTap = async ({ x, y }) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      await sleep(120)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    }
    let gestureEnd = Date.now()
    if (vp.phone) {
      await page.locator('button:visible', { hasText: /^sub/i }).first().click()
      await sleep(600)
      const out = page.locator('[role=dialog]:visible').last().getByRole('button', { name: /^\d{1,2}$/ }).first()
      await out.click()
      await sleep(600)
      const into = page.locator('[role=dialog]:visible').last().getByRole('button', { name: /^\d{1,2}$/ }).first()
      await into.click()
      gestureEnd = Date.now()
    } else {
      const team = (await sideOf(page, 'home')) === 'left' ? 'home' : 'away'
      // a court player and a bench player (not a libero) of the team on the left
      const at = await page.evaluate((team) => {
        const centre = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
        const court = [...document.querySelectorAll(`.court-player[data-team="${team}"]`)].find((e) => e.getBoundingClientRect().width > 0 && e.dataset.courtPosition === 'II')
        const bench = [...document.querySelectorAll(`[data-bench-player][data-team="${team}"]`)].find((e) => e.getBoundingClientRect().width > 0 && e.dataset.isLibero !== 'true')
        return { court: centre(court), courtNumber: court.dataset.playerNumber, bench: centre(bench), benchNumber: bench.dataset.benchPlayer }
      }, team)
      if (method === 'tap') {
        await page.mouse.click(at.court.x, at.court.y)
        await sleep(600)
        await markNumberButtons(page)
        await page.getByRole('button', { name: /^Substitution/ }).first().click()
        await sleep(600)
        if (!(await newNumberButton(page))) throw new Error('no substitute offered')
        await page.locator('[data-e2e-pick]').click()
      } else if (method === 'mouse-drag') {
        await page.locator(`[data-bench-player="${at.benchNumber}"][data-team="${team}"]`).first()
          .dragTo(page.locator(`.court-player[data-team="${team}"][data-court-position="II"]`).first())
      } else {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at.bench] })
        await sleep(700) // the hold that starts a drag (TOUCH_DRAG_HOLD_MS 350)
        const steps = 12
        for (let k = 1; k <= steps; k++) {
          const x = at.bench.x + (at.court.x - at.bench.x) * k / steps
          const y = at.bench.y + (at.court.y - at.bench.y) * k / steps
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
          await sleep(40)
        }
        await sleep(150)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      }
      gestureEnd = Date.now()
    }
    const yes = page.getByRole('button', { name: 'Yes', exact: true }).last()
    await waitUntil(async () => visible(yes), { timeoutMs: 40000, intervalMs: 100, what: 'the substitution confirmation' })
    const dialogAfter = Date.now() - gestureEnd
    await shot(page, vp, `sub-during-timeout-${method}-confirm`)
    const box = await yes.boundingBox()
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const top = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.innerText?.trim() || null, centre)
    if (top !== 'Yes') throw new Error(`"Yes" is covered by: ${top}`)
    if (method === 'touch-drag') await fingerTap(centre)
    else await page.mouse.click(centre.x, centre.y)
    await waitUntil(async () => (await dbState(page)).substitutions >= 1, { timeoutMs: 40000, what: 'substitution written' })
    const writtenAfter = Math.round((Date.now() - timeoutAt) / 100) / 10
    const stillRunning = await visible(stop)
    if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await sleep(500)
    await shot(page, vp, `sub-during-timeout-${method}-done`)
    const st = await dbState(page)
    record(vp, label, st.substitutions === 1 && st.timeouts === 1 && stillRunning,
      `substitutions ${st.substitutions}, time-outs ${st.timeouts}, written ${writtenAfter} s into the time-out, countdown still running: ${stillRunning}, confirmation shown ${dialogAfter} ms after the gesture`)
    if (errors.length) record(vp, 'sub: no page errors', false, errors[0])
  } catch (err) {
    record(vp, label, false, err.message)
    await shot(page, vp, `sub-${method}-error`)
  } finally {
    await browser.close()
  }
}

for (const vp of VPS) {
  if (ONLY.has('menus')) await runMenus(vp)
  if (vp.menusOnly) continue
  if (ONLY.has('sub')) {
    // the phone layout has no drag and drop (its SUB sheet)
    for (const method of vp.phone ? ['tap'] : ['tap', 'mouse-drag', 'touch-drag']) await runSubDuringTimeout(vp, method)
  }
  if (ONLY.has('sets')) await runSets(vp)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed${SHOTS ? `, screenshots in ${SHOTS}` : ''}`)
if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 2))
process.exit(failed.length ? 1 : 0)
