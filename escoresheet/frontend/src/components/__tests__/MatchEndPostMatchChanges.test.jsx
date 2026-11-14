/**
 * MatchEnd after the sheet was signed (pre-rollout audit 2026-11):
 * - logic-matchend-sheet-3: "Edit remarks" and removing a remarks signature
 *   kept every signature and approval of the old sheet (a protest could be
 *   deleted above them);
 * - fe-home-options-1: the server's approvals came back with the next
 *   refresh while their undo was still queued;
 * - logic-matchend-sheet-4: "Approve without PDF" left the league without
 *   the official PDF for good;
 * - logic-scoresheet-pdf-1: the sheet's consistency warnings were never
 *   seen before the approval;
 * - fe-home-options-5: a finished set at an impossible score was approved;
 * - fe-home-options-2: corrections after the match were not on the sheet.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react'
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
const auth = vi.hoisted(() => ({ value: null }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }))
vi.mock('../../hooks/useScaledLayout', () => ({ useScaledLayout: () => ({ vmin: (n) => `${n}vmin` }), default: () => ({ vmin: (n) => `${n}vmin` }) }))
vi.mock('../../utils/comprehensiveLogger', () => ({ exportLogsAsNDJSON: async () => '', downloadLogs: async () => {} }))
const cloud = vi.hoisted(() => ({ on: false }))
vi.mock('../../utils/backendConfig', async (orig) => ({ ...(await orig()), getCloudApiUrl: (p) => (cloud.on ? `https://api.test${p}` : null) }))
const confirm = vi.hoisted(() => ({ answer: true, calls: [] }))
vi.mock('../../utils/askConfirm.js', () => {
  const ask = async (opts) => { confirm.calls.push(opts); return confirm.answer }
  return { askConfirm: ask, default: ask }
})
const api = vi.hoisted(() => ({ list: null, undo: null }))
vi.mock('../../lib/accountApi', async (orig) => ({
  ...(await orig()),
  approvalsApi: { approve: vi.fn(), list: (...a) => api.list(...a), undo: (...a) => api.undo(...a) }
}))
vi.mock('../../lib/apiClient', () => {
  const chain = () => {
    const b = new Proxy({}, { get: (_, prop) => (prop === 'then' ? (r) => Promise.resolve({ data: null, error: null }).then(r) : () => b) })
    return b
  }
  return { apiFrom: () => chain(), apiStorage: { from: () => ({ upload: () => new Promise(() => {}) }) }, apiRequest: vi.fn() }
})
vi.mock('../../utils/matchEndLiveState', () => ({ publishMatchEndLiveState: vi.fn(async () => true) }))
const opened = vi.hoisted(() => [])
vi.mock('../../utils/openAppWindow', async (orig) => ({
  ...(await orig()),
  openAppWindow: vi.fn((url) => {
    const w = { url, closed: false, close() { this.closed = true } }
    opened.push(w)
    return { ok: true, mode: 'window', platform: 'tauri', window: w }
  })
}))
const pdf = vi.hoisted(() => ({ wait: null }))
vi.mock('../../utils/scoresheetPdfRequest', async (orig) => ({ ...(await orig()), waitForScoresheetPdf: (...a) => pdf.wait(...a) }))
vi.mock('../SignaturePad', () => ({
  default: ({ open, onSave, title }) => (open
    ? <div><button type="button" onClick={() => onSave('data:image/png;base64,SIG', { source: 'device' })}>draw {title}</button></div>
    : null)
}))

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
  const collection = (rows) => ({
    equals: (v) => collection(rows),
    toArray: async () => rows,
    sortBy: async (k) => [...rows].sort((a, b) => (a[k] ?? 0) - (b[k] ?? 0)),
    filter: (fn) => collection(rows.filter(fn)),
    and: (fn) => collection(rows.filter(fn)),
    first: async () => rows[0],
    delete: async () => 0,
    anyOf: () => collection(rows),
    count: async () => rows.length
  })
  const table = (name) => ({
    name,
    get: async (id) => rowsOf(name).get(id),
    add: async (row) => { const id = row?.id ?? store.nextId++; rowsOf(name).set(id, { ...row, id }); changed(); return id },
    update: async (id, ch) => {
      const r = rowsOf(name).get(id)
      if (!r) return 0
      const next = { ...r }
      for (const [k, v] of Object.entries(ch)) {
        if (!k.includes('.')) { next[k] = v; continue }
        const [head, ...rest] = k.split('.')
        next[head] = { ...(next[head] || {}) }
        next[head][rest.join('.')] = v
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
      return {
        equals: (v) => collection([...rowsOf(name).values()].filter(r => r[field] === v)),
        anyOf: (...vals) => collection([...rowsOf(name).values()].filter(r => vals.flat().includes(r[field])))
      }
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
import { resultKey } from '../../domain/accountApproval'

const SEED = 'match_post_1'
const SETS = [
  { id: 11, matchId: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true },
  { id: 12, matchId: 1, index: 2, homePoints: 25, awayPoints: 22, finished: true },
  { id: 13, matchId: 1, index: 3, homePoints: 25, awayPoints: 18, finished: true }
]
const OFFICIALS = [
  { role: '1st referee', firstName: 'Anna', lastName: 'Example' },
  { role: 'scorer', firstName: 'Sam', lastName: 'Sample' }
]
const SIGNED = {
  homePostGameCaptainSignature: 'data:cap-a', awayPostGameCaptainSignature: 'data:cap-b',
  scorerSignature: 'data:scorer', ref1Signature: 'data:ref1'
}
const APPROVAL_ID = '11111111-1111-4111-8111-111111111111'
const approval = { id: APPROVAL_ID, short_id: '11111111', slot: 'referee1', name: 'Anna Example', approved_at: '2026-11-09T20:00:00Z', result_key: resultKey(SETS) }

function seed(matchOver = {}, { sets = SETS, events = [] } = {}) {
  store.tables = {}
  store.nextId = 500
  store.tables.matches = new Map([[1, {
    id: 1, seed_key: SEED, status: 'ended', test: false, coinTossTeamA: 'home', homeTeamId: 1, awayTeamId: 2,
    gameNumber: 4711, officials: OFFICIALS, remarks: 'Protest of team B at 12:10 in set 2.', ...matchOver
  }]])
  store.tables.teams = new Map([[1, { id: 1, name: 'Home V' }], [2, { id: 2, name: 'Away V' }]])
  store.tables.players = new Map([
    [31, { id: 31, teamId: 1, number: 7, firstName: 'Lea', lastName: 'One', isCaptain: true }],
    [41, { id: 41, teamId: 2, number: 9, firstName: 'Mia', lastName: 'Two', isCaptain: true }]
  ])
  store.tables.sets = new Map(sets.map(s => [s.id, { ...s }]))
  store.tables.events = new Map(events.map(e => [e.id, { matchId: 1, ...e }]))
  store.tables.sync_queue = new Map()
}
const row = () => store.tables.matches.get(1)
const jobs = () => [...store.tables.sync_queue.values()]
const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 30)))
const approveButton = () => getButton(en.matchEnd.approveParams)
const failPdf = () => { const e = new Error('blocked'); e.reason = 'blocked'; throw e }

beforeEach(() => {
  seed()
  opened.length = 0
  confirm.answer = true
  confirm.calls = []
  cloud.on = false
  auth.value = null
  alerts.showAlert = vi.fn()
  api.list = vi.fn(async () => ({ data: { match: { status: 'ended', closed_at: null }, approvals: [] }, error: null, status: 200 }))
  api.undo = vi.fn(async () => ({ data: {}, error: null, status: 200 }))
  pdf.wait = vi.fn(async () => ({ blob: new Blob(['%PDF-1.4'], { type: 'application/pdf' }), filename: 'sheet.pdf' }))
  URL.createObjectURL = vi.fn(() => 'blob:x')
  HTMLAnchorElement.prototype.click = () => {}
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true })
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => { cleanup() })

async function editRemarks(text) {
  fireEvent.click(await findButton(en.matchEnd.editRemarks))
  const box = await screen.findByLabelText(en.matchEnd.remarks)
  fireEvent.change(box, { target: { value: text } })
  fireEvent.click(getButton(en.common.save))
}

describe('logic-matchend-sheet-3: remarks after the signatures', () => {
  it('a remarks change after every signature asks, then clears the signatures and approvals here and on the server', async () => {
    seed({ ...SIGNED, ref1Signature: null, accountApprovals: { referee1: approval } })
    render(<MatchEnd matchId={1} />)
    await settle()
    await waitFor(() => expect(approveButton()).toBeEnabled())
    await editRemarks('')
    await waitFor(() => expect(row().remarks).toBe(''))
    expect(confirm.calls.map(c => c.title)).toEqual([en.matchEnd.signedSheetChange.title])
    for (const f of ['homePostGameCaptainSignature', 'awayPostGameCaptainSignature', 'scorerSignature', 'ref1Signature']) expect(row()[f]).toBeNull()
    expect(row().accountApprovals).toBeNull()
    // logged as a change after the match (printed in REMARKS) and sent with the cleared signatures
    expect(row().manualChanges.at(-1)).toMatchObject({ category: 'correction', action: 'editRemarks', afterMatch: true, before: 'Protest of team B at 12:10 in set 2.', after: '' })
    const sigJob = jobs().find(j => j.resource === 'match' && j.payload?.signatures)
    expect(sigJob.payload.signatures).toMatchObject({ home_captain_post_game: null, away_captain_post_game: null, scorer: null, ref1: null })
    expect(sigJob.payload.manual_changes).toHaveLength(1)
    expect(jobs().filter(j => j.resource === 'approval').map(j => [j.action, j.payload.id])).toEqual([['undo', APPROVAL_ID]])
    await settle()
    expect(approveButton()).toBeDisabled()
  })

  it('declined: the remarks and every signature stay', async () => {
    seed(SIGNED)
    confirm.answer = false
    render(<MatchEnd matchId={1} />)
    await settle()
    await editRemarks('')
    await waitFor(() => expect(confirm.calls).toHaveLength(1))
    await settle()
    expect(row().remarks).toBe('Protest of team B at 12:10 in set 2.')
    expect(row().ref1Signature).toBe('data:ref1')
    expect(jobs()).toHaveLength(0)
  })

  it('before anyone signed, the remarks are written as before: no question, no log entry', async () => {
    render(<MatchEnd matchId={1} />)
    await settle()
    await editRemarks('Protest of team B, withdrawn.')
    await waitFor(() => expect(row().remarks).toBe('Protest of team B, withdrawn.'))
    expect(confirm.calls).toHaveLength(0)
    expect(row().manualChanges).toBeUndefined()
  })

  it('removing a remarks signature after the sheet was signed asks and clears the signatures too', async () => {
    seed({ ...SIGNED, remarksSignatures: [{ role: 'Referee coach', name: 'Rita Coach', image: 'data:image/png;base64,RC', signedAt: '2026-11-09T20:00:00Z' }] })
    render(<MatchEnd matchId={1} />)
    await settle()
    fireEvent.click(within(screen.getByTestId('remarks-signature')).getByRole('button', { name: en.common.remove }))
    await waitFor(() => expect(row().remarksSignatures).toEqual([]))
    expect(confirm.calls).toHaveLength(1)
    expect(row().ref1Signature).toBeNull()
    expect(row().manualChanges.at(-1)).toMatchObject({ action: 'removeRemarksSignature', afterMatch: true })
  })
})

describe('fe-home-options-1: an approval whose undo is still queued', () => {
  it('is not copied back from the server', async () => {
    cloud.on = true
    auth.value = { user: { id: 'u-scorer', email: 'scorer@example.org' }, access: { roles: ['scorer'], isAdmin: false } }
    seed()
    store.tables.sync_queue.set(700, { id: 700, resource: 'approval', action: 'undo', status: 'queued', payload: { id: APPROVAL_ID, match_external_id: SEED } })
    api.list = vi.fn(async () => ({ data: { match: { status: 'ended', closed_at: null }, approvals: [{ ...approval, revoked_at: null }] }, error: null, status: 200 }))
    render(<MatchEnd matchId={1} />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    await settle()
    expect(row().accountApprovals ?? null).toBeNull()
  })
})

describe('logic-matchend-sheet-4: the official PDF after "Approve without PDF"', () => {
  async function approveWithoutPdf() {
    pdf.wait = vi.fn(async () => failPdf())
    render(<MatchEnd matchId={1} />)
    await settle()
    await waitFor(() => expect(approveButton()).toBeEnabled())
    fireEvent.click(approveButton())
    fireEvent.click(await findButton(en.matchEnd.export.approveWithoutPdf))
    await findButton(en.matchEnd.closeMatch)
  }

  it('the approved view says the PDF is missing and creates and queues it', async () => {
    seed(SIGNED)
    await approveWithoutPdf()
    expect(row().scoresheetPdfMissing).toBe(true)
    expect(jobs().filter(j => j.resource === 'scoresheet').map(j => j.payload.contentType)).toEqual(['application/json'])
    expect(await screen.findByTestId('matchend-pdf-missing')).toBeInTheDocument()
    pdf.wait = vi.fn(async () => ({ blob: new Blob(['%PDF-1.4'], { type: 'application/pdf' }), filename: 'sheet.pdf' }))
    fireEvent.click(getButton(en.matchEnd.pdfMissing.create))
    await waitFor(() => expect(row().scoresheetPdfMissing).toBe(false))
    const uploads = jobs().filter(j => j.resource === 'scoresheet')
    expect(uploads.map(j => [j.status, j.payload.contentType])).toEqual([['queued', 'application/json'], ['queued', 'application/pdf']])
    expect(uploads[1].payload).toMatchObject({ match_external_id: SEED })
    expect(uploads[1].payload.path).toMatch(/\/game4711_[^/]+\.pdf$/)
    await waitFor(() => expect(screen.queryByTestId('matchend-pdf-missing')).toBeNull())
  })

  it('Close match asks while no PDF is queued; declined keeps the match here', async () => {
    seed(SIGNED)
    await approveWithoutPdf()
    confirm.answer = false
    fireEvent.click(getButton(en.matchEnd.closeMatch))
    await waitFor(() => expect(confirm.calls.map(c => c.title)).toEqual([en.matchEnd.pdfMissing.closeTitle]))
    await settle()
    expect(row()).toBeTruthy()
    expect(jobs().some(j => j.payload?.status === 'final')).toBe(false)
  })

  it('a PDF that came with the approval: no notice, Close match asks nothing', async () => {
    seed(SIGNED)
    render(<MatchEnd matchId={1} />)
    await settle()
    await waitFor(() => expect(approveButton()).toBeEnabled())
    fireEvent.click(approveButton())
    await findButton(en.matchEnd.closeMatch)
    await settle()
    expect(row().scoresheetPdfMissing).toBe(false)
    expect(screen.queryByTestId('matchend-pdf-missing')).toBeNull()
  })

  it('after Reopen match of an unsent approval the old approval\'s PDF is not sent', async () => {
    seed({ ...SIGNED, approved: true })
    store.tables.sync_queue.set(900, { id: 900, resource: 'match', action: 'update', status: 'queued', payload: { id: SEED, status: 'approved', current_set: null } })
    store.tables.sync_queue.set(901, { id: 901, resource: 'scoresheet', action: 'upload', status: 'queued', payload: { path: '2026-11-07/game4711_kaaaa.pdf', file: new Blob(['%PDF-1.4 OLD']), contentType: 'application/pdf', match_external_id: SEED } })
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false })
    render(<MatchEnd matchId={1} />)
    await settle()
    fireEvent.click(await findButton(en.matchEnd.reopenMatch))
    await waitFor(() => expect(row().approved).toBe(false))
    expect(store.tables.sync_queue.get(901).status).toBe('superseded')
  })
})

describe('logic-scoresheet-pdf-1: the sheet\'s consistency warnings', () => {
  const PARTIAL = [
    { id: 1, type: 'point', setIndex: 1, seq: 1, payload: { team: 'home' } },
    { id: 2, type: 'point', setIndex: 1, seq: 2, payload: { team: 'home' } },
    { id: 3, type: 'point', setIndex: 1, seq: 3, payload: { team: 'away' } }
  ]

  it('are shown at the match end and the approval asks first; declined, nothing is approved', async () => {
    seed(SIGNED, { events: PARTIAL })
    confirm.answer = false
    render(<MatchEnd matchId={1} />)
    const box = await screen.findByTestId('matchend-sheet-warnings')
    expect(box.textContent).toContain('do not match the set score')
    await waitFor(() => expect(approveButton()).toBeEnabled())
    fireEvent.click(approveButton())
    await waitFor(() => expect(confirm.calls.map(c => c.title)).toEqual([en.matchEnd.sheetWarnings.confirmTitle]))
    await settle()
    expect(opened).toHaveLength(0)
    expect(row().approved).toBeFalsy()
  })

  it('confirmed, the approval goes ahead', async () => {
    seed(SIGNED, { events: PARTIAL })
    render(<MatchEnd matchId={1} />)
    await screen.findByTestId('matchend-sheet-warnings')
    await waitFor(() => expect(approveButton()).toBeEnabled())
    fireEvent.click(approveButton())
    await findButton(en.matchEnd.closeMatch)
    expect(row().approved).toBe(true)
  })
})

describe('fe-home-options-5: a finished set at an impossible score', () => {
  it('blocks Confirm and approve and says why', async () => {
    const sets = [SETS[0], SETS[1], { ...SETS[2], homePoints: 24, awayPoints: 19 }]
    seed(SIGNED, { sets })
    render(<MatchEnd matchId={1} />)
    const box = await screen.findByTestId('matchend-result-issues')
    expect(box.textContent).toContain('Set 3 ended 24:19: not a possible final score.')
    await settle()
    expect(approveButton()).toBeDisabled()
  })
})

describe('fe-home-options-2: corrections after the match on the sheet', () => {
  it('are listed in REMARKS as "Corrected after the match"', async () => {
    seed({
      manualChanges: [
        { ts: '2026-11-09T20:10:00Z', category: 'correction', action: 'addTimeout', text: 'Added: Time-out, Team B, set 2', afterMatch: true },
        { ts: '2026-11-09T19:10:00Z', category: 'correction', action: 'addTimeout', text: 'Added during the match' }
      ]
    })
    render(<MatchEnd matchId={1} />)
    await waitFor(() => expect(screen.getAllByTestId('matchend-generated-remark').map(n => n.textContent))
      .toEqual(['Corrected after the match: Added: Time-out, Team B, set 2']))
    expect(queryAllButtons(en.matchEnd.approveParams)).toHaveLength(1)
  })
})
