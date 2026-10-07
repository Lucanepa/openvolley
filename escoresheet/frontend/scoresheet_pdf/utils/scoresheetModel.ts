/**
 * Pure derivations from the match event log for the official scoresheet.
 *
 * No React, no Dexie — every function takes plain events/match objects so the
 * printed sheet can be unit-tested against the event model Scoreboard writes.
 *
 * Event model notes (Scoreboard.jsx):
 *  - A 'lineup' event is written for the initial lineup (payload.isInitial === true),
 *    for a pre-rally FIVB 7.3.4 rectification (openManualLineup, isInitial false), and
 *    on EVERY rotation (unflagged, or fromRotation), substitution (fromSubstitution)
 *    and libero swap (liberoSubstitution). The starting lineup is the last entered
 *    lineup before the set's first point.
 *  - Exceptional substitutions are 'substitution' events with payload.isExceptional;
 *    they do not count towards the 6 regular substitutions.
 *  - The deciding set is always stored at index 5, also in best-of-3 matches.
 */

export const POSITIONS = ['I', 'II', 'III', 'IV', 'V', 'VI'] as const;

type TeamKey = 'home' | 'away';

/** Sort comparator used throughout the scoresheet: seq first, timestamp as fallback. */
export function compareEventsBySeq(a: any, b: any): number {
  const aSeq = a?.seq || 0;
  const bSeq = b?.seq || 0;
  if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq;
  return new Date(a?.ts).getTime() - new Date(b?.ts).getTime();
}

/** Convert a lineup payload ({ I: 5, II: 7, ... }) to a 6-slot string array (I-VI). */
export function lineupToArray(lineupObj: any): string[] {
  const obj = lineupObj || {};
  return POSITIONS.map(pos => (obj[pos] !== undefined && obj[pos] !== null && obj[pos] !== '' ? String(obj[pos]) : ''));
}

const hasAnyPlayer = (e: any) => lineupToArray(e?.payload?.lineup).some(n => n !== '');

/**
 * A lineup the scorer entered through the line-up form: the initial lineup
 * (isInitial true) or a FIVB 7.3.4 rectification (mode 'manual', isInitial false).
 * Rotation, substitution and libero lineups are derived states, never a starting lineup.
 */
const isEnteredLineup = (e: any) => {
  const p = e?.payload || {};
  return typeof p.isInitial === 'boolean'
    && !p.fromSubstitution
    && !p.fromRotation
    && (p.liberoSubstitution === undefined || p.liberoSubstitution === null)
    && hasAnyPlayer(e);
};

/**
 * The lineup event that holds a team's starting lineup for a set.
 *
 *  1. The latest entered lineup (initial or pre-rally rectification, FIVB 7.3.4) logged
 *     before the set's first point - Scoreboard only allows a rectification before the
 *     first rally, and a mid-set re-prompt (e.g. after a libero redesignation) must not
 *     overwrite the lineup the set started with. With no points yet, the latest one.
 *  2. Fallback when nothing qualifies (e.g. odd ordering): the first non-empty isInitial lineup.
 *  3. Legacy data without the flag: the first non-empty lineup event of the set.
 */
export function getStartingLineupEvent(events: any[], setIndex: number, team: TeamKey): any | undefined {
  const all = events || [];
  const lineups = all
    .filter(e => e?.type === 'lineup' && e.setIndex === setIndex && e.payload?.team === team)
    .sort(compareEventsBySeq);
  const firstPoint = all
    .filter(e => e?.type === 'point' && e.setIndex === setIndex)
    .sort(compareEventsBySeq)[0];

  const preRally = lineups.filter(e =>
    isEnteredLineup(e) && (!firstPoint || compareEventsBySeq(e, firstPoint) < 0)
  );
  if (preRally.length > 0) return preRally[preRally.length - 1];

  const initial = lineups.find(e => e.payload?.isInitial === true && hasAnyPlayer(e));
  if (initial) return initial;
  return lineups.find(hasAnyPlayer) || lineups[0];
}

/** Starting lineup (positions I-VI) of a team in a set, as printed in the "starting players" row. */
export function getStartingLineup(events: any[], setIndex: number, team: TeamKey): string[] {
  return lineupToArray(getStartingLineupEvent(events, setIndex, team)?.payload?.lineup);
}

/**
 * Place per-starter substitution records into the six position columns.
 * `subsByStarter` is keyed by the starting player's number; columns follow the
 * STARTING lineup, so a substitution that is still open at set end (the
 * substitute is on court, the starter is not) stays in its column.
 */
export function assignSubsToColumns<T>(subsByStarter: Map<number, T[]>, startingLineup: string[]): T[][] {
  const result: T[][] = [[], [], [], [], [], []];
  startingLineup.forEach((playerNum, positionIndex) => {
    if (positionIndex > 5 || !playerNum || playerNum.trim() === '') return;
    const playerNumInt = parseInt(playerNum, 10);
    if (!isNaN(playerNumInt) && subsByStarter.has(playerNumInt)) {
      result[positionIndex] = subsByStarter.get(playerNumInt)!;
    }
  });
  return result;
}

/** Regular (non-exceptional) substitutions of a team: the 6-substitution limit (FIVB 15.6). */
export function countRegularSubstitutions(setEvents: any[], team: TeamKey): number {
  return (setEvents || []).filter(e =>
    e?.type === 'substitution' && e.payload?.team === team && !e.payload?.isExceptional
  ).length;
}

