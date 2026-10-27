// 2026-10-23: the owner's phone kept a 'live' copy of match 406970 that the
// server had approved and closed. The app reopened it on its scoring screen
// at every start, and nothing offered a way out but scoring on. A copy the
// server has closed now never auto-opens and never reaches the scoring
// screen: its dialog offers the official version or removing the copy.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { waitFor, fireEvent, cleanup, screen } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
// the restore refusal itself is backupManager's (its own tests): here only
// what App shows for it
vi.mock('../utils/backupManager', async (importOriginal) => ({
  ...(await importOriginal()),
  selectBackupFile: vi.fn(),
  restoreMatchFromJson: vi.fn()
}))
import { db } from '../db/db'
import { restoreMatchFromJson, selectBackupFile } from '../utils/backupManager'
import en from '../i18n/locales/en.json'
import { offline, online, mountApp, button, sleep } from './appMount'
import { reloadInto } from './selfCheckFixtures'

beforeAll(offline)
afterAll(online)
beforeEach(async () => {
  cleanup()
  await Promise.all(db.tables.map(table => table.clear()))
  sessionStorage.clear()
})

const SEED = 'match_1792518507614_u2sbmb'
const start = new Date(Date.now() - 3600000).toISOString()

// An official match on its third set, as the phone had it
async function seedMatch(fields = {}) {
  const home = await db.teams.add({ name: 'Home', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away', shortName: 'AWA' })
  await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
    { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1 },
    { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1 }
  ]))
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', createdAt: start, matchInfoConfirmedAt: start,
    seed_key: SEED, gameN: 406970, gamePin: '482915',
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false,
    homeCoachSignature: 'x', homeCaptainSignature: 'x', awayCoachSignature: 'x', awayCaptainSignature: 'x',
    ...fields
  })
  await db.sets.bulkAdd([
    { matchId, index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: start, endTime: start },
    { matchId, index: 2, homePoints: 20, awayPoints: 25, finished: true, startTime: start, endTime: start },
    { matchId, index: 3, homePoints: 12, awayPoints: 10, finished: false, startTime: start }
  ])
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: start })
  return matchId
}

const closedBlock = { code: 'OV_MATCH_CLOSED', claim: null, at: Date.parse(start) }
const seedClosedCopy = () => seedMatch({ cloudBlock: closedBlock })

const closedModal = () => document.querySelector('[data-testid="closed-copy-modal"]')
const homeShown = () => !!button('Restore match')
// the Scoreboard's own screen (its set and rally controls), not the home screen
const scoreboardShown = () => !homeShown() && !closedModal() && /Set 3|Start rally|Start set/.test(document.body.textContent)

