/**
 * Public match API: what a website may embed.
 *
 *   GET /api/public/v1/matches            list (date window, status)
 *   GET /api/public/v1/matches/:id        match info incl. officials (roles only)
 *   GET /api/public/v1/matches/:id/live   livescore snapshot
 *   GET /api/public/v1/matches/:id/stream the same snapshot as Server-Sent Events
 *   GET /api/public/v1/matches/:id/stats  statistics, once the match is finished
 *   GET /embed/livescore.js               <ov-livescore match="..."> widget
 *
 * NO NAMES, anywhere: players are shirt numbers (with captain / libero flags),
 * officials and bench staff are roles ("1st referee", "head coach"). Dates of
 * birth, signatures, licence numbers, PINs and remarks never appear. Team names
 * are club data and stay. Every key is built here from an allowlist, so a field
 * added to a row later is hidden until it is listed.
 *
 * The live snapshot follows the anonymous live projection (publicColumns.js
 * LIVE_STATE_PRIVATE_COLUMNS): no line-ups, substitutions or sanctions, which
 * need the match PIN. The statistics of a finished match say when a team
 * substituted or was sanctioned, never which shirt number or why (an injury,
 * an expulsion): rosters with names are readable elsewhere by number.
 *
 * Pure builders (no I/O) first, then createPublicApi({ pool }) for the queries.
 * Every handler answers { status, body, headers? } and never throws.
 */

import { LIVE_STATE_PRIVATE_COLUMNS } from './publicColumns.js'

const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null))
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const jsonOf = (v) => {
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return null }
}
const POSITIONS = ['I', 'II', 'III', 'IV', 'V', 'VI']

/** External ids are free text up to 200 characters; nothing else is accepted. */
export const MATCH_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/

// ---------------------------------------------------------------- builders

function team(t, fallback) {
  const o = isObj(t) ? t : {}
  return {
    name: str(o.name) || fallback,
    shortName: str(o.short_name) || str(o.shortName),
    color: str(o.color, 20)
  }
}

/** Officials as roles only. Accepts the array form, the old role-keyed object, or nothing. */
export function publicOfficials(raw) {
  const v = jsonOf(raw)
  const roles = []
  if (Array.isArray(v)) {
    for (const o of v) {
      const role = str(isObj(o) ? o.role : null, 40)
      // a role is listed once it has someone in it (a line judge carries `name`)
      const filled = isObj(o) && ['firstName', 'lastName', 'first_name', 'last_name', 'name']
        .some((k) => typeof o[k] === 'string' && o[k].trim())
      if (role && filled) roles.push(role.toLowerCase())
    }
  } else if (isObj(v)) {
    for (const [role, o] of Object.entries(v)) {
      if (o && (typeof o !== 'object' || Object.values(o).some((x) => typeof x === 'string' && x.trim()))) {
        roles.push(role.replace(/_/g, ' ').toLowerCase().slice(0, 40))
      }
    }
  }
  return [...new Set(roles)].map((role) => ({ role }))
}

/** A roster as numbers and flags (never names or dates of birth). */
export function publicRoster(raw) {
  const v = jsonOf(raw)
  if (!Array.isArray(v)) return []
  const out = []
  for (const p of v) {
    if (!isObj(p)) continue
    const number = num(p.number)
    if (number == null) continue
    const lib = p.libero || p.isLibero || p.liberoType
    out.push({
      number,
      captain: !!(p.is_captain || p.isCaptain || p.captain),
      libero: !!lib && lib !== 'none'
    })
  }
  return out.sort((a, b) => a.number - b.number)
}

/** Bench staff as roles (a role is listed once per person). */
export function publicBench(raw) {
  const v = jsonOf(raw)
  if (!Array.isArray(v)) return []
  const out = []
  for (const p of v) {
    const role = str(isObj(p) ? (p.role || p.position) : null, 40)
    if (role) out.push({ role: role.toLowerCase() })
  }
  return out
}

// What the database calls a finished match: matches.status 'final' (older rows 'ended';
// 'approved' between the approval and Close match, db/007), live row 'ended'
const FINISHED_DB = ['final', 'approved', 'ended', 'finished']
const isFinished = (v) => FINISHED_DB.includes(v)
// The API's own words: setup, scheduled, live, finished
const STATUS = new Set(['setup', 'scheduled', 'live', 'finished'])
const normStatus = (v) => (isFinished(v) ? 'finished' : (v || null))

