// Sponsors on clothing in Edit match info (owner 2026-11-15): the boxes show
// while the option is on (or the match is marked); a tick after the closing
// signatures clears them (the sheet changed), here and on the server, and the
// server gets the sponsors in match_info.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))
// the save asks first once the sheet was signed (answered yes)
vi.mock('../../ui/uiStore.js', async (orig) => ({ ...(await orig()), confirmDialog: async () => true }))

import '../../i18n'
import { db } from '../../db/db'
import ManualAdjustments from '../ManualAdjustments'

let saved
beforeAll(() => {
  saved = { fetch: globalThis.fetch }
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
})
afterEach(() => {
  cleanup()
  localStorage.removeItem('sponsorsOnClothing')
})
afterAll(() => { globalThis.fetch = saved.fetch })

const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text) && !b.disabled)

async function newMatch (extra = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  return db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'ended', test: false, seed_key: `match_sponsors_${home}`,
    coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, hall: 'Halle', ...extra
  })
}

describe('Edit match info: sponsors on clothing', () => {
  it('option off and an unmarked match: no boxes', async () => {
    const matchId = await newMatch()
    render(<ManualAdjustments matchId={matchId} initialTab="info" onClose={() => {}} onSave={() => {}} />)
    await screen.findByLabelText('Hall')
    expect(screen.queryByTestId('edit-sponsors')).toBeNull()
  }, 30000)

  it('a tick after the signatures: marked, the signatures cleared, match_info sent', async () => {
    localStorage.setItem('sponsorsOnClothing', 'true')
    const matchId = await newMatch({ homePostGameCaptainSignature: 'data:a', awayPostGameCaptainSignature: 'data:b', scorerSignature: 'data:s', ref1Signature: 'data:r1' })
    render(<ManualAdjustments matchId={matchId} initialTab="info" onClose={() => {}} onSave={() => {}} />)
    const home = await screen.findByTestId('edit-sponsors-home', {}, { timeout: 5000 })
    expect(home).not.toBeChecked()
    fireEvent.click(home)
    await waitFor(() => expect(button('Save changes')).toBeTruthy())
    fireEvent.click(button('Save changes'))
    await waitFor(async () => expect(await db.matches.get(matchId)).toMatchObject({ homeSponsors: true, awaySponsors: false, sponsorsMarked: true, scorerSignature: null }), { timeout: 5000 })
    const m = await db.matches.get(matchId)
    expect(m.manualChanges.at(-1)).toMatchObject({ field: 'homeSponsors', before: '(-)', after: '(+)', afterMatch: true })
    await waitFor(async () => expect((await db.sync_queue.toArray()).some(j => j.resource === 'match' && j.payload?.match_info)).toBe(true), { timeout: 5000 })
    const job = (await db.sync_queue.toArray()).find(j => j.resource === 'match' && j.payload?.match_info)
    expect(job.payload.match_info).toMatchObject({ hall: 'Halle', sponsors_home: true, sponsors_away: false, sponsors_marked: true })
    expect(job.payload.signatures).toMatchObject({ scorer: null, ref1: null })
  }, 30000)

  it('the option off, a marked match: its boxes with its answers', async () => {
    const matchId = await newMatch({ awaySponsors: true, sponsorsMarked: true })
    render(<ManualAdjustments matchId={matchId} initialTab="info" onClose={() => {}} onSave={() => {}} />)
    expect(await screen.findByTestId('edit-sponsors-away', {}, { timeout: 5000 })).toBeChecked()
    expect(screen.getByTestId('edit-sponsors-home')).not.toBeChecked()
  }, 30000)
})
