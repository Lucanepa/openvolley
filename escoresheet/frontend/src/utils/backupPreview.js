/**
 * What the Restore preview shows of a match backup: teams, the latest set and
 * its score, each team's current line-up, time-outs and substitutions (with
 * the score when each one happened), sanctions, the serving team and the set
 * scores.
 *
 * Two shapes come in: a backup file / cloud backup (match, homeTeam,
 * awayTeam, sets, events) and a database restore (match.home_team,
 * liveState, sets with home_points).
 *
 * A substitution event carries no score (its payload is team, position,
 * playerOut, playerIn and flags), so the score is counted from the points of
 * the same set logged before it, as the scoresheet does (scoreBeforeEvent).
 */
import { compareBySeq, scoreBeforeEvent } from '../domain/describe.js'

const SIDES = ['home', 'away']
const isSide = (v) => v === 'home' || v === 'away'

const pointsOf = (set, side) => (side === 'home'
  ? (set?.homePoints ?? set?.home_points)
  : (set?.awayPoints ?? set?.away_points))

/** The last event of a list in log order (seq, then time). */
function lastBySeq(list) {
  let last = null
  for (const e of list) if (!last || compareBySeq(e, last) >= 0) last = e
  return last
}

export function summarizeBackup(d) {
  const data = d || {}
  const isDbFormat = !!(data.match?.home_team || data.liveState)
  const live = data.liveState || null

  const teamName = (side) => {
    const m = data.match || {}
    if (isDbFormat) {
      const t = side === 'home' ? m.home_team : m.away_team
      return (typeof t === 'string' ? t : t?.name) || (side === 'home' ? m.homeTeamName : m.awayTeamName) || null
    }
    const t = side === 'home' ? data.homeTeam : data.awayTeam
    return t?.name || (side === 'home' ? m.homeTeamName : m.awayTeamName) || null
  }

  const events = Array.isArray(data.events) ? data.events : []
  const sets = (Array.isArray(data.sets) ? data.sets : [])
    .slice()
    .sort((a, b) => (a.index || 0) - (b.index || 0))

  const latestSet = sets[sets.length - 1] || null
  const setIndex = latestSet?.index || live?.current_set || 1
  const score = {
    home: pointsOf(latestSet, 'home') ?? live?.points_a ?? 0,
    away: pointsOf(latestSet, 'away') ?? live?.points_b ?? 0
  }

  const inSet = (e) => (e.setIndex ?? 1) === setIndex

  // Current line-up: the last line-up of the set (a substitution or libero
  // change writes a new one), else the last one of the match, else liveState
  const lineup = {}
  for (const side of SIDES) {
    const ofTeam = events.filter(e => e.type === 'lineup' && e.payload?.team === side && e.payload?.lineup)
    const last = lastBySeq(ofTeam.filter(inSet)) || lastBySeq(ofTeam)
    lineup[side] = last?.payload?.lineup
      || (isDbFormat ? (side === 'home' ? live?.lineup_a : live?.lineup_b) : null)
      || null
  }

  const timeouts = { home: 0, away: 0 }
  for (const e of events) {
    if (e.type === 'timeout' && inSet(e) && isSide(e.payload?.team)) timeouts[e.payload.team]++
  }

  const substitutions = { home: [], away: [] }
  const subs = events.filter(e => e.type === 'substitution' && inSet(e) && isSide(e.payload?.team)).sort(compareBySeq)
  for (const e of subs) {
    const at = scoreBeforeEvent(events, e)
    substitutions[e.payload.team].push({
      key: e.id ?? e.seq,
      playerIn: e.payload.playerIn,
      playerOut: e.payload.playerOut,
      home: at.home,
      away: at.away,
      exceptional: !!e.payload.isExceptional
    })
  }

  const sanctions = events.filter(e => e.type === 'sanction').sort(compareBySeq)

  // Serving: the team that won the last rally of the set; at the start of a
  // set (no point yet) the app's own state of the last event, else liveState
  const lastPoint = lastBySeq(events.filter(e => e.type === 'point' && inSet(e)))
  let serving = isSide(lastPoint?.payload?.team) ? lastPoint.payload.team : null
  if (!serving) {
    const snap = lastBySeq(events.filter(e => e.stateSnapshot))?.stateSnapshot
    if (isSide(snap?.servingTeam)) serving = snap.servingTeam
    else if (isSide(live?.serving_team)) serving = live.serving_team
  }

  return {
    teams: { home: teamName('home'), away: teamName('away') },
    setIndex,
    score,
    serving,
    lineup,
    timeouts,
    substitutions,
    sanctions,
    sets: sets.map(s => ({
      index: s.index,
      home: pointsOf(s, 'home') ?? 0,
      away: pointsOf(s, 'away') ?? 0,
      finished: !!s.finished
    }))
  }
}
