// The coin toss roster dialog's libero selects (owner 27.11.2026): "why
// Libero, Libero 1 and Libero 2 in the dropdown? it is either nothing,
// Libero 1, Libero 2. one libero -> only Libero 1" (domain/liberoChoices).
// A team's only libero is L1: the L1 deleted or set to none, the L2 left
// becomes L1 (no match record yet).
// On the real page over the app's real Dexie database (fake IndexedDB).
// Made-up names.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen, within } from '@testing-library/react'

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
import { FORM_STACK_QUERY } from '../../utils/formLayout'
import CoinToss from '../CoinToss'

let saved
beforeAll(async () => {
  saved = { fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT, matchMedia: window.matchMedia }
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  globalThis.ResizeObserver ||= class { observe () {} unobserve () {} disconnect () {} }
  await i18n.changeLanguage('en')
})
beforeEach(async () => {
  cleanup()
  await Promise.all(db.tables.map(t => t.clear()))
})
afterEach(() => { window.matchMedia = saved.matchMedia })
afterAll(() => {
  cleanup()
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
})

// Home (Team A): #6 L1, #7 L2; away: no libero
async function storeMatch () {
  const homeTeamId = await db.teams.add({ name: 'VBC Nord', shortName: 'NOR' })
  const awayTeamId = await db.teams.add({ name: 'VBC Süd', shortName: 'SUD' })
  const players = (teamId, last, liberos = {}) => Array.from({ length: 7 }, (_, i) => ({
    teamId, number: i + 1, lastName: `${last}${i + 1}`, firstName: 'X', isCaptain: i === 0, dob: '15.06.2003', libero: liberos[i + 1] || ''
  }))
  await db.players.bulkAdd([...players(homeTeamId, 'Nord', { 6: 'libero1', 7: 'libero2' }), ...players(awayTeamId, 'Sued')])
  return db.matches.add({
    status: 'scheduled', coinTossConfirmed: false, createdAt: new Date().toISOString(),
    homeTeamId, awayTeamId, hall: 'Halle Mitte', city: 'Zürich', league: '2L', scheduledAt: '2026-11-15T17:00:00.000Z',
    officials: [{ role: '1st referee', firstName: 'Rita', lastName: 'Pfiff' }],
    bench_home: [{ role: 'Coach', firstName: 'Carla', lastName: 'Coach', dob: '01.01.1975' }],
    bench_away: [{ role: 'Coach', firstName: 'Dora', lastName: 'Trainer', dob: '03.05.1980' }]
  })
}

const Page = (props) => (
  <ScaleProvider><AlertProvider><CoinToss onConfirm={() => {}} onBack={() => {}} {...props} /></AlertProvider></ScaleProvider>
)
const rosterDialog = () => screen.getAllByRole('dialog').find(d => /VBC (Nord|Süd) - roster/.test(d.textContent))
const liberos = () => within(rosterDialog()).getAllByLabelText('Libero')
const options = (select) => [...select.options].map(o => [o.value, o.textContent])
async function openRoster (testId = 'cointoss-roster-a') {
  await waitFor(() => expect(screen.getAllByText('VBC Nord').length).toBeGreaterThan(0))
  fireEvent.click(await screen.findByTestId(testId))
  await waitFor(() => expect(liberos()).toHaveLength(7))
}
const stack = () => {
  window.matchMedia = (query) => ({
    matches: query === FORM_STACK_QUERY, media: query, onchange: null,
    addEventListener () {}, removeEventListener () {}, addListener () {}, removeListener () {}, dispatchEvent: () => false
  })
}

describe('coin toss roster dialog: libero choices', () => {
  it('table layout: a blank none option; the L1 row offers L1, the L2 row L2, the others none only', async () => {
    render(<Page matchId={await storeMatch()} />)
    await openRoster()
    expect(liberos().map(s => s.value)).toEqual(['', '', '', '', '', 'libero1', 'libero2'])
    expect(options(liberos()[0])).toEqual([['', '']])
    expect(options(liberos()[5])).toEqual([['', ''], ['libero1', 'L1']])
    expect(options(liberos()[6])).toEqual([['', ''], ['libero2', 'L2']])
  })

  it('portrait: the none option reads "No libero", never "Libero"', async () => {
    stack()
    render(<Page matchId={await storeMatch()} />)
    await openRoster()
    expect(options(liberos()[0])).toEqual([['', 'No libero']])
    expect(options(liberos()[5])).toEqual([['', 'No libero'], ['libero1', 'L1']])
  })

  it('a team without a libero: none or L1 only (its only libero is never L2)', async () => {
    render(<Page matchId={await storeMatch()} />)
    await openRoster('cointoss-roster-b')
    expect(options(liberos()[2])).toEqual([['', ''], ['libero1', 'L1']])
  })

  it('the L1 set to none: the L2 left becomes L1', async () => {
    render(<Page matchId={await storeMatch()} />)
    await openRoster()
    fireEvent.change(liberos()[5], { target: { value: '' } })
    await waitFor(() => expect(liberos()[6]).toHaveValue('libero1'))
    expect(options(liberos()[5])).toEqual([['', ''], ['libero2', 'L2']])
  })

  it('the L1 deleted: the L2 left becomes L1; a second libero added can only be Libero 2', async () => {
    render(<Page matchId={await storeMatch()} />)
    await openRoster()
    const rowOf = (select) => select.closest('tr')
    fireEvent.click(within(rowOf(liberos()[5])).getByRole('button', { name: 'Delete player' }))
    const confirm = await waitFor(() => screen.getAllByRole('dialog').find(d => /Are you sure you want to delete/.test(d.textContent)))
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(liberos()).toHaveLength(6))
    expect(liberos().map(s => s.value)).toEqual(['', '', '', '', '', 'libero1'])

    fireEvent.click(within(rosterDialog()).getByRole('button', { name: '+ Add player' }))
    const add = await waitFor(() => screen.getAllByRole('dialog').find(d => d.querySelector('.ct-add-player')))
    const addLibero = within(add).getByLabelText('Libero')
    expect(options(addLibero)).toEqual([['', 'No libero'], ['libero2', 'Libero 2']])
    fireEvent.change(within(add).getByLabelText('Number'), { target: { value: '12' } })
    fireEvent.change(within(add).getByLabelText('Last name'), { target: { value: 'Neu' } })
    fireEvent.change(within(add).getByLabelText('First name'), { target: { value: 'Y' } })
    fireEvent.change(addLibero, { target: { value: 'libero2' } })
    fireEvent.click(within(add).getByRole('button', { name: 'Add player' }))
    await waitFor(() => expect(liberos()).toHaveLength(7))
    expect(liberos().map(s => s.value)).toEqual(['', '', '', '', '', 'libero1', 'libero2'])
  })
})
