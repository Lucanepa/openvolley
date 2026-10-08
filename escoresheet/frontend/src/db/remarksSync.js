/**
 * The scoresheet remarks (match.remarks) go to the server (db/017).
 *
 * Remarks are written from many places: the remarks box on the scoreboard and
 * on the match end page, the automatic lines of the scoreboard (injury,
 * exceptional substitution, "Actual start time: HH:MM", forfeit / default),
 * the Corrections panel and undo (which takes an automatic line back out).
 * Instead of a sync job at each of them, a Dexie table hook on db.matches
 * (like db/eventHistory) queues one match update { remarks } for every
 * committed change of the text, whichever screen made it.
 *
 *  - Only for a cloud match: a seed_key and not a test match.
 *  - The job carries the whole text (a full snapshot), so jobs replace each
 *    other: last write wins on the server, like every other plain match
 *    column, and an older errored job never overwrites a newer sent one
 *    (useSyncQueue supersedeStaleUpdates).
 *  - Inside the writing transaction when it includes sync_queue (the change
 *    and its job together, in order with the transaction's other jobs), else
 *    right after it commits. A rolled-back write queues nothing.
 *  - Never shortens the local text; what is sent is clipped to REMARKS_MAX
 *    (remarksForServer).
 *  - A match added with remarks (backup restore, import from the server) is
 *    not an edit: the restore job carries them, an import came from there.
 *
 * Remark text never goes to a log: the activity log keeps the length only
 * (domain/activitySummary 'match.remarks'), and useSyncQueue's redactForLog
 * prints a length for it.
 */
import { remarksForServer } from './matchRepository'

const textOf = (v) => (typeof v === 'string' ? v : '')

/**
 * The sync job for a change of the remarks, or null (no change, no seed_key,
 * a test match).
 * @param {object|undefined} before the stored match row
 * @param {object} after the row after the update (top-level fields)
 * @param {{ now?: Date }} [opts]
 */
export function remarksSyncJob(before, after, { now = new Date() } = {}) {
  const seedKey = after?.seed_key
  if (!seedKey || after?.test === true) return null
  const next = textOf(after.remarks)
  if (next === textOf(before?.remarks)) return null
  return {
    resource: 'match',
    action: 'update',
    payload: { id: seedKey, remarks: remarksForServer(next) },
    ts: now.toISOString(),
    status: 'queued'
  }
}

/**
 * A job that sends the match's current remarks as they are (the approval
 * queues one before its own job: the closed server copy has the sheet's text,
 * also one typed before this version synced remarks). Its own job, so a
 * server without db/017 refuses only it, never the approval. Null without a
 * seed_key or for a test match.
 * @param {object|undefined} match the local match row
 * @param {{ now?: Date }} [opts]
 */
export function remarksSnapshotJob(match, { now = new Date() } = {}) {
  if (!match?.seed_key || match.test === true) return null
  return {
    resource: 'match',
    action: 'update',
    payload: { id: match.seed_key, remarks: remarksForServer(textOf(match.remarks)) },
    ts: now.toISOString(),
    status: 'queued'
  }
}

function afterCommit(tx, fn) {
  const run = () => {
    try { fn() } catch (e) { console.warn('[RemarksSync] queueing failed:', e?.message || e) }
  }
  try {
    if (tx && typeof tx.on === 'function') {
      tx.on('complete', run)
      return
    }
  } catch { /* fall through */ }
  setTimeout(run, 0)
}

const installedOn = new WeakSet()

/**
 * Install the db.matches hook (once per database). Called by db/db.js at
 * module load; tests call it with their own database.
 * @param {import('dexie').Dexie} database
 */
export function installRemarksSyncHook(database) {
  if (!database?.matches?.hook || !database.sync_queue) return
  if (installedOn.has(database)) return
  installedOn.add(database)

  database.matches.hook('updating', function (mods, primKey, obj, tx) {
    try {
      if (!mods || !obj || !Object.prototype.hasOwnProperty.call(mods, 'remarks')) return
      const job = remarksSyncJob(obj, { ...obj, ...mods })
      if (!job) return
      const names = tx?.storeNames || []
      if (names.includes('sync_queue')) {
        tx.table('sync_queue').add(job).catch((e) => console.warn('[RemarksSync] in-transaction job failed:', e?.message || e))
        return
      }
      afterCommit(tx, () => {
        Promise.resolve(database.sync_queue.add(job)).catch((e) => console.warn('[RemarksSync] job failed:', e?.message || e))
      })
    } catch (e) {
      console.warn('[RemarksSync] hook failed:', e?.message || e)
    }
  })
}
