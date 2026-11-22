import { useEffect, useState } from 'react';
import Dexie from 'dexie';
import { loadLocalMatchData, type MatchData } from './matchData';

/**
 * The tables loadLocalMatchData reads: a change to one of them (from this
 * page or, through Dexie's BroadcastChannel, from the scorer's page under it)
 * reads the match again.
 */
export const MATCH_DATA_TABLES = ['matches', 'teams', 'players', 'sets', 'events'] as const;

// Errors a liveQuery does not report either
const IGNORED_ERRORS = ['DatabaseClosedError', 'AbortError'];

/** Whether a Dexie 'storagemutated' notice touches one of the tables (`all`: everything changed). */
export function touchesMatchData(dbName: string, parts: Record<string, unknown> | null | undefined): boolean {
  if (!parts) return false;
  return Object.keys(parts).some((key) =>
    key === 'all' || MATCH_DATA_TABLES.some((table) => key.startsWith(`idb://${dbName}/${table}/`))
  );
}

/**
 * A match from this device's database, kept up to date: undefined while the
 * first read runs, null when the match is not on this device, else the sheet's
 * MatchData (one read transaction: loadLocalMatchData).
 *
 * Not Dexie's liveQuery: a liveQuery throws its result away and reads again
 * when a write it observes lands while it reads, and shows nothing until a
 * read gets through without one. The scoring screen writes the match row
 * every 10 s (its heartbeat, Scoreboard.jsx). On the Android app the
 * scoresheet is an in-app view, an iframe sharing the scoring screen's main
 * thread; on a slow tablet (Galaxy Tab A7 Lite, 22.11.2026, ~430 events in
 * set 3) one read took longer than that, so every read was thrown away and
 * the preview said "Loading scoresheet..." for good. Here every finished read
 * is shown, and a change heard while it ran reads again once it is done (the
 * newest data follows; a burst of changes is one more read).
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
    let reading = false;
    let again = false;
    const read = () => {
      if (closed) return;
      if (reading) { again = true; return; }
      reading = true;
      again = false;
      Promise.resolve()
        .then(() => loadLocalMatchData(db, matchId))
        .then(
          (data) => { if (!closed) setState({ matchId, data }); },
          (error) => {
            // as liveQuery: a closed database (Dexie reopens it) or an
            // aborted read is no error to show; the next change reads again
            if (closed || IGNORED_ERRORS.includes(error?.name)) return;
            setState({ matchId, error });
          }
        )
        .finally(() => {
          reading = false;
          if (again) read();
        });
    };
    const onChange = (parts: Record<string, unknown>) => {
      if (touchesMatchData(db.name, parts)) read();
    };
    Dexie.on('storagemutated', onChange);
    read();
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
