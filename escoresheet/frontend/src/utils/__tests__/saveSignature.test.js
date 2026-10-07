import { describe, it, expect, vi } from 'vitest'
import { saveMatchSignature } from '../saveSignature'
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
    sync_queue: { add: vi.fn(async (job) => { queue.push(job) }) }
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
})