export function publicMatchInfo(row, { withRosters = true } = {}) {
  const info = isObj(jsonOf(row.match_info)) ? jsonOf(row.match_info) : {}
  const home = row.sport_type === 'beach' ? row.team1_data : row.home_team
  const away = row.sport_type === 'beach' ? row.team2_data : row.away_team
  const homeKey = row.sport_type === 'beach' ? 'players_team1' : 'players_home'
  const awayKey = row.sport_type === 'beach' ? 'players_team2' : 'players_away'
  const out = {
    id: row.external_id,
    sport: row.sport_type || 'indoor',
    gameNumber: row.game_n ?? null,
    status: normStatus(row.status),
    scheduledAt: iso(row.scheduled_at),
    league: str(info.league),
    venue: { hall: str(info.hall), city: str(info.city) },
    bestOf: num(info.best_of),
    home: team(jsonOf(home), 'Home'),
    away: team(jsonOf(away), 'Away'),
    officials: publicOfficials(row.officials),
    updatedAt: iso(row.updated_at)
  }
  if (withRosters) {
    out.home.players = publicRoster(row[homeKey])
    out.away.players = publicRoster(row[awayKey])
    out.home.staff = publicBench(row.bench_home)
    out.away.staff = publicBench(row.bench_away)
  }
  if (row.final_score) out.result = { score: String(row.final_score).slice(0, 20), winner: str(row.winner, 10) }
  return out
}

const lineupNumbers = (l) => {
  const v = jsonOf(l)
  if (!isObj(v)) return null
  const out = {}
  for (const p of POSITIONS) {
    const e = v[p]
    const n = num(isObj(e) ? e.number : e)
    if (n != null) {
      out[p] = n
    }
  }
  return Object.keys(out).length ? out : null
}

function homeSide(row) {
  const home = str(isObj(jsonOf(row.home_team)) ? jsonOf(row.home_team).name : null)
  if (home && str(row.team_b_name) === home && str(row.team_a_name) !== home) return 'B'
  return 'A'
}

/**
 * The livescore snapshot: scores, sets, time-outs, from match_live_state (+ the
 * match row). The PIN-only columns are dropped first, whatever reads them below.
 */
export function publicLive(input) {
  const row = { ...input }
  for (const c of LIVE_STATE_PRIVATE_COLUMNS) delete row[c]
  const sets = jsonOf(row.set_results)
  return {
    id: row.external_id,
    status: normStatus(row.match_status || row.status),
    sport: row.sport_type || 'indoor',
    currentSet: num(row.current_set),
    bestOf: num(row.best_of),
    home: team(jsonOf(row.home_team), row.team_a_name || 'Home'),
    away: team(jsonOf(row.away_team), row.team_b_name || 'Away'),
    // The live row labels the teams A / B; `sideA` says which half A plays on.
    score: { setsA: num(row.sets_won_a), setsB: num(row.sets_won_b), pointsA: num(row.points_a), pointsB: num(row.points_b) },
    teams: {
      A: { name: str(row.team_a_name) || 'A', shortName: str(row.team_a_short), color: str(row.team_a_color, 20), timeouts: num(row.timeouts_a), challenges: num(row.challenges_used_a) },
      B: { name: str(row.team_b_name) || 'B', shortName: str(row.team_b_short), color: str(row.team_b_color, 20), timeouts: num(row.timeouts_b), challenges: num(row.challenges_used_b) }
    },
    // the scoresheet's A / B are not always home / away: homeIs says which one is the home team
    homeIs: homeSide(row),
    sideA: str(row.side_a, 10),
    serving: str(row.serving_team, 10),
    serverNumber: num(row.server_number),
    setResults: (Array.isArray(sets) ? sets : []).filter(isObj).map((s) => ({
      set: num(s.index), pointsA: num(s.pointsA ?? s.home_points), pointsB: num(s.pointsB ?? s.away_points), winner: str(s.winner, 2)
    })),
    timeout: !!row.timeout_active,
    setInterval: !!row.set_interval_active,
    technicalTimeout: !!row.tto_active,
    updatedAt: iso(row.updated_at)
  }
}

