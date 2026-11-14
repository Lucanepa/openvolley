// The coin toss page's roster dialog after the team signed (rollout audit,
// logic-cointoss-signatures-3/-4): Modify with a changed roster clears that
// team's coach and captain signatures and writes a remark, so the Start set
// gate asks again; the other team keeps its signatures. A signed slot in the
// dialog opens read-only with Re-sign. Made-up names.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { waitFor, fireEvent, within } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() }))
import { db } from '../db/db'
import { offline, online, mountApp, button } from './appMount'

beforeAll(offline)
afterAll(online)

const rosterDialog = () => [...document.querySelectorAll('[role=dialog]')].find(d => d.querySelector('table.roster-table'))
const INK = 'data:image/png;base64,SIGNED'

async function openCoinToss (extra = {}) {
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
    hall: 'Hall', city: 'City', league: 'League', scheduledAt: now,
    homeCoachSignature: INK, homeCaptainSignature: INK, awayCoachSignature: INK, awayCaptainSignature: INK,
    remarks: '', ...extra
  })
  sessionStorage.setItem('ov.openMatch', JSON.stringify({ id: matchId, view: 'coinToss' }))
  mountApp()
  await waitFor(() => expect(button('Confirm coin toss result')).toBeTruthy(), { timeout: 15000 })
  const show = [...document.querySelectorAll('button')].find(b => /^(Show roster|Roster) \(\d+\)$/.test(b.textContent.trim()))
  fireEvent.click(show)
  await waitFor(() => expect(rosterDialog()).toBeTruthy())
  await waitFor(() => expect(within(rosterDialog()).getAllByRole('button').filter(b => /✓/.test(b.textContent)).length).toBeGreaterThanOrEqual(2), { timeout: 5000 })
  return { matchId, home }
}

describe('Coin toss roster dialog after signing', () => {
  it('Modify with a changed roster clears the team\'s signatures and writes a remark', async () => {
    const { matchId, home } = await openCoinToss()
    const numbers = () => within(rosterDialog()).getAllByLabelText('Number')
    await waitFor(() => expect(numbers().length).toBe(7))
    fireEvent.change(numbers()[6], { target: { value: '17' } })
    await waitFor(() => expect(numbers().map(i => i.value)).toContain('17'))
    fireEvent.click(within(rosterDialog()).getByRole('button', { name: 'Modify' }))
    await waitFor(() => expect(rosterDialog()).toBeFalsy())

    await waitFor(async () => {
      const nums = (await db.players.toArray()).filter(p => p.teamId === home).map(p => p.number)
      expect(nums).toContain(17)
    })
    await waitFor(async () => expect((await db.matches.get(matchId)).homeCoachSignature).toBeNull())
    const m = await db.matches.get(matchId)
    expect(m.homeCaptainSignature).toBeNull()
    expect(m.awayCoachSignature).toBe(INK)
    expect(m.awayCaptainSignature).toBe(INK)
    expect(m.remarks).toMatch(/Roster of Home changed after signing.*Captain and Coach signatures removed/)
  }, 60000)

  it('a signed slot in the dialog opens read-only with Re-sign', async () => {
    const { matchId } = await openCoinToss()
    const captain = within(rosterDialog()).getAllByRole('button').find(b => /✓/.test(b.textContent) && /Captain/i.test(b.textContent))
    fireEvent.click(captain)
    await waitFor(() => expect(document.querySelector('[data-testid="signature-resign"]')).toBeTruthy())
    const pad = document.querySelector('[data-testid="signature-resign"]').closest('[role=dialog]')
    expect(within(pad).queryByRole('button', { name: 'Save' })).toBeNull()
    fireEvent.click(within(pad).getAllByRole('button').find(b => b.textContent.trim() === 'Close'))
    const m = await db.matches.get(matchId)
    expect(m.homeCaptainSignature).toBe(INK)
    expect(m.remarks).toBe('')
  }, 60000)
})
