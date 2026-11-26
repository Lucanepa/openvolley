// A test match given a real game (tester feedback, 23.11.2026): in a Test
// match, "Load match from schedule" took VC Tornado Adliswil D1 against VBC
// Freies Gymnasium ZH, and the roster summary "VC Tornado Adliswil D1 -
// roster" still listed the test match's seeded players (Keller Luca 100211,
// ... liberos Huber Mauro, Meier Simon). The schedule renamed the shared seed
// teams with their players; App renamed them back on the next start. And an
// emptied roster (Delete roster, Confirm) was never stored: the editor showed
// 0 while the stored players, which Coin toss, the scoresheet and Match setup
// opened again read, were still the test players.
//
// Now a replaced team of a test match loses its seeded test people and keeps
// the scorer's own, under a team of the match's own; an emptied roster is
// stored empty. Also: Match setup's Back goes where the header menu's Home
// goes.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { waitFor, fireEvent, cleanup, within } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
const schedule = vi.hoisted(() => ({ game: null }))
vi.mock('../components/LoadOfficialMatchModal', async (orig) => ({
  ...(await orig()),
  default: ({ open, onSelectMatch, onClose }) => (open
    ? <button type="button" onClick={() => { onSelectMatch(schedule.game); onClose() }}>pick-schedule-game</button>
    : null)
}))
// App mounts no UiHost (main.jsx does): the questions answer here
const ui = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }))
vi.mock('../ui', async (orig) => ({ ...(await orig()), confirmDialog: (...a) => ui.confirm(...a) }))
import { db } from '../db/db'
import { offline, online, mountApp, button } from './appMount'

beforeAll(offline)
afterAll(online)

const GAME = {
  date: '2026-11-28', time: '19:00', city: 'Adliswil', hall: 'Sporthalle Tal',
  type1: 'championship', championshipType: 'regional', type2: 'women', type3: 'senior',
  gameN: '312345', league: '3L', bestOf: 5,
  home: 'VC Tornado Adliswil D1', away: 'VBC Freies Gymnasium ZH',
  referee1First: 'Anna', referee1Last: 'Muster'
}

