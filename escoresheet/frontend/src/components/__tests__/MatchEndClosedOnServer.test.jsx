/**
 * MatchEnd of a match the server has closed (2026-10-20 23:32: a closed match
 * restored on a device showed "Reopen last set"; pressed, it reopened the
 * match there and cleared its signatures while the server refused every
 * change). Known closed (a refusal, the local status, or the server's answer
 * on mount): the approved view, no edit path, a short explanation.
 * The harness is MatchEndAccountApproval.test.jsx's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import en from '../../i18n/locales/en.json'
// Not *ByRole for the buttons: on this page each call costs ~60 ms of jsdom
// getComputedStyle after every render, and under load the polled calls ran past
// findBy's 1 s window and the 5 s test timeout (see buttonQueries)
import { findButton, queryAllButtons } from '../../__tests__/buttonQueries'

const lookup = (key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), en)
const interpolate = (text, vars) => String(text).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars && vars[k] !== undefined ? vars[k] : ''))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      const found = lookup(key)
      if (typeof found === 'string') return interpolate(found, typeof opts === 'object' ? opts : undefined)
      return typeof opts === 'string' ? opts : key
    },
    i18n: { language: 'en', changeLanguage: () => Promise.resolve() }
  })
}))

const logs = vi.hoisted(() => ({ calls: [] }))
vi.mock('../../contexts/LoggingContext', () => {
  const spy = (name) => (...args) => { logs.calls.push([name, ...args]) }
  const logger = { logHandler: spy('logHandler'), logFunction: spy('logFunction'), logCallback: spy('logCallback'), logHook: spy('logHook'), logEffect: spy('logEffect'), logError: spy('logError'), wrapHandler: (fn) => fn, wrapFunction: (fn) => fn }
  return { useComponentLogging: () => logger, useLogging: () => ({ createComponentLogger: () => logger, logNavigation: () => {} }) }
})
const alerts = vi.hoisted(() => ({ showAlert: null }))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: alerts.showAlert, showConfirm: vi.fn() }) }))
const auth = vi.hoisted(() => ({ value: null }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }))
vi.mock('../../hooks/useScaledLayout', () => ({ useScaledLayout: () => ({ vmin: (n) => `${n}vmin` }), default: () => ({ vmin: (n) => `${n}vmin` }) }))
vi.mock('../../utils/comprehensiveLogger', () => ({ exportLogsAsNDJSON: async () => '', downloadLogs: async () => {} }))
vi.mock('../../utils/backendConfig', async (orig) => ({ ...(await orig()), getCloudApiUrl: (p) => `https://api.test${p}` }))

const asked = vi.hoisted(() => ({ fn: null }))
vi.mock('../../utils/askConfirm.js', () => ({ askConfirm: (...a) => asked.fn(...a), default: (...a) => asked.fn(...a) }))

const api = vi.hoisted(() => ({ approve: null, list: null, undo: null }))
vi.mock('../../lib/accountApi', async (orig) => ({
  ...(await orig()),
  approvalsApi: {
    approve: (...a) => api.approve(...a),
    list: (...a) => api.list(...a),
    undo: (...a) => api.undo(...a)
  }
}))
vi.mock('../../lib/apiClient', () => {
  const chain = () => {
    const b = new Proxy({}, { get: (_, prop) => (prop === 'then' ? (r) => Promise.resolve({ data: null, error: null }).then(r) : () => b) })
    return b
  }
  return { apiFrom: () => chain(), apiStorage: { from: () => chain() }, apiRequest: vi.fn() }
})
vi.mock('../SignaturePad', () => ({
  default: ({ open, onSave, title }) => (open ? <button type="button" onClick={() => onSave('data:image/png;base64,SIG')}>draw {title}</button> : null)
}))

// In-memory Dexie: where(field).equals(v), live queries re-run after writes.
// store.version counts the writes; store.shown holds, per mounted live query,
// the version its last committed render reads from (see settled()).
const store = vi.hoisted(() => ({ tables: {}, nextId: 1, listeners: new Set(), version: 0, shown: new Map() }))
vi.mock('dexie-react-hooks', async () => {
  const React = await import('react')
  return {
    useLiveQuery: (fn, deps = []) => {
      const [result, setResult] = React.useState({ value: undefined, version: -1 })
      const [tick, setTick] = React.useState(0)
      const id = React.useRef(Symbol('liveQuery'))
      React.useEffect(() => {
        const key = id.current
        const l = () => setTick(x => x + 1)
        store.listeners.add(l)
        return () => { store.listeners.delete(l); store.shown.delete(key) }
      }, [])
      React.useEffect(() => {
        let alive = true
        const version = store.version
        Promise.resolve(fn()).then((v) => { if (alive) setResult({ value: v, version }) })
        return () => { alive = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [...deps, tick])
      // after the commit: this render shows the rows as of `version`
      React.useEffect(() => { store.shown.set(id.current, result.version) })
      return result.value
    }
  }
})
vi.mock('../../db/db', () => {
  const rowsOf = (name) => (store.tables[name] ||= new Map())
  const changed = () => { store.version++; for (const l of [...store.listeners]) l() }
  const collection = (rows) => {
    const c = {
      equals: (v) => collection(rows.filter(r => r.__field === undefined ? true : r[r.__field] === v)),
      toArray: async () => rows.map(({ __field, ...r }) => r),
      sortBy: async (k) => rows.map(({ __field, ...r }) => r).sort((a, b) => (a[k] ?? 0) - (b[k] ?? 0)),
      filter: (fn) => collection(rows.filter(fn)),
      first: async () => rows[0],
      delete: async () => 0,
      anyOf: () => c, count: async () => rows.length
    }
    return c
  }
  const table = (name) => ({
    get: async (id) => rowsOf(name).get(id),
    add: async (row) => { const id = row?.id ?? store.nextId++; rowsOf(name).set(id, { ...row, id }); changed(); return id },
    update: async (id, ch) => { const r = rowsOf(name).get(id); if (!r) return 0; rowsOf(name).set(id, { ...r, ...ch }); changed(); return 1 },
    delete: async (id) => { rowsOf(name).delete(id); changed() },
    bulkDelete: async () => {},
    toArray: async () => [...rowsOf(name).values()],
    where: (field) => {
      if (typeof field === 'object') return collection([...rowsOf(name).values()])
      return { equals: (v) => collection([...rowsOf(name).values()].filter(r => r[field] === v)), anyOf: () => collection([]) }
    },
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

import MatchEnd from '../MatchEnd'

const SEED = 'match_1_acc'
const SETS = [
  { id: 11, matchId: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true },
  { id: 12, matchId: 1, index: 2, homePoints: 23, awayPoints: 25, finished: true },
  { id: 13, matchId: 1, index: 3, homePoints: 25, awayPoints: 18, finished: true },
  { id: 14, matchId: 1, index: 4, homePoints: 25, awayPoints: 22, finished: true }
]
const KEY = 'ov-result-v1|1:25:20,2:23:25,3:25:18,4:25:22'
const record = (slot, over = {}) => ({
  id: `${slot}-uuid`, short_id: slot === 'referee1' ? '6F1C2A9B' : 'A1B2C3D4', slot, name: slot === 'referee1' ? 'Muster Anna' : 'Beispiel Ben',
  approved_at: '2026-10-07T19:42:10.000Z', result_key: KEY, result_matches: true, mine: false, ...over
})
const PIN = '804613'

function seed(matchOver = {}) {
  store.tables = {}
  store.nextId = 500
  store.tables.matches = new Map([[1, {
    id: 1, seed_key: SEED, status: 'ended', test: false, coinTossTeamA: 'home', homeTeamId: 1, awayTeamId: 2,
    officials: [
      { role: '1st referee', firstName: 'Anna', lastName: 'Muster' },
      { role: '2nd referee', firstName: 'Ben', lastName: 'Beispiel' },
      { role: 'scorer', firstName: 'Sam', lastName: 'Scorer' }
    ],
    homePostGameCaptainSignature: 'data:cap-a',
    awayPostGameCaptainSignature: 'data:cap-b',
    ...matchOver
  }]])
  store.tables.teams = new Map([[1, { id: 1, name: 'Home V' }], [2, { id: 2, name: 'Away V' }]])
  store.tables.players = new Map()
  store.tables.sets = new Map(SETS.map(s => [s.id, { ...s }]))
  store.tables.events = new Map()
  store.tables.sync_queue = new Map()
}

const setOnline = (value) => {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value })
  act(() => { window.dispatchEvent(new Event(value ? 'online' : 'offline')) })
}

// Every live query has rendered the latest write: no re-render is pending. A
// write re-renders the boxes (new nodes), so a click made before that lands on
// a replaced node. (A fixed 20 ms wait did this before: too short under load.)
async function settled() {
  await waitFor(() => {
    expect(store.shown.size).toBeGreaterThan(0)
    for (const version of store.shown.values()) expect(version).toBe(store.version)
  })
}
// The mount refresh (list) writes the match row: wait for it and its re-render
async function refreshed() {
  await waitFor(() => expect(store.tables.matches.get(1)).toHaveProperty('accountApprovals'))
  await settled()
}



beforeEach(() => {
  seed()
  logs.calls = []
  alerts.showAlert = vi.fn()
  asked.fn = vi.fn(async () => true)
  api.list = vi.fn(async () => ({ data: { match: { status: 'ended', closed_at: null, result_key: KEY }, approvals: [] }, error: null, status: 200 }))
  api.approve = vi.fn()
  api.undo = vi.fn(async () => ({ data: { approval: {}, already: false }, error: null, status: 200 }))
  auth.value = { user: { id: 'u-scorer', email: 'scorer@club.ch', email_confirmed_at: '2026-10-01T08:00:00Z' }, access: { roles: ['scorer'], isAdmin: false } }
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true })
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const editButtons = () => [en.matchEnd.reopenLastSet, en.corrections.title, en.matchEnd.approveParams, en.matchEnd.editRemarks]
  .filter(name => queryAllButtons(name).length > 0)

describe('MatchEnd of a match closed on the server', () => {
  it('an open match keeps its edit paths (control)', async () => {
    render(<MatchEnd matchId={1} />)
    await findButton(en.matchEnd.reopenLastSet)
    expect(editButtons()).toEqual([en.matchEnd.reopenLastSet, en.corrections.title, en.matchEnd.approveParams, en.matchEnd.editRemarks])
    expect(screen.queryByTestId('matchend-closed-on-server')).toBeNull()
  })

  // The reason: the refusal's own notice when the server refused a write as
  // closed (said once, not twice), else the page's line
  const reason = async (refused) => refused
    ? (await screen.findByTestId('cloud-block-notice')).textContent
    : (await screen.findByTestId('matchend-closed-on-server')).textContent

  it.each([
    ['refused as closed (a closed match restored here)', { status: 'final', cloudBlock: { code: 'OV_MATCH_CLOSED', claim: null, at: 1 } }],
    ['refused as closed while still ended here', { status: 'ended', cloudBlock: { code: 'OV_MATCH_CLOSED', claim: null, at: 1 } }],
    ['closed by the device that took it over', { status: 'final', cloudBlock: { code: 'OV_SCORER_MOVED', closed: true, at: 1 } }],
    ['imported closed from the cloud', { status: 'approved' }]
  ])('%s: no Reopen last set, Corrections, Approve or remarks edit; the reason and Reopen match instead', async (_what, over) => {
    seed(over)
    render(<MatchEnd matchId={1} />)
    const refused = over.cloudBlock?.code === 'OV_MATCH_CLOSED'
    expect(await reason(refused)).toBe(refused ? en.cloudBlock.matchClosed : en.matchEnd.closedOnServer)
    if (refused) expect(screen.queryByTestId('matchend-closed-on-server')).toBeNull()
    expect(editButtons()).toEqual([])
    await findButton(en.matchEnd.reopenMatch)
    await findButton(en.matchEnd.closeMatch)
    // the signatures stay shown, locked
    expect(screen.getByTestId('signature-resign-captain-a')).toBeDisabled()
    expect(screen.getByTestId('signature-clear-captain-a')).toBeDisabled()
  })

  it('the server says closed on mount (the refusal not in yet): the same', async () => {
    api.list = vi.fn(async () => ({ data: { match: { status: 'approved', closed_at: '2026-10-20T21:30:00Z', result_key: KEY }, approvals: [] }, error: null, status: 200 }))
    render(<MatchEnd matchId={1} />)
    expect((await screen.findByTestId('matchend-closed-on-server')).textContent).toBe(en.matchEnd.closedOnServer)
    expect(editButtons()).toEqual([])
    // nothing was changed here
    expect(store.tables.matches.get(1)).toMatchObject({ status: 'ended', homePostGameCaptainSignature: 'data:cap-a' })
    expect([...store.tables.sync_queue.values()]).toEqual([])
  })
})
