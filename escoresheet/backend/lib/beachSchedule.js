/**
 * beachSchedule — the schedule of a beach tournament over its courts and
 * time slots (~/ov-ops/openbeach-separation-tournaments-PLAN.md 3.2, phase
 * T1; docs/beach-tournaments-spec.md section 5). Pure: no database, no clock.
 *
 * Greedy list scheduling, in the order the brackets are played (wave, then
 * the draw's order, then the game number):
 *   - a match starts no earlier than the end of every match it depends on
 *     (the winner / loser it waits for) plus the draw's rest time, so a team
 *     never plays two matches at once and gets its rest;
 *   - it takes the court and the earliest gap where its slot fits (a later
 *     match may fill a gap an earlier one left), inside the day's hours
 *     (Europe/Zurich), else the next day of the tournament;
 *   - matches that have already been called, started or ended keep their
 *     court and time and block them;
 *   - what does not fit into the tournament's days is returned as unplaced.
 *
 * Warnings: 'court_day_limit' when a court has more than 18 matches on a day
 * (the junior limit of the Swiss Volley regulations).
 */

export const ZURICH = 'Europe/Zurich'
export const COURT_DAY_LIMIT = 18
const DAY_MIN = 24 * 60
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 'HH:MM' (or 'HH:MM:SS') -> minutes of the day, or null. */
export function minutesOf (hhmm) {
  const m = TIME_RE.exec(String(hhmm ?? ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

const zurichFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZURICH, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
})
function zurichParts (ms) {
  const p = {}
  for (const x of zurichFmt.formatToParts(new Date(ms))) p[x.type] = x.value
  return p
}

/** The UTC instant (ISO) of a Europe/Zurich wall-clock time: day 'YYYY-MM-DD' at `minutes` after midnight. */
export function zurichToIso (day, minutes) {
  if (!DAY_RE.test(day)) throw new RangeError(`not a day: ${day}`)
  const [y, mo, d] = day.split('-').map(Number)
  const wall = Date.UTC(y, mo - 1, d, 0, minutes)
  // the zone offset at the guess, applied twice (DST edges settle on the second pass)
  let t = wall
  for (let i = 0; i < 2; i++) {
    const p = zurichParts(t)
    const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute))
    t += wall - shown
  }
  return new Date(t).toISOString()
}

/** The Europe/Zurich day ('YYYY-MM-DD') and minutes of an instant. */
export function zurichDayMinutes (iso) {
  const ms = new Date(iso).getTime()
  if (Number.isNaN(ms)) return null
  const p = zurichParts(ms)
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) }
}

/** The days from `from` to `to` (both 'YYYY-MM-DD', inclusive). */
export function daysBetween (from, to) {
  const out = []
  const t = new Date(`${from}T12:00:00Z`)
  const end = new Date(`${to}T12:00:00Z`)
  while (t <= end && out.length < 31) {
    out.push(t.toISOString().slice(0, 10))
    t.setUTCDate(t.getUTCDate() + 1)
  }
  return out
}

/**
 * @param {object} o
 * @param {Array<{id: string, draw_id: string, code: string, game_n: number, wave: number,
 *   source1: string, source2: string, fixed?: {court_id: string|null, scheduled_at: string|null, duration_min?: number}}>} o.matches
 *   every match of the draws being scheduled; `fixed` for the ones that keep their slot
 * @param {Array<{id: string, slot_minutes: number, rest_minutes: number}>} o.draws  in the order they get the courts
 * @param {Array<{id: string, number: number}>} o.courts  the active courts
 * @param {string[]} o.days  the tournament days, 'YYYY-MM-DD'
 * @param {string} o.dayStart  'HH:MM' (Europe/Zurich)
 * @param {string} o.dayEnd    'HH:MM'
 * @returns {{ slots: Array<{id, court_id, scheduled_at, duration_min}>, unplaced: string[], warnings: object[] }}
 */
