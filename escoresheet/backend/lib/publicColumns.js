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
 *   ANON_DB  POST /api/db selects without a valid session (server.js); for
 *            referee_database / svrz_games also those of a session without a
 *            role that fills the sheet's officials (REFEREE_DOB_SPORTS). The
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

import { BlockList, isIP } from 'net'

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
// Indoor home/away benches; beach (openbeach) names its teams team1 / team2.
const CONNECTION_FLAG_KEYS = Object.freeze(['referee_enabled', 'home_bench_enabled', 'away_bench_enabled',
  'team1_bench_enabled', 'team2_bench_enabled'])

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
  // Beach technical timeout (db/008_live_state_tto.sql)
  tto_active: true,
  tto_started_at: true,
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

// What a viewer without a PIN gets of a live state (anonymous /api/db, the
// relay's PIN-less summary and room broadcast): the score, sets, time-outs,
// team names and colours. Line-ups, substitutions, sanctions and the last
// event's data (shirt numbers, a sanction's player or official) need the PIN
// of the match (a match token on /api/db, a PIN-proved socket on the relay).
export const LIVE_STATE_PRIVATE_COLUMNS = Object.freeze([
  'lineup_a', 'lineup_b', 'sanctions_a', 'sanctions_b', 'subs_a', 'subs_b',
  'last_event_data', 'scorer_attention_trigger'
])
// `matches`: the livescore's embed (pgQuery embeds, set_results only)
const MATCH_LIVE_STATE_PUBLIC_COLUMNS = Object.freeze({
  ...Object.fromEntries(Object.entries(MATCH_LIVE_STATE_COLUMNS).filter(([c]) => !LIVE_STATE_PRIVATE_COLUMNS.includes(c))),
  matches: Object.freeze(['set_results'])
})
const MATCH_LIVE_STATE_GRANTED_COLUMNS = Object.freeze({ match_live_state: { ...MATCH_LIVE_STATE_COLUMNS, matches: ['set_results'] } })

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
  // Beach rows (sport_type 'beach') keep their teams here
  team1_data: TEAM_KEYS,
  team2_data: TEAM_KEYS,
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

// The referee picker's suggestions; dates of birth only for an admin or an
// account that can score (server.js REFEREE_DOB_SPORTS). Any other account
// also writes only these columns of a referee it adds.
const REFEREE_DATABASE_COLUMNS = Object.freeze({
  id: true,
  first_name: true,
  last_name: true,
  country: true,
  sport_type: true,
  created_at: true
})

// The official-match loader (LoadOfficialMatchModal); the referees' dates of
// birth only for an admin or an indoor scorer (server.js REFEREE_DOB_SPORTS).
const SVRZ_GAMES_COLUMNS = Object.freeze(Object.fromEntries([
  'id', 'game_number', 'datetime', 'date', 'time', 'team_home', 'team_away', 'league', 'gender',
  'hall', 'city', 'hall_address', 'hall_postal_code', 'match_type', 'match_level',
  'championship_type', 'group_display', 'linesman_1', 'linesman_2', 'match_format',
  'referee_1', 'referee_2', 'referee_1_first_name', 'referee_1_last_name',
  'referee_2_first_name', 'referee_2_last_name', 'phase_name', 'is_supervised',
  'has_supervised_referee', 'convocations', 'synced_at', 'created_at'
].map((c) => [c, true])))

export const ANON_DB_COLUMNS = Object.freeze({
  referee_database: REFEREE_DATABASE_COLUMNS,
  svrz_games: SVRZ_GAMES_COLUMNS,
  // Event payloads (players, sanctions, lineups) need a session; no
  // anonymous page reads events.
  events: LIVE_COLUMNS.events,
  match_live_state: MATCH_LIVE_STATE_PUBLIC_COLUMNS,
  sets: SETS_COLUMNS,
  matches: Object.freeze({
    ...MATCHES_LIVE_COLUMNS,
    connections: CONNECTION_FLAG_KEYS,
    players_home: PERSON_KEYS,
    players_away: PERSON_KEYS,
    bench_home: PERSON_KEYS,
    bench_away: PERSON_KEYS,
    players_team1: PERSON_KEYS,
    players_team2: PERSON_KEYS
  })
})

/**
 * Columns an anonymous /api/db select may filter or order on: plain scalar
 * columns. JSON columns are readable in part only, so a filter on them
 * (contains, ->>key) could probe a hidden key; set_results is JSON too.
 */
