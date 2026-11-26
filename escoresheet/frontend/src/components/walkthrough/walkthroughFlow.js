// How the walkthrough brings the app to the screen a step needs (each
// step's prepare, walkthroughSteps.js). It does what a scorer would do, with
// the app's own buttons, and writes demo rallies only where the owner chose
// to skip play (fastForward.js). Everything happens on the walkthrough's test
// match: a new one when it has none (Home's Test match), never another match.
//
// The engine passes `ctx`:
//   t, db, phone (the phone scoring layout), page() (App's screen name),
//   matchId() (the open match), walkthroughMatchId() / rememberMatch(id),
//   goHome(), createTestMatch(), showSetup(id), showScoreboard(id),
//   restoreTestRosters(id), waiting(reason|null) (the card says why it waits)
import { resolveTarget, waitForTarget, waitUntil, clickTarget, closeDialogs, openDialogs, sleep } from './targets'
import { demoMatch, seedDemoClub, writeDemoUpload } from './demoData'
import { writeDemoLineups, writeDemoRallies, balancingWinner, setWonOnScore } from './fastForward'
import { isFirstRallyOf, rallyStatusOf, startingLineupsIn } from '../../domain/rally'

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---- targets several steps share -------------------------------------------
export const T = {
  editRoster: { testId: 'edit-roster-home' },
  rosterEditor: { testId: 'choose-players-home' },
  rosterBack: { testId: 'roster-back-home' },
  rosterConfirm: { testId: 'roster-confirm-home' },
  remote: { role: 'radio', name: (t) => t('matchSetup.remote') },
  local: { role: 'radio', name: (t) => t('matchSetup.local') },
  pendingCard: { testId: 'pending-roster-home' },
  savedPicker: { dialog: { has: '[data-testid="saved-team-results"]' } },
  clubPicker: { dialog: { has: '[data-testid="club-picker"]' } },
  pool: { dialog: { has: '[data-testid="player-pool-apply"]' } },
  coinTossButton: { helpId: 'setup-proceed-cointoss' },
  coinTossConfirm: { helpId: 'cointoss-confirm-button' },
  proceedAnyway: { role: 'button', name: (t) => t('coinToss.proceedAnyway') },
  startRally: { helpId: 'scoreboard-start-rally' },
  points: { union: [{ helpId: 'scoreboard-point-left' }, { helpId: 'scoreboard-point-right' }] },
  lineupButtons: { union: [
    { role: 'button', name: (t) => new RegExp(`^${esc(t('scoreboard.lineup'))}\\s*A\\b`) },
    { role: 'button', name: (t) => new RegExp(`^${esc(t('scoreboard.lineup'))}\\s*B\\b`) }
  ] },
  startTimeDialog: { dialog: { title: (t) => new RegExp(`^${esc(t('scoreboard.dialogs.setStartTime', { set: '__N__' })).replace('__N__', '\\d')}$`) } },
  setEndDialog: { dialog: { has: '.set-end-readout' } },
  liberoReminder: { dialog: { title: (t) => t('scoreboard.modals.liberoReminder') } },
  endInterval: { role: 'button', name: (t) => t('scoreboard.buttons.endSetInterval') },
  set5Confirm: { role: 'button', name: (t) => t('scoreboard.buttons.confirmSet5Setup', { number: 5 }) },
  courtSwitchDialog: { dialog: { title: (t) => t('scoreboard.modals.courtSwitchRequired') } },
  switchCourts: { role: 'button', name: (t) => t('scoreboard.buttons.switchCourts') },
  subDialog: { dialog: { has: '[data-testid="sub-dialog"]' } },
  matchEnd: { helpId: 'matchend-results-table' }
}

const confirmIn = (dialog) => ({ role: 'button', name: (t) => t('common.confirm'), within: dialog })

