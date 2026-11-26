// The walkthrough's demo data on the device (domain/walkthroughDemo.js has
// the data): only for its test match, and taken off again when it ends and
// with the test data (App clearLocalTestData). Nothing here talks to a server.
import { db as appDb } from '../../db/db'
import { DEMO_USER_ID, demoClubRow, demoUploadedRoster, isDemoUpload } from '../../domain/walkthroughDemo'

/** The match, when it is a test match the demo may touch (else null). */
export async function demoMatch(matchId, database = appDb) {
  if (matchId == null) return null
  const match = await database.matches.get(matchId)
  // practice only: never an official, guest, Global or Easy match
  if (!match || match.test !== true || match.easy === true || match.global === true || match.guest === true) return null
  return match
}

/**
 * The demo club's licence list for the test match's home team ("Add from
 * club"), under the demo account's id. false when the match is no test match.
 */
export async function seedDemoClub(matchId, database = appDb) {
  const match = await demoMatch(matchId, database)
  if (!match) return false
  const home = match.homeTeamId != null ? await database.teams.get(match.homeTeamId) : null
  if (!home?.name) return false
  await database.club_players.put(demoClubRow(home.name))
  return true
}

/**
 * The demo "Roster uploaded" of the home team (Remote): as a check of the
 * server stores one (MatchSetup checkServerForRoster). Only before the coin
 * toss, only on the test match, and never over a real upload.
 */
export async function writeDemoUpload(matchId, database = appDb) {
  const match = await demoMatch(matchId, database)
  if (!match || match.coinTossConfirmed === true) return false
  if (match.pendingHomeRoster && !isDemoUpload(match.pendingHomeRoster)) return false
  const taken = match.uploadedRosterTaken
  // offered again, also after an earlier Accept or Reject of it
  const takenAfter = taken && typeof taken === 'object' ? { ...taken, home: null } : taken
  await database.matches.update(matchId, { pendingHomeRoster: demoUploadedRoster(), ...(taken ? { uploadedRosterTaken: takenAfter } : {}) })
  return true
}

/** Everything demo off the device: the demo club list, a demo upload still waiting. */
export async function removeDemoData(database = appDb) {
  try {
    await database.club_players.where('userId').equals(DEMO_USER_ID).delete()
  } catch { /* table missing (an old database): nothing there */ }
  try {
    const waiting = await database.matches.filter(m => isDemoUpload(m.pendingHomeRoster)).toArray()
    for (const m of waiting) await database.matches.update(m.id, { pendingHomeRoster: null })
  } catch { /* nothing to take off */ }
}
