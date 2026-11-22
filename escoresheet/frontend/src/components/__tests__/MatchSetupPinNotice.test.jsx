/**
 * The game PIN notice in Match setup (utils/pinNotice, MatchPinNotice), owner
 * 22.11.2026: right after Create match of a new official match, once per
 * match on this device. OK notes it on the match row (pinNoticeShownAt, never
 * synced): Coin toss later goes straight on, and a match created and then
 * resumed straight at the coin toss (App.jsx) had its notice at creation. A
 * test match, and a Save of a match already created, never show it.
 * Harness: MatchSetupAfterCoinToss.test.jsx (in-memory Dexie stand-in).
 * Made-up names.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => String(typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en', changeLanguage: () => Promise.resolve() }
  })
}))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn(), showConfirm: vi.fn() }) }))
const auth = vi.hoisted(() => ({ user: null }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.user, profile: null, getCachedProfile: () => null }) }))

vi.mock('dexie-react-hooks', async () => {
  const React = await import('react')
  return {
    useLiveQuery: (fn, deps = []) => {
      const [value, setValue] = React.useState(undefined)
      React.useEffect(() => {
        let alive = true
        Promise.resolve(fn()).then((v) => { if (alive) setValue(v) })
        return () => { alive = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps)
      return value
    }
  }
})

const store = vi.hoisted(() => ({ tables: {}, nextId: 1, updates: [] }))
vi.mock('../../db/db', () => {
  const rowsOf = (name) => (store.tables[name] ||= new Map())
  const collection = (rows) => {
    const c = {
      equals: () => c, above: () => c, below: () => c, anyOf: () => c, between: () => c,
      filter: () => c, and: () => c, reverse: () => c, limit: () => c, offset: () => c,
      toArray: async () => rows, sortBy: async () => rows, first: async () => rows[0],
      last: async () => rows[rows.length - 1], count: async () => rows.length,
      modify: async () => 0, delete: async () => 0, each: async () => {}, primaryKeys: async () => []
    }
    return c
  }
  const table = (name) => ({
    get: async (id) => rowsOf(name).get(id),
    add: async (row) => { const id = row?.id ?? store.nextId++; rowsOf(name).set(id, { ...row, id }); return id },
    put: async (row) => { const id = row?.id ?? store.nextId++; rowsOf(name).set(id, { ...row, id }); return id },
    bulkAdd: async (rows) => { for (const r of rows) await table(name).add(r) },
    bulkDelete: async (ids) => { for (const id of ids) rowsOf(name).delete(id) },
    update: async (id, changes) => {
      store.updates.push([name, id, changes])
      const r = rowsOf(name).get(id); if (!r) return 0; rowsOf(name).set(id, { ...r, ...changes }); return 1
    },
    delete: async (id) => { rowsOf(name).delete(id) },
    toArray: async () => [...rowsOf(name).values()],
    count: async () => rowsOf(name).size,
    where: (field) => name === 'players'
      ? { equals: (v) => {
          const rows = [...rowsOf(name).values()].filter((r) => r[field] === v)
          return { ...collection(rows), delete: async () => { for (const r of rows) rowsOf(name).delete(r.id); return rows.length } }
        } }
      : collection([]),
    orderBy: () => collection([]),
    filter: () => collection([]),
    clear: async () => rowsOf(name).clear(),
    hook: () => {}
  })
  const db = new Proxy({}, {
    get: (_, prop) => {
      if (prop === 'transaction') return async (...args) => args[args.length - 1]()
      if (typeof prop !== 'string' || prop === 'then') return undefined
      return table(prop)
    }
  })
  return { db, default: db }
})

vi.mock('../../lib/apiClient', () => {
  const chain = () => {
    const b = new Proxy({}, {
      get: (_, prop) => {
        if (prop === 'then') return (resolve) => Promise.resolve({ data: null, error: null }).then(resolve)
        return () => b
      }
    })
    return b
  }
  return {
    apiFrom: () => chain(),
    apiStorage: { from: () => chain() },
    AUTH_TOKEN_CHANGE_EVENT: 'ov-test-auth-token-change',
    AUTH_TOKEN_STORAGE_KEY: 'api_auth_token',
    apiMatchRestore: () => chain(),
    apiMatchClaim: () => chain(),
    // the session of the signed-in test only
    authorizationHeader: () => (auth.user ? { Authorization: 'Bearer tok' } : {})
  }
})
// the cloud backend of the app (send-pin; send-info is not sent here: no match is created)
vi.mock('../../utils/backendConfig', async (orig) => ({
  ...(await orig()),
  getCloudApiUrl: (path) => `https://backend.example${path}`
}))
vi.mock('../../utils/logger', () => ({ uploadBackupToCloud: vi.fn(), uploadLogsToCloud: vi.fn() }))
vi.mock('../../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() }))
vi.mock('../../db/rememberedPlayers', () => ({ rememberedRosters: async () => [] }))

// The schedule picker: a button that hands the test's game to Match setup
const schedule = vi.hoisted(() => ({ game: null }))
vi.mock('../LoadOfficialMatchModal', async (orig) => ({
  ...(await orig()),
  default: ({ open, onSelectMatch }) => (open ? <button type="button" onClick={() => onSelectMatch(schedule.game)}>pick-schedule-game</button> : null)
}))
const ui = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }))
vi.mock('../../ui', async (orig) => ({ ...(await orig()), confirmDialog: (...a) => ui.confirm(...a) }))

import MatchSetup from '../MatchSetup'
import { ScaleProvider } from '../../contexts/ScaleContext'

const Setup = (props) => <ScaleProvider><MatchSetup onStart={() => {}} onReturn={() => {}} {...props} /></ScaleProvider>
const queued = () => [...(store.tables.sync_queue?.values() || [])]
const drafts = () => [...(store.tables.match_setup?.values() || [])]
const PINS = { refereePin: '111111', homeTeamPin: '222222', awayTeamPin: '333333', homeTeamUploadPin: '444444', awayTeamUploadPin: '555555' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const matchUpdates = (key) => store.updates.filter(([table, , changes]) => table === 'matches' && key in changes)

const players = (teamId, base, prefix) => Array.from({ length: 6 }, (_, i) => [base + i, {
  id: base + i, teamId, number: i + 1, lastName: `${prefix}${i + 1}`, firstName: 'P', isCaptain: i === 0, dob: '01.01.2000'
}])

function storeMatch (extra = {}) {
  store.tables.matches = new Map([[1, {
    id: 1, status: 'setup', seed_key: 'match_1_setup', matchInfoConfirmedAt: '2026-11-01T10:00:00Z', connectionPinsQueuedAt: '2026-11-01T10:00:00Z',
    refereeConnectionEnabled: false, homeTeamConnectionEnabled: false, awayTeamConnectionEnabled: false,
    homeTeamId: 11, awayTeamId: 12, homeName: 'Alpha VC', awayName: 'Beta VC', homeShortName: 'ALP', awayShortName: 'BET',
    scheduledAt: '2026-11-20T18:00:00.000Z', game_n: 991501, league: '3L', hall: 'Halle A', city: 'Musterdorf', bestOf: 5,
    gamePin: '654321',
    bench_home: [{ role: 'Coach', firstName: 'Cora', lastName: 'Coach' }],
    bench_away: [{ role: 'Coach', firstName: 'Cleo', lastName: 'Coach' }],
    officials: [
      { role: '1st referee', firstName: 'Rita', lastName: 'Ref', country: 'CHE', dob: '01.01.1990' },
      { role: 'scorer', firstName: 'Sina', lastName: 'Scorer', country: 'CHE', dob: '02.02.2000' }
    ],
    ...PINS, ...extra
  }]])
  store.tables.teams = new Map([[11, { id: 11, name: 'Alpha VC', color: '#c00000' }], [12, { id: 12, name: 'Beta VC', color: '#0000c0' }]])
  store.tables.players = new Map([...players(11, 200, 'Alpha'), ...players(12, 300, 'Beta')])
}

beforeEach(() => {
  store.tables = {}
  store.nextId = 1000
  store.updates = []
  schedule.game = null
  auth.user = null
  ui.confirm.mockReset()
  ui.confirm.mockImplementation(async () => true)
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function clickCoinToss () {
  const coinToss = await screen.findByRole('button', { name: 'matchSetup.coinToss' })
  await waitFor(() => expect(coinToss).not.toBeDisabled())
  fireEvent.click(coinToss)
}

// A match not created yet: Create match on the main view opens the info
// page, its Create match creates it
async function createMatch () {
  fireEvent.click(await screen.findByRole('button', { name: 'matchSetup.createMatch' }))
  const create = await screen.findByRole('button', { name: 'matchSetup.createMatch' })
  await waitFor(() => expect(create).not.toBeDisabled())
  fireEvent.click(create)
}

const NEW = { matchInfoConfirmedAt: null, connectionPinsQueuedAt: null }

describe('the game PIN notice right after Create match', () => {
  it('a new official match: shown right after Create match, OK notes it, Coin toss then goes straight on', async () => {
    storeMatch(NEW)
    const onOpenCoinToss = vi.fn()
    render(<Setup matchId={1} onOpenCoinToss={onOpenCoinToss} />)
    await createMatch()
    expect(await screen.findByTestId('pin-notice')).toBeInTheDocument()
    expect(store.tables.matches.get(1).matchInfoConfirmedAt).toEqual(expect.any(String))
    expect(screen.getByTestId('pin-notice-pin')).toHaveTextContent('654321')
    expect(screen.getByText('Please write the PIN down somewhere: it is needed to recover the match and/or to reopen it.')).toBeInTheDocument()
    // the teams as Match setup shows them
    expect(screen.getByTestId('pin-notice').textContent).toContain('Alpha VC – Beta VC')
    fireEvent.click(screen.getByTestId('pin-notice-ok'))
    await waitFor(() => expect(screen.queryByTestId('pin-notice')).toBeNull())
    // noted at creation: a match resumed straight at the coin toss (App.jsx
    // skips Match setup) already had its notice
    await waitFor(() => expect(store.tables.matches.get(1).pinNoticeShownAt).toEqual(expect.any(String)))
    expect(onOpenCoinToss).not.toHaveBeenCalled()
    // nothing of it goes to the server
    expect(queued().some((j) => JSON.stringify(j.payload || {}).includes('pinNotice'))).toBe(false)
    // not again on Coin toss
    await clickCoinToss()
    await waitFor(() => expect(onOpenCoinToss).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('pin-notice')).toBeNull()
  })

  it('the game PIN Create match makes is the one shown', async () => {
    storeMatch({ ...NEW, gamePin: undefined })
    render(<Setup matchId={1} onOpenCoinToss={() => {}} />)
    await createMatch()
    const pin = await screen.findByTestId('pin-notice-pin')
    const stored = store.tables.matches.get(1).gamePin
    expect(stored).toMatch(/^\d{6}$/)
    expect(pin).toHaveTextContent(stored)
    const insert = queued().find((j) => j.resource === 'match' && j.action === 'insert')
    expect(insert.payload.game_pin).toBe(stored)
  })

  it('once per match: a match whose notice was shown on this device does not show it again', async () => {
    storeMatch({ ...NEW, pinNoticeShownAt: '2026-11-21T17:00:00.000Z' })
    render(<Setup matchId={1} onOpenCoinToss={() => {}} />)
    await createMatch()
    await waitFor(() => expect(store.tables.matches.get(1).matchInfoConfirmedAt).toEqual(expect.any(String)))
    await sleep(300)
    expect(screen.queryByTestId('pin-notice')).toBeNull()
  })

  it('a test match never shows it, neither at Create match nor at Coin toss', async () => {
    storeMatch({ ...NEW, test: true, gamePin: null, seed_key: null })
    const onOpenCoinToss = vi.fn()
    render(<Setup matchId={1} onOpenCoinToss={onOpenCoinToss} />)
    await createMatch()
    await waitFor(() => expect(store.tables.matches.get(1).matchInfoConfirmedAt).toEqual(expect.any(String)))
    await sleep(300)
    expect(screen.queryByTestId('pin-notice')).toBeNull()
    await clickCoinToss()
    await waitFor(() => expect(onOpenCoinToss).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('pin-notice')).toBeNull()
  })

  it('a match already created: neither a Save of its info nor Coin toss shows it', async () => {
    storeMatch()
    const onOpenCoinToss = vi.fn()
    render(<Setup matchId={1} onOpenCoinToss={onOpenCoinToss} />)
    fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }))
    fireEvent.change(await screen.findByLabelText('matchSetup.hall'), { target: { value: 'Halle B' } })
    fireEvent.click(screen.getByRole('button', { name: 'matchSetup.save' }))
    await waitFor(() => expect(store.tables.matches.get(1).hall).toBe('Halle B'))
    await sleep(300)
    expect(screen.queryByTestId('pin-notice')).toBeNull()
    await clickCoinToss()
    await waitFor(() => expect(onOpenCoinToss).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('pin-notice')).toBeNull()
  })

  it('signed in and confirmed: "Send to my email" posts the match and the PIN to send-pin, prefilled field for the mail app', async () => {
    auth.user = { id: 'u-1', email: 'sina@example.ch', email_confirmed_at: '2026-11-01T00:00:00Z' }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({ status: 200, json: async () => ({ success: true }) }))
    storeMatch(NEW)
    render(<Setup matchId={1} onOpenCoinToss={() => {}} />)
    await createMatch()
    await screen.findByTestId('pin-notice')
    // no scorer official address in this match: the account's
    expect(screen.getByTestId('pin-notice-email')).toHaveValue('sina@example.ch')
    fireEvent.click(screen.getByTestId('pin-notice-send-account'))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === 'https://backend.example/api/match/send-pin')).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([url]) => url === 'https://backend.example/api/match/send-pin')
    expect(JSON.parse(init.body)).toEqual({ externalId: 'match_1_setup', gamePin: '654321' })
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(await screen.findByText(/^Sent to /)).toBeInTheDocument()
  })

  it('an unconfirmed account gets no server button (the server mails only a confirmed address); its address is prefilled for the mail app', async () => {
    auth.user = { id: 'u-1', email: 'sina@example.ch', email_confirmed_at: null }
    storeMatch(NEW)
    render(<Setup matchId={1} onOpenCoinToss={() => {}} />)
    await createMatch()
    await screen.findByTestId('pin-notice')
    expect(screen.queryByTestId('pin-notice-send-account')).toBeNull()
    // Match setup has no address field for the scorer official: the account's
    expect(screen.getByTestId('pin-notice-email')).toHaveValue('sina@example.ch')
  })
})