// ---- waiting for the scorer -----------------------------------------------
/**
 * While a dialog the scorer opened is open (the replace question after
 * Accept, the coin toss's connection checks ...), the next screen waits for
 * the answer: the card says so (ctx.waiting). `expected` dialogs (a spec)
 * do not count. After `timeoutMs` the dialogs are closed.
 */
export async function userDialogsDone(ctx, { expected = null, timeoutMs = 120000 } = {}) {
  const foreign = () => {
    const keep = expected ? resolveTarget(expected, ctx) : []
    return openDialogs().filter(d => !keep.some(k => k === d || d.contains(k) || k.contains(d)))
  }
  if (!foreign().length) return
  ctx.waiting?.('dialog')
  try {
    const done = await waitUntil(() => foreign().length === 0, { timeoutMs, everyMs: 250 })
    if (!done) await closeDialogs({ keep: (d) => !foreign().includes(d) })
  } finally {
    ctx.waiting?.(null)
  }
}

async function onPage(ctx, page, timeoutMs = 15000) {
  return !!(await waitUntil(() => ctx.page() === page, { timeoutMs }))
}

// ---- the test match ---------------------------------------------------------
async function walkthroughMatch(ctx) {
  const m = await demoMatch(ctx.walkthroughMatchId(), ctx.db)
  return m && m.status !== 'final' ? m : null
}

/**
 * The walkthrough's test match (a new one when there is none, or when the
 * steps need one before its coin toss and it is past it).
 */
export async function ensureTestMatch(ctx, { beforeCoinToss = false } = {}) {
  let m = await walkthroughMatch(ctx)
  if (!m) {
    // a test match the scorer opened meanwhile (Home's Test match): that one
    const open = await demoMatch(ctx.matchId(), ctx.db)
    if (open && open.status !== 'final') {
      m = open
      ctx.rememberMatch(open.id)
    }
  }
  if (m && beforeCoinToss && m.coinTossConfirmed === true) m = null
  if (m) return m
  await closeDialogs()
  ctx.goHome()
  if (!(await waitForTarget({ helpId: 'home-test-button' }, ctx, { timeoutMs: 20000 }))) throw new Error('home')
  const before = ctx.matchId()
  ctx.waiting?.('preparing')
  try {
    await ctx.createTestMatch()
    // a question first (an official match is recording): the scorer answers
    const id = await waitUntil(async () => {
      const open = ctx.matchId()
      if (open == null || open === before) return null
      return (await demoMatch(open, ctx.db)) ? open : null
    }, { timeoutMs: 120000, everyMs: 200 })
    if (id == null) throw new Error('test match')
    ctx.rememberMatch(id)
    return demoMatch(id, ctx.db)
  } finally {
    ctx.waiting?.(null)
  }
}

// ---- screens ----------------------------------------------------------------
export async function toHome(ctx) {
  await userDialogsDone(ctx)
  if (ctx.page() !== 'home') ctx.goHome()
  await waitForTarget({ helpId: 'home-restore-button' }, ctx, { timeoutMs: 20000 })
}

/** Match setup's main view of the test match (before its coin toss). */
export async function toSetup(ctx) {
  await userDialogsDone(ctx)
  const m = await ensureTestMatch(ctx, { beforeCoinToss: true })
  if (ctx.matchId() !== m.id || ctx.page() !== 'matchSetup') {
    await ctx.showSetup(m.id)
    await onPage(ctx, 'matchSetup')
  }
  // in the roster editor: Back (the main view)
  if (resolveTarget(T.rosterEditor, ctx).length) await clickTarget(T.rosterBack, ctx)
  await waitForTarget(T.editRoster, ctx, { timeoutMs: 15000 })
  return m
}

