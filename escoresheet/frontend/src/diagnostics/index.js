/**
 * Diagnostics mode (off by default): a compact JSON-lines account of page
 * loads and reloads, layout sizes and jumps, dialogs, user actions, scorer
 * actions and their database transactions, enough to explain from the log
 * alone why the scoreboard pulsed, a dialog flashed or the app reloaded.
 *
 *   switch.js    on / off (Options, ?diag=1, OPENVOLLEY_DIAGNOSTICS=1)
 *   recorder.js  diag(kind, data): the line format, buffer, flush
 *   redact.js    what a line may carry (no PIN, password, token, signature)
 *   sinks.js     desktop: diagnostics-<date>.jsonl (Rust); else IndexedDB ring
 *   watchers.js  page / geometry / dialog / click observers
 *   jumps.js     size-comes-back detection
 *   reload.js    reloadWithReason(): every app reload with its reason
 *   commits.js   React commits per action (useDiagCommits)
 *   dexie.js     Dexie transactions
 *   popupForward.js  desktop pop-up windows: their lines into the scoretable's file
 *
 * installDiagnostics() runs first in the scorer app (main.jsx),
 * installPopupDiagnostics() in the scoresheet and referee entries (desktop
 * pop-up windows only). Off, it only reads the switch: nothing is observed or
 * stored.
 */
import { diagnosticsSwitch, diagnosticsOptionOn, setDiagnosticsOption } from './switch'
import { startRecorder, stopRecorder, diag, diagActive, diagSink, flushDiagnostics, appendLines, diagSessionId } from './recorder'
import { createDiagnosticsSink } from './sinks'
import { installWatchers } from './watchers'
import { setCommitProfiling, flushCommitCounts } from './commits'
import { installDexieDiagnostics } from './dexie'
import { isDesktopApp, desktopDiagnosticsSink, receivePopupLines } from './popupForward'
import { appVersion, platformName } from '../utils/identity'

export { diag, diagActive, noteAction } from './recorder'
export { reloadWithReason } from './reload'
export { useDiagCommits } from './commits'

let state = { on: false, source: null }
let stopWatchers = null
let stopReceiver = null

function start({ db, win, source, page = null }) {
  if (diagActive()) return
  // desktop: the scoretable writes the file and takes the pop-up windows'
  // lines; a pop-up may not write it and sends its lines to the scoretable
  // (popupForward.js: which one this is, the app says)
  const sink = isDesktopApp(win)
    ? desktopDiagnosticsSink({
      win,
      page,
      sessionId: diagSessionId,
      fileSink: createDiagnosticsSink(win),
      onMain: () => {
        if (diagSink() === sink && !stopReceiver) stopReceiver = receivePopupLines({ win, append: appendLines })
      }
    })
    : createDiagnosticsSink(win)
  startRecorder({ sink })
  Promise.resolve(sink.setNative?.(true)).catch(() => {})
  if (db) installDexieDiagnostics(db)
  stopWatchers = installWatchers({ win, appVersion: appVersion(), platform: platformName(win), source })
  state = { on: true, source }
}

/**
 * Start diagnostics when the switch says so (once, before the first render).
 * @param {{ db?: import('dexie').Dexie, win?: Window, page?: string }} [opts]
 * @returns {{ on: boolean, source: string|null }}
 */
export function installDiagnostics({ db = null, win = typeof window !== 'undefined' ? window : undefined, page = null } = {}) {
  if (!win) return state
  const sw = diagnosticsSwitch({ win })
  if (!sw.on) {
    state = { on: false, source: sw.source }
    return state
  }
  // React commits are counted only when on from the start (commits.js)
  setCommitProfiling(true)
  start({ db, win, source: sw.source, page })
  return state
}

/**
 * The scoresheet / referee entries: diagnostics only in the desktop app, where
 * they run in a pop-up window opened from the scoretable (the app says so, and
 * the lines go into the scoretable's file); in a browser, a LAN tablet or the
 * Android app this does nothing.
 * @param {{ db?: import('dexie').Dexie, win?: Window, app: string }} opts
 */
export function installPopupDiagnostics({ db = null, win = typeof window !== 'undefined' ? window : undefined, app = null } = {}) {
  if (!isDesktopApp(win)) return { on: false, source: null }
  return installDiagnostics({ db, win, page: app })
}

/** Stop recording, whatever switched it on. */
export async function stopDiagnostics(by = 'stop') {
  if (!state.on) return
  diag('diag.stop', { by })
  flushCommitCounts()
  try { stopWatchers?.() } catch { /* ignore */ }
  stopWatchers = null
  try { stopReceiver?.() } catch { /* ignore */ }
  stopReceiver = null
  const sink = diagSink()
  await Promise.resolve(sink?.setNative?.(false)).catch(() => {})
  await stopRecorder()
  try { sink?.close?.() } catch { /* ignore */ }
  state = { on: false, source: null }
}

/** { on, source, option, sink: 'file'|'ring'|'forward'|null } for Options. */
export function diagnosticsState() {
  return { ...state, option: diagnosticsOptionOn(), sink: diagSink()?.kind || null }
}

/**
 * Options > Diagnostics mode. On: records from now on (and from the start of
 * the next load). Off: stops, unless the URL or the desktop's environment
 * switched it on for this run.
 */
export async function setDiagnosticsEnabled(on, { db = null, win = typeof window !== 'undefined' ? window : undefined } = {}) {
  setDiagnosticsOption(on)
  if (on && !state.on) start({ db, win, source: 'options' })
  else if (!on && state.on && state.source === 'options') await stopDiagnostics('options')
  return diagnosticsState()
}

/**
 * Options > Export diagnostics: the desktop app opens the log folder (the
 * files are there); elsewhere the stored lines download as a .jsonl file.
 * A desktop pop-up window has nothing to export (false).
 * Returns 'folder' | 'file' | 'empty' | false.
 */
export async function exportDiagnostics({ win = typeof window !== 'undefined' ? window : undefined } = {}) {
  await flushDiagnostics()
  const running = diagSink()
  // a desktop window: once the app has said which one (popupForward.js)
  const sink = (running && (await running.ready?.catch(() => null))) || running || createDiagnosticsSink(win)
  if (sink.kind === 'file') return (await sink.openFolder()) ? 'folder' : false
  // a desktop pop-up window: its lines are in the scoretable's file
  if (typeof sink.exportText !== 'function') return false
  const text = await sink.exportText()
  if (!text) return 'empty'
  const blob = new Blob([text], { type: 'application/x-ndjson' })
  const url = URL.createObjectURL(blob)
  const link = win.document.createElement('a')
  link.href = url
  link.download = `openvolley-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  win.document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return 'file'
}
