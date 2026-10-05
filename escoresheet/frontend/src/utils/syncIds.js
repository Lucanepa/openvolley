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
 *
 * The backend refuses (400 OV_UNSCOPED_EXTERNAL_ID) any set/event whose
 * external_id does not start with its match's external_id followed by ':' or
 * '_'. Every call site must therefore build ids with the helpers below.
 */

export const setExtId = (seedKey, setId) => `${seedKey}:s:${setId}`
export const eventExtId = (seedKey, eventId) => `${seedKey}:e:${eventId}`

const BARE_ID = /^\d+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True for the legacy un-namespaced form: just the local Dexie id. */
export function isBareLocalId(id) {
  return BARE_ID.test(String(id ?? ''))
}

/**
 * The coin toss event was once queued as `coin_toss_${seedKey}`: the match key is
 * not a prefix, so the backend rejects it forever. Returns the seed key of such a
 * legacy id, or null.
 */
export function legacyCoinTossSeed(extId) {
  const m = /^coin_toss_(.+)$/.exec(String(extId ?? ''))
  return m ? m[1] : null
}

/** Parse a namespaced id back into { seedKey, kind, localId }, or null. */
export function parseExtId(extId) {
  const m = /^(.+):([se]):(\d+)$/.exec(String(extId ?? ''))
  if (!m) return null
  return { seedKey: m[1], kind: m[2] === 's' ? 'set' : 'event', localId: Number(m[3]) }
}

// external_id of a legacy 'coin_toss_<seed>' event job: the local coin_toss
// event's namespaced id, or `${seed}:e:coin_toss` when that event is gone (still
// scoped to the match, so the backend accepts it).
async function resolveLegacyCoinToss(seed, { matches, events }) {
  let localEventId = null
  try {
    const localMatch = matches?.filter ? await matches.filter(m => m.seed_key === seed).first() : null
    if (localMatch?.id != null && events?.where) {
      const ev = await events.where('matchId').equals(localMatch.id).and(e => e.type === 'coin_toss').first()
      localEventId = ev?.id ?? null
    }
  } catch {
    localEventId = null
  }
  return localEventId != null ? eventExtId(seed, localEventId) : `${seed}:e:coin_toss`
}

/**
 * Work out the namespaced external_id for a queued set/event job whose payload
 * still carries a bare Dexie id (queued before ids were namespaced, or written by
 * a call site that still sends String(localId)), or the legacy coin toss id
 * 'coin_toss_<seed>'.
 *
 * The seed comes from payload.match_id (a seed_key until the queue resolves it to
 * the cloud UUID) or, for set updates that carry no match_id, from the local set's
 * match.
 *
 * @param {object} job - sync_queue row
 * @param {{ sets: object, matches: object, events?: object }} tables - Dexie tables (or fakes)
 * @returns {Promise<null | { external_id: string } | { drop: true }>}
 *   null when nothing needs changing, { drop: true } when the job cannot be
 *   attributed to a match (sending it bare would overwrite another match's row).
 */
export async function resolveJobExternalId(job, { sets, matches, events }) {
  const p = job?.payload || {}
  if (job?.resource !== 'set' && job?.resource !== 'event') return null

  const coinTossSeed = job.resource === 'event' ? legacyCoinTossSeed(p.external_id) : null
  if (coinTossSeed) {
    // Without the events table the local coin toss event cannot be looked up:
    // leave the job for a caller that can (the fallback id would not match
    // the one a re-confirmed coin toss sends)
    if (!events?.where) return null
    const seed = typeof p.match_id === 'string' && p.match_id && !UUID.test(p.match_id) ? p.match_id : coinTossSeed
    return { external_id: await resolveLegacyCoinToss(seed, { matches, events }) }
  }

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
  if (job?.resource === USER_MATCH_RESOURCE) return p.match_external_id || null
  return null
}

// ---------------------------------------------------------------------------
// user_matches ("My Matches"): which account scored / officiated which match
// ---------------------------------------------------------------------------

/** sync_queue resource of a user_matches link (action 'upsert'). */
export const USER_MATCH_RESOURCE = 'user_match'

