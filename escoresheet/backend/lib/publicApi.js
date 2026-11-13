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
 * Pure builders (no I/O) first, then createPublicApi({ pool }) for the queries.
 * Every handler answers { status, body, headers? } and never throws.
 */

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

const STATUS = new Set(['setup', 'scheduled', 'live', 'finished', 'ended'])

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
    status: STATUS.has(row.status) ? row.status : (row.status || null),
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
const lineupFlags = (l) => {
  const v = jsonOf(l)
  if (!isObj(v)) return null
  const out = {}
  for (const p of POSITIONS) {
    const e = v[p]
    if (!isObj(e) || num(e.number) == null) continue
    out[p] = { number: Number(e.number), serving: !!e.isServing, libero: !!e.isLibero, captain: !!(e.isCaptain || e.isCourtCaptain) }
  }
  return Object.keys(out).length ? out : null
}

const sanctionOut = (s) => {
  if (!isObj(s)) return null
  return {
    type: str(s.type, 30),
    // who: a shirt number, or a role for staff; never a name
    number: num(s.player ?? s.playerNumber),
    role: str(s.role, 30) || str(s.playerType, 30)
  }
}

/** The livescore snapshot: scores and what is on court, from match_live_state (+ the match row). */
export function publicLive(row) {
  const sets = jsonOf(row.set_results)
  return {
    id: row.external_id,
    status: row.match_status || row.status || null,
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
    sideA: str(row.side_a, 10),
    serving: str(row.serving_team, 10),
    serverNumber: num(row.server_number),
    onCourt: { A: lineupFlags(row.lineup_a) || lineupNumbers(row.lineup_a), B: lineupFlags(row.lineup_b) || lineupNumbers(row.lineup_b) },
    substitutions: { A: Array.isArray(jsonOf(row.subs_a)) ? jsonOf(row.subs_a).length : 0, B: Array.isArray(jsonOf(row.subs_b)) ? jsonOf(row.subs_b).length : 0 },
    sanctions: {
      A: (Array.isArray(jsonOf(row.sanctions_a)) ? jsonOf(row.sanctions_a) : []).map(sanctionOut).filter(Boolean),
      B: (Array.isArray(jsonOf(row.sanctions_b)) ? jsonOf(row.sanctions_b) : []).map(sanctionOut).filter(Boolean)
    },
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
          s.substitutions.push({
            team: t, out: num(p.playerOut), in: num(p.playerIn), at,
            exceptional: !!p.isExceptional, expelled: !!p.isExpelled, disqualified: !!p.isDisqualified
          })
          totals[t].substitutions++
        }
        break
      case 'sanction':
        if (t) {
          s.sanctions.push({ team: t, type: str(p.type, 30), number: num(p.playerNumber), role: str(p.role, 30) || str(p.playerType, 30), at })
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
    status: match.status || null,
    result: match.final_score ? { score: String(match.final_score).slice(0, 20), winner: str(match.winner, 10) } : null,
    home: team(jsonOf(match.sport_type === 'beach' ? match.team1_data : match.home_team), 'Home').name,
    away: team(jsonOf(match.sport_type === 'beach' ? match.team2_data : match.away_team), 'Away').name,
    totals,
    sets: setsOut
  }
}

// ---------------------------------------------------------------- data layer

const MATCH_COLUMNS = `m.external_id, m.sport_type, m.game_n, m.status, m.scheduled_at, m.final_score, m.winner,
  m.match_info, m.officials, m.home_team, m.away_team, m.team1_data, m.team2_data,
  m.players_home, m.players_away, m.players_team1, m.players_team2, m.bench_home, m.bench_away, m.updated_at`

const ok = (body, headers = {}) => ({ status: 200, body, headers })
const fail = (status, error) => ({ status, body: { error } , headers: { 'Cache-Control': 'no-store' } })
const MISSING = new Set(['42P01', '42703'])

