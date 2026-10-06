/**
 * Server Data Sync Service
 * Fetches match data from the main scoreboard server instead of using local IndexedDB
 */

import { apiFrom } from '../lib/apiClient'
import { getApiUrl, getBackendUrl, getCloudApiUrl, getRelayWebSocketUrl } from './backendConfig'
import { formatTimeLocal } from './timeUtils'

/**
 * Generate a unique seed_key for a match
 * This is the stable identifier used for Supabase sync (stored as external_id)
 * Format: match_{timestamp}_{random} - never includes modifiable fields like gameN
 * @returns {string} Unique seed_key
 */
export function generateMatchSeedKey() {
  const timestamp = Date.now()
  const randomPart = Math.random().toString(36).substring(2, 8)
  return `match_${timestamp}_${randomPart}`
}

// Server (relay) URL: the same backend every other module uses (backendConfig:
// runtime override from ?server= / the connection screen, VITE_BACKEND_URL, the
// cloud relay on *.openvolley.app, same origin on the LAN server). The old
// local fallbacks remain for a desktop build without any backend config.
function getServerUrl() {
  const configured = getBackendUrl()
  if (configured) return configured.replace(/\/$/, '')

  const protocol = window.location.protocol === 'https:' ? 'https' : 'http'
  const hostname = window.location.hostname
  if (window.location.protocol === 'https:') {
    return `${protocol}://${hostname}`
  }
  const port = window.location.port || '5173'
  return `${protocol}://${hostname}:${port}`
}

// Relay WebSocket: the same resolver the scorer publishes with (one relay for all)
function getWebSocketUrl() {
  return getRelayWebSocketUrl()
}

// ---------------------------------------------------------------------------
// Match access after the PIN step
// ---------------------------------------------------------------------------
// The relays hand out a match's bundle (rosters, events, actions) only to a
// tablet that proved one of its PINs; everyone else gets the public summary
// (teams, status, score). A successful PIN check here remembers, per match
// key, the PIN and the backend's match token, and every later subscribe /
// fetch of that match carries them (subscribe-match pin/token, the
// X-OV-Match-Pin / X-OV-Match-Token headers). In memory only: after a reload
// the apps re-check their stored PIN, which remembers it again.
const matchAccess = new Map() // String(match key) -> { pin, token, type? }
const MAX_MATCH_ACCESS = 16

/**
 * Remember what proves access to a match (after a successful PIN check).
 * `type` is the cloud PIN check's type (referee / bench_home / bench_away):
 * with it an expired match token can be renewed with the same PIN.
 */
export function rememberMatchAccess(matchId, { pin = null, token = null, type = null } = {}) {
  if (matchId === undefined || matchId === null || (!pin && !token)) return
  const key = String(matchId)
  const prev = matchAccess.get(key) || {}
  matchAccess.delete(key)
  if (matchAccess.size >= MAX_MATCH_ACCESS) matchAccess.delete(matchAccess.keys().next().value)
  const entry = { pin: pin ? String(pin).trim() : prev.pin || null, token: token || prev.token || null }
  const kind = type || prev.type
  if (kind) entry.type = kind
  matchAccess.set(key, entry)
}

// Token renewals per match (at most one a minute)
const TOKEN_RENEW_MS = 60 * 1000
const tokenRenewedAt = new Map()

/**
 * The API fallback read a remembered match without its rosters: the match
 * token expired (or the backend restarted without a fixed token secret).
 * Renew it with the remembered PIN (cloud PIN check, at most once a minute).
 * @returns {Promise<boolean>} true when a new token was remembered
 */
async function renewMatchToken(matchId, row) {
  const a = matchAccessFor(matchId)
  if (!a?.pin || !a.type || !row || typeof row !== 'object' || 'players_home' in row) return false
  const key = String(matchId)
  const last = tokenRenewedAt.get(key)
  if (last !== undefined && Date.now() - last < TOKEN_RENEW_MS) return false
  tokenRenewedAt.set(key, Date.now())
  const r = await validatePinSupabase(a.pin, a.type)
  return !!(r?.success && r.token && String(r.match?.id) === key)
}

/** Forget a match's access (exit, PIN no longer valid). No argument: all. */
export function forgetMatchAccess(matchId) {
  if (matchId === undefined) {
    matchAccess.clear()
    tokenRenewedAt.clear()
  } else {
    matchAccess.delete(String(matchId))
    tokenRenewedAt.delete(String(matchId))
  }
}

/** The remembered access of a match, or null. */
export function matchAccessFor(matchId) {
  if (matchId === undefined || matchId === null) return null
  return matchAccess.get(String(matchId)) || null
}

/** Request headers proving access to a match (empty without one). */
export function matchAccessHeaders(matchId) {
  const a = matchAccessFor(matchId)
  const h = {}
  if (a?.token) h['X-OV-Match-Token'] = a.token
  if (a?.pin) h['X-OV-Match-Pin'] = a.pin
  return h
}

/**
 * Validate PIN and get match data from server
 */
export async function validatePin(pin, type = 'referee') {
  const serverUrl = getServerUrl()

  try {
    const response = await fetch(`${serverUrl}/api/match/validate-pin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        pin: String(pin).trim(),
        type
      })
    })

    if (!response.ok) {
      let errorMessage = 'Failed to validate PIN'
      try {
        const errorData = await response.json()
        errorMessage = errorData.error || errorMessage
      } catch (e) {
        // If response is not JSON, use status text
        errorMessage = response.statusText || errorMessage
      }
      throw new Error(errorMessage)
    }

    // Check if response has content
    const text = await response.text()
    if (!text || text.trim() === '') {
      throw new Error('Empty response from server. Make sure the main scoresheet is running and connected.')
    }

    try {
      const result = JSON.parse(text)
      if (result?.success && result.match?.id != null) {
        rememberMatchAccess(result.match.id, { pin, token: result.token || null })
      }
      return result
    } catch (e) {
      console.error('Invalid JSON response:', text)
      throw new Error('Invalid response from server. Make sure the main scoresheet is running and connected.')
    }
  } catch (error) {
    console.error('Error validating PIN:', error)
    // If it's already an Error with a message, re-throw it
    if (error instanceof Error) {
      throw error
    }
    // Otherwise, wrap it
    throw new Error(error.message || 'Failed to validate PIN. Make sure the main scoresheet is running and connected.')
  }
}

/**
 * Get full match data from server (match, teams, players, sets, events)
 * Falls back to Supabase direct fetch if HTTP endpoint is not available
 */
export async function getMatchData(matchId) {
  const serverUrl = getServerUrl()

  // Try HTTP endpoint first (WebSocket server may have it)
  try {
    const response = await fetch(`${serverUrl}/api/match/${matchId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...matchAccessHeaders(matchId)
      }
    })

    if (response.ok) {
      const result = await response.json()
      // Without a proved PIN the relay answers with the public summary (no
      // rosters, no events): good enough for a match link before the PIN step,
      // never a replacement for the bundle after it.
      if (result?.success && result.access === 'summary' && matchAccessFor(matchId)) {
        console.debug('[getMatchData] relay answered with the summary only, trying the API')
      } else {
        // The relay's copy may lag behind the live state it stored with it
        return result?.success ? applyNewerLiveState(result) : result
      }
    }
  } catch (error) {
    console.debug('[getMatchData] HTTP fetch failed, trying API fallback:', error.message)
  }

  // Fallback to API client direct fetch
  {
    try {
      console.log('[getMatchData] Fetching via API client for matchId:', matchId)

      let match = null
      let matchError = null

      // Try 1: Fetch match by external_id (seed_key)
      // The match token of the PIN check unlocks this match's rosters on an
      // anonymous read (other matches: public columns only).
      const readByExtId = () => apiFrom('matches')
        .headers(matchAccessHeaders(matchId))
        .select('*')
        .eq('external_id', matchId)
        .eq('sport_type', 'indoor')
        .maybeSingle()
      let { data: matchByExtId, error: extIdError } = await readByExtId()
      // Rosters missing after the PIN step: renew the token once and read again
      if (matchByExtId && await renewMatchToken(matchId, matchByExtId)) {
        const again = await readByExtId()
        if (again.data) matchByExtId = again.data
      }

      if (matchByExtId) {
        match = matchByExtId
      } else {
        // Fallback: If matchId is a UUID, try direct id lookup
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        if (uuidRegex.test(matchId)) {
          const { data: matchById, error: idError } = await apiFrom('matches')
            .select('*')
            .eq('id', matchId)
            .eq('sport_type', 'indoor')
            .maybeSingle()

          if (matchById) {
            match = matchById
            console.log('[getMatchData] Found match by UUID fallback')
          } else {
            matchError = idError || extIdError
          }
        } else {
          matchError = extIdError
        }
      }

      if (!match) {
        console.error('[getMatchData] Supabase match fetch error:', matchError)
        return { success: false, error: matchError?.message || 'Match not found' }
      }

      // Fetch live state if available (for Referee app)
      const { data: liveState } = await apiFrom('match_live_state')
        .select('*')
        .eq('match_id', match.id)
        .maybeSingle()

      return buildLiveStateMatchData(match, liveState, matchId)
    } catch (apiError) {
      console.error('[getMatchData] API fallback error:', apiError)
      return { success: false, error: apiError.message }
    }
  }

  return { success: false, error: 'No data source available' }
}

