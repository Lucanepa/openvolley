// The coin toss page's roster dialog: a signature given in the dialog for an
// edited roster does not fit the roster Cancel restores, nor one edited back
// to the opening roster before Close. It goes, with a remark, so the Start
// set gate asks again; one given for the opening roster stays. Made-up names.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { waitFor, fireEvent, within } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() }))
vi.mock('../components/SignaturePad', () => ({
  default: ({ open, onSave }) => (open ? <button type="button" onClick={() => onSave('data:image/png;base64,PADINK', { source: 'device' })}>draw pad</button> : null)
}))
import { db } from '../db/db'
import { offline, online, mountApp, button } from './appMount'

beforeAll(offline)
afterAll(online)

const rosterDialog = () => [...document.querySelectorAll('[role=dialog]')].find(d => d.querySelector('table.roster-table'))
const dialogButton = (re) => within(rosterDialog()).getAllByRole('button').find(b => re.test(b.textContent.trim()))
const numbers = () => within(rosterDialog()).getAllByLabelText('Number')

async function openCoinToss () {
  await Promise.all(db.tables.map(t => t.clear()))
  const home = await db.teams.add({ name: 'Home', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away', shortName: 'AWA' })
  await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
    { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1, dob: '12.03.1990' },
    { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1, dob: '12.03.1990' }
  ]))
  const now = new Date().toISOString()
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'scheduled', test: false, createdAt: now, matchInfoConfirmedAt: now,
    hall: 'Hall', city: 'City', league: 'League', scheduledAt: now, remarks: ''
  })
  sessionStorage.setItem('ov.openMatch', JSON.stringify({ id: matchId, view: 'coinToss' }))
  mountApp()
  await waitFor(() => expect(button('Confirm coin toss result')).toBeTruthy(), { timeout: 15000 })
  // opened once the roster is loaded (the dialog keeps the roster it opened with)
  const show = await waitFor(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^(Show roster|Roster) \(7\)$/.test(x.textContent.trim()))
    expect(b).toBeTruthy()
    return b
  })
  fireEvent.click(show)
  await waitFor(() => expect(rosterDialog()).toBeTruthy())
  await waitFor(() => expect(numbers().length).toBe(7))
  return { matchId }
}

async function signCoach (matchId) {
  fireEvent.click(dialogButton(/^Coach/))
  const pad = await waitFor(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent === 'draw pad')
    expect(b).toBeTruthy()
    return b
  })
  fireEvent.click(pad)
  await waitFor(async () => expect((await db.matches.get(matchId)).homeCoachSignature).toBe('data:image/png;base64,PADINK'))
}

describe('Coin toss roster dialog: a signature for an edited roster', () => {
  it('goes on Cancel, with a remark', async () => {
    const { matchId } = await openCoinToss()
    fireEvent.change(numbers()[6], { target: { value: '17' } })
    await waitFor(() => expect(numbers().map(i => i.value)).toContain('17'))
    await signCoach(matchId)
    fireEvent.click(dialogButton(/^Cancel$/))
    await waitFor(() => expect(rosterDialog()).toBeFalsy())
    await waitFor(async () => expect((await db.matches.get(matchId)).homeCoachSignature).toBeNull())
    expect((await db.matches.get(matchId)).remarks).toMatch(/Roster of Home changed after signing.*Coach signature removed/)
  }, 60000)

  it('goes on Close after editing back to the opening roster', async () => {
    const { matchId } = await openCoinToss()
    fireEvent.change(numbers()[6], { target: { value: '17' } })
    await waitFor(() => expect(numbers().map(i => i.value)).toContain('17'))
    await signCoach(matchId)
    fireEvent.change(numbers().find(i => i.value === '17'), { target: { value: '7' } })
    await waitFor(() => expect(dialogButton(/^Close$/)).toBeTruthy())
    fireEvent.click(dialogButton(/^Close$/))
    await waitFor(() => expect(rosterDialog()).toBeFalsy())
    await waitFor(async () => expect((await db.matches.get(matchId)).homeCoachSignature).toBeNull())
  }, 60000)

  it('one given for the opening roster stays on Cancel', async () => {
    const { matchId } = await openCoinToss()
    await signCoach(matchId)
    fireEvent.change(numbers()[6], { target: { value: '17' } })
    await waitFor(() => expect(numbers().map(i => i.value)).toContain('17'))
    fireEvent.click(dialogButton(/^Cancel$/))
    await waitFor(() => expect(rosterDialog()).toBeFalsy())
    await new Promise(r => setTimeout(r, 200))
    const m = await db.matches.get(matchId)
    expect(m.homeCoachSignature).toBe('data:image/png;base64,PADINK')
    expect(m.remarks).toBe('')
  }, 60000)
})
