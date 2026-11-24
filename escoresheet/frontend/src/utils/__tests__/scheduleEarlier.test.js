import { describe, it, expect } from 'vitest'
import { gameStartMs, splitEarlierGames } from '../scheduleEarlier'

const at = (iso) => new Date(iso).getTime()

describe('gameStartMs', () => {
  it('reads a zone-less schedule time on the Zürich clock, winter and summer', () => {
    // 15.11.2026 09:00 in Zürich is 08:00Z (UTC+1)
    expect(gameStartMs({ dtstart: '2026-11-15T09:00:00' })).toBe(at('2026-11-15T08:00:00Z'))
    // 29.03.2026 10:00, the day summer time starts: 08:00Z (UTC+2)
    expect(gameStartMs({ dtstart: '2026-03-29T10:00' })).toBe(at('2026-03-29T08:00:00Z'))
    // 25.10.2026 10:00, the day winter time comes back: 09:00Z
    expect(gameStartMs({ dtstart: '2026-10-25 10:00:00' })).toBe(at('2026-10-25T09:00:00Z'))
  })

  it('an instant stays that instant', () => {
    expect(gameStartMs({ dtstart: '2026-11-15T08:00:00.000Z' })).toBe(at('2026-11-15T08:00:00Z'))
    expect(gameStartMs({ datetime: '2026-10-17T11:30:00.000000+00:00' })).toBe(at('2026-10-17T11:30:00Z'))
  })

  it('a date DD/MM/YYYY with a time HH:MM, in Zürich', () => {
    expect(gameStartMs({ date: '15/11/2026', time: '09:00' })).toBe(at('2026-11-15T08:00:00Z'))
    expect(gameStartMs({ date: '29.03.2026', time: '10:00' })).toBe(at('2026-03-29T08:00:00Z'))
  })

  it('no time, no start', () => {
    expect(gameStartMs({ dtstart: '2026-11-15' })).toBeNull()
    expect(gameStartMs({ date: '15/11/2026' })).toBeNull()
    expect(gameStartMs({ date: '15/11/2026', time: '' })).toBeNull()
    expect(gameStartMs({ dtstart: 'soon' })).toBeNull()
    expect(gameStartMs({})).toBeNull()
    expect(gameStartMs(null)).toBeNull()
  })
})

describe('splitEarlierGames', () => {
  // 15.11.2026 12:30 in Zürich
  const now = at('2026-11-15T11:30:00Z')

  it('games that started before now are earlier; the rest stay upcoming, in their order', () => {
    const games = [
      { gameN: 'past', dtstart: '2026-11-14T20:00:00' },
      { gameN: 'this morning', dtstart: '2026-11-15T09:00:00' },
      { gameN: 'now', dtstart: '2026-11-15T12:30:00' },
      { gameN: 'this evening', dtstart: '2026-11-15T19:30:00' },
      { gameN: 'tomorrow', dtstart: '2026-11-16T09:00:00' }
    ]
    const { upcoming, earlier } = splitEarlierGames(games, now)
    expect(earlier.map(g => g.gameN)).toEqual(['past', 'this morning'])
    // a game starting this very minute is still to come
    expect(upcoming.map(g => g.gameN)).toEqual(['now', 'this evening', 'tomorrow'])
  })

  it('today before and after now, by the Zürich clock, not by UTC', () => {
    // 12:00 Zürich = 11:00Z: earlier at 11:30Z; read as UTC (12:00Z) it would be upcoming
    const { earlier } = splitEarlierGames([{ dtstart: '2026-11-15T12:00' }], now)
    expect(earlier).toHaveLength(1)
    // 12:45 Zürich = 11:45Z: still to come
    expect(splitEarlierGames([{ dtstart: '2026-11-15T12:45' }], now).upcoming).toHaveLength(1)
  })

  it('across the summer-time change', () => {
    // 29.03.2026 10:00 Zürich = 08:00Z (summer time)
    const game = { dtstart: '2026-03-29T10:00' }
    expect(splitEarlierGames([game], at('2026-03-29T08:30:00Z')).earlier).toEqual([game])
    expect(splitEarlierGames([game], at('2026-03-29T07:30:00Z')).upcoming).toEqual([game])
  })

  it('a game without a time is upcoming', () => {
    const games = [{ dtstart: '2026-11-10' }, { date: '10/11/2026' }, {}]
    expect(splitEarlierGames(games, now)).toEqual({ upcoming: games, earlier: [] })
  })

  it('takes a Date as now, and no games', () => {
    expect(splitEarlierGames([{ dtstart: '2026-11-15T09:00' }], new Date(now)).earlier).toHaveLength(1)
    expect(splitEarlierGames(undefined, now)).toEqual({ upcoming: [], earlier: [] })
  })
})
