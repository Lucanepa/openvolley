/**
 * The game PIN notice (components/MatchPinNotice.jsx): right after Create
 * match in Match setup (owner 22.11.2026), before the coin toss, the scorer
 * of a new official match sees the game PIN large,
 * with "Please write the PIN down somewhere", and can send it by email:
 *
 * - signed in: the SERVER mails it to the account's own confirmed address
 *   (POST /api/match/send-pin, utils/matchInfoMail.js); no typed address
 *   ever goes to the server;
 * - any address: the device's mail app opens (mailto:) with the PIN, nothing
 *   goes through the server.
 *
 * Shown once per match: the local match row keeps `pinNoticeShownAt` (never
 * synced). The game PIN stays where it was (match info page, Home, Match ›
 * Show PINs).
 */
import { isLocalOnly } from '../domain/matchKind'
import { dayTimeLabel } from '../ui/format'

const PAST_SETUP = ['live', 'ended', 'final', 'approved']

/** The game PIN of a local match row, as shown ('' when none). */
export const gamePinOf = (match) => String(match?.gamePin ?? '').trim()

/**
 * Does this match (as stored right after Create match) show the PIN notice?
 * An official match (not test, Global, guest or easy: those have no game PIN
 * on the server) with a game PIN, before its coin toss, that has not shown it
 * on this device yet.
 */
export function needsPinNotice (match) {
  if (!match || isLocalOnly(match) || match.easy === true) return false
  if (!gamePinOf(match)) return false
  if (match.pinNoticeShownAt) return false
  if (match.coinTossConfirmed === true || match.approved === true || PAST_SETUP.includes(match.status)) return false
  return true
}

/** One address, no display name, no spaces (what a mailto: recipient may be). */
export function isMailAddress (value) {
  const s = String(value || '').trim()
  return s.length <= 254 && /^[^@\s,;?&#<>"]+@[^@\s,;?&#<>"]+\.[^@\s,;?&#<>"]+$/.test(s)
}

/** The scorer official's address stored with the match, else ''. */
export function scorerEmailOf (match) {
  const scorer = (Array.isArray(match?.officials) ? match.officials : []).find((o) => o?.role === 'scorer')
  return isMailAddress(scorer?.email) ? String(scorer.email).trim() : ''
}

/**
 * "Alpha VC – Beta VC": the team names Match setup shows (`names`, its home
 * and away fields), else those stored on the match row, else Home / Away.
 */
export function teamsLine (t, match, names = {}) {
  const home = String(names.home || match?.homeName || '').trim() || t('common.homeTeam', 'Home')
  const away = String(names.away || match?.awayName || '').trim() || t('common.awayTeam', 'Away')
  return `${home} – ${away}`
}

/** The game number of the match, '' when none. */
export const gameNumberOf = (match) => String(match?.game_n ?? match?.gameNumber ?? '').trim()

/**
 * Subject and body of the mail-app message: match, teams, date, PIN and the
 * "write it down" sentence, in the app's language. `names`: as teamsLine.
 * @returns {{ subject: string, body: string }}
 */
export function pinMailContent (t, match, names = {}) {
  const pin = gamePinOf(match)
  const teams = teamsLine(t, match, names)
  const game = gameNumberOf(match)
  const league = String(match?.league || '').trim()
  const date = dayTimeLabel(match?.scheduledAt)
  const lines = [
    teams,
    game ? t('pinNotice.mailGame', 'Game {{number}}', { number: game }) : null,
    league ? t('pinNotice.mailLeague', 'League: {{league}}', { league }) : null,
    date ? t('pinNotice.mailDate', 'Date: {{date}}', { date }) : null,
    '',
    t('pinNotice.mailPin', 'Game PIN: {{pin}}', { pin }),
    '',
    t('pinNotice.writeDown', 'Please write the PIN down somewhere: it is needed to recover the match and/or to reopen it.')
  ].filter((l) => l !== null)
  return {
    subject: t('pinNotice.mailSubject', 'Game PIN: {{teams}}', { teams }),
    body: lines.join('\r\n')
  }
}

/**
 * The mailto: link (RFC 6068): the recipient (may be empty: the mail app
 * asks), subject and body percent-encoded, line breaks as CRLF.
 */
export function pinMailtoHref (to, { subject, body }) {
  const addr = isMailAddress(to) ? encodeURIComponent(String(to).trim()).replace(/%40/g, '@') : ''
  return `mailto:${addr}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}
