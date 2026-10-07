// Opening the app database over an existing v18 database (real Dexie on
// fake-indexeddb): v19 adds the saved-team cache tables without touching the
// match data, and the upgrade never rejects.
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { describe, it, expect } from 'vitest'

const V18_STORES = {
  teams: '++id,name,createdAt',
  players: '++id,teamId,number,name,role,createdAt',
  matches: '++id,homeTeamId,awayTeamId,scheduledAt,status,createdAt,externalId,test',
  sets: '++id,matchId,index,homePoints,awayPoints,finished,startTime,endTime',
  events: '++id,matchId,setIndex,ts,type,payload,seq,stateSnapshot,[matchId+seq],[matchId+setIndex]',
  sync_queue: '++id,resource,action,payload,ts,status',
  match_setup: '++id,updatedAt',
  referees: '++id,seedKey,lastName,createdAt',
  scorers: '++id,seedKey,lastName,createdAt',
  interaction_logs: 'id,ts,gameNumber,category,sessionId'
}

describe('Dexie v19 + v20 upgrade', () => {
  it('keeps the v18 data and adds the saved-team and logging tables', async () => {
    const old = new Dexie('escoresheet')
    old.version(18).stores(V18_STORES)
    await old.open()
    const matchId = await old.table('matches').add({ status: 'live', seed_key: 'match_1_a', bestOf: 5 })
    await old.table('sync_queue').add({ resource: 'match', action: 'insert', payload: { external_id: 'match_1_a' }, ts: 1, status: 'queued' })
    old.close()

    const { db } = await import('../db')
    await db.open()
    expect(db.verno).toBe(20)
    expect((await db.matches.get(matchId)).seed_key).toBe('match_1_a')
    expect(await db.sync_queue.count()).toBe(1)
    await db.saved_teams.put({ id: 't1', competitionId: 'c1', nameKey: 'a', svrzKey: '' })
    await db.saved_teams_meta.put({ key: 'bundle', version: '1', fetchedAt: new Date().toISOString(), userId: 'u' })
    expect(await db.saved_teams.where('competitionId').equals('c1').count()).toBe(1)
    // v20: the logging tables, and interaction_logs gained its matchId index
    await db.activity_log.add({ uid: 'a', ts: '2026-10-07T00:00:00.000Z', matchId: matchId, kind: 'app.start', synced: 0 })
    await db.event_history.add({ revUid: 'r', matchId, seq: 3, eventId: 1, ts: 't' })
    await db.interaction_logs.put({ id: 'l1', ts: 1, gameNumber: null, matchId, category: 'ui', sessionId: 's' })
    expect(await db.interaction_logs.where('matchId').equals(matchId).count()).toBe(1)
    expect(await db.activity_log.where('[matchId+ts]').between([matchId, ''], [matchId, '\uffff']).count()).toBe(1)
    db.close()
  })
})
