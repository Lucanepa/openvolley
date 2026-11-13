/**
 * MatchEnd: the assistant scorer and the 2nd referee sign only when the match
 * has them. Reopen last set, a correction and a cloud import write null into
 * every post-match signature field; a null slot is no official, so a match
 * with one referee and no assistant scorer stays approvable once the officials
 * it had sign again. Dexie is an in-memory stand-in that re-runs live queries
 * on writes (key-path updates included, as clearedPostMatchSignatures uses).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import en from '../../i18n/locales/en.json'
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
vi.mock('../../contexts/LoggingContext', () => {
  const noop = () => {}
  const logger = { logHandler: noop, logFunction: noop, logCallback: noop, logHook: noop, logEffect: noop, logError: noop, wrapHandler: (fn) => fn, wrapFunction: (fn) => fn }
  return { useComponentLogging: () => logger, useLogging: () => ({ createComponentLogger: () => logger, logNavigation: () => {} }) }
})
const alerts = vi.hoisted(() => ({ showAlert: null }))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: alerts.showAlert, showConfirm: vi.fn() }) }))
const auth = vi.hoisted(() => ({ value: null }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }))
vi.mock('../../hooks/useScaledLayout', () => ({ useScaledLayout: () => ({ vmin: (n) => `${n}vmin` }), default: () => ({ vmin: (n) => `${n}vmin` }) }))
vi.mock('../../utils/comprehensiveLogger', () => ({ exportLogsAsNDJSON: async () => '', downloadLogs: async () => {} }))
vi.mock('../../utils/backendConfig', async (orig) => ({ ...(await orig()), getCloudApiUrl: (p) => `https://api.test${p}` }))
vi.mock('../../utils/askConfirm.js', () => ({ askConfirm: async () => true, default: async () => true }))
const api = vi.hoisted(() => ({ list: null }))
vi.mock('../../lib/accountApi', async (orig) => ({
  ...(await orig()),
  approvalsApi: { approve: vi.fn(), list: (...a) => api.list(...a), undo: vi.fn(async () => ({ data: null, error: null, status: 200 })) }
}))
vi.mock('../../lib/apiClient', () => {
  const chain = () => {
    const b = new Proxy({}, { get: (_, prop) => (prop === 'then' ? (r) => Promise.resolve({ data: null, error: null }).then(r) : () => b) })
    return b
  }
  return { apiFrom: () => chain(), apiStorage: { from: () => chain() }, apiRequest: vi.fn() }
})
vi.mock('../SignaturePad', () => ({
  default: ({ open, onSave, title }) => (open ? <button type="button" onClick={() => onSave('data:image/png;base64,SIG', { source: 'device' })}>draw {title}</button> : null)
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
    // Dexie applies 'a.b' as a key path; a null value is kept, not dropped
    update: async (id, ch) => {
      const r = rowsOf(name).get(id)
      if (!r) return 0
      const next = { ...r }
      for (const [k, v] of Object.entries(ch)) {
        if (!k.includes('.')) { next[k] = v; continue }
        const [head, ...rest] = k.split('.')
        next[head] = { ...(next[head] || {}), [rest.join('.')]: v }
      }
      rowsOf(name).set(id, next)
      changed()
      return 1
    },
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
import { clearedPostMatchSignatures } from '../../domain/matchEnd'
import { postMatchSignaturesFromServer } from '../../domain/signatureEdits'

const SEED = 'match_1_slots'
const SETS = [
  { id: 11, matchId: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true },
  { id: 12, matchId: 1, index: 2, homePoints: 25, awayPoints: 22, finished: true },
  { id: 13, matchId: 1, index: 3, homePoints: 25, awayPoints: 18, finished: true }
]
// A lower-league match: one referee and a scorer, no 2nd referee, no assistant scorer
const ONE_REFEREE = [
  { role: '1st referee', firstName: 'Anna', lastName: 'Muster' },
  { role: 'scorer', firstName: 'Sam', lastName: 'Scorer' }
]
const FULL_CREW = [
  ...ONE_REFEREE,
  { role: '2nd referee', firstName: 'Ben', lastName: 'Beispiel' },
  { role: 'assistant scorer', firstName: 'Ada', lastName: 'Assist' }
]
const CAPTAINS = { homePostGameCaptainSignature: 'data:cap-a', awayPostGameCaptainSignature: 'data:cap-b' }
const ONE_REFEREE_SIGNED = { ...CAPTAINS, scorerSignature: 'data:scorer', ref1Signature: 'data:ref1' }

function seed(matchOver = {}) {
  store.tables = {}
  store.nextId = 500
  store.tables.matches = new Map([[1, {
    id: 1, seed_key: SEED, status: 'ended', test: false, coinTossTeamA: 'home', homeTeamId: 1, awayTeamId: 2,
    gameNumber: 4711, officials: ONE_REFEREE, ...matchOver
  }]])
  store.tables.teams = new Map([[1, { id: 1, name: 'Home V' }], [2, { id: 2, name: 'Away V' }]])
  store.tables.players = new Map([
    [31, { id: 31, teamId: 1, number: 7, firstName: 'Lea', lastName: 'Muster', isCaptain: true }],
    [41, { id: 41, teamId: 2, number: 9, firstName: 'Mia', lastName: 'Meier', isCaptain: true }]
  ])
  store.tables.sets = new Map(SETS.map(s => [s.id, { ...s }]))
  store.tables.events = new Map()
  store.tables.sync_queue = new Map()
}

const row = () => store.tables.matches.get(1)
const slotOf = (role) => screen.queryByTestId(`signature-slot-${role}`)
const approveButton = () => queryAllButtons(en.matchEnd.approveParams)[0]

// Every live query has rendered the latest write: no re-render is pending
async function settled() {
  await waitFor(() => {
    expect(store.shown.size).toBeGreaterThan(0)
    for (const version of store.shown.values()) expect(version).toBe(store.version)
  })
}
// The mount refresh (list) writes the match row: wait for it and its re-render
async function refreshed() {
  await waitFor(() => expect(row()).toHaveProperty('accountApprovals'))
  await settled()
}
async function signVia(role) {
  fireEvent.click(await within(await screen.findByTestId(`signature-slot-${role}`)).findByText(en.matchEnd.tapToSign))
  fireEvent.click(await findButton(/^draw /))
  await settled()
}

beforeEach(() => {
  seed()
  alerts.showAlert = vi.fn()
  api.list = vi.fn(async () => ({ data: { match: { status: 'ended', closed_at: null, result_key: null }, approvals: [] }, error: null, status: 200 }))
  auth.value = { user: { id: 'u-scorer', email: 'scorer@club.ch' }, access: { roles: ['scorer'], isAdmin: false } }
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true })
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MatchEnd: assistant scorer and 2nd referee slots', () => {
  it('one referee, Reopen last set: after the set ends again the same officials sign and approve', async () => {
    seed(ONE_REFEREE_SIGNED)
    const onReopen = vi.fn()
    render(<MatchEnd matchId={1} onReopenLastSet={onReopen} />)
    await refreshed()
    expect(slotOf('asst-scorer')).toBeNull()
    expect(slotOf('ref2')).toBeNull()
    expect(approveButton()).toBeEnabled()

    // the real Reopen last set: every post-match field is null now
    fireEvent.click(await findButton(en.matchEnd.reopenLastSet))
    fireEvent.click(await findButton(en.matchEnd.yesReopen))
    await waitFor(() => expect(onReopen).toHaveBeenCalled())
    expect(row().status).toBe('live')
    expect(row().asstScorerSignature).toBeNull()
    expect(row().ref2Signature).toBeNull()
    cleanup()
    store.shown.clear()

    // the set is played to its end again on the scoreboard
    store.tables.sets.set(13, { ...store.tables.sets.get(13), finished: true })
    store.tables.matches.set(1, { ...row(), status: 'ended' })
    render(<MatchEnd matchId={1} />)
    await refreshed()
    await signVia('captain-a')
    await signVia('captain-b')

    // still no assistant scorer and no 2nd referee: the scorer signs next
    expect(slotOf('asst-scorer')).toBeNull()
    expect(slotOf('ref2')).toBeNull()
    await signVia('scorer')
    await signVia('ref1')
    expect(approveButton()).toBeEnabled()
  })

  it('one referee, continued from the cloud: the restored nulls add no slots', async () => {
    // importMatchFromSupabase spreads postMatchSignaturesFromServer into the row
    seed(postMatchSignaturesFromServer({
      home_captain_post_game: 'data:cap-a', away_captain_post_game: 'data:cap-b', scorer: 'data:scorer', ref1: 'data:ref1'
    }))
    expect(row()).toHaveProperty('asstScorerSignature', null)
    expect(row()).toHaveProperty('ref2Signature', null)
    render(<MatchEnd matchId={1} />)
    await refreshed()
    expect(slotOf('asst-scorer')).toBeNull()
    expect(slotOf('ref2')).toBeNull()
    expect(approveButton()).toBeEnabled()
  })

  it('one referee after a correction (all six cleared): only the captains, the scorer and the 1st referee sign', async () => {
    seed(clearedPostMatchSignatures())
    render(<MatchEnd matchId={1} />)
    await refreshed()
    await signVia('captain-a')
    await signVia('captain-b')
    expect(slotOf('asst-scorer')).toBeNull()
    expect(slotOf('ref2')).toBeNull()
    // the scorer is not waiting for an assistant scorer
    expect(within(slotOf('scorer')).getByText(en.matchEnd.tapToSign)).toBeInTheDocument()
    await signVia('scorer')
    await signVia('ref1')
    expect(approveButton()).toBeEnabled()
  })

  it('a full crew after a clear: the assistant scorer and the 2nd referee are still asked for', async () => {
    seed({ officials: FULL_CREW, ...clearedPostMatchSignatures(), ...CAPTAINS, scorerSignature: null })
    render(<MatchEnd matchId={1} />)
    await refreshed()
    expect(slotOf('asst-scorer')).toBeInTheDocument()
    expect(slotOf('ref2')).toBeInTheDocument()
    // the scorer waits for the assistant scorer
    expect(within(slotOf('scorer')).queryByText(en.matchEnd.tapToSign)).toBeNull()
    await signVia('asst-scorer')
    await signVia('scorer')
    // the 1st referee waits for the 2nd
    expect(within(slotOf('ref1')).queryByText(en.matchEnd.tapToSign)).toBeNull()
    expect(approveButton()).toBeDisabled()
    await signVia('ref2')
    await signVia('ref1')
    expect(approveButton()).toBeEnabled()
  })

  it('a slot that already holds a signature is shown, even without the official in the list', async () => {
    seed({ ...ONE_REFEREE_SIGNED, ref2Signature: 'data:ref2', asstScorerSignature: 'data:asst' })
    render(<MatchEnd matchId={1} />)
    await refreshed()
    expect(slotOf('asst-scorer')).toBeInTheDocument()
    expect(slotOf('ref2')).toBeInTheDocument()
    expect(approveButton()).toBeEnabled()
  })
})
