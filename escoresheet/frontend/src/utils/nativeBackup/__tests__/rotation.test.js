import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateMatchSeedKey } from '../../serverDataSync'
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
    expect(matchFolderName({ gameN: 1234, seed_key: 'abc-DEF_123456789xyz' }, 5)).toBe('game1234-abc-DEF_123456789xyz')
    expect(matchFolderName({ game_n: '77', seedKey: 'a/b\\c:d' }, 5)).toBe('game77-a-b-c-d')
    expect(matchFolderName({ gameN: 9 }, 5)).toBe('game9-local5') // no seed: the local id keeps matches apart
    expect(matchFolderName({ gameN: 9 })).toBe('game9')
    expect(matchFolderName({ seed_key: 'xyz' }, 5)).toBe('match-xyz')
    expect(matchFolderName({}, 5)).toBe('match-5')
    expect(matchFolderName({ gameN: 1, seed_key: 's', test: true }, 5)).toBe('test-game1-s')
  })

  describe('with real seeds', () => {
    afterEach(() => vi.useRealTimers())

    it('keeps the whole seed, so two matches with the same number a few seconds apart never share a folder', () => {
      vi.useFakeTimers({ now: Date.UTC(2026, 9, 6, 10, 0, 0) })
      const first = generateMatchSeedKey()
      vi.advanceTimersByTime(4000)
      const second = generateMatchSeedKey()
      expect(first).toMatch(/^match_\d{13}_[a-z0-9]+$/)
      const a = matchFolderName({ gameN: 1, seed_key: first }, 1)
      const b = matchFolderName({ gameN: 1, seed_key: second }, 1)
      expect(a).toBe(`game1-${first}`)
      expect(a).not.toBe(b)
    })

    it('tells apart two seeds of the same millisecond by their random part', () => {
      expect(matchFolderName({ gameN: 1, seed_key: 'match_1759740000000_ab12cd' }))
        .not.toBe(matchFolderName({ gameN: 1, seed_key: 'match_1759740000000_zz99yy' }))
    })

    it('stays within the 100-character folder names the desktop app accepts', () => {
      const name = matchFolderName({ gameN: '123456789012345', seed_key: 'x'.repeat(300), test: true }, 3)
      expect(name.length).toBeLessThanOrEqual(100)
      expect(name).toMatch(/^[A-Za-z0-9_-]+$/)
    })
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

describe('planMatchRotation keeps the newest state', () => {
  it('always keeps the newest event file, however old (latest.json may be stale)', () => {
    const old = [fileAt(NOW - 50 * DAY, 1), fileAt(NOW - 45 * DAY, 2), fileAt(NOW - 40 * DAY, 3)]
    expect(planMatchRotation([...old, LATEST_FILE], { now: NOW })).toEqual(old.slice(0, 2))
    expect(planMatchRotation([old[0]], { now: NOW })).toEqual([])
  })

  it('keeps the newest files within the byte budget, dropping everything older', () => {
    const files = [
      { name: fileAt(NOW - 4000, 1), size: 100 },
      { name: fileAt(NOW - 3000, 2), size: 200 },
      { name: fileAt(NOW - 2000, 3), size: 300 },
      { name: fileAt(NOW - 1000, 4), size: 400 }
    ]
    // 400 + 300 = 700 fit; 200 more would not; the small oldest one goes too
    expect(planMatchRotation(files, { now: NOW, maxBytesPerMatch: 750 })).toEqual([files[0].name, files[1].name])
    // the newest file is kept even when it alone exceeds the budget
    expect(planMatchRotation(files, { now: NOW, maxBytesPerMatch: 10 })).toEqual(files.slice(0, 3).map(f => f.name))
  })

  it('thins a folder nobody wrote to for a while (a finished match) to its newest files', () => {
    const names = Array.from({ length: 30 }, (_, i) => fileAt(NOW - 2 * DAY + i * 1000, i))
    expect(planMatchRotation(names, { now: NOW, idleKeep: 10, idleAfterHours: 12 })).toEqual(names.slice(0, 20))
    // the match being scored is not thinned
    expect(planMatchRotation(names, { now: NOW - 2 * DAY + 31 * 1000, idleKeep: 10, idleAfterHours: 12 })).toEqual([])
  })
})

describe('planRotation', () => {
  it('lists only the folders with something to delete', () => {
    const plan = planRotation([
      { dir: 'game1-a', files: [{ name: fileAt(NOW - 60 * DAY) }, { name: fileAt(NOW - 59 * DAY, 2) }, { name: LATEST_FILE }] },
      { dir: 'game2-b', files: [{ name: fileAt(NOW - DAY) }, { name: LATEST_FILE }] },
      { dir: 'game3-c', files: [{ name: LATEST_FILE }] }
    ], { now: NOW })
    expect(plan).toEqual([{ dir: 'game1-a', names: [fileAt(NOW - 60 * DAY)] }])
  })
})
