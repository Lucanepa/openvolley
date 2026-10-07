/**
 * Event history (undo, deletes and edits of logged events) — pure helpers, no
 * Dexie, no React. db/eventHistory.js builds the rows with these from its
 * table hooks; the server receives them through POST /api/match/event-revisions.
 *
 * A history row:
 *   { revUid, matchId, eventId, eventExt|null, seq, setIndex, type,
 *     op: 'void'|'edit'|'restore', reason, before, after?, changed?,
 *     actionId|null, ts, deviceId, accountId|null, appVersion }
 * `before` / `after` never carry the state snapshot (large, and the server
 * never gets it).
 */

export const REVISION_REASONS = Object.freeze([
  'undo', 'delete', 'decision_change', 'manual_adjustment',
  'forfeit_reversal', 'reopen_set', 'roster_reopen', 'correction', 'other'
])

// The undo record a decision change writes into its own event once the swap
// is done (domain/corrections decisionChangeUndoRecord): local bookkeeping,
// not an edit of the scoresheet
const DECISION_UNDO_KEYS = Object.freeze(['pointEventId', 'pointPayloadBefore', 'removedSubEvents', 'createdSubEventIds'])

export const REVISION_OPS = Object.freeze(['void', 'edit', 'restore'])

// Events the scoreboard never sends to the server (lightweight: no snapshot,
// no sync job). Their history stays local: a void would only tell the server
// about a row it never had.
export const LOCAL_ONLY_EVENT_TYPES = Object.freeze(['rally_start', 'replay'])

// Keys of an event row that are bookkeeping, not scoresheet content
const BOOKKEEPING_KEY = /^_|synced/i

/** A known reason, else the fallback ('delete' for a void, 'other' for an edit). */
export function normalizeReason(reason, fallback = 'other') {
  return REVISION_REASONS.includes(reason) ? reason : fallback
}

export const valueAt = (obj, keyPath) =>
  String(keyPath).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)

export function sameValue(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/** A JSON copy (events are plain data); null when it cannot be copied. */
export function plainCopy(value) {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

/** The event row without its state snapshot (and without bookkeeping keys). */
export function withoutSnapshot(event) {
  if (!event || typeof event !== 'object') return null
  const out = {}
  for (const [k, v] of Object.entries(event)) {
    if (k === 'stateSnapshot' || BOOKKEEPING_KEY.test(k)) continue
    out[k] = v
  }
  return plainCopy(out)
}

const isEmptySnapshot = (s) => s == null || (typeof s === 'object' && Object.keys(s).length === 0)
const topKey = (k) => String(k).split('.')[0]

/**
 * The key paths an update really changes, ignoring bookkeeping keys and values
 * equal to the stored ones (Dexie's diff compares arrays by reference).
 * @param {object} mods  key paths -> new values (Dexie updating hook)
 * @param {object} stored the row before the update
 */
export function changedKeys(mods, stored) {
  return Object.keys(mods || {})
    .filter(k => !BOOKKEEPING_KEY.test(topKey(k)))
    .filter(k => !sameValue(mods[k], valueAt(stored, k)))
}

/**
 * The edit an update makes, or null when it is not one: nothing changed but
 * bookkeeping, or it only fills in the state snapshot of a freshly logged event
 * (logEvent adds the event, then its snapshot). Rewriting an EXISTING snapshot
 * (a corrected "score at the time of the event") is an edit.
 * @returns {null | string[]} the changed key paths
 */
export function editOf(mods, stored) {
  let changed = changedKeys(mods, stored)
  if (isEmptySnapshot(stored?.stateSnapshot)) changed = changed.filter(k => topKey(k) !== 'stateSnapshot')
  if (changed.length && onlyDecisionUndoRecord(changed, mods, stored)) return null
  return changed.length ? changed : null
}

const withoutUndoRecord = (payload) => {
  const out = { ...(payload && typeof payload === 'object' ? payload : {}) }
  for (const k of DECISION_UNDO_KEYS) delete out[k]
  return out
}

/** A decision_change event getting its undo record (and nothing else) written in. */
function onlyDecisionUndoRecord(changed, mods, stored) {
  if (stored?.type !== 'decision_change') return false
  return changed.every(k => {
    const parts = String(k).split('.')
    if (parts[0] !== 'payload') return false
    if (parts.length > 1) return DECISION_UNDO_KEYS.includes(parts[1])
    return sameValue(withoutUndoRecord(mods.payload), withoutUndoRecord(stored.payload))
  })
}

/** The row after an update: the stored row with `mods` applied (key paths). */
export function applyMods(stored, mods, setByKeyPath) {
  const after = plainCopy(stored) || {}
  for (const [k, v] of Object.entries(mods || {})) {
    if (typeof setByKeyPath === 'function') {
      setByKeyPath(after, k, plainCopy(v))
    } else {
      const parts = k.split('.')
      let o = after
      for (let i = 0; i < parts.length - 1; i++) {
        if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {}
        o = o[parts[i]]
      }
      if (v === undefined) delete o[parts[parts.length - 1]]
      else o[parts[parts.length - 1]] = plainCopy(v)
    }
  }
  return after
}

/** Team A / Team B score of a snapshot (full snapshots: pointsA/B; manual entries: scoreA/B). */
export function snapshotScore(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null
  const a = snapshot.pointsA ?? snapshot.scoreA
  const b = snapshot.pointsB ?? snapshot.scoreB
  if (!Number.isFinite(Number(a)) || !Number.isFinite(Number(b)) || a === null || b === null) return null
  return { a: Number(a), b: Number(b) }
}

// Nested state snapshots (a decision change's removed sub-events) never go to the server
function dropNestedSnapshots(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? {}, (k, v) => (k === 'stateSnapshot' ? undefined : v)))
  } catch {
    return {}
  }
}

