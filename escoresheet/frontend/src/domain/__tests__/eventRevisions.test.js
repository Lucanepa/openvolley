import { describe, it, expect } from 'vitest'
import {
  editOf, applyMods, withoutSnapshot, serverColumnsOfEdit, snapshotScore, revisionSyncJob, revisionOfJob,
  normalizeReason, runningScoreAfterEdit, REVISION_REASONS
} from '../eventRevisions'
import { decisionChangeUndoRecord } from '../corrections'
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
    expect(normalizeReason('correction')).toBe('correction')
    expect(REVISION_REASONS).toContain('correction')
  })

  it('serverColumnsOfEdit sends the seq (a correction renumbers events)', () => {
    const before = { type: 'timeout', setIndex: 2, seq: 14, payload: { team: 'home' } }
    expect(serverColumnsOfEdit(before, { ...before, seq: 15 })).toMatchObject({ seq: 15, set_index: 2 })
    expect(serverColumnsOfEdit({ type: 'x' }, { type: 'x' })).not.toHaveProperty('seq')
  })

  describe('decision change: the running score of the swapped point (leftover a)', () => {
    // 14:12 for home (Team A) after this point, logged for home
    const snap = { teamAKey: 'home', pointsA: 14, pointsB: 12 }
    const point = { id: 40, type: 'point', setIndex: 1, seq: 40, payload: { team: 'home' }, stateSnapshot: snap }
    const swapped = { ...point, payload: { team: 'away', swappedFrom: 'home' } }

    it('the swap sends the score of the points after it, not the snapshot\'s', () => {
      expect(serverColumnsOfEdit(point, swapped)).toMatchObject({ score_a: 13, score_b: 13, payload: { team: 'away' } })
      // Team A is away: the same swap counts the other way round
      const awayA = { ...snap, teamAKey: 'away', pointsA: 12, pointsB: 14 }
      expect(runningScoreAfterEdit({ ...point, stateSnapshot: awayA }, { ...swapped, stateSnapshot: awayA })).toEqual({ a: 13, b: 13 })
    })

    it('undoing the swap goes back to the snapshot score; a second swap too', () => {
      expect(runningScoreAfterEdit(swapped, point)).toEqual({ a: 14, b: 12 })
      const backAgain = { ...point, payload: { team: 'home', swappedFrom: 'away' } }
      expect(runningScoreAfterEdit(swapped, backAgain)).toEqual({ a: 14, b: 12 })
    })

    it('an edit that does not move the point keeps the snapshot score', () => {
      expect(runningScoreAfterEdit(point, { ...point, payload: { team: 'home', note: 1 } })).toEqual({ a: 14, b: 12 })
      // a rewritten snapshot is the score to send
      const rewritten = { ...swapped, stateSnapshot: { ...snap, pointsA: 13, pointsB: 13 } }
      expect(runningScoreAfterEdit(point, rewritten)).toEqual({ a: 13, b: 13 })
    })

    it('without Team A in the snapshot the score columns are left out', () => {
      const noKey = { pointsA: 14, pointsB: 12 }
      const cols = serverColumnsOfEdit({ ...point, stateSnapshot: noKey }, { ...swapped, stateSnapshot: noKey })
      expect(cols).not.toHaveProperty('score_a')
      expect(cols).not.toHaveProperty('score_b')
    })
  })

  it('the undo record written into a decision_change event is not an edit (leftover b)', () => {
    const stored = { id: 41, type: 'decision_change', payload: { reason: 'point_swap', fromTeam: 'home', toTeam: 'away' } }
    const record = decisionChangeUndoRecord({ id: 40, payload: { team: 'home' } }, [{ id: 39, type: 'lineup' }], [42])
    expect(editOf({ payload: { ...stored.payload, ...record } }, stored)).toBeNull()
    expect(editOf({ 'payload.createdSubEventIds': [42, 43] }, stored)).toBeNull()
    // anything else of the decision_change event still is
    expect(editOf({ payload: { ...stored.payload, toTeam: 'home', ...record } }, stored)).toEqual(['payload'])
    expect(editOf({ seq: 9 }, stored)).toEqual(['seq'])
    // the same keys on another event type are an edit
    expect(editOf({ 'payload.pointEventId': 3 }, { ...stored, type: 'point' })).toEqual(['payload.pointEventId'])
  })
})
