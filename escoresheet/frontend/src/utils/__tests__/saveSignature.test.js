import { describe, it, expect, vi } from 'vitest'
import { saveMatchSignature, clearMatchSignatures } from '../saveSignature'
import { signatureFieldOfRole } from '../../domain/signatureEdits'

function fakeDb(row) {
  const rows = { 1: { ...row } }
  const queue = []
  return {
    rows, queue,
    matches: {
      update: vi.fn(async (id, patch) => { rows[id] = { ...rows[id], ...patch } }),
      get: vi.fn(async (id) => rows[id])
    },
    sync_queue: { add: vi.fn(async (job) => { queue.push(job) }) },
    // (mode, ...tables, fn)
    transaction: vi.fn(async (...args) => args[args.length - 1]())
  }
}

describe('saveMatchSignature (owner 2026-10-07: saved as soon as the pad is confirmed)', () => {
  it('writes the field and queues the full signatures object', async () => {
    const db = fakeDb({ seed_key: 'k1', homeCoachSignature: 'data:coach' })
    expect(await saveMatchSignature(db, 1, 'homeCaptainSignature', 'data:capt')).toBe(true)
    expect(db.rows[1].homeCaptainSignature).toBe('data:capt')
    expect(db.queue).toHaveLength(1)
    expect(db.queue[0].payload.signatures).toMatchObject({ home_captain: 'data:capt', home_coach: 'data:coach' })
  })

  it('a test match or a match without a seed key is saved, not synced', async () => {
    const db = fakeDb({ seed_key: 'k1', test: true })
    await saveMatchSignature(db, 1, 'awayCoachSignature', 'data:x')
    expect(db.rows[1].awayCoachSignature).toBe('data:x')
    expect(db.queue).toHaveLength(0)
  })

  it('writes extra fields (a phone-signing source record) in the same update', async () => {
    const db = fakeDb({ seed_key: 'k1' })
    const src = { via: 'phone', transport: 'lan', at: '2026-10-07T18:00:00.000Z' }
    await saveMatchSignature(db, 1, 'homeCoachSignature', 'data:p', { 'signatureSources.homeCoachSignature': src })
    expect(db.matches.update).toHaveBeenCalledTimes(1)
    expect(db.matches.update).toHaveBeenCalledWith(1, { 'signatureSources.homeCoachSignature': src, homeCoachSignature: 'data:p' })
  })

  it('does nothing without a match or a field', async () => {
    const db = fakeDb({})
    expect(await saveMatchSignature(db, null, 'homeCaptainSignature', 'x')).toBe(false)
    expect(await saveMatchSignature(db, 1, signatureFieldOfRole('nope'), 'x')).toBe(false)
    expect(db.matches.update).not.toHaveBeenCalled()
  })

  it('maps the pads to the match fields', () => {
    expect(signatureFieldOfRole('home-captain')).toBe('homeCaptainSignature')
    expect(signatureFieldOfRole('away-coach')).toBe('awayCoachSignature')
    expect(signatureFieldOfRole('away-captain-post')).toBe('awayPostGameCaptainSignature')
  })

  it('a Re-sign appends its remark in the same update', async () => {
    const db = fakeDb({ seed_key: 'k1', homeCaptainSignature: 'data:old', remarks: 'Earlier line' })
    await saveMatchSignature(db, 1, 'homeCaptainSignature', 'data:new', null, { remark: 'Captain signature of Team V replaced' })
    expect(db.matches.update).toHaveBeenCalledTimes(1)
    expect(db.rows[1].homeCaptainSignature).toBe('data:new')
    expect(db.rows[1].remarks).toBe('Earlier line\nCaptain signature of Team V replaced')
  })
})

// owner 22.11.2026: in a match with technical remarks, a cleared or replaced
// signature is a technical remark (the change log, synced), not a sheet line
describe('the signature lines of a match with technical remarks', () => {
  it('a Re-sign: a technical remark in the change log, queued for the cloud; the remarks stay', async () => {
    const db = fakeDb({ seed_key: 'k1', remarksModel: 2, homeCaptainSignature: 'data:old', remarks: 'Earlier line', manualChanges: [{ ts: 't0', text: 'Earlier change' }] })
    await saveMatchSignature(db, 1, 'homeCaptainSignature', 'data:new', null, { remark: 'Captain signature of Team V replaced' })
    expect(db.rows[1].homeCaptainSignature).toBe('data:new')
    expect(db.rows[1].remarks).toBe('Earlier line')
    expect(db.rows[1].manualChanges).toHaveLength(2)
    expect(db.rows[1].manualChanges[1]).toMatchObject({ category: 'technical', action: 'resigned', text: 'Captain signature of Team V replaced', by: 'app' })
    const log = db.queue.find(j => j.payload.manual_changes)
    expect(log.payload).toEqual({ id: 'k1', manual_changes: db.rows[1].manualChanges })
    expect(db.queue.some(j => j.payload.signatures)).toBe(true)
  })
  it('signatures cleared by a roster change: a technical remark; a test match keeps it on the device', async () => {
    const db = fakeDb({ seed_key: 'k1', test: true, remarksModel: 2, homeCoachSignature: 'data:c', remarks: '' })
    await clearMatchSignatures(db, 1, ['homeCoachSignature'], 'Roster changed')
    expect(db.rows[1].homeCoachSignature).toBe(null)
    expect(db.rows[1].remarks).toBe('')
    expect(db.rows[1].manualChanges[0]).toMatchObject({ category: 'technical', action: 'signaturesCleared', text: 'Roster changed' })
    expect(db.queue).toHaveLength(0)
  })
})

describe('clearMatchSignatures (a roster change after signing)', () => {
  it('clears the fields and their sources with the remark, and queues the whole object', async () => {
    const db = fakeDb({ seed_key: 'k1', homeCoachSignature: 'data:c', homeCaptainSignature: 'data:k', awayCoachSignature: 'data:ac', remarks: '' })
    expect(await clearMatchSignatures(db, 1, ['homeCoachSignature', 'homeCaptainSignature'], 'Roster changed')).toBe(true)
    expect(db.matches.update).toHaveBeenCalledWith(1, {
      homeCoachSignature: null, 'signatureSources.homeCoachSignature': null,
      homeCaptainSignature: null, 'signatureSources.homeCaptainSignature': null,
      remarks: 'Roster changed'
    })
    expect(db.queue).toHaveLength(1)
    expect(db.queue[0].payload.signatures).toMatchObject({ home_coach: '', home_captain: '', away_coach: 'data:ac' })
  })
  it('does nothing without fields', async () => {
    const db = fakeDb({})
    expect(await clearMatchSignatures(db, 1, [])).toBe(false)
    expect(db.matches.update).not.toHaveBeenCalled()
  })
})

