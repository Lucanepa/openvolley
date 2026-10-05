/**
 * Namespaced external ids for synced sets and events.
 *
 * Sets and events are upserted to the cloud with onConflict 'external_id'. Their
 * local ids are Dexie auto-increment numbers, which restart at 1 on every device
 * and after every local reset, so a bare id ('42') collides with set/event 42 of
 * every other match. Prefixing the match seed_key makes the id unique per match:
 *
 *   set   -> `${seedKey}:s:${localSetId}`
 *   event -> `${seedKey}:e:${localEventId}`
 *
 * seed_key never contains ':' (match_{timestamp}_{random}), so the id can be
 * parsed back into its parts.
 */

export const setExtId = (seedKey, setId) => `${seedKey}:s:${setId}`
export const eventExtId = (seedKey, eventId) => `${seedKey}:e:${eventId}`

const BARE_ID = /^\d+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True for the legacy un-namespaced form: just the local Dexie id. */
export function isBareLocalId(id) {
  return BARE_ID.test(String(id ?? ''))
}

/** Parse a namespaced id back into { seedKey, kind, localId }, or null. */
export function parseExtId(extId) {
  const m = /^(.+):([se]):(\d+)$/.exec(String(extId ?? ''))
  if (!m) return null
  return { seedKey: m[1], kind: m[2] === 's' ? 'set' : 'event', localId: Number(m[3]) }
}

/**
 * Work out the namespaced external_id for a queued set/event job whose payload
 * still carries a bare Dexie id (queued before ids were namespaced, or written by
 * a call site that still sends String(localId)).
 *
 * The seed comes from payload.match_id (a seed_key until the queue resolves it to
 * the cloud UUID) or, for set updates that carry no match_id, from the local set's
 * match.
 *
 * @param {object} job - sync_queue row
 * @param {{ sets: object, matches: object }} tables - Dexie tables (or fakes)
 * @returns {Promise<null | { external_id: string } | { drop: true }>}
 *   null when nothing needs changing, { drop: true } when the job cannot be
 *   attributed to a match (sending it bare would overwrite another match's row).
 */
export async function resolveJobExternalId(job, { sets, matches }) {
  const p = job?.payload || {}
  if (job?.resource !== 'set' && job?.resource !== 'event') return null
  if (!isBareLocalId(p.external_id)) return null

  let seed = typeof p.match_id === 'string' && p.match_id && !UUID.test(p.match_id) ? p.match_id : null
  if (!seed && job.resource === 'set') {
    const localSet = await sets.get(Number(p.external_id))
    // Table.get(null/undefined) throws in Dexie; a set row without a matchId
    // simply cannot be attributed.
    const localMatch = localSet?.matchId != null ? await matches.get(localSet.matchId) : null
    seed = localMatch?.seed_key || null
  }
  if (!seed) return { drop: true }

  return {
    external_id: job.resource === 'set' ? setExtId(seed, p.external_id) : eventExtId(seed, p.external_id)
  }
}

/**
 * The match (seed_key / cloud external_id) a sync_queue job belongs to, or null.
 * Used for per-match ordering in the queue and to scope queue clean-ups.
 */
export function jobMatchKey(job) {
  const p = job?.payload || {}
  if (job?.resource === 'match') {
    if (job.action === 'restore') return p.match?.external_id || null
    return p.external_id || p.id || null
  }
  if (job?.resource === 'set' || job?.resource === 'event') {
    if (typeof p.match_id === 'string' && p.match_id && !UUID.test(p.match_id)) return p.match_id
    return parseExtId(p.external_id)?.seedKey || null
  }
  return null
}

/**
 * Rewrite every pending (queued or errored) set/event job to a namespaced
 * external_id. Used by the Dexie v17 upgrade; jobs that cannot be attributed to a
 * match are marked 'dropped' (kept for inspection, never sent).
 *
 * Never rejects: this runs inside a Dexie upgrade, and a rejected upgrade leaves
 * IndexedDB unopenable (the whole scorer app dead, possibly mid-match). A job
 * that throws while being resolved is dropped (sending it with a bare id would
 * overwrite another match's row); one that cannot even be marked is left as is.
 */
export async function rewriteQueuedSyncJobs({ queue, sets, matches }) {
  let rewritten = 0
  let dropped = 0
  let failed = 0
  let jobs = []
  try {
    jobs = await queue.where('status').anyOf('queued', 'error').toArray()
  } catch (e) {
    console.warn('[syncIds] could not read the sync queue for the id rewrite:', e?.message)
    return { rewritten, dropped, failed: 1 }
  }
  for (const job of jobs) {
    try {
      let result
      try {
        result = await resolveJobExternalId(job, { sets, matches })
      } catch (e) {
        console.warn(`[syncIds] job ${job?.id}: could not resolve external_id, dropping:`, e?.message)
        result = { drop: true }
      }
      if (!result) continue
      if (result.drop) {
        await queue.update(job.id, { status: 'dropped' })
        dropped++
        continue
      }
      await queue.update(job.id, { payload: { ...job.payload, external_id: result.external_id } })
      rewritten++
    } catch (e) {
      failed++
      console.warn(`[syncIds] job ${job?.id}: rewrite failed, left untouched:`, e?.message)
    }
  }
  return { rewritten, dropped, failed }
}
