// "Skip to set 5" (owner decision 24.11.2026): the walkthrough fills sets
// with demo rallies through the same event model as live scoring, so the
// scoresheet prints them as it prints any played set. What a rally writes is
// what the scoring screen writes (Scoreboard handlePoint / confirmSetStartTime
// and the line-up dialog): the starting line-ups (lineup, isInitial), the
// set start (set_start + the first rally_start, the set row's start time),
// then per rally a rally_start and the point with the running score; the
// rotation of a side-out (and a libero's automatic exit) as the point's N.x
// sub-row, as the manual corrections rebuild it (domain/recompute, a no-op
// on a log the scoreboard wrote). The set end is NOT written here: the
// scoring screen sees the set won and asks for it, and the walkthrough
// confirms that dialog (walkthroughFlow.js), so the set end, the interval,
// the next set and the deciding set's coin toss are the app's own.
//
// Test matches only: anything else is refused (demo data never touches a
// real match, and a test match sends nothing: domain/matchKind).
import { recomputeMatch } from '../../domain/recompute'
import { startingLineupOf } from '../../domain/lineupCopy'
import { getSetResult, pointsToWinFor, setTargetsOf } from '../../domain/rules'
import { rallyStatusOf } from '../../domain/rally'
import { maxVoidedSeq } from '../../db/eventHistory'
import { demoMatch } from './demoData'

const POSITIONS = ['I', 'II', 'III', 'IV', 'V', 'VI']
const other = (team) => (team === 'home' ? 'away' : 'home')
const hasNumber = (p) => p && p.number !== null && p.number !== undefined && p.number !== '' && Number.isFinite(Number(p.number))

/**
 * A legal starting six of a roster: the team captain (so no game captain is
 * needed) and the lowest numbers that are no libero. null with fewer than six.
 */
export function demoLineupOf(players) {
  const field = (players || []).filter(p => hasNumber(p) && !p.libero)
  const captain = field.find(p => p.isCaptain)
  const rest = field.filter(p => p !== captain).sort((a, b) => Number(a.number) - Number(b.number))
  const six = [...(captain ? [captain] : []), ...rest].slice(0, 6)
  if (six.length < 6) return null
  return Object.fromEntries(POSITIONS.map((pos, i) => [pos, Number(six[i].number)]))
}

async function matchData(db, matchId) {
  const match = await demoMatch(matchId, db)
  if (!match) throw new Error('walkthrough: not a test match')
  const [events, homePlayers, awayPlayers, sets] = await Promise.all([
    db.events.where('matchId').equals(matchId).toArray(),
    match.homeTeamId != null ? db.players.where('teamId').equals(match.homeTeamId).toArray() : [],
    match.awayTeamId != null ? db.players.where('teamId').equals(match.awayTeamId).toArray() : [],
    db.sets.where('matchId').equals(matchId).toArray()
  ])
  return { match, events, players: { home: homePlayers, away: awayPlayers }, sets }
}

// The next main seq (an undone seq is never given out again, as getNextSeq)
async function nextMainSeq(db, matchId, events) {
  const max = Math.max(events.reduce((m, e) => Math.max(m, e.seq || 0), 0), Math.floor(await maxVoidedSeq(db, matchId)))
  return Math.floor(max) + 1
}

/** The set row being played (the newest unfinished row of that index). */
function setRowOf(sets, setIndex) {
  return sets.filter(s => s.index === setIndex).sort((a, b) => (b.id || 0) - (a.id || 0))[0] || null
}

/**
 * The starting line-ups of a set for the teams that have none: the team's
 * starting line-up of set 1 (any set's line-up is legal again), else a demo
 * six of its roster. Returns how many it wrote.
 */
export async function writeDemoLineups(db, matchId, setIndex) {
  const { players, events } = await matchData(db, matchId)
  let seq = await nextMainSeq(db, matchId, events)
  let written = 0
  for (const team of ['home', 'away']) {
    const has = events.some(e => e.type === 'lineup' && e.setIndex === setIndex && e.payload?.team === team && e.payload?.isInitial)
    if (has) continue
    const fromSet1 = setIndex !== 1 ? startingLineupOf(events, 1, team) : null
    // shirt numbers, as the line-up dialog writes them
    const lineup = fromSet1 && POSITIONS.every(pos => fromSet1[pos] !== '' && Number.isFinite(Number(fromSet1[pos])))
      ? Object.fromEntries(POSITIONS.map(pos => [pos, Number(fromSet1[pos])]))
      : demoLineupOf(players[team])
    if (!lineup) throw new Error(`walkthrough: no six players for ${team}`)
    await db.events.add({ matchId, setIndex, ts: new Date().toISOString(), type: 'lineup', payload: { team, lineup, isInitial: true }, seq })
    seq += 1
    written += 1
  }
  return written
}

/**
 * The points still to play, in order: the winner's last point last, and no
 * score on the way that ends the set (or passes `stopAtLeader`).
 */
export function planRallies({ home, away }, winner, { setIndex, targets, stopAtLeader = null }) {
  const toWin = pointsToWinFor(setIndex, targets)
  const loser = other(winner)
  const start = { home, away }
  let finalW
  let finalL
  if (stopAtLeader != null) {
    finalW = Math.max(start[winner], stopAtLeader)
    finalL = Math.min(Math.max(start[loser], stopAtLeader - 2), finalW - 1)
  } else {
    // a close set, a little different each time (25:20, 25:22, 25:19 ...)
    const want = toWin - [5, 3, 6, 4, 2][setIndex % 5]
    finalL = Math.max(start[loser], want)
    finalW = finalL >= toWin - 1 ? finalL + 2 : toWin
    finalW = Math.max(finalW, start[winner] + 1)
  }
  const plan = []
  let w = start[winner]
  let l = start[loser]
  const wSpan = Math.max(1, finalW - start[winner])
  const lSpan = Math.max(1, finalL - start[loser])
  while (w < finalW || l < finalL) {
    const wLeft = finalW - w
    const lLeft = finalL - l
    // the winner's last point waits for the loser's points
    const loserNext = lLeft > 0 && (wLeft <= 1 || (l - start[loser]) / lSpan <= (w - start[winner]) / wSpan)
    if (loserNext) { l += 1; plan.push(loser) } else { w += 1; plan.push(winner) }
  }
  return plan
}

