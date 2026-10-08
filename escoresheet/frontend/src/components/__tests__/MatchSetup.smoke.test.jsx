/**
 * Smoke render of Match Setup: a new (empty) match and a created
 * (matchInfoConfirmedAt) match mount without throwing (a use-before-declare
 * crash once showed only "Something went wrong" in the browser), and the
 * once-per-match connection-PIN sync is queued only when it is needed.
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
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: null, profile: null, getCachedProfile: () => null }) }))

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
    where: () => collection([]),
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
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const PINS = { refereePin: '111111', homeTeamPin: '222222', awayTeamPin: '333333', homeTeamUploadPin: '444444', awayTeamUploadPin: '555555' }

describe('MatchSetup smoke render', () => {
  it('renders a new, empty match', async () => {
    store.tables.matches = new Map([[1, { id: 1, status: 'setup', seed_key: 'match_1_new', ...PINS }]])
    render(<Setup matchId={1} />)
    expect(await screen.findAllByText('matchSetup.date')).not.toHaveLength(0) // the match info card rendered
    expect(screen.queryByText(/Something went wrong/i)).toBeNull()
    expect(pinJobs()).toHaveLength(0) // not created yet: nothing on the server to update
  })

  // City, hall and league (the competition) showed CSS-capitalized text
  // while the match stored it as typed ("zürich" shown "Zürich"), and Title
  // Case placeholders ("Enter City"). Values are shown as typed (parity with
  // OpenBeach 872eb48).
  it('city, hall and league are shown as typed (no CSS capitalize)', async () => {
    store.tables.matches = new Map([[1, { id: 1, status: 'setup', seed_key: 'match_1_new', ...PINS }]])
    render(<Setup matchId={1} />)
    // the match info form (opened from the info card)
    fireEvent.click(await screen.findByRole('button', { name: 'matchSetup.createMatch' }))
    for (const label of ['matchSetup.city', 'matchSetup.hall', 'matchSetup.league']) {
      const input = await screen.findByLabelText(label)
      expect(input.className).not.toMatch(/capitalize/)
      // nor on a wrapper of the field
      expect(input.closest('.capitalize')).toBeNull()
    }
  })

  it('renders a created match and queues its connection PINs once', async () => {
    store.tables.matches = new Map([[1, {
      id: 1, status: 'setup', seed_key: 'match_1_conf', matchInfoConfirmedAt: '2026-10-06T10:00:00Z',
      homeName: 'Home V', awayName: 'Away V', game_n: 991404, ...PINS
    }]])
    const first = render(<Setup matchId={1} />)
    await waitFor(() => expect(pinJobs()).toHaveLength(1))
    expect(pinJobs()[0].payload.id).toBe('match_1_conf')
    await waitFor(() => expect(store.tables.matches.get(1).connectionPinsQueuedAt).toBeTruthy())
    first.unmount()

    // Opened again: the PINs are already queued, no second server write
    render(<Setup matchId={1} />)
    await new Promise((r) => setTimeout(r, 50))
    expect(pinJobs()).toHaveLength(1)
    expect(screen.queryByText(/Something went wrong/i)).toBeNull()
  })
})
