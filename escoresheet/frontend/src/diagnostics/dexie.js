/**
 * Dexie transactions in diagnostics mode, as a DBCore middleware (registered
 * before the database opens, so only when diagnostics is on at start):
 *   db.tx     every read-write transaction: its tables, duration, outcome
 *   db.reads  read-only transactions summed per user action (the live
 *             queries re-reading after a write): count and total time
 */
import { diag, diagActive, sinceAction } from './recorder'

export const MIDDLEWARE_NAME = 'ov-diagnostics'
const QUIET_MS = 1500
const r1 = (n) => Math.round(n * 10) / 10
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export function createDexieDiagnostics() {
  let reads = null
  let quiet = null

  const reportReads = () => {
    if (quiet) {
      clearTimeout(quiet)
      quiet = null
    }
    if (!reads) return
    const r = reads
    reads = null
    diag('db.reads', r)
  }

  const onDone = (tx, fn) => {
    if (typeof tx?.addEventListener !== 'function') return
    tx.addEventListener('complete', () => fn('ok'))
    tx.addEventListener('abort', () => fn('abort'))
  }

  const middleware = {
    stack: 'dbcore',
    name: MIDDLEWARE_NAME,
    level: 20,
    create(down) {
      return {
        ...down,
        transaction(stores, mode, options) {
          const tx = down.transaction(stores, mode, options)
          if (!diagActive()) return tx
          try {
            const t0 = now()
            const names = Array.isArray(stores) ? stores : [stores]
            if (mode === 'readwrite') {
              const after = sinceAction()
              diag('db.tx_start', { tables: names.length > 6 ? names.length : names, after })
              onDone(tx, (outcome) => diag('db.tx', { tables: names.length > 6 ? names.length : names, ms: r1(now() - t0), outcome, after }))
            } else {
              const { a } = sinceAction()
              if (reads && reads.a !== a) reportReads()
              if (!reads) reads = { a, count: 0, ms: 0 }
              reads.count++
              onDone(tx, () => {
                if (reads && reads.a === a) reads.ms = r1(reads.ms + now() - t0)
              })
              if (quiet) clearTimeout(quiet)
              quiet = setTimeout(reportReads, QUIET_MS)
            }
          } catch { /* diagnostics never breaks a transaction */ }
          return tx
        }
      }
    }
  }
  return { middleware, flush: reportReads }
}

/** Registers the middleware on `db` (before it opens). Returns false when too late. */
export function installDexieDiagnostics(db) {
  if (!db?.use) return false
  const { middleware } = createDexieDiagnostics()
  db.use(middleware)
  const open = typeof db.isOpen === 'function' && db.isOpen()
  if (open) diag('diag.note', { note: 'database already open: db.* lines start at the next start' })
  return !open
}
