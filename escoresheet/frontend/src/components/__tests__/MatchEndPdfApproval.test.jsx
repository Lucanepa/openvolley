/**
 * MatchEnd: "Confirm and approve" and the scoresheet window's PDF (parity
 * with OpenBeach, video 2026-10-08):
 * - closing the scoresheet window while it made the PDF left the approval
 *   waiting up to 30 s with nothing to press;
 * - after the approval a remount fell back to "Confirm and approve" (the
 *   approval lived only in component state).
 * Now the wait ends at once, the scorer chooses Retry / Approve without PDF /
 * Cancel (Cancel leaves the match unapproved), Cancel is there while the PDF
 * is made, the approval and its sync job are written in one transaction and
 * the approved view comes from the match row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import en from '../../i18n/locales/en.json'
import { findButton, getButton, queryAllButtons } from '../../__tests__/buttonQueries'

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
  const logger = { logHandler: () => {}, logFunction: () => {}, logCallback: () => {}, logHook: () => {}, logEffect: () => {}, logError: () => {}, wrapHandler: (fn) => fn, wrapFunction: (fn) => fn }
  return { useComponentLogging: () => logger, useLogging: () => ({ createComponentLogger: () => logger, logNavigation: () => {} }) }
})
const alerts = vi.hoisted(() => ({ showAlert: null }))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: alerts.showAlert, showConfirm: vi.fn() }) }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => null }))
vi.mock('../../hooks/useScaledLayout', () => ({ useScaledLayout: () => ({ vmin: (n) => `${n}vmin` }), default: () => ({ vmin: (n) => `${n}vmin` }) }))
vi.mock('../../utils/comprehensiveLogger', () => ({ exportLogsAsNDJSON: async () => '', downloadLogs: async () => {} }))
vi.mock('../../utils/backendConfig', async (orig) => ({ ...(await orig()), getCloudApiUrl: () => null }))
vi.mock('../../lib/apiClient', () => {
  const chain = () => {
    const b = new Proxy({}, { get: (_, prop) => (prop === 'then' ? (r) => Promise.resolve({ data: null, error: null }).then(r) : () => b) })
    return b
  }
  return { apiFrom: () => chain(), apiStorage: { from: () => chain() }, apiRequest: vi.fn() }
})

// The scoresheet window: each open gets a fresh fake window the test can close
const opened = vi.hoisted(() => [])
vi.mock('../../utils/openAppWindow', async (orig) => ({
  ...(await orig()),
  openAppWindow: vi.fn((url) => {
    const w = { url, closed: false, close() { this.closed = true } }
    opened.push(w)
    return { ok: true, mode: 'window', platform: 'tauri', window: w }
  })
}))

// In-memory Dexie (as MatchEndAccountApproval.test.jsx): live queries re-run
// after writes; transactions record their tables.
const store = vi.hoisted(() => ({ tables: {}, nextId: 1, listeners: new Set(), transactions: [] }))
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
  const collection = (rows) => ({
    equals: (v) => collection(rows.filter(r => r.__field === undefined ? true : r[r.__field] === v)),
    toArray: async () => rows,
    sortBy: async (k) => [...rows].sort((a, b) => (a[k] ?? 0) - (b[k] ?? 0)),
    filter: (fn) => collection(rows.filter(fn)),
    first: async () => rows[0],
    delete: async () => 0,
    anyOf: () => collection(rows),
    count: async () => rows.length
  })
  const table = (name) => ({
    name,
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
      if (prop === 'transaction') {
        return async (...args) => {
          const tx = { tables: args.slice(1, -1).map(t => t?.name), writes: [] }
          store.transactions.push(tx)
          store.inTx = tx
          try { return await args[args.length - 1]() } finally { store.inTx = null }
        }
      }
      if (typeof prop !== 'string' || prop === 'then') return undefined
      const tb = table(prop)
      // writes made inside a transaction are recorded on it
      for (const op of ['add', 'update']) {
        const f = tb[op]
        tb[op] = async (...a) => { store.inTx?.writes.push(`${prop}.${op}`); return f(...a) }
      }
      return tb
    }
  })
  return { db, default: db }
})

import MatchEnd from '../MatchEnd'

function seed(matchOver = {}) {
  store.tables = {}
  store.nextId = 500
  store.transactions = []
  store.tables.matches = new Map([[1, {
    id: 1, seed_key: 'match_1_pdf', status: 'ended', test: false, coinTossTeamA: 'home', homeTeamId: 1, awayTeamId: 2,
    officials: [{ role: '1st referee', firstName: 'Anna', lastName: 'Muster' }, { role: 'scorer', firstName: 'Sam', lastName: 'Scorer' }],
    homePostGameCaptainSignature: 'data:cap-a', awayPostGameCaptainSignature: 'data:cap-b',
    scorerSignature: 'data:s', ref1Signature: 'data:r1',
    ...matchOver
  }]])
  store.tables.teams = new Map([[1, { id: 1, name: 'Home V' }], [2, { id: 2, name: 'Away V' }]])
  store.tables.players = new Map()
  store.tables.sets = new Map([
    [11, { id: 11, matchId: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true }],
    [12, { id: 12, matchId: 1, index: 2, homePoints: 25, awayPoints: 23, finished: true }],
    [13, { id: 13, matchId: 1, index: 3, homePoints: 25, awayPoints: 18, finished: true }]
  ])
  store.tables.events = new Map()
  store.tables.sync_queue = new Map()
}

const approveButton = () => getButton(en.matchEnd.approveParams)
const approvedJobs = () => [...store.tables.sync_queue.values()].filter(j => j.payload?.status === 'approved')
const postFromSheet = (data) => act(async () => {
  window.dispatchEvent(new MessageEvent('message', { data, origin: window.location.origin }))
})
async function approve() {
  await waitFor(() => expect(approveButton()).toBeEnabled())
  fireEvent.click(approveButton())
  await waitFor(() => expect(opened).toHaveLength(1))
}

beforeEach(() => {
  seed()
  opened.length = 0
  alerts.showAlert = vi.fn()
  URL.createObjectURL = vi.fn(() => 'blob:x')
  HTMLAnchorElement.prototype.click = () => {}
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true })
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => {
  cleanup()
})

describe('MatchEnd: the approval PDF', () => {
  it('a closed scoresheet window stops the wait at once; Cancel leaves the match unapproved and usable', async () => {
    render(<MatchEnd matchId={1} />)
    await approve()
    opened[0].closed = true // the scorer closes the window (X)
    const dialog = await screen.findByTestId('export-pdf-failed', {}, { timeout: 2000 })
    expect(dialog).toHaveTextContent(en.matchEnd.export.reason.closed)
    fireEvent.click(getButton(en.matchEnd.export.cancel, dialog))
    await waitFor(() => expect(screen.queryByTestId('export-pdf-failed')).toBeNull())
    await waitFor(() => expect(approveButton()).toBeEnabled())
    expect(store.tables.matches.get(1).approved).toBeFalsy()
    expect(approvedJobs()).toHaveLength(0)
  })

  it('Retry opens the scoresheet again and its PDF approves the match', async () => {
    render(<MatchEnd matchId={1} />)
    await approve()
    await postFromSheet({ type: 'pdfBlobFailed', reason: 'closed' }) // pagehide in the window
    fireEvent.click(await findButton(en.matchEnd.export.retry))
    await waitFor(() => expect(opened).toHaveLength(2))
    await postFromSheet({ type: 'pdfBlob', arrayBuffer: new ArrayBuffer(8), filename: 'x.pdf' })
    await findButton(en.matchEnd.closeMatch, { timeout: 3000 })
    expect(store.tables.matches.get(1).approved).toBe(true)
    expect(approvedJobs()).toHaveLength(1)
    expect(alerts.showAlert).not.toHaveBeenCalledWith(en.matchEnd.pdfGenerationFailed, 'warning')
  })

  it('Approve without PDF approves the match (the approval and its sync job in one transaction)', async () => {
    store.tables.matches.get(1).remarks = 'Actual start time: 18:05'
    render(<MatchEnd matchId={1} />)
    await approve()
    await postFromSheet({ type: 'pdfBlobFailed' })
    fireEvent.click(await findButton(en.matchEnd.export.approveWithoutPdf))
    await findButton(en.matchEnd.closeMatch, { timeout: 3000 })
    expect(store.tables.matches.get(1).approved).toBe(true)
    expect(approvedJobs()).toHaveLength(1)
    const tx = store.transactions.find(t => t.writes.includes('matches.update'))
    expect(tx).toBeTruthy()
    expect(tx.tables).toEqual(expect.arrayContaining(['sync_queue', 'matches']))
    // db/017: the remarks as approved, their own job just before the approval
    expect(tx.writes).toEqual(['sync_queue.add', 'sync_queue.add', 'matches.update'])
    const jobs = [...store.tables.sync_queue.values()]
    const remarksJob = jobs.find(j => j.payload && 'remarks' in j.payload)
    expect(remarksJob.payload).toEqual({ id: 'match_1_pdf', remarks: 'Actual start time: 18:05' })
    expect(jobs.indexOf(remarksJob)).toBeLessThan(jobs.indexOf(approvedJobs()[0]))
    expect('remarks' in approvedJobs()[0].payload).toBe(false)
    expect(alerts.showAlert).toHaveBeenCalledWith(en.matchEnd.pdfGenerationFailed, 'warning')
  })

  it('Cancel while the PDF is made stops at once, closes the window, nothing approved', async () => {
    render(<MatchEnd matchId={1} />)
    await approve()
    fireEvent.click(await screen.findByTestId('export-cancel'))
    await waitFor(() => expect(approveButton()).toBeEnabled())
    expect(screen.queryByTestId('export-pdf-failed')).toBeNull()
    expect(opened[0].closed).toBe(true) // the window is not left behind
    expect(store.tables.matches.get(1).approved).toBeFalsy()
    expect(approvedJobs()).toHaveLength(0)
  })

  it('a late "closed" from the window of an earlier attempt does not end the next one', async () => {
    render(<MatchEnd matchId={1} />)
    await approve()
    const reqOf = (w) => new URL(w.url, 'http://x').searchParams.get('pdfReq')
    const firstReq = reqOf(opened[0])
    expect(firstReq).toBeTruthy()
    fireEvent.click(await screen.findByTestId('export-cancel'))
    await waitFor(() => expect(approveButton()).toBeEnabled())
    fireEvent.click(approveButton())
    await waitFor(() => expect(opened).toHaveLength(2))
    const secondReq = reqOf(opened[1])
    expect(secondReq).toBeTruthy()
    expect(secondReq).not.toBe(firstReq)
    // the first window's pagehide arrives only now (it was busy capturing)
    await postFromSheet({ type: 'pdfBlobFailed', reason: 'closed', req: firstReq })
    await new Promise(r => setTimeout(r, 50))
    expect(screen.queryByTestId('export-pdf-failed')).toBeNull()
    expect(opened[1].closed).toBe(false)
    await postFromSheet({ type: 'pdfBlob', arrayBuffer: new ArrayBuffer(8), filename: 'x.pdf', req: secondReq })
    await findButton(en.matchEnd.closeMatch, { timeout: 3000 })
    expect(store.tables.matches.get(1).approved).toBe(true)
  })

  it('the export modal sits above the header (z 1000) and its open menu', async () => {
    render(<MatchEnd matchId={1} />)
    await approve()
    const modal = await screen.findByTestId('export-modal')
    expect(Number(modal.style.zIndex)).toBeGreaterThan(1000)
  })

  it('an approved match shows the approved view after a remount', async () => {
    seed({ approved: true, approvedAt: '2026-10-08T10:00:00Z' })
    render(<MatchEnd matchId={1} />)
    await findButton(en.matchEnd.closeMatch, { timeout: 3000 })
    expect(queryAllButtons(en.matchEnd.approveParams)).toHaveLength(0)
  })
})
