/**
 * Live-state fields every viewer may see, PIN or not (owner 2026-11-17): what
 * a scoreboard (Point Hub, the LedBox, a TV page) needs without the match's
 * PIN, and without a shirt number in it.
 *
 *   subs_count_a / subs_count_b  substitutions of Team A / Team B in the
 *       set the live state names (current_set), exceptional ones included
 *       (owner 22.11.2026: "SUB shall count exceptional substitutions", as
 *       the scorer, the bench and the referee show SUB). 0 once current_set
 *       moves on to a set nobody has substituted in yet (the set end's push
 *       names the next set).
 *   set_results  the finished sets, oldest first: [{ set, home, away, a, b }].
 *       `set` is the set's index (a best-of-3 decider is stored as 5, as on
 *       the match row), home / away as the match row's set_results, a / b the
 *       same points by the live state's Team A / Team B (the A/B of points_a,
 *       sets_won_a, ...; fixed for the match, whatever the sides). [] before the first set ends. Read from the sets
 *       themselves at every push, so an undone set end, a reopened set or a
 *       corrected score is gone from the next push as well.
 *
 * subs_a / subs_b (who came in for whom) stay PIN-only (backend
 * lib/publicColumns.js LIVE_STATE_PRIVATE_COLUMNS). Pure.
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/**
 * Every substitution in a live-state substitution list (Scoreboard
 * captureFullStateSnapshot subsA / subsB), exceptional ones included.
 * @param {Array<object>|null|undefined} subs
 * @returns {number}
 */
export function substitutionCount(subs) {
  if (!Array.isArray(subs)) return 0
  return subs.filter((s) => s && typeof s === 'object').length
}

/**
 * Regular substitutions in a live-state substitution list (Scoreboard
 * captureFullStateSnapshot subsA / subsB: { playerIn, playerOut, exceptional }):
 * the 6 of the rule, the referee's SUB colour.
 * @param {Array<object>|null|undefined} subs
 * @returns {number}
 */
export function regularSubstitutionCount(subs) {
  if (!Array.isArray(subs)) return 0
  return subs.filter((s) => s && typeof s === 'object' && s.exceptional !== true).length
}

/**
 * The finished sets as live-state set_results.
 * @param {Array<object>} sets  the match's set rows ({ index, homePoints, awayPoints, finished })
 * @param {{ teamAKey?: 'home'|'away', endingSetIndex?: number|null, endingSetPoints?: { a?: number, b?: number }|null }} [opts]
 *   endingSetIndex: a set that ends with this push but is not marked finished
 *   yet (the set end's push runs on the last point's snapshot, before the set
 *   row is finished); its row's points count, else endingSetPoints (Team A/B).
 * @returns {Array<{ set: number, home: number, away: number, a: number, b: number }>}
 */
export function liveSetResultsOf(sets, { teamAKey = 'home', endingSetIndex = null, endingSetPoints = null } = {}) {
  const aIsHome = teamAKey !== 'away'
  const rows = (Array.isArray(sets) ? sets : []).filter((s) => s && typeof s === 'object' && Number.isFinite(Number(s.index)))
  const byIndex = new Map()
  for (const s of rows) {
    if (s.finished === true) byIndex.set(Number(s.index), { home: num(s.homePoints), away: num(s.awayPoints) })
  }
  const ending = Number(endingSetIndex)
  if (endingSetIndex != null && Number.isFinite(ending) && !byIndex.has(ending)) {
    const row = rows.find((s) => Number(s.index) === ending)
    if (row) byIndex.set(ending, { home: num(row.homePoints), away: num(row.awayPoints) })
    else if (endingSetPoints) {
      const a = num(endingSetPoints.a)
      const b = num(endingSetPoints.b)
      byIndex.set(ending, aIsHome ? { home: a, away: b } : { home: b, away: a })
    }
  }
  return [...byIndex.entries()]
    .sort(([x], [y]) => x - y)
    .map(([set, { home, away }]) => ({
      set,
      home,
      away,
      a: aIsHome ? home : away,
      b: aIsHome ? away : home
    }))
}

/**
 * The time-outs and substitutions of a live-state push: those of the set it
 * names (current_set). The set end's push names the next set while its
 * snapshot is still the finished set's: none yet then, not the finished set's
 * under the next set's number (audit LOG-21). subs_a / subs_b stay PIN-only.
 * @param {{ snapshot: object, pushedSetIndex: number }} args
 * @returns {{ timeouts_a: *, timeouts_b: *, subs_a: Array<object>|null, subs_b: Array<object>|null }}
 */
export function liveSetCounters({ snapshot, pushedSetIndex }) {
  const sameSet = Number(pushedSetIndex) === Number(snapshot?.currentSetIndex)
  const subs = (list) => (sameSet && Array.isArray(list) && list.length > 0 ? list : null)
  return {
    timeouts_a: sameSet ? snapshot?.timeoutsA : 0,
    timeouts_b: sameSet ? snapshot?.timeoutsB : 0,
    subs_a: subs(snapshot?.subsA),
    subs_b: subs(snapshot?.subsB)
  }
}

/**
 * subs_count_a, subs_count_b and set_results of a live-state push.
 * @param {object} args
 * @param {object} args.snapshot  the push's state snapshot (currentSetIndex, teamAKey, subsA, subsB, pointsA, pointsB)
 * @param {Array<object>} args.sets  the match's set rows now
 * @param {number} args.pushedSetIndex  the current_set the push names
 * @param {boolean} [args.countFinishedSet]  the snapshot's set ends with this push and
 *   may not be marked finished yet (Scoreboard finishedSetMissingFromSnapshot)
 */
export function livePublicFields({ snapshot, sets, pushedSetIndex, countFinishedSet = false }) {
  const snapSet = Number(snapshot?.currentSetIndex)
  // the snapshot's substitutions are those of its own set: none yet in a set
  // the push has moved on to
  const sameSet = Number(pushedSetIndex) === snapSet
  return {
    subs_count_a: sameSet ? substitutionCount(snapshot?.subsA) : 0,
    subs_count_b: sameSet ? substitutionCount(snapshot?.subsB) : 0,
    set_results: liveSetResultsOf(sets, {
      teamAKey: snapshot?.teamAKey === 'away' ? 'away' : 'home',
      endingSetIndex: countFinishedSet && Number.isFinite(snapSet) ? snapSet : null,
      endingSetPoints: { a: snapshot?.pointsA, b: snapshot?.pointsB }
    })
  }
}
