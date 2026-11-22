import { useEffect, useState } from 'react';
import Dexie from 'dexie';
import { loadLocalMatchData, localMatchKey, type MatchData } from './matchData';
import { stableMatch } from '../../src/utils/nativeBackup/redact.js';

/**
 * The tables loadLocalMatchData reads: a change to one of them (from this
 * page or, through Dexie's BroadcastChannel, from the scorer's page under it)
 * reads the match again.
 */
export const MATCH_DATA_TABLES = ['matches', 'teams', 'players', 'sets', 'events'] as const;

// Errors a liveQuery does not report either
const IGNORED_ERRORS = ['DatabaseClosedError', 'AbortError'];

/**
 * What a Dexie 'storagemutated' notice asks of the sheet, from its keys only
 * (over the BroadcastChannel its values arrive as plain objects):
 * - 'none': no table the sheet reads;
 * - 'match': match rows only (a heartbeat, a sync stamp, another match's row):
 *   is this match's row still the one shown?
 * - 'all': everything changed ('all'), or the teams, players, sets or events.
 * Keys of other tables in the same notice do not count.
 */
export function matchDataChange(dbName: string, parts: Record<string, unknown> | null | undefined): 'none' | 'match' | 'all' {
  if (!parts) return 'none';
  let change: 'none' | 'match' = 'none';
  for (const key of Object.keys(parts)) {
    if (key === 'all') return 'all';
    const table = MATCH_DATA_TABLES.find((name) => key.startsWith(`idb://${dbName}/${name}/`));
    if (!table) continue;
    if (table !== 'matches') return 'all';
    change = 'match';
  }
  return change;
}

/** Whether a Dexie 'storagemutated' notice touches one of the tables (`all`: everything changed). */
export function touchesMatchData(dbName: string, parts: Record<string, unknown> | null | undefined): boolean {
  return matchDataChange(dbName, parts) !== 'none';
}

/**
 * A match row as far as the sheet goes: its JSON without the bookkeeping
 * keys (heartbeats, sessions, sync stamps, updatedAt: stableMatch, the
 * backups' own list, nativeBackup/redact.js; the sheet prints none of them).
 * Two rows with the same key are the same for the sheet. null: no row (both
 * missing is the same); undefined: a row it cannot compare (never the same).
 */
export function sheetRowKey(row: unknown): string | null | undefined {
  if (!row) return null;
  try {
    return JSON.stringify(stableMatch(row));
  } catch {
    return undefined;
  }
}

/**
 * A match from this device's database, kept up to date: undefined while the
 * first read runs, null when the match is not on this device, else the sheet's
 * MatchData (one read transaction: loadLocalMatchData).
 *
 * Not Dexie's liveQuery: a liveQuery throws its result away and reads again
 * when a write it observes lands while it reads, and shows nothing until a
 * read gets through without one. On the Android app the scoresheet is an
 * in-app view, an iframe sharing the scoring screen's main thread. The
 * scoring screen then wrote the match row every 10 s (its heartbeat,
 * Scoreboard.jsx; now every 5 min, and not while an in-app view is open); on
 * a slow tablet (Galaxy Tab A7 Lite, 22.11.2026, ~430 events in set 3) one
 * read took longer than that, so every read was thrown away and the preview
 * said "Loading scoresheet..." for good. Here every finished read is shown,
 * and a change heard while it ran is looked at once it is done (against the
 * newest data; a burst of changes is one more turn).
 *
 * A notice of match rows only (matchDataChange 'match': a heartbeat, a sync
 * stamp, another match's row) reads this match's row alone and compares it
 * with the row shown (sheetRowKey, the shown row's kept from its read): the
 * same, nothing is read; changed, gone or unreadable, everything is read
 * again. Any other notice of these tables,
 * and 'all', reads everything again, as before. On the in-app view each full
 * read and the sheet it rebuilds ran on the scorer's thread.
 *
 * `refresh`: read again when it changes (the BroadcastChannel notices of the
 * scorer's manual changes). A failed read is thrown on render, as
 * useLiveQuery did, for the page's ErrorBoundary (not a closed database or
 * an aborted read, which useLiveQuery did not report either).
 */
export function useLocalMatchData(db: any, matchId: unknown, refresh: unknown = 0): MatchData | null | undefined {
  const [state, setState] = useState<{ matchId: unknown; data?: MatchData | null; error?: unknown } | null>(null);

  useEffect(() => {
    let closed = false;
    // one turn at a time: a full read, or the check of this match's row
    let busy = false;
    // what the next turn does ('all' wins over 'match')
    let pending: 'all' | 'match' | null = null;
    // the sheetRowKey of the data shown, made once per read (null: not on
    // this device); undefined: not known (nothing read yet, the last read
    // failed, a row it cannot compare): a check reads everything
    let shownKey: string | null | undefined;

    const readAll = () => loadLocalMatchData(db, matchId).then(
      (data) => {
        if (closed) return;
        shownKey = !data ? null : data.match === undefined ? undefined : sheetRowKey(data.match);
        setState({ matchId, data });
      },
      (error) => {
        shownKey = undefined;
        // as liveQuery: a closed database (Dexie reopens it) or an
        // aborted read is no error to show; the next change reads again
        if (closed || IGNORED_ERRORS.includes(error?.name)) return;
        setState({ matchId, error });
      }
    );
    const checkRow = async () => {
      if (shownKey === undefined) return readAll();
      let row: unknown;
      try {
        const key = localMatchKey(matchId);
        row = key === null ? null : await db.matches.get(key);
      } catch {
        return readAll();
      }
      if (closed) return;
      // only the row just read is turned into JSON: the shown one's is kept
      const rowKey = sheetRowKey(row);
      if (rowKey !== undefined && rowKey === shownKey) return;
      return readAll();
    };
    const run = () => {
      if (closed || busy || !pending) return;
      const job = pending;
      pending = null;
      busy = true;
      Promise.resolve()
        .then(() => (job === 'all' ? readAll() : checkRow()))
        .finally(() => {
          busy = false;
          run();
        });
    };
    const request = (job: 'all' | 'match') => {
      if (closed) return;
      pending = job === 'all' || pending === 'all' ? 'all' : 'match';
      run();
    };
    const onChange = (parts: Record<string, unknown>) => {
      const change = matchDataChange(db.name, parts);
      if (change !== 'none') request(change);
    };
    Dexie.on('storagemutated', onChange);
    request('all');
    return () => {
      closed = true;
      Dexie.on('storagemutated').unsubscribe(onChange);
    };
  }, [db, matchId, refresh]);

  // another match's data is never shown (matchId changed: loading again)
  if (!state || state.matchId !== matchId) return undefined;
  if (state.error) throw state.error;
  return state.data;
}
