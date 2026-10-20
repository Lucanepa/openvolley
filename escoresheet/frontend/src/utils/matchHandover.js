/**
 * A match continued on another device (2026-10-20, game 406970: started on
 * the PC, finished on a phone).
 *
 * 1. The scoring device (server db/019, backend lib/scorerDevice.js). A match
 *    is scored on ONE device at a time. The app names its installation
 *    (utils/deviceId, lib/apiClient writingDevice) in every cloud write; the
 *    first device that writes a match scores it. A device that joins the
 *    match (restore by game PIN, a backup restore) or takes it back ("Take
 *    back scoring here") queues a claim (sync_queue { resource: 'match',
 *    action: 'scorer' }). The server then refuses the previous device's
 *    writes with 409 OV_SCORER_MOVED and tells it over the relay
 *    (scorer-moved): its match carries
 *    cloudBlock { code: 'OV_SCORER_MOVED', scorer: { platform, at } } and the
 *    scoring screens show ScorerMovedModal, which only offers "Take back
 *    scoring here" and "Close".
 *
 * 2. The superseded local match. A device that created its own match of the
 *    game first (the phone loaded the game before the PC claimed it) got 409
 *    OV_GAME_TAKEN for it and then joined the cloud match of that game. Its
 *    own copy can never sync (one cloud match per official game): it is
 *    retired, i.e. its unsent jobs are dropped and it is marked final locally
 *    (kept on the device, out of the open matches), so no "refused by the
 *    server" stays up for a match the scorer left. In either order: the join
 *    retires an already refused copy, a refusal that comes after the join
 *    retires the refused copy at once.
 */
import { jobMatchKey } from './syncIds'
import { matchGameNumber } from './deviceMatches'

export const SCORER_MOVED = 'OV_SCORER_MOVED'
export const SCORER_CLAIM_ACTION = 'scorer'
export const GAME_TAKEN = 'OV_GAME_TAKEN'

/** The match is scored on another device now (the server said so). */
export const isScorerMoved = (match) => match?.cloudBlock?.code === SCORER_MOVED

/** The claim job of `match` (null: no seed_key, a test match). */
export function scorerClaimJob(match, now = new Date()) {
  if (!match?.seed_key || match.test === true) return null
  return {
    resource: 'match',
    action: SCORER_CLAIM_ACTION,
    payload: { id: match.seed_key },
    ts: now.toISOString(),
    status: 'queued'
  }
}

/** Queue the claim of `match` for this device. @returns {Promise<number|null>} the job id */
export async function queueScorerClaim(database, match) {
  const job = scorerClaimJob(match)
  if (!job || !database?.sync_queue) return null
  return database.sync_queue.add(job)
}

/**
 * "Take back scoring here": this device scores the match again. The claim is
 * queued (it goes first among the match's jobs, also offline) and the notice
 * is cleared at once, so the scorer can go on; the writes refused meanwhile
 * are queued again once the server confirmed the claim
 * (requeueScorerMovedJobs).
 * @returns {Promise<number|null>} the claim job id
 */
export async function takeBackScoring(database, matchId) {
  const match = await database.matches.get(matchId)
  if (!match) return null
  const jobId = await queueScorerClaim(database, match)
  if (isScorerMoved(match)) await database.matches.update(matchId, { cloudBlock: null })
  return jobId
}

/**
 * After the server confirmed a claim: the match's jobs refused with
 * OV_SCORER_MOVED go back to the queue. @returns {Promise<number>} jobs requeued
 */
export async function requeueScorerMovedJobs(database, seedKey) {
  if (!seedKey) return 0
  const failed = await database.sync_queue.where('status').equals('failed').toArray()
  const ids = failed.filter(j => j.last_error?.code === SCORER_MOVED && jobMatchKey(j) === seedKey).map(j => j.id)
  for (const id of ids) await database.sync_queue.update(id, { status: 'queued', retry_count: 0 })
  return ids.length
}

/**
 * A scorer-moved message from the relay (the server names the match only):
 * ask whether this device still scores it; when not, its match is marked.
 * @param {{ check: (seedKey: string) => Promise<{data?: {mine: boolean|null, scorer?: object}, error?: object}> }} deps
 * @returns {Promise<boolean>} true when the match was marked as moved
 */
export async function noteScorerMoved(database, seedKey, { check, now = Date.now() } = {}) {
  if (!seedKey || typeof check !== 'function') return false
  const local = await database.matches.filter(m => m.seed_key === seedKey).first()
  if (!local || local.test === true || local.status === 'final') return false
  const { data, error } = await check(seedKey)
  if (error || data?.mine !== false) return false
  await database.matches.update(local.id, { cloudBlock: { code: SCORER_MOVED, claim: null, scorer: data.scorer || null, at: now } })
  return true
}

// ---------------------------------------------------------------------------
// Superseded local matches
// ---------------------------------------------------------------------------

