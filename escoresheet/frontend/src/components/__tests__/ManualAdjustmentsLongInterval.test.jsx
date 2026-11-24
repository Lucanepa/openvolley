// The 10-minute interval after set 2 in Edit match info (owner 2026-11-17):
// editable after the coin toss, logged, saved on the match and sent to the
// server in match_info; a switch off travels as false.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))
vi.mock('../../ui/uiStore.js', async (orig) => ({ ...(await orig()), confirmDialog: async () => true }))

import '../../i18n'
import { db } from '../../db/db'
import ManualAdjustments from '../ManualAdjustments'
import { isLiveStateDirty, setLiveStateDirty } from '../../utils/eventSync'

let saved
beforeAll(() => {
  saved = { fetch: globalThis.fetch }
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
})
afterEach(() => cleanup())
afterAll(() => { globalThis.fetch = saved.fetch })

const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text) && !b.disabled)

async function liveMatch (extra = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  return db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, seed_key: `match_interval_${home}`,
    coinTossConfirmed: true, coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, hall: 'Halle', ...extra
  })
}

async function matchInfoJob (seedKey) {
  const jobs = await db.sync_queue.toArray()
  return jobs.reverse().find(j => j.resource === 'match' && j.payload?.match_info && (j.payload.seed_key === seedKey || JSON.stringify(j).includes(seedKey)))
}

describe('Edit match info: 10-minute interval after set 2', () => {
  it('off by default; switched on after the coin toss: saved, logged, sent, tablets refreshed', async () => {
    const matchId = await liveMatch()
    setLiveStateDirty(matchId, false)
    render(<ManualAdjustments matchId={matchId} initialTab="info" tabIds={['info']} onClose={() => {}} onSave={() => {}} />)
    const sw = await screen.findByTestId('long-interval-after-set2-switch', {}, { timeout: 5000 })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(sw).not.toBeDisabled()
    expect(screen.getByText('10-minute interval after set 2')).toBeTruthy()
    fireEvent.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(button('Save changes')).toBeTruthy())
    fireEvent.click(button('Save changes'))
    await waitFor(async () => expect((await db.matches.get(matchId)).longIntervalAfterSet2).toBe(true), { timeout: 5000 })
    const m = await db.matches.get(matchId)
    expect(m.manualChanges.at(-1)).toMatchObject({ field: 'longIntervalAfterSet2', before: 'No', after: 'Yes' })
    await waitFor(async () => expect(await matchInfoJob(m.seed_key)).toBeTruthy(), { timeout: 5000 })
    expect((await matchInfoJob(m.seed_key)).payload.match_info).toMatchObject({ hall: 'Halle', long_interval_after_set2: true })
    expect(isLiveStateDirty(matchId)).toBe(true)
  }, 30000)

  it('switched off again: false on the match and in match_info', async () => {
    const matchId = await liveMatch({ longIntervalAfterSet2: true })
    render(<ManualAdjustments matchId={matchId} initialTab="info" tabIds={['info']} onClose={() => {}} onSave={() => {}} />)
    const sw = await screen.findByTestId('long-interval-after-set2-switch', {}, { timeout: 5000 })
    expect(sw).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(sw)
    await waitFor(() => expect(button('Save changes')).toBeTruthy())
    fireEvent.click(button('Save changes'))
    await waitFor(async () => expect((await db.matches.get(matchId)).longIntervalAfterSet2).toBe(false), { timeout: 5000 })
    const m = await db.matches.get(matchId)
    await waitFor(async () => expect((await matchInfoJob(m.seed_key))?.payload.match_info.long_interval_after_set2).toBe(false), { timeout: 5000 })
  }, 30000)

  it('an approved match: read-only', async () => {
    const matchId = await liveMatch({ status: 'approved' })
    render(<ManualAdjustments matchId={matchId} initialTab="info" tabIds={['info']} onClose={() => {}} onSave={() => {}} />)
    expect(await screen.findByTestId('long-interval-after-set2-switch', {}, { timeout: 5000 })).toBeDisabled()
  }, 30000)
})
