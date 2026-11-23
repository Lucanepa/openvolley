/**
 * What the decision change dialog's options leave, for its preview (the new
 * score and who serves). Pure: no React, no Dexie.
 *
 *  - swap:          the last point goes to the other team, who serve next;
 *  - replay:        the last point is taken back and its rally replayed: the
 *                   team that served it serves again. After a side-out that is
 *                   the other team, not the point's (the preview named the
 *                   point's team, plan of 22.11.2026);
 *  - record_replay: continuous play's third option, the rally played since
 *                   the last point was replayed: nothing changes.
 *
 * And the decision change on a replay (owner 23.11.2026: "keep decision
 * change, a replay can change to another decision"): the rally that was
 * replayed is given to a team after all. The point takes the replay's place
 * (the replay goes, the point is recorded as the point buttons record it: a
 * side-out rotates), one action; Undo of that point brings the replay back.
 *  - point_home / point_away: that team scores and serves next;
 *  - record_replay:           continuous play, the rally played since the
 *                             replay was replayed too: nothing changes.
 */
import { servingTeamFromLog, serveBeforePoint } from './rules'
import { isBookkeepingEvent } from './rally'

const otherTeam = (team) => (team === 'home' ? 'away' : 'home')

/**
 * @param {{ events: Array, point: object, score: { home: number, away: number }, match?: object }} args
 *   events: the match's events; point: the last point (the dialog's);
 *   score: the set score now
 * @returns {{ swap: { home: number, away: number, serve: 'home'|'away' },
 *   replay: { home: number, away: number, serve: 'home'|'away' },
 *   record_replay: { home: number, away: number, serve: 'home'|'away' } }}
 */
export function decisionChangeOutcomes({ events, point, score, match = null }) {
  const team = point?.payload?.team === 'away' ? 'away' : 'home'
  const setIndex = point?.setIndex ?? 1
  const home = Number(score?.home) || 0
  const away = Number(score?.away) || 0
  // who served the rally: the log before the point and the rows it wrote
  // (N.x), as the decision change itself reads it (rules serveBeforePoint)
  const serveBefore = serveBeforePoint(events, point, setIndex, match || {})
  const serveNow = servingTeamFromLog(events, setIndex, match || {})
  const minus = (n) => Math.max(0, n - 1)
  return {
    swap: {
      home: team === 'home' ? minus(home) : home + 1,
      away: team === 'away' ? minus(away) : away + 1,
      serve: otherTeam(team)
    },
    replay: {
      home: team === 'home' ? minus(home) : home,
      away: team === 'away' ? minus(away) : away,
      serve: serveBefore
    },
    record_replay: { home, away, serve: serveNow }
  }
}

// Newest last, by seq (events without one by their time), as the scoring
// screen orders the set's events
const timeOf = (e) => (typeof e?.ts === 'number' ? e.ts : new Date(e?.ts).getTime())
function compareEvents(a, b) {
  const as = a?.seq || 0
  const bs = b?.seq || 0
  if (as !== 0 || bs !== 0) return as - bs
  return (timeOf(a) || 0) - (timeOf(b) || 0)
}

/** The decision change options of a replay, per team. */
export const REPLAY_POINT_OPTIONS = Object.freeze({ home: 'point_home', away: 'point_away' })

/** The team a replay dialog's option gives the point to, or null. */
export function teamOfReplayOption(option) {
  if (option === REPLAY_POINT_OPTIONS.home) return 'home'
  if (option === REPLAY_POINT_OPTIONS.away) return 'away'
  return null
}

/**
 * The replay a decision change can turn into a point: the set's last event
 * when it is a replay (the in-play "Replay rally", the decision change
 * "Replay the rally", continuous play's "Rally replayed"), past a remark or a
 * bench injury recorded since (domain/rally isBookkeepingEvent). null when
 * anything else came after it (a sanction, a forced substitution, a libero
 * replacement: Undo first, as after a point) or the set's last event is no
 * replay.
 * @param {Array} events the match's events
 * @param {number} setIndex
 * @returns {object|null} the replay event
 */
export function replayToDecide(events, setIndex) {
  if (setIndex == null) return null
  let last = null
  for (const e of events || []) {
    if (!e || e.setIndex !== setIndex || isBookkeepingEvent(e)) continue
    if (!last || compareEvents(e, last) > 0) last = e
  }
  return last?.type === 'replay' ? last : null
}

/**
 * What the replay dialog's options leave, for its preview: the rally given to
 * a team (it scores and serves next), or (continuous play) recorded as
 * replayed again (nothing changes).
 * @param {{ events: Array, setIndex: number, score: { home: number, away: number }, match?: object }} args
 * @returns {{ point_home: { home: number, away: number, serve: 'home'|'away' },
 *   point_away: { home: number, away: number, serve: 'home'|'away' },
 *   record_replay: { home: number, away: number, serve: 'home'|'away' } }}
 */
export function replayDecisionOutcomes({ events, setIndex, score, match = null }) {
  const home = Number(score?.home) || 0
  const away = Number(score?.away) || 0
  return {
    point_home: { home: home + 1, away, serve: 'home' },
    point_away: { home, away: away + 1, serve: 'away' },
    record_replay: { home, away, serve: servingTeamFromLog(events, setIndex ?? 1, match || {}) }
  }
}

/**
 * The replay as the point that took its place keeps it for Undo (the point
 * row's local `_replacedReplay`: bookkeeping, never sent; a replay is never
 * sent either, domain/eventRevisions LOCAL_ONLY_EVENT_TYPES): the row without
 * its state copies.
 * @param {object} replay the replay event
 */
export function replacedReplayRecord(replay) {
  if (!replay || replay.type !== 'replay') return null
  const { stateSnapshot: _snapshot, stateBefore: _before, ...row } = replay
  return { ...row, payload: { ...(replay.payload || {}) } }
}

/**
 * Undo of a point: does the rally_start before it (domain/rally
 * rallyStartOfPoint) go with it? Yes, unless the point took a replay's place
 * (replacedReplayRecord) and that rally_start opened the replayed rally: it
 * stays with the replay Undo brings back. One the point wrote itself
 * (continuous play: newer than the replay) goes.
 * @param {object} point the point row (with its `_replacedReplay`, if any)
 * @param {object|null} rallyStart
 */
export function rallyStartGoesWithPoint(point, rallyStart) {
  if (!rallyStart) return false
  const replay = point?._replacedReplay
  if (!replay) return true
  return compareEvents(rallyStart, replay) > 0
}
