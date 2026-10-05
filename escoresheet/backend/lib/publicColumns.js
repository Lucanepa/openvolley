/**
 * What anonymous readers may see of a row: per-table column allowlists, and
 * per JSON column the keys that may be kept.
 *
 * Two audiences, one rule (no personal data without a session):
 *
 *   LIVE     `?purpose=live` sockets (realtimeHub). Nobody on them is
 *            authenticated: Livescore, and the referee/bench tablets use them
 *            only as a "something changed, refetch" trigger (they get their
 *            data from the PIN-gated relay room or a refetch). So: scores,
 *            team display names and colours, venue, set results, status.
 *            Never rosters, officials, signatures, approvals, connection data,
 *            PINs, event payloads or state snapshots.
 *
 *   ANON_DB  POST /api/db selects without a valid session (server.js). The
 *            public pages read these: the referee/bench fallback when the
 *            relay has no copy of the match (rosters: numbers, names, libero
 *            and captain flags, bench roles), the public scoresheet archive
 *            (teams, venue, result), the tablet match pickers (status, teams,
 *            the *_enabled connection flags). Dates of birth, signatures,
 *            approvals, officials, pending rosters, manual changes and PINs
 *            stay out; JSON columns cannot be filtered or ordered on, so their
 *            hidden keys cannot be probed either.
 *
 * Allowlists, not denylists: a column added to the database later is hidden
 * until it is listed here. Tables that are not listed pass unchanged
 * (redactSecrets in lib/secrets.js still applies to every path).
 *
 * A JSON column listed with a key list keeps only those keys (objects), or
 * only those keys of each element (arrays of objects). `true` keeps it whole.
 */

const TEAM_KEYS = Object.freeze(['name', 'short_name', 'shortName', 'color'])
const MATCH_INFO_KEYS = Object.freeze([
  'hall', 'city', 'league', 'championship_type', 'championship_type_other',
  'match_type_1', 'match_type_1_other', 'match_type_2', 'match_type_3', 'match_type_3_other',
  'best_of'
])
const COIN_TOSS_KEYS = Object.freeze(['team_a', 'team_b', 'confirmed', 'first_serve', 'serve_a'])
// Roster entries as the referee/bench render them. No dob, no country.
const PERSON_KEYS = Object.freeze([
  'id', 'number', 'first_name', 'last_name', 'firstName', 'lastName', 'name',
  'libero', 'isLibero', 'liberoType', 'is_captain', 'isCaptain', 'captain', 'is_lfp', 'isLfp',
  'role', 'position'
])
const CONNECTION_FLAG_KEYS = Object.freeze(['referee_enabled', 'home_bench_enabled', 'away_bench_enabled'])

const MATCH_LIVE_STATE_COLUMNS = Object.freeze({
  id: true,
  match_id: true,
  sport_type: true,
  current_set: true,
  best_of: true,
  match_status: true,
  updated_at: true,
  last_event_type: true,
  last_event_team: true,
  last_event_data: true,
  last_event_ts: true,
  set_interval_active: true,
  set_interval_started_at: true,
  timeout_active: true,
  timeout_started_at: true,
  team_a_name: true,
  team_a_short: true,
  team_a_color: true,
  team_b_name: true,
  team_b_short: true,
  team_b_color: true,
  sets_won_a: true,
  sets_won_b: true,
  points_a: true,
  points_b: true,
  side_a: true,
  serving_team: true,
  server_number: true,
  timeouts_a: true,
  timeouts_b: true,
  challenges_used_a: true,
  challenges_used_b: true,
  // Positions, player numbers and flags only (Scoreboard buildRichLineup).
  lineup_a: true,
  lineup_b: true,
  sanctions_a: true,
  sanctions_b: true,
  subs_a: true,
  subs_b: true,
  scorer_attention_trigger: true,
  set_results: true,
  game_n: true,
  league: true,
  gender: true
})

const SETS_COLUMNS = Object.freeze({
  id: true,
  match_id: true,
  external_id: true,
  sport_type: true,
  index: true,
  home_points: true,
  away_points: true,
  team1_points: true,
  team2_points: true,
  finished: true,
  start_time: true,
  end_time: true,
  updated_at: true,
  test: true
})

// The match row as a live viewer needs it.
const MATCHES_LIVE_COLUMNS = Object.freeze({
  id: true,
  external_id: true,
  sport_type: true,
  game_n: true,
  status: true,
  test: true,
  scheduled_at: true,
  created_at: true,
  updated_at: true,
  current_set: true,
  set_results: true,
  final_score: true,
  winner: true,
  home_team: TEAM_KEYS,
  away_team: TEAM_KEYS,
  match_info: MATCH_INFO_KEYS,
  coin_toss: COIN_TOSS_KEYS
})