export const ANON_DB_FILTER_COLUMNS = Object.freeze({
  // Every public column (sport_type is kept whole, so `contains` on it probes
  // nothing hidden); never dob.
  referee_database: Object.freeze(Object.keys(REFEREE_DATABASE_COLUMNS)),
  svrz_games: Object.freeze(Object.keys(SVRZ_GAMES_COLUMNS)),
  events: Object.freeze(Object.keys(LIVE_COLUMNS.events)),
  match_live_state: Object.freeze(['id', 'match_id', 'sport_type', 'current_set', 'match_status', 'updated_at',
    'game_n', 'league', 'gender']),
  sets: Object.freeze(['id', 'match_id', 'external_id', 'sport_type', 'index', 'finished', 'updated_at', 'test']),
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

/**
 * matches columns holding a team roster (names, numbers): an anonymous reader
 * sees them only for the match its PIN proved (a match access token, see
 * lib/matchAccess.js), i.e. the referee/bench fallback after the PIN step.
 */
export const MATCH_ROSTER_COLUMNS = Object.freeze(['players_home', 'players_away', 'bench_home', 'bench_away', 'players_team1', 'players_team2'])

/**
 * The anonymous /api/db answer: ANON_DB_COLUMNS, and for matches the roster
 * columns only on the row whose external_id is `grantedExternalId` (and, with
 * `grantRow`, for which grantRow(projected row) is true as well). A live
 * state keeps its private columns (LIVE_STATE_PRIVATE_COLUMNS) only on the row
 * of `grantedMatchUuid` (the match token's matches.id: the referee/bench
 * fallback of getMatchData).
 * @param {string} table
 * @param {object|object[]|null} rows
 * @param {{ grantedExternalId?: string|null, grantedMatchUuid?: string|null, grantRow?: (row: object) => boolean }} [opts]
 */
export function projectAnonDbRows(table, rows, { grantedExternalId = null, grantedMatchUuid = null, grantRow = null } = {}) {
  if (table === 'match_live_state' && grantedMatchUuid) {
    const one = (row) => (row != null && typeof row === 'object' && row.match_id === grantedMatchUuid
      ? projectRow(MATCH_LIVE_STATE_GRANTED_COLUMNS, table, row)
      : projectRow(ANON_DB_COLUMNS, table, row))
    return Array.isArray(rows) ? rows.map(one) : one(rows)
  }
  const projected = projectRows(ANON_DB_COLUMNS, table, rows)
  if (table !== 'matches') return projected
  const strip = (row) => {
    if (row == null || typeof row !== 'object') return row
    if (grantedExternalId && row.external_id === grantedExternalId && (!grantRow || grantRow(row))) return row
    for (const c of MATCH_ROSTER_COLUMNS) delete row[c]
    return row
  }
  return Array.isArray(projected) ? projected.map(strip) : strip(projected)
}

/** Column pgQuery adds to a select with opts.readOwner. */
export const OWNED_FLAG = '__owned'

/**
 * A signed-in reader's /api/db answer for matches / events (pgQuery
 * opts.readOwner): rows of a match the reader created or edits stay whole,
 * every other row gets the anonymous projection (projectAnonDbRows). The
 * __owned flag is removed from every row. An account alone is no reason to see
 * other people's rosters, dates of birth, signatures or event payloads.
 * @param {string} table
 * @param {object|object[]|null} rows
 * @param {{ grantedExternalId?: string|null, grantRow?: (row: object) => boolean }} [opts]
 */
export function projectNonOwnerRows(table, rows, opts = {}) {
  const one = (row) => {
    if (row == null || typeof row !== 'object' || Array.isArray(row)) return row
    const owned = row[OWNED_FLAG] === true
    const { [OWNED_FLAG]: _flag, ...clean } = row
    return owned ? clean : projectAnonDbRows(table, clean, opts)
  }
  return Array.isArray(rows) ? rows.map(one) : one(rows)
}

/** projectRow for every row of an array (or one row). */
export function projectRows(policy, table, rows) {
  if (Array.isArray(rows)) return rows.map((r) => projectRow(policy, table, r))
  return projectRow(policy, table, rows)
}

/** The realtime hub's projection (LIVE_COLUMNS). */
export const projectLiveRow = (table, row) => projectRow(LIVE_COLUMNS, table, row)

// The livescore list's columns of a live state (frontend utils/relayLivescore
// LIVESCORE_LIVE_FIELDS): what a summary channel of the hub sends.
const LIVE_SUMMARY_COLUMNS = Object.freeze(Object.fromEntries([
  'id', 'match_id', 'current_set', 'best_of', 'match_status', 'sport_type',
  'team_a_name', 'team_a_short', 'team_a_color', 'team_b_name', 'team_b_short', 'team_b_color',
  'sets_won_a', 'sets_won_b', 'points_a', 'points_b', 'side_a', 'serving_team',
  'timeouts_a', 'timeouts_b', 'timeout_active', 'set_interval_active',
  'last_event_type', 'last_event_ts', 'updated_at', 'game_n', 'league', 'gender', 'set_results'
].map((c) => [c, true])))

/** The realtime hub's summary projection (score-only live states, LIVE_COLUMNS otherwise). */
export const projectLiveSummaryRow = (table, row) => (table === 'match_live_state'
  ? projectRow({ match_live_state: LIVE_SUMMARY_COLUMNS }, table, row)
  : projectLiveRow(table, row))

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

// ---------------------------------------------------------------------------
// The match relay (subscribe-match rooms, GET /api/match/:id)
// ---------------------------------------------------------------------------
//
// Joining a relay room needs no PIN (the referee/bench tablets check theirs
// over HTTP and then subscribe like any viewer), and the room key is the
// match's external_id, which the live projection above hands to every
// anonymous viewer. So what the relay sends is public: the scorer's Dexie
// bundle without personal data. The match object is the scorer's free-form
// Dexie row (the tablets read many of its fields), so this one is a denylist;
// the same lists are in frontend/electron/lanRelayCore.cjs and
// frontend/src-tauri/src/relay.rs.

/** Keys of a person (player, bench member, official) never relayed. */
export const PERSON_PRIVATE_FIELDS = Object.freeze([
  'dob', 'dateOfBirth', 'date_of_birth', 'birthDate', 'birthdate', 'birth_date',
  'country', 'nationality', 'email', 'phone', 'address'
])
/** Match keys never relayed (besides any key containing "signature"). */
export const MATCH_PRIVATE_FIELDS = Object.freeze([
  'officials', 'signatures', 'approval', 'accountApprovals', 'account_approvals', 'manualChanges', 'manual_changes',
  'pendingHomeRoster', 'pendingAwayRoster', 'pending_home_roster', 'pending_away_roster',
  // openbeach's uploaded rosters waiting for the scorer (with dob)
  'pendingTeam1Roster', 'pendingTeam2Roster', 'pending_team1_roster', 'pending_team2_roster'
])
/**
 * Match keys only the referee and the scorer's own devices get (relayBundleView):
 * the remarks name people and their injuries.
 */
export const REFEREE_MATCH_FIELDS = Object.freeze(['remarks'])
/** Match keys holding people: kept, each entry without PERSON_PRIVATE_FIELDS. */
export const MATCH_ROSTER_FIELDS = Object.freeze([
  'players_home', 'players_away', 'bench_home', 'bench_away',
  'players_team1', 'players_team2', 'benchHome', 'benchAway', 'homePlayers', 'awayPlayers',
  'team1Players', 'team2Players'
])
/** The MATCH_ROSTER_FIELDS of each team (beach: team 1 is home, team 2 away). */
const TEAM_ROSTER_FIELDS = Object.freeze({
  home: Object.freeze(['players_home', 'bench_home', 'players_team1', 'benchHome', 'homePlayers', 'team1Players']),
  away: Object.freeze(['players_away', 'bench_away', 'players_team2', 'benchAway', 'awayPlayers', 'team2Players'])
})

const isSignatureKey = (k) => /signature/i.test(k)

function publicPerson(p) {
  if (p == null || typeof p !== 'object' || Array.isArray(p)) return p
  let out = p
  for (const k of PERSON_PRIVATE_FIELDS) {
    if (has(out, k)) {
      if (out === p) out = { ...p }
      delete out[k]
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Before the PIN: the public summary of a relayed match
// ---------------------------------------------------------------------------
//
// A relay socket or HTTP caller that has not proved one of the match's PINs
// (referee, home/away bench, or the game PIN) gets this instead of the bundle:
// teams, status, set scores and the live state (what Livescore and the LedBox
// bridge show anyway). No rosters, no events, no officials. Allowlists; the
// same lists are in frontend/electron/lanRelayCore.cjs and
// frontend/src-tauri/src/relay.rs.

/** Match keys a summary keeps. */
export const SUMMARY_MATCH_FIELDS = Object.freeze([
  'id', 'status', 'gameNumber', 'gameN', 'game_n', 'seed_key', 'seedKey', 'external_id', 'externalId',
  'scheduledAt', 'scheduled_at', 'sport_type', 'sportType', 'test', 'league', 'best_of', 'bestOf',
  'coinTossTeamA', 'coinTossTeamB', 'homeShortName', 'awayShortName', 'homeTeamName', 'awayTeamName',
  'refereeConnectionEnabled', 'homeTeamConnectionEnabled', 'awayTeamConnectionEnabled',
  '_syncedAt', '_syncedSeq', '_syncSession', '_relaySeq', '_relayEpoch'
])
/** Team keys a summary keeps. */
export const SUMMARY_TEAM_FIELDS = Object.freeze(['name', 'shortName', 'short_name', 'color'])
/** Set keys a summary keeps (scores only). */
export const SUMMARY_SET_FIELDS = Object.freeze([
  'id', 'index', 'homePoints', 'awayPoints', 'home_points', 'away_points', 'finished', 'startTime', 'endTime'
])

function pickFields(obj, keys) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return obj ?? null
  const out = {}
  for (const k of keys) if (has(obj, k)) out[k] = obj[k]
  return out
}

/**
 * The PIN-free public summary of a relay bundle ({ match, homeTeam, awayTeam,
 * homePlayers, awayPlayers, sets, events, liveState? }): same shape, rosters
 * and events empty, `access: 'summary'`.
 */
export function relaySummaryBundle(entry) {
  const out = {
    access: 'summary',
    match: pickFields(entry?.match, SUMMARY_MATCH_FIELDS),
    homeTeam: typeof entry?.homeTeam === 'string' ? entry.homeTeam : pickFields(entry?.homeTeam, SUMMARY_TEAM_FIELDS),
    awayTeam: typeof entry?.awayTeam === 'string' ? entry.awayTeam : pickFields(entry?.awayTeam, SUMMARY_TEAM_FIELDS),
    homePlayers: [],
    awayPlayers: [],
    sets: Array.isArray(entry?.sets) ? entry.sets.map((s) => pickFields(s, SUMMARY_SET_FIELDS)) : [],
    events: []
  }
  // no covered line-up of an older scorer app's live state (relayLiveStateView)
  if (entry?.liveState !== undefined) out.liveState = publicLiveState(entry.liveState)
  return out
}

/**
 * A live state as a viewer without a PIN gets it: every column but
 * LIVE_STATE_PRIVATE_COLUMNS (unknown keys such as the scorer's _seq/_session
 * and the relay's _relaySeq stay). Never mutates `liveState`.
 */
export function publicLiveState(liveState) {
  if (!liveState || typeof liveState !== 'object' || Array.isArray(liveState)) return liveState
  const out = { ...liveState }
  for (const c of LIVE_STATE_PRIVATE_COLUMNS) delete out[c]
  return out
}

const LISTED_STATUSES = new Set(['scheduled', 'live'])
// Listed only on request (?finished=1, the livescore): same set as the relays'
const FINISHED_STATUSES = new Set(['final', 'ended', 'completed', 'finished'])

/** A team's display name: a team object or plain string, else `fallback`. */
function teamNameOf(team, fallback) {
  const name = typeof team === 'string' ? team : (team && typeof team === 'object' ? team.name : null)
  return typeof name === 'string' && name.trim() ? name : fallback
}

// Built once: Date#toLocaleDateString / #toLocaleTimeString with options build
// a new Intl formatter on every call (about 66 us), and GET /api/match/list
// formats every match the relay holds on every call. Same text.
const LIST_DATE_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const LIST_TIME_FORMAT = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })

function formatListDateTime(scheduledAt) {
  if (!scheduledAt) return 'TBD'
  try {
    const d = new Date(scheduledAt)
    return `${LIST_DATE_FORMAT.format(d)} ${LIST_TIME_FORMAT.format(d)}`
  } catch {
    // an unparseable date (format throws RangeError)
    return 'TBD'
  }
}

/**
 * One GET /api/match/list row for a relay entry ({ matchId, match, homeTeam,
 * awayTeam, gameNumber? }), or null when the match is not listed. Listed:
 * status 'scheduled' or 'live' (none counts as 'scheduled'), whatever the
 * referee connection — display devices (the point-hub LedBox bridge) need no
 * PIN and pick their match from this list — and with `includeFinished`
 * (?finished=1, the livescore on a venue relay) a finished one too. Public
 * fields only: no PINs, no people. Same rule as lanRelayCore matchListEntry
 * and relay.rs match_list_entry.
 * @param {object} entry
 * @param {{ includeFinished?: boolean }} [options]
 */
export function relayMatchListRow(entry, { includeFinished = false } = {}) {
  const match = (entry?.match && typeof entry.match === 'object') ? entry.match : {}
  const status = match.status == null || match.status === '' ? 'scheduled' : String(match.status)
  if (!LISTED_STATUSES.has(status) && !(includeFinished && FINISHED_STATUSES.has(status.toLowerCase()))) return null
  // Only a string or a finite number: the /api/match/list sort calls new Date()
  // on this, which throws for an object whose toString is not a function, and
  // that makes the whole list answer 500 (a sync stores only validated values,
  // this is the second guard on the read).
  const scheduledAt = typeof match.scheduledAt === 'string' || Number.isFinite(match.scheduledAt) ? match.scheduledAt : null
  return {
    id: entry.matchId,
    gameNumber: entry.gameNumber || match.gameNumber || match.game_n || entry.matchId,
    homeTeam: teamNameOf(entry.homeTeam, teamNameOf(match.homeTeamName, 'Home')),
    awayTeam: teamNameOf(entry.awayTeam, teamNameOf(match.awayTeamName, 'Away')),
    scheduledAt,
    dateTime: formatListDateTime(scheduledAt),
    status,
    // 'beach' (openbeach) or 'indoor': each app lists its own sport's matches
    sportType: entry.sportType === 'beach' ? 'beach' : 'indoor',
    test: match.test === true,
    refereeConnectionEnabled: match.refereeConnectionEnabled === true,
    homeTeamConnectionEnabled: match.homeTeamConnectionEnabled === true,
    awayTeamConnectionEnabled: match.awayTeamConnectionEnabled === true
  }
}

// Addresses that are no venue's own public address: on the cloud they are a
// proxy in front of the relay (Traefik, Docker), shared by every caller.
const NON_PUBLIC = new BlockList()
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]]) {
  NON_PUBLIC.addSubnet(net, bits, 'ipv4')
}
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]]) NON_PUBLIC.addSubnet(net, bits, 'ipv6')

