// Match setup drafts: one per match, read back by its match, removed with it;
// the old draft without a match (rosters, signatures) and drafts of matches
// no longer on the device are dropped.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { clearSetupDraft, dropStaleSetupDrafts, readSetupDraft, writeSetupDraft } from '../setupDrafts'

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map(t => t.clear()))
})

describe('setup drafts', () => {
  it('one row per match, the newest data of its view', async () => {
    await writeSetupDraft(1, 'info', { hall: 'Halle A' })
    await writeSetupDraft(1, 'info', { hall: 'Halle B' })
    await writeSetupDraft(2, 'home', { roster: [] })
    expect(await db.match_setup.count()).toBe(2)
    expect((await readSetupDraft(1)).data.hall).toBe('Halle B')
    expect((await readSetupDraft(2)).view).toBe('home')
    expect(await readSetupDraft(3)).toBeNull()
    await clearSetupDraft(1)
    expect(await readSetupDraft(1)).toBeNull()
    expect(await readSetupDraft(2)).not.toBeNull()
  })

  it('drops the old draft without a match and drafts of matches that are gone', async () => {
    const kept = await db.matches.add({ status: 'setup' })
    await db.match_setup.add({ homeRoster: [{ lastName: 'Old', dob: '01.01.2010' }], homeCoachSignature: 'data:image/png;base64,AAAA', updatedAt: '2026-10-01T00:00:00Z' })
    await writeSetupDraft(kept, 'info', { hall: 'Halle A' })
    await writeSetupDraft(kept + 100, 'info', { hall: 'Gone' })
    await dropStaleSetupDrafts()
    const rows = await db.match_setup.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].matchId).toBe(kept)
  })
})
