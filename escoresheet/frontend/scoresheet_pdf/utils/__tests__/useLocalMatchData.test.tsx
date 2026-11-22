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

const slow = vi.hoisted(() => ({ ms: 0, fail: null as Error | null, reads: 0 }));
vi.mock('../matchData', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../matchData')>();
  return {
    ...orig,
    loadLocalMatchData: async (db: any, id: unknown) => {
      slow.reads++;
      if (slow.fail) throw slow.fail;
      const data = await orig.loadLocalMatchData(db, id);
      // the read is done, but the thread only gets to it this much later
      if (slow.ms) await new Promise((r) => setTimeout(r, slow.ms));
      return data;
    }
  };
});

import { db as appDb } from '../../../src/db/db';
import { useLocalMatchData, touchesMatchData, matchDataChange } from '../useLocalMatchData';

// the app's database (src/db/db.js: its tables are not typed)
const db: any = appDb;

function Sheet({ matchId, refresh = 0 }: { matchId: unknown; refresh?: number }) {
  const data = useLocalMatchData(db, matchId, refresh);
  if (data === undefined) return <div data-testid="sheet">Loading scoresheet...</div>;
  if (data === null) return <div data-testid="sheet">not found</div>;
  return (
    <>
      <div data-testid="sheet">{`${data.match.gameNumber} events ${data.events.length}`}</div>
      <div data-testid="remarks">{data.match.remarks ?? ''}</div>
    </>
  );
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
afterEach(() => { cleanup(); slow.ms = 0; slow.fail = null; slow.reads = 0; vi.restoreAllMocks(); });

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
    // a printed field: the whole match is read again, and that read fails
    const before = slow.reads;
    await db.matches.update(matchId, { remarks: 'read with the database closed' });
    await waitFor(() => expect(slow.reads).toBe(before + 1));
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

// Perf pass 22.11.2026: on the in-app view every full read (all events, one
// transaction) and the sheet it rebuilds ran on the scorer's thread, also for
// writes the sheet does not print (the heartbeat's updatedAt, another match's
// row). Those now read the match row alone; anything else reads as before.
describe('useLocalMatchData: a write the sheet does not print reads nothing more', () => {
  // the notices of a write have arrived and been handled
  const settle = () => new Promise((r) => setTimeout(r, 100));
  async function shown(gameNumber: number, events = 2) {
    const matchId = await addMatch(gameNumber, events);
    const view = render(<Sheet matchId={matchId} />);
    await waitFor(() => expect(view.getByTestId('sheet').textContent).toBe(`${gameNumber} events ${events}`));
    await settle();
    return { matchId, view, reads: slow.reads };
  }
  // a notice as it arrives from another page (the scorer's under the in-app
  // view): Dexie's BroadcastChannel, its values plain objects
  async function noticeFromAnotherPage(parts: Record<string, unknown>) {
    const channel = new BroadcastChannel('x-storagemutated-1');
    channel.postMessage(parts);
    channel.close();
    await settle();
  }

  it('the heartbeat and other bookkeeping of the shown match read nothing', async () => {
    const { matchId, view, reads } = await shown(2001);
    await db.matches.update(matchId, { updatedAt: new Date().toISOString() });
    await db.matches.update(matchId, { scorerHeartbeat: Date.now(), lastSeenReferee: Date.now(), synced: true, _syncedAt: 'x', lastUpdated: 1 });
    await settle();
    expect(slow.reads).toBe(reads);
    expect(view.getByTestId('sheet').textContent).toBe('2001 events 2');
  });

  it("another match's row reads nothing (written, added or deleted)", async () => {
    const other = await addMatch(2099, 1);
    const { reads } = await shown(2002);
    await db.matches.update(other, { remarks: 'another match', status: 'ended' });
    const added = await db.matches.add({ status: 'live', test: true, gameNumber: 2098 });
    await db.matches.delete(added);
    await settle();
    expect(slow.reads).toBe(reads);
  });

  it('a printed field of the match row (remarks) reads the match again and shows it', async () => {
    const { matchId, view, reads } = await shown(2003);
    await db.matches.update(matchId, { remarks: 'Protest by team A', updatedAt: new Date().toISOString() });
    await waitFor(() => expect(view.getByTestId('remarks').textContent).toBe('Protest by team A'));
    expect(slow.reads).toBe(reads + 1);
  });

  it('a write to the events, sets, players or teams reads the match again, whichever row', async () => {
    const { matchId, view, reads } = await shown(2004);
    await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 3, payload: {} });
    await waitFor(() => expect(view.getByTestId('sheet').textContent).toBe('2004 events 3'));
    await settle();
    expect(slow.reads).toBe(reads + 1);
    // an undo deletes by primary key: its notice does not name the match
    await db.events.where('matchId').equals(matchId).and((e: any) => e.seq === 3).delete();
    await waitFor(() => expect(view.getByTestId('sheet').textContent).toBe('2004 events 2'));
    await settle();
    expect(slow.reads).toBe(reads + 2);
    await db.sets.where('matchId').equals(matchId).modify({ homePoints: 1 });
    await waitFor(() => expect(slow.reads).toBe(reads + 3));
    await settle();
    await db.players.add({ teamId: 999999, number: 7, name: 'Not on this sheet' });
    await waitFor(() => expect(slow.reads).toBe(reads + 4));
    await settle();
    await db.teams.add({ name: 'Not on this sheet' });
    await waitFor(() => expect(slow.reads).toBe(reads + 5));
  });

  it("deleting the shown match shows it as not on this device", async () => {
    const { matchId, view } = await shown(2005);
    await db.matches.delete(matchId);
    await waitFor(() => expect(view.getByTestId('sheet').textContent).toBe('not found'));
  });

  it("a notice from another page: 'all' and the five tables read again, match rows are checked", async () => {
    const { matchId, view, reads } = await shown(2006);
    await noticeFromAnotherPage({ all: { from: [], to: [] } });
    expect(slow.reads).toBe(reads + 1);
    await noticeFromAnotherPage({ 'idb://escoresheet/events/matchId': { d: 1 } });
    expect(slow.reads).toBe(reads + 2);
    // match rows only, the row unchanged: nothing read
    await noticeFromAnotherPage({ 'idb://escoresheet/matches/': { d: 1 }, 'idb://escoresheet/sync_queue/': { d: 1 } });
    expect(slow.reads).toBe(reads + 2);
    // ... changed (written straight into IndexedDB, no notice of its own): read again
    const raw: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open('escoresheet');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = raw.transaction('matches', 'readwrite');
      const store = tx.objectStore('matches');
      const get = store.get(matchId);
      get.onsuccess = () => store.put({ ...get.result, remarks: 'from the scorer' });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    raw.close();
    await noticeFromAnotherPage({ 'idb://escoresheet/matches/': { d: 1 } });
    await waitFor(() => expect(view.getByTestId('remarks').textContent).toBe('from the scorer'));
    expect(slow.reads).toBe(reads + 3);
  });

  it('a change heard during a read is checked against the newest data once it is done', async () => {
    const matchId = await addMatch(2007, 2);
    slow.ms = 150;
    const { getByTestId } = render(<Sheet matchId={matchId} />);
    // while the first read waits: a heartbeat, then a printed change
    await waitFor(() => expect(slow.reads).toBe(1));
    await db.matches.update(matchId, { updatedAt: new Date().toISOString() });
    await waitFor(() => expect(getByTestId('sheet').textContent).toBe('2007 events 2'), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 400));
    // the heartbeat after the read: the row shown is still right, nothing read
    expect(slow.reads).toBe(1);
    // a printed change during a read (the second one) is not lost
    await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 3, payload: {} });
    await waitFor(() => expect(slow.reads).toBe(2));
    await db.matches.update(matchId, { remarks: 'changed during the read' });
    await waitFor(() => expect(getByTestId('remarks').textContent).toBe('changed during the read'), { timeout: 2000 });
    expect(getByTestId('sheet').textContent).toBe('2007 events 3');
    // (a third read only when the second did not see the remarks yet)
    expect(slow.reads).toBeLessThanOrEqual(3);
  });
});

describe('matchDataChange', () => {
  it('names match rows only, everything, or nothing', () => {
    expect(matchDataChange('escoresheet', { 'idb://escoresheet/matches/': {} })).toBe('match');
    expect(matchDataChange('escoresheet', { 'idb://escoresheet/matches/:dels': {}, 'idb://escoresheet/matches/status': {} })).toBe('match');
    // other tables in the same notice do not count
    expect(matchDataChange('escoresheet', { 'idb://escoresheet/matches/': {}, 'idb://escoresheet/sync_queue/': {} })).toBe('match');
    expect(matchDataChange('escoresheet', { 'idb://escoresheet/matches/': {}, 'idb://escoresheet/events/': {} })).toBe('all');
    for (const table of ['teams', 'players', 'sets', 'events']) {
      expect(matchDataChange('escoresheet', { [`idb://escoresheet/${table}/`]: {} })).toBe('all');
    }
    expect(matchDataChange('escoresheet', { all: {} })).toBe('all');
    expect(matchDataChange('escoresheet', { 'idb://other/events/': {}, 'idb://escoresheet/sync_queue/': {} })).toBe('none');
    expect(matchDataChange('escoresheet', null)).toBe('none');
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
