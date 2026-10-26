// Stress test 2026-10-25 (correction-clears-signatures-only-locally): a team
// renamed in Manual adjustments after the closing signatures cleared them on
// the device only. The cloud kept every one of them, attached to the changed
// sheet. The match job now carries the cleared signatures, as Reopen last set
// and Corrections do.
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

describe('ManualAdjustments: a renamed team after the closing signatures', () => {
  it('clears them on the server too, keeping the pre-match ones', async () => {
    const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
    const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'ended', test: false, seed_key: 'match_renamed_after_signing',
      coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true,
      homeCoachSignature: 'data:coach', homeCaptainSignature: 'data:cap',
      homePostGameCaptainSignature: 'data:a', awayPostGameCaptainSignature: 'data:b', scorerSignature: 'data:s', ref1Signature: 'data:r1', ref2Signature: 'data:r2'
    })
    await db.sets.bulkAdd([
      { matchId, index: 1, homePoints: 25, awayPoints: 20, finished: true },
      { matchId, index: 2, homePoints: 25, awayPoints: 18, finished: true },
      { matchId, index: 3, homePoints: 25, awayPoints: 22, finished: true }
    ])
    render(<ManualAdjustments matchId={matchId} onClose={() => {}} onSave={() => {}} />)
    const teamsTab = await screen.findByRole('radio', { name: 'Teams' }).catch(() => screen.findByRole('button', { name: 'Teams' }))
    fireEvent.click(teamsTab)
    let input
    await waitFor(() => {
      input = [...document.querySelectorAll('input')].find(i => i.value === 'Home VC')
      expect(input).toBeTruthy()
    }, { timeout: 5000 })
    fireEvent.change(input, { target: { value: 'Home Volley Club' } })
    await waitFor(() => expect(button('Save changes')).toBeTruthy())
    fireEvent.click(button('Save changes'))

    await waitFor(async () => expect((await db.matches.get(matchId)).scorerSignature).toBeNull(), { timeout: 5000 })
    await waitFor(async () => expect((await db.sync_queue.toArray()).some(j => j.resource === 'match' && j.payload?.home_team)).toBe(true), { timeout: 5000 })
    const job = (await db.sync_queue.toArray()).find(j => j.resource === 'match' && j.payload?.home_team)
    expect(job.payload.signatures).toEqual({
      home_coach: 'data:coach', home_captain: 'data:cap', away_coach: '', away_captain: '',
      home_captain_post_game: null, away_captain_post_game: null, asst_scorer: null, scorer: null, ref2: null, ref1: null
    })
  }, 30000)
})
