/**
 * The scoresheet's input (App_Scoresheet `matchData`), one shape for every
 * renderer (owner 2026-11-16: "all scoresheet renderers use the same logic, so
 * we don't have different scoresheets"). See docs/scoresheet/code-map.md,
 * "Renderers".
 *
 * Every source builds the same object:
 *   { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events, sanctions: [] }
 * - this device's database: loadLocalMatchData (the scorer's own sheet, the
 *   approval's PDF window, the archive site's ?matchId=);
 * - the server's record: src/utils/scoresheetFromCloud.js (Rebuild PDF);
 * - the relay bundle: src/components/referee/scoresheetInput.js (referee tablet);
 * - a stored or imported JSON: the same object, saved by an earlier app.
 * App_Scoresheet passes whatever it gets through normalizeMatchData, so the
 * lists are always in the same order and of the same kinds, whichever source
 * drew them: sets by index, events by seq (stable, a missing seq last).
 */

export interface MatchData {
  match: Record<string, any>;
  homeTeam: Record<string, any> | null;
  awayTeam: Record<string, any> | null;
  homePlayers: any[];
  awayPlayers: any[];
  sets: any[];
  events: any[];
  sanctions: any[];
}

const list = (v: unknown): any[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

/** Events in the scorer's order: seq (a decimal seq is a point's sub-event), stable for equal or missing seq (those last). */
export function eventsBySeq<T extends { seq?: unknown }>(events: unknown): T[] {
  return list(events)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const sa = Number(a.e.seq);
      const sb = Number(b.e.seq);
      const fa = a.e.seq !== null && a.e.seq !== undefined && a.e.seq !== '' && Number.isFinite(sa);
      const fb = b.e.seq !== null && b.e.seq !== undefined && b.e.seq !== '' && Number.isFinite(sb);
      if (fa && fb && sa !== sb) return sa - sb;
      if (fa !== fb) return fa ? -1 : 1;
      return a.i - b.i;
    })
    .map(({ e }) => e as T);
}

/** Sets by index (stable). */
export function setsByIndex<T extends { index?: unknown }>(sets: unknown): T[] {
  return list(sets)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => ((Number(a.s.index) || 0) - (Number(b.s.index) || 0)) || a.i - b.i)
    .map(({ s }) => s as T);
}

const teamOf = (t: unknown): Record<string, any> | null =>
  typeof t === 'string' ? (t ? { name: t } : null) : (t && typeof t === 'object' ? (t as Record<string, any>) : null);

/** The one shape every renderer hands to the sheet (never throws; a partial or older object is filled in). */
export function normalizeMatchData(raw: any): MatchData {
  const m = raw && typeof raw === 'object' ? raw : {};
  return {
    match: m.match && typeof m.match === 'object' ? m.match : {},
    homeTeam: teamOf(m.homeTeam),
    awayTeam: teamOf(m.awayTeam),
    homePlayers: list(m.homePlayers),
    awayPlayers: list(m.awayPlayers),
    sets: setsByIndex(m.sets),
    events: eventsBySeq(m.events),
    sanctions: []
  };
}

/**
 * A match from this device's database in one read transaction (the sets of
 * one moment are never paired with the events of another: "the points
 * recorded (2:2) do not match the set score (3:2)"). null when the match is
 * not on this device.
 */
export async function loadLocalMatchData(db: any, matchId: unknown): Promise<MatchData | null> {
  const id = typeof matchId === 'string' && matchId !== '' && !Number.isNaN(Number(matchId)) ? Number(matchId) : matchId;
  if (id === null || id === undefined || id === '') return null;
  return db.transaction('r', [db.matches, db.teams, db.players, db.sets, db.events], async () => {
    const match = await db.matches.get(id);
    if (!match) return null;
    const [homeTeam, awayTeam, homePlayers, awayPlayers, sets, events] = await Promise.all([
      match.homeTeamId ? db.teams.get(match.homeTeamId) : null,
      match.awayTeamId ? db.teams.get(match.awayTeamId) : null,
      match.homeTeamId ? db.players.where('teamId').equals(match.homeTeamId).toArray() : [],
      match.awayTeamId ? db.players.where('teamId').equals(match.awayTeamId).toArray() : [],
      db.sets.where('matchId').equals(id).toArray(),
      db.events.where('matchId').equals(id).toArray()
    ]);
    return normalizeMatchData({ match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events });
  });
}
