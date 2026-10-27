/**
 * The scorer app's "current match": the one the home screen continues and the
 * one kept on the relay for the tablets and displays (App.jsx).
 *
 * It used to be ANY local match in status 'live', however old: a match
 * started months ago and never finished was published to the relay again on
 * every start and offered to the hall's referee tablets ("Home – Away").
 *
 * Now: the newest unfinished match by createdAt, leaving out an abandoned one
 * (created, last edited and scheduled all more than ABANDONED_LOCAL_MATCH_MS
 * ago, and without a single event). A match set up well ahead of its date is
 * not abandoned before that date. An old match that has events was played:
 * it stays current until it is finished, as before.
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
 * Old enough that it counts as abandoned when it has no events? createdAt
 * more than ABANDONED_LOCAL_MATCH_MS ago, and so are updatedAt and
 * scheduledAt when set (a match prepared a week or more ahead, or edited
 * lately, is not old); a match without createdAt is not. The caller looks up
 * the events only for these.
 */
export function needsEventCheck(match, now = Date.now()) {
  const created = timeOf(match?.createdAt)
  if (created == null) return false
  const latest = Math.max(created, timeOf(match?.updatedAt) ?? -Infinity, timeOf(match?.scheduledAt) ?? -Infinity)
  return now - latest > ABANDONED_LOCAL_MATCH_MS
}

/**
 * Abandoned: old (needsEventCheck: created, edited and scheduled more than 7
 * days ago) and without events.
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

/**
 * What "New match → Official match" does with the current match
 * (App.jsx createNewOfficialMatch), from its home-screen status:
 * - 'recording': an official match is being recorded. It is not replaced;
 *   the scorer is told to continue or delete it first.
 * - 'replace': a confirmed match is deleted after a question, a test or easy
 *   match also while it is being recorded.
 *   The button used to do nothing at all then, no dialog, no message, while
 *   Test match in the same menu asked to replace the match.
 * - 'discard': a match never confirmed (Create Match not pressed) is deleted
 *   without a word.
 * - 'new': no current match, or one that is no longer this device's to
 *   score: a copy the server has closed or another device scores now. Such a
 *   copy never blocks a new match and is never deleted on the way (the owner,
 *   2026-10-27): it stays on the device, read-only, listed on the home screen
 *   with its state, and Remove takes it off there. It used to be replaced
 *   after a question (closed), or to block as "still recording" (moved).
 * @param {object|null} match the current match
 * @param {string|undefined} status its home-screen status ('Match recording', ...)
 * @param {{ closedCopy?: boolean, movedCopy?: boolean }} [opts] closedCopy:
 *   closed on the server; movedCopy: scored on another device
 * @returns {'recording'|'replace'|'discard'|'new'}
 */
export function newOfficialMatchStep(match, status, { closedCopy = false, movedCopy = false } = {}) {
  if (!match || closedCopy || movedCopy) return 'new'
  if (status === 'Match recording') return match.test === true ? 'replace' : 'recording'
  return match.matchInfoConfirmedAt ? 'replace' : 'discard'
}
