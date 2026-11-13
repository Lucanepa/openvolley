// The Match End editor's "Save changes" (Teams / Match info), pre-rollout
// audit 2026-11:
// - fe-home-options-3: the cloud roster lost every date of birth and LFP
//   mark, and set_results went in a shape no reader takes;
// - fe-home-options-4: a new date filed the official PDF where the server
//   never looks, a new game number reached nothing;
// - fe-home-options-1: a save after the sheet was signed undid the server's
//   approvals only online (they came back), and changes other than a team
//   name kept every signature;
// - fe-home-options-2: the log took one entry per keystroke.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))
const dialog = vi.hoisted(() => ({ answer: true, calls: [] }))
vi.mock('../../ui/uiStore.js', async (orig) => ({
  ...(await orig()),
  confirmDialog: async (opts) => { dialog.calls.push(opts); return dialog.answer }
}))
const undo = vi.hoisted(() => ({ fn: null }))
vi.mock('../../lib/accountApi', async (orig) => {
  const real = await orig()
  return { ...real, approvalsApi: { ...real.approvalsApi, undo: (...a) => undo.fn(...a) } }
})

import '../../i18n'
import { db } from '../../db/db'
import ManualAdjustments from '../ManualAdjustments'
import { resultKey } from '../../domain/accountApproval'

let saved
beforeAll(() => {
  saved = { fetch: globalThis.fetch }
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
})
afterAll(() => {
  cleanup()
  globalThis.fetch = saved.fetch
})
beforeEach(async () => {
  cleanup()
  dialog.answer = true
  dialog.calls = []
  undo.fn = vi.fn(async () => ({ data: {}, error: null }))
  await db.open()
  await Promise.all(db.tables.map(t => t.clear()))
})

const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text) && !b.disabled)
const SETS = [
  { index: 1, homePoints: 25, awayPoints: 20, finished: true },
  { index: 2, homePoints: 25, awayPoints: 18, finished: true },
  { index: 3, homePoints: 25, awayPoints: 22, finished: true }
]

async function seed(over = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'ended', test: false, seed_key: 'match_editor_save_1',
    hall: 'North Hall', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true,
    game_n: 4711, gameNumber: '4711', scheduledAt: '2026-11-07T19:00:00.000Z',
    ...over
  })
  await db.players.bulkAdd([
    { teamId: home, number: 4, firstName: 'Mia', lastName: 'Example', dob: '2010-03-04', isLfp: true, isCaptain: true },
    { teamId: home, number: 7, firstName: 'Lena', lastName: 'Sample', dob: '2009-05-06', libero: 'libero1' },
    { teamId: away, number: 9, firstName: 'Zoe', lastName: 'Test', dob: '2010-07-08', isCaptain: true }
  ])
  await db.sets.bulkAdd(SETS.map(s => ({ ...s, matchId })))
  return matchId
}

