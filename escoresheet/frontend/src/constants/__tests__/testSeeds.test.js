import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TEST_MATCH_SEED_KEY, newTestMatchSeedKey, isTestMatchSeedKey, testMatchSeedKeyFor, getTestHomeTeamShortName, getTestAwayTeamShortName, getTestTeamByExternalId, TEST_HOME_TEAM_EXTERNAL_ID, TEST_AWAY_TEAM_EXTERNAL_ID } from '../testSeeds'
import { relayMatchKey } from '../../utils/serverDataSync'

// A test (rehearsal) match publishes its live state to the venue relay and
// shows in its match list: its seed key is its relay room, so two scorers
// rehearsing on one relay need two keys.
describe('test match seed key', () => {
  const DEVICE_KEY = `${TEST_MATCH_SEED_KEY}-${'0a1b2c'.repeat(2)}`
  it('is per device: test-match-default-<random>', () => {
    const a = newTestMatchSeedKey()
    const b = newTestMatchSeedKey()
    expect(a).toMatch(/^test-match-default-[0-9a-f]{12}$/)
    expect(a).not.toBe(b)
    expect(relayMatchKey({ id: 1, seedKey: a })).toBe(a)
  })

  it('tells a test match key from any other', () => {
    for (const k of [TEST_MATCH_SEED_KEY, DEVICE_KEY]) expect(isTestMatchSeedKey(k)).toBe(true)
    for (const k of ['match_1791223004296_b2mej1', 'test-team-alpha', 'test-match-defaultx', '', null, undefined]) expect(isTestMatchSeedKey(k)).toBe(false)
  })

  it('a device keeps its own key across restarts; the shared legacy key (or none) gets a new one', () => {
    expect(testMatchSeedKeyFor(DEVICE_KEY)).toBe(DEVICE_KEY)
    for (const k of [TEST_MATCH_SEED_KEY, undefined, null, 'match_1']) {
      const next = testMatchSeedKeyFor(k)
      expect(next).not.toBe(TEST_MATCH_SEED_KEY)
      expect(isTestMatchSeedKey(next)).toBe(true)
    }
  })

  it('App.jsx no longer gives every test match the shared key', () => {
    const app = readFileSync(resolve(__dirname, '../../App.jsx'), 'utf8')
    expect(app).not.toMatch(/seedKey: TEST_MATCH_SEED_KEY/)
    expect(app).toMatch(/const testSeedKey = testMatchSeedKeyFor\(existingMatch\?\.seedKey\)/)
    expect(app).toMatch(/seedKey: testSeedKey,/)
  })
})

// The server test match names its teams by these external ids: they must find
// the seed teams, or the sheet and the PDF's file name said HOME / AWAY.
describe('test team seeds', () => {
  it('the external ids find the seed teams and their short names', () => {
    expect(getTestHomeTeamShortName()).not.toBe('HOME')
    expect(getTestAwayTeamShortName()).not.toBe('AWAY')
    expect(getTestTeamByExternalId(TEST_HOME_TEAM_EXTERNAL_ID)?.players.length).toBeGreaterThan(6)
    expect(getTestTeamByExternalId(TEST_AWAY_TEAM_EXTERNAL_ID)?.players.length).toBeGreaterThan(6)
    expect(getTestTeamByExternalId('test-team-home')).toBe(getTestTeamByExternalId(TEST_HOME_TEAM_EXTERNAL_ID))
  })
})