/** A routable internet address (not loopback, private, CGNAT or link-local). */
export function isPublicIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '')
  const family = isIP(s)
  if (!family) return false
  return !NON_PUBLIC.check(s, family === 4 ? 'ipv4' : 'ipv6')
}

/**
 * Does the CLOUD relay's GET /api/match/list show this match to this caller?
 * A match with the referee connection on: to everyone (the referee tablets
 * pick it there). Any other: only to a caller on the same public address
 * (bucket) as one of the match's scoreboard sockets — the venue's own
 * displays (the point-hub LedBox bridge) behind the hall's NAT — so the room
 * keys of every official match are not handed to anonymous callers
 * worldwide. Behind a proxy whose client address is not passed on, every
 * caller is the proxy (not public): then only the first rule applies.
 * A LAN / venue relay lists every match (it is the venue).
 * @param {{ refereeConnectionEnabled?: boolean, requesterIp?: string, requesterIpKey?: string, ownerIpKeys?: Iterable<string> }} args
 */
export function cloudListsMatch({ refereeConnectionEnabled = false, requesterIp = '', requesterIpKey = '', ownerIpKeys = [] } = {}) {
  if (refereeConnectionEnabled === true) return true
  if (!requesterIpKey || !isPublicIp(requesterIp)) return false
  for (const key of ownerIpKeys) if (key === requesterIpKey) return true
  return false
}