const TEAMS = ['home', 'away']

/**
 * The running score (Team A / Team B) after this event, as the server keeps
 * it in score_a / score_b: the event's snapshot score, with the point moved
 * when the edit gave a point to the other team (a decision change).
 *
 * A point's snapshot is taken when the point is logged and never rewritten,
 * so it counts the point for the team it was logged for: the swap's
 * `swappedFrom` when the point was swapped, else the team before this edit.
 * When the edit's team differs from that one, one point moves from it to
 * the new team (Team A = snapshot.teamAKey) — the score the points after the
 * edit add up to. Null (no score columns) when that cannot be told.
 */
export function runningScoreAfterEdit(before, after) {
  const row = after || before || {}
  const score = snapshotScore(row.stateSnapshot)
  if (!score) return null
  if (row.type !== 'point' || !before || !after) return score
  // The edit rewrote the snapshot itself: it is the score to send
  if (!sameValue(before.stateSnapshot, after.stateSnapshot)) return score
  const loggedFor = before.payload?.swappedFrom ?? after.payload?.swappedFrom ?? before.payload?.team
  const now = after.payload?.team
  if (!TEAMS.includes(loggedFor) || !TEAMS.includes(now) || loggedFor === now) return score
  const teamA = row.stateSnapshot?.teamAKey
  if (!TEAMS.includes(teamA)) return null
  const delta = now === teamA ? 1 : -1
  return { a: Math.max(0, score.a + delta), b: Math.max(0, score.b - delta) }
}

/**
 * The server columns an edit writes: { type, set_index, seq, payload,
 * score_a?, score_b? } — the score is the running score after the event
 * (runningScoreAfterEdit). Never state_snapshot.
 * @param {object} before the full local row before the edit
 * @param {object} after  the full local row after the edit
 */
export function serverColumnsOfEdit(before, after) {
  const row = after || before || {}
  const out = {
    type: typeof row.type === 'string' ? row.type : null,
    set_index: Number.isFinite(Number(row.setIndex)) ? Number(row.setIndex) : null,
    payload: dropNestedSnapshots(row.payload)
  }
  if (row.seq != null && Number.isFinite(Number(row.seq))) out.seq = Number(row.seq)
  const score = runningScoreAfterEdit(before, after)
  if (score) {
    out.score_a = score.a
    out.score_b = score.b
  }
  return out
}

/**
 * The sync_queue job of one history row, or null when the server must not get
 * it (test match, no seed_key yet, an event type never sent).
 * @param {object} row  history row (see the module comment)
 * @param {{seedKey?:string, test?:boolean}} match
 * @param {(seed:string, id:any)=>string} eventExtId
 */
export function revisionSyncJob(row, match, eventExtId) {
  const seed = match?.seedKey
  if (!row || !seed || match?.test === true) return null
  if (LOCAL_ONLY_EVENT_TYPES.includes(row.type)) return null
  if (!REVISION_OPS.includes(row.op)) return null
  const payload = {
    external_id: eventExtId(seed, row.eventId),
    match_id: seed,
    rev_uid: row.revUid,
    op: row.op,
    reason: row.reason,
    seq: row.seq ?? null,
    set_index: row.setIndex ?? null,
    type: row.type ?? null,
    client_ts: row.ts,
    device_id: row.deviceId ?? null,
    app_version: row.appVersion ?? null
  }
  if (row.op !== 'void' && row.serverAfter) payload.after = row.serverAfter
  return { resource: 'event', action: row.op, status: 'queued', ts: Date.now(), payload }
}

/**
 * The revision the server route takes, from a job payload.
 * @returns {object|null}
 */
export function revisionOfJob(payload) {
  if (!payload || typeof payload !== 'object') return null
  const op = payload.op
  if (!REVISION_OPS.includes(op) || !payload.rev_uid || !payload.external_id) return null
  const out = {
    rev_uid: payload.rev_uid,
    op,
    event_external_id: payload.external_id,
    reason: normalizeReason(payload.reason, op === 'void' ? 'delete' : 'other'),
    seq: payload.seq ?? null,
    set_index: payload.set_index ?? null,
    type: payload.type ?? null,
    client_ts: payload.client_ts,
    device_id: payload.device_id ?? null,
    app_version: payload.app_version ?? null
  }
  if (op !== 'void' && payload.after) out.after = payload.after
  return out
}
