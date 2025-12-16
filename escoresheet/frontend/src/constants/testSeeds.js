// Test Match Constants
export const TEST_MATCH_SEED_KEY = 'test-match-default'
export const TEST_MATCH_EXTERNAL_ID = 'test-match-default'
export const TEST_HOME_TEAM_EXTERNAL_ID = 'test-team-alpha'
export const TEST_AWAY_TEAM_EXTERNAL_ID = 'test-team-bravo'

export const TEST_MATCH_DEFAULTS = {
  hall: 'Kantonsschule Wiedikon (Halle A)',
  city: 'Zürich',
  league: '3L B',
  gameNumber: '123456'
}

export const TEST_HOME_BENCH = [
  { role: 'Coach', firstName: 'Marco', lastName: 'Frei', dob: '15/05/1975' },
  { role: 'Assistant Coach 1', firstName: 'Jan', lastName: 'Widmer', dob: '21/09/1980' },
  { role: 'Assistant Coach 2', firstName: 'Luca', lastName: 'Keller', dob: '05/01/1998' },
  { role: 'Physiotherapist', firstName: 'Eva', lastName: 'Gerber', dob: '03/12/1985' },
  { role: 'Medic', firstName: 'Luca', lastName: 'Keller', dob: '05/01/1998' }
]

export const TEST_AWAY_BENCH = [
  { role: 'Coach', firstName: 'Stefan', lastName: 'Keller', dob: '08/02/1976' },
  { role: 'Assistant Coach 1', firstName: 'Lars', lastName: 'Brunner', dob: '27/07/1981' },
  { role: 'Physiotherapist', firstName: 'Mia', lastName: 'Schmid', dob: '14/04/1987' }
]

export function getNextTestMatchStartTime() {
  const now = new Date()
  const kickoff = new Date(now)
  kickoff.setHours(20, 0, 0, 0)
  if (kickoff <= now) {
    kickoff.setDate(kickoff.getDate() + 1)
  }
  return kickoff.toISOString()
}

// Test Team Seed Data
export const TEST_TEAM_SEED_DATA = [
  {
    seedKey: 'test-team-alpha',
    name: 'VBC Zürich',
    shortName: 'ZÜRICH',
    color: '#3b82f6',
    players: [
      { number: 1, firstName: 'Luca', lastName: 'Keller', dob: '05/01/1998', libero: '', isCaptain: true },
      { number: 2, firstName: 'Jonas', lastName: 'Hofmann', dob: '12/03/1997', libero: '', isCaptain: false },
      { number: 3, firstName: 'Noah', lastName: 'Schmid', dob: '23/07/1996', libero: '', isCaptain: false },
      { number: 13, firstName: 'Simon', lastName: 'Meier', dob: '18/09/1995', libero: 'libero2', isCaptain: false },
      { number: 4, firstName: 'Felix', lastName: 'Graf', dob: '30/11/1999', libero: '', isCaptain: false },
      { number: 6, firstName: 'David', lastName: 'Brunner', dob: '14/01/1998', libero: '', isCaptain: false },
      { number: 7, firstName: 'Erik', lastName: 'Fischer', dob: '09/02/1996', libero: '', isCaptain: false },
      { number: 8, firstName: 'Ben', lastName: 'Wenger', dob: '27/04/1999', libero: '', isCaptain: false },
      { number: 9, firstName: 'Lukas', lastName: 'Bachmann', dob: '08/06/1997', libero: '', isCaptain: false },
      { number: 10, firstName: 'Alex', lastName: 'Baumann', dob: '16/08/2000', libero: '', isCaptain: false },
      { number: 11, firstName: 'Jonas', lastName: 'Arnold', dob: '02/12/1998', libero: '', isCaptain: false },
      { number: 12, firstName: 'Mauro', lastName: 'Huber', dob: '19/03/1997', libero: 'libero1', isCaptain: false },
    ]
  },
  {
    seedKey: 'test-team-bravo',
    name: 'Volleyball Uni St. Gallen',
    shortName: 'UNISG',
    color: '#ef4444',
    players: [
      { number: 1, firstName: 'Tom', lastName: 'Weber', dob: '11/01/1998', libero: 'libero1', isCaptain: false },
      { number: 2, firstName: 'Max', lastName: 'Schneider', dob: '24/03/1996', libero: '', isCaptain: false },
      { number: 3, firstName: 'Daniel', lastName: 'Vogt', dob: '06/05/1997', libero: '', isCaptain: false },
      { number: 4, firstName: 'Michael', lastName: 'Imhof', dob: '22/07/1995', libero: '', isCaptain: false },
      { number: 5, firstName: 'Jonas', lastName: 'Ackermann', dob: '18/09/1999', libero: '', isCaptain: false },
      { number: 6, firstName: 'Reto', lastName: 'Gerber', dob: '03/12/1998', libero: '', isCaptain: false },
      { number: 7, firstName: 'Marco', lastName: 'Aebi', dob: '15/02/1997', libero: '', isCaptain: false },
      { number: 8, firstName: 'Lorenz', lastName: 'Egli', dob: '28/04/1996', libero: '', isCaptain: false },
      { number: 9, firstName: 'Yannik', lastName: 'Frey', dob: '09/06/1999', libero: '', isCaptain: false },
      { number: 10, firstName: 'Philipp', lastName: 'Ryser', dob: '17/08/2000', libero: '', isCaptain: false },
      { number: 11, firstName: 'Lars', lastName: 'Hauser', dob: '05/10/1997', libero: '', isCaptain: false },
      { number: 12, firstName: 'Jonas', lastName: 'Mäder', dob: '21/11/1998', libero: '', isCaptain: true }
    ]
  }
]

// Helper to get team data by external ID
export function getTestTeamByExternalId(externalId) {
  return TEST_TEAM_SEED_DATA.find(t => t.seedKey === externalId)
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
    dob: '1982-04-19'
  },
  {
    seedKey: 'test-referee-bravo',
    firstName: 'Martin',
    lastName: 'Kunz',
    country: 'CHE',
    dob: '1979-09-02'
  }
]

export const TEST_SCORER_SEED_DATA = [
  {
    seedKey: 'test-scorer-alpha',
    firstName: 'Petra',
    lastName: 'Schneider',
    country: 'CHE',
    dob: '1990-01-15'
  },
  {
    seedKey: 'test-scorer-bravo',
    firstName: 'Lukas',
    lastName: 'Baumann',
    country: 'CHE',
    dob: '1988-06-27'
  }
]
