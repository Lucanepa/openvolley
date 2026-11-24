import { describe, it, expect } from 'vitest'
import {
  initialBoard, addPoint, removePoint, finishSet, canFinishSet, swapSides, undo, canUndo,
  setTeams, resetBoard, setsWon, currentSet, hasScore, sides, parseBoard, loadBoard, saveBoard,
  SIMPLE_BOARD_KEY, MAX_POINTS, MAX_SETS, MAX_UNDO, MAX_NAME
} from '../simpleScoreboard'
import { DEFAULT_AWAY_COLOUR, DEFAULT_HOME_COLOUR } from '../../utils/teamColours'

const play = (board, ...steps) => steps.reduce((b, step) => step(b), board)
const H = (b) => addPoint(b, 'home')
const A = (b) => addPoint(b, 'away')
const times = (n, step) => Array.from({ length: n }, () => step)

const memoryStorage = () => {
  const data = new Map()
  return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), data }
}

describe('simple scoreboard', () => {
  it('starts at 0:0 with no sets, home on the left, in the default colours', () => {
    const b = initialBoard()
    expect(b.points).toEqual({ home: 0, away: 0 })
    expect(b.sets).toEqual([])
    expect(sides(b)).toEqual({ left: 'home', right: 'away' })
    expect(b.teams.home.color).toBe(DEFAULT_HOME_COLOUR)
    expect(b.teams.away.color).toBe(DEFAULT_AWAY_COLOUR)
    expect(b.serving).toBeNull()
    expect(canUndo(b)).toBe(false)
    expect(hasScore(b)).toBe(false)
    expect(currentSet(b)).toBe(1)
  })

  it('counts points; the team that scored serves', () => {
    const b = play(initialBoard(), H, H, A)
    expect(b.points).toEqual({ home: 2, away: 1 })
    expect(b.serving).toBe('away')
    expect(hasScore(b)).toBe(true)
  })

  it('takes a point off, never below 0, and keeps who serves', () => {
    let b = play(initialBoard(), H, A)
    b = removePoint(b, 'home')
    expect(b.points).toEqual({ home: 0, away: 1 })
    expect(b.serving).toBe('away')
    expect(removePoint(b, 'home')).toBe(b)
  })

  it('stops at 99 points', () => {
    const b = play(initialBoard(), ...times(MAX_POINTS, H))
    expect(b.points.home).toBe(MAX_POINTS)
    expect(addPoint(b, 'home')).toBe(b)
  })

  it('ignores a team that is not home or away', () => {
    const b = initialBoard()
    expect(addPoint(b, 'left')).toBe(b)
    expect(removePoint(b, undefined)).toBe(b)
  })

  it('ends a set when one team leads: the leader wins it, 0:0 again', () => {
    let b = play(initialBoard(), ...times(25, H), ...times(23, A))
    expect(canFinishSet(b)).toBe(true)
    b = finishSet(b)
    expect(b.sets).toEqual([{ home: 25, away: 23 }])
    expect(b.points).toEqual({ home: 0, away: 0 })
    expect(b.serving).toBeNull()
    expect(currentSet(b)).toBe(2)
    b = finishSet(play(b, ...times(15, A), ...times(21, H).slice(0, 10)))
    expect(b.sets[1]).toEqual({ home: 10, away: 15 })
    expect(setsWon(b)).toEqual({ home: 1, away: 1 })
  })

  it('does not end a tied set', () => {
    const b = play(initialBoard(), H, A)
    expect(canFinishSet(b)).toBe(false)
    expect(finishSet(b)).toBe(b)
    expect(canFinishSet(initialBoard())).toBe(false)
  })

  it(`stops at ${MAX_SETS} sets`, () => {
    let b = initialBoard()
    for (let i = 0; i < MAX_SETS; i++) b = finishSet(H(b))
    expect(b.sets).toHaveLength(MAX_SETS)
    expect(canFinishSet(H(b))).toBe(false)
  })

  it('swaps the sides', () => {
    const b = swapSides(initialBoard())
    expect(sides(b)).toEqual({ left: 'away', right: 'home' })
    expect(sides(swapSides(b))).toEqual({ left: 'home', right: 'away' })
  })

  it('undoes points, points off, set ends and side changes, newest first', () => {
    const start = initialBoard()
    const steps = [H, A, (b) => removePoint(b, 'away'), H, finishSet, swapSides, A]
    const states = [start]
    for (const step of steps) states.push(step(states[states.length - 1]))
    let b = states[states.length - 1]
    for (let i = states.length - 2; i >= 0; i--) {
      b = undo(b)
      const { history: _h, ...now } = b
      const { history: _e, ...expected } = states[i]
      expect(now).toEqual(expected)
    }
    expect(canUndo(b)).toBe(false)
    expect(undo(b)).toBe(b)
  })

  it(`keeps the last ${MAX_UNDO} undo steps`, () => {
    let b = initialBoard()
    for (let i = 0; i < MAX_UNDO + 20; i++) b = i % 2 ? removePoint(b, 'home') : H(b)
    expect(b.history).toHaveLength(MAX_UNDO)
  })

  it('names the teams and picks their colours, without an undo step', () => {
    let b = H(initialBoard())
    b = setTeams(b, { home: { name: '  Musterdorf  ', color: '#FACC15' }, away: { name: 'x'.repeat(80), color: 'not a colour' } })
    expect(b.teams.home).toEqual({ name: 'Musterdorf', color: '#facc15' })
    expect(b.teams.away.name).toHaveLength(MAX_NAME)
    expect(b.teams.away.color).toBe(DEFAULT_AWAY_COLOUR) // kept
    expect(b.history).toHaveLength(1)
    expect(b.points.home).toBe(1)
  })

  it('a reset keeps the teams and clears the score, the sets and the undo steps', () => {
    let b = setTeams(initialBoard(), { home: { name: 'A', color: '#000000' }, away: { name: 'B', color: '#ffffff' } })
    b = resetBoard(swapSides(finishSet(play(b, H, H))))
    expect(b.teams.home).toEqual({ name: 'A', color: '#000000' })
    expect(b.teams.away).toEqual({ name: 'B', color: '#ffffff' })
    expect(b.points).toEqual({ home: 0, away: 0 })
    expect(b.sets).toEqual([])
    expect(b.left).toBe('home')
    expect(canUndo(b)).toBe(false)
  })

  it('is stored and read back, undo steps included', () => {
    const storage = memoryStorage()
    const b = finishSet(play(setTeams(initialBoard(), { home: { name: 'A' }, away: { name: 'B' } }), H, A, H))
    expect(saveBoard(b, storage)).toBe(true)
    const back = loadBoard(storage)
    expect(back).toEqual(b)
    expect(undo(back).points).toEqual({ home: 2, away: 1 })
  })

  it('reads a missing, broken or foreign value as a new board', () => {
    expect(loadBoard(memoryStorage())).toEqual(initialBoard())
    const storage = memoryStorage()
    storage.setItem(SIMPLE_BOARD_KEY, '{not json')
    expect(loadBoard(storage)).toEqual(initialBoard())
    expect(parseBoard({ v: 2, points: { home: 5 } })).toEqual(initialBoard())
    expect(loadBoard({ getItem: () => { throw new Error('blocked') } })).toEqual(initialBoard())
  })

  it('checks every stored field', () => {
    const b = parseBoard({
      v: 1,
      teams: { home: { name: 7, color: 'red' }, away: null },
      points: { home: -3, away: 1000 },
      sets: [{ home: '25', away: 'x' }, null],
      left: 'middle',
      serving: 'nobody',
      history: 'no'
    })
    expect(b.teams.home).toEqual({ name: '7', color: '#ff0000' })
    expect(b.teams.away.color).toBe(DEFAULT_AWAY_COLOUR)
    expect(b.points).toEqual({ home: 0, away: MAX_POINTS })
    expect(b.sets).toEqual([{ home: 25, away: 0 }, { home: 0, away: 0 }])
    expect(b.left).toBe('home')
    expect(b.serving).toBeNull()
    expect(b.history).toEqual([])
  })

  it('a full storage does not throw', () => {
    expect(saveBoard(initialBoard(), { setItem: () => { throw new Error('QuotaExceededError') } })).toBe(false)
  })
})
