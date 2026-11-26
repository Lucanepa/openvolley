/**
 * The demo data of the "Your first match" walkthrough (owner decision
 * 24.11.2026: the signed-in roster ways are SIMULATED on the walkthrough's
 * test match, nothing is sent): a saved team for "Load saved team", a club
 * licence list for "Add from club" and a roster the coach "uploaded" for
 * Remote -> Accept. Made-up people only, no club of the app's users (the app
 * stays club-agnostic). Pure data and checks; components/walkthrough/demoData.js
 * puts it on the device and takes it off again.
 *
 * The demo account (DEMO_USER_ID) exists only inside Match setup of the
 * walkthrough's test match (components/walkthrough/DemoAuthScope.jsx): the
 * saved-team cache answers it from here (db/savedTeams.js), never from the
 * server, and its club list is a device row under its own user id, so a real
 * account never sees it.
 */

export const DEMO_USER_ID = 'walkthrough-demo'
export const DEMO_CLUB_ID = 'walkthrough-demo-club'
// The demo upload's time stamp: what marks the demo "Roster uploaded" on the
// test match (removeDemoData takes only that one off)
export const DEMO_UPLOAD_TIMESTAMP = '2026-01-01T12:00:00.000Z'

/** Is this the walkthrough's demo account? */
export const isWalkthroughDemoUser = (userId) => userId === DEMO_USER_ID

// The demo account's rights: it reads teams (saved teams, club lists), nothing more
export const DEMO_ACCESS = Object.freeze({
  roles: [],
  isAdmin: false,
  isSuperAdmin: false,
  canScore: false,
  canManageTeams: false,
  canReadTeams: true,
  isPending: false,
  known: true,
  demo: true
})

export const DEMO_USER = Object.freeze({ id: DEMO_USER_ID, email: null, demo: true })

const COMPETITION = Object.freeze({ id: 'walkthrough-demo-competition', name: 'Demo league', season: '2026/27', gender: null, category: null, vmLeagues: [], archived: false, sport: 'indoor' })

// The saved team: twelve players with their shirt numbers, a coach
const SAVED_PLAYERS = [
  [1, 'Remo', 'Tanner', '904101', false, true],
  [3, 'Nico', 'Bärtschi', '904103', false, false],
  [4, 'Janis', 'Zurflüh', '904104', false, false],
  [5, 'Levin', 'Oberli', '904105', false, false],
  [7, 'Silvan', 'Rüfenacht', '904107', false, false],
  [8, 'Dario', 'Kälin', '904108', false, false],
  [9, 'Gian', 'Fankhauser', '904109', false, false],
  [10, 'Flurin', 'Schöni', '904110', false, false],
  [11, 'Matteo', 'Wälti', '904111', false, false],
  [14, 'Elia', 'Bühlmann', '904114', false, false],
  [15, 'Timo', 'Gerwer', '904115', true, false],
  [17, 'Noel', 'Zbären', '904117', false, false]
]

/** The saved team as a cache row (db/savedTeams.js bundleToRows). */
export function demoSavedTeamRows() {
  return [{
    id: 'walkthrough-demo-team',
    competitionId: COMPETITION.id,
    competition: { ...COMPETITION },
    name: 'Demo saved team',
    shortName: 'DEM',
    club: 'Demo club',
    color: '',
    svrzTeamName: '',
    nameKey: 'demo saved team',
    svrzKey: '',
    players: SAVED_PLAYERS.map(([number, first, last, licence, libero, captain], i) => ({
      number, first_name: first, last_name: last, license_number: licence, is_libero: libero, is_captain: captain, active: true, order: i
    })),
    staff: [{ role: 'Coach', first_name: 'Urs', last_name: 'Gfeller', license_number: '904190', order: 0 }],
    updatedAt: '2026-01-01T12:00:00.000Z'
  }]
}

// The club's licence list: three players the saved team does not have, then
// the saved team's (their numbers come from it). The three come first: "Add
// from club" lists the club in this order, and after "Load saved team" its
// players are all "In the roster", so the ones to tick are at the top; the
// player pool offers them unticked ("Choose players", MatchSetup)
const CLUB_EXTRA = [
  ['Ruben', 'Lauener', '904120'],
  ['Andrin', 'Pfister', '904121'],
  ['Cyrill', 'Mosimann', '904122']
]

/**
 * The club row of the demo account (db/clubPlayers.js clubToRow shape) for
 * the team `teamName` (the test match's team: "Add from club" offers it
 * there).
 */
export function demoClubRow(teamName) {
  const person = ([first, last, licence]) => ({ sv_number: licence, last_name: last, first_name: first, gender: null, manual: false, from_match: false })
  const players = [...CLUB_EXTRA.map(person), ...SAVED_PLAYERS.map(([, first, last, licence]) => person([first, last, licence]))]
  const coach = { ...person(['Urs', 'Gfeller', '904190']), lists: ['coaches'] }
  return {
    clubId: DEMO_CLUB_ID,
    clubName: 'Demo club',
    teamNames: [teamName],
    teamGenders: { [teamName]: null },
    players,
    people: [...players.map(p => ({ ...p, lists: ['players'] })), coach],
    fetchedAt: '2026-01-01T12:00:00.000Z',
    userId: DEMO_USER_ID
  }
}

// The roster the coach "uploaded" with the upload PIN (domain/uploadedRoster shape)
const UPLOAD_PLAYERS = [
  [2, 'Lio', 'Hänni', '905102', '', true],
  [3, 'Mika', 'Zaugg', '905103', '', false],
  [5, 'Jan', 'Stucki', '905105', '', false],
  [6, 'Nils', 'Aeschbacher', '905106', '', false],
  [8, 'Tim', 'Grossenbacher', '905108', '', false],
  [9, 'Ivo', 'Bigler', '905109', '', false],
  [10, 'Luan', 'Rieder', '905110', '', false],
  [12, 'Mael', 'Liechti', '905112', '', false],
  [13, 'Yves', 'Siegenthaler', '905113', 'libero1', false],
  [16, 'Joel', 'Ramseier', '905116', '', false]
]

/** The demo upload, as the server would hand it over (pendingHomeRoster). */
export function demoUploadedRoster() {
  return {
    players: UPLOAD_PLAYERS.map(([number, firstName, lastName, dob, libero, isCaptain]) => ({ number, firstName, lastName, dob, libero, isCaptain, isLfp: false })),
    bench: [{ role: 'Coach', firstName: 'Beat', lastName: 'Wüthrich', dob: '905190' }],
    coachSignature: null,
    captainSignature: null,
    timestamp: DEMO_UPLOAD_TIMESTAMP
  }
}

/** Is this the demo upload (and no real one)? */
export const isDemoUpload = (raw) => !!raw && typeof raw === 'object' && raw.timestamp === DEMO_UPLOAD_TIMESTAMP
