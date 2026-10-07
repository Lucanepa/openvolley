/**
 * Which matches the referee / bench tablets offer in their pickers.
 *
 * A match that was set up or started and then abandoned (never finished, the
 * scorer gone home) stays in 'setup' or 'live' for ever, in the cloud and on a
 * relay that still holds it. Without a rule it sat at the top of every
 * referee's list for months, as "Home – Away" when it had no team names.
 *
 * Stale (isStalePickerMatch), whatever its connections:
 *   - not started, and its scheduled time is more than 12 h ago;
 *   - started (status 'live', or the coin toss confirmed), and not written
 *     for more than 6 h (no set lasts that long);
 *   - no scheduled time, and not written for more than 24 h.
 * A row whose last write is unknown (relay rows carry none) is judged by its
 * scheduled time only: not started, as above; started, once its scheduled
 * time is more than 24 h ago (an old scorer app that still publishes a match
 * started months ago and never finished, "Home – Away 15.06 16:00").
 *
 * The cloud pickers also leave out beach rows (OpenBeach matches share the
 * table; older indoor rows have no sport_type) and test rows, and ask only
 * for rows written in the last PICKER_QUERY_WINDOW_MS.
 */

const HOUR = 60 * 60 * 1000

export const PICKER_STALE = Object.freeze({
  scheduledPastMs: 12 * HOUR,
  liveIdleMs: 6 * HOUR,
  undatedIdleMs: 24 * HOUR,
  // started, last write unknown (relay rows): judged by the scheduled time
  liveScheduledPastMs: 24 * HOUR
})

/** The cloud query asks only for rows written in the last 30 days. */
export const PICKER_QUERY_WINDOW_MS = 30 * 24 * HOUR

/**
 * A timestamp (ISO string, with or without zone; epoch ms; Date) in epoch ms,
 * or null. A string without zone is UTC (the cloud returns them so).
 */
export function pickerTime(value) {
  if (value == null || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s) return null
  let iso = s
  if (/\d[T\s]\d/.test(s)) {
    iso = s.replace(/(\d)\s(\d)/, '$1T$2')
    if (/[+-]\d\d$/.test(iso)) iso = `${iso}:00` // Postgres "+00"
    else if (!/(Z|[+-]\d\d:?\d\d)$/i.test(iso)) iso = `${iso}Z`
  }
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/** Started: status 'live', or (a cloud row) its coin toss confirmed. */
export function isStartedPickerMatch(row) {
  if (!row || typeof row !== 'object') return false
  return row.status === 'live' || row.coin_toss?.confirmed === true || row.coinToss?.confirmed === true
}

/**
 * Is this match (cloud row or relay list row) abandoned? See the module doc.
 * @param {object} row  cloud: scheduled_at / updated_at; relay: scheduledAt / updatedAt
 * @param {number} [now]
 */
export function isStalePickerMatch(row, now = Date.now()) {
  if (!row || typeof row !== 'object') return true
  const scheduled = pickerTime(row.scheduled_at ?? row.scheduledAt)
  const updated = pickerTime(row.updated_at ?? row.updatedAt)
  if (isStartedPickerMatch(row)) {
    if (updated != null) return now - updated > PICKER_STALE.liveIdleMs
    return scheduled != null && now - scheduled > PICKER_STALE.liveScheduledPastMs
  }
  if (scheduled != null) return now - scheduled > PICKER_STALE.scheduledPastMs
  return updated != null && now - updated > PICKER_STALE.undatedIdleMs
}

/** A beach (OpenBeach) row. Older indoor rows have no sport_type. */
export function isBeachPickerRow(row) {
  const sport = row?.sport_type ?? row?.sportType
  return typeof sport === 'string' && sport.trim().toLowerCase() === 'beach'
}

/**
 * Does an indoor tablet picker offer this cloud row? Not beach, not a test
 * match, not stale. (Connections are checked by the caller.)
 */
export function isShownCloudPickerRow(row, now = Date.now()) {
  return !!row && typeof row === 'object' && !isBeachPickerRow(row) && row.test !== true && !isStalePickerMatch(row, now)
}

const nameOf = (team) => {
  const name = typeof team === 'string' ? team : team?.name
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

/**
 * The team names of a cloud row: home_team / away_team, else team1_data /
 * team2_data, else 'Home' / 'Away'.
 * @returns {{ home: string, away: string }}
 */
export function pickerTeamNames(row) {
  return {
    home: nameOf(row?.home_team) || nameOf(row?.team1_data) || 'Home',
    away: nameOf(row?.away_team) || nameOf(row?.team2_data) || 'Away'
  }
}

/** The cloud ask: rows written since this ISO time (PICKER_QUERY_WINDOW_MS). */
export const pickerQuerySince = (now = Date.now()) => new Date(now - PICKER_QUERY_WINDOW_MS).toISOString()

const rowsOf = (rows) => (Array.isArray(rows) ? rows.filter((m) => m && typeof m === 'object') : [])

/**
 * One list from the cloud's and the relay's picker rows, merged by id: a
 * match both list appears once, as the relay lists it (the relay has the
 * scorer's live copy). Every row says where it came from (`listSource`:
 * 'supabase' | 'websocket'). Soonest scheduled first, undated last.
 * @param {Array<object>} cloudRows
 * @param {Array<object>} relayRows
 */
export function mergePickerMatches(cloudRows, relayRows) {
  const byId = new Map()
  const keyOf = (m, i, tag) => (m.id != null && m.id !== '' ? `id:${String(m.id)}` : `${tag}:${i}`)
  rowsOf(cloudRows).forEach((m, i) => byId.set(keyOf(m, i, 'cloud'), { ...m, listSource: 'supabase' }))
  rowsOf(relayRows).forEach((m, i) => byId.set(keyOf(m, i, 'relay'), { ...m, listSource: 'websocket' }))
  const rows = [...byId.values()]
  const at = (m) => pickerTime(m.scheduledAt ?? m.scheduled_at)
  return rows
    .map((m, i) => ({ m, i, t: at(m) }))
    .sort((a, b) => {
      if (a.t == null && b.t == null) return a.i - b.i
      if (a.t == null) return 1
      if (b.t == null) return -1
      return a.t - b.t || a.i - b.i
    })
    .map(({ m }) => m)
}
