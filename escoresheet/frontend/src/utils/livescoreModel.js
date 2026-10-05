/**
 * Livescore view model: when a match counts as live, where its set results
 * come from, and when the page may skip the server-connection screen.
 * Pure functions; LivescoreApp.jsx wires them to state.
 *
 * ── When is a match "live"? ────────────────────────────────────────────────
 * The scoreboard upserts match_live_state on key events (Scoreboard.jsx
 * logEvent keyEvents + syncLiveStateToSupabase). The first upsert happens at
 * the first lineup confirm, before Start Set, with match_status 'in_progress'
 * at 0:0, set 1. In the event model a match starts with set 1's set_start
 * (Start Set), and the first rally/point follows. The live-state row does not
 * carry set_start itself (set_start is written straight to Dexie, not through
 * logEvent), so livescore decides from what the row does carry:
 *
 *   started  = any point or set already played (points, sets won, set > 1),
 *              or a status only an in-play match has (interval, timeout,
 *              ended/final), or a last event that is not a setup event.
 *   setup    = lineup, rotation, coin toss, court captain, manual side/serve
 *              changes: what the scorer does before Start Set.
 *   explicit pre-start statuses (pre_match, scheduled, not_started) are never
 *   live, so a scoreboard that starts writing one is honoured as is.
 *
 * A match the list has already shown as started stays listed for the rest of
 * the session (an undo back to 0:0 must not make it vanish).
 */

export const isEndedStatus = (status) => status === 'ended' || status === 'final'

const PRE_START_STATUSES = new Set(['pre_match', 'scheduled', 'not_started', 'setup'])
const IN_PLAY_STATUSES = new Set(['interval', 'timeout'])

/** Live-state event types the scorer produces while setting up, before Start Set. */
export const SETUP_EVENT_TYPES = Object.freeze([
  'lineup',
  'rotation',
  'coin_toss',
  'court_captain_designation',
  'court_captain_cleared',
  'manual_side_change',
  'manual_serve_change'
])
const SETUP_EVENTS = new Set(SETUP_EVENT_TYPES)

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/**
 * True once the match is under way (Start Set pressed and something
 * happened) or finished. See the header for the rule.
 * @param {object} game  a match_live_state row
 */
export function hasMatchStarted(game) {
  if (!game) return false
  const status = game.match_status
  if (PRE_START_STATUSES.has(status)) return false
  if (isEndedStatus(status) || IN_PLAY_STATUSES.has(status)) return true
  if (game.set_interval_active || game.timeout_active) return true
  if (num(game.sets_won_a) + num(game.sets_won_b) > 0) return true
  if (num(game.points_a) + num(game.points_b) > 0) return true
  if (num(game.current_set) > 1) return true
  const ev = game.last_event_type
  if (!ev) return false
  return !SETUP_EVENTS.has(ev)
}

/**
 * The games the livescore list shows: started (or finished) matches, plus any
 * match already shown as started in this session.
 * @param {object[]} games
 * @param {Set<string>} [shown]  match_ids already shown as started; updated in place
 * @returns {object[]}
 */
export function listedGames(games, shown = new Set()) {
  return (games || []).filter((g) => {
    if (!g) return false
    if (hasMatchStarted(g)) {
      shown.add(g.match_id)
      return true
    }
    return shown.has(g.match_id)
  })
}

/**
 * Per-set results [{set, home, away}], Team A = home. The live-state row's own
 * set_results wins when filled; otherwise the joined matches.set_results from
 * the initial select (written by the scorer at match end).
 * @param {object} game
 * @returns {{set:number, home:number, away:number}[]}
 */
export function getSetResults(game) {
  const own = game?.set_results
  if (Array.isArray(own) && own.length > 0) return own
  const joined = Array.isArray(game?.matches) ? game.matches[0] : game?.matches
  const fromMatch = joined?.set_results
  return Array.isArray(fromMatch) ? fromMatch : []
}

/**
 * Remember the games this page watched while they could still change their
 * set results: seen not yet ended, or arrived through realtime only (no joined
 * `matches` from the select).
 * @param {object[]} games
 * @param {Set<string>} watched  updated in place
 */
export function trackWatched(games, watched) {
  for (const g of games || []) {
    if (g && (!isEndedStatus(g.match_status) || !('matches' in g))) watched.add(g.match_id)
  }
}

/**
 * True when a finished game has no set results and a refetch can fill them:
 * it ended while this page watched it (the joined matches.set_results was
 * loaded before the match end wrote it, and realtime UPDATEs carry only
 * match_live_state columns). A game that was already finished in the initial
 * select already got whatever the server has, so it is not refetched.
 * @param {object} game
 * @param {Set<string>} watched  see trackWatched
 */
export function needsFinalRefetch(game, watched) {
  if (!game || !isEndedStatus(game.match_status)) return false
  if (getSetResults(game).length > 0) return false
  return watched.has(game.match_id)
}

/** Delays (ms) for the refetches after a match ends without set results. */
export const FINAL_REFETCH_DELAYS_MS = Object.freeze([1500, 4000, 10000, 30000])

/**
 * Whether livescore can skip the server-connection screen. Livescore needs no
 * PIN, so it connects at once when the server is known: served by the
 * standalone LAN server / desktop app (same origin), a *.openvolley.app page
 * (cloud backend by default), a ?match= / ?server= link, or a server the
 * viewer already chose on this device. Only a dev build without a stored
 * choice still asks.
 * @param {{servedFromLocalServer?: boolean, staticDeployment?: boolean, search?: string, hasOverride?: boolean}} p
 */
export function shouldAutoConnect({ servedFromLocalServer = false, staticDeployment = false, search = '', hasOverride = false } = {}) {
  if (servedFromLocalServer || staticDeployment || hasOverride) return true
  let params
  try { params = new URLSearchParams(search || '') } catch { return false }
  return !!(params.get('match') || params.get('server'))
}