export const LIVE_COLUMNS = Object.freeze({
  matches: MATCHES_LIVE_COLUMNS,
  match_live_state: MATCH_LIVE_STATE_COLUMNS,
  sets: SETS_COLUMNS,
  // Live subscribers only use an events change as a refetch trigger: no
  // payload, no state snapshot, no lineups.
  events: Object.freeze({
    id: true,
    match_id: true,
    external_id: true,
    sport_type: true,
    set_index: true,
    type: true,
    seq: true,
    ts: true,
    created_at: true,
    score_a: true,
    score_b: true,
    serve_team: true,
    test: true
  })
})

export const ANON_DB_COLUMNS = Object.freeze({
  matches: Object.freeze({
    ...MATCHES_LIVE_COLUMNS,
    connections: CONNECTION_FLAG_KEYS,
    players_home: PERSON_KEYS,
    players_away: PERSON_KEYS,
    bench_home: PERSON_KEYS,
    bench_away: PERSON_KEYS,
    players_team1: PERSON_KEYS,
    players_team2: PERSON_KEYS,
    team1_data: TEAM_KEYS,
    team2_data: TEAM_KEYS
  })
})

/**
 * Columns an anonymous /api/db select may filter or order on: plain scalar
 * columns. JSON columns are readable in part only, so a filter on them
 * (contains, ->>key) could probe a hidden key; set_results is JSON too.
 */
export const ANON_DB_FILTER_COLUMNS = Object.freeze({
  matches: Object.freeze(['id', 'external_id', 'sport_type', 'game_n', 'status', 'test', 'scheduled_at',
    'created_at', 'updated_at', 'current_set', 'final_score', 'winner'])
})

const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k)

function pickKeys(value, keys) {
  if (value == null || typeof value !== 'object') return value
  const pickOne = (o) => {
    if (o == null || typeof o !== 'object' || Array.isArray(o)) return null
    const out = {}
    for (const k of keys) if (has(o, k)) out[k] = o[k]
    return out
  }
  return Array.isArray(value) ? value.map(pickOne) : pickOne(value)
}

/**
 * A new object with only the allowed columns of `row` (JSON columns reduced to
 * their allowed keys). Rows of tables without a policy are returned as they
 * are. Never mutates `row`.
 * @param {Object<string, Object<string, true|readonly string[]>>} policy  LIVE_COLUMNS or ANON_DB_COLUMNS
 * @param {string} table
 * @param {object} row
 */
export function projectRow(policy, table, row) {
  if (row == null || typeof row !== 'object' || Array.isArray(row)) return row
  const cols = has(policy, table) ? policy[table] : null
  if (!cols) return row
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    if (!has(cols, k)) continue
    const rule = cols[k]
    out[k] = rule === true ? v : pickKeys(v, rule)
  }
  return out
}

/** projectRow for every row of an array (or one row). */
export function projectRows(policy, table, rows) {
  if (Array.isArray(rows)) return rows.map((r) => projectRow(policy, table, r))
  return projectRow(policy, table, rows)
}

/** The realtime hub's projection (LIVE_COLUMNS). */
export const projectLiveRow = (table, row) => projectRow(LIVE_COLUMNS, table, row)

/** True when anonymous /api/db reads of `table` are limited. */
export const hasAnonPolicy = (table) => has(ANON_DB_COLUMNS, table)

const asList = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]))

/**
 * Check an anonymous select against ANON_DB_COLUMNS / ANON_DB_FILTER_COLUMNS.
 *   needsMore  '*', no column list, or a column that is not kept whole was
 *              asked for: the answer will be projected, so a session (if the
 *              caller sent one) would see more.
 *   badFilter  the first filter or order term that is not a plain filterable
 *              column (pgQuery accepts `col` and `col->>key`; the JSON form is
 *              never allowed here), else null. Such a request is refused.
 * @param {string} table
 * @param {object} params  /api/db params
 * @returns {{ needsMore: boolean, badFilter: string|null }}
 */
export function anonSelectCheck(table, params) {
  const cols = has(ANON_DB_COLUMNS, table) ? ANON_DB_COLUMNS[table] : null
  if (!cols) return { needsMore: false, badFilter: null }
  const filterable = new Set(ANON_DB_FILTER_COLUMNS[table] || [])
  const columns = params?.columns
  const items = typeof columns === 'string' ? columns.split(',').map((s) => s.trim()).filter(Boolean) : []
  const needsMore = items.length === 0 || items.some((c) => !has(cols, c) || cols[c] !== true)
  let badFilter = null
  for (const term of [...asList(params?.filters), ...asList(params?.order)]) {
    const col = term && typeof term === 'object' ? term.column : null
    if (typeof col !== 'string' || !filterable.has(col.trim())) {
      badFilter = String(col ?? '').slice(0, 40)
      break
    }
  }
  return { needsMore, badFilter }
}
