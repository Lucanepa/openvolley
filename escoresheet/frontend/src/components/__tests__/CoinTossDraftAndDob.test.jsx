// The coin toss page, owner 2026-11-15 (live match, 3.2.5/3.2.6):
//  - "the warning for bday 1.1.xxxx should be in the roster only, not at coin
//    toss": dates of birth on 1 January (01.01.1900 too) no longer ask
//    "Confirm birthdates" nor hold "Confirm coin toss result";
//  - "I said go back and it did not save the coin toss result": Team A and
//    the first serve chosen here stay after Back and coming back, without
//    the toss being confirmed.
// On the real page over the app's real Dexie database (fake IndexedDB).
// Made-up names.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/react'

vi.mock('../../utils/preMatchChecks', () => ({
  runConnectionChecks: async () => [],
  checksOutcome: () => 'offline',
  readOfflineMode: () => true
}))
vi.mock('../../utils/scoresheetUploader', () => ({ uploadScoresheetAsync: () => {} }))
vi.mock('../../utils/logger', () => ({ uploadBackupToCloud: () => {}, uploadLogsToCloud: () => {} }))

import '../../i18n'
import i18n from '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { db } from '../../db/db'
import CoinToss from '../CoinToss'

let saved
beforeAll(async () => {
  saved = { fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  globalThis.ResizeObserver ||= class { observe () {} unobserve () {} disconnect () {} }
  await i18n.changeLanguage('en')
})
beforeEach(async () => {
  cleanup()
  await Promise.all(db.tables.map(t => t.clear()))
})
afterAll(() => {
  cleanup()
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
})

const OFFICIALS = [
  { role: '1st referee', firstName: 'Rita', lastName: 'Pfiff' },
  { role: 'scorer', firstName: 'Sam', lastName: 'Schreiber', dob: '12.04.1990' }
]

async function storeMatch (extra = {}) {
  const homeTeamId = await db.teams.add({ name: 'VBC Nord', shortName: 'NOR' })
  const awayTeamId = await db.teams.add({ name: 'VBC Süd', shortName: 'SUD' })
  const players = (teamId, last) => Array.from({ length: 7 }, (_, i) => ({
    teamId, number: i + 1, lastName: `${last}${i + 1}`, firstName: 'X', isCaptain: i === 0,
    // a placeholder and a 1 January date: the coin toss does not ask about them
    dob: i === 1 ? '01.01.1900' : i === 2 ? '01.01.2004' : '15.06.2003'
  }))
  await db.players.bulkAdd([...players(homeTeamId, 'Nord'), ...players(awayTeamId, 'Sued')])
  return db.matches.add({
    status: 'scheduled', coinTossConfirmed: false, createdAt: new Date().toISOString(),
    homeTeamId, awayTeamId, hall: 'Halle Mitte', city: 'Zürich', league: '2L', scheduledAt: '2026-11-15T17:00:00.000Z',
    officials: OFFICIALS,
    bench_home: [{ role: 'Coach', firstName: 'Carla', lastName: 'Coach', dob: '01.01.1975' }],
    bench_away: [{ role: 'Coach', firstName: 'Dora', lastName: 'Trainer', dob: '03.05.1980' }],
    ...extra
  })
}

const Page = (props) => (
  <ScaleProvider><AlertProvider><CoinToss onConfirm={() => {}} onBack={() => {}} {...props} /></AlertProvider></ScaleProvider>
)
const button = (name) => screen.findByRole('button', { name })
const row = (id) => db.matches.get(id)
// Both teams' names are on the page once it has read the match
const loaded = () => waitFor(() => {
  expect(screen.getAllByText('VBC Nord').length).toBeGreaterThan(0)
  expect(screen.getAllByText('VBC Süd').length).toBeGreaterThan(0)
})

describe('coin toss: Back keeps the choices', () => {
  it('Team A and the first serve chosen are on the match as a draft, not as a confirmed toss', async () => {
    const id = await storeMatch()
    const onBack = vi.fn()
    const first = render(<Page matchId={id} onBack={onBack} />)
    await loaded()
    fireEvent.click(await button('Switch sides'))
    await waitFor(async () => expect((await row(id)).coinTossDraft).toEqual({ teamA: 'away', serveA: true }))
    fireEvent.click(await button('Switch serve'))
    await waitFor(async () => expect((await row(id)).coinTossDraft).toEqual({ teamA: 'away', serveA: false }))
    fireEvent.click(await button('Back'))
    expect(onBack).toHaveBeenCalled()
    first.unmount()

    // nothing confirmed: the app still reads the toss as not done
    const stored = await row(id)
    expect(stored.coinTossConfirmed).toBe(false)
    expect(stored.coinTossTeamA).toBeUndefined()
    expect(stored.coinTossServeA).toBeUndefined()
    expect(stored.firstServe).toBeUndefined()
    expect(await db.events.where('matchId').equals(id).count()).toBe(0)

    // back on the page: it opens as left. A switch from there turns the
    // draft back (had it opened as Team A home / A serving, these would
    // have given away / B serving)
    render(<Page matchId={id} />)
    await loaded()
    fireEvent.click(await button('Switch sides'))
    await waitFor(async () => expect((await row(id)).coinTossDraft).toEqual({ teamA: 'home', serveA: false }))
    fireEvent.click(await button('Switch serve'))
    await waitFor(async () => expect((await row(id)).coinTossDraft).toEqual({ teamA: 'home', serveA: true }))
  })
})

describe('coin toss: dates of birth on 1 January', () => {
  it('do not ask "Confirm birthdates" and do not hold the confirm; the draft is what is confirmed', async () => {
    const id = await storeMatch({ coinTossDraft: { teamA: 'away', serveA: false } })
    const onConfirm = vi.fn()
    render(<Page matchId={id} onConfirm={onConfirm} />)
    await loaded()
    fireEvent.click(await button('Confirm coin toss result'))
    await waitFor(async () => expect((await row(id)).coinTossConfirmed).toBe(true))
    expect(screen.queryByText(/birthdates/i)).toBeNull()
    expect(screen.queryByText(/January/i)).toBeNull()
    const stored = await row(id)
    expect(stored).toMatchObject({ coinTossTeamA: 'away', coinTossTeamB: 'home', coinTossServeA: false, coinTossServeB: true, firstServe: 'home' })
    expect(stored.coinTossDraft).toBeNull()
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(id))
  })
})
