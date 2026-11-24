// A roster without shirt numbers (tester feedback, 23.11.2026): a team
// uploaded its roster on roster.openvolley.app without numbers, the phone
// took it (Edit roster -> Remote -> Accept) and Confirm; going back to add
// the numbers, the players were gone. Accept had stored them, Confirm refused
// players without a number, and Back put the roster the editor had opened
// with back into the form (the next save wrote it over the stored players);
// the save also skipped numberless rows and deleted the stored ones.
//
// Owner: "can we have the players be saved anyway, but no coin toss until
// numbers?" Now players without a number are saved and come back, a number
// added later updates the same player, and the coin toss waits until every
// player of both teams has one.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { waitFor, fireEvent, cleanup, within } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
// App mounts no UiHost (main.jsx does): the questions answer here
const ui = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }))
vi.mock('../ui', async (orig) => ({ ...(await orig()), confirmDialog: (...a) => ui.confirm(...a) }))
import { db } from '../db/db'
import { offline, online, mountApp, button } from './appMount'

beforeAll(offline)
afterAll(online)

// The team's upload as the Remote panel gets it: no shirt numbers
const UPLOAD = {
  players: [
    ['Ammann', 'Lea', '123456'], ['Bucher', 'Nina', '123457'], ['Christen', 'Mia', '123458'], ['Dubach', 'Zoe', '123459'],
    ['Egger', 'Lina', '123460'], ['Frey', 'Sara', '123461'], ['Gut', 'Jana', '123462'], ['Hess', 'Anna', '123463']
  ].map(([lastName, firstName, dob], i) => ({ number: '', firstName, lastName, dob, libero: i === 7 ? 'libero1' : '', isCaptain: i === 0, isLfp: false })),
  bench: [{ role: 'Coach', firstName: 'Petra', lastName: 'Coach', dob: '' }],
  timestamp: '2026-11-23T10:00:00.000Z'
}

