// The seeded test roster of a test match (domain/testRoster): what goes when
// the test match gets other teams, and what of the scorer's stays.
import { describe, it, expect } from 'vitest'
import { TEST_TEAM_SEED_DATA, TEST_HOME_BENCH, TEST_AWAY_BENCH } from '../../constants/testSeeds'
import { isSeedTestPlayer, isSeedTestOfficial, isSeedTestTeam, withoutSeedTestRoster, EMPTY_BENCH } from '../testRoster'

const [HOME, AWAY] = TEST_TEAM_SEED_DATA

describe('isSeedTestPlayer', () => {
  it('knows every seeded player of both test teams, as the form and the stored rows hold them', () => {
    for (const p of [...HOME.players, ...AWAY.players]) expect(isSeedTestPlayer(p)).toBe(true)
    // a stored row: number as stored, an id, captain and libero changed by the scorer
    expect(isSeedTestPlayer({ id: 7, number: 1, lastName: 'Keller', firstName: 'Luca', dob: '100211', isCaptain: false, libero: 'libero1' })).toBe(true)
    // the same name typed with other spaces or case
    expect(isSeedTestPlayer({ number: '12', lastName: ' huber ', firstName: 'MAURO', dob: '100729' })).toBe(true)
  })

  it('takes a player the scorer added or edited as the scorer\'s own', () => {
    expect(isSeedTestPlayer({ number: 99, lastName: 'Eigen', firstName: 'Mia', dob: '' })).toBe(false)
    // a seeded player renumbered, renamed or given a licence of the real team
    expect(isSeedTestPlayer({ number: 5, lastName: 'Keller', firstName: 'Luca', dob: '100211' })).toBe(false)
    expect(isSeedTestPlayer({ number: 1, lastName: 'Keller', firstName: 'Lucas', dob: '100211' })).toBe(false)
    expect(isSeedTestPlayer({ number: 1, lastName: 'Keller', firstName: 'Luca', dob: '123456' })).toBe(false)
    expect(isSeedTestPlayer(null)).toBe(false)
  })
})

describe('isSeedTestOfficial', () => {
  it('knows the seeded bench officials, whatever their role now', () => {
    for (const m of [...TEST_HOME_BENCH, ...TEST_AWAY_BENCH]) expect(isSeedTestOfficial(m)).toBe(true)
    expect(isSeedTestOfficial({ role: 'Assistant Coach 1', firstName: 'Marco', lastName: 'Frei', dob: '100137' })).toBe(true)
    expect(isSeedTestOfficial({ role: 'Coach', firstName: 'Anna', lastName: 'Trainer', dob: '' })).toBe(false)
    expect(isSeedTestOfficial({ role: 'Coach', firstName: '', lastName: '', dob: '' })).toBe(false)
  })
})

describe('isSeedTestTeam', () => {
  it('is one of the two shared seed teams, found by seed key', () => {
    expect(isSeedTestTeam({ seedKey: 'test-team-home' })).toBe(true)
    expect(isSeedTestTeam({ seedKey: 'test-team-away' })).toBe(true)
    expect(isSeedTestTeam({ seedKey: 'test-match-team' })).toBe(false)
    expect(isSeedTestTeam({ name: 'VBC Musterau' })).toBe(false)
    expect(isSeedTestTeam(null)).toBe(false)
  })
})

describe('withoutSeedTestRoster', () => {
  it('drops the seeded players and officials, keeps the scorer\'s own, and counts what went', () => {
    const own = { number: 99, lastName: 'Eigen', firstName: 'Mia', dob: '', libero: '', isCaptain: true }
    const ownCoach = { role: 'Coach', firstName: 'Anna', lastName: 'Trainer', dob: '' }
    const out = withoutSeedTestRoster([...HOME.players, own], [...TEST_HOME_BENCH, ownCoach])
    expect(out.roster).toEqual([own])
    expect(out.bench).toEqual([ownCoach])
    expect(out.removed).toBe(HOME.players.length + TEST_HOME_BENCH.length)
  })

  it('leaves one empty coach row when no official is left, as Delete roster does', () => {
    const out = withoutSeedTestRoster(AWAY.players, TEST_AWAY_BENCH)
    expect(out.roster).toEqual([])
    expect(out.bench).toEqual([{ role: 'Coach', firstName: '', lastName: '', dob: '' }])
    expect(out.bench[0]).not.toBe(EMPTY_BENCH[0])
  })

  it('changes nothing in a roster without seeded people', () => {
    const roster = [{ number: 4, lastName: 'Real', firstName: 'Player', dob: '654321' }]
    const bench = [{ role: 'Coach', firstName: 'Real', lastName: 'Coach', dob: '' }]
    expect(withoutSeedTestRoster(roster, bench)).toEqual({ roster, bench, removed: 0 })
  })
})