/**
 * Plays demo rallies in set `setIndex` until `winner` has won it (the set
 * end is left to the scoring screen), or with `stopAtLeader` until the
 * winner has that many points. Starts the set first when it has not started
 * (needs both starting line-ups: writeDemoLineups). Returns the score.
 */
export async function writeDemoRallies(db, matchId, { setIndex, winner, stopAtLeader = null }) {
  if (winner !== 'home' && winner !== 'away') throw new Error('walkthrough: no winner')
  return db.transaction('rw', [db.events, db.sets, db.matches, db.players, db.event_history], async () => {
    const { match, events, players, sets } = await matchData(db, matchId)
    const setRow = setRowOf(sets, setIndex)
    if (!setRow || setRow.finished) throw new Error(`walkthrough: set ${setIndex} is not being played`)
    const lineupsIn = ['home', 'away'].every(team => events.some(e => e.type === 'lineup' && e.setIndex === setIndex && e.payload?.team === team && e.payload?.isInitial))
    if (!lineupsIn) throw new Error(`walkthrough: set ${setIndex} has no line-ups`)
    const targets = setTargetsOf(match)
    const ofSet = events.filter(e => e.setIndex === setIndex)
    const score = {
      home: ofSet.filter(e => e.type === 'point' && e.payload?.team === 'home').length,
      away: ofSet.filter(e => e.type === 'point' && e.payload?.team === 'away').length
    }
    const plan = planRallies(score, winner, { setIndex, targets, stopAtLeader })
    let seq = await nextMainSeq(db, matchId, events)
    // one rally after the other, a few milliseconds apart (the scoreboard's
    // clock order; the times are not used for ordering)
    let clock = Date.now()
    const ts = () => new Date(clock++).toISOString()
    const added = []
    const add = async (row) => {
      const id = await db.events.add({ matchId, setIndex, ...row })
      added.push({ id, ...row })
      return id
    }
    let inPlay = rallyStatusOf(events, setIndex) === 'in_play'
    const started = ofSet.some(e => e.type === 'set_start' || e.type === 'rally_start' || (e.type === 'point' && e.payload?.penaltySeq == null))
    if (!started && plan.length) {
      // Start set: the set row's start, set_start and the first rally
      const startTime = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString()
      await db.sets.update(setRow.id, { startTime })
      const firstRallyAt = ts()
      await add({ type: 'set_start', payload: { setIndex, startTime, firstRallyAt }, ts: startTime, seq: seq++ })
      await add({ type: 'rally_start', payload: {}, ts: firstRallyAt, seq: seq++ })
      inPlay = true
    }
    const pointSeqs = new Set()
    for (const team of plan) {
      if (!inPlay) await add({ type: 'rally_start', payload: {}, ts: ts(), seq: seq++ })
      score[team] += 1
      pointSeqs.add(seq)
      await add({ type: 'point', payload: { team, score: { home: score.home, away: score.away } }, ts: ts(), seq: seq++ })
      inPlay = false
    }
    if (!plan.length) return { ...score }
    // What the points write with them: the rotation of a side-out (N.1) and
    // a libero's exit at the front row, as the scoring screen writes them
    const all = await db.events.where('matchId').equals(matchId).toArray()
    const rebuilt = recomputeMatch(all, { match, players, matchId })
    for (const row of rebuilt.add) {
      if (row.setIndex !== setIndex || !pointSeqs.has(Math.floor(row.seq || 0))) continue
      const { manual, recomputed, tempKey, stateSnapshot, ...plain } = row // eslint-disable-line no-unused-vars
      await db.events.add({ ...plain, matchId })
    }
    await db.sets.update(setRow.id, { homePoints: score.home, awayPoints: score.away })
    return { ...score }
  })
}

/**
 * Who wins the next demo set so that the match reaches the deciding set
 * (2:2): the team behind in sets (home on a level score). null when no set is
 * left to fill (the deciding set, or a team has won).
 */
export function balancingWinner(sets, match) {
  const finished = (sets || []).filter(s => s.finished)
  const home = finished.filter(s => (s.homePoints || 0) > (s.awayPoints || 0)).length
  const away = finished.filter(s => (s.awayPoints || 0) > (s.homePoints || 0)).length
  const toWin = match?.bestOf === 3 ? 2 : 3
  if (home >= toWin || away >= toWin) return null
  if (home === toWin - 1 && away === toWin - 1) return null
  return away < home ? 'away' : 'home'
}

/** Is the set won on its score (the scoring screen then asks for its end)? */
export function setWonOnScore(set, match, sets) {
  const finished = (sets || []).filter(s => s.finished)
  return getSetResult(set.homePoints || 0, set.awayPoints || 0, set.index, {
    targets: setTargetsOf(match),
    bestOf: match?.bestOf,
    homeSetsWon: finished.filter(s => s.homePoints > s.awayPoints).length,
    awaySetsWon: finished.filter(s => s.awayPoints > s.homePoints).length
  }).isSetWon
}
