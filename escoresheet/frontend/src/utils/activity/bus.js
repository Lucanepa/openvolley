/**
 * The way into the activity log for code that must not import the database
 * (the sync queue, the lifecycle, error handlers, the backup engine): calls
 * are handed to the writer that startActivityLog() registers, and dropped
 * on pages that never start one (referee, bench, livescore). Never throws.
 */

let sink = null
const early = []
const EARLY_MAX = 200

/**
 * Record an activity entry.
 * @param {string} kind e.g. 'sync.error' (domain/activitySummary ACTIVITY_KINDS)
 * @param {object} [data] sanitized by the writer
 * @param {{level?:'info'|'warn'|'error', matchId?:any, matchExt?:string, setIndex?:number, eventSeq?:number, eventExt?:string, accountId?:string|null}} [opts]
 */
export function emitActivity(kind, data = {}, opts = {}) {
  try {
    if (sink) sink.record(kind, data, opts)
    else if (early.length < EARLY_MAX) early.push([kind, data, opts, new Date().toISOString()])
  } catch {
    // logging never breaks the app
  }
}

/** Write what is buffered now (quit); resolves within timeoutMs at the latest. */
export async function flushActivityNow(timeoutMs = 1000) {
  if (!sink) return
  try {
    await Promise.race([
      Promise.resolve(sink.flush()),
      new Promise((resolve) => setTimeout(resolve, timeoutMs))
    ])
  } catch {
    // best effort
  }
}

/** A queue pass finished (useSyncQueue): counted into the periodic sync.summary. */
export function noteSyncPass(outcome) {
  try { sink?.noteSyncPass?.(outcome) } catch { /* ignore */ }
}

/** Register the writer (startActivityLog); entries emitted before it are replayed. */
export function setActivitySink(next) {
  sink = next
  if (!sink) return
  for (const [kind, data, opts, ts] of early.splice(0)) {
    try { sink.record(kind, data, { ...opts, ts }) } catch { /* ignore */ }
  }
}

export const hasActivitySink = () => !!sink
