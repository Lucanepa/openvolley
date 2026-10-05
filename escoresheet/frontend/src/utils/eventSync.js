/**
 * Cloud sync jobs for scoreboard writes that do not go through logEvent:
 * set_start and lineup events, the running score of the open set, and the
 * match row's current_set / set_results at every set end.
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

/** A live-state write error worth an error dialog (not offline, signed out or a backend hiccup). */
export function isLiveStateErrorWorthAlert(error) {
  if (!error || error.network) return false
  const status = error.status ?? 0
  return !(status === 0 || status === 401 || status === 429 || status >= 500)
}
