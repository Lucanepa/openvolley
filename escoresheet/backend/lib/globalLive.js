/**
 * globalLive — the Global tool's live page for TVs (owner 2026-11-17).
 *
 * A Global match is a test match to the rest of the server: its live state
 * never reaches match_live_state, the public lists or the public API. A
 * tournament that wants a live page opts in on the scorer devices with a
 * shared tournament code; the scorer's relay live-state-update then carries
 * `globalLive: <code>` and this store keeps a SUMMARY per court, in memory:
 *
 *   team names, short names and colours, points, sets won, the finished
 *   sets' points, the current set, best of, who serves, the match status,
 *   timeout / set interval, the hall and the scheduled time.
 *
 * Never kept: players, line-ups, substitutions, sanctions, officials, PINs,
 * signatures, remarks. No database row and no file: a restart empties it and
 * the next rally fills it again.
 *
 *   GET /api/global/live/<code> -> { data: { code, updatedAt, courts: [...] }, error: null }
 *
 * The code (8 characters from an alphabet without look-alikes, about 40
 * bits) is the only way to a page; nothing lists the codes. Bounded: maxCodes
 * codes, maxCourtsPerCode courts per code (the oldest court gives way), a
 * court is dropped endedKeepMs after its match ended and idleMs after its
 * last update, a code with no court left is dropped.
 *
 * Node built-ins only. Pure: server.js does the relay checks (the room is a
 * Global match, the sender owns it), the rate limit and the HTTP layer.
 */
import crypto from 'node:crypto'

export const LIVE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/

/** A court token: a hex hash of a match's own secret key (frontend utils/globalLive.js courtToken). */
export const isCourtToken = (t) => typeof t === 'string' && /^[0-9a-f]{32}$/.test(t)

/** A court token for a relay room that sent none (an older scorer app): a hash of the room key. */
export const courtTokenOf = (roomKey) => crypto.createHash('sha256').update(`room\0${roomKey}`).digest('hex').slice(0, 32)

const LIVE_SUMMARY_FIELDS = ['team_a_name', 'team_a_short', 'team_a_color', 'team_b_name', 'team_b_short', 'team_b_color', 'sets_won_a', 'sets_won_b', 'points_a', 'points_b', 'current_set', 'best_of', 'side_a', 'serving_team', 'match_status', 'timeout_active', 'set_interval_active']
/** Only the live-state fields courtSummary reads (what a forward or a push carries). */
export function pickLiveSummaryFields(liveState) {
  const out = {}
  if (!liveState || typeof liveState !== 'object') return out
  for (const k of LIVE_SUMMARY_FIELDS) if (k in liveState) out[k] = liveState[k]
  return out
}

/** A court number a scorer device set for its screen (1-99), else null. */
export function screenNumber(v) {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : null
}

/**
 * The court number for /tv/<code>/<n>: the one the scorer device set, else
 * the number at the end of the match's court (OpenBeach: 'Court 3' -> 3).
 */
export function screenOf(explicit, entry) {
  const own = screenNumber(explicit)
  if (own != null) return own
  const court = entry?.match?.court
  const m = typeof court === 'string' ? /([0-9]{1,2})\s*$/.exec(court) : (Number.isInteger(court) ? [null, String(court)] : null)
  return m ? screenNumber(m[1]) : null
}

/** A live screen code as the app makes it (utils/globalLive.js). */
export const isLiveCode = (code) => typeof code === 'string' && CODE_RE.test(code)

const str = (v, max = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Math.min(999, Math.trunc(Number(v)))) : 0)
const color = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim() : null)

/**
 * One court's summary from the scorer's live state and the room's synced
 * match (server.js activeMatches entry). Home and away as on the scoresheet:
 * the live state counts team A / B (the coin toss), so A is mapped back.
 */
