import { zonedParts, zurichWallTimeMs } from '../ui/format'

// Test Match Constants
export const TEST_MATCH_SEED_KEY = 'test-match-default'

/**
 * A test (rehearsal) match's own seed key, which is also its relay room:
 * `test-match-default-<random>`. Rehearsals publish their live state to the
 * venue relay and show in its match list, so two scorers rehearsing on one
 * relay must not share a room (the second got not-match-owner, or the LedBox
 * mixed their live states).
 */
export function newTestMatchSeedKey() {
  let suffix = ''
  try {
    const bytes = new Uint8Array(6)
    globalThis.crypto.getRandomValues(bytes)
    suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    suffix = Math.random().toString(16).slice(2, 14).padEnd(12, '0')
  }
  return `${TEST_MATCH_SEED_KEY}-${suffix}`
}

/** The seed key of a test match: the shared legacy one or a per-device one. */
export function isTestMatchSeedKey(key) {
  return typeof key === 'string' && (key === TEST_MATCH_SEED_KEY || key.startsWith(`${TEST_MATCH_SEED_KEY}-`))
}

/**
 * The seed key a device's test match keeps: its own per-device key (the
 * LedBox keeps following the same room when the rehearsal is restarted), or a
 * new one in place of the shared legacy key or none.
 */
export function testMatchSeedKeyFor(existing) {
  return isTestMatchSeedKey(existing) && existing !== TEST_MATCH_SEED_KEY ? existing : newTestMatchSeedKey()
}
export const TEST_MATCH_EXTERNAL_ID = 'test-match-default'
export const TEST_HOME_TEAM_EXTERNAL_ID = 'test-team-alpha'
export const TEST_AWAY_TEAM_EXTERNAL_ID = 'test-team-bravo'

export const TEST_MATCH_DEFAULTS = {
  hall: 'Sporthalle Musterdorf (Halle A)',
  city: 'Zürich',
  league: '3L B',
  gameNumber: '123456',
  bestOf: 5
}

export const TEST_HOME_BENCH = [
  { role: 'Coach', firstName: 'Marco', lastName: 'Frei', dob: '100137' },
  { role: 'Assistant Coach 1', firstName: 'Jan', lastName: 'Widmer', dob: '100174' },
  { role: 'Assistant Coach 2', firstName: 'Luca', lastName: 'Keller', dob: '100211' },
  { role: 'Physiotherapist', firstName: 'Eva', lastName: 'Gerber', dob: '100248' },
  { role: 'Medic', firstName: 'Luca', lastName: 'Keller', dob: '100211' }
]

export const TEST_AWAY_BENCH = [
  { role: 'Coach', firstName: 'Stefan', lastName: 'Keller', dob: '100285' },
  { role: 'Assistant Coach 1', firstName: 'Lars', lastName: 'Brunner', dob: '100322' },
  { role: 'Physiotherapist', firstName: 'Mia', lastName: 'Schmid', dob: '100359' }
]

/**
 * A test match's kickoff: the next 20:00 on the hall's clock (the match's
 * zone, else Europe/Zurich), whatever zone the device is in. The device's
 * setHours(20) made it 21:00 Zürich on a board left on Europe/London
 * (owner 2026-11-17).
 */
export function getNextTestMatchStartTime(now = new Date()) {
  const p = zonedParts(now)
  let kickoff = zurichWallTimeMs(p.year, p.month, p.day, 20, 0)
  if (kickoff <= now.getTime()) kickoff = zurichWallTimeMs(p.year, p.month, p.day + 1, 20, 0)
  return new Date(kickoff).toISOString()
}

