/**
 * The last list of today's games (GET /api/games/today, TodayGamesModal), per
 * account, in localStorage: a venue whose network drops still shows the games
 * (owner plan 2026-10-29, step 3).
 *
 * Only what the list and a pick from it need: the referees' dates of birth
 * (minors among them) are never kept. A game picked from this copy has none,
 * the scorer enters them; the fresh answer online still carries them. Removed
 * with the account's other local data when a session ends on the device
 * (AuthContext clearLocalAccountData).
 */
export const TODAY_GAMES_CACHE_KEY = 'ov:todayGames'

// The schedule fields the list shows and matchDataFromSchedule fills the
// match from (LoadOfficialMatchModal mapSupabaseToMatchFormat), plus the
// answer's club and claim
const KEPT_GAME_FIELDS = [
  'game_number', 'datetime', 'date', 'time', 'city', 'hall', 'hall_address', 'hall_postal_code',
  'match_type', 'championship_type', 'gender', 'match_level', 'league', 'match_format', 'team_home', 'team_away',
  'referee_1_first_name', 'referee_1_last_name', 'referee_2_first_name', 'referee_2_last_name',
  'linesman_1', 'linesman_2', 'group_display', 'club', 'claim'
]

/** The day's list of `userId`, or null (none, another account's, another day's). */
export function readCachedTodayGames(userId, day) {
  try {
    const v = JSON.parse(localStorage.getItem(TODAY_GAMES_CACHE_KEY) || 'null')
    return v && v.userId === userId && v.day === day ? v.data : null
  } catch {
    return null
  }
}

export function cacheTodayGames(userId, data) {
  const games = (Array.isArray(data?.games) ? data.games : [])
    .map((g) => Object.fromEntries(KEPT_GAME_FIELDS.filter((k) => g && k in g).map((k) => [k, g[k]])))
  const kept = { day: data?.day, clubs: Array.isArray(data?.clubs) ? data.clubs : [], games }
  try { localStorage.setItem(TODAY_GAMES_CACHE_KEY, JSON.stringify({ userId, day: kept.day, data: kept })) } catch { /* the list still shows */ }
}
