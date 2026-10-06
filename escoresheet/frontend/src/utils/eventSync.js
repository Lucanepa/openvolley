/**
 * Cloud sync jobs for scoreboard writes that do not go through logEvent:
 * set_start and lineup events, the running score of the open set, the
 * match row's current_set / set_results at every set end, and the reverse of
 * that when a set end is undone.
 *
 * Every job is an ordinary sync_queue row (offline-first: written to IndexedDB,
 * sent by useSyncQueue when the cloud is reachable). Test matches and matches
 * without a seed_key never get jobs. Nothing here may throw into the scoring
 * flow: a failure to queue is logged and the local write stands.
 */
import { eventExtId, setExtId } from './syncIds'

// Set update fields that only carry the running score: a newer score of the
// same set makes an older, still queued one pointless.
const SCORE_ONLY_KEYS = new Set(['external_id', 'home_points', 'away_points', 'sport_type'])

export function isScoreOnlySetUpdate(job, setExternalId) {
  return job?.resource === 'set' && job.action === 'update' && job.status === 'queued' &&
    job.payload?.external_id === setExternalId &&
    Object.keys(job.payload).every(k => SCORE_ONLY_KEYS.has(k))
}

/** sync_queue row for an event written straight to Dexie. */
export function buildEventInsertJob(event, match) {
  return {
    resource: 'event',
    action: 'insert',
    payload: {
      external_id: eventExtId(match.seed_key, event.id),
      match_id: match.seed_key,
      set_index: event.setIndex ?? null,
      type: event.type,
      payload: event.payload || {},
      seq: event.seq ?? null,
      test: false,
      created_at: event.ts || new Date().toISOString()
    },
    ts: Date.now(),
    status: 'queued'
  }
}

/**
 * Queue a locally written event (set_start, lineup) for the cloud.
 * @returns {Promise<boolean>} true when a job was queued
 */
export async function queueEventSync(db, eventId) {
  try {
    if (eventId == null) return false
    const event = await db.events.get(eventId)
    if (!event) return false
    const match = await db.matches.get(event.matchId)
    if (!match || match.test || !match.seed_key) return false
    await db.sync_queue.add(buildEventInsertJob(event, match))
    return true
  } catch (err) {
    console.warn('[eventSync] could not queue event', eventId, err?.message)
    return false
  }
}

/**
 * Queue the running score of a set (the cloud row used to stay 0:0 until the
 * set ended). Older, still queued score-only updates of the same set are
 * dropped first, so a long offline period sends one update per set, not one
 * per rally.
 * @returns {Promise<boolean>} true when a job was queued
 */
export async function queueSetScoreSync(db, { matchId, setIndex }) {
  try {
    const match = await db.matches.get(matchId)
    if (!match || match.test || !match.seed_key) return false
    const set = await db.sets.where('matchId').equals(matchId).and(s => s.index === setIndex).first()
    if (!set) return false
    const externalId = setExtId(match.seed_key, set.id)
    const stale = await db.sync_queue.where('status').equals('queued')
      .and(j => isScoreOnlySetUpdate(j, externalId))
      .toArray()
    if (stale.length > 0) await db.sync_queue.bulkDelete(stale.map(j => j.id))
    await db.sync_queue.add({
      resource: 'set',
      action: 'update',
      payload: {
        external_id: externalId,
        home_points: set.homePoints || 0,
        away_points: set.awayPoints || 0
      },
      ts: Date.now(),
      status: 'queued'
    })
    return true
  } catch (err) {
    console.warn('[eventSync] could not queue the set score', matchId, setIndex, err?.message)
    return false
  }
}

/**
 * The matches row update sent at a set end. Every set end moves current_set on
 * and publishes the finished sets (livescore reads set_results from the match);
 * status/winner/final_score are added only at the match end.
 */
export function buildSetEndMatchPayload({ seedKey, finishedSets, isMatchEnd, nextSetIndex, homeSetsWon, awaySetsWon, sanctions }) {
  const setResults = [...(finishedSets || [])]
    .sort((a, b) => a.index - b.index)
    .map(s => ({ set: s.index, home: s.homePoints, away: s.awayPoints }))
  if (isMatchEnd) {
    return {
      id: seedKey,
      status: 'ended',
      set_results: setResults,
      winner: homeSetsWon > awaySetsWon ? 'home' : 'away',
      final_score: `${homeSetsWon}-${awaySetsWon}`,
      sanctions: sanctions || null
    }
  }
  return {
    id: seedKey,
    current_set: nextSetIndex,
    set_results: setResults
  }
}

/**
 * The matches row update sent when a set end is undone: the reopened set is the
 * current one again and set_results lists only the sets still finished. When
 * the undone set end had ended the match, the result fields are cleared too.
 */
export function buildSetReopenMatchPayload({ seedKey, finishedSets, reopenedSetIndex, wasMatchEnd = false }) {
  const setResults = [...(finishedSets || [])]
    .filter(s => s.index !== reopenedSetIndex)
    .sort((a, b) => a.index - b.index)
    .map(s => ({ set: s.index, home: s.homePoints, away: s.awayPoints }))
  return {
    id: seedKey,
    current_set: reopenedSetIndex,
    set_results: setResults,
    ...(wasMatchEnd ? { status: 'live', winner: null, final_score: null } : {})
  }
}

