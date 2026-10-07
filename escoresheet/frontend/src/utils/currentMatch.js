/**
 * The scorer app's "current match": the one the home screen continues and the
 * one kept on the relay for the tablets and displays (App.jsx).
 *
 * It used to be ANY local match in status 'live', however old: a match
 * started months ago and never finished was published to the relay again on
 * every start and offered to the hall's referee tablets ("Home – Away").
 *
 * Now: the newest unfinished match by createdAt, leaving out an abandoned one
 * (created more than ABANDONED_LOCAL_MATCH_MS ago and without a single
 * event). An old match that has events was played: it stays current until it
 * is finished, as before.
 */

export const ABANDONED_LOCAL_MATCH_MS = 7 * 24 * 60 * 60 * 1000

/** A Dexie timestamp (ISO string or epoch ms) in epoch ms, or null. */
function timeOf(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime()
  const t = Date.parse(String(value))
  return Number.isNaN(t) ? null : t
}

const isFinishedLocalMatch = (m) => m?.status === 'final'

/**
 * Old enough that it counts as abandoned when it has no events? (createdAt
 * more than ABANDONED_LOCAL_MATCH_MS ago; a match without createdAt is not.)
 * The caller looks up the events only for these.
 */
export function needsEventCheck(match, now = Date.now()) {
  const created = timeOf(match?.createdAt)
  return created != null && now - created > ABANDONED_LOCAL_MATCH_MS
}

/**
 * Abandoned: created more than 7 days ago and without events.
 * @param {object} match
 * @param {{ now?: number, hasEvents?: (id: any) => boolean }} [opts]
 */
export function isAbandonedLocalMatch(match, { now = Date.now(), hasEvents = () => false } = {}) {
  return needsEventCheck(match, now) && !hasEvents(match.id)
}

/**
 * The current match among the local ones: newest unfinished by createdAt
 * (none last), not abandoned. null when there is none.
 * @param {Array<object>} matches
 * @param {{ now?: number, hasEvents?: (id: any) => boolean }} [opts]
 */
export function pickCurrentMatch(matches, { now = Date.now(), hasEvents = () => false } = {}) {
  if (!Array.isArray(matches)) return null
  const candidates = matches
    .map((m, i) => ({ m, i, t: timeOf(m?.createdAt) }))
    .filter(({ m }) => m && typeof m === 'object' && !isFinishedLocalMatch(m) && !isAbandonedLocalMatch(m, { now, hasEvents }))
    .sort((a, b) => {
      if (a.t == null && b.t == null) return a.i - b.i
      if (a.t == null) return 1
      if (b.t == null) return -1
      return b.t - a.t || a.i - b.i
    })
  return candidates.length ? candidates[0].m : null
}
