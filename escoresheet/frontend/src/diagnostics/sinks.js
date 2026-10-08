/**
 * Where diagnostics lines go:
 *   desktop (Tauri):  <log dir>/diagnostics-YYYY-MM-DD.jsonl through the Rust
 *                     command diagnostics_append (src-tauri/src/diagnostics.rs:
 *                     20 MB a day, 7 days); the window's native events are
 *                     switched with diagnostics_native.
 *   browser, Android: a ring buffer in its own IndexedDB database
 *                     (openvolley-diagnostics, at most RING_MAX_ROWS lines,
 *                     RING_MAX_AGE_MS), exported from Options as a .jsonl file.
 * A sink never throws into the app.
 */
import Dexie from 'dexie'

export const RING_DB_NAME = 'openvolley-diagnostics'
export const RING_MAX_ROWS = 50000
export const RING_MAX_AGE_MS = 7 * 24 * 3600 * 1000
// prune every this many writes (and at open)
const RING_PRUNE_EVERY = 20
const TAURI_CHUNK = 500

export function tauriSink(invoke) {
  return {
    kind: 'file',
    async write(lines) {
      for (let i = 0; i < lines.length; i += TAURI_CHUNK) {
        await invoke('diagnostics_append', { lines: lines.slice(i, i + TAURI_CHUNK) })
      }
    },
    setNative: (on) => invoke('diagnostics_native', { on }).catch(() => false),
    openFolder: () => invoke('activity_open_dir').then(() => true, () => false),
    exportText: null,
    clear: null
  }
}

/**
 * The capped IndexedDB ring buffer.
 * @param {{ name?: string, maxRows?: number, maxAgeMs?: number, now?: () => number, indexedDB?: any, IDBKeyRange?: any }} [opts]
 */
export function ringSink({ name = RING_DB_NAME, maxRows = RING_MAX_ROWS, maxAgeMs = RING_MAX_AGE_MS, now = () => Date.now(), indexedDB, IDBKeyRange } = {}) {
  const db = new Dexie(name, indexedDB ? { indexedDB, IDBKeyRange } : undefined)
  db.version(1).stores({ lines: '++id, at' })
  let writes = 0

  async function prune() {
    const cutoff = now() - maxAgeMs
    await db.lines.where('at').below(cutoff).delete()
    const count = await db.lines.count()
    if (count > maxRows) {
      const ids = await db.lines.orderBy('id').limit(count - maxRows).primaryKeys()
      await db.lines.bulkDelete(ids)
    }
  }

  return {
    kind: 'ring',
    db,
    async write(lines) {
      const at = now()
      await db.lines.bulkAdd(lines.map(line => ({ at, line })))
      writes++
      if (writes === 1 || writes % RING_PRUNE_EVERY === 0) await prune()
    },
    prune,
    setNative: async () => false,
    openFolder: async () => false,
    /** Every stored line, oldest first, one per line. */
    async exportText() {
      const rows = await db.lines.orderBy('id').toArray()
      return rows.map(r => r.line).join('\n') + (rows.length ? '\n' : '')
    },
    clear: () => db.lines.clear(),
    count: () => db.lines.count()
  }
}

/** The sink of this platform. */
export function createDiagnosticsSink(win = typeof window !== 'undefined' ? window : undefined) {
  const invoke = win?.__TAURI_INTERNALS__?.invoke
  if (typeof invoke === 'function') return tauriSink((cmd, args) => invoke(cmd, args))
  return ringSink()
}