/**
 * Is a match_live_state row newer than the last one applied (by updated_at)?
 * Rows arrive twice per action (relay push and HTTP write-through) and the
 * scorer's writes can land out of order; an older row must not roll the view
 * back. Unknown timestamps count as newer.
 * @param {object|null} row - live state row
 * @param {string|null} lastTs - updated_at of the newest row applied
 */
export function isNewerLiveState(row, lastTs, { allowEqual = false } = {}) {
  if (!lastTs) return true
  const t = Date.parse(row?.updated_at)
  const last = Date.parse(lastTs)
  if (Number.isNaN(t) || Number.isNaN(last)) return true
  return allowEqual ? t >= last : t > last
}

const liveStateTime = (liveState) => Date.parse(liveState?.updated_at)

/**
 * The scorer's order of a live state: its sequence number and session
 * (relayPublisher.createLiveStateOrder), or null (a match_live_state row from
 * the database, an older scorer).
 */
function liveStateOrderOf(liveState) {
  const seq = Number(liveState?._seq)
  const session = liveState?._session
  return Number.isFinite(seq) && typeof session === 'string' && session ? { seq, session } : null
}

/**
 * Which live state to keep when `incoming` arrives after `current` (relay
 * push, relay bundle, match_live_state row): `incoming` unless it is older.
 * Two states of one scorer session compare by sequence number (never by the
 * wall clock: an NTP step back would freeze the view on the state from before
 * the step); otherwise by updated_at. Either may be missing; unknown
 * timestamps count as newer.
 */
export function newerLiveState(current, incoming) {
  if (!incoming) return current || null
  if (!current) return incoming
  const a = liveStateOrderOf(current)
  const b = liveStateOrderOf(incoming)
  if (a && b && a.session === b.session) return b.seq < a.seq ? current : incoming
  return liveStateTime(incoming) < liveStateTime(current) ? current : incoming
}

/**
 * Was `liveState` computed after the relay bundle was read on the scorer?
 * - Same scorer session: its sequence number is higher than the bundle's
 *   match._syncedSeq (the last number issued before the sync read IndexedDB).
 * - Otherwise its updated_at is later than match._syncedAt (both on the
 *   scorer's clock; the fallback for a database row or an older scorer).
 * False when the bundle carries neither (an older scorer).
 */
export function isLiveStateNewerThanBundle(liveState, bundle) {
  if (!liveState || !bundle) return false
  const match = bundle.match
  const order = liveStateOrderOf(liveState)
  const syncedSeq = Number(match?._syncedSeq)
  if (order && Number.isFinite(syncedSeq) && match?._syncSession === order.session) {
    return order.seq > syncedSeq
  }
  const syncedAt = Number(match?._syncedAt)
  const liveAt = liveStateTime(liveState)
  return Number.isFinite(syncedAt) && !Number.isNaN(liveAt) && liveAt > syncedAt
}

/**
 * A relay bundle with a live state that is newer than it applied: the scorer
 * pushes its live state after every action, but the bundle (sets, events) can
 * arrive later, be refused, or be read back from the relay before the scorer's
 * sync landed. Then the live state's points replace those of the set it names,
 * so the referee and bench show the newest score whichever path brought it.
 * "Newer": isLiveStateNewerThanBundle. A bundle that does not say when it was
 * read (older scorer) or an older live state is returned as it is.
 * @param {object} bundle - { match, sets, liveState?, ... }
 * @param {object|null} [liveState] - defaults to the bundle's own
 */
export function applyNewerLiveState(bundle, liveState = bundle?.liveState) {
  if (!bundle || !liveState || !Array.isArray(bundle.sets)) return bundle
  if (!isLiveStateNewerThanBundle(liveState, bundle)) return bundle
  const out = { ...bundle, liveState }
  const index = Number(liveState.current_set)
  const pointsA = Number(liveState.points_a)
  const pointsB = Number(liveState.points_b)
  if (!Number.isFinite(index) || !Number.isFinite(pointsA) || !Number.isFinite(pointsB)) return out
  const teamAIsHome = (bundle.match?.coinTossTeamA || 'home') === 'home'
  const homePoints = teamAIsHome ? pointsA : pointsB
  const awayPoints = teamAIsHome ? pointsB : pointsA
  let changed = false
  const sets = bundle.sets.map((s) => {
    if (!s || Number(s.index) !== index || s.finished) return s
    if (s.homePoints === homePoints && s.awayPoints === awayPoints) return s
    changed = true
    return { ...s, homePoints, awayPoints }
  })
  return changed ? { ...out, sets } : out
}

/**
 * The newest live state a tablet has seen from any source (relay push, relay
 * bundle, match_live_state row) and the last relay bundle as received, so a
 * newer live state wins over an older bundle's score (applyNewerLiveState):
 * - bundle(result): a relay bundle (getMatchData / subscribeToMatchData
 *   result). Returns it with the newest live state applied. A bundle read on
 *   the scorer after the kept state supersedes it (which also frees a state
 *   kept from before a clock step on the scorer). Results built from a
 *   match_live_state row (source 'live_state') pass through.
 * - liveState(row): a live state from elsewhere (database row). True when it
 *   is now the newest: re-deliver bundle(lastBundle) to show it.
 */
export function createLiveStateTracker() {
  let newest = null
  let lastBundle = null
  return {
    get newest() { return newest },
    get lastBundle() { return lastBundle },
    reset() {
      newest = null
      lastBundle = null
    },
    bundle(result) {
      if (!result?.success || result.source === 'live_state' || !Array.isArray(result.sets)) return result
      lastBundle = result
      const m = result.match
      if (newest && (m?._syncedSeq != null || m?._syncedAt != null) && !isLiveStateNewerThanBundle(newest, result)) {
        newest = null
      }
      newest = newerLiveState(newest, result.liveState)
      return applyNewerLiveState(result, newest)
    },
    liveState(row) {
      if (!row || typeof row !== 'object') return false
      const before = newest
      newest = newerLiveState(newest, row)
      return newest !== before
    }
  }
}

/**
 * Build the referee/bench match payload ({ success, match, homeTeam, awayTeam,
 * homePlayers, awayPlayers, sets, events, liveState }) from a `matches` row and
 * its `match_live_state` row. Pure: getMatchData uses it after reading both
 * rows, and the referee applies a pushed live_state row (db-change) with it
 * directly instead of re-reading the database, which could still return the
 * row from before the push.
 * @param {object} match - matches row
 * @param {object|null} liveState - match_live_state row
 * @param {string} matchId - the id the caller knows the match by (seed key)
 */
