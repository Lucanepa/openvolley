/**
 * Bench requests: a team's bench tablet sends the starting line-up of a set,
 * a time-out request or a prepared substitution to the scorer, who accepts or
 * declines (like the bench app of a DataProject e-scoresheet). The relay only
 * carries them: it checks who may send what, keeps the open requests in memory
 * per match and hands each message to the right sockets. Pure: no sockets, no
 * timers (the caller passes `now`).
 *
 * The same rules live in frontend/electron/lanRelayCore.cjs (LAN relays) and
 * frontend/src-tauri/src/relay.rs (desktop relay); the wire scenario all of
 * them pass is backend/tests/helpers/benchRequestContract.js.
 *
 * Client -> relay
 *   bench-request  { matchId, team, request }  from a bench socket whose
 *                  subscribe-match PIN (or match token) is THAT team's bench
 *                  PIN while that bench's connection is on.
 *                  request { id, kind: 'lineup'|'timeout'|'substitution'|'cancel',
 *                  setIndex, lineup?: { I..VI }, gameCaptain?, pairs?: [{ out, in }],
 *                  cancelId? }
 *   bench-response { matchId, team, id, status: 'accepted'|'declined'|'seen', reason? }
 *                  from the match's scoreboard only
 * Relay -> client
 *   bench-request-ack   to the sender: { matchId, team, id, status, delivered, superseded }
 *   bench-request       to the match's scoreboard socket(s) only: { matchId, team,
 *                       request, status, at, replay? } (replay: sent again
 *                       after the scorer reconnected)
 *   bench-response      to that team's bench sockets only
 *   bench-request-state to a bench socket when it subscribes: its team's requests
 *   bench-request-info  to referee sockets: time-out / substitution requests
 *                       (never line-ups) { matchId, team, id, kind, pairs?, status }
 *   error { code: 'bench-request-refused', reason, id?, matchId }
 * Nothing goes to the other bench or the livescore: FIVB 7.3 (the line-up is
 * not shown to the other team before the set starts).
 */

export const BENCH_REQUEST_KINDS = Object.freeze(['lineup', 'timeout', 'substitution', 'cancel'])
export const BENCH_RESPONSE_STATUSES = Object.freeze(['accepted', 'declined', 'seen'])
export const LINEUP_KEYS = Object.freeze(['I', 'II', 'III', 'IV', 'V', 'VI'])
export const BENCH_REQUESTS_PER_MINUTE = 30
export const MAX_BENCH_REASON = 200
export const MAX_BENCH_PAIRS = 6
export const MAX_REQUESTS_PER_TEAM = 12
export const BENCH_REQUEST_TTL_MS = 30 * 60 * 1000
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const isTeam = (t) => t === 'home' || t === 'away'
const shirt = (v) => {
  const n = typeof v === 'string' && /^\d{1,2}$/.test(v.trim()) ? Number(v.trim()) : v
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : null
}
const fail = (reason) => ({ ok: false, reason })

/**
 * A bench-request's request, checked and copied to the known fields only.
 * @returns {{ ok: true, request: object } | { ok: false, reason: string }}
 */