export function createPublicApi({ pool, logger = console } = {}) {
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

  async function list({ from, to, status, limit }) {
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
        args.push(list)
        statusSql = ` AND m.status = ANY($${args.length})`
      }
      args.push(lim)
      const { rows } = await pool.query(
        `SELECT ${MATCH_COLUMNS} FROM public.matches m
          WHERE coalesce(m.test, false) = false AND m.external_id IS NOT NULL
            AND m.scheduled_at >= $1 AND m.scheduled_at < $2${statusSql}
          ORDER BY m.scheduled_at, m.game_n LIMIT $${args.length}`, args)
      return ok({ matches: rows.map((r) => publicMatchInfo(r, { withRosters: false })) }, { 'Cache-Control': 'public, max-age=15' })
    })
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
      if (!['finished', 'ended'].includes(m.status)) return fail(409, 'statistics are published when the match is finished')
      const ev = await pool.query(
        `SELECT type, set_index, seq, payload FROM public.events
          WHERE match_id = $1 AND voided_at IS NULL AND coalesce(test, false) = false
          ORDER BY set_index, seq LIMIT 20000`, [m._id])
      const st = await pool.query(`SELECT index, start_time, end_time FROM public.sets WHERE match_id = $1`, [m._id])
      return ok({ ...publicMatchInfo(m, { withRosters: true }), stats: buildStats(m, ev.rows, st.rows) }, { 'Cache-Control': 'public, max-age=300' })
    })
  }

  return { list, info, live, liveSnapshot, stats }
}

/**
 * Server-Sent Events for one match: one shared poller per match (every
 * `intervalMs`), a frame only when the snapshot changed, a comment every
 * 20 s so proxies keep the connection. Pure of http details except `res`.
 */
export function createLiveStreams({ snapshot, intervalMs = 2000, maxPerMatch = 500, maxTotal = 3000, logger = console } = {}) {
  const pollers = new Map() // id -> { clients:Set, timer, last, busy }
  let total = 0

  const send = (res, data) => res.write(`event: live\ndata: ${data}\n\n`)

  function attach(id, res) {
    let p = pollers.get(id)
    if (total >= maxTotal || (p && p.clients.size >= maxPerMatch)) return false
    if (!p) {
      p = { clients: new Set(), last: null, busy: false, timer: null, beat: 0 }
      p.timer = setInterval(async () => {
        if (p.busy) return
        p.busy = true
        try {
          const snap = await snapshot(id)
          const text = snap ? JSON.stringify(snap) : null
          // updatedAt alone moves on every write; compare the content that matters
          if (text && text !== p.last) {
            p.last = text
            for (const c of p.clients) send(c, text)
          } else if (++p.beat >= Math.ceil(20000 / intervalMs)) {
            p.beat = 0
            for (const c of p.clients) c.write(': keep-alive\n\n')
          }
        } catch (err) {
          logger.warn?.('[public-api] stream poll failed:', err?.message)
        } finally {
          p.busy = false
        }
      }, intervalMs)
      p.timer.unref?.()
      pollers.set(id, p)
    }
    p.clients.add(res)
    total++
    if (p.last) send(res, p.last)
    else snapshot(id).then((s) => { if (s) { p.last = JSON.stringify(s); send(res, p.last) } }).catch(() => {})
    const done = () => {
      if (!p.clients.delete(res)) return
      total--
      if (p.clients.size === 0) { clearInterval(p.timer); pollers.delete(id) }
    }
    res.on('close', done)
    return true
  }
  return { attach, stats: () => ({ matches: pollers.size, clients: total }), closeAll() { for (const p of pollers.values()) clearInterval(p.timer); pollers.clear(); total = 0 } }
}

/** `?from`, `?to`, `?status`, `?limit` from a URL. */
export const listParams = (u) => ({
  from: u.searchParams.get('from'), to: u.searchParams.get('to'), status: u.searchParams.get('status'), limit: u.searchParams.get('limit')
})