/** A roster array (or anything else, returned as is) without personal keys. */
export const publicPeople = (list) => (Array.isArray(list) ? list.map(publicPerson) : list)

/**
 * A match object as the relay may hand it out: no MATCH_PRIVATE_FIELDS, no
 * REFEREE_MATCH_FIELDS (relayBundleView gives those back to the referee), no
 * signature keys, rosters without dates of birth/country. PINs are NOT
 * handled here (stripMatchSecrets in server.js). Never mutates `match`.
 */
export function publicRelayMatch(match) {
  if (match == null || typeof match !== 'object' || Array.isArray(match)) return match
  const out = {}
  for (const [k, v] of Object.entries(match)) {
    if (MATCH_PRIVATE_FIELDS.includes(k) || REFEREE_MATCH_FIELDS.includes(k) || isSignatureKey(k)) continue
    out[k] = MATCH_ROSTER_FIELDS.includes(k) ? publicPeople(v) : v
  }
  return out
}

// ---------------------------------------------------------------------------
// After the PIN: the bundle by what the PIN proved
// ---------------------------------------------------------------------------
//
// Any PIN of the match opens the bundle, but each tablet gets what its screen
// needs (relayBundleView): the referee and the scorer's own devices (game
// PIN) both rosters and the remarks; a bench its own roster and, of the other
// team, the shirt numbers only, and no remarks, not on the events either.
// Team rows: names and colours. Nobody gets a date of birth or the account
// approvals. A team's first line-up of a set stays off the other bench while
// it is covered (only that team's line-up is in and no point has been scored:
// FIVB 7.3, frontend/src/domain/lineupPrivacy.js): its events of the set, its
// game captain on the match row, and the line-up in the live state of an
// older scorer app, which no PIN-less socket gets either. The LAN relays
// (frontend/electron/lanRelayCore.cjs, frontend/src-tauri/src/relay.rs) do
// not apply it yet: they hand the whole bundle to any PIN holder.