export function normalizeBenchRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('bad-request')
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return fail('bad-id')
  if (!BENCH_REQUEST_KINDS.includes(raw.kind)) return fail('bad-kind')
  const setIndex = raw.setIndex
  if (!Number.isInteger(setIndex) || setIndex < 1 || setIndex > 5) return fail('bad-set')
  const request = { id: raw.id, kind: raw.kind, setIndex }
  if (raw.kind === 'cancel') {
    if (typeof raw.cancelId !== 'string' || !ID_RE.test(raw.cancelId)) return fail('bad-cancel')
    request.cancelId = raw.cancelId
    return { ok: true, request }
  }
  if (raw.kind === 'lineup') {
    const lu = raw.lineup
    if (!lu || typeof lu !== 'object' || Array.isArray(lu)) return fail('bad-lineup')
    const lineup = {}
    const seen = new Set()
    for (const k of LINEUP_KEYS) {
      const n = shirt(lu[k])
      if (n === null || seen.has(n)) return fail('bad-lineup')
      seen.add(n)
      lineup[k] = n
    }
    request.lineup = lineup
    if (raw.gameCaptain !== undefined && raw.gameCaptain !== null) {
      const gc = shirt(raw.gameCaptain)
      if (gc === null || !seen.has(gc)) return fail('bad-captain')
      request.gameCaptain = gc
    }
    return { ok: true, request }
  }
  if (raw.kind === 'substitution') {
    if (!Array.isArray(raw.pairs) || raw.pairs.length < 1 || raw.pairs.length > MAX_BENCH_PAIRS) return fail('bad-pairs')
    const outs = new Set()
    const ins = new Set()
    const pairs = []
    for (const p of raw.pairs) {
      if (!p || typeof p !== 'object') return fail('bad-pairs')
      const out = shirt(p.out)
      const inn = shirt(p.in)
      if (out === null || inn === null || out === inn || outs.has(out) || ins.has(inn) || outs.has(inn) || ins.has(out)) return fail('bad-pairs')
      outs.add(out)
      ins.add(inn)
      pairs.push({ out, in: inn })
    }
    request.pairs = pairs
    if (raw.gameCaptain !== undefined && raw.gameCaptain !== null) {
      const gc = shirt(raw.gameCaptain)
      if (gc === null || outs.has(gc)) return fail('bad-captain')
      request.gameCaptain = gc
    }
    return { ok: true, request }
  }
  return { ok: true, request } // timeout: nothing more
}

/** A bench-response, checked: { ok, response: { id, status, reason? } }. */
export function normalizeBenchResponse(raw) {
  if (!raw || typeof raw !== 'object') return fail('bad-request')
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return fail('bad-id')
  if (!BENCH_RESPONSE_STATUSES.includes(raw.status)) return fail('bad-status')
  const response = { id: raw.id, status: raw.status }
  if (typeof raw.reason === 'string' && raw.reason.trim()) response.reason = raw.reason.trim().slice(0, MAX_BENCH_REASON)
  return { ok: true, response }
}

/** The set the match is in from the relayed sets: the lowest unfinished one, else after the last. */
export function currentSetOfBundle(bundle) {
  const sets = Array.isArray(bundle?.sets) ? bundle.sets : []
  let open = null
  let last = 0
  for (const s of sets) {
    const i = Number(s?.index)
    if (!Number.isInteger(i)) continue
    if (i > last) last = i
    if (!s.finished && (open === null || i < open)) open = i
  }
  return open ?? (last > 0 ? last + 1 : 1)
}

const OPEN = (e) => e.status === 'pending' || e.status === 'seen'

/** What the bench is told about one of its requests. */
export function benchView(entry) {
  const r = entry.request
  return { id: r.id, kind: r.kind, setIndex: r.setIndex, status: entry.status, ...(entry.reason ? { reason: entry.reason } : {}) }
}

/** What a referee sees of a time-out / substitution request (never a line-up). */
export function refereeInfo(matchId, entry, status = entry.status) {
  const r = entry.request
  return { type: 'bench-request-info', matchId, team: entry.team, id: r.id, kind: r.kind, setIndex: r.setIndex, ...(r.pairs ? { pairs: r.pairs } : {}), status }
}

/**
 * The open and recently answered requests of every match. Answered ones stay
 * (for a bench that reconnects) until their set is over or BENCH_REQUEST_TTL_MS.
 */
