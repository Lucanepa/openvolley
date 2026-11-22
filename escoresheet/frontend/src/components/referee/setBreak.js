/**
 * The referee between two sets (pure; Referee.jsx): which set comes next, on
 * which sides its teams play and who serves its first rally.
 *
 * At a set end the scorer marks the set finished and syncs that bundle
 * before the next set's row exists (Scoreboard confirmSetEndTime creates it
 * after the backups), and often sends no other bundle before the next set's
 * line-ups. The referee then had no unfinished set for the whole break and
 * fell back to defaults: home on the left of the 2nd referee and set 1's
 * first server, so the previous set's sides with the SERVE box on the team
 * that had served last, while the other team serves the next set
 * (full-match test 21.11.2026).
 *
 * The next set's sides: the live state's (side_a) when it names that set
 * (the set end's push and every push in the break are the coming set's,
 * Scoreboard syncLiveStateToSupabase), else the scorer's own rule
 * (domain/rules getSideAForSet: the teams change sides after every set).
 * Its first server: the scorer's log (servingTeamFromLog: set 1's server in
 * odd sets, the other team in even sets, a penalty point before the first
 * serve), a view built from the live state alone its serving_team. The
 * deciding set (index 5) only after its coin toss: before it the teams stay
 * on the sides the set before ended on, and nobody is shown serving.
 */
import { getNextSetIndex, isMatchFinished, previousSetIndex } from '../../utils/matchFormat'
import { getSideAForSet, getFirstServeForSet, servingTeamFromLog } from '../../domain/rules'
import { isFirstRallyOf } from '../../domain/rally'

const SIDES = ['left', 'right']
const teamKey = (v, fallback = 'home') => (v === 'home' || v === 'away' ? v : fallback)

const setRows = (sets) => (Array.isArray(sets) ? sets : [])
  .filter((s) => s && typeof s === 'object' && Number.isFinite(Number(s.index)))

/** Sets won by home and away, from the finished set rows. */
export function setsWonOf(sets) {
  const won = { home: 0, away: 0 }
  for (const s of setRows(sets)) {
    if (!s.finished) continue
    if ((s.homePoints || 0) > (s.awayPoints || 0)) won.home++
    else if ((s.awayPoints || 0) > (s.homePoints || 0)) won.away++
  }
  return won
}

/**
 * The set that comes next while every set row is finished and the match is
 * not over (the next set's row is not there yet), else null.
 * @param {Array<{ index: number, homePoints?: number, awayPoints?: number, finished?: boolean }>} sets
 * @param {number} [bestOf]
 * @returns {number|null}
 */
export function pendingSetIndex(sets, bestOf = 5) {
  const rows = setRows(sets)
  if (!rows.length || rows.some((s) => !s.finished)) return null
  const b = Number(bestOf) || 5
  const won = setsWonOf(rows)
  if (isMatchFinished(won.home, won.away, b)) return null
  const last = Math.max(...rows.map((s) => Number(s.index)))
  return getNextSetIndex(last, won.home, won.away, b)
}

/**
 * Has the deciding set's coin toss been confirmed? Its set5_coin_toss event
 * in the scorer's log (Scoreboard confirmSet5SideService); a view built from
 * the live state alone (no log): the break has ended on the scorer while the
 * live state names set 5 (the set 5 setup's confirmation ends it).
 */
export function decidingTossDone({ events, liveState, liveStateOnly = false } = {}) {
  if ((events || []).some((e) => e?.type === 'set5_coin_toss' && Number(e.setIndex) === 5)) return true
  return !!liveStateOnly && Number(liveState?.current_set) === 5 && liveState?.set_interval_active === false
}

/**
 * The break the referee is in, or null while a set is under way (also
 * before set 1 and once the match is over).
 *
 * In a break: every set row finished and the match not over (the next
 * set's row is not there yet); the set after a finished one before its
 * first rally (a penalty point before the first serve does not start it,
 * domain/rally isFirstRallyOf); or the live state says the scorer's break
 * runs (set_interval_active).
 *
 * @param {object} p
 * @param {Array<object>} [p.sets]  the bundle's set rows
 * @param {object|null} [p.currentSet]  the first unfinished set row
 * @param {object|null} [p.liveState]
 * @param {Array<object>} [p.events]  the scorer's log (a relay bundle), or the events built from the live state
 * @param {object} [p.match]
 * @param {number} [p.bestOf]
 * @param {'home'|'away'} [p.teamAKey]  the match's Team A (coin toss)
 * @param {'home'|'away'} [p.liveTeamAKey]  the Team A the live state's A/B fields name
 * @param {boolean} [p.liveStateOnly]  the view is built from a match_live_state row (no log)
 * @returns {null | { setIndex: number, betweenSets: boolean, homeLeft: boolean, servingTeam: 'home'|'away'|null }}
 *   setIndex: the set that comes next. betweenSets: no set has started since
 *   the last one ended (not only the live state's break flag). homeLeft:
 *   home is on the left of the 2nd referee (the scorer's side) in that set.
 *   servingTeam: who serves its first rally, null while not known (the
 *   deciding set before its coin toss).
 */
export function refereeSetBreak({ sets, currentSet = null, liveState = null, events = [], match = {}, bestOf = 5, teamAKey = 'home', liveTeamAKey, liveStateOnly = false } = {}) {
  const rows = setRows(sets)
  const b = Number(bestOf) || 5
  const won = setsWonOf(rows)
  if (liveState?.match_status === 'ended' || isMatchFinished(won.home, won.away, b) ||
      isMatchFinished(Number(liveState?.sets_won_a) || 0, Number(liveState?.sets_won_b) || 0, b)) return null

  let setIndex = null
  let betweenSets = false
  if (currentSet && Number.isFinite(Number(currentSet.index))) {
    const index = Number(currentSet.index)
    const before = rows.find((s) => Number(s.index) === previousSetIndex(index, b))
    if (index > 1 && before?.finished && isFirstRallyOf(events, index)) {
      setIndex = index
      betweenSets = true
    }
  } else {
    const pending = pendingSetIndex(rows, b)
    if (pending != null) {
      setIndex = pending
      betweenSets = true
    }
  }
  if (setIndex == null && liveState?.set_interval_active === true) {
    setIndex = Number(liveState.current_set) || Number(currentSet?.index) || null
  }
  if (setIndex == null) return null

  const aKey = teamKey(teamAKey)
  const liveAKey = teamKey(liveTeamAKey, aKey)
  const m = match || {}
  const known = setIndex !== 5 || decidingTossDone({ events, liveState, liveStateOnly })
  const liveNamesSet = known && Number(liveState?.current_set) === setIndex && SIDES.includes(liveState?.side_a)

  let homeLeft
  if (liveNamesSet) {
    homeLeft = (liveState.side_a === 'left') === (liveAKey === 'home')
  } else {
    // the scorer's own rule; the deciding set before its coin toss: the
    // sides the set before ended on (the teams stay there until the toss)
    const sideA = getSideAForSet(known ? setIndex : previousSetIndex(setIndex, b), m)
    homeLeft = (sideA === 'left') === (aKey === 'home')
  }

  let servingTeam = null
  if (known) {
    if (liveStateOnly) {
      servingTeam = liveNamesSet && SIDES.includes(liveState?.serving_team)
        ? ((liveState.serving_team === 'left') === homeLeft ? 'home' : 'away')
        : getFirstServeForSet(setIndex, m)
    } else {
      servingTeam = servingTeamFromLog(events, setIndex, m)
    }
  }

  return { setIndex, betweenSets, homeLeft, servingTeam }
}
