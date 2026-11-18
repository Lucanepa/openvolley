/**
 * Two questions the code asks about a match, kept apart (owner 2026-11-17):
 *
 * - isLocalOnly: the match never reaches the cloud database. A test or easy
 *   match (practice), and a Global match (any tournament, no account: its
 *   sheet and backup go to the Global store only, utils/globalCloud). Every
 *   cloud write, server check and sync job asks this.
 * - match.test: the match is practice. Labels, the referee/bench pickers'
 *   "test matches", placeholder signatures, skipped checks. A Global match is
 *   a real match there (test: false), so its tablets, livescore and TV treat
 *   it as one.
 */
export const isLocalOnly = (match) => !!match && (match.test === true || match.global === true)
