/**
 * Time-out requests (FIVB 2025-2028 Rules 15.2, 15.4, 15.11). Pure: no React,
 * no Dexie.
 *
 *  - Each team has two time-outs per set (15.2.1). Swiss indoor play has no
 *    technical time-outs.
 *  - A team may take both in the same interruption, one after the other, with
 *    no rally in between (15.4.3). That is legal, but worth a second look on
 *    the scoretable because a double tap looks the same.
 *  - A request beyond the two is an improper request (15.11.1.4).
 */

export const TIMEOUTS_PER_SET = 2

/**
 * What a time-out request by `team` means right now, from the events of the
 * current set. Taken once, when the request dialog opens, so the dialog shows
 * the same thing until it closes (the live time-out count changes the moment
 * the time-out is written).
 *
 * @param {Array} events all match events
 * @param {number} setIndex the current set
 * @param {'home'|'away'} team
 * @returns {{used:number, ordinal:number, consecutive:boolean, improper:boolean}}
 *   used: time-outs the team already took this set;
 *   ordinal: which time-out this would be (1, 2, or 3+ when improper);
 *   consecutive: the team already took a time-out in this interruption (no
 *     rally started or point scored since its last one);
 *   improper: both time-outs are used, so this is an improper request.
 */
export function classifyTimeoutRequest(events, setIndex, team) {
  const setEvents = (events || []).filter(e => e.setIndex === setIndex)
  const own = setEvents.filter(e => e.type === 'timeout' && e.payload?.team === team)
  const used = own.length
  if (used >= TIMEOUTS_PER_SET) {
    return { used, ordinal: used + 1, consecutive: false, improper: true }
  }
  let consecutive = false
  if (used > 0) {
    const lastSeq = Math.max(...own.map(e => e.seq || 0))
    // A rally that was started (even if it was then replayed) ends the
    // interruption; so does any point.
    consecutive = !setEvents.some(e =>
      (e.type === 'rally_start' || e.type === 'point') && (e.seq || 0) > lastSeq
    )
  }
  return { used, ordinal: used + 1, consecutive, improper: false }
}