export function buildLiveStateMatchData(match, liveState, matchId) {
  // Build team info from matches table (prefer JSONB, fallback to old columns for transition)
  const homeTeamName = match.home_team?.name || match.home_team_name || 'Home'
  const awayTeamName = match.away_team?.name || match.away_team_name || 'Away'

  // A/B Model: Team A = coin toss winner (constant), side_a = which side they're on
  // Determine coinTossTeamA: is Team A the home or away team?
  let coinTossTeamA = null
  let teamAIsHome = true

  if (liveState?.team_a_name) {
    // Compare live state team_a_name with matches table to determine if Team A is home
    teamAIsHome = liveState.team_a_name === homeTeamName
    coinTossTeamA = teamAIsHome ? 'home' : 'away'
  } else {
    // Fallback to coin_toss if live state doesn't have A/B data (prefer JSONB, fallback to old columns)
    coinTossTeamA = match.coin_toss?.team_a || match.coin_toss_team_a || 'home'
    teamAIsHome = coinTossTeamA === 'home'
  }

  // Determine which side is home based on side_a
  // side_a = 'left' means Team A is on left, side_a = 'right' means Team A is on right
  const sideA = liveState?.side_a || 'left'
  const leftIsHome = (sideA === 'left') === teamAIsHome

  // Build team info with live state colors
  const homeColorFromLive = liveState ? (teamAIsHome ? liveState.team_a_color : liveState.team_b_color) : null
  const awayColorFromLive = liveState ? (teamAIsHome ? liveState.team_b_color : liveState.team_a_color) : null

  const homeTeam = {
    name: homeTeamName,
    shortName: match.home_team?.short_name || match.home_short_name || 'HOM',
    color: homeColorFromLive || match.home_team?.color || '#ef4444'
  }
  const awayTeam = {
    name: awayTeamName,
    shortName: match.away_team?.short_name || match.away_short_name || 'AWY',
    color: awayColorFromLive || match.away_team?.color || '#3b82f6'
  }

  // Build sets from live state using A/B model
  let sets = []
  if (liveState) {
    // Convert A/B points to home/away
    const homePoints = teamAIsHome ? liveState.points_a : liveState.points_b
    const awayPoints = teamAIsHome ? liveState.points_b : liveState.points_a

    // Determine serving team - priority: serving_team field, then lineup isServing
    let servingTeam = 'home'
    let serverNumber = null

    const lineupA = liveState.lineup_a
    const lineupB = liveState.lineup_b

    // First priority: use serving_team from live state (set by manual changes or score events)
    // serving_team stores 'left' or 'right', convert to 'home'/'away'
    if (liveState.serving_team) {
      const servingSide = liveState.serving_team // 'left' or 'right'
      // leftIsHome tells us if home is on left
      servingTeam = (servingSide === 'left') === leftIsHome ? 'home' : 'away'
      // Get server number from the serving team's lineup position I
      // If serving home and Team A is home, use lineupA. Otherwise use lineupB.
      const servingTeamIsA = (servingTeam === 'home') === teamAIsHome
      const servingTeamLineup = servingTeamIsA ? lineupA : lineupB
      serverNumber = servingTeamLineup?.I?.number || null
    } else if (lineupA?.I?.isServing) {
      // Fallback: Rich format with serving info in position I (isServing field)
      servingTeam = teamAIsHome ? 'home' : 'away'
      serverNumber = lineupA.I.number
    } else if (lineupB?.I?.isServing) {
      servingTeam = teamAIsHome ? 'away' : 'home'
      serverNumber = lineupB.I.number
    }

    const currentSet = {
      index: liveState.current_set || 1,
      homePoints: homePoints || 0,
      awayPoints: awayPoints || 0,
      finished: false,
      servingTeam,
      serverNumber
    }
    sets = [currentSet]

    // Set scores
    const homeSetsWon = teamAIsHome ? liveState.sets_won_a : liveState.sets_won_b
    const awaySetsWon = teamAIsHome ? liveState.sets_won_b : liveState.sets_won_a
    // We only have set counts, not individual set scores - this is a limitation
  } else {
    // No live state yet (before first point) - create empty set 1
    sets = [{ index: 1, homePoints: 0, awayPoints: 0, finished: false }]
  }

  // Build events array with lineup info from live state
  let events = []

  if (liveState) {
    // Lineup events contain rich data (captain, libero, subs, sanctions embedded per position)
    if (liveState.lineup_a) {
      events.push({
        type: 'lineup',
        setIndex: liveState.current_set || 1,
        seq: 1,
        payload: {
          team: teamAIsHome ? 'home' : 'away',
          lineup: liveState.lineup_a,
          isRichFormat: true
        }
      })
    }
    if (liveState.lineup_b) {
      events.push({
        type: 'lineup',
        setIndex: liveState.current_set || 1,
        seq: 1.1,
        payload: {
          team: teamAIsHome ? 'away' : 'home',
          lineup: liveState.lineup_b,
          isRichFormat: true
        }
      })
    }

    // Build sanction events from live state (team-level sanctions only)
    if (liveState.sanctions_a) {
      for (const sanction of liveState.sanctions_a) {
        events.push({
          type: 'sanction',
          setIndex: liveState.current_set || 1,
          ts: sanction.ts,
          payload: {
            team: teamAIsHome ? 'home' : 'away',
            playerNumber: sanction.player,
            type: sanction.type,
            playerType: sanction.playerType, // 'player', 'bench', 'libero', 'official'
            position: sanction.position,
            role: sanction.role
          }
        })
      }
    }
    if (liveState.sanctions_b) {
      for (const sanction of liveState.sanctions_b) {
        events.push({
          type: 'sanction',
          setIndex: liveState.current_set || 1,
          ts: sanction.ts,
          payload: {
            team: teamAIsHome ? 'away' : 'home',
            playerNumber: sanction.player,
            type: sanction.type,
            playerType: sanction.playerType,
            position: sanction.position,
            role: sanction.role
          }
        })
      }
    }

    // Build substitution events from live state (if stored as JSONB arrays)
    if (Array.isArray(liveState.subs_a)) {
      for (const sub of liveState.subs_a) {
        events.push({
          type: 'substitution',
          setIndex: liveState.current_set || 1,
          ts: sub.ts,
          payload: {
            team: teamAIsHome ? 'home' : 'away',
            playerIn: sub.playerIn,
            playerOut: sub.playerOut,
            position: sub.position,
            exceptional: sub.exceptional || false
          }
        })
      }
    }
    if (Array.isArray(liveState.subs_b)) {
      for (const sub of liveState.subs_b) {
        events.push({
          type: 'substitution',
          setIndex: liveState.current_set || 1,
          ts: sub.ts,
          payload: {
            team: teamAIsHome ? 'away' : 'home',
            playerIn: sub.playerIn,
            playerOut: sub.playerOut,
            position: sub.position,
            exceptional: sub.exceptional || false
          }
        })
      }
    }

    // Build timeout events from live state (if stored as JSONB arrays)
    if (Array.isArray(liveState.timeouts_a)) {
      for (const timeout of liveState.timeouts_a) {
        events.push({
          type: 'timeout',
          setIndex: liveState.current_set || 1,
          ts: timeout.ts,
          payload: {
            team: teamAIsHome ? 'home' : 'away'
          }
        })
      }
    } else if (typeof liveState.timeouts_a === 'number') {
      // Backwards compatibility: if stored as number, create that many timeout events
      for (let i = 0; i < liveState.timeouts_a; i++) {
        events.push({
          type: 'timeout',
          setIndex: liveState.current_set || 1,
          payload: {
            team: teamAIsHome ? 'home' : 'away'
          }
        })
      }
    }
    if (Array.isArray(liveState.timeouts_b)) {
      for (const timeout of liveState.timeouts_b) {
        events.push({
          type: 'timeout',
          setIndex: liveState.current_set || 1,
          ts: timeout.ts,
          payload: {
            team: teamAIsHome ? 'away' : 'home'
          }
        })
      }
    } else if (typeof liveState.timeouts_b === 'number') {
      // Backwards compatibility: if stored as number, create that many timeout events
      for (let i = 0; i < liveState.timeouts_b; i++) {
        events.push({
          type: 'timeout',
          setIndex: liveState.current_set || 1,
          payload: {
            team: teamAIsHome ? 'away' : 'home'
          }
        })
      }
    }
  }

  // Build players from matches table JSONB columns
  const homePlayers = match.players_home || []
  const awayPlayers = match.players_away || []

  // Extract captain info from rich lineup format
  let homeCaptain = null
  let awayCaptain = null
  let homeCourtCaptain = null
  let awayCourtCaptain = null

  const homeLineup = teamAIsHome ? liveState?.lineup_a : liveState?.lineup_b
  const awayLineup = teamAIsHome ? liveState?.lineup_b : liveState?.lineup_a

  for (const pos of ['I', 'II', 'III', 'IV', 'V', 'VI']) {
    if (homeLineup?.[pos]?.isCaptain) homeCaptain = homeLineup[pos].number
    if (homeLineup?.[pos]?.isCourtCaptain) homeCourtCaptain = homeLineup[pos].number
    if (awayLineup?.[pos]?.isCaptain) awayCaptain = awayLineup[pos].number
    if (awayLineup?.[pos]?.isCourtCaptain) awayCourtCaptain = awayLineup[pos].number
  }

  return {
    success: true,
    match: {
      ...match,
      id: matchId, // Use external_id as the reference ID
      // Use liveState.match_status if available (reflects actual game state)
      status: liveState?.match_status || match.status,
      coinTossTeamA: coinTossTeamA, // Derived from live state if not in matches table
      coinTossTeamB: coinTossTeamA === 'home' ? 'away' : 'home',
      coinTossServeA: match.coin_toss?.serve_a ?? match.coin_toss_serve_a,
      firstServe: match.coin_toss?.first_serve || match.first_serve,
      // coin_toss_confirmed = true if we have liveState with team names (means coin toss happened)
      coin_toss_confirmed: !!(liveState?.team_a_name),
      // Get short names from JSONB, or fallback to old columns
      homeShortName: match.home_team?.short_name || match.home_short_name || homeTeam.shortName,
      awayShortName: match.away_team?.short_name || match.away_short_name || awayTeam.shortName,
      homeName: homeTeam.name,
      awayName: awayTeam.name,
      homeColor: homeTeam.color,
      awayColor: awayTeam.color,
      // Captain info
      homeCaptain: homeCaptain || null,
      awayCaptain: awayCaptain || null,
      homeCourtCaptain: homeCourtCaptain || null,
      awayCourtCaptain: awayCourtCaptain || null,
      // Also ensure gameNumber is set
      gameNumber: match.game_n ? String(match.game_n) : null,
      gameN: match.game_n
    },
    homeTeam,
    awayTeam,
    homePlayers,
    awayPlayers,
    sets,
    events,
    isRichFormat: true, // Always rich format now
    liveState, // Include raw live state for additional data
    // Built from the match_live_state row alone (no relay bundle): a pushed
    // live_state row can be applied with this same function.
    source: 'live_state'
  }
}