export function scheduleMatches ({ matches, draws, courts, days, dayStart = '09:00', dayEnd = '19:00' }) {
  const startMin = minutesOf(dayStart)
  const endMin = minutesOf(dayEnd)
  if (startMin == null || endMin == null || endMin <= startMin) throw new RangeError('day hours: HH:MM, end after start')
  if (!Array.isArray(days) || days.length === 0 || !days.every((d) => DAY_RE.test(d))) throw new RangeError('days: YYYY-MM-DD')
  const drawInfo = new Map(draws.map((d, i) => [d.id, { order: i, slot: d.slot_minutes, rest: d.rest_minutes || 0 }]))
  const courtList = [...courts].sort((a, b) => a.number - b.number)
  const dayIndex = new Map(days.map((d, i) => [d, i]))
  // absolute minutes since the first day's midnight (Zurich wall clock)
  const abs = (iso) => {
    const z = zurichDayMinutes(iso)
    if (!z) return null
    if (dayIndex.has(z.day)) return dayIndex.get(z.day) * DAY_MIN + z.minutes
    // a fixed slot outside the days: before the first day or after the last
    return z.day < days[0] ? -DAY_MIN : days.length * DAY_MIN
  }
  const toIso = (t) => zurichToIso(days[Math.floor(t / DAY_MIN)], t % DAY_MIN)

  const busy = new Map(courtList.map((c) => [c.id, []])) // court -> [[from, to]] sorted
  const occupy = (courtId, from, to) => {
    const list = busy.get(courtId)
    if (!list) return
    list.push([from, to])
    list.sort((a, b) => a[0] - b[0])
  }
  const end = new Map() // code (per draw) -> end minute
  const key = (drawId, code) => `${drawId}|${code}`

  // Matches that keep their slot
  for (const m of matches) {
    if (!m.fixed) continue
    const dur = m.fixed.duration_min || drawInfo.get(m.draw_id)?.slot || 50
    const from = m.fixed.scheduled_at ? abs(m.fixed.scheduled_at) : null
    if (from == null) { end.set(key(m.draw_id, m.code), -Infinity); continue }
    if (m.fixed.court_id) occupy(m.fixed.court_id, from, from + dur)
    end.set(key(m.draw_id, m.code), from + dur)
  }

  const todo = matches.filter((m) => !m.fixed && drawInfo.has(m.draw_id)).sort((a, b) =>
    a.wave - b.wave || drawInfo.get(a.draw_id).order - drawInfo.get(b.draw_id).order || a.game_n - b.game_n)
  const slots = []
  const unplaced = []
  const ref = (s) => /^(?:winner|loser):(.+)$/.exec(s)?.[1] ?? null

  /** The earliest start >= t on `courtId` where `dur` minutes fit, inside the day hours; null when none. */
  const earliestOn = (courtId, t, dur) => {
    const list = busy.get(courtId)
    let at = t
    for (let guard = 0; guard < 10000; guard++) {
      const day = Math.floor(at / DAY_MIN)
      if (day >= days.length) return null
      const minute = at - day * DAY_MIN
      if (minute < startMin) { at = day * DAY_MIN + startMin; continue }
      if (minute + dur > endMin) { at = (day + 1) * DAY_MIN + startMin; continue }
      const clash = list.find(([f, e]) => f < at + dur && e > at)
      if (!clash) return at
      at = clash[1]
    }
    return null
  }

  for (const m of todo) {
    const info = drawInfo.get(m.draw_id)
    let ready = Math.max(0, startMin)
    let waiting = false
    for (const s of [m.source1, m.source2]) {
      const code = ref(s)
      if (!code) continue
      const e = end.get(key(m.draw_id, code))
      if (e === undefined) { waiting = true; break }
      if (e !== -Infinity) ready = Math.max(ready, e + info.rest)
    }
    if (waiting) { unplaced.push(m.id); continue }
    let best = null
    for (const c of courtList) {
      const t = earliestOn(c.id, ready, info.slot)
      if (t != null && (best == null || t < best.t)) best = { t, court: c }
    }
    if (!best) { unplaced.push(m.id); continue }
    occupy(best.court.id, best.t, best.t + info.slot)
    end.set(key(m.draw_id, m.code), best.t + info.slot)
    slots.push({ id: m.id, court_id: best.court.id, scheduled_at: toIso(best.t), duration_min: info.slot })
  }

  const warnings = []
  for (const c of courtList) {
    const perDay = new Map()
    for (const [from] of busy.get(c.id)) {
      const d = Math.floor(from / DAY_MIN)
      perDay.set(d, (perDay.get(d) || 0) + 1)
    }
    for (const [d, count] of perDay) {
      if (count > COURT_DAY_LIMIT && days[d]) warnings.push({ code: 'court_day_limit', court: c.number, day: days[d], matches: count })
    }
  }
  return { slots, unplaced, warnings }
}
