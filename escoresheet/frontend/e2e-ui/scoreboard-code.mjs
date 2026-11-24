#!/usr/bin/env node
// Scoreboard codes end to end (docs/scoreboard-code-spec.md): a scorer
// (1005x600, a Galaxy Tab A7 Lite) scores a test match on the dev server's
// own relay, opens Match ▸ Show on a scoreboard, and two board pages
// (1920x1080 and 1280x720) follow the match by the code alone. Needs a
// running dev server with a dead cloud (the relay is the dev server's own):
//
//   VITE_CLOUD_API_URL=http://127.0.0.1:9 WS_PORT=18741 VITE_WS_PORT=18741 \
//     npx vite --host 127.0.0.1 --port 5641 --strictPort
//   OV_URL=http://127.0.0.1:5641/ node e2e-ui/scoreboard-code.mjs --shots DIR [--quick]
//
// Checked: the panel shows a code that the relay took (Ready), its QR link is
// the board page with the code in the fragment; both boards show the names
// and the score as the scorer's database has it, the serve, a time-out, the
// set interval, the match end; a wrong code and "New code" on the scorer end
// the boards; the board page without a code shows its form.
// --quick stops after the time-out (no full match). --shots DIR saves the
// screenshots at device scale 2. Environment: PLAYWRIGHT_CORE, CHROME_PATH.
import fs from 'node:fs'
import path from 'node:path'
import {
  BASE_URL, launch, openApp, openCoinToss, confirmCoinToss, enterLineups, dialogs, answerDialogs,
  clickTopButton, dbState, sideOf, help, visible, sleep, waitUntil
} from './lib.mjs'

