/**
 * Countdowns (a time-out's 30 s, the interval between sets) counted on the
 * device's own monotonic clock (performance.now), never by subtracting
 * wall-clock times, least of all those of two devices.
 *
 * The referee tablet counted a time-out as 30 - (its own Date.now() - the
 * scorer's Date.now() at the start): a tablet whose clock ran 2 minutes slow
 * showed 150 and counted down from there, one a minute fast showed no
 * countdown at all. The scorer's own countdown read 3624 once its clock was
 * set back an hour in the middle of a time-out (stress test 2026-10-25). In a
 * hall without network time, clocks are off by minutes; and a clock that is
 * corrected jumps.
 *
 * A device's clock may be off, but the scorer's own two readings, when the
 * countdown started and when it sent the message about it, are not off from
 * each other: their difference is how long the countdown had run when it was
 * sent. The receiving device counts on from there on its own monotonic clock
 * (the message's way through the relay, well under a second, is not counted).
 * Both readings are the device's own Date.now(), never the live-state clock
 * that orders the rows (liveStatePushedAt).
 */

/** This device's monotonic clock in ms (performance.now; Date.now without it). */
export function monotonicNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

const toMs = (value) => {
  if (value == null || value === '') return null
  const ms = typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}

/**
 * How long (ms) another device's countdown had run when that device sent the
 * message about it: its start and its send time, both read on ITS clock
 * (epoch ms or ISO). 0 without one of them (the time-out action is sent as it
 * starts). Never below 0 nor above the countdown's length.
 * @param {number|string|null} startedAt
 * @param {number|string|null} sentAt
 * @param {number} durationMs
 */
export function elapsedWhenSent(startedAt, sentAt, durationMs) {
  const start = toMs(startedAt)
  const sent = toMs(sentAt)
  if (start == null || sent == null) return 0
  return Math.min(Math.max(0, sent - start), Math.max(0, durationMs || 0))
}

/**
 * When the scorer pushed a match_live_state row, read on its own clock, the
 * clock its countdown starts (timeout_started_at, set_interval_started_at)
 * are on: the push's last_event_ts, else its updated_at. A push that names
 * an event stamps last_event_ts with the device's Date.now() as it is sent.
 * updated_at is on the match's live-state clock (serverDataSync
 * liveClockOffset), which orders the rows: on a device that continued a
 * match from one whose clock was ahead, it runs ahead of the device's own
 * clock by as much, an hour after a laptop in the wrong time zone, and a
 * time-out counted from it read 0 from its first second. A reconnect push
 * names the last event again with its own time: a countdown first read from
 * one counts from that event's push (more time left than there is, never
 * less).
 * @param {object|null} row
 * @returns {string|number|null}
 */
export function liveStatePushedAt(row) {
  return row?.last_event_ts || row?.updated_at || null
}

/**
 * The countdown's start on this device's monotonic clock, from how long it
 * has already run.
 * @param {number} [elapsedMs=0]
 * @param {number} [now] monotonicNow()
 */
export function countdownAnchor(elapsedMs = 0, now = monotonicNow()) {
  return now - Math.max(0, Number(elapsedMs) || 0)
}

/**
 * Whole seconds left of a countdown of `durationSec` started at `anchor`
 * (countdownAnchor): from durationSec down to 0, never outside.
 * @param {number} anchor
 * @param {number} durationSec
 * @param {number} [now] monotonicNow()
 */
export function secondsLeft(anchor, durationSec, now = monotonicNow()) {
  const elapsed = Math.floor(Math.max(0, now - anchor) / 1000)
  return Math.max(0, Math.min(durationSec, durationSec - elapsed))
}

// Two starts this close are the same time-out or break (the Referee's own
// comparison of a row's start with the countdown it shows)
const SAME_COUNTDOWN_MS = 2000
const KEPT_PREFIX = 'openvolley-countdown:'

/**
 * Keep a countdown this tab shows for its reload: its end on this device's
 * wall clock, in sessionStorage (a reload keeps it, no other tab reads it).
 * The monotonic clock starts again with the page, the wall clock does not,
 * and both readings are this device's own. `key` names the countdown (match
 * and kind), `startedAt` (the scorer's start) tells which one it is.
 * @param {string} key
 * @param {number|string} startedAt
 * @param {number} anchor countdownAnchor()
 * @param {number} durationSec
 */
export function keepCountdown(key, startedAt, anchor, durationSec, { now = Date.now(), mono = monotonicNow() } = {}) {
  const start = toMs(startedAt)
  if (start == null || !Number.isFinite(anchor)) return
  try {
    sessionStorage.setItem(KEPT_PREFIX + key, JSON.stringify({ start, endsAt: now + (anchor + durationSec * 1000 - mono) }))
  } catch { /* no storage: a reload counts from the scorer's start */ }
}

/**
 * How long (ms) a countdown has run, for one read after the fact from a
 * live-state row (a referee that reloads or joins while it runs). Its
 * difference with the row's push time says nothing then: the scorer sends
 * no push while a countdown runs, so that is the push at its start. This
 * tab's own countdown of the same start, kept before the reload
 * (keepCountdown), when there is one; else this device's clock against the
 * scorer's start, right when both keep network time (a tablet joining only
 * now has nothing else). The start is the scorer's own clock, as the relay
 * action's start a kept countdown names: on the live-state clock (round 2),
 * a start the offset ahead matched no kept countdown and read 0 elapsed, the
 * full 30 s. Never below 0 nor above the countdown's length.
 * @param {string} key
 * @param {number|string} startedAt
 * @param {number} durationSec
 */
export function elapsedAfterTheFact(key, startedAt, durationSec, { now = Date.now() } = {}) {
  const durationMs = Math.max(0, (durationSec || 0) * 1000)
  const start = toMs(startedAt)
  if (start == null) return 0
  let elapsed = now - start
  try {
    const kept = JSON.parse(sessionStorage.getItem(KEPT_PREFIX + key) || 'null')
    if (kept && Number.isFinite(kept.endsAt) && Math.abs(kept.start - start) <= SAME_COUNTDOWN_MS) {
      elapsed = durationMs - (kept.endsAt - now)
    }
  } catch { /* unreadable: this device's clock */ }
  return Math.min(Math.max(0, elapsed), durationMs)
}
