// Galaxy Tab A7 Lite, Android app 26.11.3, 22.11.2026: during a match (~430
// events, set 3) the scoresheet preview said "Loading scoresheet..." for good.
// The preview is an in-app view, an iframe on the scoring screen's main
// thread; the scoring screen writes the match row every 10 s (heartbeat).
// Dexie's liveQuery throws a read away when a write it observes lands while
// it reads: on that tablet every read took longer than 10 s, so none was ever
// shown. Here a read is held back (the busy thread) longer than the time
// between two writes of the match row.
import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';

const slow = vi.hoisted(() => ({ ms: 0, fail: null as Error | null }));
vi.mock('../matchData', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../matchData')>();
  return {
    ...orig,
    loadLocalMatchData: async (db: any, id: unknown) => {
      if (slow.fail) throw slow.fail;
      const data = await orig.loadLocalMatchData(db, id);
      // the read is done, but the thread only gets to it this much later
      if (slow.ms) await new Promise((r) => setTimeout(r, slow.ms));
      return data;
    }
  };
});

import { db as appDb } from '../../../src/db/db';
import { useLocalMatchData, touchesMatchData } from '../useLocalMatchData';

// the app's database (src/db/db.js: its tables are not typed)
const db: any = appDb;

function Sheet({ matchId, refresh = 0 }: { matchId: unknown; refresh?: number }) {
  const data = useLocalMatchData(db, matchId, refresh);
  if (data === undefined) return <div data-testid="sheet">Loading scoresheet...</div>;
  if (data === null) return <div data-testid="sheet">not found</div>;
  return <div data-testid="sheet">{`${data.match.gameNumber} events ${data.events.length}`}</div>;
}

class Boundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() { return this.state.error ? <div data-testid="sheet">error {this.state.error.message}</div> : this.props.children; }
}

async function addMatch(gameNumber: number, events: number) {
  const matchId = await db.matches.add({ status: 'live', test: true, gameNumber });
  await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false });
  await db.events.bulkAdd(Array.from({ length: events }, (_, i) => ({ matchId, setIndex: 1, type: 'point', seq: i + 1, payload: {} })));
  return matchId as number;
}

let previousAct: unknown;
beforeAll(() => { previousAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });
afterAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = previousAct; });
afterEach(() => { cleanup(); slow.ms = 0; slow.fail = null; vi.restoreAllMocks(); });

describe('useLocalMatchData: the scoresheet shows the match while the scoring screen writes', () => {
  it('shows the match, then the next point, although a write lands during every read', async () => {
    const matchId = await addMatch(4711, 40);
    slow.ms = 60;
    let stop = false;
    let writes = 0;
    // the scoring screen's heartbeat, here faster than one read
    const heartbeat = (async () => {
      while (!stop) {
        await db.matches.update(matchId, { updatedAt: new Date().toISOString() });
        writes++;
        await new Promise((r) => setTimeout(r, 25));
      }
    })();
    try {
      const { getByTestId } = render(<Sheet matchId={matchId} />);
      expect(getByTestId('sheet').textContent).toBe('Loading scoresheet...');
      await waitFor(() => expect(getByTestId('sheet').textContent).toBe('4711 events 40'), { timeout: 5000 });
      // a point scored while the sheet is open is shown too
      await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 41, payload: {} });
      await waitFor(() => expect(getByTestId('sheet').textContent).toBe('4711 events 41'), { timeout: 5000 });
    } finally {
      stop = true;
      await heartbeat;
    }
    expect(writes).toBeGreaterThan(3);
  });

  it('is null for a match that is not on this device', async () => {
    const { getByTestId } = render(<Sheet matchId={987654} />);
    await waitFor(() => expect(getByTestId('sheet').textContent).toBe('not found'));
  });

  it('never shows the previous match after the match id changed', async () => {
    const a = await addMatch(1001, 3);
    const b = await addMatch(1002, 5);
    const { getByTestId, rerender } = render(<Sheet matchId={a} />);
    await waitFor(() => expect(getByTestId('sheet').textContent).toBe('1001 events 3'));
    slow.ms = 50;
    rerender(<Sheet matchId={b} />);
    expect(getByTestId('sheet').textContent).toBe('Loading scoresheet...');
    await waitFor(() => expect(getByTestId('sheet').textContent).toBe('1002 events 5'));
  });

  it('reads again on refresh', async () => {
    const matchId = await addMatch(1003, 2);
    const { getByTestId, rerender } = render(<Sheet matchId={matchId} refresh={0} />);
    await waitFor(() => expect(getByTestId('sheet').textContent).toBe('1003 events 2'));
    // a write Dexie sends no notice of (straight into IndexedDB): the refresh reads it
    const raw: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open('escoresheet');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = raw.transaction('events', 'readwrite');
      tx.objectStore('events').add({ matchId, setIndex: 1, type: 'point', seq: 3, payload: {} });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    raw.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(getByTestId('sheet').textContent).toBe('1003 events 2');
    rerender(<Sheet matchId={matchId} refresh={1} />);
    await waitFor(() => expect(getByTestId('sheet').textContent).toBe('1003 events 3'));
  });

  it('keeps the sheet when a read finds the database closed (Dexie reopens it)', async () => {
    const matchId = await addMatch(1004, 2);
    const { getByTestId } = render(<Boundary><Sheet matchId={matchId} /></Boundary>);
    await waitFor(() => expect(getByTestId('sheet').textContent).toBe('1004 events 2'));
    slow.fail = Object.assign(new Error('closed'), { name: 'DatabaseClosedError' });
    await db.matches.update(matchId, { updatedAt: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 50));
    expect(getByTestId('sheet').textContent).toBe('1004 events 2');
    slow.fail = null;
    await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 3, payload: {} });
    await waitFor(() => expect(getByTestId('sheet').textContent).toBe('1004 events 3'));
  });

  it('throws a failed read to the error boundary, as useLiveQuery did', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    slow.fail = new Error('read failed');
    const { getByTestId } = render(<Boundary><Sheet matchId={1} /></Boundary>);
    await waitFor(() => expect(getByTestId('sheet').textContent).toBe('error read failed'));
    quiet.mockRestore();
  });
});

describe('touchesMatchData', () => {
  it('is true for the tables the sheet reads and for everything', () => {
    expect(touchesMatchData('escoresheet', { 'idb://escoresheet/matches/': {} })).toBe(true);
    expect(touchesMatchData('escoresheet', { 'idb://escoresheet/events/matchId': {} })).toBe(true);
    expect(touchesMatchData('escoresheet', { 'idb://escoresheet/players/teamId': {} })).toBe(true);
    expect(touchesMatchData('escoresheet', { all: {} })).toBe(true);
  });

  it('is false for other tables and other databases', () => {
    expect(touchesMatchData('escoresheet', { 'idb://escoresheet/sync_queue/': {}, 'idb://escoresheet/interaction_logs/matchId': {} })).toBe(false);
    expect(touchesMatchData('escoresheet', { 'idb://other/matches/': {} })).toBe(false);
    expect(touchesMatchData('escoresheet', {})).toBe(false);
    expect(touchesMatchData('escoresheet', null)).toBe(false);
  });
});
