// "Load match from schedule": games that already started go under "Earlier
// matches", after the upcoming ones (owner 2026-11-15: "hide previous matches
// (matches with start time before current time) under 'earlier matches'").
//
// A game's start is read on the gym's clock (ui/format: Zürich, or the
// device's in the Global tool), whatever zone the device is in, so a 10:20
// kick-off is earlier from 10:20 Zürich time on, summer or winter.

import { zonedParts, zurichWallTimeMs } from '../ui/format'

const HAS_ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i
const SWISS_DATE_RE = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/
const TIME_RE = /^(\d{1,2}):(\d{2})/

/**
 * The instant (ms) a schedule game starts, or null when it has no time (a
 * date alone, or nothing readable). Takes the modal's `dtstart`, a raw row's
 * `datetime`, or a `date` 'DD/MM/YYYY' (or DD.MM.YYYY) with a `time` 'HH:MM'.
 * @param {{ dtstart?: string, datetime?: string, date?: string, time?: string }} game
 * @returns {number|null}
 */
export function gameStartMs(game) {
  if (!game) return null
  const value = game.dtstart ?? game.datetime
  if (typeof value === 'string' && value.trim()) {
    const text = value.trim()
    const p = zonedParts(text)
    if (!p.valid || !p.timed) return null
    // An instant as it is; a zone-less wall time on the gym's clock
    if (HAS_ZONE_RE.test(text)) {
      const ms = new Date(text.replace(' ', 'T')).getTime()
      return Number.isFinite(ms) ? ms : null
    }
    const ms = zurichWallTimeMs(p.year, p.month, p.day, p.hour, p.minute)
    return Number.isFinite(ms) ? ms : null
  }
  const d = SWISS_DATE_RE.exec(String(game.date ?? '').trim())
  const t = TIME_RE.exec(String(game.time ?? '').trim())
  if (!d || !t) return null
  const ms = zurichWallTimeMs(+d[3], +d[2], +d[1], +t[1], +t[2])
  return Number.isFinite(ms) ? ms : null
}

/**
 * Splits schedule games into the upcoming ones and those whose start is before
 * `now`. Both keep the order they came in. A game without a time is upcoming.
 * @template G
 * @param {G[]} games
 * @param {number|Date} [now]
 * @returns {{ upcoming: G[], earlier: G[] }}
 */
export function splitEarlierGames(games, now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now)
  const upcoming = []
  const earlier = []
  for (const game of games || []) {
    const start = gameStartMs(game)
    if (start != null && start < nowMs) earlier.push(game)
    else upcoming.push(game)
  }
  return { upcoming, earlier }
}
