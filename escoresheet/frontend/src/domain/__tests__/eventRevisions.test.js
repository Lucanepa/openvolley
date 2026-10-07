import { describe, it, expect } from 'vitest'
import {
  editOf, applyMods, withoutSnapshot, serverColumnsOfEdit, snapshotScore, revisionSyncJob, revisionOfJob,
  normalizeReason
} from '../eventRevisions'
import { eventExtId } from '../../utils/syncIds'

describe('eventRevisions', () => {
  it('editOf ignores bookkeeping, unchanged values and the first snapshot fill', () => {
    const stored = { id: 1, type: 'point', payload: { team: 'home' }, stateSnapshot: null }
    expect(editOf({ stateSnapshot: { pointsA: 1 } }, stored)).toBeNull()
    expect(editOf({ _synced: true, synced: 1 }, stored)).toBeNull()
    expect(editOf({ payload: { team: 'home' } }, stored)).toBeNull()
    expect(editOf({ 'payload.team': 'away' }, stored)).toEqual(['payload.team'])
    expect(editOf({ stateSnapshot: { pointsA: 2 } }, { ...stored, stateSnapshot: { pointsA: 1 } })).toEqual(['stateSnapshot'])
    // a fill together with a real change: only the change counts
    expect(editOf({ stateSnapshot: { pointsA: 1 }, setIndex: 2 }, { ...stored, setIndex: 1 })).toEqual(['setIndex'])
  })

  it('applyMods applies key paths without touching the stored row', () => {
    const stored = { payload: { team: 'home', n: 1 } }
    const after = applyMods(stored, { 'payload.team': 'away', setIndex: 3 })
    expect(after).toEqual({ payload: { team: 'away', n: 1 }, setIndex: 3 })
    expect(stored.payload.team).toBe('home')
  })

  it('withoutSnapshot drops the snapshot and bookkeeping keys', () => {
    expect(withoutSnapshot({ id: 1, stateSnapshot: { a: 1 }, _x: 1, synced: true, type: 't' })).toEqual({ id: 1, type: 't' })
  })

  it('serverColumnsOfEdit maps to server columns, scores from the snapshot, never a snapshot', () => {
    const before = { type: 'sanction', setIndex: 1, payload: { team: 'home' }, stateSnapshot: { scoreA: 1, scoreB: 2 } }
    const after = { ...before, payload: { team: 'away', removedSubEvents: [{ id: 3, stateSnapshot: { big: 1 } }] }, stateSnapshot: { scoreA: 3, scoreB: 2 } }
    expect(serverColumnsOfEdit(before, after)).toEqual({ type: 'sanction', set_index: 1, payload: { team: 'away', removedSubEvents: [{ id: 3 }] }, score_a: 3, score_b: 2 })
    expect(serverColumnsOfEdit(before, { ...after, stateSnapshot: null })).not.toHaveProperty('score_a')
    expect(snapshotScore({ pointsA: 4, pointsB: 5 })).toEqual({ a: 4, b: 5 })
  })

  it('revisionSyncJob: only cloud matches and synced event types', () => {
    const row = { revUid: 'u', eventId: 7, op: 'void', reason: 'undo', seq: 3, setIndex: 1, type: 'point', ts: '2026-10-07T10:00:00.000Z', deviceId: 'd', appVersion: '1' }
    const job = revisionSyncJob(row, { seedKey: 'match_1_x', test: false }, eventExtId)
    expect(job).toMatchObject({ resource: 'event', action: 'void', status: 'queued' })
    expect(job.payload).toMatchObject({ external_id: 'match_1_x:e:7', match_id: 'match_1_x', rev_uid: 'u', op: 'void', reason: 'undo', client_ts: row.ts })
    expect(revisionSyncJob(row, { seedKey: 'match_1_x', test: true }, eventExtId)).toBeNull()
    expect(revisionSyncJob(row, { seedKey: null }, eventExtId)).toBeNull()
    expect(revisionSyncJob({ ...row, type: 'rally_start' }, { seedKey: 'match_1_x' }, eventExtId)).toBeNull()
    const edit = revisionSyncJob({ ...row, op: 'edit', serverAfter: { type: 'point' } }, { seedKey: 'match_1_x' }, eventExtId)
    expect(edit.payload.after).toEqual({ type: 'point' })
  })

  it('revisionOfJob builds the route body and normalises the reason', () => {
    expect(revisionOfJob({ op: 'void', rev_uid: 'u', external_id: 'm:e:1', reason: 'nonsense', client_ts: 't' }))
      .toMatchObject({ rev_uid: 'u', op: 'void', event_external_id: 'm:e:1', reason: 'delete' })
    expect(revisionOfJob({ op: 'insert', rev_uid: 'u', external_id: 'x' })).toBeNull()
    expect(normalizeReason('undo')).toBe('undo')
  })
})
