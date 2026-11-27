/**
 * VolleyManager's public league calendars (`/iCal/schedule/<token>`): one
 * calendar per league, no login. Since 27.11.2026 they are the schedule's
 * source instead of the shared login, which VolleyManager refuses.
 *
 * Read by the structured fields only. The text labels follow the language of
 * the account the link was made with ("Risultato", "Lega", "Palestra" for an
 * Italian one), so nothing here matches a label.
 *
 * A calendar has no referees, line judges, licences or number of win sets.
 */

/** RFC 5545 unfolding: a line that starts with a space or tab continues the previous one. */
export function unfoldIcal(text) {
  const out = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length) out[out.length - 1] += raw.slice(1)
    else if (raw !== '') out.push(raw)
  }
  return out
}

/** \\n, \\, \\; \\\\ in a TEXT value. */
export function unescapeIcal(value) {
  return String(value ?? '').replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c))
}

/**
 * "NAME;P1=a;P2=b:value" -> { name, params, value }. The value starts at the
 * first ':' outside double quotes (parameter values may be quoted).
 */
export function splitProperty(line) {
  let inQuotes = false
  let cut = -1
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === ':' && !inQuotes) { cut = i; break }
  }
  if (cut < 0) return null
  const [name, ...rawParams] = line.slice(0, cut).split(';')
  const params = {}
  for (const p of rawParams) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: name.toUpperCase(), params, value: line.slice(cut + 1) }
}

const GENDERS = { '♂': 'men', '♀': 'women' }

/** "#7351 | Rookie 2 | ♂ (SVRZ)" -> { id: '7351', league: 'Rookie 2', gender: 'men', region: 'SVRZ' }. */
export function parseCalendarName(name) {
  const m = String(name ?? '').trim().match(/^#(\d+)\s*\|\s*(.+?)\s*\|\s*([♂♀])\s*(?:\(([^)]*)\))?\s*$/u)
  if (!m) return { id: '', league: String(name ?? '').trim(), gender: '', region: '' }
  return { id: m[1], league: m[2].trim(), gender: GENDERS[m[3]] ?? '', region: (m[4] ?? '').trim() }
}

/**
 * DTSTART: "20260912T090000" with TZID, or "20260912T070000Z".
 * -> { ymd: '2026-09-12', hour: 9, minute: 0, tz: 'Europe/Zurich' | 'UTC' }, or null.
 */
export function parseIcalStart(value, tzid) {
  const m = String(value ?? '').trim().match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/)
  if (!m) return null
  return { ymd: `${m[1]}-${m[2]}-${m[3]}`, hour: Number(m[4]), minute: Number(m[5]), tz: m[7] ? 'UTC' : (tzid || 'Europe/Zurich') }
}

/** "Talacherstrasse, 8302 Kloten" -> { street, postalCode, city }. */
export function parseLocation(location) {
  const text = String(location ?? '').trim()
  const m = text.match(/^(.*?),\s*(\d{4})\s+(.+)$/)
  if (m) return { street: m[1].trim(), postalCode: m[2], city: m[3].trim() }
  return { street: text, postalCode: '', city: '' }
}

/**
 * The two teams. The description's first line is
 * "#422686 | 12.09.2026 09:00 | VBC Züri Unterland — Volley Dübi" (an em dash
 * between the teams, the same in every language). Fallback: the summary
 * "Home - Away (League)".
 */
export function parseTeams(description, summary) {
  const first = unescapeIcal(description).split('\n')[0] ?? ''
  const teams = first.split(' | ').slice(2).join(' | ')
  const byDash = teams.split(' — ')
  if (byDash.length === 2) return { home: byDash[0].trim(), away: byDash[1].trim() }
  const s = unescapeIcal(summary).replace(/\s*\([^()]*\)\s*$/, '')
  const parts = s.split(' - ')
  if (parts.length === 2) return { home: parts[0].trim(), away: parts[1].trim() }
  return { home: '', away: '' }
}

/**
 * A league calendar -> { calendar, games, skipped }. `games`: one per VEVENT
 * with a "game-<number>" UID and a start time; `skipped`: events without them.
 */
export function parseLeagueCalendar(text) {
  const lines = unfoldIcal(text)
  let calName = ''
  const events = []
  let ev = null
  let depth = 0 // nested components inside a VEVENT (VALARM)
  for (const line of lines) {
    const prop = splitProperty(line)
    if (!prop) continue
    if (prop.name === 'BEGIN') {
      if (prop.value.toUpperCase() === 'VEVENT' && !ev) ev = {}
      else if (ev) depth++
      continue
    }
    if (prop.name === 'END') {
      if (ev && depth) depth--
      else if (ev && prop.value.toUpperCase() === 'VEVENT') { events.push(ev); ev = null }
      continue
    }
    if (!ev) {
      if ((prop.name === 'X-WR-CALNAME' || (prop.name === 'NAME' && !calName))) calName = unescapeIcal(prop.value)
      continue
    }
    if (depth) continue // the alarm's own DESCRIPTION is not the game's
    if (prop.name === 'UID') ev.uid = prop.value.trim()
    else if (prop.name === 'DTSTART') ev.start = parseIcalStart(prop.value, prop.params.TZID)
    else if (prop.name === 'SUMMARY') ev.summary = prop.value
    else if (prop.name === 'DESCRIPTION') ev.description = prop.value
    else if (prop.name === 'LOCATION') ev.location = unescapeIcal(prop.value)
    else if (prop.name === 'X-APPLE-STRUCTURED-LOCATION') ev.hall = unescapeIcal(prop.params['X-TITLE'] ?? '').trim()
  }

  const calendar = parseCalendarName(calName)
  const games = []
  let skipped = 0
  for (const e of events) {
    const number = String(e.uid ?? '').match(/^game-(\d+)$/)?.[1]
    if (!number || !e.start) { skipped++; continue }
    const { home, away } = parseTeams(e.description, e.summary)
    games.push({ game_number: number, start: e.start, team_home: home, team_away: away, hall: e.hall ?? '', ...parseLocation(e.location) })
  }
  return { calendar, games, skipped }
}