/**
 * End-of-match statistics from the (non-voided) events, in order. Events carry
 * `team: 'home'|'away'` and shirt numbers; nothing else is read from a payload.
 * @param {object} match  the match row
 * @param {object[]} events  rows ordered by set_index, seq
 * @param {object[]} sets  rows of `sets`
 */
export function buildStats(match, events, sets) {
  const bySet = new Map()
  const setOf = (i) => {
    if (!bySet.has(i)) {
      bySet.set(i, {
        set: i, points: { home: 0, away: 0 }, winner: null, startingLineup: {}, pointLog: [],
        timeouts: [], substitutions: [], sanctions: [], liberoActions: 0, longestRun: { home: 0, away: 0 }, _run: { team: null, n: 0 }
      })
    }
    return bySet.get(i)
  }
  const totals = { home: { points: 0, timeouts: 0, substitutions: 0, sanctions: 0 }, away: { points: 0, timeouts: 0, substitutions: 0, sanctions: 0 } }
  const side = (t) => (t === 'home' || t === 'away' ? t : null)

  for (const ev of events) {
    const p = isObj(jsonOf(ev.payload)) ? jsonOf(ev.payload) : {}
    const i = num(ev.set_index) ?? 1
    const s = setOf(i)
    const t = side(p.team)
    const at = { home: s.points.home, away: s.points.away }
    switch (ev.type) {
      case 'lineup': {
        const nums = lineupNumbers(p.lineup)
        // the first lineup of a team in a set, before any point, is the starting line-up
        if (t && nums && !p.fromSubstitution && !s.startingLineup[t] && s.pointLog.length === 0) s.startingLineup[t] = nums
        break
      }
      case 'point':
        if (t) {
          s.points[t]++
          totals[t].points++
          s.pointLog.push([s.points.home, s.points.away, t === 'home' ? 'H' : 'A'])
          if (s._run.team === t) s._run.n++
          else s._run = { team: t, n: 1 }
          if (s._run.n > s.longestRun[t]) s.longestRun[t] = s._run.n
        }
        break
      case 'timeout':
        if (t) { s.timeouts.push({ team: t, at }); totals[t].timeouts++ }
        break
      case 'substitution':
        if (t) {
          // not who (rosters with names are public by number) or why (injury, expulsion)
          s.substitutions.push({ team: t, at })
          totals[t].substitutions++
        }
        break
      case 'sanction':
        if (t) {
          s.sanctions.push({ team: t, type: str(p.type, 30), at })
          totals[t].sanctions++
        }
        break
      case 'libero_entry':
      case 'libero_exit':
      case 'libero_exchange':
        s.liberoActions++
        break
      case 'set_end':
        s.winner = side(p.team)
        break
      default:
    }
  }

  const durations = new Map((sets || []).map((r) => [num(r.index), r]))
  const setsOut = [...bySet.values()].sort((a, b) => a.set - b.set).map((s) => {
    const r = durations.get(s.set)
    const start = r?.start_time ? new Date(r.start_time) : null
    const end = r?.end_time ? new Date(r.end_time) : null
    const { _run, ...rest } = s
    return {
      ...rest,
      startedAt: iso(r?.start_time),
      endedAt: iso(r?.end_time),
      minutes: start && end && end > start ? Math.round((end - start) / 60000) : null
    }
  }).filter((s) => s.pointLog.length > 0 || s.timeouts.length || s.substitutions.length)

  return {
    id: match.external_id,
    status: normStatus(match.status),
    result: match.final_score ? { score: String(match.final_score).slice(0, 20), winner: str(match.winner, 10) } : null,
    home: team(jsonOf(match.sport_type === 'beach' ? match.team1_data : match.home_team), 'Home').name,
    away: team(jsonOf(match.sport_type === 'beach' ? match.team2_data : match.away_team), 'Away').name,
    totals,
    sets: setsOut
  }
}

// ---------------------------------------------------------------- data layer

