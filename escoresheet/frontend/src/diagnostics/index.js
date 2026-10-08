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
 *
 * installDiagnostics() runs first in the scorer app (main.jsx). Off, it only
 * reads the switch: nothing is observed or stored.
 */
import { diagnosticsSwitch, diagnosticsOptionOn, setDiagnosticsOption } from './switch'
import { startRecorder, stopRecorder, diag, diagActive, diagSink, flushDiagnostics } from './recorder'
import { createDiagnosticsSink } from './sinks'
import { installWatchers } from './watchers'
import { setCommitProfiling, flushCommitCounts } from './commits'
import { installDexieDiagnostics } from './dexie'
import { appVersion, platformName } from '../utils/identity'

export { diag, diagActive, noteAction } from './recorder'
export { reloadWithReason } from './reload'
export { useDiagCommits } from './commits'

let state = { on: false, source: null }
let stopWatchers = null

function start({ db, win, source }) {
  if (diagActive()) return
  const sink = createDiagnosticsSink(win)
  startRecorder({ sink })
  Promise.resolve(sink.setNative?.(true)).catch(() => {})
  if (db) installDexieDiagnostics(db)
  stopWatchers = installWatchers({ win, appVersion: appVersion(), platform: platformName(win), source })
  state = { on: true, source }
}

/**
 * Start diagnostics when the switch says so (once, before the first render).
 * @param {{ db?: import('dexie').Dexie, win?: Window }} [opts]
 * @returns {{ on: boolean, source: string|null }}
 */
export function installDiagnostics({ db = null, win = typeof window !== 'undefined' ? window : undefined } = {}) {
  if (!win) return state
  const sw = diagnosticsSwitch({ win })
  if (!sw.on) {
    state = { on: false, source: sw.source }
    return state
  }
  // React commits are counted only when on from the start (commits.js)
  setCommitProfiling(true)
  start({ db, win, source: sw.source })
  return state
}

/** { on, source, option, sink: 'file'|'ring'|null } for Options. */
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
  else if (!on && state.on && state.source === 'options') {
    diag('diag.stop', { by: 'options' })
    flushCommitCounts()
    try { stopWatchers?.() } catch { /* ignore */ }
    stopWatchers = null
    await Promise.resolve(diagSink()?.setNative?.(false)).catch(() => {})
    await stopRecorder()
    state = { on: false, source: null }
  }
  return diagnosticsState()
}

/**
 * Options > Export diagnostics: the desktop app opens the log folder (the
 * files are there); elsewhere the stored lines download as a .jsonl file.
 * Returns 'folder' | 'file' | 'empty' | false.
 */
export async function exportDiagnostics({ win = typeof window !== 'undefined' ? window : undefined } = {}) {
  await flushDiagnostics()
  const sink = diagSink() || createDiagnosticsSink(win)
  if (sink.kind === 'file') return (await sink.openFolder()) ? 'folder' : false
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