const text = () => document.body.textContent
const playerCounts = () => (text().match(/Players: \d+/g) || []).join(' ')
const editorCount = () => Number(text().match(/Players:\s*(\d+)\s*\(/)?.[1])
const testMatch = async () => (await db.matches.toArray()).find(m => m.test === true)
const storedPlayers = async () => {
  const m = await testMatch()
  return (await db.players.where('teamId').equals(m.homeTeamId).toArray()).sort((a, b) => a.lastName.localeCompare(b.lastName))
}
const numberInputs = () => [...document.querySelectorAll('.roster-grid-row input[aria-label="Player number"]')]
  .filter(i => !i.closest('[data-help-id="setup-add-player"]'))
const editRoster = () => fireEvent.click([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Edit roster'))
const coinTossButton = () => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Coin toss')

async function openTestMatch() {
  mountApp()
  await waitFor(() => expect(button('Test match')).toBeTruthy())
  fireEvent.click(button('Test match'))
  await waitFor(() => expect(playerCounts()).toBe('Players: 12 Players: 12'), { timeout: 10000 })
}

// Edit roster -> Remote -> Accept the upload (it replaces the test roster)
async function acceptUploadInEditor() {
  const match = await testMatch()
  await db.matches.update(match.id, { pendingHomeRoster: UPLOAD })
  editRoster()
  const remote = await waitFor(() => {
    const r = [...document.querySelectorAll('[role="radio"]')].find(b => b.textContent.trim() === 'Remote')
    expect(r).toBeTruthy()
    return r
  })
  fireEvent.click(remote)
  await waitFor(() => expect(document.querySelector('[data-testid="pending-roster-home"]')).toBeTruthy())
  fireEvent.click(within(document.querySelector('[data-testid="pending-roster-home"]')).getByRole('button', { name: 'Accept' }))
  await waitFor(() => expect(editorCount()).toBe(8))
}

async function remountAndContinue() {
  cleanup()
  mountApp()
  await waitFor(() => expect(button('Continue match') || button('Load match from schedule')).toBeTruthy(), { timeout: 10000 })
  if (button('Continue match')) fireEvent.click(button('Continue match'))
  await waitFor(() => expect(button('Load match from schedule')).toBeTruthy(), { timeout: 10000 })
}

beforeEach(async () => {
  cleanup()
  ui.confirm.mockReset()
  ui.confirm.mockImplementation(async () => true)
  await db.open()
  await Promise.all(db.tables.map(t => t.clear()))
})

describe('App: an uploaded roster without shirt numbers', () => {
  it('is saved by Confirm, comes back in the editor and after a restart, and numbers added later update the same players', async () => {
    await openTestMatch()
    await acceptUploadInEditor()
    fireEvent.click(button('Confirm'))
    await waitFor(() => expect(playerCounts()).toBe('Players: 8 Players: 12'))
    expect(text()).not.toContain('These players have no shirt number')

    const stored = await storedPlayers()
    expect(stored.map(p => [p.lastName, p.number ?? null])).toEqual(UPLOAD.players.map(p => [p.lastName, null]))
    const ids = stored.map(p => p.id)

    // back in the editor: the eight players, each # asking for its number
    editRoster()
    await waitFor(() => expect(editorCount()).toBe(8))
    expect(numberInputs().length).toBe(8)
    expect(numberInputs().every(i => i.value === '' && i.getAttribute('aria-invalid') === 'true')).toBe(true)
    fireEvent.click(button('← Back'))
    await waitFor(() => expect(button('Load match from schedule')).toBeTruthy())

    // also after a restart
    await remountAndContinue()
    await waitFor(() => expect(playerCounts()).toBe('Players: 8 Players: 12'))

    // the numbers, one per player: the same stored players get them
    editRoster()
    await waitFor(() => expect(numberInputs().length).toBe(8))
    numberInputs().forEach((input, i) => fireEvent.change(input, { target: { value: String(i + 1) } }))
    await waitFor(() => expect(numberInputs().every(i => i.getAttribute('aria-invalid') !== 'true')).toBe(true))
    fireEvent.click(button('Confirm'))
    await waitFor(() => expect(button('Load match from schedule')).toBeTruthy())
    await waitFor(async () => expect((await storedPlayers()).every(p => Number.isInteger(p.number))).toBe(true))
    const numbered = await storedPlayers()
    expect(numbered.map(p => p.id).sort()).toEqual([...ids].sort())
    expect(numbered.length).toBe(8)
  }, 60000)

  it('Back after Accept keeps the accepted players (they are stored): the form and the stored roster agree', async () => {
    await openTestMatch()
    await acceptUploadInEditor()
    fireEvent.click(button('← Back'))
    await waitFor(() => expect(playerCounts()).toBe('Players: 8 Players: 12'))
    expect((await storedPlayers()).length).toBe(8)
    editRoster()
    await waitFor(() => expect(editorCount()).toBe(8))
  }, 40000)
})

describe('App: no coin toss while a player has no shirt number', () => {
  it('blocks the Coin toss button with the team and the count, until every player has a number', async () => {
    await openTestMatch()
    await waitFor(() => expect(coinTossButton()?.disabled).toBe(false))
    await acceptUploadInEditor()
    fireEvent.click(button('Confirm'))
    await waitFor(() => expect(playerCounts()).toBe('Players: 8 Players: 12'))
    expect(coinTossButton().disabled).toBe(true)
    // the warning beside it says why
    const warning = coinTossButton().parentElement.querySelector('[title="Click to see what\'s missing"]')
    expect(warning).toBeTruthy()
    fireEvent.click(warning)
    await waitFor(() => expect(text()).toContain('VBC Musterau: 8 players without a shirt number'))

    editRoster()
    await waitFor(() => expect(numberInputs().length).toBe(8))
    numberInputs().forEach((input, i) => fireEvent.change(input, { target: { value: String(i + 1) } }))
    fireEvent.click(button('Confirm'))
    await waitFor(() => expect(button('Load match from schedule')).toBeTruthy())
    await waitFor(() => expect(coinTossButton().disabled).toBe(false))
  }, 60000)

  it('Continue match goes to Match setup, not to the coin toss, for a signed test match with a player without a number', async () => {
    await openTestMatch()
    const match = await testMatch()
    const sig = 'data:image/png;base64,AAAA'
    await db.matches.update(match.id, { homeCoachSignature: sig, homeCaptainSignature: sig, awayCoachSignature: sig, awayCaptainSignature: sig })
    const one = (await db.players.where('teamId').equals(match.awayTeamId).toArray())[0]
    await db.players.update(one.id, { number: null })
    // Home, then Continue match (App's continueTestMatch)
    fireEvent.click(button('← Back'))
    await waitFor(() => expect(button('Continue match')).toBeTruthy())
    fireEvent.click(button('Continue match'))
    await waitFor(() => expect(button('Load match from schedule') || button('Confirm coin toss result')).toBeTruthy(), { timeout: 10000 })
    expect(button('Confirm coin toss result')).toBeFalsy()
    expect(coinTossButton().disabled).toBe(true)
  }, 40000)
})

describe('App: the coin toss page and a number cleared there', () => {
  const rosterDialog = () => [...document.querySelectorAll('[role=dialog]')].find(d => d.querySelector('table.roster-table'))

  it('Confirm coin toss result says which team has players without a number, a test match too', async () => {
    const home = await db.teams.add({ name: 'Home', shortName: 'HOM' })
    const away = await db.teams.add({ name: 'Away', shortName: 'AWA' })
    for (const teamId of [home, away]) {
      await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].map(n => ({ teamId, number: n, firstName: 'P', lastName: `Player${teamId}-${n}`, isCaptain: n === 1, dob: '123456' })))
    }
    const now = new Date().toISOString()
    const sig = 'data:image/png;base64,AAAA'
    await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'scheduled', test: true, createdAt: now, matchInfoConfirmedAt: now,
      hall: 'Hall', city: 'City', league: 'League', scheduledAt: now,
      homeCoachSignature: sig, homeCaptainSignature: sig, awayCoachSignature: sig, awayCaptainSignature: sig
    })
    mountApp()
    await waitFor(() => expect(button('Continue match')).toBeTruthy())
    fireEvent.click(button('Continue match'))
    await waitFor(() => expect(button('Confirm coin toss result')).toBeTruthy(), { timeout: 10000 })

    const show = [...document.querySelectorAll('button')].find(b => /^(Show roster|Roster) \(\d+\)$/.test(b.textContent.trim()))
    fireEvent.click(show)
    const numbers = () => within(rosterDialog()).getAllByLabelText('Number')
    await waitFor(() => expect(numbers().length).toBe(7))
    fireEvent.change(numbers()[2], { target: { value: '' } })
    fireEvent.click(await waitFor(() => within(rosterDialog()).getByRole('button', { name: 'Modify' })))
    await waitFor(() => expect(rosterDialog()).toBeFalsy())
    await waitFor(async () => expect((await db.players.where('teamId').equals(home).toArray()).filter(p => p.number == null).length).toBe(1))
    // the other numberless-free players are all still there
    expect((await db.players.where('teamId').equals(home).toArray()).length).toBe(7)

    fireEvent.click(button('Confirm coin toss result'))
    await waitFor(() => expect(text()).toMatch(/Home team has 1 player\(s\) without jersey numbers/))
    expect((await testMatch()).coinTossConfirmed).not.toBe(true)
  }, 40000)
})