// The list shows no rosters: up to 200 rows, so their JSON is not read at all
const LIST_COLUMNS = `m.external_id, m.sport_type, m.game_n, m.status, m.scheduled_at, m.final_score, m.winner,
  m.match_info, m.officials, m.home_team, m.away_team, m.team1_data, m.team2_data, m.updated_at`
const MATCH_COLUMNS = `${LIST_COLUMNS},
  m.players_home, m.players_away, m.players_team1, m.players_team2, m.bench_home, m.bench_away, m.closed_at`
// Built statistics of CLOSED matches, by id and updated_at: up to 20000 events
// are read once, not on every anonymous request. Only closed ones: a correction
// (lib/eventRevisions.js) or an event that syncs late from an offline scorer
// writes events only, so updated_at of a finished but open match does not
// move. Children of a closed match are frozen (ov_match_children_guard), and an
// admin change or reopen updates the row (adminMatchUpdate), so updated_at does.
const STATS_CACHE_MAX = 100

const ok = (body, headers = {}) => ({ status: 200, body, headers })
const fail = (status, error) => ({ status, body: { error } , headers: { 'Cache-Control': 'no-store' } })
const MISSING = new Set(['42P01', '42703'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function createPublicApi({ pool, logger = console } = {}) {
  const statsCache = new Map() // `${id}|${updated_at}` -> body
  async function guarded(what, fn) {
    try {
      return await fn()
    } catch (err) {
      logger.error?.(`[public-api] ${what} failed:`, err?.message)
      if (MISSING.has(err?.code)) return fail(404, 'not available')
      return fail(503, 'temporarily unavailable')
    }
  }

  // test rows (rehearsals) are never public
  async function matchRow(id) {
    const { rows } = await pool.query(
      `SELECT ${MATCH_COLUMNS}, m.id AS _id FROM public.matches m
        WHERE m.external_id = $1 AND coalesce(m.test, false) = false LIMIT 1`, [id])
    return rows[0] || null
  }

  async function list({ from, to, status, limit, teams = null, club = null }) {
    return guarded('list', async () => {
      const lim = Math.min(Math.max(Number(limit) || 50, 1), 200)
      const now = Date.now()
      const f = from && !Number.isNaN(Date.parse(from)) ? new Date(from) : new Date(now - 24 * 3600e3)
      const t = to && !Number.isNaN(Date.parse(to)) ? new Date(to) : new Date(now + 7 * 24 * 3600e3)
      if (t - f > 62 * 24 * 3600e3) return fail(400, 'window too long (max 62 days)')
      const args = [f.toISOString(), t.toISOString()]
      let statusSql = ''
      if (status) {
        const list = String(status).split(',').map((s) => s.trim()).filter((s) => STATUS.has(s))
        if (!list.length) return fail(400, 'unknown status')
        args.push(list.flatMap((x) => (x === 'finished' ? FINISHED_DB : [x])))
        statusSql = ` AND m.status = ANY($${args.length})`
      }
      // one club's matches: its team names (the club API) or a club id (the public ?club=)
      let names = Array.isArray(teams) ? teams : null
      if (!names && club) {
        if (!UUID_RE.test(club)) return fail(400, 'bad club id')
        names = (await pool.query('SELECT team_name FROM public.club_teams WHERE club_id = $1', [club])).rows.map((r) => r.team_name)
      }
      let clubSql = ''
      if (names) {
        if (!names.length) return ok({ matches: [] }, { 'Cache-Control': 'public, max-age=15' })
        args.push(names)
        clubSql = ` AND (m.home_team->>'name' = ANY($${args.length}) OR m.away_team->>'name' = ANY($${args.length}))`
      }
      args.push(lim)
      const { rows } = await pool.query(
        `SELECT ${LIST_COLUMNS} FROM public.matches m
          WHERE coalesce(m.test, false) = false AND m.external_id IS NOT NULL
            AND m.scheduled_at >= $1 AND m.scheduled_at < $2${statusSql}${clubSql}
          ORDER BY m.scheduled_at, m.game_n LIMIT $${args.length}`, args)
      return ok({ matches: rows.map((r) => publicMatchInfo(r, { withRosters: false })) }, { 'Cache-Control': 'public, max-age=15' })
    })
  }

  /** Is one of `names` playing in match `id`? (the club API's check before it serves a match) */
  async function involves(id, names) {
    if (!MATCH_ID_RE.test(id) || !names?.length) return false
    const { rows } = await pool.query(
      `SELECT 1 FROM public.matches m WHERE m.external_id = $1 AND coalesce(m.test, false) = false
          AND (m.home_team->>'name' = ANY($2) OR m.away_team->>'name' = ANY($2))`, [id, names])
    return rows.length > 0
  }

  async function info(id) {
    return guarded('info', async () => {
      if (!MATCH_ID_RE.test(id)) return fail(400, 'bad match id')
      const r = await matchRow(id)
      if (!r) return fail(404, 'match not found')
      return ok(publicMatchInfo(r), { 'Cache-Control': 'public, max-age=15' })
    })
  }

  /** The raw snapshot (also what the stream polls). */
  async function liveSnapshot(id) {
    const { rows } = await pool.query(
      `SELECT l.*, m.external_id, m.home_team, m.away_team, m.status
         FROM public.matches m LEFT JOIN public.match_live_state l ON l.match_id = m.id
        WHERE m.external_id = $1 AND coalesce(m.test, false) = false LIMIT 1`, [id])
    const r = rows[0]
    if (!r) return null
    // a match that has not started has no live row: score zero from the match row
    return publicLive({ ...r, match_status: r.match_status || r.status, points_a: r.points_a ?? 0, points_b: r.points_b ?? 0, sets_won_a: r.sets_won_a ?? 0, sets_won_b: r.sets_won_b ?? 0 })
  }

  async function live(id) {
    return guarded('live', async () => {
      if (!MATCH_ID_RE.test(id)) return fail(400, 'bad match id')
      const snap = await liveSnapshot(id)
      if (!snap) return fail(404, 'match not found')
      return ok(snap, { 'Cache-Control': 'public, max-age=2' })
    })
  }

  async function stats(id) {
    return guarded('stats', async () => {
      if (!MATCH_ID_RE.test(id)) return fail(400, 'bad match id')
      const m = await matchRow(id)
      if (!m) return fail(404, 'match not found')
      if (!isFinished(m.status)) return fail(409, 'statistics are published when the match is finished')
      const cacheKey = m.closed_at ? `${id}|${iso(m.updated_at)}` : null
      const cached = cacheKey && statsCache.get(cacheKey)
      // an open match can still be corrected: proxies keep it 30 s, not 5 min
      const cacheControl = { 'Cache-Control': `public, max-age=${m.closed_at ? 300 : 30}` }
      if (cached) return ok(cached, cacheControl)
      const ev = await pool.query(
        `SELECT type, set_index, seq, payload FROM public.events
          WHERE match_id = $1 AND voided_at IS NULL AND coalesce(test, false) = false
          ORDER BY set_index, seq LIMIT 20000`, [m._id])
      const st = await pool.query(`SELECT index, start_time, end_time FROM public.sets WHERE match_id = $1`, [m._id])
      const body = { ...publicMatchInfo(m, { withRosters: true }), stats: buildStats(m, ev.rows, st.rows) }
      for (const k of statsCache.keys()) if (k.startsWith(`${id}|`)) statsCache.delete(k)
      if (cacheKey) {
        while (statsCache.size >= STATS_CACHE_MAX) statsCache.delete(statsCache.keys().next().value)
        statsCache.set(cacheKey, body)
      }
      return ok(body, cacheControl)
    })
  }

  return { list, info, live, liveSnapshot, stats, involves }
}

/**
 * Server-Sent Events for one match: one shared poller per match (every
 * `intervalMs`, every `finishedEvery` ms once the match is finished), a frame
 * only when the snapshot changed, a comment every 20 s (every 30 s, on each
 * poll, once finished) so proxies keep the connection. Pure of http details except `res`.
 *
 * Limits, checked with canAttach() BEFORE the 200 (a refused stream must be an
 * error status: a 200 that ends makes EventSource reconnect every 3 s):
 * `maxPerKey` streams per caller key (the address bucket; the per-minute rate
 * alone let one address hold every slot over time; 100, as a hall's Wi-Fi or
 * a carrier NAT puts many viewers behind one address), `maxPerMatch` viewers of
 * one match, `maxMatches` polled matches (each one is a query every
 * `intervalMs`), `maxTotal` streams. A viewer whose unsent output passes
 * `maxBuffered` bytes (it does not read) is dropped.
 */
export function createLiveStreams({
  snapshot, intervalMs = 2000, finishedEvery = 30000, maxPerMatch = 500, maxTotal = 3000, maxPerKey = 100, maxMatches = 200,
  maxBuffered = 256 * 1024, logger = console
} = {}) {
  const pollers = new Map() // id -> { clients:Set, timer, last, lastFinished, busy, beat, skip }
  const perKey = new Map() // key -> open streams
  let total = 0

  const FINISHED = new Set(['finished', 'ended'])
  const isFinished = (snap) => !!snap && FINISHED.has(snap.status)

  function canAttach(id, key = '') {
    if (total >= maxTotal) return false
    if ((perKey.get(key) || 0) >= maxPerKey) return false
    const p = pollers.get(id)
    if (p) return p.clients.size < maxPerMatch
    return pollers.size < maxMatches
  }

  function drop(p, res) {
    try { res.destroy?.() } catch { /* ignore */ }
    // destroy emits close; a fake or an already closed one may not
    p.done.get(res)?.()
  }
  function write(p, res, text) {
    if ((res.writableLength || 0) > maxBuffered) { drop(p, res); return }
    res.write(text)
  }
  const send = (p, res, data) => write(p, res, `event: live\ndata: ${data}\n\n`)

  function attach(id, res, { key = '', first = null } = {}) {
    if (!canAttach(id, key)) return false
    let p = pollers.get(id)
    if (!p) {
      p = { clients: new Set(), done: new Map(), last: null, lastFinished: false, busy: false, timer: null, beat: 0, skip: 0 }
      const finishedTicks = Math.max(1, Math.ceil(finishedEvery / intervalMs))
      p.timer = setInterval(async () => {
        if (p.busy) return
        // a finished match changes only by a correction: poll it rarely
        if (p.lastFinished && ++p.skip < finishedTicks) return
        p.skip = 0
        p.busy = true
        try {
          const snap = await snapshot(id)
          const text = snap ? JSON.stringify(snap) : null
          if (text && text !== p.last) {
            p.last = text
            p.lastFinished = isFinished(snap)
            for (const c of [...p.clients]) send(p, c, text)
          } else if (++p.beat >= Math.ceil(20000 / intervalMs) || p.lastFinished) {
            p.beat = 0
            for (const c of [...p.clients]) write(p, c, ': keep-alive\n\n')
          }
        } catch (err) {
          logger.warn?.('[public-api] stream poll failed:', err?.message)
        } finally {
          p.busy = false
        }
      }, intervalMs)
      p.timer.unref?.()
      pollers.set(id, p)
      if (first) { p.last = JSON.stringify(first); p.lastFinished = isFinished(first) }
    }
    p.clients.add(res)
    total++
    perKey.set(key, (perKey.get(key) || 0) + 1)
    const done = () => {
      if (!p.clients.delete(res)) return
      p.done.delete(res)
      total--
      const n = (perKey.get(key) || 1) - 1
      if (n > 0) perKey.set(key, n)
      else perKey.delete(key)
      if (p.clients.size === 0) { clearInterval(p.timer); if (pollers.get(id) === p) pollers.delete(id) }
    }
    p.done.set(res, done)
    res.on('close', done)
    if (p.last) send(p, res, p.last)
    else snapshot(id).then((s) => { if (s && p.clients.has(res)) { p.last = JSON.stringify(s); p.lastFinished = isFinished(s); send(p, res, p.last) } }).catch(() => {})
    return true
  }
  return {
    attach,
    canAttach,
    stats: () => ({ matches: pollers.size, clients: total }),
    closeAll() { for (const p of pollers.values()) clearInterval(p.timer); pollers.clear(); perKey.clear(); total = 0 }
  }
}

/** `?from`, `?to`, `?status`, `?limit` from a URL. */
export const listParams = (u) => ({
  from: u.searchParams.get('from'), to: u.searchParams.get('to'), status: u.searchParams.get('status'), limit: u.searchParams.get('limit'), club: u.searchParams.get('club')
})