export function createBenchRequestStore({ ttlMs = BENCH_REQUEST_TTL_MS, maxPerTeam = MAX_REQUESTS_PER_TEAM } = {}) {
  const byMatch = new Map() // matchId -> Map<id, { team, request, status, reason?, at }>

  const entries = (matchId) => byMatch.get(matchId) || null

  /**
   * Keep a request. A new line-up of a team replaces its open line-up of that
   * set, a new time-out request its open time-out request, a new substitution
   * request its open one. A line-up already accepted for the set is locked.
   * cancel: drops the team's open request cancelId.
   * @returns {{ ok: true, entry, superseded: object[], cancelled: object|null } | { ok: false, reason }}
   */
  function add(matchId, team, request, now = Date.now()) {
    if (!isTeam(team)) return fail('bad-team')
    let map = byMatch.get(matchId)
    if (request.kind === 'cancel') {
      const target = map?.get(request.cancelId)
      if (!target || target.team !== team || !OPEN(target)) return fail('nothing-to-cancel')
      map.delete(request.cancelId)
      return { ok: true, entry: null, superseded: [], cancelled: target }
    }
    if (!map) {
      map = new Map()
      byMatch.set(matchId, map)
    }
    const prev = map.get(request.id)
    if (prev && (prev.team !== team || !OPEN(prev))) return fail('duplicate-id')
    if (request.kind === 'lineup') {
      for (const e of map.values()) {
        if (e.team === team && e.request.kind === 'lineup' && e.request.setIndex === request.setIndex && e.status === 'accepted') return fail('lineup-locked')
      }
    }
    const superseded = []
    for (const [id, e] of map) {
      if (id === request.id || e.team !== team || !OPEN(e) || e.request.kind !== request.kind) continue
      if (request.kind === 'lineup' && e.request.setIndex !== request.setIndex) continue
      superseded.push(e)
      map.delete(id)
    }
    const entry = { team, request, status: 'pending', at: now }
    map.delete(request.id)
    map.set(request.id, entry)
    // Room per team: the oldest answered ones go first, then the oldest
    let own = [...map.entries()].filter(([, e]) => e.team === team)
    while (own.length > maxPerTeam) {
      const victim = own.find(([, e]) => !OPEN(e)) || own[0]
      map.delete(victim[0])
      own = own.filter((x) => x !== victim)
    }
    return { ok: true, entry, superseded, cancelled: null }
  }

  /** The scorer's answer. null when there is no such open request of the team. */
  function answer(matchId, team, id, status, reason = null, now = Date.now()) {
    const e = entries(matchId)?.get(id)
    if (!e || e.team !== team || !OPEN(e)) return null
    if (status === 'seen') {
      e.status = 'seen'
      return e
    }
    e.status = status
    e.answeredAt = now
    if (reason) e.reason = reason
    else delete e.reason
    return e
  }

  /** Open requests (for the scorer), oldest first. */
  function open(matchId) {
    return [...(entries(matchId)?.values() || [])].filter(OPEN)
  }

  /** Every kept request of a team (for its bench). */
  function ofTeam(matchId, team) {
    return [...(entries(matchId)?.values() || [])].filter((e) => e.team === team)
  }

  /** Drop what belongs to a set that is over, and what is older than the TTL. */
  function prune(matchId, currentSet, now = Date.now()) {
    const map = entries(matchId)
    if (!map) return
    for (const [id, e] of map) {
      if (e.request.setIndex < currentSet || now - e.at > ttlMs) map.delete(id)
    }
    if (map.size === 0) byMatch.delete(matchId)
  }

  function drop(matchId) {
    byMatch.delete(matchId)
  }

  return { add, answer, open, ofTeam, prune, drop, size: () => byMatch.size }
}

/** Fixed-window counter per key (the per-socket bench-request limit). */
export function createWindowLimiter({ max = BENCH_REQUESTS_PER_MINUTE, windowMs = 60 * 1000 } = {}) {
  const windows = new Map()
  return {
    /** Counts one; true when over the limit. */
    hit(key, now = Date.now()) {
      let w = windows.get(key)
      if (!w || now - w.start >= windowMs) {
        w = { start: now, count: 0 }
        windows.set(key, w)
      }
      w.count++
      if (windows.size > 10000) {
        for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k)
      }
      return w.count > max
    },
    forget(key) { windows.delete(key) }
  }
}