// Global WebSocket connection manager to prevent multiple connections
const wsConnections = new Map() // Map<matchId, { ws, subscribers, reconnectTimeout, reconnectAttempts, isIntentionallyClosed, pingInterval }>

// Ping interval in ms - keeps connection alive on mobile networks (NAT timeout is usually 30-60s)
const PING_INTERVAL = 25000
// A socket that answers nothing (not even the pong) this long after a ping is
// dead — e.g. the tablet's Wi-Fi dropped without a close frame — and is replaced.
// The resubscribe brings a fresh match-full-data snapshot.
const PONG_TIMEOUT = 10000

// Debug info for mobile debugging
const wsDebugInfo = {
  connectedAt: null,
  lastMessageAt: null,
  lastPingAt: null,
  lastPongAt: null,
  messagesReceived: 0,
  connectionAttempts: 0,
  errors: [],
  wsUrl: null,
  readyState: null,
  lastError: null,
  lastServerError: null
}

/**
 * Build the subscriber payload from a relay 'match-data-update' or
 * 'match-full-data' message. Every relay (cloud backend, LAN server, Electron,
 * Tauri, Vite dev) sends the bundle flat on the message; older LAN relays nested
 * it under `data`, so both shapes are accepted.
 * @returns {object|null} { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events, liveState?, _timestamp, _scoreboardTimestamp }
 */
export function readRelayBundle(message) {
  if (!message || typeof message !== 'object') return null
  const src = message.match === undefined && message.data && typeof message.data === 'object'
    ? message.data
    : message
  if (!src.match) return null
  const payload = {
    match: src.match,
    homeTeam: src.homeTeam || src.teams?.[0],
    awayTeam: src.awayTeam || src.teams?.[1],
    homePlayers: src.homePlayers || src.players?.filter(p => p.teamId === src.match?.homeTeamId) || [],
    awayPlayers: src.awayPlayers || src.players?.filter(p => p.teamId === src.match?.awayTeamId) || [],
    sets: src.sets || [],
    events: src.events || [],
    _timestamp: message._timestamp || message.timestamp,
    _scoreboardTimestamp: message._scoreboardTimestamp || message.timestamp
  }
  if (src.liveState !== undefined) payload.liveState = src.liveState
  return payload
}

/**
 * Get WebSocket debug info for on-screen debugging
 */
export function getWsDebugInfo(matchId) {
  const matchIdStr = String(matchId)
  const connection = wsConnections.get(matchIdStr)

  return {
    ...wsDebugInfo,
    readyState: connection?.ws?.readyState ?? -1,
    readyStateLabel: connection?.ws ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][connection.ws.readyState] : 'NO_CONNECTION',
    subscriberCount: connection?.subscribers?.size ?? 0,
    reconnectAttempts: connection?.reconnectAttempts ?? 0,
    isIntentionallyClosed: connection?.isIntentionallyClosed ?? false
  }
}

// Store connect functions for each match to allow force reconnect
const connectFunctions = new Map()

/**
 * Force reconnect WebSocket for a match
 */
export function forceReconnect(matchId) {
  const matchIdStr = String(matchId)
  const connection = wsConnections.get(matchIdStr)

  if (!connection) {
    console.log('[ServerDataSync] No connection to reconnect for match', matchId)
    return false
  }

  console.log('[ServerDataSync] Force reconnecting...')

  // Close existing connection with code 4000 (custom code that triggers reconnect)
  if (connection.ws) {
    try {
      connection.ws.close(4000, 'Force reconnect')
    } catch (e) { }
    connection.ws = null
  }

  // Clear timeouts
  if (connection.reconnectTimeout) {
    clearTimeout(connection.reconnectTimeout)
    connection.reconnectTimeout = null
  }
  if (connection.pingInterval) {
    clearInterval(connection.pingInterval)
    connection.pingInterval = null
  }

  // Reset flags
  connection.isIntentionallyClosed = false
  connection.reconnectAttempts = 0

  // Trigger reconnect using stored connect function
  const connectFn = connectFunctions.get(matchIdStr)
  if (connectFn) {
    setTimeout(connectFn, 100) // Small delay to ensure cleanup completes
    return true
  }

  return false
}

// What this tablet is, for the scorer's tablet status (relay
// /api/server/connections). A label only: it grants nothing.
let relayDevice = null

/**
 * Label this app's relay subscriptions (RefereeApp: 'referee', BenchApp:
 * 'bench' + team). Applies to subscriptions opened from now on and to the
 * re-subscribe after every reconnect.
 * @param {'referee'|'bench'|'livescore'|null} device
 * @param {'home'|'away'|null} [team]
 */
export function setRelayDevice(device, team = null) {
  relayDevice = device ? { device, ...(team === 'home' || team === 'away' ? { team } : {}) } : null
}

/**
 * The subscribe-match message for a match key, with this app's device label
 * and what proves access to it (PIN / match token of the PIN check).
 */
export function subscribeMessage(matchId) {
  const access = matchAccessFor(matchId)
  return {
    type: 'subscribe-match',
    matchId: String(matchId),
    ...(relayDevice || {}),
    ...(access?.pin ? { pin: access.pin } : {}),
    ...(access?.token ? { token: access.token } : {})
  }
}