/** Team keys a bundle keeps: the names and colours the tablets draw. */
export const RELAY_TEAM_FIELDS = Object.freeze([...SUMMARY_TEAM_FIELDS, 'liberoColor', 'liberoColour', 'libero_color', 'libero_colour'])

/**
 * The bundle view a proved PIN type (lib/matchAccess.js pinTypeOf: 'game',
 * 'referee', 'bench_home', ...) or match token role ('homeTeam', ...) gets:
 * 'scorer', 'referee', 'home', 'away', else null.
 */
export function relayViewOf(type) {
  switch (type) {
    case 'game': return 'scorer'
    case 'referee': return 'referee'
    case 'bench_home': case 'homeTeam': case 'bench_team1': return 'home'
    case 'bench_away': case 'awayTeam': case 'bench_team2': return 'away'
    default: return null
  }
}

// A corrected date of birth in the remarks (an older scorer's in-match roster
// edit wrote "Player #7 dob: 03.05.2011 → 04.06.2011 (Team)"): the change
// stays, the two dates go. The values run to the team label at the end of the
// line, or to its end. Read with indexOf, never a backtracking pattern: the
// remarks are the scorer's own text, as long as a bundle may be, and this
// runs on the relay's one thread for every bundle a referee gets.
const DOB_LABEL = 'dob: '
const DOB_ARROWS = Object.freeze([' → ', ' -> '])
const DOB_CHANGED = 'date of birth changed'
// Where a line ends (the line ends of `.` and `$` in a pattern)
const LINE_END = /[\n\r\u2028\u2029]/g
const WORD_CHAR = /[A-Za-z0-9_]/