/**
 * Did the server refuse `m` because the cloud match `joinedSeedKey` holds its
 * game? A claim of a newer server names the match when it is the account's
 * own (claim.external_id); an older server's claim names none: the game
 * number decides then.
 */
function refusedFor(m, joinedSeedKey) {
  const block = m?.cloudBlock
  if (block?.code !== GAME_TAKEN) return false
  const named = block.claim?.external_id
  return !named || named === joinedSeedKey
}

const OPEN_JOB = ['queued', 'error', 'failed']

/** Drop the unsent jobs of `seedKey` and mark the local match final. */
async function retire(database, m, bySeedKey, now) {
  let dropped = 0
  if (m.seed_key) {
    const jobs = await database.sync_queue.where('status').anyOf(OPEN_JOB).toArray()
    const ids = jobs.filter(j => jobMatchKey(j) === m.seed_key).map(j => j.id)
    for (const id of ids) await database.sync_queue.update(id, { status: 'superseded', superseded_by: bySeedKey })
    dropped = ids.length
  }
  // Final locally like a match the server closed (useSyncQueue closesLocalCopy):
  // kept on the device, no longer an open match on the home screen
  await database.matches.update(m.id, { status: 'final', supersededBy: bySeedKey, supersededAt: new Date(now).toISOString() })
  console.log(`[Handover] Local match ${m.seed_key || m.id} of game ${matchGameNumber(m)} retired: continued as ${bySeedKey} (${dropped} unsent job(s) dropped)`)
  return dropped
}

/**
 * This device joined the cloud match `joined` (its local copy): every other
 * open local match of the same official game that the server refused with
 * OV_GAME_TAKEN for it is retired.
 * @returns {Promise<number[]>} ids of the retired local matches
 */
export async function retireSupersededMatches(database, joined, { now = Date.now() } = {}) {
  const game = matchGameNumber(joined)
  if (!joined?.seed_key || joined.test === true || !game) return []
  const others = (await database.matches.toArray()).filter(m =>
    m.id !== joined.id && m.test !== true && m.status !== 'final' && m.seed_key !== joined.seed_key &&
    matchGameNumber(m) === game && refusedFor(m, joined.seed_key))
  for (const m of others) await retire(database, m, joined.seed_key, now)
  return others.map(m => m.id)
}

// The claim's states of a closed cloud match (db/007): nothing more is scored in it
const CLOSED_STATUSES = ['approved', 'final']

/**
 * The server refused `refused` (a local match) with OV_GAME_TAKEN. It is
 * superseded, and retired at once, when this device has or had the cloud
 * match that holds the game:
 *   - a local copy of it is on the device, open or not (the claim names it;
 *     from an older server, the account's own match of the game that was
 *     restored or joined here);
 *   - or the claim is the account's own match and it is closed (approved /
 *     final): the game was scored and closed by this account, on this device
 *     (Close Match removes the local copy) or another one. The refused copy
 *     can never sync then, and "join with game PIN" would only reopen
 *     nothing.
 * A claim of another account's match, or of the account's own match still
 * being scored elsewhere, keeps the notice: joining with the PIN is the way
 * on. 2026-10-20: the phone's own copy of game 406970 stayed the current
 * match on the home screen with "Not synced: you already score game 406970
 * in another match" after the scorer had scored and closed that match on
 * the phone.
 * @returns {Promise<string|null>} the match key it was retired for
 */
export async function retireIfSuperseded(database, refused, { now = Date.now() } = {}) {
  const block = refused?.cloudBlock
  const game = matchGameNumber(refused)
  if (block?.code !== GAME_TAKEN || refused.test === true || refused.status === 'final' || !game) return null
  const claim = block.claim || {}
  const named = claim.external_id || null
  const joined = (await database.matches.toArray()).find(m =>
    m.id !== refused.id && m.test !== true && !!m.seed_key && m.seed_key !== refused.seed_key &&
    m.cloudBlock?.code !== GAME_TAKEN && matchGameNumber(m) === game &&
    (named ? m.seed_key === named : (claim.mine === true && !!(m.importedFrom || m.restoredAt))))
  if (joined) {
    await retire(database, refused, joined.seed_key, now)
    return joined.seed_key
  }
  if (claim.mine === true && CLOSED_STATUSES.includes(claim.status)) {
    const by = named || `game ${game} (closed)`
    await retire(database, refused, by, now)
    return by
  }
  return null
}

/**
 * Once per app start: every open local match that the server refused with
 * OV_GAME_TAKEN is checked again (retireIfSuperseded), also offline. A copy
 * refused before this version stays retired from now on.
 * @returns {Promise<number>} local matches retired
 */
export async function retireStaleGameCopies(database) {
  const refused = (await database.matches.toArray()).filter(m => m.cloudBlock?.code === GAME_TAKEN && m.status !== 'final' && m.test !== true)
  let n = 0
  for (const m of refused) if (await retireIfSuperseded(database, m)) n++
  return n
}
