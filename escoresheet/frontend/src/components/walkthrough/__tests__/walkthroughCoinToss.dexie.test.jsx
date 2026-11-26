// The coin toss of the walkthrough's own test match starts unsigned (owner
// follow-up 26.11.2026: the step "Captain and coach sign here" showed "Sign A ✓
// / Sign B ✓" before anyone signed, a test match's placeholders). Any other
// test match keeps them; the tour's toss is still confirmed without anyone
// signing (a test match then gets the placeholders, as before).
// The real page over the app's Dexie database (fake IndexedDB). Made-up names.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen, act } from '@testing-library/react'

vi.mock('../../../utils/preMatchChecks', () => ({
  runConnectionChecks: async () => [],
  checksOutcome: () => 'offline',
  readOfflineMode: () => true
}))
vi.mock('../../../utils/scoresheetUploader', () => ({ uploadScoresheetAsync: () => {} }))
vi.mock('../../../utils/logger', () => ({ uploadBackupToCloud: () => {}, uploadLogsToCloud: () => {} }))

import '../../../i18n'
import i18n from '../../../i18n'
import { AlertProvider } from '../../../contexts/AlertContext'
import { ScaleProvider } from '../../../contexts/ScaleContext'
import { db } from '../../../db/db'
import CoinToss from '../../CoinToss'
import { startWalkthrough, setWalkthroughMatch, resetWalkthroughForTests, isWalkthroughMatch } from '../walkthroughStore'

let saved
beforeAll(async () => {
  saved = { fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  globalThis.ResizeObserver ||= class { observe () {} unobserve () {} disconnect () {} }
  // jsdom has no canvas: the placeholder signature draws nothing
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({})), set: (t, k, v) => { t[k] = v; return true } })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => 'data:image/png;base64,placeholder')
  await i18n.changeLanguage('en')
})
beforeEach(async () => {
  cleanup()
  resetWalkthroughForTests()
  await Promise.all(db.tables.map(t => t.clear()))
})
afterEach(() => resetWalkthroughForTests())
afterAll(() => {
  cleanup()
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

async function storeTestMatch () {
  const homeTeamId = await db.teams.add({ name: 'VBC Musterau', shortName: 'MUS' })
  const awayTeamId = await db.teams.add({ name: 'VC Beispielstadt', shortName: 'BSP' })
  const players = (teamId, last) => Array.from({ length: 7 }, (_, i) => ({ teamId, number: i + 1, lastName: `${last}${i + 1}`, firstName: 'X', isCaptain: i === 0, dob: '15.06.2003' }))
  await db.players.bulkAdd([...players(homeTeamId, 'Muster'), ...players(awayTeamId, 'Beispiel')])
  return db.matches.add({
    test: true, status: 'scheduled', coinTossConfirmed: false, createdAt: new Date().toISOString(), homeTeamId, awayTeamId,
    officials: [{ role: 'scorer', firstName: 'Sam', lastName: 'Schreiber', dob: '12.04.1990' }],
    bench_home: [{ role: 'Coach', firstName: 'Carla', lastName: 'Coach', dob: '01.01.1975' }],
    bench_away: [{ role: 'Coach', firstName: 'Dora', lastName: 'Trainer', dob: '03.05.1980' }]
  })
}

const Page = (props) => <ScaleProvider><AlertProvider><CoinToss onConfirm={() => {}} onBack={() => {}} {...props} /></AlertProvider></ScaleProvider>
const signA = () => screen.findByTestId('cointoss-sign-a')

describe('walkthrough: its coin toss starts unsigned', () => {
  it('the tour\'s test match: Sign A / Sign B (0/2), and the toss is confirmed without signing', async () => {
    const id = await storeTestMatch()
    act(() => { startWalkthrough({ chapter: 3 }); setWalkthroughMatch(id) })
    expect(isWalkthroughMatch(id)).toBe(true)
    const onConfirm = vi.fn()
    render(<Page matchId={id} onConfirm={onConfirm} />)
    await waitFor(async () => expect((await signA()).textContent).toMatch(/\(0\/2\)/))
    expect((await screen.findByTestId('cointoss-sign-b')).textContent).toMatch(/\(0\/2\)/)

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm coin toss result' }))
    await waitFor(async () => expect((await db.matches.get(id)).coinTossConfirmed).toBe(true))
    const stored = await db.matches.get(id)
    expect(stored.homeCaptainSignature).toBeTruthy()
    expect(stored.awayCoachSignature).toBeTruthy()
  })

  it('any other test match keeps its placeholders (✓), also while the tour runs elsewhere', async () => {
    const id = await storeTestMatch()
    const other = await storeTestMatch()
    act(() => { startWalkthrough({ chapter: 3 }); setWalkthroughMatch(other) })
    expect(isWalkthroughMatch(id)).toBe(false)
    render(<Page matchId={id} />)
    await waitFor(async () => expect((await signA()).textContent).toContain('✓'))
    cleanup()
    // the tour ended: its match is an ordinary test match again
    resetWalkthroughForTests()
    expect(isWalkthroughMatch(other)).toBe(false)
    render(<Page matchId={other} />)
    await waitFor(async () => expect((await signA()).textContent).toContain('✓'))
  })
})
