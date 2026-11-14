// A signature written with a remark reads and writes the remarks in one
// transaction (utils/saveSignature): a remark written elsewhere at the same
// time is kept. Against the real app database (Dexie 4 on fake-indexeddb).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { saveMatchSignature, clearMatchSignatures } from '../../utils/saveSignature'
import { appendRemark } from '../../domain/remarks'

describe('saveSignature remarks', () => {
  let id
  beforeEach(async () => {
    await db.open()
    await db.matches.clear()
    await db.sync_queue.clear()
    id = await db.matches.add({ test: true, remarks: 'First line', homeCoachSignature: 'data:c', homeCaptainSignature: 'data:k' })
  })

  it('a remark written at the same time is not lost (Re-sign)', async () => {
    const other = db.transaction('rw', db.matches, async () => {
      const row = await db.matches.get(id)
      await db.matches.update(id, { remarks: appendRemark(row.remarks, 'Other line') })
    })
    const sign = saveMatchSignature(db, id, 'homeCaptainSignature', 'data:new', null, { remark: 'Captain signature of Team V replaced' })
    await Promise.all([other, sign])
    const row = await db.matches.get(id)
    expect(row.homeCaptainSignature).toBe('data:new')
    expect(row.remarks).toContain('Other line')
    expect(row.remarks).toContain('Captain signature of Team V replaced')
  })

  it('a remark written at the same time is not lost (roster change)', async () => {
    const clear = clearMatchSignatures(db, id, ['homeCoachSignature'], 'Roster of Team V changed after signing')
    const other = db.transaction('rw', db.matches, async () => {
      const row = await db.matches.get(id)
      await db.matches.update(id, { remarks: appendRemark(row.remarks, 'Other line') })
    })
    await Promise.all([clear, other])
    const row = await db.matches.get(id)
    expect(row.homeCoachSignature).toBeNull()
    expect(row.remarks).toContain('Other line')
    expect(row.remarks).toContain('Roster of Team V changed after signing')
  })
})