/**
 * Subscribe to match data updates via WebSocket
 */
export function subscribeToMatchData(matchId, onUpdate) {
  const wsUrl = getWebSocketUrl()
  const matchIdStr = String(matchId)

  // Get or create connection manager for this match
  let connection = wsConnections.get(matchIdStr)
  if (!connection) {
    connection = {
      ws: null,
      subscribers: new Set(),
      reconnectTimeout: null,
      reconnectAttempts: 0,
      isIntentionallyClosed: false,
      pingInterval: null,
      pongTimer: null,
      lastMessageAt: 0,
      onWake: null
    }
    wsConnections.set(matchIdStr, connection)
  }

  // Add this subscriber
  connection.subscribers.add(onUpdate)

  const maxReconnectDelay = 10000 // Max 10 seconds

  // Drop a socket that stopped answering and connect a new one right away.
  const replaceDeadSocket = () => {
    const dead = connection.ws
    if (!dead || connection.isIntentionallyClosed) return
    try {
      dead.onopen = null
      dead.onmessage = null
      dead.onerror = null
      dead.onclose = null
      dead.close(4000, 'No answer to ping')
    } catch { /* already gone */ }
    connection.ws = null
    if (connection.pingInterval) {
      clearInterval(connection.pingInterval)
      connection.pingInterval = null
    }
    if (connection.reconnectTimeout) clearTimeout(connection.reconnectTimeout)
    connection.reconnectTimeout = setTimeout(connect, 250)
  }

  // Ping and expect any message back within PONG_TIMEOUT. Never judged by the
  // time of the last message alone, so a throttled background tab is not
  // mistaken for a dead socket.
  const probe = () => {
    const ws = connection.ws
    if (connection.isIntentionallyClosed) return
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      // Back online / visible with no socket: reconnect now, not after the backoff
      if (connection.reconnectTimeout) clearTimeout(connection.reconnectTimeout)
      connection.reconnectTimeout = null
      connection.ws = null
      connect()
      return
    }
    if (ws.readyState !== WebSocket.OPEN) return
    const sentAt = Date.now()
    try {
      wsDebugInfo.lastPingAt = sentAt
      ws.send(JSON.stringify({ type: 'ping', timestamp: sentAt }))
    } catch (err) {
      console.warn('[ServerDataSync] Error sending ping:', err)
    }
    if (connection.pongTimer) clearTimeout(connection.pongTimer)
    connection.pongTimer = setTimeout(() => {
      connection.pongTimer = null
      if (connection.ws === ws && connection.lastMessageAt < sentAt) replaceDeadSocket()
    }, PONG_TIMEOUT)
  }

  if (!connection.onWake && typeof window !== 'undefined') {
    connection.onWake = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      probe()
    }
    window.addEventListener('online', connection.onWake)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', connection.onWake)
  }

  const connect = () => {
    // Store this connect function for force reconnect
    connectFunctions.set(matchIdStr, connect)
    // Don't reconnect if intentionally closed or already connected
    if (connection.isIntentionallyClosed) return
    if (connection.ws && connection.ws.readyState === WebSocket.OPEN) {
      // Already connected, just send subscription message
      try {
        connection.ws.send(JSON.stringify(subscribeMessage(matchIdStr)))
      } catch (err) {
        console.error('[ServerDataSync] Error sending subscription:', err)
      }
      return
    }
    if (connection.ws && connection.ws.readyState === WebSocket.CONNECTING) {
      // Already connecting, wait for it
      return
    }

    try {
      // Close existing connection if any (but not if it's already closed)
      if (connection.ws && connection.ws.readyState !== WebSocket.CLOSED) {
        connection.ws.close()
      }

      wsDebugInfo.wsUrl = wsUrl
      wsDebugInfo.connectionAttempts++
      connection.ws = new WebSocket(wsUrl)

      connection.ws.onopen = () => {
        // Skip if intentionally closed (cleanup ran before connection opened)
        if (connection.isIntentionallyClosed || !connection.ws) return

        connection.reconnectAttempts = 0 // Reset on successful connection
        wsDebugInfo.connectedAt = Date.now()
        wsDebugInfo.lastError = null
        console.log('[ServerDataSync] WebSocket connected')

        // Request match data subscription
        try {
          connection.ws.send(JSON.stringify(subscribeMessage(matchIdStr)))
        } catch (err) {
          // Error sending subscription
        }

        // Start ping interval to keep connection alive (important for mobile networks)
        if (connection.pingInterval) {
          clearInterval(connection.pingInterval)
        }
        connection.pingInterval = setInterval(probe, PING_INTERVAL)
      }

      connection.ws.onmessage = (event) => {
        // Skip if intentionally closed
        if (connection.isIntentionallyClosed) return

        try {
          const message = JSON.parse(event.data)
          connection.lastMessageAt = Date.now()
          wsDebugInfo.lastMessageAt = connection.lastMessageAt
          wsDebugInfo.messagesReceived++

          // Handle pong (heartbeat response)
          if (message.type === 'pong') {
            wsDebugInfo.lastPongAt = Date.now()
            return
          }

          const notify = (payload) => {
            connection.subscribers.forEach(subscriber => {
              try {
                subscriber(payload)
              } catch (err) {
                console.error('[ServerDataSync] Error in subscriber callback:', err)
              }
            })
          }

          if ((message.type === 'match-data-update' || message.type === 'match-full-data') && String(message.matchId) === matchIdStr &&
              message.access === 'summary') {
            // The public summary (no PIN proved on this socket): never replaces
            // the bundle; only its live state is used, like a live-state-update.
            const liveState = newerLiveState(connection.lastLiveState, message.liveState)
            if (liveState && liveState === message.liveState) {
              connection.lastLiveState = liveState
              if (connection.lastPayload) {
                connection.lastPayload = applyNewerLiveState({ ...connection.lastPayload, liveState }, liveState)
                notify(connection.lastPayload)
              }
            }
          } else if ((message.type === 'match-data-update' || message.type === 'match-full-data') && String(message.matchId) === matchIdStr) {
            // Match data (full snapshot on subscribe, then every scoreboard sync).
            // Pass through timestamp fields for latency tracking.
            const bundle = readRelayBundle(message)
            if (bundle) {
              // The relay decides whether the last live-state still applies: it
              // re-sends it with every bundle while the same scoreboard / game PIN
              // keeps the match, and drops it on a takeover. Re-applying an old
              // one here would show another match's sides, sets or 'ended' state.
              // A live state newer than the bundle wins over its score.
              const payload = applyNewerLiveState(bundle)
              connection.lastLiveState = payload.liveState
              connection.lastPayload = payload
              notify(payload)
            }
          } else if (message.type === 'live-state-update' && String(message.matchId) === matchIdStr) {
            // Scoreboard's computed live-state: re-deliver the last bundle with
            // it so consumers see one consistent object, its score included
            // when the push is newer than the bundle. An older push (pushes and
            // syncs race) is not applied over a newer one.
            const liveState = newerLiveState(connection.lastLiveState, message.liveState)
            if (liveState && liveState === message.liveState) {
              connection.lastLiveState = liveState
              if (connection.lastPayload) {
                connection.lastPayload = applyNewerLiveState({ ...connection.lastPayload, liveState }, liveState)
                notify(connection.lastPayload)
              }
            }
          } else if (message.type === 'match-deleted' && String(message.matchId) === matchIdStr) {
            // Match removed from the relay (match end / scorer deleted it)
            connection.lastPayload = null
            connection.lastLiveState = undefined
            notify({ _deleted: true, matchId: matchIdStr })
          } else if (message.type === 'error') {
            // Relay refused something (rate limit, not the match's scoreboard, ...)
            wsDebugInfo.lastServerError = { time: Date.now(), code: message.code || null, message: message.message || 'Server error' }
            console.warn('[ServerDataSync] Relay error:', message.code || '', message.message || '')
          } else if (message.type === 'match-action' && String(message.matchId) === matchIdStr) {
            // Action received from scoreboard (timeout, substitution, set_end, etc.)
            connection.subscribers.forEach(subscriber => {
              try {
                // Pass the action with a special _action wrapper, including timestamps for latency tracking
                subscriber({
                  _action: message.action,
                  _actionData: message.data,
                  _timestamp: message._timestamp || message.timestamp,
                  _scoreboardTimestamp: message._scoreboardTimestamp || message.timestamp
                })
              } catch (err) {
                console.error('[ServerDataSync] Error in subscriber callback for action:', err)
              }
            })
          }
        } catch (err) {
          console.error('[ServerDataSync] Error parsing message:', err)
        }
      }

      connection.ws.onerror = (error) => {
        // Track error for debugging
        wsDebugInfo.lastError = {
          time: Date.now(),
          message: error?.message || 'WebSocket error',
          readyState: connection.ws?.readyState
        }
        wsDebugInfo.errors.push(wsDebugInfo.lastError)
        if (wsDebugInfo.errors.length > 10) wsDebugInfo.errors.shift() // Keep last 10 errors

        // Skip if ws is null (cleanup already happened) or intentionally closed
        if (!connection.ws || connection.isIntentionallyClosed) return

        // Only log if it's not a connection error (which is expected during initial connection)
        // Connection errors are usually handled by onclose
        if (connection.ws.readyState === WebSocket.CONNECTING) {
          // This is expected during initial connection attempts, don't log as error
          return
        }
        console.warn('[ServerDataSync] WebSocket error (will attempt reconnect):', error)
      }

      connection.ws.onclose = (event) => {
        // Clear ping interval
        if (connection.pingInterval) {
          clearInterval(connection.pingInterval)
          connection.pingInterval = null
        }

        // Don't reconnect if intentionally closed or ws is null
        if (connection.isIntentionallyClosed || !connection.ws) return

        // Don't reconnect on normal closure (code 1000)
        if (event.code === 1000) {
          console.log('[ServerDataSync] WebSocket closed normally')
          return
        }

        // Only reconnect if there are still subscribers
        if (connection.subscribers.size === 0) {
          console.log('[ServerDataSync] No subscribers, not reconnecting')
          return
        }

        // Exponential backoff for reconnection
        connection.reconnectAttempts++
        const delay = Math.min(3000 * connection.reconnectAttempts, maxReconnectDelay)
        console.log(`[ServerDataSync] WebSocket disconnected, reconnecting in ${delay / 1000} seconds... (attempt ${connection.reconnectAttempts})`)
        connection.reconnectTimeout = setTimeout(connect, delay)
      }
    } catch (err) {
      console.error('[ServerDataSync] Connection error:', err)
      // Exponential backoff for reconnection
      connection.reconnectAttempts++
      const delay = Math.min(3000 * connection.reconnectAttempts, maxReconnectDelay)
      connection.reconnectTimeout = setTimeout(connect, delay)
    }
  }

  // Connect if not already connected
  if (!connection.ws || connection.ws.readyState === WebSocket.CLOSED) {
    connect()
  } else if (connection.ws.readyState === WebSocket.OPEN) {
    // Already connected, send subscription immediately
    try {
      connection.ws.send(JSON.stringify(subscribeMessage(matchIdStr)))
    } catch (err) {
      console.error('[ServerDataSync] Error sending subscription:', err)
    }
  }

  // Return unsubscribe function
  return () => {
    // Remove this subscriber
    connection.subscribers.delete(onUpdate)

    // If no more subscribers, close the connection
    if (connection.subscribers.size === 0) {
      connection.isIntentionallyClosed = true
      if (connection.reconnectTimeout) {
        clearTimeout(connection.reconnectTimeout)
        connection.reconnectTimeout = null
      }
      if (connection.pingInterval) {
        clearInterval(connection.pingInterval)
        connection.pingInterval = null
      }
      if (connection.pongTimer) {
        clearTimeout(connection.pongTimer)
        connection.pongTimer = null
      }
      if (connection.onWake) {
        window.removeEventListener('online', connection.onWake)
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', connection.onWake)
        connection.onWake = null
      }
      if (connection.ws) {
        connection.ws.close(1000, 'Unsubscribing') // Normal closure
        connection.ws = null
      }
      // Remove from maps
      wsConnections.delete(matchIdStr)
      connectFunctions.delete(matchIdStr)
    }
  }
}

