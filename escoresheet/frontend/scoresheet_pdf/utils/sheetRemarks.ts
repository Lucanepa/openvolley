/**
 * Remarks the sheet writes itself (field-spec 8 and 11): a default / forfeit,
 * an incomplete team, and a set of sets 1-4 that went past the 48 points of
 * its column (field-spec 4.4). Scoreboard.handleForfait records them as a 'forfait'
 * event (team, reason, scope 'match' | 'set', setsBefore) plus the awarded
 * points (payload.forfeitAwarded) and sets (forfeitCreated), but writes no
 * remark. Every remark names the team (A/B), the set and the score, the
 * concerned team first (SC p.71).
 */
import { compareEventsBySeq, displaySetNumber } from './scoresheetModel'

type TeamKey = 'home' | 'away'

// The generic reasons (the Scoreboard writes 'forfait') add nothing to "declared in default":
// they map to '' and the remark has no bracket ("in default (default)" before).
const REASONS: Record<string, string> = {
  forfeit: '',
  forfait: '',
  default: '',
  injury: 'injury',
  illness: 'illness',
  expulsion: 'expulsion',
  disqualification: 'disqualification',
  noshow: 'did not show up',
  'no-show': 'did not show up',
  incomplete: 'incomplete team'
}

const reasonText = (reason: unknown) => {
  const r = typeof reason === 'string' ? reason.trim() : ''
  const key = r.toLowerCase()
  return key in REASONS ? REASONS[key] : r
}
const inBrackets = (why: string) => (why ? ` (${why})` : '')

const pts = (s: any, team: TeamKey) => (team === 'home' ? s?.homePoints || 0 : s?.awayPoints || 0)

/** Home/away score of a set just before its first awarded point (the score at the forfeit). */
function scoreBeforeAward(events: any[], setIndex: number): { home: number; away: number } {
  let home = 0
  let away = 0
  const pointsOfSet = events
    .filter(e => e?.type === 'point' && e.setIndex === setIndex)
    .sort(compareEventsBySeq)
  for (const e of pointsOfSet) {
    if (e.payload?.forfeitAwarded === true) break
    if (e.payload?.team === 'home') home++
    else if (e.payload?.team === 'away') away++
  }
  return { home, away }
}

export function generatedRemarks({ sets, events, teamAKey, bestOf }: {
  sets: any[]
  events: any[]
  teamAKey: TeamKey
  bestOf?: number
}): string[] {
  const allSets = (sets || []).filter(Boolean)
  const allEvents = (events || []).filter(Boolean)
  const letter = (team: TeamKey) => (team === teamAKey ? 'A' : 'B')
  const lines: string[] = []

  const forfaits = allEvents.filter(e => e.type === 'forfait').sort(compareEventsBySeq)
  for (const e of forfaits) {
    const p = e.payload || {}
    const team: TeamKey = p.team === 'away' ? 'away' : 'home'
    const opp: TeamKey = team === 'home' ? 'away' : 'home'
    const setIndex: number = Number(p.setIndex ?? e.setIndex) || 1
    const shown = displaySetNumber(setIndex, bestOf)
    const before = scoreBeforeAward(allEvents, setIndex)
    const atForfeit = `${before[team]}:${before[opp]}`
    const why = reasonText(p.reason)

    if (p.scope === 'set') {
      const set = allSets.find(s => s.index === setIndex)
      lines.push(
        `Team ${letter(team)}, Set ${shown}, Result ${atForfeit}: incomplete team${inBrackets(why === 'incomplete team' ? '' : why)}. ` +
        `Set awarded to Team ${letter(opp)}${set ? `, ${pts(set, opp)}:${pts(set, team)}` : ''}.`
      )
      continue
    }

    // The whole match: the defaulting team loses 0:3 / 0:2, the result written from the winner's side
    const finished = allSets.filter(s => s.finished).sort((a, b) => a.index - b.index)
    const won = finished.filter(s => pts(s, opp) > pts(s, team)).length
    const lost = finished.filter(s => pts(s, team) > pts(s, opp)).length
    const scores = finished.map(s => `${pts(s, opp)}:${pts(s, team)}`).join(', ')
    const anyRally = allEvents.some(x => x.type === 'point' && x.payload?.forfeitAwarded !== true)
    if (!anyRally) {
      lines.push(`Team ${letter(team)} declared in default${inBrackets(why)}, match result ${won}:${lost}${scores ? ` (${scores})` : ''}.`)
    } else {
      lines.push(
        `Team ${letter(team)}, Set ${shown}, Result ${atForfeit}: declared in default${inBrackets(why)}. ` +
        `Match awarded to Team ${letter(opp)}, ${won}:${lost}${scores ? ` (${scores})` : ''}.`
      )
    }
  }

  // Sets 1-4 have 48 points a team on paper (field-spec 4.4): the column is
  // extended and the remark says so, Team A first
  const teamBKey: TeamKey = teamAKey === 'home' ? 'away' : 'home'
  for (const s of allSets.filter(x => x.finished && x.index >= 1 && x.index <= 4).sort((a, b) => a.index - b.index)) {
    if (Math.max(pts(s, 'home'), pts(s, 'away')) > 48) {
      lines.push(`Set ${s.index} continued beyond 48, final ${pts(s, teamAKey)}:${pts(s, teamBKey)}`)
    }
  }
  return lines
}

/** The prefix of a remark the sheet writes for a change made after the match. */
export const CORRECTED_AFTER_MATCH = 'Corrected after the match'

/**
 * The changes made after the match (match.manualChanges entries marked
 * `afterMatch`: a correction at the match end, the Teams / Match info editor,
 * a remarks change after the signatures), one remark each, oldest first:
 * Match End lists them in REMARKS before anyone signs, and the scoresheet
 * prints them. The sentence is the log's own (`text`, else `description`).
 * Entries made during the match, and those of older versions without the
 * mark, are left out; the whole log stays with the match on the server
 * (manual_changes) and in the Corrections panel.
 */
export function correctionRemarks(manualChanges: unknown): string[] {
  if (!Array.isArray(manualChanges)) return []
  const lines: string[] = []
  for (const c of manualChanges) {
    if (!c || typeof c !== 'object' || (c as any).afterMatch !== true) continue
    const raw = (c as any).text ?? (c as any).description
    const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
    if (text) lines.push(`${CORRECTED_AFTER_MATCH}: ${text}`)
  }
  return lines
}
