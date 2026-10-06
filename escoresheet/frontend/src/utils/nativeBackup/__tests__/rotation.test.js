import { describe, it, expect } from 'vitest'
import {
  eventFileName,
  parseEventFileName,
  isEventFile,
  matchFolderName,
  latestEventSeq,
  planMatchRotation,
  planRotation,
  LATEST_FILE
} from '../rotation'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0, 0)
const fileAt = (ms, seq = 1) => eventFileName(new Date(ms), seq)

describe('event file names', () => {
  it('are UTC, fixed width and sort chronologically', () => {
    expect(eventFileName(new Date(Date.UTC(2026, 9, 6, 9, 5, 7, 42)), 17)).toBe('20261006T090507.042Z-00017.json')
    const names = [fileAt(NOW + 1000, 3), fileAt(NOW, 99), fileAt(NOW - DAY, 120)]
    expect([...names].sort()).toEqual([names[2], names[1], names[0]])
  })

  it('round-trip through the parser', () => {
    const name = eventFileName(new Date(NOW + 123), 4.5)
    expect(parseEventFileName(name)).toEqual({ time: NOW + 123, seq: 4 })
    expect(isEventFile(name)).toBe(true)
    expect(isEventFile(LATEST_FILE)).toBe(false)
    expect(parseEventFileName('backup_g1_set1.json')).toBeNull()
  })

  it('take the highest integer event seq of the backup', () => {
    expect(latestEventSeq({ events: [{ seq: 3 }, { seq: 12.2 }, { seq: 7 }] })).toBe(12)
    expect(latestEventSeq({ events: [] })).toBe(0)
    expect(latestEventSeq(null)).toBe(0)
  })
})

describe('matchFolderName', () => {
  it('uses the game number and the seed, safe for any file system', () => {
    expect(matchFolderName({ gameN: 1234, seed_key: 'abc-DEF_123456789xyz' }, 5)).toBe('game1234-abc-DEF_1234')
    expect(matchFolderName({ game_n: '77', seedKey: 'a/b\\c:d' }, 5)).toBe('game77-a-b-c-d')
    expect(matchFolderName({ gameN: 9 }, 5)).toBe('game9')
    expect(matchFolderName({ seed_key: 'xyz' }, 5)).toBe('match-xyz')
    expect(matchFolderName({}, 5)).toBe('match-5')
    expect(matchFolderName({ gameN: 1, seed_key: 's', test: true }, 5)).toBe('test-game1-s')
  })

  it('never yields path separators or dot segments', () => {
    const name = matchFolderName({ gameN: '../..', seed_key: '../../etc' }, '..')
    expect(name).not.toMatch(/[/\\]|\.\./)
  })
})

describe('planMatchRotation', () => {
  it('keeps every event of the current match up to the cap', () => {
    const names = Array.from({ length: 10 }, (_, i) => fileAt(NOW - i * 1000, i))
    expect(planMatchRotation([...names, LATEST_FILE], { now: NOW, maxPerMatch: 500 })).toEqual([])
  })

  it('drops the oldest event files beyond the cap, never latest.json', () => {
    const names = Array.from({ length: 8 }, (_, i) => fileAt(NOW - (8 - i) * 1000, i))
    const doomed = planMatchRotation([LATEST_FILE, ...names, 'notes.txt'], { now: NOW, maxPerMatch: 5 })
    expect(doomed).toEqual(names.slice(0, 3))
    expect(doomed).not.toContain(LATEST_FILE)
  })

  it('drops event files older than 30 days but keeps latest.json', () => {
    const old = [fileAt(NOW - 40 * DAY, 1), fileAt(NOW - 31 * DAY, 2)]
    const recent = [fileAt(NOW - 29 * DAY, 3)]
    expect(planMatchRotation([...old, ...recent, LATEST_FILE], { now: NOW })).toEqual(old)
  })
})

describe('planRotation', () => {
  it('lists only the folders with something to delete', () => {
    const plan = planRotation([
      { dir: 'game1-a', files: [{ name: fileAt(NOW - 60 * DAY) }, { name: LATEST_FILE }] },
      { dir: 'game2-b', files: [{ name: fileAt(NOW - DAY) }, { name: LATEST_FILE }] },
      { dir: 'game3-c', files: [{ name: LATEST_FILE }] }
    ], { now: NOW })
    expect(plan).toEqual([{ dir: 'game1-a', names: [fileAt(NOW - 60 * DAY)] }])
  })
})
