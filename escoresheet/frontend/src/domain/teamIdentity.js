/**
 * A team's labels outside the official sheet's fixed data: its name and its
 * shirt colour. Both live twice, on the team record (teams.name, teams.color)
 * and mirrored on the match row (homeName / awayName, homeColor / awayColor),
 * the way Match setup writes them. The scoring screen's live state
 * (team_a_name / team_a_color, read by the referee and bench tablets, the
 * livescore and Point Hub) takes the match's first, so an editor that writes
 * the team record only changed nothing there.
 *
 * Every OpenVolley screen and the sheet show the full name (the short name
 * was retired 26.11.2026). Only the live state still carries team_a_short /
 * team_b_short, derived from the name, for the readers outside this app
 * (Point Hub's LED board, kscw.ch, the public API).
 * Pure: no React, no Dexie.
 */
import { effectiveTeamColour } from '../utils/teamColours'

const MIRROR = {
  home: { name: 'homeName', color: 'homeColor' },
  away: { name: 'awayName', color: 'awayColor' }
}

// Club-type words: dropped from the derived label (any case, with or without dots)
const CLUB_WORDS = new Set([
  'VBC', 'VC', 'VB', 'VBG', 'VG', 'BC', 'TV', 'STV', 'DTV', 'KTV', 'TSV', 'SC', 'KSC', 'SV', 'SG', 'FC', 'USC',
  'VOLLEY', 'VOLLEYBALL', 'VOLLEYBALLCLUB', 'VOLLEYCLUB', 'CLUB', 'TEAM'
])

/**
 * The live state's team_a_short: the name without the club-type words most
 * Swiss names start with ("VBC Klosterau D2" -> "Klosterau D2"; the old first
 * 3 letters gave "VBC" to both teams, 2026-10-21). A name of club words only
 * stays whole.
 */
export function deriveTeamShortLabel(name) {
  if (name == null || String(name).trim() === '') return ''
  const words = String(name).trim().split(/\s+/)
  const kept = words.filter(w => !CLUB_WORDS.has(w.replace(/\./g, '').toLocaleUpperCase()))
  return (kept.length ? kept : words).join(' ')
}

/**
 * The match-row fields to write for team edits: only the fields an editor
 * changed (a name or colour the same as before writes nothing, so a match row
 * whose names come from the server keeps them).
 * @param {{ home?: object|null, away?: object|null }} before the team records as loaded
 * @param {{ home?: object|null, away?: object|null }} after the edited team records
 * @returns {object} e.g. { homeName: 'NEW', awayColor: '#1d4ed8' }
 */
export function teamMirrorPatch(before = {}, after = {}) {
  const patch = {}
  for (const side of ['home', 'away']) {
    const was = before?.[side]
    const now = after?.[side]
    if (!now) continue
    for (const field of ['name', 'color']) {
      if ((now[field] ?? '') !== (was?.[field] ?? '')) patch[MIRROR[side][field]] = now[field]
    }
  }
  return patch
}

/**
 * Team A / B as the live state sends them (team_a_name, team_a_short,
 * team_a_color, ...): the match row's name first, else the team record's; the
 * short label derived from it; the colour the scorer's court shows (the team
 * record's first).
 * @param {object} match the match row
 * @param {object|null} homeTeam the home team record
 * @param {object|null} awayTeam the away team record
 */
export function liveTeamIdentity(match, homeTeam, awayTeam) {
  const teamAKey = match?.coinTossTeamA || 'home'
  const of = (side) => {
    const team = side === 'home' ? homeTeam : awayTeam
    const name = match?.[MIRROR[side].name] || team?.name
    return { name, short: deriveTeamShortLabel(name), color: effectiveTeamColour(side, team, match) }
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