describe('App: a copy of a match the server has closed', () => {
  it('is not reopened at start: the home screen says it differs, no scoring screen', async () => {
    await seedClosedCopy()
    mountApp()
    await waitFor(() => expect(button('Continue match')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('cloud-block-notice').textContent).toBe(en.cloudBlock.matchClosedDiffers))
    await sleep(500)
    expect(homeShown()).toBe(true)
    expect(closedModal()).toBeNull()
    expect(document.body.textContent).not.toMatch(/Start rally/)
  })

  it('Continue opens the closed-copy dialog, never the scoring screen; Close goes home with the copy kept', async () => {
    const matchId = await seedClosedCopy()
    mountApp()
    await waitFor(() => expect(button('Continue match')).toBeTruthy())
    fireEvent.click(button('Continue match'))
    await waitFor(() => expect(closedModal()).toBeTruthy())
    await sleep(300)
    expect(document.body.textContent).not.toMatch(/Start rally/)
    expect(closedModal().textContent).toContain(en.cloudBlock.closedCopy.body)

    fireEvent.click(button(en.common.close))
    await waitFor(() => expect(closedModal()).toBeNull())
    expect(homeShown()).toBe(true)
    expect(button('Continue match')).toBeTruthy()
    expect(await db.matches.get(matchId)).toBeTruthy()
  })

  it('Load the official version needs a connection', async () => {
    await seedClosedCopy()
    const onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    try {
      mountApp()
      await waitFor(() => expect(button('Continue match')).toBeTruthy())
      fireEvent.click(button('Continue match'))
      await waitFor(() => expect(closedModal()).toBeTruthy())
      fireEvent.click(button(en.cloudBlock.closedCopy.loadOfficial))
      await waitFor(() => expect(document.querySelector('[data-testid="closed-copy-error"]')?.textContent).toBe(en.cloudBlock.closedCopy.errors.offline))
      expect(closedModal()).toBeTruthy()
    } finally {
      onLine.mockRestore()
    }
  })

  it('Remove from this device: the delete dialog with its game PIN, only the local copy goes', async () => {
    const matchId = await seedClosedCopy()
    // the refused restore of the incident and a newer write it held back
    await db.sync_queue.bulkAdd([
      { resource: 'match', action: 'restore', payload: { match: { external_id: SEED, status: 'live' } }, ts: start, status: 'failed' },
      { resource: 'match', action: 'update', payload: { id: SEED, status: 'live' }, ts: start, status: 'queued' }
    ])
    mountApp()
    await waitFor(() => expect(button('Continue match')).toBeTruthy())
    fireEvent.click(button('Continue match'))
    await waitFor(() => expect(closedModal()).toBeTruthy())
    fireEvent.click(button(en.cloudBlock.closedCopy.remove))
    await waitFor(() => expect(document.body.textContent).toContain(en.cloudBlock.removeLocalOnly))
    expect(closedModal()).toBeNull()
    expect(document.body.textContent).not.toContain('from the cloud database')

    // the game PIN step is kept
    fireEvent.click(button(en.deleteMatch.delete))
    await waitFor(() => expect(document.body.textContent).toContain('Please enter the game PIN'))
    fireEvent.change(document.getElementById('delete-match-pin'), { target: { value: '482915' } })
    fireEvent.click(button(en.deleteMatch.delete))
    await waitFor(async () => expect(await db.matches.get(matchId)).toBeUndefined())
    await sleep(300)

    expect(await db.sets.where('matchId').equals(matchId).count()).toBe(0)
    expect(await db.events.where('matchId').equals(matchId).count()).toBe(0)
    // its jobs are gone and no server delete was queued: the server keeps
    // the closed record
    expect(await db.sync_queue.toArray()).toEqual([])
    expect(closedModal()).toBeNull()
    expect(homeShown()).toBe(true)
    expect(button('Continue match')).toBeFalsy()
  })

  it('a backup refused as closed on the server says so', async () => {
    selectBackupFile.mockResolvedValue({ match: { seed_key: SEED, external_id: SEED, status: 'live', gameN: 406970 }, sets: [], events: [] })
    restoreMatchFromJson.mockRejectedValue(Object.assign(new Error('This match is closed on the server'), { code: 'OV_MATCH_CLOSED' }))
    mountApp()
    await waitFor(() => expect(button('Restore match')).toBeTruthy())
    fireEvent.click(button('Restore match'))
    await waitFor(() => expect(button(en.settings.backup.selectBackupFile)).toBeTruthy())
    fireEvent.click(button(en.settings.backup.selectBackupFile))
    await waitFor(() => expect(button(en.settings.backup.preview.confirmRestore)).toBeTruthy())
    fireEvent.click(button(en.settings.backup.preview.confirmRestore))
    await waitFor(() => expect(document.body.textContent).toContain(en.cloudBlock.restoreRefused))
    expect(restoreMatchFromJson).toHaveBeenCalledTimes(1)
    expect(button(en.settings.backup.preview.confirmRestore)).toBeFalsy()
    expect(await db.matches.count()).toBe(0)
  })

  // (a fresh start opens Home, AppOpenAndResume: a reload goes back)
  it('a live official match without a block still reopens on its scoring screen on a reload', async () => {
    reloadInto(await seedMatch())
    mountApp()
    await waitFor(() => expect(scoreboardShown()).toBe(true), { timeout: 5000 })
    expect(closedModal()).toBeNull()
  })

  it('a live test match with a closed block still reopens on a reload: never a closed copy', async () => {
    reloadInto(await seedMatch({ test: true, seed_key: 'test-match-1', cloudBlock: closedBlock, matchInfoConfirmedAt: undefined }))
    mountApp()
    await waitFor(() => expect(scoreboardShown()).toBe(true), { timeout: 5000 })
    expect(closedModal()).toBeNull()
  })

  it('scoring when the server closes the match: the scoring screen goes, the dialog comes', async () => {
    const matchId = await seedMatch()
    reloadInto(matchId)
    mountApp()
    await waitFor(() => expect(scoreboardShown()).toBe(true), { timeout: 5000 })
    // the first 409 OV_MATCH_CLOSED (useSyncQueue recordCloudBlock)
    await db.matches.update(matchId, { cloudBlock: closedBlock })
    await waitFor(() => expect(closedModal()).toBeTruthy())
    expect(scoreboardShown()).toBe(false)
    fireEvent.click(button(en.common.close))
    await waitFor(() => expect(homeShown()).toBe(true))
    expect(closedModal()).toBeNull()
  })
})
