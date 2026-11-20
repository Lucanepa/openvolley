// Owner 2026-11-20: the test match's teams are made-up clubs (they were "VBC
// Zürich" and a real club). A device seeded before keeps its seed team rows
// (found by seedKey): App renames them on start, so the test match it has and
// the next one show the new names; the colour a scorer set stays.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { offline, online, mountApp, button } from './appMount'
import { db } from '../db/db'

beforeAll(offline)
afterAll(online)

describe('App: the seed teams of before', () => {
  it('take the made-up names and short names on start, the colour and the players stay', async () => {
    await db.open()
    const home = await db.teams.add({ name: 'VBC Zürich', shortName: 'ZÜRICH', color: '#3b82f6', seedKey: 'test-team-home', test: true, createdAt: '2026-10-01T00:00:00.000Z' })
    const away = await db.teams.add({ name: 'Volley Luzern', shortName: 'LUZERN', color: '#16a34a', seedKey: 'test-team-away', test: true, createdAt: '2026-10-01T00:00:00.000Z' })
    await db.players.add({ teamId: away, number: 1, lastName: 'Weber', firstName: 'Tom', name: 'Weber Tom', dob: '100803', test: true })
    mountApp()
    await waitFor(() => expect(button('Test match')).toBeTruthy())
    await waitFor(async () => expect((await db.teams.get(home))?.name).toBe('VBC Musterau'))
    const [h, a] = [await db.teams.get(home), await db.teams.get(away)]
    expect([h.name, h.shortName, h.color]).toEqual(['VBC Musterau', 'MUS', '#3b82f6'])
    expect([a.name, a.shortName, a.color]).toEqual(['VC Beispielstadt', 'BSP', '#16a34a'])
    // no second seed team, the stored players kept
    expect(await db.teams.filter((t) => t.seedKey === 'test-team-home' || t.seedKey === 'test-team-away').count()).toBe(2)
    expect(await db.players.where('teamId').equals(away).count()).toBe(1)
  })
})
