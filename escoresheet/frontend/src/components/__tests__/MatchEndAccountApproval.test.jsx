/**
 * MatchEnd: approval with an account next to the drawn signatures
 * (docs/account-approval-spec.md 4.5, tests 6.2). The approvals API is
 * mocked; Dexie is an in-memory stand-in that re-runs live queries on writes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react'
import en from '../../i18n/locales/en.json'
// Not *ByRole for the buttons: on this page each call costs ~60 ms of jsdom
// getComputedStyle after every render, and under load the polled calls ran past
// findBy's 1 s window and the 5 s test timeout (see buttonQueries)
import { findButton, getButton } from '../../__tests__/buttonQueries'

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
import AccountApprovalDialog from '../AccountApprovalDialog'
import { StrictMode } from 'react'

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
async function openApprove(role) {
  await refreshed()
  fireEvent.click(await screen.findByTestId(`account-approval-open-${role}`))
  return screen.findByRole('dialog')
}

const confirmButton = () => getButton(en.matchEnd.approveParams)
const slot = (role) => screen.getByTestId(`signature-slot-${role}`)

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

describe('MatchEnd: approve with an account', () => {
  it('offers "Approve with PIN" on scorer, 2nd and 1st referee, also once signed by hand (owner fix)', async () => {
    seed({ asstScorerSignature: undefined, officials: [
      { role: '1st referee', firstName: 'Anna', lastName: 'Muster' },
      { role: '2nd referee', firstName: 'Ben', lastName: 'Beispiel' },
      { role: 'scorer', firstName: 'Sam', lastName: 'Scorer' },
      { role: 'assistant scorer', firstName: 'Ada', lastName: 'Assist' }
    ], asstScorerSignature: 'data:asst', scorerSignature: 'data:s', ref2Signature: 'data:ref2' })
    render(<MatchEnd matchId={1} />)
    await screen.findByTestId('account-approval-open-scorer')
    expect(screen.getByTestId('account-approval-open-ref1')).toHaveTextContent(en.approval.approveWithPin)
    // drawn ref2: the PIN is still offered next to the signature
    expect(screen.getByTestId('account-approval-open-ref2')).toBeEnabled()
    // the assistant scorer signs only, and says so; the captains have no PIN line
    expect(screen.queryByTestId('account-approval-open-asst-scorer')).toBeNull()
    expect(screen.getByTestId('account-approval-why-asst-scorer')).toHaveTextContent(en.approval.why.signOnly)
    expect(screen.queryByTestId('account-approval-open-captain-a')).toBeNull()
    expect(screen.queryByTestId('account-approval-why-captain-a')).toBeNull()
  })

  it('offline: the reason line instead of the button; the button is back on "online"', async () => {
    render(<MatchEnd matchId={1} />)
    await refreshed()
    await screen.findByTestId('account-approval-open-scorer')
    setOnline(false)
    await waitFor(() => expect(screen.getByTestId('account-approval-why-scorer')).toHaveTextContent(en.approval.why.offline))
    expect(screen.queryByTestId('account-approval-open-scorer')).toBeNull()
    setOnline(true)
    await waitFor(() => expect(screen.getByTestId('account-approval-open-scorer')).toBeEnabled())
    expect(screen.getByTestId('account-approval-open-scorer')).toHaveTextContent(en.approval.approveWithPin)
  })

  it('on mount, list() replaces the local approvals', async () => {
    seed({ accountApprovals: { scorer: record('scorer', { id: 'old-local' }) } })
    api.list = vi.fn(async () => ({ data: { match: { status: 'ended', closed_at: null, result_key: KEY }, approvals: [record('referee1')] }, error: null, status: 200 }))
    render(<MatchEnd matchId={1} />)
    await waitFor(() => expect(store.tables.matches.get(1).accountApprovals).toEqual({ referee1: record('referee1') }))
    expect(api.list).toHaveBeenCalledWith(SEED)
  })

  it('mixed: a drawn scorer and ref2 plus an account ref1 complete the sheet', async () => {
    const approved = record('referee1')
    api.approve = vi.fn(async () => ({ data: { approval: approved, already: false }, error: null, status: 200 }))
    // The sync queue: each drawn signature is queued at once, and the approval
    // waits until the match's jobs are sent. Stand-in: sent on every wake-up.
    const sendQueue = () => { for (const [id, j] of store.tables.sync_queue) store.tables.sync_queue.set(id, { ...j, status: 'sent' }) }
    window.addEventListener('sync-queue-write', sendQueue)
    render(<MatchEnd matchId={1} />)
    await refreshed()

    // scorer and 2nd referee draw
    fireEvent.click(await within(await screen.findByTestId('signature-slot-scorer')).findByText(en.matchEnd.tapToSign))
    fireEvent.click(await findButton(/^draw /))
    await waitFor(() => expect(store.tables.matches.get(1).scorerSignature).toBe('data:image/png;base64,SIG'))
    await settled()
    fireEvent.click(await within(slot('ref2')).findByText(en.matchEnd.tapToSign))
    fireEvent.click(await findButton(/^draw /))
    await waitFor(() => expect(store.tables.matches.get(1).ref2Signature).toBeTruthy())
    await settled()
    expect(confirmButton()).toBeDisabled()

    // 1st referee approves with the account
    const dialog = await openApprove('ref1')
    expect(within(dialog).getByTestId('account-approval-entered')).toHaveTextContent('Muster Anna')
    fireEvent.change(within(dialog).getByLabelText(en.approval.email), { target: { value: 'Anna@Example.ch ' } })
    fireEvent.change(within(dialog).getByLabelText(en.approval.pinLabel), { target: { value: PIN } })
    fireEvent.click(within(dialog).getByTestId('account-approval-submit'))

    await waitFor(() => expect(store.tables.matches.get(1).accountApprovals).toEqual({ referee1: approved }))
    expect(api.approve).toHaveBeenCalledTimes(1)
    const body = api.approve.mock.calls[0][0]
    expect(body).toMatchObject({ external_id: SEED, slot: 'referee1', email: 'anna@example.ch', pin: PIN, result: { sets: [[1, 25, 20], [2, 23, 25], [3, 25, 18], [4, 25, 22]] } })
    // the done state and the Confirm button
    expect(await screen.findByTestId('account-approval-ref1')).toHaveTextContent(en.approval.done)
    expect(screen.getByTestId('account-approval-ref1')).toHaveTextContent('Muster Anna · 07.10.2026 21:42 · ID 6F1C2A9B')
    await waitFor(() => expect(confirmButton()).toBeEnabled())
    // remembered on this device for the official's name
    expect(JSON.parse(localStorage.getItem('ov.approvalEmails'))).toEqual([{ k: 'muster anna', e: 'anna@example.ch' }])
    // both drawings went to the queue as they were made
    expect([...store.tables.sync_queue.values()].filter(j => j.payload?.signatures).length).toBe(2)
    window.removeEventListener('sync-queue-write', sendQueue)
  })

  it('the PIN never reaches the logger or the console, and the field clears after an error', async () => {
    const spies = ['log', 'warn', 'error', 'info', 'debug'].map(m => vi.spyOn(console, m))
    api.approve = vi.fn(async () => ({ data: null, error: { code: 'OV_APPROVAL_PIN_INVALID', status: 403, message: 'Email or PIN not accepted' }, status: 403 }))
    render(<MatchEnd matchId={1} />)
    const dialog = await openApprove('scorer')
    // the scorer slot starts with the signed-in account's email
    expect(within(dialog).getByLabelText(en.approval.email)).toHaveValue('scorer@club.ch')
    const pinField = within(dialog).getByLabelText(en.approval.pinLabel)
    expect(pinField).toHaveAttribute('type', 'password')
    expect(pinField).toHaveAttribute('inputmode', 'numeric')
    expect(pinField).toHaveAttribute('autocomplete', 'off')
    fireEvent.change(pinField, { target: { value: PIN } })
    fireEvent.click(within(dialog).getByTestId('account-approval-submit'))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(en.approval.errors.pinInvalid)
    expect(within(dialog).getByLabelText(en.approval.pinLabel)).toHaveValue('')

    const seen = JSON.stringify([logs.calls, ...spies.map(s => s.mock.calls)], (_, v) => (v instanceof Error ? v.message : v))
    expect(seen).not.toContain(PIN)
    expect(localStorage.getItem('ov.approvalEmails') || '').not.toContain(PIN)
    expect(JSON.stringify([...store.tables.matches.values()])).not.toContain(PIN)
  })

  it('Approve stays disabled until the PIN has 4 to 6 digits (a slip is never sent; review fix)', async () => {
    seed({ scorerSignature: 'data:s', ref2Signature: 'data:r2' })
    render(<MatchEnd matchId={1} />)
    const dialog = await openApprove('ref1')
    fireEvent.change(within(dialog).getByLabelText(en.approval.email), { target: { value: 'anna@example.ch' } })
    fireEvent.change(within(dialog).getByLabelText(en.approval.pinLabel), { target: { value: '123' } })
    expect(within(dialog).getByTestId('account-approval-submit')).toBeDisabled()
    fireEvent.click(within(dialog).getByTestId('account-approval-submit'))
    expect(api.approve).not.toHaveBeenCalled()
    fireEvent.change(within(dialog).getByLabelText(en.approval.pinLabel), { target: { value: '4829' } })
    expect(within(dialog).getByTestId('account-approval-submit')).toBeEnabled()
  })

  it('the server codes of the review fixes read as their own messages', async () => {
    api.approve = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: 'OV_APPROVAL_SCORER_NOT_REFEREE', status: 403 }, status: 403 })
      .mockResolvedValueOnce({ data: null, error: { code: 'OV_APPROVAL_CALLER_ROLE', status: 403 }, status: 403 })
    seed({ scorerSignature: 'data:s', ref2Signature: 'data:r2' })
    render(<MatchEnd matchId={1} />)
    const dialog = await openApprove('ref1')
    fireEvent.change(within(dialog).getByLabelText(en.approval.email), { target: { value: 'anna@example.ch' } })
    fireEvent.change(within(dialog).getByLabelText(en.approval.pinLabel), { target: { value: '482917' } })
    fireEvent.click(within(dialog).getByTestId('account-approval-submit'))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(en.approval.errors.scorerNotReferee)
    fireEvent.change(within(dialog).getByLabelText(en.approval.pinLabel), { target: { value: '482917' } })
    fireEvent.click(within(dialog).getByTestId('account-approval-submit'))
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(en.approval.errors.callerRole))
    // the app language travels for the official's notification mail
    expect(api.approve.mock.calls[0][0]).toHaveProperty('lang', 'en')
  })

  it('OV_RESULT_NOT_SYNCED is retried once, then shown', async () => {
    api.approve = vi.fn(async () => ({ data: null, error: { code: 'OV_RESULT_NOT_SYNCED', status: 409, details: { server: [] } }, status: 409 }))
    seed({ scorerSignature: 'data:s', ref2Signature: 'data:r2' })
    render(<MatchEnd matchId={1} />)
    const dialog = await openApprove('ref1')
    fireEvent.change(within(dialog).getByLabelText(en.approval.email), { target: { value: 'anna@example.ch' } })
    fireEvent.change(within(dialog).getByLabelText(en.approval.pinLabel), { target: { value: '482917' } })
    fireEvent.click(within(dialog).getByTestId('account-approval-submit'))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(en.approval.errors.resultNotSynced)
    expect(api.approve).toHaveBeenCalledTimes(2)
  })

  it('a stale approval shows the amber state and blocks Confirm', async () => {
    const stale = { referee1: record('referee1', { result_key: 'ov-result-v1|1:25:20,2:23:25,3:25:18,4:26:24' }) }
    seed({ scorerSignature: 'data:s', ref2Signature: 'data:r2', accountApprovals: stale })
    api.list = vi.fn(async () => ({ data: { match: {}, approvals: [stale.referee1] }, error: null, status: 200 }))
    render(<MatchEnd matchId={1} />)
    expect(await screen.findByTestId('account-approval-stale-ref1')).toHaveTextContent(en.approval.stale)
    // both ways stay open
    expect(screen.getByTestId('account-approval-open-ref1')).toBeEnabled()
    expect(confirmButton()).toBeDisabled()
  })

  it('undo asks first (askConfirm), then calls the server and drops the local record', async () => {
    const approved = { referee1: record('referee1') }
    seed({ scorerSignature: 'data:s', ref2Signature: 'data:r2', accountApprovals: approved })
    api.list = vi.fn(async () => ({ data: { match: {}, approvals: [approved.referee1] }, error: null, status: 200 }))
    render(<MatchEnd matchId={1} />)
    await refreshed()
    await waitFor(() => expect(confirmButton()).toBeEnabled())

    asked.fn = vi.fn(async () => false)
    fireEvent.click(screen.getByTestId('account-approval-undo-ref1'))
    await waitFor(() => expect(asked.fn).toHaveBeenCalledTimes(1))
    expect(asked.fn.mock.calls[0][0]).toMatchObject({ title: en.approval.undoConfirm, tone: 'danger' })
    expect(api.undo).not.toHaveBeenCalled()

    asked.fn = vi.fn(async () => true)
    fireEvent.click(screen.getByTestId('account-approval-undo-ref1'))
    await waitFor(() => expect(api.undo).toHaveBeenCalledWith('referee1-uuid'))
    await waitFor(() => expect(store.tables.matches.get(1).accountApprovals).toBeNull())
    expect(confirmButton()).toBeDisabled()
  })

  it('the approve sync job carries the account summary (names and short IDs, no emails)', async () => {
    const approved = { referee1: record('referee1') }
    seed({ scorerSignature: 'data:s', ref2Signature: 'data:r2', accountApprovals: approved })
    api.list = vi.fn(async () => ({ data: { match: {}, approvals: [approved.referee1] }, error: null, status: 200 }))
    // the PDF window is not available in jsdom: the approval goes on without it
    window.open = vi.fn(() => null)
    URL.createObjectURL = vi.fn(() => 'blob:x')
    render(<MatchEnd matchId={1} />)
    await waitFor(() => expect(confirmButton()).toBeEnabled())
    fireEvent.click(confirmButton())
    // no scoresheet window: the scorer approves without the PDF
    fireEvent.click(await findButton(en.matchEnd.export.approveWithoutPdf))
    await waitFor(() => {
      const jobs = [...store.tables.sync_queue.values()]
      expect(jobs.some(j => j.payload?.status === 'approved')).toBe(true)
    })
    const job = [...store.tables.sync_queue.values()].find(j => j.payload?.status === 'approved')
    expect(job.payload.approval.accounts).toEqual({
      ref1: { short_id: '6F1C2A9B', name: 'Muster Anna', approved_at: '2026-10-07T19:42:10.000Z' },
      ref2: null,
      scorer: null
    })
    expect(JSON.stringify(job.payload.approval)).not.toMatch(/@|user_id/)
  })

  it('a voided approval stops "Confirm and approve" (revalidated online)', async () => {
    const approved = { referee1: record('referee1') }
    seed({ scorerSignature: 'data:s', ref2Signature: 'data:r2', accountApprovals: approved })
    api.list = vi.fn()
      .mockResolvedValueOnce({ data: { match: {}, approvals: [approved.referee1] }, error: null, status: 200 })
      .mockResolvedValue({ data: { match: {}, approvals: [] }, error: null, status: 200 })
    render(<MatchEnd matchId={1} />)
    await waitFor(() => expect(confirmButton()).toBeEnabled())
    fireEvent.click(confirmButton())
    await waitFor(() => expect(alerts.showAlert).toHaveBeenCalledWith(en.approval.revalidateFailed, 'warning'))
    expect([...store.tables.sync_queue.values()].some(j => j.payload?.status === 'approved')).toBe(false)
  })

  it('a stale approval in a slot signed by hand never blocks Confirm (review fix)', async () => {
    // the 1st referee approved, the score was corrected, then the 1st referee signed by hand
    const stale = record('referee1', { result_key: 'ov-result-v1|1:25:20,2:23:25,3:25:18,4:26:24' })
    seed({ scorerSignature: 'data:s', ref2Signature: 'data:r2', ref1Signature: 'data:r1', accountApprovals: { referee1: stale } })
    // the server still lists it (its sets were not corrected yet)
    api.list = vi.fn(async () => ({ data: { match: {}, approvals: [stale] }, error: null, status: 200 }))
    window.open = vi.fn(() => null)
    URL.createObjectURL = vi.fn(() => 'blob:x')
    render(<MatchEnd matchId={1} />)
    await refreshed()
    await waitFor(() => expect(confirmButton()).toBeEnabled())
    fireEvent.click(confirmButton())
    // no scoresheet window: the scorer approves without the PDF
    fireEvent.click(await findButton(en.matchEnd.export.approveWithoutPdf))
    await waitFor(() => {
      expect([...store.tables.sync_queue.values()].some(j => j.payload?.status === 'approved')).toBe(true)
    })
    expect(alerts.showAlert).not.toHaveBeenCalledWith(en.approval.revalidateFailed, 'warning')
  })

  it('drawing a signature over a stale approval drops the stale record', async () => {
    const stale = record('referee1', { result_key: 'ov-result-v1|1:25:20,2:23:25,3:25:18,4:26:24' })
    seed({ scorerSignature: 'data:s', ref2Signature: 'data:r2', accountApprovals: { referee1: stale } })
    api.list = vi.fn(async () => ({ data: { match: {}, approvals: [stale] }, error: null, status: 200 }))
    render(<MatchEnd matchId={1} />)
    await refreshed()
    fireEvent.click(await screen.findByTestId('account-approval-stale-ref1'))
    fireEvent.click(await findButton(/^draw /))
    await waitFor(() => expect(store.tables.matches.get(1).ref1Signature).toBe('data:image/png;base64,SIG'))
    await waitFor(() => expect(store.tables.matches.get(1).accountApprovals).toBeNull())
  })

  it('"Reopen match" keeps the account approvals, as it keeps the drawn signatures (review fix)', async () => {
    const approved = { referee1: record('referee1') }
    seed({ scorerSignature: 'data:s', ref2Signature: 'data:r2', accountApprovals: approved })
    api.list = vi.fn(async () => ({ data: { match: {}, approvals: [approved.referee1] }, error: null, status: 200 }))
    window.open = vi.fn(() => null)
    URL.createObjectURL = vi.fn(() => 'blob:x')
    render(<MatchEnd matchId={1} />)
    await waitFor(() => expect(confirmButton()).toBeEnabled())
    fireEvent.click(confirmButton())
    fireEvent.click(await findButton(en.matchEnd.export.approveWithoutPdf))
    const reopen = await findButton(en.matchEnd.reopenMatch)
    fireEvent.click(reopen)
    await waitFor(() => expect(store.tables.matches.get(1).approved).toBe(false))
    expect(api.undo).not.toHaveBeenCalled()
    expect(store.tables.matches.get(1).accountApprovals).toEqual(approved)
    expect(store.tables.matches.get(1).ref1Signature).toBeUndefined()
    await waitFor(() => expect(confirmButton()).toBeEnabled())
  })

  it('an account without the scorer or referee role: the reason, no button (the server refuses it too)', async () => {
    auth.value = { user: { id: 'u-new', email: 'new@club.ch' }, access: { roles: [], isAdmin: false } }
    render(<MatchEnd matchId={1} />)
    await within(await screen.findByTestId('signature-slot-scorer')).findByText(en.matchEnd.tapToSign)
    await refreshed()
    expect(screen.queryByTestId('account-approval-open-scorer')).toBeNull()
    expect(screen.getByTestId('account-approval-why-ref1')).toHaveTextContent(en.approval.why.callerRole)
  })

  it('without a session, and when the server does not offer the feature: each says why', async () => {
    auth.value = { user: null, access: { roles: [] } }
    const first = render(<MatchEnd matchId={1} />)
    await within(await screen.findByTestId('signature-slot-scorer')).findByText(en.matchEnd.tapToSign)
    expect(screen.queryByTestId('account-approval-open-scorer')).toBeNull()
    expect(screen.getByTestId('account-approval-why-scorer')).toHaveTextContent(en.approval.why.signedOut)
    first.unmount()

    auth.value = { user: { id: 'u', email: 'a@b.ch' }, access: { roles: ['scorer'] } }
    api.list = vi.fn(async () => ({ data: null, error: { code: 'OV_APPROVAL_UNAVAILABLE', status: 503 }, status: 503 }))
    render(<MatchEnd matchId={1} />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('account-approval-why-scorer')).toHaveTextContent(en.approval.why.serverOff))
    expect(screen.queryByTestId('account-approval-open-scorer')).toBeNull()
  })

  it('a match that is not in the cloud says so', async () => {
    seed({ seed_key: undefined })
    render(<MatchEnd matchId={1} />)
    expect(await screen.findByTestId('account-approval-why-ref1')).toHaveTextContent(en.approval.why.localMatch)
  })

  it('signed by hand and approved: both show, with Undo', async () => {
    const approved = { referee1: record('referee1') }
    seed({ scorerSignature: 'data:s', ref2Signature: 'data:r2', ref1Signature: 'data:r1', accountApprovals: approved })
    api.list = vi.fn(async () => ({ data: { match: {}, approvals: [approved.referee1] }, error: null, status: 200 }))
    render(<MatchEnd matchId={1} />)
    await refreshed()
    expect(within(slot('ref1')).getByAltText(en.common.signature)).toBeInTheDocument()
    expect(screen.getByTestId('account-approval-ref1')).toHaveTextContent('Muster Anna · 07.10.2026 21:42 · ID 6F1C2A9B')
    expect(screen.getByTestId('account-approval-undo-ref1')).toBeEnabled()
  })
})

describe('MatchEnd: Re-sign and Clear', () => {
  const matchJobs = () => [...store.tables.sync_queue.values()].filter(j => j.resource === 'match' && j.payload?.signatures)

  it('Re-sign replaces the signature, saves it at once and queues the whole signatures object', async () => {
    seed({ homeCoachSignature: 'data:coach', scorerSignature: 'data:old' })
    render(<MatchEnd matchId={1} />)
    await refreshed()
    fireEvent.click(await screen.findByTestId('signature-resign-scorer'))
    fireEvent.click(await findButton(/^draw /))
    await waitFor(() => expect(store.tables.matches.get(1).scorerSignature).toBe('data:image/png;base64,SIG'))
    const job = matchJobs().at(-1)
    expect(job.payload.id).toBe(SEED)
    expect(job.payload.signatures).toMatchObject({ scorer: 'data:image/png;base64,SIG', home_coach: 'data:coach', home_captain_post_game: 'data:cap-a' })
  })

  it('Clear empties the slot at once (saved and synced) and opens the pad', async () => {
    seed({ scorerSignature: 'data:old' })
    render(<MatchEnd matchId={1} />)
    await refreshed()
    fireEvent.click(await screen.findByTestId('signature-clear-scorer'))
    await waitFor(() => expect(store.tables.matches.get(1).scorerSignature).toBeNull())
    expect(matchJobs().at(-1).payload.signatures.scorer).toBeNull()
    // the pad is open for the new signature
    expect(await findButton(/^draw /)).toBeInTheDocument()
  })

  it('also on the captains; a test match is saved but not sent', async () => {
    seed({ test: true })
    render(<MatchEnd matchId={1} />)
    await refreshed()
    fireEvent.click(await screen.findByTestId('signature-clear-captain-a'))
    await waitFor(() => expect(store.tables.matches.get(1).homePostGameCaptainSignature).toBeNull())
    expect(matchJobs()).toHaveLength(0)
  })

  it('re-signing keeps a valid account approval (it is bound to the result, not to the image)', async () => {
    const approved = { referee1: record('referee1') }
    seed({ scorerSignature: 'data:s', ref2Signature: 'data:r2', ref1Signature: 'data:r1', accountApprovals: approved })
    api.list = vi.fn(async () => ({ data: { match: {}, approvals: [approved.referee1] }, error: null, status: 200 }))
    render(<MatchEnd matchId={1} />)
    await refreshed()
    fireEvent.click(screen.getByTestId('signature-resign-ref1'))
    fireEvent.click(await findButton(/^draw /))
    await waitFor(() => expect(store.tables.matches.get(1).ref1Signature).toBe('data:image/png;base64,SIG'))
    expect(store.tables.matches.get(1).accountApprovals).toEqual(approved)
    expect(api.undo).not.toHaveBeenCalled()
  })

  it('disabled once the match is approved or closed', async () => {
    // approved: the page opens on the approved view (from the match row), no
    // signature boxes to change
    seed({ scorerSignature: 'data:s', approved: true })
    const first = render(<MatchEnd matchId={1} />)
    await findButton(en.matchEnd.closeMatch)
    expect(screen.queryByTestId('signature-resign-scorer')).toBeNull()
    expect(screen.queryByTestId('account-approval-open-ref1')).toBeNull()
    first.unmount()

    // closed (not approved here): the boxes are shown, locked
    seed({ scorerSignature: 'data:s', closed_at: '2026-10-07T20:00:00Z' })
    render(<MatchEnd matchId={1} />)
    expect(await screen.findByTestId('signature-resign-scorer')).toBeDisabled()
    expect(screen.getByTestId('signature-clear-scorer')).toBeDisabled()
    expect(screen.getByTestId('signature-clear-captain-a')).toBeDisabled()
    expect(screen.getByTestId('account-approval-why-ref1')).toHaveTextContent(en.approval.why.locked)
  })
})

describe('AccountApprovalDialog under StrictMode (review fix)', () => {
  it('the dev double mount does not leave the dialog stuck: onApproved is called', async () => {
    const approved = record('referee1')
    api.approve = vi.fn(async () => ({ data: { approval: approved, already: false }, error: null, status: 200 }))
    const onApproved = vi.fn()
    render(
      <StrictMode>
        <AccountApprovalDialog open onClose={() => {}} match={store.tables.matches.get(1)} role="ref1" roleLabel="1st referee" sets={SETS} userEmail="scorer@club.ch" onApproved={onApproved} />
      </StrictMode>
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(en.approval.email), { target: { value: 'anna@example.ch' } })
    fireEvent.change(within(dialog).getByLabelText(en.approval.pinLabel), { target: { value: PIN } })
    fireEvent.click(within(dialog).getByTestId('account-approval-submit'))
    await waitFor(() => expect(onApproved).toHaveBeenCalledWith(approved, { email: 'anna@example.ch', entered: 'Muster Anna' }))
    // not stuck busy: Cancel works again
    expect(within(dialog).getByRole('button', { name: en.common.cancel })).toBeEnabled()
  })
})
