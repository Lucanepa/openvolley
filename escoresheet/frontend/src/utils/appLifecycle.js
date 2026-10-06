/**
 * Closing and quitting the scorer app, the right way for where it runs.
 *
 * - tauri (the desktop app's scoretable window): the window's close button
 *   hides the app to the tray, it keeps serving the tablets
 *   (src-tauri/src/lifecycle.rs). The app sends `ov-app-lifecycle` events:
 *   `close-requested` (the first close of a run: say "OpenVolley keeps
 *   running in the tray", then hide) and `quit-requested` (the tray's
 *   "Quit OpenVolley…": take it (`app_quit_ack`), ask, then quit). The page
 *   reports its handler, tray texts, the texts of the app's own native quit
 *   question and whether a match is live (`app_page_state`), and says when
 *   its handler is gone (`app_page_gone`: e.g. it crashed into its error
 *   screen), so the app then asks natively instead of waiting for a page
 *   that no longer answers. The header menu's "Quit OpenVolley…" asks the
 *   same question (requestDesktopQuit). A quit request closes the first-close
 *   notice if it is open.
 * - capacitor (the Android app): the Back button on the app's first page
 *   closes an open dialog first (a confirm is cancelled, a modal gets
 *   Escape / its close button); with none open it asks "Exit OpenVolley?"
 *   (MainActivity calls window.__ovAndroidBack; on Exit the app's own plugin
 *   "OpenVolleyApp" finishes the activity). The in-app view of the
 *   scoresheet keeps its own Back (a history entry, openAppWindow.js), so
 *   Back closes it first.
 * - web (a browser): leaving or reloading the page while a match is live
 *   asks first (beforeunload; the browser shows its own generic text).
 *
 * Every question goes through askConfirm (the in-app dialog), never
 * window.confirm.
 */

import i18n from 'i18next'
import { askConfirm } from './askConfirm.js'
import { getConfirmSnapshot, hasConfirmHost, settleConfirm } from '../ui/uiStore.js'
import { detectAppPlatform, isInAppView } from './openAppWindow.js'
import { isLeavingAllowed, resetLeaveGuardForTests } from './leaveGuard.js'

export { allowLeaving } from './leaveGuard.js'

export const LIFECYCLE_EVENT = 'ov-app-lifecycle'