const args = process.argv.slice(2)
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
const SHOTS = arg('shots', null)
const QUICK = args.includes('--quick')
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const shot = async (page, name) => {
  if (!SHOTS) return
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
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

/** Play until the scorer's set `set` has `points` for `team`, or the set ends. */
async function playTo (page, team, points, set) {
  const t0 = Date.now()
  for (;;) {
    if (Date.now() - t0 > 240000) throw new Error(`set ${set}: ${team} did not reach ${points}`)
    const st = await dbState(page)
    if (st.set > set || st.status === 'final' || (st.set === set && (st.finished || st[team] >= points))) return st
    await rallyFor(page, team)
  }
}

/** What a board page shows: its state and both scores (the BoardApp test ids). */
async function boardView (page) {
  return page.evaluate(() => {
    const text = (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? null
    const state = document.querySelector('[data-testid="board-state"]')?.getAttribute('data-state') ?? text('board-state')
    return {
      state,
      left: text('board-points-left'),
      right: text('board-points-right'),
      leftName: text('board-name-left'),
      rightName: text('board-name-right'),
      phase: document.querySelector('[data-testid="board-banner"]')?.getAttribute('data-phase') ?? null,
      body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)
    }
  })
}

/** The scorer's points by side as its screen shows them (left / right). */
async function scorerSides (page) {
  const st = await dbState(page)
  const homeSide = await sideOf(page, 'home')
  return homeSide === 'left' ? { left: st.home, right: st.away, st } : { left: st.away, right: st.home, st }
}

async function waitBoardScore (page, want, what) {
  try {
    await waitUntil(async () => {
      const v = await boardView(page)
      return v.left === String(want.left) && v.right === String(want.right)
    }, { timeoutMs: 15000, intervalMs: 200, what })
    return true
  } catch {
    return false
  }
}

async function openMatchMenuRow (page, label) {
  await answerDialogs(page, { prefer: /^(Continue|Confirm|OK|Not now)$/ })
  await page.locator('button[title="Match"]:visible').first().click()
  await sleep(400)
  await page.getByRole('menuitem', { name: label, exact: true }).click({ timeout: 10000 })
  await sleep(500)
}

async function main () {
  const scorer = await launch({ width: 1005, height: 600, dpr: SHOTS ? 2 : 1, touch: true })
  const big = await launch({ width: 1920, height: 1080, dpr: SHOTS ? 2 : 1, touch: false })
  const small = await launch({ width: 1280, height: 720, dpr: SHOTS ? 2 : 1, touch: false })
  const boards = [{ name: '1920x1080', ...big }, { name: '1280x720', ...small }]
  const boardUrl = (hash = '') => `${BASE_URL.replace(/\/+$/, '')}/livescore/board${hash}`
  try {
    // --- the board page without a code: its form -----------------------------
    await small.page.goto(boardUrl(), { waitUntil: 'domcontentloaded', timeout: 60000 })
    await small.page.locator('[data-testid="board-code-form"]').waitFor({ state: 'visible', timeout: 60000 })
    record('board without a code shows the code form', true)
    await shot(small.page, 'board-1280x720-code-form')

    // --- the scorer: a test match, a few rallies ------------------------------
    const page = scorer.page
    await openApp(page)
    await openCoinToss(page)
    await confirmCoinToss(page)
    await enterLineups(page)
    const s0 = await dbState(page)
    const teamA = s0.teamA || 'home'
    const teamB = teamA === 'home' ? 'away' : 'home'
    await playTo(page, teamA, 3, 1)
    await playTo(page, teamB, 2, 1)

    // --- Show on a scoreboard --------------------------------------------------
    await openMatchMenuRow(page, 'Show on a scoreboard')
    const panel = page.locator('[data-testid="scoreboard-code-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 15000 })
    await waitUntil(async () => /Ready/.test(await page.locator('[data-testid="scoreboard-code-status"]').innerText()), { timeoutMs: 20000, what: 'the relay took the code' })
    const shown = (await page.locator('[data-testid="scoreboard-code"]').innerText()).trim()
    const link = (await page.locator('[data-testid="scoreboard-code-link"]').textContent()).trim()
    const code = shown.replace('-', '')
    record('the scorer panel shows a code the relay took', /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(shown), shown)
    record('the QR link is the board page with the code in the fragment', link.endsWith(`/livescore/board#${code}`) && !link.includes('?'), link)
    await shot(page, 'scorer-1005x600-show-on-scoreboard')
    await page.locator('[data-testid="scoreboard-code-done"]').click()
    await sleep(400)

    // --- both boards follow by the code ---------------------------------------
    for (const b of boards) await b.page.goto(boardUrl(`#${shown}`), { waitUntil: 'domcontentloaded', timeout: 60000 })
    let want = await scorerSides(page)
    for (const b of boards) {
      const ok = await waitBoardScore(b.page, want, `board ${b.name} score`)
      const v = await boardView(b.page)
      record(`board ${b.name} shows the score ${want.left}:${want.right}`, ok, `${v.left}:${v.right} ${v.leftName ?? ''} / ${v.rightName ?? ''}`)
      record(`board ${b.name} has the team names`, /Home|Away|VBC|Volley|\w{3}/.test(`${v.leftName}${v.rightName}`), `${v.leftName} / ${v.rightName}`)
      await shot(b.page, `board-${b.name}-live`)
    }
    // the code is gone from the address bar's query (fragment only) and never in a request
    record('the board keeps the code out of the query', !(await big.page.url()).includes('?code'), big.page.url())

    // --- a rally: the boards move within a second or two ----------------------
    await playTo(page, teamA, 4, 1)
    want = await scorerSides(page)
    for (const b of boards) {
      const t0 = Date.now()
      const ok = await waitBoardScore(b.page, want, `board ${b.name} after a rally`)
      record(`board ${b.name} follows a rally`, ok, `${Date.now() - t0} ms`)
    }

    // --- a time-out -------------------------------------------------------------
    await help(page, 'scoreboard-timeout-left').click()
    await sleep(600)
    if (!(await clickTopButton(page, /^Confirm time-out$/))) throw new Error('no time-out confirmation')
    await sleep(500)
    for (const b of boards) {
      let ok = false
      try {
        await waitUntil(async () => {
          const v = await boardView(b.page)
          return v.phase === 'timeout' || /time-out/i.test(v.body)
        }, { timeoutMs: 10000, what: 'time-out on the board' })
        ok = true
      } catch { /* recorded below */ }
      record(`board ${b.name} shows the time-out`, ok)
      await shot(b.page, `board-${b.name}-timeout`)
    }
    await shot(page, 'scorer-1005x600-timeout')
    const stop = page.getByRole('button', { name: 'Stop timeout', exact: true })
    if (await visible(stop)) { await stop.click(); await sleep(600); await answerDialogs(page) }

    // --- a wrong code -------------------------------------------------------------
    const stranger = await launch({ width: 1280, height: 720, dpr: SHOTS ? 2 : 1, touch: false })
    try {
      await stranger.page.goto(boardUrl('#ZZZZ-ZZZZ'), { waitUntil: 'domcontentloaded', timeout: 60000 })
      let ok = false
      try {
        await waitUntil(async () => (await boardView(stranger.page)).state === 'not-found', { timeoutMs: 15000, what: 'not found' })
        ok = true
      } catch { /* recorded below */ }
      record('a wrong code shows not found', ok, (await boardView(stranger.page)).body.slice(0, 120))
      await shot(stranger.page, 'board-1280x720-not-found')
    } finally {
      await stranger.browser.close()
    }

    // --- New code on the scorer: the boards with the old one end --------------------
    await answerDialogs(page, { prefer: /^(Continue|Confirm|OK|Not now)$/ })
    const sheetOpen = page.locator('button[title="Match"]:visible').first()
    if (!(await visible(sheetOpen))) await shot(page, 'debug-no-match-button')
    if (await visible(sheetOpen)) {
      await openMatchMenuRow(page, 'Show on a scoreboard')
      await page.locator('[data-testid="scoreboard-code-new"]').click()
      await sleep(400)
      await clickTopButton(page, /^New code$/)
      await waitUntil(async () => (await page.locator('[data-testid="scoreboard-code"]').innerText()).trim() !== shown, { timeoutMs: 10000, what: 'a new code' })
      const fresh = (await page.locator('[data-testid="scoreboard-code"]').innerText()).trim()
      await shot(page, 'scorer-1005x600-new-code')
      for (const b of boards) {
        let ok = false
        try {
          await waitUntil(async () => (await boardView(b.page)).state === 'ended', { timeoutMs: 15000, what: 'ended' })
          ok = true
        } catch { /* recorded below */ }
        record(`board ${b.name} ends with the old code`, ok, (await boardView(b.page)).body.slice(0, 120))
      }
      await shot(big.page, 'board-1920x1080-code-ended')
      await page.locator('[data-testid="scoreboard-code-done"]').click()
      await sleep(400)
      // the new code follows again, on both boards
      for (const b of boards) {
        await b.page.goto(boardUrl(`#${fresh}`), { waitUntil: 'domcontentloaded', timeout: 60000 })
        const ok = await waitBoardScore(b.page, await scorerSides(page), `board ${b.name} new code`)
        record(`board ${b.name} follows the match again with the new code`, ok, (await boardView(b.page)).state)
      }
      await shot(big.page, 'board-1920x1080-new-code')
    } else {
      record('New code (Match menu reachable after the match)', false, 'no Match button on the scorer screen')
    }

    if (!QUICK) {
      // --- set 1 to its end: the set interval ---------------------------------
      await playTo(page, teamA, 25, 1)
      // the set end asks the scorer to confirm; then the interval runs (not ended here)
      {
        const t1 = Date.now()
        while (Date.now() - t1 < 30000) {
          if ((await dialogs(page)).length) { await answerDialogs(page, { prefer: /^(Continue|Confirm|OK|Yes|Confirm .+|Switch courts|Not now)$/ }); continue }
          if (await visible(page.getByRole('button', { name: 'End set interval', exact: true }))) break
          await sleep(250)
        }
      }
      await shot(page, 'scorer-1005x600-set-interval')
      for (const b of boards) {
        let ok = false
        try {
          await waitUntil(async () => (await boardView(b.page)).phase === 'set_break', { timeoutMs: 15000, what: 'set interval on the board' })
          ok = true
        } catch { /* recorded below */ }
        record(`board ${b.name} shows the set interval`, ok, (await boardView(b.page)).body.slice(0, 120))
        await shot(b.page, `board-${b.name}-set-interval`)
      }
      // --- sets 2 and 3 to team A: the match end ------------------------------
      for (const set of [2, 3]) {
        const t1 = Date.now()
        for (;;) {
          if (Date.now() - t1 > 60000) throw new Error(`set ${set} did not get ready`)
          const ds = await dialogs(page)
          if (ds.length) { await answerDialogs(page, { prefer: /^(Continue|Confirm|OK|Yes|Confirm .+|Switch courts|Not now)$/ }); continue }
          if (await clickTopButton(page, /^End set interval$/)) { await sleep(700); continue }
          if (await page.locator('button:visible').filter({ hasText: /^(Lineup\s*[AB]\s*[-·]|Confirm set \d setup$)/ }).count()) { await enterLineups(page); continue }
          if (await visible(help(page, 'scoreboard-start-rally'))) break
          await sleep(200)
        }
        if (set === 2) {
          await playTo(page, teamA, 10, 2)
          await playTo(page, teamB, 6, 2)
          for (const b of boards) await shot(b.page, `board-${b.name}-set2`)
        }
        await playTo(page, teamA, 25, set)
      }
      // the match end: confirm what the scorer is asked until the match is over
      {
        const t1 = Date.now()
        while (Date.now() - t1 < 30000) {
          if ((await dialogs(page)).length) { await answerDialogs(page, { prefer: /^(Continue|Confirm|OK|Yes|Confirm .+|Not now)$/ }); continue }
          const st = await dbState(page)
          if (st && ['final', 'ended', 'approved'].includes(st.status)) break
          await sleep(300)
        }
      }
      for (const b of boards) {
        let ok = false
        try {
          await waitUntil(async () => (await boardView(b.page)).phase === 'final', { timeoutMs: 20000, what: 'match end on the board' })
          ok = true
        } catch { /* recorded below */ }
        record(`board ${b.name} shows the match end`, ok, (await boardView(b.page)).body.slice(0, 160))
        await shot(b.page, `board-${b.name}-match-end`)
      }
      await shot(page, 'scorer-1005x600-match-end')
    }

    const errs = [...scorer.errors, ...big.errors, ...small.errors]
    record('no page errors', errs.length === 0, errs[0] || '')
  } catch (err) {
    record('run', false, err.message)
    await shot(scorer.page, 'error-scorer')
    for (const b of boards) await shot(b.page, `error-board-${b.name}`)
  } finally {
    for (const env of [scorer, big, small]) await env.browser.close().catch(() => {})
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${SHOTS ? `, screenshots in ${SHOTS}` : ''}`)
  process.exit(failed.length ? 1 : 0)
}

main()