/**
 * Get WebSocket connection status for a match
 * Returns: 'connected', 'connecting', 'disconnected', or 'unknown'
 */
export function getWebSocketStatus(matchId) {
  const matchIdStr = String(matchId)
  const connection = wsConnections.get(matchIdStr)

  if (!connection || !connection.ws) {
    return 'disconnected'
  }

  switch (connection.ws.readyState) {
    case WebSocket.CONNECTING:
      return 'connecting'
    case WebSocket.OPEN:
      return 'connected'
    case WebSocket.CLOSING:
    case WebSocket.CLOSED:
      return 'disconnected'
    default:
      return 'unknown'
  }
}

/**
 * Is the relay this app talks to up? GET /api/server/status on the configured
 * backend (every relay serves it), not on window.location — on a static
 * deployment that answers with index.html.
 * @returns {Promise<{ running: boolean }>}
 */
export async function getRelayServerStatus({ fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${getServerUrl()}/api/server/status`, { headers: { Accept: 'application/json' } })
    if (!response.ok) return { running: false }
    const type = response.headers?.get?.('content-type') || ''
    if (type && !type.includes('json')) return { running: false }
    const body = await response.json()
    return { ...(body && typeof body === 'object' ? body : {}), running: true }
  } catch {
    return { running: false }
  }
}

/**
 * Find match by game number from server
 */
export async function findMatchByGameNumber(gameNumber) {
  const serverUrl = getServerUrl()

  try {
    const response = await fetch(`${serverUrl}/api/match/by-game-number?gameNumber=${encodeURIComponent(gameNumber)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      return null
    }

    const result = await response.json()
    return result.match || null
  } catch (error) {
    console.error('Error finding match by game number:', error)
    return null
  }
}

/**
 * Update match data on server (for upload roster, etc.)
 */