/** Where the value after the first arrow at or after `from` starts, or -1. */
function dobValueAt(line, from) {
  let start = -1
  let length = 0
  for (const arrow of DOB_ARROWS) {
    const i = line.indexOf(arrow, from)
    if (i !== -1 && (start === -1 || i < start)) {
      start = i
      length = arrow.length
    }
  }
  return start === -1 ? -1 : start + length
}

/** Where a line's trailing " (Team)" starts (no brackets inside), or -1. */
function teamLabelAt(line) {
  if (!line.endsWith(')')) return -1
  const at = line.lastIndexOf(' (')
  if (at === -1) return -1
  const inner = line.slice(at + 2, -1)
  return inner.includes('(') || inner.includes(')') ? -1 : at
}

/** The remarks text without the values of date-of-birth corrections. */
export function redactRemarkDobs(text) {
  if (typeof text !== 'string' || !text.includes(DOB_LABEL)) return text
  let out = ''
  let copied = 0
  let from = 0
  for (;;) {
    const at = text.indexOf(DOB_LABEL, from)
    if (at === -1) break
    if (at > 0 && WORD_CHAR.test(text[at - 1])) {
      from = at + 1
      continue
    }
    LINE_END.lastIndex = at
    const lineEnd = LINE_END.exec(text)?.index ?? text.length
    // from "dob: " to the end of its line: at least one character before
    // the arrow and one after it
    const rest = text.slice(at, lineEnd)
    const value = dobValueAt(rest, DOB_LABEL.length + 1)
    if (value === -1 || value >= rest.length) {
      from = lineEnd
      continue
    }
    const label = teamLabelAt(rest)
    out += text.slice(copied, at) + DOB_CHANGED
    copied = from = at + (label > value ? label : rest.length)
  }
  return copied === 0 ? text : out + text.slice(copied)
}

/** Someone of the other team on a bench's tablet: the shirt number (an official: the role). */
function numberOnly(p) {
  if (p == null || typeof p !== 'object' || Array.isArray(p)) return p
  if (has(p, 'number')) return { number: p.number }
  return has(p, 'role') ? { role: p.role } : {}
}

