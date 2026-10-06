/**
 * Closing and quitting the scorer app, the right way for where it runs.
 *
 * - tauri (the desktop app's scoretable window): the window's close button
 *   hides the app to the tray, it keeps serving the tablets
 *   (src-tauri/src/lifecycle.rs). The app sends `ov-app-lifecycle` events:
 *   `close-requested` (the first close of a run: say "OpenVolley keeps
 *   running in the tray", then hide) and `quit-requested` (the tray's
 *   "Quit OpenVolley…": ask, then quit). The page reports its tray texts and
 *   whether a match is live (`app_page_state`). The header menu's "Quit
 *   OpenVolley…" asks the same question (requestDesktopQuit).
 * - capacitor (the Android app): the Back button on the app's first page
 *   asks "Exit OpenVolley?" (MainActivity calls window.__ovAndroidBack; on
 *   Exit the app's own plugin "OpenVolleyApp" finishes the activity). The
 *   in-app view of the scoresheet keeps its own Back (a history entry,
 *   openAppWindow.js), so Back closes it first.
 * - web (a browser): leaving or reloading the page while a match is live
 *   asks first (beforeunload; the browser shows its own generic text).
 *
 * Every question goes through askConfirm (the in-app dialog), never
 * window.confirm.
 */

import i18n from 'i18next'
import { askConfirm } from './askConfirm.js'
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

/** The tray's texts in the page's language (Rust falls back to English). */
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
let asking = false

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

/**
 * Ask "Quit OpenVolley?" and quit on confirm. The header menu's "Quit
 * OpenVolley…" and the tray's (through `quit-requested`) both end here.
 * @returns {Promise<boolean>} true when the app is quitting
 */
export async function requestDesktopQuit(win = desktopWin || window, ask = askConfirm) {
  const invoke = tauriInvoke(win)
  if (!invoke || asking) return false
  asking = true
  try {
    const nets = await laptopNetworks(invoke)
    if (!(await ask(quitQuestion({ live, ...nets })))) return false
    await invoke('app_quit')
    return true
  } catch (e) {
    console.error('[app] quit failed', e)
    return false
  } finally {
    asking = false
  }
}

async function showCloseNotice(win, ask) {
  const invoke = tauriInvoke(win)
  if (!invoke || asking) return
  asking = true
  try {
    if (await ask(closeNotice({ tray }))) await invoke('app_hide')
  } catch (e) {
    console.error('[app] hide failed', e)
  } finally {
    asking = false
  }
}

function installDesktop(win, ask) {
  const invoke = tauriInvoke(win)
  desktopWin = win
  const report = () => {
    Promise.resolve(invoke('app_page_state', { labels: trayLabels(), live }))
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

function installAndroid(win, ask) {
  let open = false
  // MainActivity: Back with no page to go back to. Returns true when handled
  // (the app then neither exits nor goes to the background by itself).
  win.__ovAndroidBack = () => {
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
  asking = false
  exitPlugin = null
  resetLeaveGuardForTests()
}
