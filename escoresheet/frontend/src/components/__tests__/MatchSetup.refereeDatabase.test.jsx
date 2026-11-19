/**
 * The referee directory ("Database" on the 1st / 2nd referee cards) is only
 * offered in an official match of an account that may score: the server
 * refuses the directory to anyone else (backend/server.js REFEREE_DIRECTORY),
 * and a test, easy or Global match never reads it.
 * (Harness copied from MatchSetup.global.test.jsx.)
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
const auth = vi.hoisted(() => ({ user: null, access: undefined }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.user, profile: null, getCachedProfile: () => null, access: auth.access }) }))

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
    get: async (id) => rowsOf(name).get(id),
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

import MatchSetup from '../MatchSetup'
import { ScaleProvider } from '../../contexts/ScaleContext'

// As in main.jsx
const Setup = (props) => <ScaleProvider><MatchSetup onStart={() => {}} onReturn={() => {}} {...props} /></ScaleProvider>

const queued = () => [...(store.tables.sync_queue?.values() || [])]
const pinJobs = () => queued().filter((j) => j.resource === 'match' && j.action === 'update' && j.payload?.connection_pins)

beforeEach(() => {
  store.tables = {}
  store.nextId = 100
  auth.user = null
  auth.access = undefined
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const match = (extra = {}) => {
  store.tables.matches = new Map([[1, {
    id: 1, status: 'setup', test: false, homeTeamId: 11, awayTeamId: 12, homeName: 'Home V', awayName: 'Away V',
    homeShortName: 'HOM', awayShortName: 'AWA', scheduledAt: '2026-10-29T18:00:00.000Z', league: 'H2', hall: 'Hall 1', city: 'Zurich',
    ...extra
  }]])
  store.tables.teams = new Map([[11, { id: 11, name: 'Home V' }], [12, { id: 12, name: 'Away V' }]])
}
const SCORER = { known: true, roles: ['scorer'], isAdmin: false, canScore: true }
const PENDING = { known: true, roles: [], isAdmin: false, canScore: false, isPending: true }
// The officials cards are on the match info form (main screen: Create match / Edit)
const openInfo = async () => {
  const open = await screen.findByRole('button', { name: /^(matchSetup\.createMatch|common\.edit)$/ })
  fireEvent.click(open)
  await screen.findAllByText('matchSetup.referee1')
}
const databaseButtons = () => screen.queryAllByRole('button', { name: 'matchSetup.database' })

describe('Match setup: the referee directory picker', () => {
  it('an official match of a scorer offers it (1st referee; the empty 2nd referee card starts collapsed)', async () => {
    auth.user = { id: 'u1' }
    auth.access = SCORER
    match()
    render(<Setup matchId={1} />)
    await openInfo()
    await waitFor(() => expect(databaseButtons()).toHaveLength(1))
  })

  for (const [label, extra, access] of [
    ['a test match of a scorer', { test: true }, SCORER],
    ['an easy match of a scorer', { test: true, easy: true }, SCORER],
    ['a Global match', { test: true, global: true, globalKey: 'AbCdEfGhIjKlMnOpQrStUv' }, SCORER],
    ['a test match signed out', { test: true }, undefined],
    ['an official match of an account without a role', {}, PENDING]
  ]) {
    it(`${label} does not offer it`, async () => {
      auth.user = access ? { id: 'u1' } : null
      auth.access = access
      match(extra)
      render(<Setup matchId={1} />)
      await openInfo()
      expect(databaseButtons()).toHaveLength(0)
    })
  }
})
