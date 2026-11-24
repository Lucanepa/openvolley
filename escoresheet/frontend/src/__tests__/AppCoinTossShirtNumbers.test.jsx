// A shirt number typed on the coin toss page is a whole number.
//
// b0d36db7 made the match setup's roster inputs keep only the digits typed
// ('1.5', the '.' next to the digits on a tablet keypad, meant as 15) and its
// Confirm refuse any number that is not a whole number 1-99. The coin toss
// page's "Show roster" dialog and its "Add player" box took any number
// (Number(value)) and Modify wrote it to the match's roster: 1.5 was on the
// roster, on court and on the sheet, and every rally that player served
// reached the cloud with no server (review of #37).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { waitFor, fireEvent, within, cleanup } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../db/db'
import { offline, online, mountApp, button } from './appMount'

beforeAll(offline)
afterAll(online)

const rosterDialog = () => [...document.querySelectorAll('[role=dialog]')].find(d => d.querySelector('table.roster-table'))
const addPlayerDialog = () => [...document.querySelectorAll('[role=dialog]')].find(d => /Add player - /.test(d.textContent))

async function openCoinToss({ homeNumbers = [1, 2, 3, 4, 5, 6, 7] } = {}) {
  await Promise.all(db.tables.map(t => t.clear()))
  const home = await db.teams.add({ name: 'Home', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away', shortName: 'AWA' })
  await db.players.bulkAdd(homeNumbers.map(n => (
    { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1, dob: '01.01.1990' }
  )))
  await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
    { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1, dob: '01.01.1990' }
  ]))
  const now = new Date().toISOString()
  await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'scheduled', test: true, createdAt: now, matchInfoConfirmedAt: now,
    hall: 'Hall', city: 'City', league: 'League', scheduledAt: now,
    homeCoachSignature: 'x', homeCaptainSignature: 'x', awayCoachSignature: 'x', awayCaptainSignature: 'x'
  })
  mountApp()
  await waitFor(() => expect(button('Continue match')).toBeTruthy())
  fireEvent.click(button('Continue match'))
  await waitFor(() => expect(button('Confirm coin toss result')).toBeTruthy())
  return { home, away }
}

describe('App: shirt numbers on the coin toss page', () => {
  it('"Show roster" and "Add player" keep the digits of 1.5 (15), and Modify stores whole numbers', async () => {
    const { home, away } = await openCoinToss()
    const show = [...document.querySelectorAll('button')].find(b => /^(Show roster|Roster) \(\d+\)$/.test(b.textContent.trim()))
    fireEvent.click(show)
    await waitFor(() => expect(rosterDialog()).toBeTruthy())

    // a row's number
    const numbers = () => within(rosterDialog()).getAllByLabelText('Number')
    await waitFor(() => expect(numbers().length).toBe(7))
    fireEvent.change(numbers()[1], { target: { value: '1.5' } })
    await waitFor(() => expect(numbers().map(i => i.value)).toContain('15'))

    // a new player
    fireEvent.click(within(rosterDialog()).getByRole('button', { name: '+ Add player' }))
    await waitFor(() => expect(addPlayerDialog()).toBeTruthy())
    const add = within(addPlayerDialog())
    fireEvent.change(add.getByLabelText('Number'), { target: { value: '2.5' } })
    expect(add.getByLabelText('Number').value).toBe('25')
    fireEvent.change(add.getByLabelText('Last name'), { target: { value: 'Newman' } })
    fireEvent.change(add.getByLabelText('First name'), { target: { value: 'Nina' } })
    fireEvent.click(add.getByRole('button', { name: 'Add player' }))
    await waitFor(() => expect(addPlayerDialog()).toBeFalsy())

    fireEvent.click(within(rosterDialog()).getByRole('button', { name: 'Modify' }))
    await waitFor(() => expect(rosterDialog()).toBeFalsy())
    let stored = []
    await waitFor(async () => {
      stored = (await db.players.toArray()).filter(p => p.teamId === home || p.teamId === away).map(p => p.number)
      expect(stored).toContain(25)
    })
    expect(stored).toContain(15)
    expect(stored.filter(n => !Number.isInteger(Number(n)))).toEqual([])
  })

  it('Modify refuses a decimal number already on the roster (an older roster, an import)', async () => {
    cleanup()
    const { home } = await openCoinToss({ homeNumbers: [1, 1.5, 3, 4, 5, 6, 7] })
    const show = [...document.querySelectorAll('button')].find(b => /^(Show roster|Roster) \(\d+\)$/.test(b.textContent.trim()))
    fireEvent.click(show)
    await waitFor(() => expect(within(rosterDialog()).getAllByLabelText('Number').length).toBe(7))
    // another change: Close becomes Modify
    fireEvent.click(within(rosterDialog()).getByRole('button', { name: 'Team captain #7' }))
    const modify = await waitFor(() => within(rosterDialog()).getByRole('button', { name: 'Modify' }))
    const before = (await db.players.toArray()).filter(p => p.teamId === home).map(p => `${p.number}:${p.isCaptain}`)
    fireEvent.click(modify)
    await waitFor(() => expect(document.body.textContent).toMatch(/Invalid jersey numbers \(must be 1-99\): 1\.5/))
    expect(rosterDialog()).toBeTruthy()
    expect((await db.players.toArray()).filter(p => p.teamId === home).map(p => `${p.number}:${p.isCaptain}`)).toEqual(before)
  })
})
