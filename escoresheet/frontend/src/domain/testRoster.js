/**
 * The seeded test roster of a test match (constants/testSeeds): its players
 * and bench officials are made-up people. When a test match gets other teams
 * (a game loaded from the schedule, team names typed), the seeded people of a
 * replaced team go; players and officials the scorer added or loaded stay.
 * A seeded person is one equal to a seed entry (number, names and licence for
 * a player; names and licence for an official): one the scorer edited is the
 * scorer's own. Pure: no React, no Dexie.
 */
import { TEST_TEAM_SEED_DATA, TEST_HOME_BENCH, TEST_AWAY_BENCH } from '../constants/testSeeds'

const str = (v) => (v === null || v === undefined ? '' : String(v).trim())
const lower = (v) => str(v).toLowerCase()

const playerKey = (p) => [str(p?.number), lower(p?.lastName), lower(p?.firstName), str(p?.dob)].join('|')
const officialKey = (m) => [lower(m?.lastName), lower(m?.firstName), str(m?.dob)].join('|')

const SEED_PLAYERS = new Set(TEST_TEAM_SEED_DATA.flatMap((team) => team.players.map(playerKey)))
const SEED_OFFICIALS = new Set([...TEST_HOME_BENCH, ...TEST_AWAY_BENCH].map(officialKey))
const SEED_TEAM_KEYS = new Set(TEST_TEAM_SEED_DATA.map((team) => team.seedKey))

/** A bench without officials: one empty coach row, as "Delete roster" leaves it. */
export const EMPTY_BENCH = Object.freeze([Object.freeze({ role: 'Coach', firstName: '', lastName: '', dob: '' })])

/** Is this roster entry a player of the seeded test roster? */
export function isSeedTestPlayer(player) {
  return !!player && SEED_PLAYERS.has(playerKey(player))
}

/** Is this bench row an official of the seeded test benches? */
export function isSeedTestOfficial(member) {
  return !!member && SEED_OFFICIALS.has(officialKey(member))
}

/** Is this stored team one of the shared seed teams every test match starts with? */
export function isSeedTestTeam(team) {
  return !!team && SEED_TEAM_KEYS.has(team.seedKey)
}

/**
 * A side's roster and bench without the seeded test people.
 * @param {object[]} roster
 * @param {object[]} bench
 * @returns {{ roster: object[], bench: object[], removed: number }} removed:
 *   how many players and officials went; a bench left without rows gets one
 *   empty coach row
 */
export function withoutSeedTestRoster(roster = [], bench = []) {
  const players = (roster || []).filter((p) => !isSeedTestPlayer(p))
  const officials = (bench || []).filter((m) => !isSeedTestOfficial(m))
  const removed = (roster || []).length - players.length + (bench || []).length - officials.length
  return {
    roster: players,
    bench: officials.length ? officials : EMPTY_BENCH.map((m) => ({ ...m })),
    removed
  }
}