/**
 * Every substitution of a team in a set, exceptional ones included: the RESULT
 * "S" column (field-spec 9 / 12.1; SC p.71 counts "4 standard + 1 exceptional" as 5).
 */
export function countAllSubstitutions(setEvents: any[], team: TeamKey): number {
  return (setEvents || []).filter(e => e?.type === 'substitution' && e.payload?.team === team).length;
}

/**
 * Set number as printed on the sheet. The deciding set is stored at index 5 in both
 * formats, but in best-of-3 it is the 3rd set played (Swiss Matchblatt numbers 1,2,3).
 */
export function displaySetNumber(setIndex: number, bestOf: number | undefined): number {
  return (bestOf || 5) === 3 && setIndex === 5 ? 3 : setIndex;
}

/**
 * Home/away score at the moment `target` was logged: points of the same set that
 * come before it in the event order (seq, timestamp only when seq is missing).
 */
export function getScoreBeforeEvent(events: any[], target: any): { home: number; away: number } {
  let home = 0;
  let away = 0;
  for (const e of events || []) {
    if (e === target || e?.type !== 'point' || e.setIndex !== target?.setIndex) continue;
    if (compareEventsBySeq(e, target) > 0) continue;
    if (e.payload?.team === 'home') home++;
    else if (e.payload?.team === 'away') away++;
  }
  return { home, away };
}

/**
 * Team label ('A'|'B') starting the deciding set on the left (the panel 1/3 team).
 * Falls back like Scoreboard does when the set-5 toss was never stored:
 * teams switched as in sets 2 and 4, i.e. Team B on the left.
 */
export function getSet5LeftTeamLabel(match: any): 'A' | 'B' {
  if (match?.set5LeftTeam === 'A' || match?.set5LeftTeam === 'B') return match.set5LeftTeam;
  return 'B';
}

/**
 * Team key serving first in a set.
 *  - Set 1 server: coinTossServeA (truthy = A), else match.firstServe, else Team B.
 *  - Odd sets (1, 3): set 1 server; even sets (2, 4): the other team.
 *  - Deciding set (index 5): set5FirstServe ('A'|'B') from the deciding-set toss,
 *    else the set 1 server (same fallback as domain/rules getFirstServeForSet).
 */
export function getFirstServeTeamKey(setIndex: number, match: any, teamAKey: TeamKey, teamBKey: TeamKey): TeamKey {
  let set1Server: TeamKey;
  if (match?.coinTossServeA !== undefined && match?.coinTossServeA !== null) {
    set1Server = match.coinTossServeA ? teamAKey : teamBKey;
  } else if (match?.firstServe === 'home' || match?.firstServe === 'away') {
    set1Server = match.firstServe;
  } else {
    set1Server = teamBKey;
  }
  const other: TeamKey = set1Server === 'home' ? 'away' : 'home';

  if (setIndex === 5) {
    if (match?.set5FirstServe === 'A') return teamAKey;
    if (match?.set5FirstServe === 'B') return teamBKey;
    return set1Server;
  }
  return setIndex % 2 === 1 ? set1Server : other;
}

/**
 * Consistency checks before the sheet is printed (field-spec 12.2). They never
 * change the sheet: the scoresheet window lists them above it (not in the PDF)
 * so the scorer can correct the match before approving it.
 */
export function consistencyWarnings({ sets, events, teamAKey, homePlayers, awayPlayers }: {
  sets: any[]
  events: any[]
  teamAKey: TeamKey
  homePlayers?: any[]
  awayPlayers?: any[]
}): string[] {
  const out: string[] = []
  const letter = (t: TeamKey) => (t === teamAKey ? 'A' : 'B')
  const roster: Record<TeamKey, Set<string>> = {
    home: new Set((homePlayers || []).map(p => String(p?.number ?? '')).filter(Boolean)),
    away: new Set((awayPlayers || []).map(p => String(p?.number ?? '')).filter(Boolean))
  }
  for (const set of (sets || []).filter(Boolean).sort((a, b) => a.index - b.index)) {
    const n = displaySetNumber(set.index, undefined)
    const setEvents = (events || []).filter(e => e?.setIndex === set.index)
    const pts = { home: 0, away: 0 }
    for (const e of setEvents) if (e.type === 'point' && (e.payload?.team === 'home' || e.payload?.team === 'away')) pts[e.payload.team as TeamKey]++
    const hasPoints = pts.home + pts.away > 0
    if (hasPoints && (pts.home !== (set.homePoints || 0) || pts.away !== (set.awayPoints || 0))) {
      out.push(`Set ${n}: the points recorded (${pts.home}:${pts.away}, home:away) do not match the set score (${set.homePoints || 0}:${set.awayPoints || 0}).`)
    }
    for (const team of ['home', 'away'] as TeamKey[]) {
      const subs = countRegularSubstitutions(setEvents, team)
      if (subs > 6) out.push(`Set ${n}, Team ${letter(team)}: ${subs} regular substitutions (at most 6).`)
      const tos = setEvents.filter(e => e.type === 'timeout' && e.payload?.team === team).length
      if (tos > 2) out.push(`Set ${n}, Team ${letter(team)}: ${tos} time-outs (at most 2).`)
      if (roster[team].size > 0) {
        const missing = getStartingLineup(events, set.index, team).filter(num => num && !roster[team].has(num))
        if (missing.length) out.push(`Set ${n}, Team ${letter(team)}: starting player${missing.length > 1 ? 's' : ''} ${missing.join(', ')} not on the roster.`)
      }
    }
  }
  return out
}
