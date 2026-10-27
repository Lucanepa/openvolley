import { describe, it, expect } from 'vitest'
import { deviceMatchRows, duplicateGameNumbers, isOpenOfficialMatch, jobsOfMatch, matchGameNumber } from '../deviceMatches'

const confirmed = '2026-10-01T10:00:00.000Z'

describe('deviceMatchRows', () => {
  // The phone of 2026-10-19: a restored match of game 402397 (7.10) and a
  // new one of the same game (10.10), plus a test match and a draft
  const matches = [
    { id: 2, status: 'ended', game_n: 402397, createdAt: '2026-10-07T13:38:55.083Z', matchInfoConfirmedAt: confirmed, homeTeamId: 21, awayTeamId: 22 },
    { id: 1, status: 'scheduled', gameNumber: '402397', createdAt: '2026-10-10T19:31:56.821Z', matchInfoConfirmedAt: confirmed, cloudBlock: { code: 'OV_GAME_TAKEN' } },
    { id: 3, status: 'live', test: true, createdAt: '2026-10-19T21:00:00.000Z', matchInfoConfirmedAt: confirmed },
    { id: 4, status: 'scheduled', createdAt: '2026-10-19T21:31:58.368Z' },
    { id: 5, status: 'final', createdAt: '2026-09-01T10:00:00.000Z', matchInfoConfirmedAt: confirmed }
  ]

  it('lists the open official matches, newest first, with their teams', () => {
    const rows = deviceMatchRows(matches, new Map([[21, 'VBC Muster'], [22, 'TV Beispiel']]))
    expect(rows.map(r => r.id)).toEqual([1, 2])
    expect(rows[1]).toMatchObject({ home: 'VBC Muster', away: 'TV Beispiel', gameN: '402397', status: 'ended', cloudBlock: null })
    expect(rows[0]).toMatchObject({ home: null, away: null, gameN: '402397', cloudBlock: { code: 'OV_GAME_TAKEN' } })
  })

  it('flags a game number that is on the device twice', () => {
    expect([...duplicateGameNumbers(deviceMatchRows(matches))]).toEqual(['402397'])
    expect(duplicateGameNumbers([{ gameN: '1' }, { gameN: '2' }, { gameN: null }, { gameN: null }]).size).toBe(0)
  })

  // The self-check on open flagged two copies of one official match that
  // each hold something (utils/deviceSelfCheck): both are listed as copies,
  // also one restored without matchInfoConfirmedAt
  it('lists and marks the copies the self-check flagged', () => {
    const copies = [
      { id: 7, status: 'live', seed_key: 'match_1_a', createdAt: '2026-10-20T10:00:00.000Z', matchInfoConfirmedAt: confirmed },
      { id: 8, status: 'live', seed_key: 'match_1_a', createdAt: '2026-10-21T10:00:00.000Z' },
      { id: 9, status: 'final', seed_key: 'match_1_a', createdAt: '2026-10-21T10:00:00.000Z' }
    ]
    expect(deviceMatchRows(copies).map(r => r.id)).toEqual([7])
    const rows = deviceMatchRows(copies, new Map(), { duplicateIds: [7, 8, 9] })
    expect(rows.map(r => [r.id, r.duplicate])).toEqual([[8, true], [7, true]])
    expect(deviceMatchRows(matches).every(r => r.duplicate === false)).toBe(true)
  })

  it('reads the game number from any of its fields', () => {
    expect(matchGameNumber({ gameN: 7 })).toBe('7')
    expect(matchGameNumber({ game_n: 8 })).toBe('8')
    expect(matchGameNumber({ gameNumber: '9' })).toBe('9')
    expect(matchGameNumber({ gameNumber: '' })).toBeNull()
    expect(matchGameNumber({})).toBeNull()
  })

  it('an unconfirmed draft, a test match and a final match are not open official matches', () => {
    expect(isOpenOfficialMatch(matches[2])).toBe(false)
    expect(isOpenOfficialMatch(matches[3])).toBe(false)
    expect(isOpenOfficialMatch(matches[4])).toBe(false)
    expect(isOpenOfficialMatch(matches[0])).toBe(true)
  })
})

describe('jobsOfMatch', () => {
  const jobs = [
    { id: 1, resource: 'match', action: 'insert', payload: { external_id: 'match_1_a' } },
    { id: 2, resource: 'event', action: 'insert', payload: { external_id: 'match_1_a:e:5', match_id: 'match_1_a' } },
    { id: 3, resource: 'match', action: 'delete', payload: { id: 'match_2_b' } },
    { id: 4, resource: 'match', action: 'restore', payload: { match: { external_id: 'match_1_a' } } },
    { id: 5, resource: 'set', action: 'insert', payload: { external_id: 'match_2_b:s:1', match_id: 'match_2_b' } }
  ]

  it("takes one match's jobs and leaves the other match's", () => {
    expect(jobsOfMatch(jobs, 'match_1_a').map(j => j.id)).toEqual([1, 2, 4])
    expect(jobsOfMatch(jobs, 'match_2_b').map(j => j.id)).toEqual([3, 5])
  })

  it('a match without a seed key has no jobs', () => {
    expect(jobsOfMatch(jobs, null)).toEqual([])
  })
})
