/**
 * MatchEnd: approval with an account next to the drawn signatures
 * (docs/account-approval-spec.md 4.5, tests 6.2). The approvals API is
 * mocked; Dexie is an in-memory stand-in that re-runs live queries on writes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react'
import en from '../../i18n/locales/en.json'

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

// In-memory Dexie: where(field).equals(v), live queries re-run after writes
const store = vi.hoisted(() => ({ tables: {}, nextId: 1, listeners: new Set() }))
vi.mock('dexie-react-hooks', async () => {
  const React = await import('react')
  return {
    useLiveQuery: (fn, deps = []) => {
      const [value, setValue] = React.useState(undefined)
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => {
        const l = () => setTick(x => x + 1)
        store.listeners.add(l)
        return () => { store.listeners.delete(l) }
      }, [])
      React.useEffect(() => {
        let alive = true
        Promise.resolve(fn()).then((v) => { if (alive) setValue(v) })
        return () => { alive = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [...deps, tick])
      return value
    }
  }
})
vi.mock('../../db/db', () => {
  const rowsOf = (name) => (store.tables[name] ||= new Map())
  const changed = () => { for (const l of [...store.listeners]) l() }
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

// The mount refresh (list) writes the match row, which re-renders the boxes:
// wait for it before clicking, or the click lands on a replaced node
async function refreshed() {
  await waitFor(() => expect(store.tables.matches.get(1)).toHaveProperty('accountApprovals'))
  // let the live query re-render with the written row
  await act(() => new Promise(resolve => setTimeout(resolve, 20)))
}
async function openApprove(role) {
  await refreshed()
  fireEvent.click(await screen.findByTestId(`account-approval-open-${role}`))
  return screen.findByRole('dialog')
}

const confirmButton = () => screen.getByRole('button', { name: en.matchEnd.approveParams })
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
  it('offers the action on scorer, 2nd and 1st referee only, and hides it once drawn', async () => {
    seed({ asstScorerSignature: undefined, officials: [
      { role: '1st referee', firstName: 'Anna', lastName: 'Muster' },
      { role: '2nd referee', firstName: 'Ben', lastName: 'Beispiel' },
      { role: 'scorer', firstName: 'Sam', lastName: 'Scorer' },
      { role: 'assistant scorer', firstName: 'Ada', lastName: 'Assist' }
    ], ref2Signature: 'data:ref2' })
    render(<MatchEnd matchId={1} />)
    await screen.findByTestId('account-approval-open-scorer')
    expect(screen.getByTestId('account-approval-open-ref1')).toBeInTheDocument()
    // drawn ref2: no account action
    expect(screen.queryByTestId('account-approval-open-ref2')).toBeNull()
    // assistant scorer and captains never
    expect(screen.queryByTestId('account-approval-open-asst-scorer')).toBeNull()
    expect(screen.queryByTestId('account-approval-open-captain-a')).toBeNull()
    expect(within(slot('asst-scorer')).queryByRole('button', { name: en.approval.approveWithAccount })).toBeNull()
  })

  it('offline: disabled with the sign-by-hand label; enabled again on "online"', async () => {
    render(<MatchEnd matchId={1} />)
    await refreshed()
    await screen.findByTestId('account-approval-open-scorer')
    setOnline(false)
    await waitFor(() => expect(screen.getByTestId('account-approval-open-scorer')).toBeDisabled())
    expect(screen.getByTestId('account-approval-open-scorer')).toHaveTextContent(en.approval.needsInternetSignByHand)
    setOnline(true)
    await waitFor(() => expect(screen.getByTestId('account-approval-open-scorer')).toBeEnabled())
    expect(screen.getByTestId('account-approval-open-scorer')).toHaveTextContent(en.approval.approveWithAccount)
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
    render(<MatchEnd matchId={1} />)
    await refreshed()

    // scorer and 2nd referee draw
    fireEvent.click(await within(await screen.findByTestId('signature-slot-scorer')).findByText(en.matchEnd.tapToSign))
    fireEvent.click(await screen.findByRole('button', { name: /draw/ }))
    await waitFor(() => expect(store.tables.matches.get(1).scorerSignature).toBe('data:image/png;base64,SIG'))
    await act(() => new Promise(resolve => setTimeout(resolve, 20)))
    fireEvent.click(await within(slot('ref2')).findByText(en.matchEnd.tapToSign))
    fireEvent.click(await screen.findByRole('button', { name: /draw/ }))
    await waitFor(() => expect(store.tables.matches.get(1).ref2Signature).toBeTruthy())
    await act(() => new Promise(resolve => setTimeout(resolve, 20)))
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

  it('a locked PIN says how long; a blocked one says to set a new PIN', async () => {
    api.approve = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: 'OV_APPROVAL_PIN_LOCKED', status: 423, details: { retry_after_sec: 610 } }, status: 423 })
      .mockResolvedValueOnce({ data: null, error: { code: 'OV_APPROVAL_PIN_LOCKED', status: 423, details: { disabled: true } }, status: 423 })
    seed({ scorerSignature: 'data:s', ref2Signature: 'data:r2' })
    render(<MatchEnd matchId={1} />)
    const dialog = await openApprove('ref1')
    fireEvent.change(within(dialog).getByLabelText(en.approval.email), { target: { value: 'anna@example.ch' } })
    fireEvent.change(within(dialog).getByLabelText(en.approval.pinLabel), { target: { value: '111111' } })
    fireEvent.click(within(dialog).getByTestId('account-approval-submit'))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Try again in 11 min')
    fireEvent.change(within(dialog).getByLabelText(en.approval.pinLabel), { target: { value: '111111' } })
    fireEvent.click(within(dialog).getByTestId('account-approval-submit'))
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(en.approval.errors.pinDisabled))
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
    await waitFor(() => {
      const jobs = [...store.tables.sync_queue.values()]
      expect(jobs.some(j => j.payload?.status === 'approved')).toBe(true)
    }, { timeout: 5000 })
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

  it('hidden without a session, and when the server does not offer the feature', async () => {
    auth.value = { user: null, access: { roles: [] } }
    const first = render(<MatchEnd matchId={1} />)
    await within(await screen.findByTestId('signature-slot-scorer')).findByText(en.matchEnd.tapToSign)
    expect(screen.queryByTestId('account-approval-open-scorer')).toBeNull()
    first.unmount()

    auth.value = { user: { id: 'u', email: 'a@b.ch' }, access: { roles: ['scorer'] } }
    api.list = vi.fn(async () => ({ data: null, error: { code: 'OV_APPROVAL_UNAVAILABLE', status: 503 }, status: 503 }))
    render(<MatchEnd matchId={1} />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId('account-approval-open-scorer')).toBeNull())
  })
})
