/**
 * One loading state (owner 2026-11-11: "every time I click something or
 * start new game etc it seems it loads something, stops, loads it again"):
 * Match Setup shows the branded spinner until its first reads are in, then
 * the setup whole; a game picked from the schedule shows the spinner until
 * its suggestions and checks are in (at most 3 s), and Back drops it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => String(typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en', changeLanguage: () => Promise.resolve() }
  })
}))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn(), showConfirm: vi.fn() }) }))
const auth = vi.hoisted(() => ({ user: null }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.user, profile: null, getCachedProfile: () => null }) }))

// useLiveQuery: run the query once per deps change (no Dexie observation)
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

// In-memory Dexie stand-in: get/update/add on rows, empty collections otherwise
const store = vi.hoisted(() => ({ tables: {}, nextId: 1 }))
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
    get: async (id) => { if (name === 'matches' && store.hold) await store.hold; return rowsOf(name).get(id) },
    add: async (row) => { const id = row?.id ?? store.nextId++; rowsOf(name).set(id, { ...row, id }); return id },
    put: async (row) => { const id = row?.id ?? store.nextId++; rowsOf(name).set(id, { ...row, id }); return id },
    bulkAdd: async (rows) => { for (const r of rows) await table(name).add(r) },
    update: async (id, changes) => { const r = rowsOf(name).get(id); if (!r) return 0; rowsOf(name).set(id, { ...r, ...changes }); return 1 },
    delete: async (id) => { rowsOf(name).delete(id) },
    toArray: async () => [...rowsOf(name).values()],
    count: async () => rowsOf(name).size,
    // players: by team (the roster editor reads them), club_players by account; empty otherwise
    where: (field) => name === 'players' || name === 'club_players'
      ? { equals: (v) => collection([...rowsOf(name).values()].filter((r) => r[field] === v)) }
      : collection([]),
    orderBy: () => collection([]),
    filter: () => collection([]),
    clear: async () => rowsOf(name).clear(),
    hook: () => {} // useSyncQueue installs a 'creating' hook on sync_queue at module load
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
    // useSyncQueue (via utils/syncToast) installs its auth listeners at module load
    AUTH_TOKEN_CHANGE_EVENT: 'ov-test-auth-token-change',
    AUTH_TOKEN_STORAGE_KEY: 'api_auth_token',
    apiMatchRestore: () => chain(),
    apiMatchClaim: () => chain()
  }
})
vi.mock('../../utils/logger', () => ({ uploadBackupToCloud: vi.fn(), uploadLogsToCloud: vi.fn() }))
vi.mock('../../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import

// the remembered rosters of a schedule pick: held by the test
const remembered = vi.hoisted(() => ({ hold: null }))
vi.mock('../../db/rememberedPlayers', () => ({
  rememberedRosters: async () => { if (remembered.hold) await remembered.hold; return [] }
}))

import MatchSetup, { SCHEDULE_LOAD_WAIT_MS } from '../MatchSetup'
import { ScaleProvider } from '../../contexts/ScaleContext'

const Setup = (props) => <ScaleProvider><MatchSetup onStart={() => {}} onReturn={() => {}} {...props} /></ScaleProvider>
const PINS = { refereePin: '111111', homeTeamPin: '222222', awayTeamPin: '333333', homeTeamUploadPin: '444444', awayTeamUploadPin: '555555' }
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

beforeEach(() => {
  store.tables = {}
  store.nextId = 100
  store.hold = null
  remembered.hold = null
  auth.user = null
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Match Setup appears whole', () => {
  it('shows the spinner until the match is read, then the setup', async () => {
    store.tables.matches = new Map([[1, { id: 1, status: 'setup', seed_key: 'match_1_new', ...PINS }]])
    const read = deferred()
    store.hold = read.promise
    const onReady = vi.fn()
    render(<Setup matchId={1} onReady={onReady} />)
    expect(screen.getByTestId('match-setup-loading')).toBeInTheDocument()
    expect(screen.queryByText('matchSetup.date')).toBeNull() // no empty card first
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.getByTestId('match-setup-loading')).toBeInTheDocument()
    expect(onReady).not.toHaveBeenCalled()
    read.resolve()
    expect((await screen.findAllByText('matchSetup.date')).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('match-setup-loading')).toBeNull()
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
  })

  it('a game picked from the schedule: the spinner until its checks are in, then the filled form', async () => {
    store.tables.matches = new Map([[1, { id: 1, status: 'scheduled', ...PINS }]])
    const checks = deferred()
    remembered.hold = checks.promise
    const game = { gameN: '930001', date: '2026-10-29', time: '18:00', home: 'VBC Musterdorf H1', away: 'VBC Other H1', league: '2L', hall: 'Halle Musterdorf', city: 'Zürich', bestOf: 5 }
    render(<Setup matchId={1} initialOfficialGame={game} onInitialOfficialGameUsed={() => {}} />)
    expect(await screen.findByTestId('schedule-load-spinner')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByTestId('schedule-load-spinner')).toBeInTheDocument()
    checks.resolve()
    await waitFor(() => expect(screen.queryByTestId('schedule-load-spinner')).toBeNull())
    expect(screen.getByLabelText('matchSetup.gameNumber')).toHaveValue(930001)
  })

  it('a check that hangs: the form shows after the wait', async () => {
    store.tables.matches = new Map([[1, { id: 1, status: 'scheduled', ...PINS }]])
    remembered.hold = new Promise(() => {}) // never answers
    const game = { gameN: '930002', home: 'A H1', away: 'B H1' }
    render(<Setup matchId={1} initialOfficialGame={game} onInitialOfficialGameUsed={() => {}} />)
    expect(await screen.findByTestId('schedule-load-spinner')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('schedule-load-spinner')).toBeNull(), { timeout: SCHEDULE_LOAD_WAIT_MS + 2000 })
    expect(screen.getByLabelText('matchSetup.gameNumber')).toHaveValue(930002)
  }, SCHEDULE_LOAD_WAIT_MS + 5000)

  it('Back while the pick loads drops the spinner (a late answer applies nothing)', async () => {
    store.tables.matches = new Map([[1, { id: 1, status: 'scheduled', ...PINS }]])
    const checks = deferred()
    remembered.hold = checks.promise
    render(<Setup matchId={1} initialOfficialGame={{ gameN: '930003', home: 'A H1', away: 'B H1' }} onInitialOfficialGameUsed={() => {}} />)
    expect(await screen.findByTestId('schedule-load-spinner')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /common\.back/ }))
    await waitFor(() => expect(screen.queryByTestId('schedule-load-spinner')).toBeNull())
    checks.resolve()
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId('schedule-load-spinner')).toBeNull()
  })
})
