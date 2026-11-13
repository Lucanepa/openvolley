/**
 * A restore the server refused with its own code (a body over its limit, too
 * many rows, a row it cannot take). Parked as refused, it holds every later
 * job of its match (useSyncQueue pendingEntityBlocks), so the match never
 * reaches the cloud without help. The sync queue marks the local match with
 * a cloudBlock of this code (useSyncQueue recordRestoreRefused) and
 * CloudBlockNotice names the game, the reason and what to do. Not a server
 * code.
 */
import { db } from '../db/db'
import { jobMatchKey } from './syncIds'

export const RESTORE_REFUSED = 'OV_RESTORE_REFUSED'

// Events per part (splitRefusedRestore): far below the server's restore body
// limit (16 MB) for the largest rally rows
const RESTORE_PART_EVENTS = 500
// Match statuses that close a match on the server (db/007)
const CLOSING_STATUSES = ['approved', 'final']

/**
 * Support's way to get such a match into the cloud (CloudBlockNotice "Send
 * in parts"): the refused restore is replaced by restores of a part of its
 * events each, sent one after the other. A part only adds and updates rows
 * (rekey: the server deletes nothing, unlike the whole restore); the sets go
 * with the first part, a closing status (approved, final) with the last one
 * only (the server would refuse the next part of a closed match). The
 * match's jobs queued after the restore are moved behind the parts, in their
 * order: nothing of the match may overtake them.
 * @param {string} seedKey the match
 * @param {{ eventsPerPart?: number, database?: object }} [options]
 * @returns {Promise<number>} parts queued (0: no refused restore of the match)
 */
export async function splitRefusedRestore(seedKey, { eventsPerPart = RESTORE_PART_EVENTS, database = db } = {}) {
  if (!seedKey) return 0
  const size = Math.max(1, Math.floor(eventsPerPart) || RESTORE_PART_EVENTS)
  const parts = await database.transaction('rw', database.sync_queue, async () => {
    const unsent = await database.sync_queue.where('status').anyOf('queued', 'error', 'failed').toArray()
    const ofMatch = unsent.filter(j => jobMatchKey(j) === seedKey).sort((a, b) => a.id - b.id)
    const refused = ofMatch.filter(j => j.resource === 'match' && j.action === 'restore' && j.status === 'failed').pop()
    const { match, sets, events } = refused?.payload || {}
    if (!match?.external_id) return 0
    const list = Array.isArray(events) ? events : []
    const chunks = []
    for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size))
    if (chunks.length === 0) chunks.push([])
    const closing = CLOSING_STATUSES.includes(match.status)
    const later = ofMatch.filter(j => j.id > refused.id)
    await database.sync_queue.bulkDelete([refused.id, ...later.map(j => j.id)])
    for (const [i, chunk] of chunks.entries()) {
      const last = i === chunks.length - 1
      await database.sync_queue.add({
        resource: 'match',
        action: 'restore',
        payload: {
          match: closing && !last ? { ...match, status: 'ended' } : match,
          sets: i === 0 && Array.isArray(sets) ? sets : [],
          events: chunk,
          liveState: null,
          rekey: { sets: {}, events: {} }
        },
        // when the restore was made (db/019 queuedAt), as the refused one
        ts: refused.ts,
        status: 'queued',
        retry_count: 0
      })
    }
    for (const job of later) {
      const row = { ...job }
      delete row.id
      await database.sync_queue.add(row)
    }
    return chunks.length
  })
  if (parts > 0) {
    console.log(`[refusedRestore] Refused restore of ${seedKey} queued again in ${parts} part(s)`)
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('sync-queue-flush-now'))
  }
  return parts
}
