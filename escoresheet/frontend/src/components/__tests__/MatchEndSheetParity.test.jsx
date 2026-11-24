/**
 * MatchEnd shows what the PDF the officials sign shows: the best-of-3
 * deciding set (index 5) as set 3 in RESULTS and SANCTIONS; the remarks the
 * sheet writes itself (a default); 9 sanction rows, the 10th in REMARKS; no
 * time for a set awarded by default; a sanction's score from the event order.
 * The harness is MatchEndClosedOnServer.test.jsx's.
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

const t0 = Date.UTC(2026, 9, 7, 18, 0, 0)
let seq = 0
const ev = (type, setIndex, payload, min = 0) => ({ id: 900 + ++seq, matchId: 1, type, setIndex, seq, ts: new Date(t0 + min * 60000 + seq * 1000).toISOString(), payload })

function seed({ match = {}, sets, events = [] }) {
  store.tables = {}
  store.nextId = 500
  store.tables.matches = new Map([[1, {
    id: 1, seed_key: 'match_1_sheet', status: 'ended', test: false, coinTossTeamA: 'home', homeTeamId: 1, awayTeamId: 2,
    officials: [{ role: '1st referee', firstName: 'Anna', lastName: 'Muster' }, { role: 'scorer', firstName: 'Sam', lastName: 'Scorer' }],
    ...match
  }]])
  store.tables.teams = new Map([[1, { id: 1, name: 'Home V' }], [2, { id: 2, name: 'Away V' }]])
  store.tables.players = new Map()
  store.tables.sets = new Map(sets.map((s, i) => [20 + i, { id: 20 + i, matchId: 1, ...s }]))
  store.tables.events = new Map(events.map(e => [e.id, e]))
  store.tables.sync_queue = new Map()
}

beforeEach(() => {
  seq = 0
  alerts.showAlert = vi.fn()
  asked.fn = vi.fn(async () => true)
  api.list = vi.fn(async () => ({ data: { match: { status: 'ended', closed_at: null }, approvals: [] }, error: null, status: 200 }))
  auth.value = { user: null, access: null }
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false })
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const resultsCard = () => document.querySelector('[data-help-id="matchend-results-table"]')
const cardOf = (title) => [...document.querySelectorAll('.card')].find(c => c.querySelector('h3')?.textContent === title)

describe('MatchEnd: the best-of-3 deciding set', () => {
  it('reads set 3 in RESULTS and in SANCTIONS, as on the PDF', async () => {
    seed({
      match: { bestOf: 3 },
      sets: [
        { index: 1, homePoints: 25, awayPoints: 20, finished: true },
        { index: 2, homePoints: 20, awayPoints: 25, finished: true },
        { index: 5, homePoints: 15, awayPoints: 11, finished: true }
      ],
      events: [ev('point', 5, { team: 'home' }), ev('sanction', 5, { team: 'away', type: 'warning', playerType: 'player', playerNumber: 8 })]
    })
    render(<MatchEnd matchId={1} />)
    await waitFor(() => expect(resultsCard()?.textContent).toContain('Home V'))
    const setCells = [...resultsCard().querySelectorAll('span[style*="font-weight: 600"]')].map(s => s.textContent)
    expect(setCells).toContain('3')
    expect(setCells).not.toContain('5')
    const rows = [...cardOf(en.matchEnd.sanctions).querySelectorAll('div[style*="repeat(7, 1fr)"]')].slice(1)
    expect(rows).toHaveLength(1)
    const cells = [...rows[0].querySelectorAll('span')].map(s => s.textContent)
    expect(cells.slice(4)).toEqual(['B', '3', '0:1'])
  })
})

const iso = (min) => new Date(t0 + min * 60000).toISOString()

describe('MatchEnd as the PDF', () => {
  it('a match lost by default: the generated remark is in REMARKS', async () => {
    seed({
      match: { forfeitTeam: 'away' },
      sets: [1, 2, 3].map(index => ({ index, homePoints: 25, awayPoints: 0, finished: true, forfeitCreated: true })),
      events: [ev('forfait', 1, { team: 'away', reason: 'forfait', scope: 'match', setIndex: 1 })]
    })
    render(<MatchEnd matchId={1} />)
    await waitFor(() => expect(screen.getByTestId('matchend-generated-remark').textContent)
      .toBe('Team B declared in default, match result 3:0 (25:0, 25:0, 25:0).'))
  })

  it('9 sanctions in the box, the 10th in REMARKS', async () => {
    seed({
      sets: [{ index: 1, homePoints: 25, awayPoints: 20, finished: true }],
      events: Array.from({ length: 10 }, (_, i) => ev('sanction', 1, { team: 'home', type: 'warning', playerType: 'player', playerNumber: i + 1 }))
    })
    render(<MatchEnd matchId={1} />)
    await waitFor(() => expect(resultsCard()?.textContent).toContain('Home V'))
    const rows = [...cardOf(en.matchEnd.sanctions).querySelectorAll('div[style*="repeat(7, 1fr)"]')].slice(1)
    expect(rows).toHaveLength(9)
    expect(cardOf(en.matchEnd.remarks).textContent).toContain('#10')
  })

  it('a set awarded by default gets no duration, and the sanction score follows the event order', async () => {
    const sameTs = iso(5)
    seed({
      match: { forfeitTeam: 'away' },
      sets: [
        { index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: iso(0), endTime: iso(22) },
        { index: 2, homePoints: 25, awayPoints: 0, finished: true, forfeitCreated: true, startTime: iso(23), endTime: iso(40) },
        { index: 3, homePoints: 25, awayPoints: 0, finished: true, forfeitCreated: true, startTime: iso(23), endTime: iso(40) }
      ],
      events: [
        // the sanction is logged before the point, in the same millisecond
        { id: 951, matchId: 1, type: 'sanction', setIndex: 1, seq: 1, ts: sameTs, payload: { team: 'home', type: 'warning', playerType: 'player', playerNumber: 4 } },
        { id: 952, matchId: 1, type: 'point', setIndex: 1, seq: 2, ts: sameTs, payload: { team: 'home' } },
        { id: 953, matchId: 1, type: 'forfait', setIndex: 2, seq: 3, ts: iso(23), payload: { team: 'away', reason: 'injury', scope: 'match', setIndex: 2 } }
      ]
    })
    render(<MatchEnd matchId={1} />)
    await waitFor(() => expect(resultsCard()?.textContent).toContain('Home V'))
    const setRows = [...resultsCard().querySelectorAll('div[style*="1fr 60px 1fr"]')]
      .map(r => [...r.children[1].querySelectorAll('span')].map(x => x.textContent))
    // set 1 its 22', sets 2 and 3 (awarded) none
    expect(setRows.filter(([n]) => ['1', '2', '3'].includes(n))).toEqual([['1', "22'"], ['2', ''], ['3', '']])
    const sanction = [...cardOf(en.matchEnd.sanctions).querySelectorAll('div[style*="repeat(7, 1fr)"]')].slice(1)[0]
    expect([...sanction.querySelectorAll('span')].map(x => x.textContent).slice(4)).toEqual(['A', '1', '0:0'])
  })
})