/** The home team's roster editor, Local, with the demo club list on the device. */
export async function toRosterEditor(ctx, { mode = 'local' } = {}) {
  await userDialogsDone(ctx)
  let m = await walkthroughMatch(ctx)
  if (!m || m.coinTossConfirmed === true || ctx.page() !== 'matchSetup' || !resolveTarget(T.rosterEditor, ctx).length) {
    m = await toSetup(ctx)
    await clickTarget(T.editRoster, ctx)
    await waitForTarget(T.rosterEditor, ctx, { timeoutMs: 15000 })
  }
  await seedDemoClub(m.id, ctx.db)
  const want = mode === 'remote' ? T.remote : T.local
  const radio = resolveTarget(want, ctx)[0]
  if (radio && radio.getAttribute('aria-checked') !== 'true') {
    radio.click()
    await sleep(200)
  }
  return m
}

/** The Remote panel with the demo "Roster uploaded" card. */
export async function toDemoUpload(ctx) {
  const m = await toRosterEditor(ctx, { mode: 'remote' })
  await writeDemoUpload(m.id, ctx.db)
  await waitForTarget(T.pendingCard, ctx, { timeoutMs: 8000 })
}

/** A picker of the roster editor open (its button clicked when it is not). */
export async function openPicker(ctx, picker, button) {
  if (resolveTarget(picker, ctx).length) return
  await toRosterEditor(ctx)
  await clickTarget(button, ctx)
  await waitForTarget(picker, ctx, { timeoutMs: 8000 })
}

async function coinTossButton(ctx) {
  const wrap = resolveTarget(T.coinTossButton, ctx)[0]
  return wrap ? (wrap.matches('button') ? wrap : wrap.querySelector('button')) : null
}

/** The coin toss of the test match (a test roster again when Match setup is not complete). */
export async function toCoinToss(ctx) {
  await userDialogsDone(ctx)
  if (ctx.page() === 'coinToss' && resolveTarget(T.coinTossConfirm, ctx).length) {
    const m = await walkthroughMatch(ctx)
    if (m && m.coinTossConfirmed !== true) return m
  }
  let m = await toSetup(ctx)
  let button = await waitUntil(() => coinTossButton(ctx), { timeoutMs: 8000 })
  if (!button || button.disabled) {
    // e.g. players saved without a number: the test rosters again
    await ctx.restoreTestRosters(m.id)
    m = await toSetup(ctx)
    button = await waitUntil(async () => { const b = await coinTossButton(ctx); return b && !b.disabled ? b : null }, { timeoutMs: 10000 })
  }
  if (!button || button.disabled) throw new Error('coin toss')
  button.click()
  await waitForTarget(T.coinTossConfirm, ctx, { timeoutMs: 15000 })
  return m
}

/** The scoring screen of the test match: its coin toss confirmed (the app's connection checks passed). */
export async function toScoreboard(ctx) {
  await userDialogsDone(ctx)
  let m = await walkthroughMatch(ctx)
  if (!m || m.coinTossConfirmed !== true) {
    m = await toCoinToss(ctx)
    await clickTarget({ selector: '[data-help-id="cointoss-confirm-button"] button' }, ctx)
    // the connection checks (Proceed anyway), then the scoring screen; once
    // the toss is stored, the screen is opened when it does not come by itself
    let storedAt = null
    const there = await waitUntil(async () => {
      if (resolveTarget(T.proceedAnyway, ctx).length) await clickTarget(T.proceedAnyway, ctx, { timeoutMs: 500 })
      if (ctx.page() === 'scoreboard') return true
      const now = await walkthroughMatch(ctx)
      if (now?.coinTossConfirmed === true) {
        storedAt = storedAt || Date.now()
        if (Date.now() - storedAt > 8000 && !openDialogs().length) {
          await ctx.showScoreboard(now.id)
          return onPage(ctx, 'scoreboard', 10000)
        }
      }
      return false
    }, { timeoutMs: 90000, everyMs: 300 })
    if (!there) throw new Error('scoreboard')
    m = await walkthroughMatch(ctx)
  } else if (ctx.page() !== 'scoreboard' || ctx.matchId() !== m.id) {
    if (ctx.page() === 'matchEnd') throw new Error('match over')
    await ctx.showScoreboard(m.id)
    await onPage(ctx, 'scoreboard')
  }
  await waitUntil(() => resolveTarget({ any: [T.startRally, T.points, T.lineupButtons, T.set5Confirm, T.setEndDialog] }, ctx).length > 0, { timeoutMs: 15000 })
  return m
}

