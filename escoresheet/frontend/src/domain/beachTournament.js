/**
 * Pure helpers of the OpenBeach tournament console (manager-beach, Tournaments
 * tab; backend lib/beachTournaments.js). No React, no network.
 *
 * Times: the server stores instants; the console shows and takes them on the
 * Europe/Zurich wall clock (the venue's), whatever the device's zone is.
 */

export const ZURICH = 'Europe/Zurich'
export const PHASE_ORDER = ['winners', 'losers', 'final', 'placement']
const SET_RE = /^(\d{1,2})\s*[:\-–]\s*(\d{1,2})$/

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZURICH, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
})
function parts(ms) {
  const p = {}
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value
  return p
}

/** An instant as the value of a datetime-local input on the Zurich clock: 'YYYY-MM-DDTHH:MM' ('' for none). */
export function toZurichInput(iso) {
  const ms = iso ? new Date(iso).getTime() : NaN
  if (Number.isNaN(ms)) return ''
  const p = parts(ms)
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

/** A datetime-local value on the Zurich clock as an ISO instant (null when empty or invalid). */
export function fromZurichInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ''))
  if (!m) return null
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
  let t = wall
  for (let i = 0; i < 2; i++) {
    const p = parts(t)
    t += wall - Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute))
  }
  return new Date(t).toISOString()
}

/** 'seed:4' / 'winner:W3' / 'loser:L2' -> { kind, value } (null for anything else). */
export function parseSource(source) {
  const m = /^(seed|winner|loser):(.+)$/.exec(String(source || ''))
  return m ? { kind: m[1], value: m[2] } : null
}

/** '21:17 19:21 15:12' (or with commas) -> [[21,17],[19,21],[15,12]]; [] for ''; null when it is not sets. */
export function parseSets(text) {
  const s = String(text || '').trim()
  if (!s) return []
  const out = []
  for (const part of s.split(/[\s,;/]+/).filter(Boolean)) {
    const m = SET_RE.exec(part)
    if (!m) return null
    out.push([Number(m[1]), Number(m[2])])
  }
  return out.length <= 3 ? out : null
}

/** [[21,17],[19,21]] -> '21:17 19:21' ('' for none). */
export function setsText(sets) {
  return Array.isArray(sets) ? sets.map(s => `${s[0]}:${s[1]}`).join(' ') : ''
}

/** The side (1 or 2) that won more sets, or null. */
export function setsWinner(sets) {
  if (!Array.isArray(sets) || !sets.length) return null
  let a = 0
  let b = 0
  for (const [x, y] of sets) {
    if (x > y) a++
    else if (y > x) b++
  }
  return a === b ? null : a > b ? 1 : 2
}

/**
 * The matches of one draw grouped for the bracket view: [{ phase, round,
 * index, matches }] in bracket order. `round` is the board's round; `index`
 * counts the rounds that are played within the phase (with byes, the first
 * losers round of a 12-team draw is the board's round 2, shown as round 1).
 */
export function bracketSections(matches) {
  const groups = new Map()
  for (const m of matches || []) {
    const key = `${m.phase}|${m.round}`
    if (!groups.has(key)) groups.set(key, { phase: m.phase, round: m.round, matches: [] })
    groups.get(key).matches.push(m)
  }
  const order = (p) => {
    const i = PHASE_ORDER.indexOf(p)
    return i < 0 ? 99 : i
  }
  return [...groups.values()]
    .map(g => ({ ...g, matches: g.matches.sort((x, y) => x.game_n - y.game_n) }))
    .sort((x, y) => order(x.phase) - order(y.phase) || x.round - y.round)
    .map((g, i, all) => ({ ...g, index: all.slice(0, i + 1).filter(o => o.phase === g.phase).length }))
}

/**
 * The schedule as a grid: one row per start time (in order), one column per
 * court. { times: [iso], courts: [court], cell(time, courtId) -> match|null,
 * unscheduled: [match] }.
 */
export function scheduleGrid(matches, courts) {
  const cols = [...(courts || [])].sort((a, b) => a.number - b.number)
  const placed = (matches || []).filter(m => m.scheduled_at && m.court_id)
  const times = [...new Set(placed.map(m => new Date(m.scheduled_at).toISOString()))].sort()
  const cells = new Map(placed.map(m => [`${new Date(m.scheduled_at).toISOString()}|${m.court_id}`, m]))
  return {
    times,
    courts: cols,
    cell: (time, courtId) => cells.get(`${time}|${courtId}`) || null,
    unscheduled: (matches || []).filter(m => !m.scheduled_at || !m.court_id).sort((a, b) => a.game_n - b.game_n)
  }
}

/** The Zurich day ('YYYY-MM-DD') of an instant. */
export function zurichDay(iso) {
  return toZurichInput(iso).slice(0, 10)
}

/** A file name for a draw's ranking CSV: 'zuri-open-2026-a1-women-ranking.csv'. */
export function rankingFileName(tournament, draw) {
  const clean = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${[clean(tournament?.slug || tournament?.title), clean(draw?.category), clean(draw?.gender)].filter(Boolean).join('-')}-ranking.csv`
}

/** The order of entries for the seeds list: seeded ones by seed, then the others by name. Registered only. */
export function seedOrderOf(entries) {
  return (entries || [])
    .filter(e => e.status === 'registered')
    .sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9) || String(a.name).localeCompare(String(b.name)))
}

/** Moves item `index` of a list by `delta` (a new array; unchanged at the ends). */
export function moveItem(list, index, delta) {
  const to = index + delta
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list
  const out = [...list]
  const [item] = out.splice(index, 1)
  out.splice(to, 0, item)
  return out
}
