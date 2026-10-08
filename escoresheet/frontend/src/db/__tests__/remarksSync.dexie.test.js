// db/017: every committed change of match.remarks queues one match update
// { remarks } (db/remarksSync.js), against the real app database (Dexie 4 on
// fake-indexeddb), whichever screen wrote it.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { remarksSyncJob, remarksSnapshotJob } from '../remarksSync'
import { REMARKS_MAX, VALID_MATCH_COLUMNS, filterMatchPayload, remarksForServer } from '../matchRepository'
import { appendRemark, removeRemarkLine } from '../../domain/remarks'

const SEED = 'match_1759740000000_rm01ab'
const settle = () => new Promise(r => setTimeout(r, 20))
const remarkJobs = async () => (await db.sync_queue.toArray()).filter(j => j.resource === 'match' && j.action === 'update' && 'remarks' in (j.payload || {}))

describe('remarks sync hook', () => {
  let matchId
  beforeEach(async () => {
    await db.open()
    await Promise.all(db.tables.map(t => t.clear()))
    matchId = await db.matches.add({ status: 'live', seed_key: SEED, test: false })
  })

  it('a remarks edit queues the whole text for the server', async () => {
    await db.matches.update(matchId, { remarks: 'Floor wet, wiped at 12:3' })
    await settle()
    const jobs = await remarkJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ resource: 'match', action: 'update', status: 'queued', payload: { id: SEED, remarks: 'Floor wet, wiped at 12:3' } })
    // nothing but the remarks: the job never overwrites another column
    expect(Object.keys(jobs[0].payload).sort()).toEqual(['id', 'remarks'])
  })

  it('appended automatic lines and an undo that removes one: one job per change, last write wins', async () => {
    const line = 'Actual start time: 18:05'
    await db.matches.update(matchId, { remarks: appendRemark('', 'Scorer note') })
    await db.matches.update(matchId, { remarks: appendRemark('Scorer note', line) })
    await db.matches.update(matchId, { remarks: removeRemarkLine(`Scorer note\n${line}`, line) })
    await settle()
    const jobs = await remarkJobs()
    expect(jobs.map(j => j.payload.remarks)).toEqual(['Scorer note', `Scorer note\n${line}`, 'Scorer note'])
    // queued in order: the last one sent is the current text
    expect(jobs.map(j => j.id)).toEqual([...jobs.map(j => j.id)].sort((a, b) => a - b))
  })

  it('emptying the remarks sends an empty text', async () => {
    await db.matches.update(matchId, { remarks: 'x' })
    await db.matches.update(matchId, { remarks: '' })
    await settle()
    expect((await remarkJobs()).map(j => j.payload.remarks)).toEqual(['x', ''])
  })

  it('an unchanged text, another field, a test match or a local-only match queue nothing', async () => {
    await db.matches.update(matchId, { remarks: 'same' })
    await settle()
    await db.matches.update(matchId, { remarks: 'same', status: 'ended' })
    await db.matches.update(matchId, { status: 'live' })
    const testId = await db.matches.add({ status: 'live', seed_key: 'match_test_1', test: true })
    await db.matches.update(testId, { remarks: 'test remark' })
    const localId = await db.matches.add({ status: 'live' })
    await db.matches.update(localId, { remarks: 'no seed key' })
    await settle()
    expect((await remarkJobs()).map(j => j.payload.remarks)).toEqual(['same'])
  })

  it('in a transaction with sync_queue the job is written with the change; a rollback queues nothing', async () => {
    await db.transaction('rw', db.matches, db.sync_queue, async () => {
      await db.sync_queue.add({ resource: 'set', action: 'update', payload: { external_id: `${SEED}:s:1` }, ts: 't', status: 'queued' })
      await db.matches.update(matchId, { remarks: 'In the transaction' })
      // already there before the commit
      expect((await db.sync_queue.toArray()).some(j => j.payload?.remarks === 'In the transaction')).toBe(true)
    })
    await expect(db.transaction('rw', db.matches, async () => {
      await db.matches.update(matchId, { remarks: 'Rolled back' })
      throw new Error('abort')
    })).rejects.toThrow('abort')
    await settle()
    expect((await remarkJobs()).map(j => j.payload.remarks)).toEqual(['In the transaction'])
    expect((await db.matches.get(matchId)).remarks).toBe('In the transaction')
  })

  it('a match added with remarks (backup restore, import) is not an edit', async () => {
    await db.matches.add({ status: 'live', seed_key: 'match_restored_1', remarks: 'From the backup' })
    await settle()
    expect(await remarkJobs()).toEqual([])
  })

  it('the local text is never shortened; the server copy is clipped to the column limit', async () => {
    const long = 'a'.repeat(REMARKS_MAX + 50)
    await db.matches.update(matchId, { remarks: long })
    await settle()
    expect((await db.matches.get(matchId)).remarks).toBe(long)
    const [job] = await remarkJobs()
    expect(job.payload.remarks).toHaveLength(REMARKS_MAX)
  })
})

describe('remarks on the server: columns and limit', () => {
  it('remarks is a match column the sync keeps', () => {
    expect(VALID_MATCH_COLUMNS).toContain('remarks')
    expect(filterMatchPayload({ external_id: 'x', remarks: 'r', bogus: 1 })).toEqual({ external_id: 'x', remarks: 'r' })
  })

  it('remarksForServer: a string, at most REMARKS_MAX characters, never a split emoji', () => {
    expect(remarksForServer(undefined)).toBe('')
    expect(remarksForServer(null)).toBe('')
    expect(remarksForServer('a\nb')).toBe('a\nb')
    const emoji = '🏐'.repeat(REMARKS_MAX) // 2 UTF-16 units each, REMARKS_MAX characters
    expect(remarksForServer(emoji)).toBe(emoji)
    const over = remarksForServer('🏐'.repeat(REMARKS_MAX + 1))
    expect(Array.from(over)).toHaveLength(REMARKS_MAX)
    expect(over.endsWith('🏐')).toBe(true)
  })

  it('remarksSyncJob compares texts, not null and empty', () => {
    expect(remarksSyncJob({ remarks: undefined }, { seed_key: SEED, remarks: '' })).toBeNull()
    expect(remarksSyncJob({ remarks: 'a' }, { seed_key: SEED, remarks: 'a' })).toBeNull()
    expect(remarksSyncJob({ remarks: 'a' }, { seed_key: SEED, remarks: null })?.payload).toEqual({ id: SEED, remarks: '' })
  })

  it('remarksSnapshotJob: the current text as it is (the approval), never for a test or local-only match', () => {
    expect(remarksSnapshotJob({ seed_key: SEED, remarks: 'At approval' })).toMatchObject({ resource: 'match', action: 'update', status: 'queued', payload: { id: SEED, remarks: 'At approval' } })
    expect(remarksSnapshotJob({ seed_key: SEED })?.payload).toEqual({ id: SEED, remarks: '' })
    expect(remarksSnapshotJob({ seed_key: SEED, test: true, remarks: 'x' })).toBeNull()
    expect(remarksSnapshotJob({ remarks: 'x' })).toBeNull()
    expect(remarksSnapshotJob(undefined)).toBeNull()
  })
})
