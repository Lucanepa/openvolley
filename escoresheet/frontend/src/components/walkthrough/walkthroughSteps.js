// "Your first match": the walkthrough's chapters and steps (owner path
// 24.11.2026: Home, every way to get a roster in, the buttons of Match
// setup, the coin toss, set 1, the set end and the start of set 2, set 5,
// the match end; texts from the approved mockup,
// ~/ov-ops/guides-2611/mockup/build.py). Each step:
//   id        walkthrough.steps.<id>.title / .text
//   chapter   index into CHAPTERS
//   screen    the screen it needs ('home', 'matchSetup', 'rosterEditor',
//             'coinToss', 'scoreboard', 'matchEnd')
//   target    what it points at (targets.js), { tablet, phone } where the
//             phone's scoring screen has its own controls; null: no
//             spotlight, the card alone
//   click     what a click on advances the step (advance 'click'); the target
//   advance   'click' (the scorer taps the target) | 'next' (the card's Next)
//   prepare   brings the app there (walkthroughFlow.js)
//   leave     closes what the step opened, when the walkthrough goes on
//   action    a button on the card: 'fastForward' (Skip to set 5)
import { closeDialogs, resolveTarget, clickTarget, waitForTarget } from './targets'
import { writeDemoUpload } from './demoData'
import { writeDemoLineups } from './fastForward'
import { CHAPTERS } from './walkthroughChapters'
import {
  T, toHome, toSetup, toRosterEditor, toDemoUpload, openPicker, toCoinToss, toScoreboard,
  ensureIdle, ensureInPlay, toSetEnd, toNextSet, toSet5Setup, toCourtSwitch, toMatchEnd, userDialogsDone
} from './walkthroughFlow'

export { CHAPTERS }

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const button = (key, opts) => ({ role: 'button', name: (t) => t(key, opts) })
const startsWith = (key) => ({ role: 'button', name: (t) => new RegExp(`^${esc(t(key))}`) })
const closeAll = () => closeDialogs()

const S = (chapter, id, rest) => ({ chapter, id, advance: 'next', target: null, ...rest })

