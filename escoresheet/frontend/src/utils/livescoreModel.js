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
 *              ended/final), or a last event from IN_PLAY_EVENT_TYPES (an
 *              allowlist: point, set_start, timeout, substitution, ...).
 *   anything else at 0:0 / set 1 / no sets won is not started: setup events
 *              (lineup, rotation, coin toss, court captain, manual side/serve
 *              changes), and events that can happen before Start Set too
 *              ('undo' is synced after every undo, including an undone
 *              lineup; a pre-match 'sanction'; 'manual_score_update';
 *              libero_*). An unknown event type is also not started, so a new
 *              scorer event cannot list a match early by accident.
 *   explicit pre-start statuses (pre_match, scheduled, not_started) are never
 *   live, so a scoreboard that starts writing one is honoured as is.
 *
 * Start Set alone (no rally yet) lists the match: Scoreboard.jsx pushes
 * 'set_start' to match_live_state right after writing it. Open: the scorer
 * does not write 'pre_match' for setup upserts yet; livescore honours it.
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

/**
 * Event types that only happen once a set is under way (allowlist). Anything
 * else (setup events, 'undo', 'sanction', 'manual_*', libero_*, unknown types)
 * leaves the decision to the score, sets and status.
 */
export const IN_PLAY_EVENT_TYPES = Object.freeze([
  'point',
  'rally',
  'replay',
  'decision_change',
  'set_start',
  'set_end',
  'timeout',
  'end_timeout',
  'substitution',
  'end_interval',
  'court_switch',
  'match_end'
])
const IN_PLAY_EVENTS = new Set(IN_PLAY_EVENT_TYPES)

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
  return IN_PLAY_EVENTS.has(game.last_event_type)
}

/**
 * The games the livescore list shows: started (or finished) matches, plus any
 * match already shown as started in this session; never stale ones
 * (isStaleGame: finished hours ago, or abandoned).
 * @param {object[]} games
 * @param {Set<string>} [shown]  match_ids already shown as started; updated in place
 * @param {number} [now]
 * @param {Map<string, {stamp: string, changedAt: number|null}>} [seen]  per
 *   match_id, the updated_at last seen and when (this page's clock) it last
 *   changed; updated in place (noteRowChanges)
 * @returns {object[]}
 */