export async function updateMatchData(matchId, updates) {
  const serverUrl = getServerUrl()

  try {
    const response = await fetch(`${serverUrl}/api/match/${matchId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updates)
    })

    if (!response.ok) {
      throw new Error('Failed to update match data')
    }

    const result = await response.json()
    return result
  } catch (error) {
    console.error('Error updating match data:', error)
    throw error
  }
}

/**
 * List available matches from server (for game number dropdown)
 */
export async function listAvailableMatches() {
  const serverUrl = getServerUrl()
  const url = `${serverUrl}/api/match/list`

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      return { success: false, matches: [], error: `HTTP ${response.status}: ${response.statusText}` }
    }

    const result = await response.json()
    return result
  } catch (error) {
    console.error('[listAvailableMatches] Error:', error.message)
    return { success: false, matches: [], error: error.message }
  }
}

/**
 * List available matches from Supabase (for Supabase-only mode)
 * Returns matches that are in 'setup' or 'live' status with referee_connection_enabled = true
 */
export async function listAvailableMatchesSupabase() {
  try {
    const { data, error } = await apiFrom('matches')
      .select(`
        id,
        external_id,
        game_n,
        status,
        scheduled_at,
        home_team,
        away_team,
        connections,
        connection_pins
      `)
      .in('status', ['setup', 'live'])
      .order('scheduled_at', { ascending: true })

    if (error) {
      // 404 (a relay without /api/db) or no answer (venue offline, or a LAN
      // tablet origin the cloud does not serve): the caller falls back to the
      // relay's own match list, nothing is wrong
      if (error.status !== 404 && !error.network) console.error('[listAvailableMatchesSupabase] Error:', error)
      return { success: false, matches: [], error: error.message }
    }

    // Filter to only show matches where referee connection is enabled
    const filteredData = (data || []).filter(m => {
      const connections = m.connections || {}
      return connections.referee_enabled === true
    })

    // Format to match the WebSocket server format
    const formattedMatches = filteredData.map(m => {
      let dateTime = 'TBD'
      if (m.scheduled_at) {
        try {
          // Ensure timestamp is parsed as UTC (Supabase may return without 'Z')
          let scheduledStr = m.scheduled_at
          if (!scheduledStr.endsWith('Z') && !scheduledStr.includes('+')) {
            scheduledStr = scheduledStr + 'Z'
          }
          const scheduledDate = new Date(scheduledStr)
          // Display in local timezone
          const dateStr = scheduledDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          const timeStr = formatTimeLocal(scheduledStr)
          dateTime = `${dateStr} ${timeStr}`
        } catch (e) {
          dateTime = 'TBD'
        }
      }

      // Read from JSONB columns only (clean schema)
      const homeTeamName = m.home_team?.name || 'Home'
      const awayTeamName = m.away_team?.name || 'Away'
      const connections = m.connections || {}
      const connectionPins = m.connection_pins || {}

      return {
        id: m.external_id || m.id,
        external_id: m.external_id, // Keep original for Supabase writes
        gameNumber: m.game_n || m.external_id,
        homeTeam: homeTeamName,
        awayTeam: awayTeamName,
        homeTeamName: homeTeamName,
        awayTeamName: awayTeamName,
        scheduledAt: m.scheduled_at,
        dateTime,
        status: m.status,
        refereeConnectionEnabled: connections.referee_enabled === true,
        // Include upload PINs for roster upload app
        homeTeamUploadPin: connectionPins.upload_home,
        awayTeamUploadPin: connectionPins.upload_away
      }
    })

    return { success: true, matches: formattedMatches }
  } catch (error) {
    console.error('[listAvailableMatchesSupabase] Exception:', error)
    return { success: false, matches: [], error: error.message }
  }
}

/**
 * List available matches from Supabase for Bench apps
 * Filters by bench_connection_enabled = true
 */
export async function listAvailableMatchesForBenchSupabase() {
  try {
    // NOTE: connection_pins is intentionally NOT selected — bench PINs must not
    // be shipped to the client. PIN validation happens server-side on connect.
    const { data, error } = await apiFrom('matches')
      .select(`
        id,
        external_id,
        game_n,
        status,
        scheduled_at,
        home_team,
        away_team,
        connections
      `)
      .in('status', ['setup', 'live'])
      .order('scheduled_at', { ascending: true })

    if (error) {
      // No answer (venue offline, LAN tablet origin): the relay list stands in
      if (error.status !== 404 && !error.network) console.error('[listAvailableMatchesForBenchSupabase] Error:', error)
      return { success: false, matches: [], error: error.message }
    }

    // Filter to only show matches where at least one bench connection is enabled
    const filteredData = (data || []).filter(m => {
      const connections = m.connections || {}
      return connections.home_bench_enabled === true || connections.away_bench_enabled === true
    })

    // Format to match the WebSocket server format
    const formattedMatches = filteredData.map(m => {
      let dateTime = 'TBD'
      if (m.scheduled_at) {
        try {
          let scheduledStr = m.scheduled_at
          if (!scheduledStr.endsWith('Z') && !scheduledStr.includes('+')) {
            scheduledStr = scheduledStr + 'Z'
          }
          const scheduledDate = new Date(scheduledStr)
          // Display in local timezone
          const dateStr = scheduledDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          const timeStr = formatTimeLocal(scheduledStr)
          dateTime = `${dateStr} ${timeStr}`
        } catch (e) {
          dateTime = 'TBD'
        }
      }

      // Read from JSONB columns only (clean schema)
      const homeTeamName = m.home_team?.name || 'Home'
      const awayTeamName = m.away_team?.name || 'Away'
      const connections = m.connections || {}

      return {
        id: m.external_id || m.id,
        external_id: m.external_id,
        gameNumber: m.game_n || m.external_id,
        homeTeam: homeTeamName,
        awayTeam: awayTeamName,
        homeTeamName: homeTeamName,
        awayTeamName: awayTeamName,
        scheduledAt: m.scheduled_at,
        dateTime,
        homeBenchEnabled: connections.home_bench_enabled,
        awayBenchEnabled: connections.away_bench_enabled,
        status: m.status
      }
    })

    return { success: true, matches: formattedMatches }
  } catch (error) {
    console.error('[listAvailableMatchesForBenchSupabase] Exception:', error)
    return { success: false, matches: [], error: error.message }
  }
}

/**
 * Validate PIN against Supabase database
 * Returns match data if PIN is valid
 */
export async function validatePinSupabase(pin, type = 'referee', { timeoutMs = 3000 } = {}) {
  // Bounded: on a venue network that drops packets to the internet this check
  // must fail fast so the caller can fall back to the LAN relay.
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const pinStr = String(pin).trim()

    if (!pinStr || pinStr.length !== 6) {
      return { success: false, error: 'Invalid PIN format' }
    }

    // SECURITY: the PIN is validated server-side. Match connection PINs are
    // never sent to the client (previously this read connection_pins for every
    // live match into the browser, defeating the PIN gate).
    const apiUrl = getCloudApiUrl('/api/match/validate-connection-pin')
    if (!apiUrl) return { success: false, error: 'Backend not available' }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: pinStr, type }),
      ...(controller ? { signal: controller.signal } : {})
    })

    let result
    try {
      result = await response.json()
    } catch {
      return { success: false, error: 'Validation failed' }
    }

    if (!response.ok || !result?.success) {
      return { success: false, error: result?.error || 'Invalid PIN code' }
    }

    if (result.match?.id != null) rememberMatchAccess(result.match.id, { pin: pinStr, token: result.token || null, type })
    return { success: true, match: result.match, token: result.token || null }
  } catch (error) {
    if (error?.name === 'AbortError') return { success: false, error: 'Server PIN check timed out' }
    console.error('[validatePinSupabase] Exception:', error)
    return { success: false, error: error.message }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Validate a roster-upload PIN server-side (Supabase mode).
 * The upload PINs are never sent to the client; the server compares them.
 * With matchExternalId the PIN is checked against that match only (the server
 * filters on it, and the answer must name it): a PIN of match A never unlocks
 * the roster upload of match B.
 * @param {'home'|'away'} team
 * @param {string} pin
 * @param {string} [matchExternalId] the match the roster will be written to
 */
export async function validateUploadPinSupabase(team, pin, matchExternalId) {
  try {
    const pinStr = String(pin).trim()
    if (!pinStr || pinStr.length !== 6) {
      return { success: false, error: 'Invalid PIN format' }
    }
    const apiUrl = getCloudApiUrl('/api/match/validate-connection-pin')
    if (!apiUrl) return { success: false, error: 'Backend not available' }
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pin: pinStr,
        type: team === 'home' ? 'upload_home' : 'upload_away',
        ...(matchExternalId ? { matchExternalId: String(matchExternalId) } : {})
      })
    })
    let result
    try { result = await response.json() } catch { return { success: false, error: 'Validation failed' } }
    if (!response.ok || !result?.success) {
      return { success: false, error: result?.error || 'Invalid upload PIN' }
    }
    if (matchExternalId && String(result.match?.id ?? '') !== String(matchExternalId)) {
      return { success: false, error: 'Invalid upload PIN' }
    }
    return { success: true, match: result.match }
  } catch (error) {
    console.error('[validateUploadPinSupabase] Exception:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Store a team's roster as the match's pending roster in the cloud (Upload
 * Roster app). Authorised by the team's upload PIN of that match, not by an
 * account: POST /api/match/upload-roster writes only the pending roster and the
 * team's coach/captain signatures.
 * @param {string} matchExternalId
 * @param {'home'|'away'} team
 * @param {string} pin - the team's upload PIN
 * @param {{players: object[], bench: object[], coachSignature?: string|null, captainSignature?: string|null, timestamp?: string}} rosterData
 * @returns {Promise<{success: boolean, status?: number, error?: string}>}
 */
export async function uploadRosterToCloud(matchExternalId, team, pin, rosterData, { fetchImpl = fetch } = {}) {
  const apiUrl = getCloudApiUrl('/api/match/upload-roster')
  if (!apiUrl) return { success: false, error: 'Backend not available' }
  const { coachSignature = null, captainSignature = null, ...roster } = rosterData || {}
  try {
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchExternalId: String(matchExternalId), team, pin: String(pin).trim(), roster, coachSignature, captainSignature })
    })
    let result = null
    try { result = await response.json() } catch { /* not JSON */ }
    if (!response.ok || !result?.success) {
      return { success: false, status: response.status, error: result?.error || 'Upload failed' }
    }
    return { success: true, status: response.status }
  } catch (error) {
    return { success: false, status: 0, error: error.message }
  }
}

/**
 * The relay's view of who watches a match (GET /api/server/connections) on the
 * same backend the app talks to — not window.location, which on a static
 * deployment answers with the SPA's index.html. Null when unreachable.
 * @param {string} matchKey - the relay room key (seed_key)
 */
const connectionsCache = new Map() // url -> { at, promise }
const CONNECTIONS_TTL_MS = 4000

export function fetchRelayConnections(matchKey, { fetchImpl = fetch, maxAgeMs = CONNECTIONS_TTL_MS } = {}) {
  const url = getApiUrl(`/api/server/connections${matchKey ? `?matchId=${encodeURIComponent(matchKey)}` : ''}`)
  if (!url) return Promise.resolve(null)
  // Several views poll this (header chip, scoreboard, connection setup): one
  // request serves them all for a few seconds.
  const hit = connectionsCache.get(url)
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.promise
  const promise = requestRelayConnections(url, fetchImpl)
  connectionsCache.set(url, { at: Date.now(), promise })
  if (connectionsCache.size > 20) connectionsCache.delete(connectionsCache.keys().next().value)
  return promise
}

async function requestRelayConnections(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } })
    if (!response.ok) return null
    const type = response.headers?.get?.('content-type') || ''
    if (type && !type.includes('json')) return null
    const body = await response.json()
    return body && typeof body === 'object' && Array.isArray(body.clients) ? body : null
  } catch {
    return null
  }
}

/**
 * Which tablets the relay sees on a match: { referee, benchHome, benchAway,
 * watchers }. Counts only clients subscribed to matchKey. A bench that did not
 * say which team it is counts for both benches only when one of them is enabled.
 * @param {object|null} connections - fetchRelayConnections() result
 * @param {string} matchKey
 * @param {object} [match] - scorer's match (connection flags)
 */
export function summarizeRelayTablets(connections, matchKey, match = null) {
  const out = { referee: 0, benchHome: 0, benchAway: 0, watchers: 0 }
  if (!connections || !Array.isArray(connections.clients)) return out
  const key = matchKey == null ? null : String(matchKey)
  let benchUnknown = 0
  for (const c of connections.clients) {
    if (key && String(c.matchId) !== key) continue
    out.watchers++
    if (c.role === 'referee') out.referee++
    else if (c.role === 'bench' && c.team === 'home') out.benchHome++
    else if (c.role === 'bench' && c.team === 'away') out.benchAway++
    else if (c.role === 'bench') benchUnknown++
  }
  if (benchUnknown > 0 && match) {
    const home = match.homeTeamConnectionEnabled === true
    const away = match.awayTeamConnectionEnabled === true
    if (home && !away) out.benchHome += benchUnknown
    else if (away && !home) out.benchAway += benchUnknown
  }
  return out
}

/**
 * Merge what the relay sees (summarizeRelayTablets) into a heartbeat-based
 * tablet summary (utils/connectionHealth getTabletStatusSummary): a role the
 * relay has a subscriber for is connected.
 */
export function applyRelayTablets(summary, relay) {
  if (!summary || !relay) return summary
  const seen = { referee: relay.referee > 0, bench_home: relay.benchHome > 0, bench_away: relay.benchAway > 0 }
  const roles = summary.roles.map((r) => (
    seen[r.role] && r.status !== 'connected' ? { ...r, status: 'connected', color: '#22c55e', ageMs: null } : r
  ))
  const connectedCount = roles.filter((r) => r.status === 'connected').length
  const issues = roles.some((r) => r.status !== 'connected')
  return {
    ...summary,
    roles,
    connectedCount,
    overallStatus: summary.expectedCount > 0 ? (issues ? 'issues' : 'ok') : summary.overallStatus
  }
}

/**
 * Team names of a match object from any source: the scorer's Dexie match
 * (homeName/awayName), a relay bundle, the cloud PIN check (homeTeam string),
 * a matches row (home_team JSONB) or a match list entry (homeTeamName).
 * @returns {{ home: string|null, away: string|null }}
 */
export function matchTeamNames(match, { homeTeam, awayTeam } = {}) {
  const pick = (...vals) => {
    for (const v of vals) {
      if (typeof v === 'string' && v.trim()) return v.trim()
      if (v && typeof v === 'object' && typeof v.name === 'string' && v.name.trim()) return v.name.trim()
    }
    return null
  }
  const m = match || {}
  return {
    home: pick(m.homeTeamName, m.homeName, m.home_team_name, m.home_team, m.homeTeam, homeTeam),
    away: pick(m.awayTeamName, m.awayName, m.away_team_name, m.away_team, m.awayTeam, awayTeam)
  }
}

// PIN fields the relay needs from the scorer: the game PIN proves the
// scoreboard role, the connection PINs let the relay check referee/bench PINs
// itself (LAN). Nothing else secret goes over the relay.
const RELAY_PIN_FIELDS = ['gamePin', 'refereePin', 'homeTeamPin', 'awayTeamPin', 'homeTeamUploadPin', 'awayTeamUploadPin']
const NEVER_RELAYED = ['game_pin', 'connection_pins', 'connectionPins']

/**
 * The relay room key of a scorer's match: its seed_key (what the tablets know
 * from the PIN check and the QR code); a test match's seedKey (the relays key
 * by seed_key ?? seedKey too). Null while the match has none (a blank match
 * before Create Match): it is not published then. A Dexie id is no key: every
 * device's first match is id 1, so scorers met in room '1' and a tablet
 * following it got another scorer's match.
 * @param {object|null} match
 * @returns {string|null}
 */
export function relayMatchKey(match) {
  for (const seed of [match?.seed_key, match?.seedKey]) {
    if (typeof seed === 'string' && seed.trim()) return seed.trim()
  }
  return null
}

/**
 * The match object a scorer sends in sync-match-data. PINs go only with the
 * first sync on a socket and when one changes (the relay keeps the stored ones
 * meanwhile); pass the signature returned last time for this socket, or null.
 * `_syncedSeq` / `_syncSession` (the scorer's live-state order, marked before
 * the sync read IndexedDB: `mark` = { seq, session, at }) let the tablets tell
 * whether a live-state push is newer than this copy (applyNewerLiveState);
 * `_syncedAt` (the scorer's clock) is the fallback when the two come from
 * different sessions.
 * @returns {{ match: object, pinSignature: string }}
 */
export function relayMatchPayload(match, lastPinSignature = null, { now = Date.now(), mark = null } = {}) {
  const out = { ...(match || {}) }
  delete out._syncedSeq
  delete out._syncSession
  out._syncedAt = Number.isFinite(mark?.at) ? mark.at : now
  if (mark && Number.isFinite(mark.seq) && typeof mark.session === 'string' && mark.session) {
    out._syncedSeq = mark.seq
    out._syncSession = mark.session
  }
  const pins = {}
  for (const f of RELAY_PIN_FIELDS) {
    const v = f === 'gamePin' ? (out.gamePin ?? out.game_pin) : out[f]
    pins[f] = v === undefined || v === '' ? null : v
    delete out[f]
  }
  for (const f of NEVER_RELAYED) delete out[f]
  const pinSignature = JSON.stringify(pins)
  return {
    match: pinSignature === lastPinSignature ? out : { ...out, ...pins },
    pinSignature
  }
}
