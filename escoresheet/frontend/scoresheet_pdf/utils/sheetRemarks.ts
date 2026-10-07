/**
 * Remarks the sheet writes itself (field-spec 8 and 11): a default / forfeit
 * and an incomplete team. Scoreboard.handleForfait records them as a 'forfait'
 * event (team, reason, scope 'match' | 'set', setsBefore) plus the awarded
 * points (payload.forfeitAwarded) and sets (forfeitCreated), but writes no
 * remark. Every remark names the team (A/B), the set and the score, the
 * concerned team first (SC p.71).
 */
import { compareEventsBySeq, displaySetNumber } from './scoresheetModel'

type TeamKey = 'home' | 'away'

const REASONS: Record<string, string> = {
  forfeit: 'default',
  default: 'default',
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
  return REASONS[r.toLowerCase()] || r || 'default'
}

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
        `Team ${letter(team)}, Set ${shown}, Result ${atForfeit}: incomplete team (${why}). ` +
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
      lines.push(`Team ${letter(team)} declared in default (${why}), match result ${won}:${lost}${scores ? ` (${scores})` : ''}.`)
    } else {
      lines.push(
        `Team ${letter(team)}, Set ${shown}, Result ${atForfeit}: declared in default (${why}). ` +
        `Match awarded to Team ${letter(opp)}, ${won}:${lost}${scores ? ` (${scores})` : ''}.`
      )
    }
  }
  return lines
}
