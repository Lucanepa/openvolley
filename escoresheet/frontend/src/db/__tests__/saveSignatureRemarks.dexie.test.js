// A signature written with a remark reads and writes the remarks in one
// transaction (utils/saveSignature): a remark written elsewhere at the same
// time is kept. Against the real app database (Dexie 4 on fake-indexeddb).
// A new match notes it as a technical remark (owner 22.11.2026: the change
// log, never the sheet); an older match (no remarks model) as a remark line.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { saveMatchSignature, clearMatchSignatures } from '../../utils/saveSignature'
import { appendRemark } from '../../domain/remarks'
import { REMARKS_MODEL } from '../../domain/technicalRemarks'

const otherLine = (id) => db.transaction('rw', db.matches, async () => {
  const row = await db.matches.get(id)
  await db.matches.update(id, { remarks: appendRemark(row.remarks, 'Other line') })
})

describe('saveSignature remarks (an older match)', () => {
  let id
  beforeEach(async () => {
    await db.open()
    await db.matches.clear()
    await db.sync_queue.clear()
    // a match restored from before the technical remarks: no model
    id = await db.matches.add({ test: true, remarksModel: null, remarks: 'First line', homeCoachSignature: 'data:c', homeCaptainSignature: 'data:k' })
  })

  it('a remark written at the same time is not lost (Re-sign)', async () => {
    const other = otherLine(id)
    const sign = saveMatchSignature(db, id, 'homeCaptainSignature', 'data:new', null, { remark: 'Captain signature of Team V replaced' })
    await Promise.all([other, sign])
    const row = await db.matches.get(id)
    expect(row.homeCaptainSignature).toBe('data:new')
    expect(row.remarks).toContain('Other line')
    expect(row.remarks).toContain('Captain signature of Team V replaced')
  })

  it('a remark written at the same time is not lost (roster change)', async () => {
    const clear = clearMatchSignatures(db, id, ['homeCoachSignature'], 'Roster of Team V changed after signing')
    const other = otherLine(id)
    await Promise.all([clear, other])
    const row = await db.matches.get(id)
    expect(row.homeCoachSignature).toBeNull()
    expect(row.remarks).toContain('Other line')
    expect(row.remarks).toContain('Roster of Team V changed after signing')
  })
})

describe('saveSignature technical remarks (a new match)', () => {
  let id
  beforeEach(async () => {
    await db.open()
    await db.matches.clear()
    await db.sync_queue.clear()
    id = await db.matches.add({ seed_key: 'k-tech', remarks: 'First line', homeCoachSignature: 'data:c', homeCaptainSignature: 'data:k' })
  })

  it('a new match carries the remarks model of this version', async () => {
    expect((await db.matches.get(id)).remarksModel).toBe(REMARKS_MODEL)
  })

  it('Re-sign and a roster change: the change log, queued for the cloud; the remarks and a line written meanwhile stay', async () => {
    const other = otherLine(id)
    const sign = saveMatchSignature(db, id, 'homeCaptainSignature', 'data:new', null, { remark: 'Captain signature of Team V replaced' })
    await Promise.all([other, sign])
    await clearMatchSignatures(db, id, ['homeCoachSignature'], 'Roster of Team V changed after signing')
    const row = await db.matches.get(id)
    expect(row.homeCaptainSignature).toBe('data:new')
    expect(row.homeCoachSignature).toBeNull()
    expect(row.remarks).toBe('First line\nOther line')
    expect(row.manualChanges.map(c => [c.category, c.action, c.text])).toEqual([
      ['technical', 'resigned', 'Captain signature of Team V replaced'],
      ['technical', 'signaturesCleared', 'Roster of Team V changed after signing']
    ])
    const logs = (await db.sync_queue.toArray()).filter(j => j.payload?.manual_changes)
    expect(logs.at(-1).payload).toEqual({ id: 'k-tech', manual_changes: row.manualChanges })
  })
})