async function openInfo(matchId) {
  render(<ManualAdjustments matchId={matchId} onClose={() => {}} onSave={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Match info' }))
  let hall
  await waitFor(() => {
    hall = screen.getByRole('textbox', { name: 'Hall' })
    expect(hall.value).toBe('North Hall')
  }, { timeout: 5000 })
  return hall
}
const matchJob = async () => (await db.sync_queue.toArray()).find(j => j.resource === 'match' && j.payload?.match_info)

describe('ManualAdjustments: Save at the match end', () => {
  it('sends the roster as the other writers do (dates of birth, LFP) and set_results as finished sets', async () => {
    const matchId = await seed()
    const hall = await openInfo(matchId)
    fireEvent.change(hall, { target: { value: 'South Hall' } })
    await waitFor(() => expect(button('Save changes')).toBeTruthy())
    fireEvent.click(button('Save changes'))
    await waitFor(async () => expect(await matchJob()).toBeTruthy(), { timeout: 5000 })
    const job = await matchJob()
    expect(job.payload.set_results).toEqual([{ set: 1, home: 25, away: 20 }, { set: 2, home: 25, away: 18 }, { set: 3, home: 25, away: 22 }])
    expect(job.payload.players_home).toEqual([
      { number: 4, first_name: 'Mia', last_name: 'Example', dob: '2010-03-04', libero: '', is_captain: true, is_lfp: true },
      { number: 7, first_name: 'Lena', last_name: 'Sample', dob: '2009-05-06', libero: 'libero1', is_captain: false, is_lfp: false }
    ])
    expect(job.payload.players_away).toEqual([
      { number: 9, first_name: 'Zoe', last_name: 'Test', dob: '2010-07-08', libero: '', is_captain: true, is_lfp: false }
    ])
  }, 30000)

  it('the game number and the date are fixed after the match: the PDF stays where the server looks', async () => {
    const matchId = await seed()
    await openInfo(matchId)
    expect(screen.getByRole('textbox', { name: 'Game number' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Game number' }).value).toBe('4711')
    const dateInputs = [...document.querySelectorAll('input')].filter(i => (i.getAttribute('aria-label') || '').startsWith('Scheduled date/time'))
    expect(dateInputs.length).toBeGreaterThan(0)
    for (const input of dateInputs) expect(input).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Hall' }), { target: { value: 'South Hall' } })
    fireEvent.click(button('Save changes'))
    await waitFor(async () => expect(await matchJob()).toBeTruthy(), { timeout: 5000 })
    const after = await db.matches.get(matchId)
    expect(after.scheduledAt).toBe('2026-11-07T19:00:00.000Z')
    expect(after.gameN).toBeUndefined()
    expect((await matchJob()).payload).not.toHaveProperty('scheduled_at')
  }, 30000)

  it('one log entry per field (not one per keystroke), marked as a change after the match', async () => {
    const matchId = await seed()
    const hall = await openInfo(matchId)
    for (const v of ['S', 'So', 'Sou', 'South Hall']) fireEvent.change(hall, { target: { value: v } })
    fireEvent.change(screen.getByRole('textbox', { name: 'City' }), { target: { value: 'Townsville' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'City' }), { target: { value: '' } })
    await waitFor(() => expect(button('Save changes')?.textContent).toContain('(1)'))
    fireEvent.click(button('Save changes'))
    await waitFor(async () => expect((await db.matches.get(matchId)).manualChanges).toHaveLength(1), { timeout: 5000 })
    // the cloud update queued too (a save still running would write into the next test)
    await waitFor(async () => expect(await matchJob()).toBeTruthy(), { timeout: 5000 })
    expect((await db.matches.get(matchId)).manualChanges[0]).toMatchObject({
      category: 'match', field: 'hall', before: 'North Hall', after: 'South Hall', afterMatch: true,
      description: 'Hall: North Hall → South Hall'
    })
  }, 30000)

  it('after the sheet was signed or approved: asks, clears both, and queues the approvals\' undo', async () => {
    const approval = { id: '44444444-4444-4444-8444-444444444444', slot: 'referee1', name: 'Ref One', result_key: resultKey(SETS) }
    const matchId = await seed({ homePostGameCaptainSignature: 'data:a', accountApprovals: { referee1: approval } })
    const hall = await openInfo(matchId)
    fireEvent.change(hall, { target: { value: 'South Hall' } })
    fireEvent.click(button('Save changes'))
    await waitFor(async () => expect((await db.matches.get(matchId)).homePostGameCaptainSignature).toBeNull(), { timeout: 5000 })
    expect(dialog.calls).toHaveLength(1)
    expect((await db.matches.get(matchId)).accountApprovals).toBeNull()
    const jobs = await db.sync_queue.toArray()
    expect(jobs.filter(j => j.resource === 'approval').map(j => [j.action, j.payload.id])).toEqual([['undo', approval.id]])
    expect((await matchJob()).payload.signatures).toMatchObject({ home_captain_post_game: null, ref1: null })
    expect(undo.fn).not.toHaveBeenCalled()
  }, 30000)

  it('declined: nothing is saved', async () => {
    dialog.answer = false
    const matchId = await seed({ ref1Signature: 'data:r1' })
    const hall = await openInfo(matchId)
    fireEvent.change(hall, { target: { value: 'South Hall' } })
    fireEvent.click(button('Save changes'))
    await waitFor(() => expect(dialog.calls).toHaveLength(1))
    await new Promise(r => setTimeout(r, 100))
    const after = await db.matches.get(matchId)
    expect(after.hall).toBe('North Hall')
    expect(after.ref1Signature).toBe('data:r1')
    expect(await db.sync_queue.count()).toBe(0)
  }, 30000)
})
