/**
 * Calls onWrite after every committed Dexie write of one match: its events
 * (points, timeouts, substitutions, sanctions, libero changes, set start/end,
 * undo deletes), its sets (scores, set end) and its match row (status, match
 * end, signatures, sanctions, remarks...). This is the place every scorer
 * action lands, whichever screen wrote it.
 *
 * Uses Dexie table hooks; the callback runs after the transaction commits
 * (never inside it) and its errors are swallowed, so a backup problem can never
 * abort or slow a scoring write.
 */

// Match-row writes that are bookkeeping, not scoring (connection heartbeats,
// session ownership, sync stamps): they do not start a backup by themselves.
const VOLATILE_MATCH_KEY = /heartbeat|lastseen|sessionid|synced|_sync|lastupdated|updatedat/i

const NO_BACKUP_EVENT_TYPES = new Set(['rally_start'])

const valueAt = (obj, keyPath) => keyPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)

function sameValue(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/**
 * True when an update of the match row changes nothing but bookkeeping.
 * Dexie's `updating` hook gets an object diff that compares arrays and other
 * non-plain values by reference, so an unchanged officials/bench array shows
 * up as "modified": keys whose value equals the stored one are ignored.
 * @param {object} modifications key paths -> new values
 * @param {object} [current] the stored row before the update
 */
export function isVolatileMatchUpdate(modifications, current) {
  const keys = Object.keys(modifications || {})
  if (!keys.length) return false
  const changed = current
    ? keys.filter(k => !sameValue(modifications[k], valueAt(current, k)))
    : keys
  return changed.every(k => VOLATILE_MATCH_KEY.test(k))
}

function afterCommit(transaction, fn) {
  const run = () => {
    try { fn() } catch (e) { console.warn('[NativeBackup] write hook callback failed:', e) }
  }
  try {
    if (transaction && typeof transaction.on === 'function') {
      transaction.on('complete', run)
      return
    }
  } catch {
    // fall through: schedule outside the transaction
  }
  setTimeout(run, 0)
}

/**
 * @param {import('dexie').Dexie} db
 * @param {number} matchId local match id
 * @param {() => void} onWrite
 * @returns {() => void} unsubscribe
 */
export function subscribeMatchWrites(db, matchId, onWrite) {
  if (!db || matchId == null || typeof onWrite !== 'function') return () => {}
  const fire = (transaction) => afterCommit(transaction, onWrite)
  const subs = []

  const add = (table, type, fn) => {
    try {
      if (!table?.hook) return
      table.hook(type, fn)
      subs.push(() => table.hook(type).unsubscribe(fn))
    } catch (e) {
      console.warn(`[NativeBackup] cannot hook ${type}:`, e)
    }
  }

  // events + sets: rows carry matchId
  for (const table of [db.events, db.sets]) {
    add(table, 'creating', function (_key, obj, transaction) {
      if (obj?.matchId !== matchId) return
      // "rally started" is not a scoring event and comes before every point:
      // it would double the files; the point backup right after includes it.
      if (table === db.events && NO_BACKUP_EVENT_TYPES.has(obj.type)) return
      fire(transaction)
    })
    add(table, 'updating', function (mods, _key, obj, transaction) {
      if (obj?.matchId === matchId || mods?.matchId === matchId) fire(transaction)
    })
    add(table, 'deleting', function (_key, obj, transaction) {
      if (obj?.matchId === matchId) fire(transaction)
    })
  }

  // the match row itself
  add(db.matches, 'updating', function (mods, key, obj, transaction) {
    if (key === matchId && !isVolatileMatchUpdate(mods, obj)) fire(transaction)
  })
  add(db.matches, 'creating', function (key, _obj, transaction) {
    if (key === matchId) fire(transaction)
  })

  return () => {
    for (const off of subs.splice(0)) {
      try { off() } catch { /* already gone */ }
    }
  }
}