/** Role of the account that runs the scorer app for a match. */
export const SCORER_ROLE = 'scorer'

const normName = (s) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Roles the signed-in account holds in a match: always 'scorer' (it runs the
 * scoresheet), plus every officials entry that carries the account's own name
 * (first + last name from its profile, either order, case and accents
 * ignored), e.g. '1st referee' when the referee signed in on the scorer's
 * device. Role strings are the officials' own ('1st referee', 'assistant
 * scorer', 'line judge 1', ...), shown as such in My Matches.
 *
 * @param {object} match - local match (officials with firstName/lastName or first_name/last_name, line judges with name)
 * @param {object|null} profile - the account's profile row (first_name, last_name)
 * @returns {string[]} distinct roles, 'scorer' first
 */
export function userMatchRoles(match, profile) {
  const roles = [SCORER_ROLE]
  const first = normName(profile?.first_name ?? profile?.firstName)
  const last = normName(profile?.last_name ?? profile?.lastName)
  if (!first || !last || !Array.isArray(match?.officials)) return roles
  const own = new Set([`${first} ${last}`, `${last} ${first}`])
  for (const o of match.officials) {
    if (!o || typeof o.role !== 'string' || !o.role.trim()) continue
    const full = o.name != null
      ? normName(o.name)
      : normName(`${o.firstName ?? o.first_name ?? ''} ${o.lastName ?? o.last_name ?? ''}`)
    const role = o.role.trim().toLowerCase()
    if (own.has(full) && !roles.includes(role)) roles.push(role)
  }
  return roles
}

/**
 * sync_queue row linking an account to a match (POST /api/db user_matches
 * upsert, onConflict user_id,match_external_id,role). Keyed by the match's
 * seed_key: never queued for a match without one (a Dexie id is not unique
 * across devices). user_id records whose link it is; the backend forces the
 * caller's own id, so the queue sends it only while that account is signed in.
 */
export function userMatchJob({ userId, seedKey, role, ts = new Date().toISOString() }) {
  return {
    resource: USER_MATCH_RESOURCE,
    action: 'upsert',
    payload: { user_id: userId, match_external_id: seedKey, role, sport_type: 'indoor' },
    ts,
    status: 'queued'
  }
}

/**
 * Rewrite every pending (queued or errored) set/event job to a namespaced
 * external_id. Used by the Dexie v17 upgrade (bare ids) and v18 (legacy coin
 * toss ids); jobs that cannot be attributed to a match are marked 'dropped'
 * (kept for inspection, never sent).
 *
 * `statuses` picks the jobs looked at. With `requeue`, a rewritten job that was
 * parked ('error'/'failed') is put back in the queue at once: it was failing only
 * because of its id.
 *
 * Never rejects: this runs inside a Dexie upgrade, and a rejected upgrade leaves
 * IndexedDB unopenable (the whole scorer app dead, possibly mid-match). A job
 * that throws while being resolved is dropped (sending it with a bare id would
 * overwrite another match's row); one that cannot even be marked is left as is.
 */
export async function rewriteQueuedSyncJobs({ queue, sets, matches, events }, { statuses = ['queued', 'error'], requeue = false } = {}) {
  let rewritten = 0
  let dropped = 0
  let failed = 0
  let jobs = []
  try {
    jobs = await queue.where('status').anyOf(...statuses).toArray()
  } catch (e) {
    console.warn('[syncIds] could not read the sync queue for the id rewrite:', e?.message)
    return { rewritten, dropped, failed: 1 }
  }
  for (const job of jobs) {
    try {
      let result
      try {
        result = await resolveJobExternalId(job, { sets, matches, events })
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
      const changes = { payload: { ...job.payload, external_id: result.external_id } }
      if (requeue && job.status !== 'queued') {
        Object.assign(changes, { status: 'queued', retry_count: 0, next_attempt_at: null, last_error: null })
      }
      await queue.update(job.id, changes)
      rewritten++
    } catch (e) {
      failed++
      console.warn(`[syncIds] job ${job?.id}: rewrite failed, left untouched:`, e?.message)
    }
  }
  return { rewritten, dropped, failed }
}