export function courtSummary(liveState, entry = {}, nowIso = new Date().toISOString()) {
  const ls = liveState && typeof liveState === 'object' ? liveState : {}
  const match = entry.match && typeof entry.match === 'object' ? entry.match : {}
  const homeName = str(entry.homeTeam?.name)
  const awayName = str(entry.awayTeam?.name)
  const aName = str(ls.team_a_name)
  // A is home unless the names say otherwise, or the coin toss gave A to away
  const aIsHome = aName && awayName && aName === awayName && aName !== homeName
    ? false
    // (indoor says home/away, OpenBeach team1/team2)
    : (match.coinTossTeamA ? match.coinTossTeamA !== 'away' && match.coinTossTeamA !== 'team2' : true)
  const side = (a, b) => (aIsHome ? { home: a, away: b } : { home: b, away: a })
  const team = (prefix) => ({ name: str(ls[`team_${prefix}_name`]), short: str(ls[`team_${prefix}_short`], 12), color: color(ls[`team_${prefix}_color`]) })
  const teams = side(team('a'), team('b'))
  if (homeName) teams.home.name = homeName
  if (awayName) teams.away.name = awayName
  const setsWon = side(int(ls.sets_won_a), int(ls.sets_won_b))
  const points = side(int(ls.points_a), int(ls.points_b))
  // serving_team is a side (left/right); side_a says where team A stands
  let serving = null
  if ((ls.serving_team === 'left' || ls.serving_team === 'right') && (ls.side_a === 'left' || ls.side_a === 'right')) {
    const aServes = ls.serving_team === ls.side_a
    serving = aServes === aIsHome ? 'home' : 'away'
  }
  // The finished sets, home/away as the scoresheet keeps them
  const sets = (Array.isArray(entry.sets) ? entry.sets : [])
    .filter((s) => s && s.finished === true)
    .sort((x, y) => int(x.index) - int(y.index))
    .slice(0, 5)
    .map((s) => ({ home: int(s.homePoints), away: int(s.awayPoints) }))
  const status = str(ls.match_status, 20)
  return {
    home: teams.home,
    away: teams.away,
    setsWon,
    points,
    sets,
    currentSet: int(ls.current_set) || null,
    bestOf: int(ls.best_of) === 3 ? 3 : 5,
    serving,
    status,
    ended: status === 'final' || status === 'ended' || status === 'approved',
    timeout: ls.timeout_active === true,
    interval: ls.set_interval_active === true,
    // the hall or venue, and the court when there is one (OpenBeach: the same
    // venue on every court, the court number tells them apart)
    hall: [str(match.hall) || str(match.venue), str(match.court)].filter(Boolean).join(' \u00b7 ') || null,
    scheduledAt: str(match.scheduledAt, 40),
    gameNumber: str(match.gameN != null ? String(match.gameN) : null, 20),
    updatedAt: nowIso
  }
}