async function currentSet(ctx, matchId) {
  const sets = await ctx.db.sets.where('matchId').equals(matchId).toArray()
  const open = sets.filter(s => !s.finished).sort((a, b) => a.index - b.index)[0] || null
  return { sets, open }
}

async function eventsOf(ctx, matchId) {
  return ctx.db.events.where('matchId').equals(matchId).toArray()
}

/**
 * The set's start after Start set: the libero reminder first when it comes
 * (Proceed), then the start-time dialog confirmed (a reason typed in when it
 * asks for one).
 */
async function confirmStartTime(ctx) {
  const dialog = await waitUntil(async () => {
    if (resolveTarget(T.liberoReminder, ctx).length) {
      await clickTarget({ role: 'button', name: (t) => t('scoreboard.sync.proceed'), within: T.liberoReminder }, ctx, { timeoutMs: 1000 })
      return null
    }
    return resolveTarget(T.startTimeDialog, ctx)[0] || null
  }, { timeoutMs: 8000, everyMs: 150 })
  if (!dialog) return false
  const reason = dialog.querySelector('#set-start-reason')
  if (reason && !reason.value) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(reason), 'value')?.set
    setter?.call(reason, ctx.t('walkthrough.demoReason'))
    reason.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(150)
  }
  return clickTarget(confirmIn(T.startTimeDialog), ctx)
}

/** The set being played has both line-ups (demo ones when missing) and has started. */
export async function ensureSetStarted(ctx) {
  const m = await toScoreboard(ctx)
  const { open } = await currentSet(ctx, m.id)
  if (!open) return m
  let events = await eventsOf(ctx, m.id)
  if (!startingLineupsIn(events, open.index)) {
    await writeDemoLineups(ctx.db, m.id, open.index)
    await waitUntil(() => !resolveTarget(T.lineupButtons, ctx).length, { timeoutMs: 6000 })
  }
  events = await eventsOf(ctx, m.id)
  if (isFirstRallyOf(events, open.index)) {
    await clickTarget(T.startRally, ctx)
    await confirmStartTime(ctx)
    await waitUntil(async () => !isFirstRallyOf(await eventsOf(ctx, m.id), open.index), { timeoutMs: 8000 })
  }
  return m
}

/** Between rallies: a rally in play gets its point (team A's side, left). */
export async function ensureIdle(ctx) {
  const m = await ensureSetStarted(ctx)
  const { open } = await currentSet(ctx, m.id)
  if (open && rallyStatusOf(await eventsOf(ctx, m.id), open.index) === 'in_play') {
    await clickTarget({ helpId: 'scoreboard-point-left' }, ctx)
    await waitForTarget(T.startRally, ctx, { timeoutMs: 6000 })
  }
  return m
}

/**
 * A rally in play (Start rally pressed; at the set's first rally, Start set).
 * The scoring screen drops a tap that follows another one too closely (its
 * double-tap guard): tapped again until the rally runs.
 */
export async function ensureInPlay(ctx) {
  const m = await ensureSetStarted(ctx)
  const { open } = await currentSet(ctx, m.id)
  for (let i = 0; open && i < 5; i++) {
    if (rallyStatusOf(await eventsOf(ctx, m.id), open.index) === 'in_play') break
    await clickTarget(T.startRally, ctx)
    if (await waitForTarget(T.points, ctx, { timeoutMs: 1500 })) break
  }
  return m
}

