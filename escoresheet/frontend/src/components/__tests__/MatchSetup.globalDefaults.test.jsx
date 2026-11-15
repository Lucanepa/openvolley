/**
 * Global match, Match Setup: neutral defaults (friendly, mixed, no country), Mixed and school levels. (Harness copied from MatchSetup.smoke.test.jsx.)
 * Smoke render of Match Setup: a new (empty) match and a created
 * (matchInfoConfirmedAt) match mount without throwing (a use-before-declare
 * crash once showed only "Something went wrong" in the browser), and the
 * once-per-match connection-PIN sync is queued only when it is needed.
 * The roster editor keeps a row in its place while its number is typed.
 * Choose players in the roster editor writes nothing before its Save.
 * A roster of more than 14 players is not ready for the coin toss.
 * "Add from club" (db/024, the device's copy): a bench official from anyone
 * of the club's lists, of either gender.
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
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const PINS = { refereePin: '111111', homeTeamPin: '222222', awayTeamPin: '333333', homeTeamUploadPin: '444444', awayTeamUploadPin: '555555' }

const open = async (extra) => {
  store.tables.matches = new Map([[1, { id: 1, status: 'scheduled', ...PINS, ...extra }]])
  render(<Setup matchId={1} />)
  fireEvent.click(await screen.findByRole('button', { name: 'matchSetup.createMatch' }))
  await screen.findByLabelText('matchSetup.gender')
}
const values = (label) => [...screen.getByLabelText(label).querySelectorAll('option')].map((o) => o.value)

describe('Global match: neutral defaults', () => {
  it('starts as a friendly, mixed, with no country prefilled', async () => {
    await open({ test: true, global: true })
    await waitFor(() => expect(screen.getByLabelText('matchSetup.gender')).toHaveValue('mixed'))
    expect(screen.getByLabelText('matchSetup.matchType')).toHaveValue('friendly')
    for (const el of screen.getAllByLabelText('matchSetup.country')) expect(el).toHaveValue('')
  })

  it('offers Mixed and the school levels', async () => {
    await open({ test: true, global: true })
    expect(values('matchSetup.gender')).toEqual(['men', 'women', 'mixed'])
    expect(values('matchSetup.matchLevel')).toEqual(expect.arrayContaining(['U16', 'U15', 'U14', 'School']))
  })

  it('a Swiss match keeps its defaults: men, championship, CHE, no extras', async () => {
    await open({})
    expect(screen.getByLabelText('matchSetup.gender')).toHaveValue('men')
    expect(screen.getByLabelText('matchSetup.matchType')).toHaveValue('championship')
    expect(screen.getAllByLabelText('matchSetup.country')[0]).toHaveValue('CHE')
    expect(values('matchSetup.gender')).toEqual(['men', 'women'])
    expect(values('matchSetup.matchLevel')).not.toContain('School')
  })

  it('a confirmed Global match keeps what was saved (no reset of its type or gender)', async () => {
    await open({ test: true, global: true, matchInfoConfirmedAt: '2026-11-14T10:00:00Z', match_type_1: 'cup', match_type_2: 'women' })
    await waitFor(() => expect(screen.getByLabelText('matchSetup.gender')).toHaveValue('women'))
    expect(screen.getByLabelText('matchSetup.matchType')).toHaveValue('cup')
  })
})