export function createGlobalLive({ maxCodes = 1000, maxCourtsPerCode = 24, idleMs = 3 * 60 * 60 * 1000, endedKeepMs = 45 * 60 * 1000, now = Date.now } = {}) {
  /** code -> Map(courtId -> { summary, at, endedAt }) */
  const codes = new Map()

  // The room key never leaves the server: a court's id is a short hash of it
  const courtIdOf = (code, roomKey) => crypto.createHash('sha256').update(`${code}\0${roomKey}`).digest('base64url').slice(0, 10)

  function sweep() {
    const t = now()
    for (const [code, courts] of codes) {
      for (const [id, c] of courts) {
        if (t - c.at > idleMs || (c.endedAt && t - c.endedAt > endedKeepMs)) courts.delete(id)
      }
      if (courts.size === 0) codes.delete(code)
    }
  }

  /**
   * The scorer's live state for one room. False: not taken (bad code, store
   * full). The caller has checked that the room is a Global match.
   */
  /** screen: the court number the scorer device set (1-99) for /tv/<code>/<n>, or null. */
  function update(code, roomKey, liveState, entry, screen = null) {
    if (!isLiveCode(code) || !roomKey || !liveState || typeof liveState !== 'object') return false
    sweep()
    let courts = codes.get(code)
    if (!courts) {
      if (codes.size >= maxCodes) return false
      courts = new Map()
      codes.set(code, courts)
    }
    const id = courtIdOf(code, String(roomKey))
    const t = now()
    const summary = { id, ...courtSummary(liveState, entry, new Date(t).toISOString()), screen: screenNumber(screen) }
    const prev = courts.get(id)
    if (!prev && courts.size >= maxCourtsPerCode) {
      // the court updated longest ago gives way
      let oldest = null
      for (const [k, c] of courts) if (!oldest || c.at < oldest[1].at) oldest = [k, c]
      if (oldest) courts.delete(oldest[0])
    }
    courts.set(id, { summary, at: t, endedAt: summary.ended ? (prev?.endedAt || t) : null })
    return true
  }

  /** The page's data for a code, or null when nothing is live under it. */
  /** The page's data for a code (one court with `screen`), or null when nothing is live under it. */
  function get(code, { screen = null } = {}) {
    if (!isLiveCode(code)) return null
    sweep()
    const courts = codes.get(code)
    if (!courts || courts.size === 0) return null
    const only = screenNumber(screen)
    const list = [...courts.values()].map((c) => c.summary).filter((c) => only == null || c.screen === only)
    // running matches first, then by the scheduled time, then by hall
    list.sort((a, b) => (a.ended - b.ended) || String(a.scheduledAt || '').localeCompare(String(b.scheduledAt || '')) || String(a.hall || '').localeCompare(String(b.hall || '')))
    const updatedAt = list.reduce((m, c) => (c.updatedAt > m ? c.updatedAt : m), '')
    return { code, updatedAt, courts: list }
  }

  return { update, get, sweep, size: () => codes.size }
}

/**
 * A league game's court summary from its public live row (publicApi
 * gameLiveRow: match_live_state + the match row), for /tv/<game number>.
 * The live row's columns are the scorer's live-state names, so courtSummary
 * reads it as it is; home / away and the finished sets come from the match.
 */
export function gameSummary(row, nowIso = new Date().toISOString()) {
  if (!row || typeof row !== 'object') return null
  const j = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return null } }
  const beach = (row.match_sport || row.sport_type) === 'beach'
  const home = j(beach ? row.team1_data : row.home_team) || {}
  const away = j(beach ? row.team2_data : row.away_team) || {}
  const info = j(row.match_info) || {}
  const aIsHome = !(typeof row.team_a_name === 'string' && row.team_a_name === away.name && row.team_a_name !== home.name)
  const sets = (Array.isArray(j(row.set_results)) ? j(row.set_results) : [])
    .filter((x) => x && typeof x === 'object')
    .map((x) => {
      // the scorer's live state (frontend domain/livePublicFields): { set, home, away, a, b }
      if (x.home != null || x.away != null) return { index: x.set ?? x.index, homePoints: x.home, awayPoints: x.away, finished: true }
      // an older shape by team A / B
      const a = x.pointsA ?? x.home_points
      const b = x.pointsB ?? x.away_points
      return { index: x.index, homePoints: aIsHome ? a : b, awayPoints: aIsHome ? b : a, finished: true }
    })
  const liveState = { ...row, match_status: row.match_status || row.status, points_a: row.points_a ?? 0, points_b: row.points_b ?? 0, sets_won_a: row.sets_won_a ?? 0, sets_won_b: row.sets_won_b ?? 0 }
  const scheduledAt = row.scheduled_at instanceof Date ? row.scheduled_at.toISOString() : row.scheduled_at
  const entry = {
    match: { coinTossTeamA: aIsHome ? 'home' : 'away', hall: info.hall ?? null, scheduledAt: scheduledAt ?? null, gameN: row.game_n ?? null },
    homeTeam: { name: home.name ?? null },
    awayTeam: { name: away.name ?? null },
    sets
  }
  return { id: `game-${row.game_n}`, ...courtSummary(liveState, entry, nowIso) }
}
