/**
 * Sponsors on clothing (owner 2026-11-15).
 *
 * A scorer option (per device, off by default): while it is on, Match setup,
 * the match end and Edit match info show one box per team, "Sponsors on
 * clothing". The match keeps the answers:
 *   - homeSponsors / awaySponsors: booleans (default false)
 *   - sponsorsMarked: true from the first box ticked. From then on the match
 *     prints its marks on every device and in the PDF, whatever the device's
 *     option says ("the match decides").
 * A marked match prints " (+)" after a team's name when its box is ticked,
 * else " (-)": on the scoresheet PDF and the match-end screen only (never the
 * live scoreboard, the referee tablet or the livescore).
 *
 * On the server the fields travel in match_info (sponsors_home,
 * sponsors_away, sponsors_marked: db/matchRepository matchInfoFromLocal).
 */

export const SPONSORS_OPTION_KEY = 'sponsorsOnClothing'
// fired on this window when the option changes, so every open screen agrees
export const SPONSORS_OPTION_EVENT = 'ov:sponsors-option'

export const SPONSOR_MARK_YES = '(+)'
export const SPONSOR_MARK_NO = '(-)'

/** Is the option on on this device (localStorage; off when it cannot be read). */
export function getSponsorsOption() {
  try {
    return globalThis.localStorage?.getItem(SPONSORS_OPTION_KEY) === 'true'
  } catch {
    return false
  }
}

/** Turn the option on or off on this device, and tell the open screens. */
export function setSponsorsOption(on) {
  try {
    globalThis.localStorage?.setItem(SPONSORS_OPTION_KEY, String(!!on))
  } catch { /* storage blocked: the screens still follow the event */ }
  try {
    window.dispatchEvent(new CustomEvent(SPONSORS_OPTION_EVENT, { detail: !!on }))
  } catch { /* no window */ }
}

/**
 * The match's sponsor answers, from a local match (camelCase) or a server row
 * (match_info). Never throws.
 * @returns {{ marked: boolean, home: boolean, away: boolean }}
 */
export function sponsorsOf(match) {
  const info = match?.match_info && typeof match.match_info === 'object' ? match.match_info : {}
  const pick = (local, remote) => (typeof local === 'boolean' ? local : remote === true)
  return {
    marked: pick(match?.sponsorsMarked, info.sponsors_marked),
    home: pick(match?.homeSponsors, info.sponsors_home),
    away: pick(match?.awaySponsors, info.sponsors_away)
  }
}

/** The boxes are shown: the option is on, or the match is already marked. */
export function showsSponsorBoxes(optionOn, match) {
  return !!optionOn || sponsorsOf(match).marked
}

/**
 * A team name as the sheet prints it: " (+)" or " (-)" after it once the
 * match is marked, the name unchanged otherwise (and an empty name stays empty).
 */
export function withSponsorMark(name, ticked, marked) {
  const text = name == null ? '' : String(name)
  if (!marked || !text.trim()) return text
  return `${text} ${ticked ? SPONSOR_MARK_YES : SPONSOR_MARK_NO}`
}

/** One team's name ('home' | 'away') with the match's mark. */
export function teamNameWithSponsors(match, team, name) {
  const s = sponsorsOf(match)
  return withSponsorMark(name, team === 'away' ? s.away : s.home, s.marked)
}

/**
 * The match fields after one team's box changed. A ticked box marks the match
 * for good; unticking never unmarks it (the team then prints "(-)").
 * @param {object} match the match as it is now
 * @param {'home'|'away'} team
 * @param {boolean} ticked
 */
export function sponsorsPatch(match, team, ticked) {
  const field = team === 'away' ? 'awaySponsors' : 'homeSponsors'
  const marked = !!ticked || sponsorsOf(match).marked
  return { [field]: !!ticked, ...(marked ? { sponsorsMarked: true } : {}) }
}

/** The match_info keys (every one, so a whole-object write keeps them). */
export function sponsorsToMatchInfo(match) {
  const s = sponsorsOf(match)
  return { sponsors_home: s.home, sponsors_away: s.away, sponsors_marked: s.marked }
}

/** The local fields from match_info: only the keys the server has. */
export function sponsorsFromMatchInfo(info) {
  const src = info && typeof info === 'object' ? info : {}
  const out = {}
  if (typeof src.sponsors_home === 'boolean') out.homeSponsors = src.sponsors_home
  if (typeof src.sponsors_away === 'boolean') out.awaySponsors = src.sponsors_away
  if (typeof src.sponsors_marked === 'boolean') out.sponsorsMarked = src.sponsors_marked
  return out
}
