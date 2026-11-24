// Scoreboard (Home): a plain scoreboard for a friendly, a training game or a
// tournament on the side, where nobody keeps a scoresheet. Two teams, their
// points and the sets they won, nothing else: no rosters, no rotation, no
// rules. A set ends when the operator says so ("Next set"), so 25, 21 or 15
// points all work.
//
// It is no match: nothing goes to the database, the cloud or the relay. The
// board lives in localStorage, so a reload or a closed app keeps the score.
// Every change but the team names and colours can be undone.

import { DEFAULT_AWAY_COLOUR, DEFAULT_HOME_COLOUR, normaliseColour } from '../utils/teamColours'
import { cutText } from '../utils/stringUtils'

export const SIMPLE_BOARD_KEY = 'ov:simpleScoreboard'
// sessionStorage: the board was open, so a reload comes back to it
export const SIMPLE_BOARD_OPEN_KEY = 'ov:simpleScoreboardOpen'

export const TEAMS = ['home', 'away']
export const MAX_POINTS = 99
export const MAX_SETS = 9
export const MAX_NAME = 40
// Undo steps kept (a long evening of points stays well under it)
export const MAX_UNDO = 300

const other = (team) => (team === 'home' ? 'away' : 'home')
const isTeam = (v) => v === 'home' || v === 'away'
const count = (v, max) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0
}

/** A new board: 0:0, no sets, home on the left. Keeps the given teams. */
export function initialBoard(teams = null) {
  return {
    v: 1,
    teams: {
      home: cleanTeam(teams?.home, DEFAULT_HOME_COLOUR),
      away: cleanTeam(teams?.away, DEFAULT_AWAY_COLOUR)
    },
    points: { home: 0, away: 0 },
    // the finished sets, in order: { home, away } points each
    sets: [],
    // the team on the left half of the screen
    left: 'home',
    // the team that won the last rally (it serves next), null at a set's start
    serving: null,
    // the earlier states (points, sets, left, serving), newest last
    history: []
  }
}

function cleanTeam(team, fallbackColour) {
  return {
    name: cutText(String(team?.name ?? '').trim(), MAX_NAME),
    color: normaliseColour(team?.color) || fallbackColour
  }
}

const snapshot = (b) => ({ points: { ...b.points }, sets: b.sets.map(s => ({ ...s })), left: b.left, serving: b.serving })

function withStep(board, change) {
  const history = [...board.history, snapshot(board)]
  return { ...board, ...change, history: history.length > MAX_UNDO ? history.slice(-MAX_UNDO) : history }
}

/** A point for the team; it serves next */
export function addPoint(board, team) {
  if (!isTeam(team) || board.points[team] >= MAX_POINTS) return board
  return withStep(board, { points: { ...board.points, [team]: board.points[team] + 1 }, serving: team })
}

/** One point off the team (a point counted by mistake, seen later) */
export function removePoint(board, team) {
  if (!isTeam(team) || board.points[team] <= 0) return board
  return withStep(board, { points: { ...board.points, [team]: board.points[team] - 1 } })
}

/** The set can end when one team leads */
export function canFinishSet(board) {
  return board.points.home !== board.points.away && board.sets.length < MAX_SETS
}

/** Ends the set: the team ahead wins it, the next set starts at 0:0 */
export function finishSet(board) {
  if (!canFinishSet(board)) return board
  return withStep(board, {
    sets: [...board.sets, { ...board.points }],
    points: { home: 0, away: 0 },
    serving: null
  })
}

/** The teams change sides */
export function swapSides(board) {
  return withStep(board, { left: other(board.left) })
}

export function canUndo(board) {
  return board.history.length > 0
}

/** Back one step: a point, a point off, a set end or a change of sides */
export function undo(board) {
  if (!canUndo(board)) return board
  const prev = board.history[board.history.length - 1]
  return { ...board, ...prev, history: board.history.slice(0, -1) }
}

/** The teams' names and colours (not an undo step) */
export function setTeams(board, teams) {
  return {
    ...board,
    teams: {
      home: cleanTeam(teams?.home, board.teams.home.color),
      away: cleanTeam(teams?.away, board.teams.away.color)
    }
  }
}

/** A new game: 0:0 and no sets, the same teams */
export function resetBoard(board) {
  return initialBoard(board.teams)
}

/** Sets won per team */
export function setsWon(board) {
  const won = { home: 0, away: 0 }
  for (const s of board.sets) {
    if (s.home > s.away) won.home++
    else if (s.away > s.home) won.away++
  }
  return won
}

/** The set being played, from 1 */
export function currentSet(board) {
  return board.sets.length + 1
}

/** Has anything happened on the board (worth a confirmation before a reset)? */
export function hasScore(board) {
  return board.sets.length > 0 || board.points.home > 0 || board.points.away > 0
}

/** The left and right teams */
export function sides(board) {
  return { left: board.left, right: other(board.left) }
}

/** A stored board, checked field by field; a new one when there is none */
export function parseBoard(raw) {
  let data = raw
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw) } catch { data = null }
  }
  if (!data || typeof data !== 'object' || data.v !== 1) return initialBoard()
  const base = initialBoard(data.teams)
  const state = (s) => ({
    points: { home: count(s?.points?.home, MAX_POINTS), away: count(s?.points?.away, MAX_POINTS) },
    sets: (Array.isArray(s?.sets) ? s.sets : []).slice(0, MAX_SETS).map(x => ({ home: count(x?.home, MAX_POINTS), away: count(x?.away, MAX_POINTS) })),
    left: isTeam(s?.left) ? s.left : 'home',
    serving: isTeam(s?.serving) ? s.serving : null
  })
  return {
    ...base,
    ...state(data),
    history: (Array.isArray(data.history) ? data.history : []).slice(-MAX_UNDO).map(state)
  }
}

/** The stored board (a new one when there is none or it is unreadable) */
export function loadBoard(storage = globalThis.localStorage) {
  try {
    return parseBoard(storage?.getItem(SIMPLE_BOARD_KEY) ?? null)
  } catch {
    return initialBoard()
  }
}

export function saveBoard(board, storage = globalThis.localStorage) {
  try {
    storage?.setItem(SIMPLE_BOARD_KEY, JSON.stringify(board))
    return true
  } catch {
    return false
  }
}