const relayTeam = (team) => (typeof team === 'string' ? team : pickFields(team, RELAY_TEAM_FIELDS))
const relayPeople = (list, numbersOnly) => (Array.isArray(list) ? list.map(numbersOnly ? numberOnly : publicPerson) : [])

// Remark text on the events: every event's remark line (payload.autoRemark),
// and a 'remark' event's added lines and the whole remarks text after them
// (the scorer's Remarks dialog: text, fullRemarks; a test match's message)
const EVENT_REMARK_KEYS = Object.freeze(['autoRemark'])
const REMARK_EVENT_KEYS = Object.freeze(['text', 'fullRemarks', 'message'])
const remarkKeysOf = (e) => (e.type === 'remark' ? [...EVENT_REMARK_KEYS, ...REMARK_EVENT_KEYS] : EVENT_REMARK_KEYS)

/** An event with `fn` applied to its remark text (fn returns undefined: the key goes). */
function mapEventRemarks(e, fn) {
  if (!e?.payload || typeof e.payload !== 'object' || Array.isArray(e.payload)) return e
  let payload = null
  for (const k of remarkKeysOf(e)) {
    if (!has(e.payload, k)) continue
    const v = fn(e.payload[k])
    if (v === e.payload[k]) continue
    payload ??= { ...e.payload }
    if (v === undefined) delete payload[k]
    else payload[k] = v
  }
  return payload ? { ...e, payload } : e
}

const officialEvent = (e) => mapEventRemarks(e, redactRemarkDobs)
const benchEvent = (e) => mapEventRemarks(e, () => undefined)

// Once per stored bundle, not per bundle sent: a room's remarks and events go
// out with every bundle, to every socket. Keyed by the stored match and
// events array, which a sync replaces and the relay never changes in place
// (server.js handleSyncMatchData); a WeakMap keeps nothing past its room.
function storedOnce(fn) {
  const memo = new WeakMap()
  return (obj) => {
    if (obj == null || typeof obj !== 'object') return fn(obj)
    if (!memo.has(obj)) memo.set(obj, fn(obj))
    return memo.get(obj)
  }
}
const officialRemarksOf = storedOnce((match) => redactRemarkDobs(match.remarks))
const officialEventsOf = storedOnce((events) => (Array.isArray(events) ? events.map(officialEvent) : []))

/**
 * The sets in which one team's first line-up is covered (only that team's
 * line-up is in and no point has been scored): setIndex → 'home' / 'away'.
 */
const coveredLineupSets = storedOnce((events) => {
  const sets = new Map()
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue
    const i = Number(e.setIndex ?? 1)
    const s = sets.get(i) || { started: false, home: false, away: false }
    if (e.type === 'point') s.started = true
    if (e.type === 'lineup' && (e.payload?.team === 'home' || e.payload?.team === 'away')) s[e.payload.team] = true
    sets.set(i, s)
  }
  const covered = new Map()
  for (const [i, s] of sets) {
    if (!s.started && s.home !== s.away) covered.set(i, s.home ? 'home' : 'away')
  }
  return covered
})

/**
 * The events a bench of `team` ('home' / 'away', null: neither) gets: no
 * remark text, and none of the other team's events of a set in which that
 * team's first line-up is covered (coveredLineupSets).
 */
function benchEvents(events, team, covered) {
  if (!Array.isArray(events)) return []
  const out = []
  for (const e of events) {
    const coveredTeam = e && typeof e === 'object' ? covered.get(Number(e.setIndex ?? 1)) : undefined
    if (coveredTeam && coveredTeam !== team && e.payload?.team === coveredTeam) continue
    out.push(benchEvent(e))
  }
  return out
}

// The game captain chosen in the line-up dialog is written to the match row
// as well (frontend/src/domain/lineupEntry.js lineupGameCaptainDecision): one
// starter of the line-up, and whether the team captain starts
const COURT_CAPTAIN_FIELDS = Object.freeze({
  home: Object.freeze(['homeCourtCaptain', 'homeRememberedCourtCaptain']),
  away: Object.freeze(['awayCourtCaptain', 'awayRememberedCourtCaptain'])
})

/**
 * The match row of the bundle for `view` (relayViewOf; any other: the bench
 * of neither team). The referee and the scorer's own devices: the remarks
 * without date-of-birth values. A bench: no remarks, the other team's people
 * as shirt numbers (officials: role), and while that team's first line-up is
 * covered, not its game captain. PINs are NOT handled here
 * (stripMatchSecrets in server.js). Never mutates `entry`.
 * @param {object} entry the stored bundle ({ match, events, ... })
 * @param {'scorer'|'referee'|'home'|'away'|null} view
 * @param {Map<number, 'home'|'away'>} [covered] coveredLineupSets(entry.events)
 */
