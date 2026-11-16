// A new match keeps the zone its clocks read (db.js creating hook, owner 2026-11-16)
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { toolTz } from '../../ui/format.js'

describe('matches: tz at creation', () => {
  beforeEach(async () => {
    await db.open()
    await db.matches.clear()
  })
  it('a new match takes the tool zone', async () => {
    const id = await db.matches.add({ status: 'setup' })
    expect((await db.matches.get(id)).tz).toBe(toolTz())
  })
  it('a match restored with its own zone keeps it', async () => {
    const id = await db.matches.add({ status: 'final', tz: 'America/New_York' })
    expect((await db.matches.get(id)).tz).toBe('America/New_York')
  })
})
