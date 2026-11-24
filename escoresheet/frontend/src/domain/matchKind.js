/**
 * Two questions the code asks about a match, kept apart (owner 2026-11-17):
 *
 * - isLocalOnly: the match never reaches the cloud database. A test or easy
 *   match (practice), a Global match (any tournament, no account: its sheet
 *   and backup go to the Global store only, utils/globalCloud), and a guest
 *   match (the Swiss "New match" signed out, same store). Every
 *   cloud write, server check and sync job asks this.
 * - match.test: the match is practice. Labels, the referee/bench pickers'
 *   "test matches", placeholder signatures, skipped checks. A Global match is
 *   a real match there (test: false), so its tablets, livescore and TV treat
 *   it as one.
 */
export const isLocalOnly = (match) => !!match && (match.test === true || match.global === true || match.guest === true)

/**
 * A guest match (owner 2026-11-18): the Swiss app's "New match" while signed
 * out. A real match in the Swiss format (Swiss Volley rules, scorer's date of
 * birth, CHE) without an account: local only like a Global match, its backup
 * and finished sheet in the same keyed store (utils/globalCloud), and no
 * private data in Match setup (saved teams, club lists, sent rosters, the
 * referee directory, other matches' rosters on the device). The public
 * schedule (svrz_games' public columns) and the Einsatzliste import stay.
 */
export const isGuestMatch = (match) => !!match && match.guest === true && match.global !== true

/**
 * The match keeps its files in the keyed store by its own `globalKey` (no
 * account): a Global or a guest match. The Global *format* (any league, ID
 * modes, no Swiss checks) still asks `match.global` alone.
 */
export const usesKeyStore = (match) => !!match && (match.global === true || match.guest === true)