/** The set being played is won on the score: its set-end dialog is open. */
export async function toSetEnd(ctx) {
  await userDialogsDone(ctx, { expected: T.setEndDialog })
  if (resolveTarget(T.setEndDialog, ctx).length) return
  const m = await ensureIdle(ctx)
  const { sets, open } = await currentSet(ctx, m.id)
  if (!open) return
  if (!setWonOnScore(open, m, sets)) {
    // the deciding set (or a set past the 2:2) goes to the team ahead
    const leader = (open.awayPoints || 0) > (open.homePoints || 0) ? 'away' : 'home'
    const winner = (open.index < 5 && balancingWinner(sets, m)) || leader
    await writeDemoRallies(ctx.db, m.id, { setIndex: open.index, winner })
  }
  await waitForTarget(T.setEndDialog, ctx, { timeoutMs: 15000 })
}

/** The set end confirmed (the app's own: set end, interval, next set). */
export async function confirmSetEnd(ctx) {
  if (!resolveTarget(T.setEndDialog, ctx).length) return false
  // tapped again when the screen dropped the tap (its guard against a double tap)
  for (let i = 0; i < 4; i++) {
    await clickTarget(confirmIn(T.setEndDialog), ctx, { timeoutMs: 3000 })
    if (await waitUntil(() => !resolveTarget(T.setEndDialog, ctx).length, { timeoutMs: i < 3 ? 4000 : 15000 })) break
  }
  return true
}

/** The next set's start (the set end confirmed when it is still asked). */
export async function toNextSet(ctx) {
  await userDialogsDone(ctx, { expected: T.setEndDialog })
  if (!(await confirmSetEnd(ctx))) await toScoreboard(ctx)
  await waitUntil(() => resolveTarget({ any: [T.lineupButtons, T.startRally, T.endInterval] }, ctx).length > 0, { timeoutMs: 15000 })
}

/**
 * "Skip to set 5": demo sets until 2:2, each set end confirmed on the
 * screen; stops at the deciding set's coin toss (its setup on screen).
 * `onSet(n)` says which set is being filled.
 */
export async function fastForwardToSet5(ctx, { onSet = null } = {}) {
  await userDialogsDone(ctx, { expected: T.setEndDialog })
  let m = await toScoreboard(ctx)
  for (let guard = 0; guard < 16; guard++) {
    if (await confirmSetEnd(ctx)) { await sleep(400); continue }
    const { sets, open } = await currentSet(ctx, m.id)
    m = (await walkthroughMatch(ctx)) || m
    const winner = balancingWinner(sets, m)
    if (!open || open.index >= 5 || !winner) {
      // the deciding set's setup (or the match is decided already)
      await waitUntil(() => resolveTarget({ any: [T.set5Confirm, T.startRally, T.lineupButtons] }, ctx).length > 0, { timeoutMs: 15000 })
      return true
    }
    onSet?.(open.index)
    // the interval's countdown ends by hand (Start set would end it too)
    if (resolveTarget(T.endInterval, ctx).length) await clickTarget(T.endInterval, ctx, { timeoutMs: 1000 })
    const events = await eventsOf(ctx, m.id)
    if (!startingLineupsIn(events, open.index)) await writeDemoLineups(ctx.db, m.id, open.index)
    if (!setWonOnScore(open, m, sets)) await writeDemoRallies(ctx.db, m.id, { setIndex: open.index, winner })
    await waitForTarget(T.setEndDialog, ctx, { timeoutMs: 20000 })
  }
  return false
}

/** The deciding set's coin toss on screen. */
export async function toSet5Setup(ctx) {
  await userDialogsDone(ctx, { expected: T.setEndDialog })
  if (resolveTarget(T.set5Confirm, ctx).length) return
  const m = await walkthroughMatch(ctx)
  const { open } = m ? await currentSet(ctx, m.id) : { open: null }
  if (open && open.index === 5) return
  await fastForwardToSet5(ctx)
}

