// A new test match while an older one is on the home screen (verification
// of OV-18 / OB-2, 2026-10-08): the home screen kept its 'Continue match /
// Delete match' while the test match was prepared, but the header's 'Test
// match' chip went away for two frames (the older match deleted, its header
// status not held) and came back with the setup. The header stays as it was
// now too.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { waitFor, fireEvent } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../db/db'
import { offline, online, mountApp, button, sleep, track } from './appMount'

beforeAll(offline)
afterAll(online)

// the header's match chip (the home screen's own 'Test match' button has the same text)
const chip = () => document.querySelector('button[data-match-info-menu]')?.textContent.trim() || null
const menuTestMatch = () => [...document.querySelectorAll('button:not([data-match-info-menu])')]
  .find(b => b.textContent.trim() === 'Test match' && !b.disabled)

describe('App: a new test match over an older one', () => {
  it('keeps the home screen and its header as they were until the filled Match Setup', async () => {
    const home = await db.teams.add({ name: 'Old home', shortName: 'OLH' })
    const away = await db.teams.add({ name: 'Old away', shortName: 'OLA' })
    await db.matches.add({ homeTeamId: home, awayTeamId: away, status: 'scheduled', test: true, createdAt: new Date().toISOString() })

    mountApp()
    await waitFor(() => expect(button('Continue match')).toBeTruthy(), { timeout: 8000 })
    await waitFor(() => expect(chip()).toBe('Test match'), { timeout: 8000 })
    fireEvent.click(button('New match'))
    await waitFor(() => expect(menuTestMatch()).toBeTruthy())

    const { states, stop } = track(() => {
      const text = document.body.textContent
      return {
        home: !!button('Restore match'),
        match: !!button('Continue match') || !!button('Delete match'),
        chip: chip(),
        setup: /Players: \d+/.test(text),
        notSet: (text.match(/Not set/g) || []).length
      }
    })
    fireEvent.click(menuTestMatch())
    await waitFor(() => expect(states.at(-1)).toMatchObject({ home: false, setup: true, notSet: 0 }), { timeout: 8000 })
    await sleep(500)
    stop()

    expect(states.at(-1)).toMatchObject({ home: false, chip: 'Test match', setup: true, notSet: 0 })
    // the home screen as it was: the older match's buttons and the header chip
    expect(states.filter(s => s.home && !(s.match && s.chip === 'Test match'))).toEqual([])
    // then only the filled setup
    expect(states.filter(s => !s.home && !(s.setup && s.notSet === 0 && s.chip === 'Test match'))).toEqual([])
  }, 30000)
})