/**
 * Queue the cloud side of an undone set end: the set row is open again (score,
 * finished false, no end time) and the match row's current_set / set_results
 * (written at every set end) go back. Call it after the local undo (the next
 * set deleted, the reopened set unfinished).
 * @returns {Promise<boolean>} true when the jobs were queued
 */
export async function queueSetReopenSync(db, { matchId, setIndex, wasMatchEnd = false }) {
  try {
    const match = await db.matches.get(matchId)
    if (!match || match.test || !match.seed_key) return false
    const sets = await db.sets.where('matchId').equals(matchId).toArray()
    const set = sets.find(s => s.index === setIndex)
    if (!set) return false
    const externalId = setExtId(match.seed_key, set.id)
    // The reopen update carries the score: older queued score-only ones go
    const stale = await db.sync_queue.where('status').equals('queued')
      .and(j => isScoreOnlySetUpdate(j, externalId))
      .toArray()
    if (stale.length > 0) await db.sync_queue.bulkDelete(stale.map(j => j.id))
    const ts = Date.now()
    await db.sync_queue.add({
      resource: 'set',
      action: 'update',
      payload: {
        external_id: externalId,
        home_points: set.homePoints || 0,
        away_points: set.awayPoints || 0,
        finished: false,
        end_time: null
      },
      ts,
      status: 'queued'
    })
    await db.sync_queue.add({
      resource: 'match',
      action: 'update',
      payload: buildSetReopenMatchPayload({
        seedKey: match.seed_key,
        finishedSets: sets.filter(s => s.finished),
        reopenedSetIndex: setIndex,
        wasMatchEnd
      }),
      ts,
      status: 'queued'
    })
    return true
  } catch (err) {
    console.warn('[eventSync] could not queue the reopened set', matchId, setIndex, err?.message)
    return false
  }
}

// ----------------------------------------------------------------------------
// match_live_state catch-up
// ----------------------------------------------------------------------------
// The live state is written straight to the backend (not queued: spectators
// need it at once). When that write fails or cannot run (offline, match not in
// the cloud yet, no session) the match is marked "dirty" so the scoreboard
// pushes the current state again when the device is back online or the queue
// drains, instead of leaving livescore on a stale score until the next rally.
// Kept in localStorage so a reload while offline still catches up.

const LIVE_DIRTY_PREFIX = 'ov_live_state_dirty_'

export function setLiveStateDirty(matchKey, dirty) {
  if (matchKey == null) return
  try {
    if (dirty) localStorage.setItem(LIVE_DIRTY_PREFIX + matchKey, '1')
    else localStorage.removeItem(LIVE_DIRTY_PREFIX + matchKey)
  } catch { /* storage blocked: the 'online' push still runs */ }
}

export function isLiveStateDirty(matchKey) {
  if (matchKey == null) return false
  try { return localStorage.getItem(LIVE_DIRTY_PREFIX + matchKey) === '1' } catch { return false }
}

// The server's answers that say "this account may not write this match's live
// state" (not approved, the game is another account's, the match is closed,
// not an owner, or the row belongs to another match). Retrying every rally
// changes nothing, so they never open a dialog: the scoreboard stops pushing
// the cloud live state of that match for a while (LIVE_REFUSAL_PAUSE_MS) or
// until the account's access changes. Local scoring is never blocked.
export const LIVE_STATE_REFUSAL_CODES = Object.freeze([
  'OV_SCORER_REQUIRED', 'OV_MATCH_CLOSED', 'OV_GAME_TAKEN', 'OV_NOT_MATCH_OWNER', 'OV_UNSCOPED_WRITE'
])
export const LIVE_REFUSAL_PAUSE_MS = 5 * 60 * 1000
const liveRefusals = new Map() // matchKey -> { code, at }

/** Is this live-state write error the server refusing the account (see LIVE_STATE_REFUSAL_CODES)? */
export function isLiveStateRefusal(error) {
  if (!error || error.network) return false
  const status = error.status ?? 0
  return (status === 403 || status === 409) && LIVE_STATE_REFUSAL_CODES.includes(error.code)
}

export function markLiveStateRefused(matchKey, code, now = Date.now()) {
  if (matchKey == null) return
  liveRefusals.set(String(matchKey), { code: code || null, at: now })
}

/** The refusal of this match's live state is recent: do not push it to the cloud now. */
export function isLiveStateRefused(matchKey, now = Date.now()) {
  if (matchKey == null) return false
  const r = liveRefusals.get(String(matchKey))
  if (!r) return false
  if (now - r.at >= LIVE_REFUSAL_PAUSE_MS) {
    liveRefusals.delete(String(matchKey))
    return false
  }
  return true
}

/** Forget a refusal (one match, or all when matchKey is omitted): the account's access changed. */
export function clearLiveStateRefused(matchKey) {
  if (matchKey == null) liveRefusals.clear()
  else liveRefusals.delete(String(matchKey))
}

/** A live-state write error worth an error dialog (not offline, signed out, refused or a backend hiccup). */
export function isLiveStateErrorWorthAlert(error) {
  if (!error || error.network) return false
  if (isLiveStateRefusal(error)) return false
  const status = error.status ?? 0
  return !(status === 0 || status === 401 || status === 429 || status >= 500)
}
