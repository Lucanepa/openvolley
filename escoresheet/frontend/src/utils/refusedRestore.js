/**
 * A restore the server refused with its own code (a body over its limit, too
 * many rows, a row it cannot take): a backup restore, or the re-key of a
 * hand-over. Parked as refused, it holds every later job of its match
 * (useSyncQueue pendingEntityBlocks), so the match never reaches the cloud
 * without help. The sync queue marks the local match with a cloudBlock of
 * this code (useSyncQueue recordRestoreRefused) and CloudBlockNotice names
 * the game, the reason and what to do. Not a server code.
 */
import { db } from '../db/db'
import { jobMatchKey } from './syncIds'

export const RESTORE_REFUSED = 'OV_RESTORE_REFUSED'

// Events per part (splitRefusedRestore): far below the server's restore body
// limit (16 MB) for the largest rally rows
const RESTORE_PART_EVENTS = 500
// Events one restore may carry (backend lib/matchRestore.js maxEvents; more
// are refused as OV_INVALID_REQUEST)
const RESTORE_MAX_EVENTS = 20000
// Match statuses that close a match on the server (db/007)
const CLOSING_STATUSES = ['approved', 'final']

/**
 * Would parts get a refused restore through? Only where the refusal is about
 * its size: the body over the server's limit (OV_BODY_TOO_LARGE), or more
 * events than one restore takes. A refusal of what it carries (a row, an id
 * out of scope, another owner's match) refuses every part the same.
 * @param {{ code?: string, status?: number }|null} error the refusal
 * @param {object} payload the restore's
 */
export function partsMayHelp(error, payload) {
  const events = Array.isArray(payload?.events) ? payload.events.length : 0
  if (events < 2) return false
  if (error?.code === 'OV_BODY_TOO_LARGE') return true
  return error?.code === 'OV_INVALID_REQUEST' && events > RESTORE_MAX_EVENTS
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v)

// The entries of a hand-over's re-key map for these rows (by their new id)
function rekeyOf(map, rows) {
  const out = {}
  if (!isPlainObject(map)) return out
  for (const row of rows) {
    const from = map[row?.external_id]
    if (typeof from === 'string') out[row.external_id] = from
  }
  return out
}

// A re-key whose new ids are old ids of the same map (cloud e:1..e:5 to
// e:3..e:7): the server renames those in two steps within ONE restore; a
// part would delete a row a later part still has to rename
function rekeyOverlaps(rekey) {
  return ['sets', 'events'].some(kind => {
    const map = isPlainObject(rekey[kind]) ? rekey[kind] : {}
    const old = new Set(Object.values(map))
    return Object.keys(map).some(key => old.has(key))
  })
}

/**
 * Support's way to get such a match into the cloud (CloudBlockNotice "Send
 * in parts"): the refused restore is replaced by restores of a part of its
 * events each, sent one after the other, as the whole one would have left
 * the cloud:
 * - a backup restore (a whole replace): the first part replaces the match's
 *   rows with its sets, its events and the live state, as the whole one
 *   would; the later parts only add theirs (rekey without entries: the
 *   server deletes nothing);
 * - a hand-over (rekey, importMatchFromSupabase): each part carries the
 *   entries of its own rows (the sets' with the first part), so the server
 *   renames the cloud rows in place instead of writing them twice.
 * The sets go with the first part, a closing status (approved, final) with
 * the last one only (the server would refuse the next part of a closed
 * match). A part refused again is split further: at most half its events
 * per part. The match's jobs queued after the restore are moved behind the
 * parts, in their order: nothing of the match may overtake them.
 * @param {string} seedKey the match
 * @param {{ eventsPerPart?: number, database?: object }} [options]
 * @returns {Promise<number>} parts queued (0: no refused restore of the
 *   match, or one that cannot be split)
 */
export async function splitRefusedRestore(seedKey, { eventsPerPart = RESTORE_PART_EVENTS, database = db } = {}) {
  if (!seedKey) return 0
  const size = Math.max(1, Math.floor(eventsPerPart) || RESTORE_PART_EVENTS)
  const parts = await database.transaction('rw', database.sync_queue, async () => {
    const unsent = await database.sync_queue.where('status').anyOf('queued', 'error', 'failed').toArray()
    const ofMatch = unsent.filter(j => jobMatchKey(j) === seedKey).sort((a, b) => a.id - b.id)
    const refused = ofMatch.filter(j => j.resource === 'match' && j.action === 'restore' && j.status === 'failed').pop()
    const { match, sets, events, liveState, rekey } = refused?.payload || {}
    if (!match?.external_id) return 0
    const handOver = isPlainObject(rekey)
    if (handOver && rekeyOverlaps(rekey)) {
      console.warn(`[refusedRestore] The refused restore of ${seedKey} re-keys rows onto ids it also moves: not split`)
      return 0
    }
    const list = Array.isArray(events) ? events : []
    const setList = Array.isArray(sets) ? sets : []
    const perPart = Math.min(size, Math.max(1, Math.ceil(list.length / 2)))
    const chunks = []
    for (let i = 0; i < list.length; i += perPart) chunks.push(list.slice(i, i + perPart))
    if (chunks.length === 0) chunks.push([])
    const closing = CLOSING_STATUSES.includes(match.status)
    const later = ofMatch.filter(j => j.id > refused.id)
    await database.sync_queue.bulkDelete([refused.id, ...later.map(j => j.id)])
    for (const [i, chunk] of chunks.entries()) {
      const first = i === 0
      const last = i === chunks.length - 1
      // the first part of a replace goes without: the server replaces the match's rows
      const partRekey = handOver
        ? { sets: first ? rekeyOf(rekey.sets, setList) : {}, events: rekeyOf(rekey.events, chunk) }
        : (first ? null : { sets: {}, events: {} })
      await database.sync_queue.add({
        resource: 'match',
        action: 'restore',
        payload: {
          match: closing && !last ? { ...match, status: 'ended' } : match,
          sets: first ? setList : [],
          events: chunk,
          liveState: first ? (liveState ?? null) : null,
          ...(partRekey ? { rekey: partRekey } : {})
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
