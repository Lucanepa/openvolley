// "Swap A/B" in Manual adjustments on a match without firstServe (the
// device then plays home first: firstServe || 'home'). The swap derived the
// first server from the old A/B serve flag: the cloud coin toss got the
// other team as first server than the device plays, and the local match
// kept no firstServe (found by a check, 2026-10-09). Now the kept first
// server is written locally and sent as the cloud coin toss's first_serve.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))

import '../../i18n'
import { db } from '../../db/db'
import ManualAdjustments from '../ManualAdjustments'

let saved
beforeAll(() => {
  saved = { fetch: globalThis.fetch }
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
})
afterAll(() => {
  cleanup()
  globalThis.fetch = saved.fetch
})

const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text) && !b.disabled)

describe('ManualAdjustments: Swap A/B without firstServe', () => {
  it('keeps home as first server here and in the cloud coin toss', async () => {
    const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
    const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: false, seed_key: 'match_swap_first_serve',
      coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: false
    })
    render(<ManualAdjustments matchId={matchId} onClose={() => {}} onSave={() => {}} />)
    const teamsTab = await screen.findByRole('radio', { name: 'Teams' }).catch(() => screen.findByRole('button', { name: 'Teams' }))
    fireEvent.click(teamsTab)
    await waitFor(() => expect(button('Swap A/B')).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(button('Swap A/B'))
    await waitFor(() => expect(button('Save changes')).toBeTruthy())
    fireEvent.click(button('Save changes'))

    await waitFor(async () => expect((await db.matches.get(matchId)).coinTossTeamA).toBe('away'), { timeout: 5000 })
    const match = await db.matches.get(matchId)
    // home still serves first (now team B)
    expect(match.firstServe).toBe('home')
    expect(match.coinTossServeA).toBe(false)
    expect(match.coinTossServeB).toBe(true)

    await waitFor(async () => expect((await db.sync_queue.toArray()).some(j => j.payload?.coin_toss)).toBe(true), { timeout: 5000 })
    const job = (await db.sync_queue.toArray()).find(j => j.payload?.coin_toss)
    expect(job.payload.coin_toss).toMatchObject({ team_a: 'away', team_b: 'home', serve_a: false, first_serve: 'home' })
  }, 30000)
})
