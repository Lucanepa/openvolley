/**
 * A team's labels outside the official sheet's fixed data: its short name and
 * its shirt colour. Both live twice, on the team record (teams.shortName,
 * teams.color) and mirrored on the match row (homeShortName / awayShortName,
 * homeColor / awayColor), the way Match setup writes them. The scoring
 * screen's live state (team_a_short / team_a_color, read by the referee and
 * bench tablets, the livescore and Point Hub) takes the match's short name
 * first, so an editor that writes the team record only changed nothing there.
 * Pure: no React, no Dexie.
 */
import { effectiveTeamColour } from '../utils/teamColours'

/** Short names: at most 8 characters, in capitals (Match setup and the editors) */
export const SHORT_NAME_MAX = 8

/** A short name as typed, the way it is stored: capitals, at most 8 characters */
export function cleanShortName(value) {
  return String(value ?? '').toUpperCase().slice(0, SHORT_NAME_MAX)
}

const MIRROR = {
  home: { name: 'homeName', shortName: 'homeShortName', color: 'homeColor' },
  away: { name: 'awayName', shortName: 'awayShortName', color: 'awayColor' }
}

/**
 * The match-row fields to write for team edits: only the fields an editor
 * changed (a name, short name or colour the same as before writes nothing,
 * so a match row whose names come from the server keeps them).
 * @param {{ home?: object|null, away?: object|null }} before the team records as loaded
 * @param {{ home?: object|null, away?: object|null }} after the edited team records
 * @returns {object} e.g. { homeShortName: 'NEW', awayColor: '#1d4ed8' }
 */
export function teamMirrorPatch(before = {}, after = {}) {
  const patch = {}
  for (const side of ['home', 'away']) {
    const was = before?.[side]
    const now = after?.[side]
    if (!now) continue
    for (const field of ['name', 'shortName', 'color']) {
      if ((now[field] ?? '') !== (was?.[field] ?? '')) patch[MIRROR[side][field]] = now[field]
    }
  }
  return patch
}

/**
 * Team A / B as the live state sends them (team_a_name, team_a_short,
 * team_a_color, ...): the match row's name and short name first, else the
 * team record's, else the first three letters of the name; the colour the
 * scorer's court shows (the team record's first).
 * @param {object} match the match row
 * @param {object|null} homeTeam the home team record
 * @param {object|null} awayTeam the away team record
 */
export function liveTeamIdentity(match, homeTeam, awayTeam) {
  const teamAKey = match?.coinTossTeamA || 'home'
  const of = (side) => {
    const team = side === 'home' ? homeTeam : awayTeam
    const name = match?.[MIRROR[side].name] || team?.name
    const short = match?.[MIRROR[side].shortName] || team?.shortName || name?.substring(0, 3).toUpperCase()
    return { name, short, color: effectiveTeamColour(side, team, match) }
  }
  const a = of(teamAKey)
  const b = of(teamAKey === 'home' ? 'away' : 'home')
  return {
    teamAKey,
    teamAName: a.name,
    teamAShort: a.short,
    teamAColor: a.color,
    teamBName: b.name,
    teamBShort: b.short,
    teamBColor: b.color
  }
}