const t = (key, fallback, opts) => {
  try {
    const s = i18n.t(key, { defaultValue: fallback, ...opts })
    return typeof s === 'string' && s ? s : fallback
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// The match the app is scoring: 'none' | 'official' | 'test'

let live = 'none'
const liveListeners = new Set()

/** 'official' / 'test' for a live match, else 'none'. */
export function liveOf(match) {
  if (!match || match.status !== 'live') return 'none'
  return match.test ? 'test' : 'official'
}

/** The app's live match changed (App.jsx). */
export function setLiveMatch(next) {
  const value = next === 'official' || next === 'test' ? next : 'none'
  if (value === live) return
  live = value
  liveListeners.forEach((l) => l(value))
}

export const getLiveMatch = () => live

/**
 * Follow the live match (e.g. the Android update notice waits for its end).
 * @param {(live: 'none'|'official'|'test') => void} listener
 * @returns {() => void} unsubscribe
 */
export function onLiveMatchChange(listener) {
  liveListeners.add(listener)
  return () => { liveListeners.delete(listener) }
}

// ---------------------------------------------------------------------------
// Questions (plain data, tested)

/**
 * "Quit OpenVolley?" in the desktop app.
 * @param {{ live?: 'none'|'official'|'test', wifi?: boolean, bluetooth?: boolean }} state
 *   wifi / bluetooth: the laptop's own network for the tablets is on (it stops with the app)
 */
export function quitQuestion({ live: liveNow = 'none', wifi = false, bluetooth = false } = {}) {
  const lines = []
  if (liveNow === 'official') {
    lines.push(t('appLifecycle.quitMatchLive', 'A match is in progress. It is saved on this computer: start OpenVolley again and continue it from the home screen.'))
  } else if (liveNow === 'test') {
    lines.push(t('appLifecycle.quitTestMatchLive', 'A test match is in progress. It is saved on this computer: start OpenVolley again and continue it from the home screen.'))
  }
  lines.push(t('appLifecycle.quitTablets', "Tablets on this computer's network will disconnect."))
  if (wifi && bluetooth) lines.push(t('appLifecycle.quitWifiBluetooth', "The laptop's Wi-Fi and Bluetooth network for tablets will stop."))
  else if (wifi) lines.push(t('appLifecycle.quitWifi', "The laptop's Wi-Fi for tablets will stop."))
  else if (bluetooth) lines.push(t('appLifecycle.quitBluetooth', "The laptop's Bluetooth network for tablets will stop."))
  const title = liveNow === 'official'
    ? t('appLifecycle.quitTitleMatch', 'Quit OpenVolley during the match?')
    : liveNow === 'test'
      ? t('appLifecycle.quitTitleTestMatch', 'Quit OpenVolley during the test match?')
      : t('appLifecycle.quitTitle', 'Quit OpenVolley?')
  return {
    title,
    message: lines.join('\n\n'),
    confirmLabel: t('appLifecycle.quitConfirm', 'Quit OpenVolley'),
    cancelLabel: t('appLifecycle.keepRunning', 'Keep running'),
    tone: 'danger',
  }
}

/** The first close of the desktop window: it keeps running (tray, or minimised). */
export function closeNotice({ tray = true } = {}) {
  return tray
    ? {
        title: t('appLifecycle.closeNoticeTitle', 'OpenVolley keeps running in the tray'),
        message: t('appLifecycle.closeNoticeBody', 'So tablets stay connected. Open it again from the OpenVolley icon in the tray. To quit, choose "Quit OpenVolley…" in its menu.'),
        confirmLabel: t('appLifecycle.closeNoticeHide', 'Hide window'),
        cancelLabel: t('appLifecycle.closeNoticeKeep', 'Keep open'),
      }
    : {
        title: t('appLifecycle.closeNoticeTitleNoTray', 'OpenVolley keeps running'),
        message: t('appLifecycle.closeNoticeBodyNoTray', 'So tablets stay connected, the window is minimised. To quit, choose "Quit OpenVolley…" in the menu at the top right.'),
        confirmLabel: t('appLifecycle.closeNoticeMinimise', 'Minimise window'),
        cancelLabel: t('appLifecycle.closeNoticeKeep', 'Keep open'),
      }
}

/** "Exit OpenVolley?" on Android's Back button. */
export function exitQuestion({ live: liveNow = 'none' } = {}) {
  const inMatch = liveNow !== 'none'
  return {
    title: inMatch
      ? t('appLifecycle.exitTitleMatch', 'Exit OpenVolley during the match?')
      : t('appLifecycle.exitTitle', 'Exit OpenVolley?'),
    message: inMatch
      ? t('appLifecycle.exitMatchBody', 'The match is saved on this device: open OpenVolley again to continue it.')
      : undefined,
    confirmLabel: t('appLifecycle.exitConfirm', 'Exit'),
    cancelLabel: t('appLifecycle.stay', 'Stay'),
    tone: inMatch ? 'danger' : 'default',
  }
}

/** The tray's texts and the app's native quit question, in the page's
 *  language (Rust falls back to English). The native question is the app's
 *  own fallback when the page cannot ask (lifecycle.rs). */
export function trayLabels() {
  // {{count}} stays in the text: the app fills it in (lifecycle.rs)
  const tablets = t('appLifecycle.trayTablets', '{{count}} tablets connected', { count: '{{count}}' })
  return {
    tooltip: t('appLifecycle.trayTooltip', 'OpenVolley eScoresheet'),
    show: t('appLifecycle.trayShow', 'Show OpenVolley'),
    quit: t('appLifecycle.trayQuit', 'Quit OpenVolley…'),
    noTablets: t('appLifecycle.trayNoTablets', 'No tablets connected'),
    oneTablet: t('appLifecycle.trayOneTablet', '1 tablet connected'),
    tablets: tablets.includes('{{count}}') ? tablets : '{{count}} tablets connected',
    matchLive: t('appLifecycle.trayMatchLive', 'Match in progress'),
    testMatchLive: t('appLifecycle.trayTestMatchLive', 'Test match in progress'),
    quitTitle: t('appLifecycle.quitTitle', 'Quit OpenVolley?'),
    quitTitleMatch: t('appLifecycle.quitTitleMatch', 'Quit OpenVolley during the match?'),
    quitTitleTestMatch: t('appLifecycle.quitTitleTestMatch', 'Quit OpenVolley during the test match?'),
    quitBody: t('appLifecycle.quitTablets', "Tablets on this computer's network will disconnect."),
    quitMatchBody: t('appLifecycle.quitMatchLive', 'A match is in progress. It is saved on this computer: start OpenVolley again and continue it from the home screen.'),
    quitTestMatchBody: t('appLifecycle.quitTestMatchLive', 'A test match is in progress. It is saved on this computer: start OpenVolley again and continue it from the home screen.'),
    quitConfirm: t('appLifecycle.quitConfirm', 'Quit OpenVolley'),
    keepRunning: t('appLifecycle.keepRunning', 'Keep running'),
  }
}

// ---------------------------------------------------------------------------
// Desktop app (Tauri)

function tauriInvoke(win) {
  try {
    const internals = win?.__TAURI_INTERNALS__
    return typeof internals?.invoke === 'function' ? internals.invoke.bind(internals) : null
  } catch {
    return null
  }
}

/** The desktop app's scoretable window (not a scoresheet window, not a browser). */
export function isDesktopScoretable(win = typeof window !== 'undefined' ? window : undefined) {
  if (!tauriInvoke(win)) return false
  const label = win.__TAURI_INTERNALS__?.metadata?.currentWindow?.label
  return !label || label === 'main'
}

let desktopWin = null
let tray = true
// The quit question and the first-close notice are separate: a quit request
// while the notice is open replaces the notice (noticeAbort).
let quitAsking = false
let noticeAbort = null
let handlerSeq = 0

/** A promise that settles within `ms` (a stuck command must not hold the dialog). */
function within(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

/** Whether the laptop's own Wi-Fi / Bluetooth for the tablets is on (stops with the app). */
async function laptopNetworks(invoke) {
  const [wifi, bt] = await Promise.all([
    within(invoke('hotspot_status'), 1500, null),
    within(invoke('bluetooth_status'), 1500, null),
  ])
  // a hotspot switched on outside the app (external) is not stopped by it
  return { wifi: !!(wifi?.active && !wifi?.external), bluetooth: !!(bt?.active && !bt?.external) }
}

/** Tell the app this page took its quit request (its question is on screen);
 *  without it the app asks natively after a few seconds (lifecycle.rs). */
function ackQuit(invoke) {
  Promise.resolve(invoke('app_quit_ack')).catch((e) => console.warn('[app] app_quit_ack failed', e))
}

/** The in-app dialog can show: a <UiHost /> is mounted. An injected `ask`
 *  (tests) is taken as able to. */
const defaultCanAsk = (ask) => (ask === askConfirm ? hasConfirmHost() : true)

/**
 * Ask "Quit OpenVolley?" and quit on confirm. The header menu's "Quit
 * OpenVolley…" and the tray's (through `quit-requested`) both end here.
 * @returns {Promise<boolean>} true when the app is quitting
 */
export async function requestDesktopQuit(win = desktopWin || window, ask = askConfirm, { canAsk = defaultCanAsk } = {}) {
  const invoke = tauriInvoke(win)
  if (!invoke) return false
  // No dialog host (the page crashed into its error screen): do not take the
  // request; the app asks natively.
  if (!canAsk(ask)) return false
  // Taken: the question is (or already was) on screen.
  ackQuit(invoke)
  if (quitAsking) return false
  quitAsking = true
  // The first-close notice gives way to the quit question.
  noticeAbort?.abort()
  try {
    const nets = await laptopNetworks(invoke)
    if (!(await ask(quitQuestion({ live, ...nets })))) return false
    await invoke('app_quit')
    return true
  } catch (e) {
    console.error('[app] quit failed', e)
    return false
  } finally {
    quitAsking = false
  }
}

async function showCloseNotice(win, ask) {
  const invoke = tauriInvoke(win)
  if (!invoke || quitAsking || noticeAbort) return
  const controller = new AbortController()
  noticeAbort = controller
  try {
    const hide = await ask({ ...closeNotice({ tray }), signal: controller.signal })
    if (hide && !controller.signal.aborted) await invoke('app_hide')
  } catch (e) {
    console.error('[app] hide failed', e)
  } finally {
    if (noticeAbort === controller) noticeAbort = null
  }
}

function installDesktop(win, ask) {
  const invoke = tauriInvoke(win)
  desktopWin = win
  // This install's handler: the app forgets it on app_page_gone, and a late
  // report of an uninstalled one (StrictMode, remounts) cannot revive it.
  const handler = `${Date.now().toString(36)}-${++handlerSeq}`
  const report = () => {
    Promise.resolve(invoke('app_page_state', { handler, labels: trayLabels(), live }))
      .then((info) => { if (info && typeof info.tray === 'boolean') tray = info.tray })
      .catch((e) => console.warn('[app] app_page_state failed', e))
  }
  const onEvent = (event) => {
    const type = event?.detail?.type
    if (type === 'close-requested') showCloseNotice(win, ask)
    else if (type === 'quit-requested') requestDesktopQuit(win, ask)
  }
  win.addEventListener(LIFECYCLE_EVENT, onEvent)
  liveListeners.add(report)
  // A language's texts load after the switch (i18n/index.js): report again
  // once they are there, or the tray keeps the fallback (English) ones.
  i18n.on?.('languageChanged', report)
  i18n.store?.on?.('added', report)
  report()
  return () => {
    win.removeEventListener(LIFECYCLE_EVENT, onEvent)
    liveListeners.delete(report)
    i18n.off?.('languageChanged', report)
    i18n.store?.off?.('added', report)
    if (desktopWin === win) desktopWin = null
    // e.g. the page crashed into its error screen: nothing here answers
    // "close" / "quit" any more, so the app must not wait for it
    Promise.resolve(invoke('app_page_gone', { handler })).catch((e) => console.warn('[app] app_page_gone failed', e))
  }
}

// ---------------------------------------------------------------------------
// Android app (Capacitor)

/** The app's own native plugin (android/.../AppExitPlugin.java). */
let exitPlugin = null
function androidExit(win) {
  const cap = win.Capacitor
  if (!exitPlugin && typeof cap?.registerPlugin === 'function') exitPlugin = cap.registerPlugin('OpenVolleyApp')
  return exitPlugin?.exitApp?.()
}

/**
 * Back while a dialog is open closes that dialog, like Back does anywhere on
 * Android. Returns true when there was one (Back then never asks to exit):
 * - an in-app confirm (askConfirm; also "Exit OpenVolley?" itself): cancelled;
 * - a modal: Escape (kit modals close on it), or its close button for the
 *   legacy modals that have one (data-modal-close). A decision modal without
 *   one stays: it needs an answer.
 */
function closeOpenDialog(win) {
  const confirm = getConfirmSnapshot()
  if (confirm) {
    settleConfirm(confirm.id, false)
    return true
  }
  const doc = win.document
  const modals = doc?.querySelectorAll?.('[aria-modal="true"]')
  if (!modals || modals.length === 0) return false
  const modal = modals[modals.length - 1]
  const close = modal.querySelector?.('[data-modal-close]')
  if (close) {
    close.click()
    return true
  }
  const active = doc.activeElement
  const target = active && modal.contains?.(active) ? active : modal
  const KeyboardEventCtor = win.KeyboardEvent || globalThis.KeyboardEvent
  target.dispatchEvent(new KeyboardEventCtor('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
  return true
}

function installAndroid(win, ask) {
  let open = false
  // MainActivity: Back with no page to go back to. Returns true when handled
  // (the app then neither exits nor goes to the background by itself).
  win.__ovAndroidBack = () => {
    if (closeOpenDialog(win)) return true
    if (open) return true // a second Back while it asks: keep asking
    open = true
    Promise.resolve(ask(exitQuestion({ live })))
      .then((ok) => (ok ? androidExit(win) : undefined))
      .catch((e) => console.error('[app] exit failed', e))
      .finally(() => { open = false })
    return true
  }
  return () => { delete win.__ovAndroidBack }
}

// ---------------------------------------------------------------------------
// Browser

function installWeb(win) {
  const onBeforeUnload = (event) => {
    if (live === 'none' || isLeavingAllowed()) return undefined
    event.preventDefault()
    // older browsers need returnValue; the text is the browser's own
    event.returnValue = ''
    return ''
  }
  win.addEventListener('beforeunload', onBeforeUnload)
  return () => win.removeEventListener('beforeunload', onBeforeUnload)
}

// ---------------------------------------------------------------------------

/**
 * Install the close / quit handling for this window (App.jsx, once).
 * @returns {() => void} uninstall
 */
export function installAppLifecycle({ win = window, ask = askConfirm } = {}) {
  if (!win || isInAppView(win)) return () => {}
  const platform = detectAppPlatform(win)
  if (platform === 'tauri') return isDesktopScoretable(win) ? installDesktop(win, ask) : () => {}
  if (platform === 'capacitor') return installAndroid(win, ask)
  // Electron (the alternative desktop build) closes its window without a
  // prompt on a beforeunload that cancels: no guard there
  if (win.electronAPI) return () => {}
  return installWeb(win)
}

/** Tests: back to the initial state. */
export function resetAppLifecycleForTests() {
  live = 'none'
  liveListeners.clear()
  desktopWin = null
  tray = true
  quitAsking = false
  noticeAbort = null
  exitPlugin = null
  resetLeaveGuardForTests()
}