export function relayMatchView(entry, view, covered = coveredLineupSets(entry?.events)) {
  const match = publicRelayMatch(entry?.match)
  if (!match || typeof match !== 'object' || Array.isArray(match)) return match
  if (view === 'referee' || view === 'scorer') {
    if (has(entry.match, 'remarks')) match.remarks = officialRemarksOf(entry.match)
    return match
  }
  const team = view === 'home' || view === 'away' ? view : null
  for (const side of ['home', 'away']) {
    if (side === team) continue
    for (const k of TEAM_ROSTER_FIELDS[side]) if (Array.isArray(match[k])) match[k] = match[k].map(numberOnly)
  }
  for (const side of new Set(covered.values())) {
    if (side !== team) for (const k of COURT_CAPTAIN_FIELDS[side]) delete match[k]
  }
  return match
}

// A covered line-up in the live state: the set at 0:0 and only one team's
// line-up in. The scorer app sends it as null (frontend/src/domain/
// lineupPrivacy.js withCoveredLiveLineups); an older one sends it as it is,
// and the relay covers it (relayLiveStateView).
const isLiveLineup = (v) => v != null && typeof v === 'object' && Object.keys(v).length > 0
const teamAOf = (match) => (match?.coinTossTeamA === 'away' ? 'away' : 'home')

/**
 * The team ('home' / 'away') whose first line-up the live state carries while
 * it is covered, or null. Team A is the match's coinTossTeamA.
 * @param {object} liveState match_live_state shape (Team A / B)
 * @param {object} [match] the stored match
 */
export function coveredLiveLineupTeam(liveState, match) {
  if (!liveState || typeof liveState !== 'object' || Array.isArray(liveState)) return null
  if ((Number(liveState.points_a) || 0) + (Number(liveState.points_b) || 0) !== 0) return null
  const a = isLiveLineup(liveState.lineup_a)
  if (a === isLiveLineup(liveState.lineup_b)) return null
  const teamA = teamAOf(match)
  return a ? teamA : (teamA === 'home' ? 'away' : 'home')
}

/**
 * The live state as `view` (relayViewOf; null: no PIN proved) may get it:
 * while it carries a covered line-up (coveredLiveLineupTeam), everyone but
 * the referee, the scorer's own devices and that team's bench gets that
 * line-up as null (with it the number of its server) and no numbers of its
 * last action, as the scorer app sends it. Never mutates `liveState`.
 * @param {object} liveState
 * @param {string|null} view
 * @param {object} [match] the stored match (Team A)
 */
export function relayLiveStateView(liveState, view, match) {
  const covered = coveredLiveLineupTeam(liveState, match)
  if (!covered || view === 'referee' || view === 'scorer' || view === covered) return liveState
  const out = { ...liveState }
  if (covered === teamAOf(match)) out.lineup_a = null
  else out.lineup_b = null
  const data = out.last_event_data
  if (data != null && out.last_event_team === covered) {
    out.last_event_data = null
  } else if (data?.lastAction && data.lastAction.team === covered) {
    out.last_event_data = { ...data, lastAction: { ...data.lastAction, data: {} } }
  }
  return out
}

/**
 * The bundle ({ match, homeTeam, awayTeam, homePlayers, awayPlayers, sets,
 * events, liveState? }) for a socket whose PIN proved `view` (relayViewOf).
 * PINs are NOT handled here (stripMatchSecrets in server.js). Never mutates
 * `entry`. Any other view gets the bench view of neither team.
 * @param {object} entry
 * @param {'scorer'|'referee'|'home'|'away'|null} view
 */
export function relayBundleView(entry, view) {
  const official = view === 'referee' || view === 'scorer'
  const team = view === 'home' || view === 'away' ? view : null
  const numbersOf = (side) => !official && side !== team
  const covered = coveredLineupSets(entry?.events)
  const out = {
    match: relayMatchView(entry, view, covered),
    homeTeam: relayTeam(entry?.homeTeam),
    awayTeam: relayTeam(entry?.awayTeam),
    homePlayers: relayPeople(entry?.homePlayers, numbersOf('home')),
    awayPlayers: relayPeople(entry?.awayPlayers, numbersOf('away')),
    sets: entry?.sets || [],
    events: official
      ? officialEventsOf(entry?.events)
      : benchEvents(entry?.events, team, covered)
  }
  if (entry?.liveState !== undefined) out.liveState = relayLiveStateView(entry.liveState, view, entry?.match)
  return out
}
