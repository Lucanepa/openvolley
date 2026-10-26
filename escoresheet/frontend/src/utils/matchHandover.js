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
 *    scoring here" and "Close". Its unsent writes of the match are set aside
 *    (never sent over the other device's score); taking it back loads the
 *    cloud copy first.
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
 *
 * 3. Closed on the server. Once the server has closed a match (approved /
 *    final, db/007) it refuses every write of its score with 409
 *    OV_MATCH_CLOSED. 2026-10-23, match 406970: a phone's live copy of the
 *    closed match kept its refused restore 'failed' for days ("Refused by the
 *    server", Retry all did nothing), and that job held back every newer
 *    write of the match. Now the first refusal sets aside every unsent write
 *    of the match (status 'superseded', superseded_by 'server-closed'): no
 *    lasting error, and the local sets and events stay. They are sent again
 *    only once the server has the match open again (Match End's Reopen match
 *    finds it open, or an admin reopens it there). Devices stuck before this
 *    version are cleared at app start, offline too (setAsideClosedCopies).
 */
import { jobMatchKey } from './syncIds'
import { matchGameNumber } from './deviceMatches'
import { isClosingSyncJob } from './matchReopen'
import { randomUuid } from './deviceId'

export const SCORER_MOVED = 'OV_SCORER_MOVED'
export const SCORER_CLAIM_ACTION = 'scorer'
export const GAME_TAKEN = 'OV_GAME_TAKEN'
// superseded_by of the jobs a device set aside when another one took the match over
export const SCORER_MOVED_BY = 'scorer-moved'
export const MATCH_CLOSED = 'OV_MATCH_CLOSED'
// superseded_by of the jobs set aside because the server has closed their match
export const SERVER_CLOSED_BY = 'server-closed'
// Jobs not sent yet (a retry would send them)
const OPEN_JOB = ['queued', 'error', 'failed']

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
 * This device's claim of `matchId` on the venue relays: a random id kept on
 * the local match (scorerClaim) and sent with each relay sync (device.claim,
 * see relaySyncDevice). A venue relay has no database to tell the scorer
 * from the device it left (the game PIN is known to both): it remembers which
 * claim each device scored the room with, and once another device took the
 * room over, refuses a sync that still carries the claim it took over
 * (lanRelayCore, backend --local). The claim is made on the first sync and
 * kept; continuing a match makes a new one: a restore by game PIN and "Take
 * back scoring here" import a new local match, and a backup restore clears
 * it. One transaction, so the scoreboard's and the app's syncs never make
 * two. null: no such match (or no storage).
 */
export async function scorerClaimOf(database, matchId) {
  return (await scorerClaimRecord(database, matchId))?.claim ?? null
}

/** scorerClaimOf with the claims the match was continued from: { claim, supersedes } or null. */
async function scorerClaimRecord(database, matchId) {
  if (matchId == null || !database?.matches) return null
  try {
    return await database.transaction('rw', database.matches, async () => {
      const row = await database.matches.get(matchId)
      if (!row) return null
      const supersedes = olderClaims(row.supersededClaims)
      if (typeof row.scorerClaim === 'string' && row.scorerClaim) return { claim: row.scorerClaim, supersedes }
      const claim = randomUuid()
      await database.matches.update(matchId, { scorerClaim: claim })
      return { claim, supersedes }
    })
  } catch {
    return null
  }
}

// The claims a sync names as the copies the match was continued from (the
// venue relays read at most 8)
const MAX_SUPERSEDED_CLAIMS = 8
const olderClaims = (list) => (Array.isArray(list)
  ? [...new Set(list.filter(c => typeof c === 'string' && c && c.length <= 64))].slice(0, MAX_SUPERSEDED_CLAIMS)
  : [])

/**
 * The claims a match continued from the copy `match` (a backup file's match
 * row) supersedes: that copy's claim, then the ones it superseded itself,
 * newest first. Kept on the restored match (supersededClaims) and sent with
 * each relay sync (device.supersedes): a venue relay refuses those older
 * copies even after a restart of the relay, when it no longer remembers
 * which device took the room over from which (2026-10-27: after a restart,
 * a laptop's older copy synced after the phone that had continued the match
 * from its backup took the room for good).
 * @param {object|null} match
 * @returns {string[]}
 */
export function supersededClaimsOf(match) {
  return olderClaims([match?.scorerClaim, ...(Array.isArray(match?.supersededClaims) ? match.supersededClaims : [])])
}

/**
 * The `device` of a relay sync of `matchId`: this installation (`device`,
 * apiClient writingDevice: the cloud relay checks it against the database,
 * db/019) with its claim of the match for the venue relays (scorerClaimOf)
 * and the claims of the copies it continued the match from (supersedes, see
 * supersededClaimsOf). null without a device id; without a claim, the device
 * alone.
 */
export async function relaySyncDevice(database, matchId, device) {
  if (!device) return null
  const record = await scorerClaimRecord(database, matchId)
  if (!record?.claim) return device
  const supersedes = record.supersedes.filter(c => c !== record.claim)
  return supersedes.length ? { ...device, claim: record.claim, supersedes } : { ...device, claim: record.claim }
}

// The jobs that write a match's score (the server checks the scoring device
// of these: matches, sets, events, live state; never "My Matches")
const SCORING_RESOURCES = ['match', 'set', 'event']
const UNSENT_CLAIM = ['queued', 'sending', 'error']

/**
 * Has this device asked to score `seedKey` without an answer yet (a claim
 * queued, in flight or waiting out a backoff)? Until the server confirmed it,
 * an OV_SCORER_MOVED answer to its writes only says the claim is not through
 * yet: retried, never the "scored on another device" notice.
 */
export async function hasUnsentClaim(database, seedKey) {
  if (!seedKey || !database?.sync_queue) return false
  const jobs = await database.sync_queue.where('status').anyOf(UNSENT_CLAIM).toArray()
  return jobs.some(j => j.resource === 'match' && j.action === SCORER_CLAIM_ACTION && jobMatchKey(j) === seedKey)
}

/**
 * This device no longer scores `seedKey`: its unsent writes of the match are
 * set aside (status 'superseded', superseded_by 'scorer-moved'). Sent later,
 * they would write this device's older score over the other device's (on a
 * take-back, or once the server stops checking a closed match), and kept as
 * 'failed' they stay a lasting "refused by the server". The local match keeps
 * its sets and events; "Take back scoring here" loads the cloud copy anyway.
 * @returns {Promise<number>} jobs set aside
 */
export async function setAsideMovedJobs(database, seedKey) {
  if (!seedKey || !database?.sync_queue) return 0
  const jobs = await database.sync_queue.where('status').anyOf(OPEN_JOB).toArray()
  const ids = jobs.filter(j => SCORING_RESOURCES.includes(j.resource) && jobMatchKey(j) === seedKey).map(j => j.id)
  for (const id of ids) await database.sync_queue.update(id, { status: 'superseded', superseded_by: SCORER_MOVED_BY })
  return ids.length
}

// The writes set aside when the server has closed their match. Never a claim
// (a closed match answers it as done, and hasUnsentClaim reads it) and never
// a delete (a match delete answered "closed" is done: the local copy is gone).
const isClosedWrite = (j) => SCORING_RESOURCES.includes(j.resource) && j.action !== SCORER_CLAIM_ACTION && j.action !== 'delete'

/**
 * The server has closed `seedKey` (409 OV_MATCH_CLOSED): its unsent writes,
 * restores and writes of a local copy that is gone included, are set aside
 * (status 'superseded', superseded_by 'server-closed'). The server would
 * refuse each of them, and one kept as 'failed' is a lasting "Refused by the
 * server" that holds back every newer write of the match (2026-10-23). The
 * local sets and events stay; requeueClosedJobs sends the writes again once
 * the server has the match open. A "My Matches" link still goes; a write in
 * flight is left to its sender. A closing write (approved / final) is not
 * set aside: the server still takes approved -> final on a closed match
 * (db/007), and
 * Close match queues 'final' after deleting the local copy, so an older
 * write of the match refused later must not take it along (the match would
 * stay 'approved' for good, missing from the public finished list). If the
 * server refuses it, the queue sets it aside on its own (recordCloudBlock).
 * @returns {Promise<number>} jobs set aside
 */
export async function setAsideClosedJobs(database, seedKey) {
  if (!seedKey || !database?.sync_queue) return 0
  const jobs = await database.sync_queue.where('status').anyOf(OPEN_JOB).toArray()
  const ids = jobs.filter(j => isClosedWrite(j) && !isClosingSyncJob(j) && jobMatchKey(j) === seedKey).map(j => j.id)
  for (const id of ids) await database.sync_queue.update(id, { status: 'superseded', superseded_by: SERVER_CLOSED_BY })
  return ids.length
}

/**
 * Once per app start, offline too: the unsent writes of every local match the
 * server refused as closed are set aside, and so is every write an older
 * version parked as 'failed' with OV_MATCH_CLOSED (the phone of 2026-10-23,
 * its restore refused since 2026-10-20). The parked write alone, not its
 * match's others: a match without the block may have been reopened since.
 * @returns {Promise<number>} jobs set aside
 */
export async function setAsideClosedCopies(database) {
  if (!database?.sync_queue || !database?.matches) return 0
  let n = 0
  const blocked = (await database.matches.toArray()).filter(m => m.test !== true && !!m.seed_key && m.cloudBlock?.code === MATCH_CLOSED)
  for (const m of blocked) n += await setAsideClosedJobs(database, m.seed_key)
  const parked = await database.sync_queue.where('status').equals('failed').toArray()
  for (const j of parked) {
    if (!isClosedWrite(j) || j.last_error?.code !== MATCH_CLOSED) continue
    await database.sync_queue.update(j.id, { status: 'superseded', superseded_by: SERVER_CLOSED_BY })
    n++
  }
  return n
}

// A write set aside as closed: with the match's others ('superseded'), or the
// refused write itself, which the queue stores as 'dropped' (the mark stays)
const SET_ASIDE = ['superseded', 'dropped']
const jobTime = (j) => (typeof j.ts === 'number' ? j.ts : Date.parse(j.ts))

/**
 * The server has `seedKey` open again (an admin reopened it): the writes set
 * aside as closed are queued again, in place (same ids, so the same order).
 * Callers use it only when the server is known to have the match open. Two
 * kinds stay aside: a closing write (approved / final), which would close the
 * match the scorer has just reopened, and the writes of an older local copy.
 * A copy loaded from the cloud or restored from a backup after them (`since`:
 * its importedAt / restoredAt) replaced the rows they describe.
 * @param {{ since?: string|number|null }} [options]
 * @returns {Promise<number>} jobs queued again
 */
export async function requeueClosedJobs(database, seedKey, { since = null } = {}) {
  if (!seedKey || !database?.sync_queue) return 0
  const from = since == null ? NaN : (typeof since === 'number' ? since : Date.parse(since))
  const jobs = await database.sync_queue.where('status').anyOf(SET_ASIDE).toArray()
  const ids = jobs.filter(j => j.superseded_by === SERVER_CLOSED_BY && jobMatchKey(j) === seedKey && !isClosingSyncJob(j) &&
    (!Number.isFinite(from) || jobTime(j) >= from)).map(j => j.id)
  for (const id of ids) await database.sync_queue.update(id, { status: 'queued', retry_count: 0, superseded_by: null })
  return ids.length
}

/**
 * The server said another device scores `local` now (409 OV_SCORER_MOVED, or
 * the relay nudge confirmed by POST /api/match/scorer): the match carries the
 * block (ScorerMovedModal) and its unsent writes are set aside. A match the
 * server has closed meanwhile is final here too (no longer an open match).
 * @param {{ scorer?: object|null, closed?: boolean, now?: number }} info
 */
export async function markScorerMoved(database, local, { scorer = null, closed = false, now = Date.now() } = {}) {
  if (!local?.id) return 0
  const prev = isScorerMoved(local) ? local.cloudBlock : null
  const block = { code: SCORER_MOVED, claim: null, scorer: scorer || prev?.scorer || null, at: prev?.at || now, ...(closed || prev?.closed ? { closed: true } : {}) }
  await database.matches.update(local.id, { cloudBlock: block, ...(block.closed && local.status !== 'final' ? { status: 'final' } : {}) })
  return setAsideMovedJobs(database, local.seed_key)
}

/**
 * "Take back scoring here": this device scores the match again, from the
 * score the other device left in the cloud. Its own copy is older (it
 * stopped when the other device took over), so the cloud match is loaded
 * first, the same as a join with the game PIN (the local match is replaced
 * and the claim queued, backupManager.importMatchFromSupabase), and the
 * scoring screens open the replaced match. Needs a connection and the game
 * PIN the device kept; a match closed meanwhile loads as closed (its Match
 * End), the claim then has nothing to take.
 * @param {{ fetchCloud: (pin: string, gameN: number|string, options: { claim: boolean, externalId: string }) => Promise<object>, importCloud: (cloudData: object) => Promise<number>, online?: boolean }} deps
 * @returns {Promise<{ ok: true, matchId: number, cloud: object } | { ok: false, reason: 'offline'|'noPin'|'notFound'|'otherMatch'|'failed', message?: string }>}
 */
export async function takeBackScoring(database, matchId, { fetchCloud, importCloud, online = true } = {}) {
  const match = await database.matches.get(matchId)
  if (!match?.seed_key) return { ok: false, reason: 'notFound' }
  const pin = match.gamePin ?? match.game_pin
  const gameN = match.gameN ?? match.game_n ?? match.gameNumber
  if (pin == null || String(pin).trim() === '' || gameN == null || gameN === '') return { ok: false, reason: 'noPin' }
  if (!online) return { ok: false, reason: 'offline' }
  let cloud
  try {
    // with the claim: the server makes this device the scorer before it
    // reads the match (signed in or not), this match only
    cloud = await fetchCloud(String(pin).trim(), gameN, { claim: true, externalId: match.seed_key })
  } catch (err) {
    return { ok: false, reason: err?.network || err?.status === 0 ? 'offline' : 'failed', message: err?.message }
  }
  if (!cloud?.match) return { ok: false, reason: 'notFound' }
  // The game PIN names the game: never load another match over this one
  if (cloud.match.external_id && cloud.match.external_id !== match.seed_key) return { ok: false, reason: 'otherMatch' }
  const newId = await importCloud(cloud)
  if (newId == null) return { ok: false, reason: 'failed' }
  console.log(`[Handover] ${match.seed_key}: scoring taken back on this device from the cloud copy`)
  return { ok: true, matchId: newId, cloud }
}

/**
 * A scorer-moved message from the relay (the server names the match only):
 * ask whether this device still scores it; when not, its match is marked
 * (markScorerMoved). A device that asked to score it and has no answer yet
 * is not marked: the nudge is about its own claim's predecessor.
 * @param {{ check: (seedKey: string) => Promise<{data?: {mine: boolean|null, closed?: boolean, scorer?: object}, error?: object}> }} deps
 * @returns {Promise<boolean>} true when the match was marked as moved
 */
export async function noteScorerMoved(database, seedKey, { check, now = Date.now() } = {}) {
  if (!seedKey || typeof check !== 'function') return false
  const local = await database.matches.filter(m => m.seed_key === seedKey).first()
  if (!local || local.test === true || local.status === 'final') return false
  if (await hasUnsentClaim(database, seedKey)) return false
  const { data, error } = await check(seedKey)
  if (error || data?.mine !== false) return false
  await markScorerMoved(database, local, { scorer: data.scorer || null, closed: data.closed === true, now })
  return true
}

/**
 * At app start (online): a match this device lost to another one is asked
 * about again. Once the server has closed it, it is final here too: no
 * longer an open match, nothing of it left to send.
 * @returns {Promise<number>} local matches marked final
 */
export async function closeMovedMatches(database, { check }) {
  if (typeof check !== 'function') return 0
  const moved = (await database.matches.toArray()).filter(m => isScorerMoved(m) && m.status !== 'final' && m.test !== true && m.seed_key)
  let n = 0
  for (const m of moved) {
    const { data, error } = await check(m.seed_key)
    if (error || data?.closed !== true) continue
    await markScorerMoved(database, m, { scorer: data.scorer || null, closed: true })
    n++
  }
  return n
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