// Test Team Seed Data
export const TEST_TEAM_SEED_DATA = [
  {
    seedKey: 'test-team-home',
    name: 'VBC Zürich',
    shortName: 'ZÜRICH',
    color: '#3b82f6',
    players: [
      { number: 1, firstName: 'Luca', lastName: 'Keller', dob: '100211', libero: '', isCaptain: true, isLfp: true },
      { number: 2, firstName: 'Jonas', lastName: 'Hofmann', dob: '100396', libero: '', isCaptain: false, isLfp: true },
      { number: 3, firstName: 'Noah', lastName: 'Schmid', dob: '100433', libero: '', isCaptain: false, isLfp: true },
      { number: 4, firstName: 'Felix', lastName: 'Graf', dob: '100470', libero: '', isCaptain: false, isLfp: true },
      { number: 6, firstName: 'David', lastName: 'Brunner', dob: '100507', libero: '', isCaptain: false, isLfp: true },
      { number: 7, firstName: 'Erik', lastName: 'Fischer', dob: '100544', libero: '', isCaptain: false, isLfp: true },
      { number: 8, firstName: 'Ben', lastName: 'Wenger', dob: '100581', libero: '', isCaptain: false, isLfp: true },
      { number: 9, firstName: 'Lukas', lastName: 'Bachmann', dob: '100618', libero: '', isCaptain: false, isLfp: true },
      { number: 10, firstName: 'Alex', lastName: 'Baumann', dob: '100655', libero: '', isCaptain: false, isLfp: true },
      { number: 11, firstName: 'Jonas', lastName: 'Arnold', dob: '100692', libero: '', isCaptain: false, isLfp: true },
      { number: 12, firstName: 'Mauro', lastName: 'Huber', dob: '100729', libero: 'libero1', isCaptain: false, isLfp: true },
      { number: 13, firstName: 'Simon', lastName: 'Meier', dob: '100766', libero: 'libero2', isCaptain: false, isLfp: true },
    ]
  },
  {
    seedKey: 'test-team-away',
    name: 'Volley Luzern',
    shortName: 'LUZERN',
    color: '#dc2626', // the red preset (DEFAULT_HOME_COLOUR)
    players: [
      { number: 1, firstName: 'Tom', lastName: 'Weber', dob: '100803', libero: 'libero1', isCaptain: false, isLfp: true },
      { number: 2, firstName: 'Max', lastName: 'Schneider', dob: '100840', libero: '', isCaptain: false, isLfp: true },
      { number: 3, firstName: 'Daniel', lastName: 'Vogt', dob: '100877', libero: '', isCaptain: false, isLfp: true },
      { number: 4, firstName: 'Michael', lastName: 'Imhof', dob: '100914', libero: '', isCaptain: false, isLfp: true },
      { number: 5, firstName: 'Jonas', lastName: 'Ackermann', dob: '100951', libero: '', isCaptain: false, isLfp: true },
      { number: 6, firstName: 'Reto', lastName: 'Gerber', dob: '100988', libero: '', isCaptain: false, isLfp: true },
      { number: 7, firstName: 'Marco', lastName: 'Aebi', dob: '101025', libero: '', isCaptain: false, isLfp: true },
      { number: 8, firstName: 'Lorenz', lastName: 'Egli', dob: '101062', libero: '', isCaptain: false, isLfp: true },
      { number: 9, firstName: 'Yannik', lastName: 'Frey', dob: '101099', libero: '', isCaptain: false, isLfp: true },
      { number: 10, firstName: 'Philipp', lastName: 'Ryser', dob: '101136', libero: '', isCaptain: false, isLfp: true },
      { number: 11, firstName: 'Lars', lastName: 'Hauser', dob: '101173', libero: '', isCaptain: false, isLfp: true },
      { number: 12, firstName: 'Jonas', lastName: 'Mäder', dob: '101210', libero: '', isCaptain: true, isLfp: true }
    ]
  }
]

// The seed team of the test match's team external ids (the ids stay as they are:
// test teams stored on a device are found by them)
const SEED_KEY_OF_EXTERNAL_ID = {
  [TEST_HOME_TEAM_EXTERNAL_ID]: 'test-team-home',
  [TEST_AWAY_TEAM_EXTERNAL_ID]: 'test-team-away'
}

// Helper to get team data by external ID (or by its seed key)
export function getTestTeamByExternalId(externalId) {
  const seedKey = SEED_KEY_OF_EXTERNAL_ID[externalId] || externalId
  return TEST_TEAM_SEED_DATA.find(t => t.seedKey === seedKey)
}

// Get home team short name
export function getTestHomeTeamShortName() {
  const team = getTestTeamByExternalId(TEST_HOME_TEAM_EXTERNAL_ID)
  return team?.shortName || 'HOME'
}

// Get away team short name
export function getTestAwayTeamShortName() {
  const team = getTestTeamByExternalId(TEST_AWAY_TEAM_EXTERNAL_ID)
  return team?.shortName || 'AWAY'
}

export const TEST_REFEREE_SEED_DATA = [
  {
    seedKey: 'test-referee-alpha',
    firstName: 'Claudia',
    lastName: 'Moser',
    country: 'CHE',
    dob: '101247'
  },
  {
    seedKey: 'test-referee-bravo',
    firstName: 'Martin',
    lastName: 'Kunz',
    country: 'CHE',
    dob: '101284'
  }
]

export const TEST_SCORER_SEED_DATA = [
  {
    seedKey: 'test-scorer-alpha',
    firstName: 'Petra',
    lastName: 'Schneider',
    country: 'CHE',
    dob: '101321'
  },
  {
    seedKey: 'test-scorer-bravo',
    firstName: 'Lukas',
    lastName: 'Baumann',
    country: 'CHE',
    dob: '101358'
  }
]