const text = () => document.body.textContent
const playerCounts = () => (text().match(/Players: \d+/g) || []).join(' ')
const editorCount = () => Number(text().match(/Players:\s*(\d+)\s*\(/)?.[1])
const testMatch = async () => (await db.matches.toArray()).find(m => m.test === true)
const storedPlayers = async (teamId) => (await db.players.where('teamId').equals(teamId).toArray())
const seedTeam = (key) => db.teams.filter(t => t.seedKey === key).first()

async function openTestMatch() {
  mountApp()
  await waitFor(() => expect(button('Test match')).toBeTruthy())
  fireEvent.click(button('Test match'))
  await waitFor(() => expect(playerCounts()).toBe('Players: 12 Players: 12'), { timeout: 10000 })
}

async function loadScheduleGame() {
  fireEvent.click(button('Load match from schedule'))
  await waitFor(() => expect(button('pick-schedule-game')).toBeTruthy())
  fireEvent.click(button('pick-schedule-game'))
  // no short names to fill in (retired 26.11.2026)
  await waitFor(() => {
    expect(document.querySelector('input[aria-label="Home Team name"]')?.value).toBe('VC Tornado Adliswil D1')
  }, { timeout: 10000 })
  expect(document.querySelector('input[aria-label="Home Short"]')).toBeNull()
  await waitFor(() => expect(button('Save')).toBeTruthy(), { timeout: 5000 })
  fireEvent.click(button('Save'))
  await waitFor(() => expect(button('Load match from schedule')).toBeTruthy(), { timeout: 10000 })
}

async function remountAndContinue() {
  cleanup()
  mountApp()
  // the app opens the match it had open, else Home offers it
  await waitFor(() => expect(button('Continue match') || button('Load match from schedule')).toBeTruthy(), { timeout: 10000 })
  if (button('Continue match')) fireEvent.click(button('Continue match'))
  await waitFor(() => expect(button('Load match from schedule')).toBeTruthy(), { timeout: 10000 })
}

beforeEach(async () => {
  cleanup()
  ui.confirm.mockReset()
  ui.confirm.mockImplementation(async () => true)
  schedule.game = GAME
  await db.open()
  await Promise.all(db.tables.map(t => t.clear()))
})

describe('App: a test match given a game from the schedule', () => {
  it('drops the seeded test roster of both teams: summary, roster editor and the stored players agree, also after a restart', async () => {
    await openTestMatch()
    await loadScheduleGame()

    await waitFor(() => expect(playerCounts()).toBe('Players: 0 Players: 0'))
    fireEvent.click(button('Show rosters'))
    await waitFor(() => expect(text()).toContain('VC Tornado Adliswil D1 - roster'))
    expect(text()).not.toMatch(/Keller|Hofmann|Huber|Meier|Weber|Frei Marco/)
    // nothing of the scorer's to ask about: the seeded players go with their team
    expect(ui.confirm).not.toHaveBeenCalled()

    const match = await testMatch()
    expect(await storedPlayers(match.homeTeamId)).toEqual([])
    expect(await storedPlayers(match.awayTeamId)).toEqual([])
    expect([(await db.teams.get(match.homeTeamId)).name, (await db.teams.get(match.awayTeamId)).name])
      .toEqual(['VC Tornado Adliswil D1', 'VBC Freies Gymnasium ZH'])
    // the seed teams stay as they are, for the next test match
    const [home, away] = [await seedTeam('test-team-home'), await seedTeam('test-team-away')]
    expect([home.name, away.name]).toEqual(['VBC Musterau', 'VC Beispielstadt'])
    expect((await storedPlayers(home.id)).length).toBe(12)
    expect([match.homeTeamId, match.awayTeamId]).not.toContain(home.id)

    fireEvent.click([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Edit roster'))
    await waitFor(() => expect(editorCount()).toBe(0))
    fireEvent.click(button('← Back'))
    await waitFor(() => expect(button('Load match from schedule')).toBeTruthy())

    // App's start renamed the seed teams back and the game's names were gone
    await remountAndContinue()
    await waitFor(() => expect(text()).toContain('VC TORNADO ADLISWIL D1'))
    expect(playerCounts()).toBe('Players: 0 Players: 0')
  }, 40000)

  it('keeps a player the scorer added to the test roster', async () => {
    await openTestMatch()
    fireEvent.click([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Edit roster'))
    const add = await waitFor(() => {
      const row = document.querySelector('[data-help-id="setup-add-player"]')
      expect(row).toBeTruthy()
      return within(row)
    })
    fireEvent.change(add.getByLabelText('Player number'), { target: { value: '99' } })
    fireEvent.change(add.getByLabelText('Last name'), { target: { value: 'Eigen' } })
    fireEvent.change(add.getByLabelText('First name'), { target: { value: 'Mia' } })
    fireEvent.click(add.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(editorCount()).toBe(13))
    fireEvent.click(button('Confirm'))
    await waitFor(() => expect(playerCounts()).toBe('Players: 13 Players: 12'))

    await loadScheduleGame()
    // the scorer's own player is asked about (it stays and takes the new name)
    expect(ui.confirm).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(playerCounts()).toBe('Players: 1 Players: 0'))
    fireEvent.click(button('Show rosters'))
    await waitFor(() => expect(text()).toContain('Eigen Mia'))
    expect(text()).not.toMatch(/Keller|Hofmann/)
    const match = await testMatch()
    expect((await storedPlayers(match.homeTeamId)).map(p => [p.number, p.lastName])).toEqual([[99, 'Eigen']])
  }, 40000)
})

describe('App: a test match given a game after signing', () => {
  it('clears the coach and captain signatures given for the seeded roster, with a remark', async () => {
    await openTestMatch()
    const signed = await testMatch()
    await db.matches.update(signed.id, { homeCoachSignature: 'data:image/png;base64,AAAA', homeCaptainSignature: 'data:image/png;base64,BBBB' })
    await remountAndContinue()
    await loadScheduleGame()
    await waitFor(async () => {
      const match = await testMatch()
      expect([match.homeCoachSignature, match.homeCaptainSignature]).toEqual([null, null])
    })
    const match = await testMatch()
    const notes = JSON.stringify([match.remarks || '', match.manualChanges || []])
    expect(notes).toContain('Roster of VC Tornado Adliswil D1 changed after signing')
  }, 40000)
})

describe('App: a roster emptied in the editor', () => {
  it('is stored empty: Match setup opened again shows 0, not the test players', async () => {
    await openTestMatch()
    fireEvent.click([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Edit roster'))
    await waitFor(() => expect(button('Delete roster')).toBeTruthy())
    fireEvent.click(button('Delete roster'))
    await waitFor(() => expect(editorCount()).toBe(0))
    fireEvent.click(button('Confirm'))
    await waitFor(() => expect(playerCounts()).toBe('Players: 0 Players: 12'))
    const match = await testMatch()
    await waitFor(async () => expect(await storedPlayers(match.homeTeamId)).toEqual([]))

    // App's start refilled the emptied seed team the test match plays with
    await remountAndContinue()
    await waitFor(() => expect(playerCounts()).toBe('Players: 0 Players: 12'))
  }, 40000)
})

describe('App: the licence field of the roster editor', () => {
  it('says "Licence/DoB" in the add-player row, the player rows and the bench rows, named "Licence"', async () => {
    await openTestMatch()
    fireEvent.click([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Edit roster'))
    const add = await waitFor(() => {
      const row = document.querySelector('[data-help-id="setup-add-player"]')
      expect(row).toBeTruthy()
      return within(row)
    })
    expect(add.getByLabelText('Licence').placeholder).toBe('Licence/DoB')
    // 12 players and 5 bench officials besides the add-player row
    const fields = [...document.querySelectorAll('input[aria-label="Licence"]')]
    expect(fields.length).toBe(1 + 12 + 5)
    expect(fields.filter(f => f.placeholder !== 'Licence/DoB')).toEqual([])
  }, 30000)
})

describe('App: Match setup Back', () => {
  it('goes to the home screen, as the header menu Home does; the match stays', async () => {
    await openTestMatch()
    const row = document.querySelector('[data-testid="setup-header-actions"]')
    expect([...row.querySelectorAll('button')].map(b => b.textContent.trim())).toEqual(['← Back', 'Scoresheet', 'Options'])
    expect(within(row).getByRole('button', { name: 'Back' })).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(button('Continue match')).toBeTruthy())
    expect(button('Load match from schedule')).toBeFalsy()
    expect(await testMatch()).toBeTruthy()
  }, 30000)
})