export function listedGames(games, shown = new Set(), now = Date.now(), seen = null) {
  if (seen) noteRowChanges(games, seen, now)
  return (games || []).filter((g) => {
    if (!g) return false
    if (isStaleGame(g, now, seen?.get(g.match_id)?.changedAt ?? null)) return false
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

/**
 * Delays (ms) for the safety-net refetches after a match ends without set
 * results. The primary path is applyMatchRowChange (realtime matches UPDATE);
 * these only cover a missed or late change. Jittered, see jitterDelay.
 */
export const FINAL_REFETCH_DELAYS_MS = Object.freeze([1500, 4000, 10000, 30000])

/**
 * ±30% jitter so the viewers of one match do not refetch the list in step.
 * @param {number} ms
 * @param {() => number} [random]
 */
export function jitterDelay(ms, random = Math.random) {
  return Math.round(ms * (0.7 + 0.6 * random()))
}

/**
 * Reducer for a realtime `matches` change: copy its set_results into the
 * joined `matches` of the game with that match_id, so the FINAL view gets its
 * set chips as soon as the scorer's match sync lands (match_live_state
 * UPDATEs do not carry set_results). Other columns of the match row are
 * ignored.
 * @param {object[]} games
 * @param {{eventType: string, new?: object}} payload
 * @returns {object[]} the next list (the same array when nothing changed)
 */
export function applyMatchRowChange(games, payload) {
  if (payload?.eventType !== 'UPDATE' && payload?.eventType !== 'INSERT') return games
  const row = payload.new
  if (!row || row.id == null) return games
  // Columns of the (public) match row the livescore uses: the set chips, and
  // who Team A is (coin toss, home team name) to put them on the right side.
  const picked = {}
  if (Array.isArray(row.set_results)) picked.set_results = row.set_results
  if (row.coin_toss?.team_a === 'home' || row.coin_toss?.team_a === 'away') picked.coin_toss = { team_a: row.coin_toss.team_a }
  if (typeof row.home_team?.name === 'string' && row.home_team.name) picked.home_team = { name: row.home_team.name }
  if (Object.keys(picked).length === 0) return games
  const index = (games || []).findIndex((g) => g?.match_id === row.id)
  if (index === -1) return games
  const game = games[index]
  const joined = Array.isArray(game.matches) ? game.matches[0] : game.matches
  const changed = Object.keys(picked).some((k) => JSON.stringify(joined?.[k] ?? null) !== JSON.stringify(picked[k]))
  if (!changed) return games
  const next = games.slice()
  next[index] = { ...game, matches: { ...(joined || {}), ...picked } }
  return next
}

// ── Set numbers, set counts and sides ───────────────────────────────────────

/**
 * best_of of a live-state row. Rows written before match_live_state.best_of
 * existed have none: a decider (index 5) reached with at most 3 sets played is
 * a best-of-3 one (a best-of-5 decider starts at 2:2).
 * @param {object} game
 * @returns {3|5}
 */
export function liveBestOf(game) {
  const b = Number(game?.best_of)
  if (b === 3 || b === 5) return b
  // The joined match's own format, when the row carries it
  const info = Number(joinedMatch(game)?.match_info?.best_of)
  if (info === 3 || info === 5) return info
  if (Number(game?.current_set) !== 5) return 5
  // A best-of-3 decider is played at 1:1 and ends 2:1; a best-of-5 one at
  // 2:2. Older scoreboards dropped Team B's set at the set_end push, so a
  // best-of-5 interval before the decider could read 2:1: only a FINISHED
  // 2:1 is a best-of-3.
  const a = num(game?.sets_won_a)
  const bb = num(game?.sets_won_b)
  if (a + bb <= 2) return 3
  if (a + bb === 3 && Math.max(a, bb) === 2 && isEndedStatus(game?.match_status)) return 3
  return 5
}

/**
 * The set number viewers see for the row's current set: a best-of-3 decider
 * is stored as set 5 and is shown as set 3 (utils/matchFormat displaySetNumber).
 * @param {object} game  a match_live_state row
 */
export function liveSetNumber(game) {
  const index = num(game?.current_set) || 1
  return liveBestOf(game) === 3 && index === 5 ? 3 : index
}

const joinedMatch = (game) => (Array.isArray(game?.matches) ? game.matches[0] : game?.matches) || null

/**
 * Is Team A (the live state's A/B model) the home team? set_results are
 * stored as {home, away}. Known from the match row (coin toss, else the home
 * team name against team_a_name); for a finished match without either, from
 * the set results themselves: the live row's own Team A count matches the
 * home or the away wins (older scoreboards only ever undercounted Team B).
 * Defaults to true.
 * @param {object} game
 * @returns {boolean}
 */
export function teamAIsHome(game) {
  const match = joinedMatch(game)
  const tossA = match?.coin_toss?.team_a
  if (tossA === 'home' || tossA === 'away') return tossA === 'home'
  const homeName = match?.home_team?.name
  if (homeName && game?.team_a_name && game.team_a_name !== game.team_b_name) return game.team_a_name === homeName
  if (isEndedStatus(game?.match_status)) {
    const wins = setWinsByTeam(getSetResults(game))
    if (wins && wins.home !== wins.away) {
      const a = num(game.sets_won_a)
      if (a === wins.home) return true
      if (a === wins.away) return false
    }
  }
  return true
}

/** Sets won per team from set results ({set, home, away}), or null without any. */
function setWinsByTeam(results) {
  if (!Array.isArray(results) || results.length === 0) return null
  let home = 0
  let away = 0
  for (const s of results) {
    if (num(s?.home) > num(s?.away)) home++
    else if (num(s?.away) > num(s?.home)) away++
  }
  return { home, away }
}

/**
 * Sets won by Team A and Team B. A finished match counts its set results (the
 * match row is written from the finished sets; live rows from older
 * scoreboards missed every set Team B won: FINAL 1:1 for a 1:2). Otherwise
 * the live row's own counts.
 * @param {object} game
 * @returns {{a: number, b: number}}
 */
export function liveSetsWon(game) {
  const own = { a: num(game?.sets_won_a), b: num(game?.sets_won_b) }
  if (!isEndedStatus(game?.match_status)) return own
  const wins = setWinsByTeam(getSetResults(game))
  if (!wins || wins.home + wins.away < own.a + own.b) return own
  return teamAIsHome(game) ? { a: wins.home, b: wins.away } : { a: wins.away, b: wins.home }
}

/**
 * Set results as Team A / Team B points: [{set, a, b}], set = the number
 * viewers see (a best-of-3 decider stored as 5 is set 3).
 * @param {object} game
 */
export function liveSetResults(game) {
  const aIsHome = teamAIsHome(game)
  const bestOf = liveBestOf(game)
  return getSetResults(game).map((s) => ({
    set: bestOf === 3 && num(s.set) === 5 ? 3 : s.set,
    a: aIsHome ? s.home : s.away,
    b: aIsHome ? s.away : s.home
  }))
}

// ── What the score display shows ────────────────────────────────────────────

/**
 * The phase viewers see: 'final', 'set_break' (interval between sets),
 * 'timeout' or 'play'.
 * @param {object} game  a match_live_state row
 */
export function livePhase(game) {
  if (isEndedStatus(game?.match_status)) return 'final'
  if (game?.set_interval_active || game?.match_status === 'interval') return 'set_break'
  if (game?.timeout_active || game?.match_status === 'timeout') return 'timeout'
  return 'play'
}

/**
 * Everything the list row and the fullscreen view show for one game, by side
 * (side_a says where Team A plays now).
 *
 * Main digits: the set count once the match is final, otherwise the points of
 * the set (during a set break: the next set's 0:0, with phase 'set_break' for
 * the label, no longer the set count, which looked like points). Finished
 * sets (setResults) are shown during the match too, not only at FINAL.
 * @param {object} game
 */
export function liveScoreboard(game) {
  const sideA = game.side_a || 'left' // default Team A on left
  const isALeft = sideA === 'left'
  const phase = livePhase(game)
  const isMatchEnded = phase === 'final'

  const setsWon = liveSetsWon(game)
  const leftSets = isALeft ? setsWon.a : setsWon.b
  const rightSets = isALeft ? setsWon.b : setsWon.a
  const leftPoints = num(isALeft ? game.points_a : game.points_b)
  const rightPoints = num(isALeft ? game.points_b : game.points_a)

  // Set results (live-state row, else the joined matches row), as Team A /
  // Team B (Team A is home or away), to left/right
  const setResults = liveSetResults(game).map((s) => ({
    set: s.set,
    left: isALeft ? s.a : s.b,
    right: isALeft ? s.b : s.a
  }))

  return {
    leftName: isALeft ? (game.team_a_name || 'Team A') : (game.team_b_name || 'Team B'),
    rightName: isALeft ? (game.team_b_name || 'Team B') : (game.team_a_name || 'Team A'),
    leftScore: isMatchEnded ? leftSets : leftPoints,
    rightScore: isMatchEnded ? rightSets : rightPoints,
    leftSets,
    rightSets,
    leftPoints,
    rightPoints,
    phase,
    isMatchEnded,
    isInSetInterval: phase === 'set_break',
    isTimeout: phase === 'timeout',
    // Serving: already 'left' or 'right'
    servingTeam: game.serving_team,
    setResults
  }
}

// ── Realtime frame ordering ─────────────────────────────────────────────────

// Where the teams play and the running score: what a stray frame must not flip
const LAYOUT_FIELDS = ['side_a', 'serving_team', 'points_a', 'points_b']

/**
 * updated_at is the scorer (or referee) device's clock. A value further ahead
 * of this page's clock is not trusted for ordering (realtimeHub admitOrdered
 * clamps the same way, maxFutureSkewMs).
 */
export const FRAME_MAX_FUTURE_SKEW_MS = 5 * 1000
/**
 * Out-of-order delivery (relay push vs HTTP write-through) is seconds apart.
 * A frame older than the shown row by more than this is a device clock that
 * runs behind (scorer moved to another device, NTP correction), not a late
 * copy: it is applied, or that game would freeze until a reload.
 */
export const FRAME_REORDER_WINDOW_MS = 60 * 1000

/**
 * Is this frame a late copy of an older state (drop it)? Only when both
 * stamps are plausible and the frame is older by at most
 * FRAME_REORDER_WINDOW_MS. A shown row stamped further than
 * FRAME_MAX_FUTURE_SKEW_MS ahead never blocks later frames; a frame's own
 * future stamp is clamped to now + FRAME_MAX_FUTURE_SKEW_MS.
 * @param {string|undefined} shownStamp  updated_at of the row on screen
 * @param {string|undefined} frameStamp  updated_at of the incoming frame
 * @param {number} [now]  this page's clock
 */
export function isLateFrame(shownStamp, frameStamp, now = Date.now()) {
  const shownAt = Date.parse(shownStamp || '')
  const rawAt = Date.parse(frameStamp || '')
  if (!Number.isFinite(shownAt) || !Number.isFinite(rawAt)) return false
  const ceiling = now + FRAME_MAX_FUTURE_SKEW_MS
  if (shownAt > ceiling) return false
  const frameAt = Math.min(rawAt, ceiling)
  const behind = shownAt - frameAt
  return behind > 0 && behind <= FRAME_REORDER_WINDOW_MS
}

/**
 * Settle a realtime match_live_state change against the row already shown,
 * before applyLiveChange merges it:
 *   - a late copy of an older state (updated_at a little earlier than the
 *     shown row: the relay and the HTTP write-through can deliver out of
 *     order) is dropped (null). updated_at is a device clock, so a shown row
 *     stamped in the future, or a frame far behind it, is not a reason to
 *     drop anything (isLateFrame);
 *   - at match end the scoreboard first pushes its set_end frame, already
 *     'ended' but with the NEXT set's layout (sides swapped, points 0:0), and
 *     the match_end frame with the real last-set layout ~1.5 s later. Any
 *     'ended' frame that is not the match_end one keeps the shown row's
 *     layout (side_a, serving team, points), so the FINAL view does not flip
 *     its sides and set chips back and forth.
 * @param {object[]} games  the list shown now
 * @param {{eventType: string, new?: object}} payload
 * @param {number} [now]  this page's clock
 * @returns {object|null} the payload to apply, or null to ignore it
 */
export function settleLiveChange(games, payload, now = Date.now()) {
  if (payload?.eventType !== 'INSERT' && payload?.eventType !== 'UPDATE') return payload
  const row = payload.new
  if (!row || row.match_id == null) return payload
  const shown = (games || []).find((g) => g?.match_id === row.match_id)
  if (!shown) return payload

  if (isLateFrame(shown.updated_at, row.updated_at, now)) return null

  if (!isEndedStatus(row.match_status) || row.last_event_type === 'match_end') return payload
  const kept = {}
  for (const k of LAYOUT_FIELDS) {
    if (k in shown && shown[k] !== row[k]) kept[k] = shown[k]
  }
  if (Object.keys(kept).length === 0) return payload
  return { ...payload, new: { ...row, ...kept } }
}

// ── Stale rows ──────────────────────────────────────────────────────────────

/** A finished match stays listed this long after its last update. */
export const ENDED_LISTED_MS = 3 * 60 * 60 * 1000
/** A match not finished but silent this long is abandoned (never ended on the scorer). */
export const IDLE_LISTED_MS = 3 * 60 * 60 * 1000
/** The list query asks for rows updated within this window only. */
export const LIVE_FETCH_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * True when a row should no longer be listed: finished more than
 * ENDED_LISTED_MS ago, or not finished and not updated for IDLE_LISTED_MS.
 * Rows without a timestamp are kept.
 *
 * updated_at comes from the scorer device's clock. A tablet or Pi without NTP
 * that runs hours slow would make a match being played look abandoned, so a
 * change this page saw itself (`changedAt`, this page's clock) counts too:
 * the later of the two decides.
 * @param {object} game
 * @param {number} [now]
 * @param {number|null} [changedAt]  when this page last saw the row change
 */
export function isStaleGame(game, now = Date.now(), changedAt = null) {
  const parsed = Date.parse(game?.updated_at || game?.last_event_ts || '')
  const t = Math.max(Number.isFinite(parsed) ? parsed : -Infinity, Number.isFinite(changedAt) ? changedAt : -Infinity)
  if (!Number.isFinite(t)) return false
  return now - t > (isEndedStatus(game?.match_status) ? ENDED_LISTED_MS : IDLE_LISTED_MS)
}

/**
 * Remember, per match_id, when this page saw a row's updated_at change. The
 * first sighting records nothing (an old row is not news): only a later,
 * different updated_at sets `changedAt` to `now`.
 * @param {object[]} games
 * @param {Map<string, {stamp: string, changedAt: number|null}>} seen  updated in place
 * @param {number} now
 */
export function noteRowChanges(games, seen, now) {
  for (const g of games || []) {
    if (!g || g.match_id == null) continue
    const stamp = String(g.updated_at ?? g.last_event_ts ?? '')
    const prev = seen.get(g.match_id)
    if (!prev) seen.set(g.match_id, { stamp, changedAt: null })
    else if (prev.stamp !== stamp) seen.set(g.match_id, { stamp, changedAt: now })
  }
}

/** Number of listed games still being played (FINAL ones are not live). */
export function countLiveGames(games) {
  return (games || []).filter((g) => g && !isEndedStatus(g.match_status)).length
}

// ── Live-state pushes (scoreboard side) ─────────────────────────────────────

/**
 * Must the scoreboard capture a fresh state snapshot for this live-state push
 * instead of reusing the last event's? Manual changes, and the deciding-set
 * court switch: it writes set5CourtSwitched without an event, so the last
 * event's snapshot still has the old sides (livescore showed them until the
 * next rally).
 * @param {string|null|undefined} eventType
 */
export function liveStateNeedsFreshSnapshot(eventType) {
  return typeof eventType === 'string' && (eventType.startsWith('manual_') || eventType === 'court_switch')
}

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