/** Set 5 with the leader on 7, between rallies (the setup confirmed, line-ups in). */
async function toSet5AtSeven(ctx) {
  await toSet5Setup(ctx)
  if (resolveTarget(T.set5Confirm, ctx).length) {
    await clickTarget(T.set5Confirm, ctx)
    await waitUntil(() => !resolveTarget(T.set5Confirm, ctx).length, { timeoutMs: 8000 })
  }
  const m = await ensureIdle(ctx)
  const { open } = await currentSet(ctx, m.id)
  if (!open || open.index !== 5) return m
  if (Math.max(open.homePoints || 0, open.awayPoints || 0) < 7) {
    const leader = (open.awayPoints || 0) > (open.homePoints || 0) ? 'away' : 'home'
    await writeDemoRallies(ctx.db, m.id, { setIndex: 5, winner: leader, stopAtLeader: 7 })
    await sleep(300)
  }
  return m
}

const scoreOf = (ctx, side) => {
  const el = resolveTarget(ctx.phone ? { testId: `phone-score-${side}` } : { testId: `score-${side}` }, ctx)[0]
  return el ? Number(String(el.textContent || '').replace(/\D+/g, '')) : NaN
}

/** The change of courts at 8: the leader's eighth point played on the screen, its dialog open. */
export async function toCourtSwitch(ctx) {
  await userDialogsDone(ctx, { expected: T.courtSwitchDialog })
  if (resolveTarget(T.courtSwitchDialog, ctx).length) return
  const m = await toSet5AtSeven(ctx)
  const { open } = await currentSet(ctx, m.id)
  if (!open || open.index !== 5 || m.set5CourtSwitched) return
  if (Math.max(open.homePoints || 0, open.awayPoints || 0) >= 8) return
  // the leader's eighth point, tapped on the screen (again when the tap guard dropped it)
  for (let i = 0; i < 5; i++) {
    await ensureInPlay(ctx)
    const side = scoreOf(ctx, 'right') > scoreOf(ctx, 'left') ? 'right' : 'left'
    await clickTarget({ helpId: `scoreboard-point-${side}` }, ctx, { timeoutMs: 3000 })
    if (await waitForTarget(T.courtSwitchDialog, ctx, { timeoutMs: 2500 })) return
    const now = (await currentSet(ctx, m.id)).open
    if (!now || Math.max(now.homePoints || 0, now.awayPoints || 0) >= 8) break
  }
  await waitForTarget(T.courtSwitchDialog, ctx, { timeoutMs: 5000 })
}

/** Match End: the deciding set played to its end, the match end confirmed. */
export async function toMatchEnd(ctx) {
  await userDialogsDone(ctx, { expected: { any: [T.courtSwitchDialog, T.setEndDialog] } })
  if (ctx.page() === 'matchEnd') return
  const m = await walkthroughMatch(ctx)
  if (m && m.status !== 'live') {
    // ended earlier: Match End again
    await ctx.showScoreboard(m.id)
  }
  if (resolveTarget(T.courtSwitchDialog, ctx).length) {
    await clickTarget(T.switchCourts, ctx)
    await waitUntil(() => !resolveTarget(T.courtSwitchDialog, ctx).length, { timeoutMs: 8000 })
  }
  if (!resolveTarget(T.setEndDialog, ctx).length) {
    const fresh = await walkthroughMatch(ctx)
    const { open } = fresh ? await currentSet(ctx, fresh.id) : { open: null }
    if (open && open.index === 5 && !fresh.set5CourtSwitched && Math.max(open.homePoints || 0, open.awayPoints || 0) < 8) {
      await toCourtSwitch(ctx)
      if (resolveTarget(T.courtSwitchDialog, ctx).length) {
        await clickTarget(T.switchCourts, ctx)
        await waitUntil(() => !resolveTarget(T.courtSwitchDialog, ctx).length, { timeoutMs: 8000 })
      }
    }
    await toSetEnd(ctx)
  }
  await confirmSetEnd(ctx)
  await waitForTarget(T.matchEnd, ctx, { timeoutMs: 60000 })
}