export const STEPS = [
  // ---- 0 Home -------------------------------------------------------------
  S(0, 'homeNew', {
    screen: 'home',
    target: { any: [{ helpId: 'home-official-button' }, { helpId: 'home-new-match-guest' }, { helpId: 'home-global-match-button' }] },
    prepare: toHome
  }),
  S(0, 'homeTest', { screen: 'home', target: { helpId: 'home-test-button' }, prepare: toHome }),
  S(0, 'homeEasy', { screen: 'home', target: { helpId: 'home-easy-button' }, prepare: toHome }),
  S(0, 'homeRestore', { screen: 'home', target: { helpId: 'home-restore-button' }, prepare: toHome }),
  S(0, 'homeOptions', { screen: 'home', target: { testId: 'home-options' }, prepare: toHome }),
  S(0, 'homeHelp', { screen: 'home', target: { testId: 'header-help' }, prepare: toHome }),

  // ---- 1 Match setup --------------------------------------------------------
  S(1, 'setupTop', { screen: 'matchSetup', target: { testId: 'setup-header-actions' }, prepare: toSetup }),
  S(1, 'setupInfo', { screen: 'matchSetup', target: { helpId: 'setup-match-info-card' }, prepare: toSetup }),
  S(1, 'setupTeams', { screen: 'matchSetup', target: { union: [{ testId: 'setup-team-home' }, { testId: 'setup-team-away' }] }, prepare: toSetup }),
  S(1, 'setupCoinToss', { screen: 'matchSetup', target: { helpId: 'setup-proceed-cointoss' }, prepare: toSetup }),
  S(1, 'setupEditRoster', { screen: 'matchSetup', target: T.editRoster, advance: 'click', prepare: toSetup }),

  // ---- 2 Rosters: every way -------------------------------------------------
  S(2, 'rosterType', { screen: 'rosterEditor', target: { helpId: 'setup-add-player' }, prepare: (ctx) => toRosterEditor(ctx) }),
  S(2, 'rosterPdf', { screen: 'rosterEditor', target: { helpId: 'setup-pdf-import' }, prepare: (ctx) => toRosterEditor(ctx, { mode: 'pdf' }) }),
  S(2, 'rosterRemote', {
    screen: 'rosterEditor',
    target: T.remote,
    advance: 'click',
    prepare: async (ctx) => {
      const m = await toRosterEditor(ctx)
      // the demo upload waits on the server side: Remote shows it
      await writeDemoUpload(m.id, ctx.db)
    }
  }),
  S(2, 'rosterUploaded', {
    screen: 'rosterEditor',
    target: T.pendingCard,
    click: { role: 'button', name: (t) => t('matchSetup.acceptRoster'), within: T.pendingCard },
    advance: 'click',
    prepare: toDemoUpload
  }),
  S(2, 'rosterSaved', { screen: 'rosterEditor', target: { testId: 'load-saved-team-home' }, advance: 'click', prepare: (ctx) => toRosterEditor(ctx) }),
  S(2, 'rosterSavedPick', {
    screen: 'rosterEditor',
    target: { testId: 'saved-team-row', within: T.savedPicker },
    advance: 'click',
    prepare: (ctx) => openPicker(ctx, T.savedPicker, { testId: 'load-saved-team-home' }),
    leave: async () => { if (resolveTarget(T.savedPicker).length) await closeAll() }
  }),
  S(2, 'rosterClub', { screen: 'rosterEditor', target: { testId: 'add-from-club-home' }, advance: 'click', prepare: (ctx) => toRosterEditor(ctx) }),
  S(2, 'rosterClubPick', {
    screen: 'rosterEditor',
    target: T.clubPicker,
    prepare: (ctx) => openPicker(ctx, T.clubPicker, { testId: 'add-from-club-home' }),
    leave: async () => { if (resolveTarget(T.clubPicker).length) await closeAll() }
  }),
  S(2, 'rosterChoose', { screen: 'rosterEditor', target: { testId: 'choose-players-home' }, advance: 'click', prepare: (ctx) => toRosterEditor(ctx) }),
  S(2, 'rosterChooseList', {
    screen: 'rosterEditor',
    target: T.pool,
    prepare: (ctx) => openPicker(ctx, T.pool, { testId: 'choose-players-home' }),
    leave: async () => { if (resolveTarget(T.pool).length) await closeAll() }
  }),
  S(2, 'rosterTest', {
    screen: 'rosterEditor',
    target: { union: [{ testId: 'load-test-roster-home' }, button('roster.deleteRoster')] },
    prepare: (ctx) => toRosterEditor(ctx)
  }),
  S(2, 'rosterMore', { screen: 'rosterEditor', target: null, prepare: (ctx) => toRosterEditor(ctx) }),
  S(2, 'rosterConfirm', { screen: 'rosterEditor', target: T.rosterConfirm, advance: 'click', prepare: (ctx) => toRosterEditor(ctx) }),

  // ---- 3 Coin toss ------------------------------------------------------------
  S(3, 'tossRecord', { screen: 'coinToss', target: { union: [{ helpId: 'cointoss-team-selector' }, { helpId: 'cointoss-serve-selector' }] }, prepare: toCoinToss }),
  S(3, 'tossRoster', { screen: 'coinToss', target: { testId: 'cointoss-roster-a' }, prepare: toCoinToss }),
  S(3, 'tossSign', { screen: 'coinToss', target: { union: [{ testId: 'cointoss-sign-a' }, { testId: 'cointoss-sign-b' }] }, prepare: toCoinToss }),
  S(3, 'tossConfirm', {
    screen: 'coinToss',
    target: { helpId: 'cointoss-confirm-button' },
    click: { selector: '[data-help-id="cointoss-confirm-button"] button' },
    advance: 'click',
    prepare: toCoinToss
  }),

  // ---- 4 Set 1 ----------------------------------------------------------------
  S(4, 'set1Lineups', { screen: 'scoreboard', target: { any: [T.lineupButtons, T.startRally] }, prepare: toScoreboard }),
  S(4, 'set1Start', {
    screen: 'scoreboard',
    target: T.startRally,
    advance: 'click',
    prepare: async (ctx) => {
      // the line-ups the scorer did not enter: demo ones
      const m = await toScoreboard(ctx)
      const sets = await ctx.db.sets.where('matchId').equals(m.id).toArray()
      const open = sets.filter(s => !s.finished).sort((a, b) => a.index - b.index)[0]
      if (open) await writeDemoLineups(ctx.db, m.id, open.index)
      await waitForTarget(T.startRally, ctx, { timeoutMs: 8000 })
      // a rally already in play: its point first
      if (resolveTarget(T.points, ctx).length) await ensureIdle(ctx)
    }
  }),
  S(4, 'set1Point', { screen: 'scoreboard', target: T.points, advance: 'click', prepare: ensureInPlay }),
  S(4, 'set1Requests', {
    screen: 'scoreboard',
    target: {
      tablet: { union: [{ helpId: 'scoreboard-timeout-left' }, { testId: 'sub-box-left' }] },
      phone: { union: [{ testId: 'phone-timeout-left' }, { testId: 'phone-sub-left' }] }
    },
    prepare: ensureIdle
  }),
  S(4, 'set1SubDialog', {
    screen: 'scoreboard',
    target: T.subDialog,
    prepare: async (ctx) => {
      if (resolveTarget(T.subDialog, ctx).length) return
      await ensureIdle(ctx)
      await clickTarget(ctx.phone ? { testId: 'phone-sub-left' } : { testId: 'sub-box-left' }, ctx)
      await waitForTarget(T.subDialog, ctx, { timeoutMs: 6000 })
    },
    leave: async () => { if (resolveTarget(T.subDialog).length) await closeAll() }
  }),
  S(4, 'set1Sanctions', {
    screen: 'scoreboard',
    target: {
      tablet: { union: [button('scoreboard.sanctions.improperRequest'), button('scoreboard.sanctions.delayWarning')] },
      phone: { testId: 'phone-action-sanction' }
    },
    prepare: ensureIdle
  }),
  S(4, 'set1Player', {
    screen: 'scoreboard',
    target: { tablet: { selector: '[data-court-position]' }, phone: { testId: 'phone-court-left' } },
    prepare: ensureIdle
  }),
  S(4, 'set1Decision', {
    screen: 'scoreboard',
    target: {
      tablet: { union: [button('scoreboard.buttons.decisionChange'), { helpId: 'scoreboard-undo' }] },
      phone: { union: [{ testId: 'phone-action-decision' }, button('scoreboard.buttons.undo')] }
    },
    prepare: ensureIdle
  }),
  S(4, 'set1Match', {
    screen: 'scoreboard',
    target: { tablet: startsWith('header.match'), phone: button('scoreboard.menu.menu') },
    prepare: ensureIdle
  }),

  // ---- 5 Set end, start of set 2 ---------------------------------------------
  S(5, 'setEnd', {
    screen: 'scoreboard',
    target: T.setEndDialog,
    click: { role: 'button', name: (t) => t('common.confirm'), within: T.setEndDialog },
    advance: 'click',
    prepare: toSetEnd
  }),
  S(5, 'set2Start', { screen: 'scoreboard', target: { any: [{ union: [T.lineupButtons, T.endInterval] }, T.startRally] }, prepare: toNextSet }),

  // ---- 6 Set 5 ------------------------------------------------------------------
  S(6, 'set5Skip', { screen: 'scoreboard', target: null, action: 'fastForward', prepare: (ctx) => userDialogsDone(ctx) }),
  S(6, 'set5Toss', {
    screen: 'scoreboard',
    target: { union: [T.set5Confirm, { role: 'button', name: (t) => new RegExp(esc(t('scoreboard.buttons.switchSides'))) }, button('scoreboard.buttons.switchServe')] },
    click: T.set5Confirm,
    advance: 'click',
    prepare: toSet5Setup
  }),
  S(6, 'set5Switch', {
    screen: 'scoreboard',
    target: T.courtSwitchDialog,
    click: { ...T.switchCourts, within: T.courtSwitchDialog },
    advance: 'click',
    prepare: toCourtSwitch
  }),

  // ---- 7 Match end --------------------------------------------------------------
  S(7, 'endComplete', { screen: 'matchEnd', target: T.matchEnd, prepare: toMatchEnd }),
  S(7, 'endSignatures', {
    screen: 'matchEnd',
    target: { union: [{ helpId: 'matchend-signatures' }, { testId: 'matchend-technical-remark-add' }] },
    prepare: toMatchEnd
  }),
  S(7, 'endSign', {
    screen: 'matchEnd',
    target: { dialog: { has: 'canvas' } },
    prepare: async (ctx) => {
      if (resolveTarget({ dialog: { has: 'canvas' } }, ctx).length) return
      await toMatchEnd(ctx)
      // the first slot's "Tap to sign" well
      await clickTarget({ selector: '[data-testid^="signature-slot-"] > div.rounded-xl' }, ctx)
      await waitForTarget({ dialog: { has: 'canvas' } }, ctx, { timeoutMs: 6000 })
    },
    leave: async () => { if (resolveTarget({ dialog: { has: 'canvas' } }).length) await closeAll() }
  }),
  S(7, 'endScoresheet', { screen: 'matchEnd', target: { helpId: 'matchend-export-pdf' }, prepare: toMatchEnd })
]

/** The index of a chapter's first step. */
export function firstStepOfChapter(chapter) {
  const i = STEPS.findIndex(s => s.chapter === chapter)
  return i < 0 ? 0 : i
}

/** The steps of a chapter (their indexes in STEPS). */
export function stepsOfChapter(chapter) {
  return STEPS.map((s, i) => (s.chapter === chapter ? i : -1)).filter(i => i >= 0)
}
