/**
 * MatchEnd and Sign on phone (docs/qr-signing-spec.md 5.6, 8.5): a phone
 * signature lands in the right field of every slot (A / B by the coin toss)
 * with its "signed on phone" record in the same update, a later drawing
 * clears the record, the slot shows where it was signed, the pad gets the
 * slot's context, and a stale account approval is dropped as for a drawing.
 * SignaturePad is mocked: its phone / draw buttons call onSave as it does.
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
const pad = vi.hoisted(() => ({ phone: null }))
vi.mock('../SignaturePad', () => ({
  default: ({ open, onSave, title, phone }) => {
    if (!open) return null
    pad.phone = phone
    return (
      <div>
        <button type="button" onClick={() => onSave('data:image/png;base64,PHONE', { source: 'phone', transport: 'cloud' })}>phone {title}</button>
        <button type="button" onClick={() => onSave('data:image/png;base64,SIG', { source: 'device' })}>draw {title}</button>
      </div>
    )
  }
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
    // store.beforeAdd: a test holds (or fails) an add, as a slow tablet would
    add: async (row) => {
      if (store.beforeAdd) await store.beforeAdd(name, row)
      const id = row?.id ?? store.nextId++; rowsOf(name).set(id, { ...row, id }); changed(); return id
    },
    // Dexie key paths ('signatureSources.scorerSignature') set nested values
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

const SEED = 'match_1_phone'
const SETS = [
  { id: 11, matchId: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true },
  { id: 12, matchId: 1, index: 2, homePoints: 25, awayPoints: 22, finished: true },
  { id: 13, matchId: 1, index: 3, homePoints: 25, awayPoints: 18, finished: true }
]

// The signing order: captains, then the assistant scorer, the scorer, the referees
const BEFORE_SCORER = { homePostGameCaptainSignature: 'data:cap-a', awayPostGameCaptainSignature: 'data:cap-b', asstScorerSignature: 'data:asst' }

function seed(matchOver = {}) {
  store.tables = {}
  store.nextId = 500
  store.tables.matches = new Map([[1, {
    id: 1, seed_key: SEED, status: 'ended', test: false, coinTossTeamA: 'home', homeTeamId: 1, awayTeamId: 2, gameNumber: 4711, gamePin: '987654',
    officials: [
      { role: '1st referee', firstName: 'Anna', lastName: 'Muster' },
      { role: '2nd referee', firstName: 'Ben', lastName: 'Beispiel' },
      { role: 'scorer', firstName: 'Sam', lastName: 'Scorer' },
      { role: 'assistant scorer', firstName: 'Ada', lastName: 'Assist' }
    ],
    ...matchOver
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
const slot = (role) => screen.getByTestId(`signature-slot-${role}`)
const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 20)))

async function signVia(role, how) {
  await settle()
  fireEvent.click(await within(await screen.findByTestId(`signature-slot-${role}`)).findByText(en.matchEnd.tapToSign))
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${how} `) }))
  await settle()
}

beforeEach(() => {
  seed()
  logs.calls = []
  alerts.showAlert = vi.fn()
  asked.fn = vi.fn(async () => true)
  api.list = vi.fn(async () => ({ data: { match: { status: 'ended', closed_at: null, result_key: null }, approvals: [] }, error: null, status: 200 }))
  api.approve = vi.fn()
  api.undo = vi.fn()
  pad.phone = null
  store.beforeAdd = null
  auth.value = { user: { id: 'u-scorer', email: 'scorer@club.ch' }, access: { roles: ['scorer'], isAdmin: false } }
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true })
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const FIELDS = {
  'captain-a': 'homePostGameCaptainSignature',
  'captain-b': 'awayPostGameCaptainSignature',
  'asst-scorer': 'asstScorerSignature',
  scorer: 'scorerSignature',
  ref2: 'ref2Signature',
  ref1: 'ref1Signature'
}

describe('MatchEnd: Sign on phone', () => {
  it('a phone signature lands in the field of each of the six slots, with its record', async () => {
    render(<MatchEnd matchId={1} />)
    for (const [role, field] of Object.entries(FIELDS)) {
      await signVia(role, 'phone')
      await waitFor(() => expect(row()[field]).toBe('data:image/png;base64,PHONE'))
      expect(row().signatureSources[field]).toMatchObject({ via: 'phone', transport: 'cloud' })
      expect(Date.parse(row().signatureSources[field].at)).not.toBeNaN()
    }
    // Every slot shows that it was signed on a phone
    for (const role of Object.keys(FIELDS)) {
      expect(within(slot(role)).getByTestId(`signed-on-phone-${role}`)).toHaveAttribute('title', en.phoneSign.signedOnPhone)
    }
  }, 30000)

  it('captain A / B follow the coin toss', async () => {
    seed({ coinTossTeamA: 'away' })
    render(<MatchEnd matchId={1} />)
    await signVia('captain-a', 'phone')
    await waitFor(() => expect(row().awayPostGameCaptainSignature).toBe('data:image/png;base64,PHONE'))
    expect(row().homePostGameCaptainSignature).toBeUndefined()
    expect(row().signatureSources).toEqual({ awayPostGameCaptainSignature: expect.objectContaining({ via: 'phone' }) })
    // ... and the phone page names the away team as A, with its captain
    expect(pad.phone).toMatchObject({
      slot: 'captain-a',
      matchKey: SEED,
      gamePin: '987654',
      context: { home: 'Home V', away: 'Away V', matchNo: '4711', teamSide: 'away', teamLabel: 'A', name: '#9 Mia Meier', lang: 'en' }
    })
  })

  it('a drawn signature records no phone, and replaces a phone record', async () => {
    seed({ ...BEFORE_SCORER, scorerSignature: null, signatureSources: { scorerSignature: { via: 'phone', transport: 'lan', at: '2026-10-07T20:00:00.000Z' } } })
    render(<MatchEnd matchId={1} />)
    await signVia('scorer', 'draw')
    await waitFor(() => expect(row().scorerSignature).toBe('data:image/png;base64,SIG'))
    expect(row().signatureSources.scorerSignature).toBeNull()
    expect(within(slot('scorer')).queryByTestId('signed-on-phone-scorer')).toBeNull()
  })

  it('the officials\' pads get their slot and name', async () => {
    seed({ ...BEFORE_SCORER, scorerSignature: 'data:scorer', ref2Signature: 'data:ref2' })
    render(<MatchEnd matchId={1} />)
    await settle()
    fireEvent.click(await within(slot('ref1')).findByText(en.matchEnd.tapToSign))
    await screen.findByRole('button', { name: /^phone / })
    expect(pad.phone).toMatchObject({ slot: 'ref1', context: { home: 'Home V', away: 'Away V', name: 'Anna Muster' } })
    expect(pad.phone.context.teamSide).toBeUndefined()
  })

  it('a phone signature drops a stale account approval, as a drawn one does', async () => {
    const stale = { id: 'stale-uuid', short_id: 'A1B2C3D4', slot: 'scorer', name: 'Scorer Sam', approved_at: '2026-10-07T19:00:00.000Z', result_key: 'ov-result-v1|1:25:20', result_matches: false }
    api.list = vi.fn(async () => ({ data: { match: { status: 'ended', closed_at: null, result_key: null }, approvals: [stale] }, error: null, status: 200 }))
    seed(BEFORE_SCORER)
    render(<MatchEnd matchId={1} />)
    await waitFor(() => expect(row().accountApprovals?.scorer?.id).toBe('stale-uuid'))
    await settle()
    fireEvent.click(await within(slot('scorer')).findByTestId('account-approval-stale-scorer'))
    fireEvent.click(await screen.findByRole('button', { name: /^phone / }))
    await waitFor(() => expect(row().scorerSignature).toBe('data:image/png;base64,PHONE'))
    await waitFor(() => expect(row().accountApprovals?.scorer).toBeUndefined())
  })
})

// The match-end signature edits (Re-sign / Clear, domain/signatureEdits.js):
// one writer (writeSignature) for a drawing, a phone result and a Clear
describe('MatchEnd: Sign on phone with Re-sign and Clear', () => {
  const matchJobs = () => [...store.tables.sync_queue.values()].filter(j => j.resource === 'match' && j.payload?.signatures)
  const PHONE_SRC = { via: 'phone', transport: 'lan', at: '2026-10-07T20:00:00.000Z' }

  it('a phone result is saved at once and queued for the cloud, like a drawing', async () => {
    seed({ ...BEFORE_SCORER, homeCoachSignature: 'data:coach' })
    render(<MatchEnd matchId={1} />)
    await signVia('scorer', 'phone')
    await waitFor(() => expect(row().scorerSignature).toBe('data:image/png;base64,PHONE'))
    const job = matchJobs().at(-1)
    expect(job).toBeTruthy()
    expect(job.payload.id).toBe(SEED)
    expect(job.payload.signatures).toMatchObject({ scorer: 'data:image/png;base64,PHONE', home_coach: 'data:coach', asst_scorer: 'data:asst' })
  })

  it('Clear empties the image AND its phone record, then the pad offers the phone again', async () => {
    seed({ ...BEFORE_SCORER, scorerSignature: 'data:old', signatureSources: { scorerSignature: PHONE_SRC } })
    render(<MatchEnd matchId={1} />)
    await settle()
    expect(within(slot('scorer')).getByTestId('signed-on-phone-scorer')).toBeInTheDocument()
    fireEvent.click(await screen.findByTestId('signature-clear-scorer'))
    await waitFor(() => expect(row().scorerSignature).toBeNull())
    expect(row().signatureSources.scorerSignature).toBeNull()
    expect(matchJobs().at(-1).payload.signatures.scorer).toBeNull()
    // The pad Clear opens has "Sign on phone": signing there sets the record again
    fireEvent.click(await screen.findByRole('button', { name: /^phone / }))
    expect(pad.phone).toMatchObject({ slot: 'scorer', locked: false })
    await waitFor(() => expect(row().scorerSignature).toBe('data:image/png;base64,PHONE'))
    expect(row().signatureSources.scorerSignature).toMatchObject({ via: 'phone', transport: 'cloud' })
  })

  it('Re-sign on the phone records the phone; Re-sign on this device resets it', async () => {
    seed({ ...BEFORE_SCORER, scorerSignature: 'data:old' })
    render(<MatchEnd matchId={1} />)
    await settle()
    fireEvent.click(await screen.findByTestId('signature-resign-scorer'))
    fireEvent.click(await screen.findByRole('button', { name: /^phone / }))
    await waitFor(() => expect(row().scorerSignature).toBe('data:image/png;base64,PHONE'))
    expect(row().signatureSources.scorerSignature).toMatchObject({ via: 'phone' })
    await settle()
    fireEvent.click(await screen.findByTestId('signature-resign-scorer'))
    fireEvent.click(await screen.findByRole('button', { name: /^draw / }))
    await waitFor(() => expect(row().scorerSignature).toBe('data:image/png;base64,SIG'))
    expect(row().signatureSources.scorerSignature).toBeNull()
    expect(within(slot('scorer')).queryByTestId('signed-on-phone-scorer')).toBeNull()
  })

  it('a locked match (closed or final) opens no pad, so no phone session; an approved one shows no boxes', async () => {
    // approved: the approved view (from the match row), no signature boxes at all
    seed({ ...BEFORE_SCORER, approved: true })
    const approvedView = render(<MatchEnd matchId={1} />)
    await screen.findByRole('button', { name: en.matchEnd.closeMatch })
    expect(screen.queryByTestId('signature-slot-scorer')).toBeNull()
    expect(screen.queryByTestId('signature-resign-captain-a')).toBeNull()
    approvedView.unmount()

    for (const lock of [{ closed_at: '2026-10-07T20:00:00Z' }, { status: 'final' }]) {
      seed({ ...BEFORE_SCORER, ...lock })
      const view = render(<MatchEnd matchId={1} />)
      await settle()
      fireEvent.click(await within(await screen.findByTestId('signature-slot-scorer')).findByText(en.matchEnd.tapToSign))
      await settle()
      expect(screen.queryByRole('button', { name: /^phone / })).toBeNull()
      expect(pad.phone).toBeNull()
      expect(screen.getByTestId('signature-resign-captain-a')).toBeDisabled()
      view.unmount()
    }
  })

  // A slow tablet: the signature is on the match row (the next box opens)
  // while its sync job is not queued yet, and the next box's pad is tapped
  // open in between. The end of the previous save closes its own slot's pad
  // only (OpenBeach f573c46, a full-suite flake at load 40, 2026-10-08).
  // held: resolves the held add, or rejects it (the save then fails)
  async function nextPadOpenDuringSave(settleHeld) {
    seed()
    let release
    let held = false
    store.beforeAdd = async (name) => {
      if (name !== 'sync_queue' || held) return
      held = true
      await new Promise((resolve, reject) => { release = { resolve, reject } })
    }
    render(<MatchEnd matchId={1} />)
    await signVia('captain-a', 'phone')
    await waitFor(() => expect(row().homePostGameCaptainSignature).toBe('data:image/png;base64,PHONE'))
    await waitFor(() => expect(release).toBeTruthy())
    // the save of A still running: B's box is open, its pad is tapped open
    fireEvent.click(await within(slot('captain-b')).findByText(en.matchEnd.tapToSign))
    expect(await screen.findByRole('button', { name: /^phone .*Captain B/ })).toBeInTheDocument()
    await act(async () => { settleHeld(release) })
    await settle()
    await act(async () => { await new Promise(r => setTimeout(r, 1600)) })
    return screen.queryByRole('button', { name: /^phone .*Captain B/ })
  }

  it('the next box tapped while the last signature is still being queued: its pad stays open', async () => {
    const padB = await nextPadOpenDuringSave(release => release.resolve())
    expect(matchJobs()).toHaveLength(1)
    expect(padB).toBeInTheDocument()
  })

  it('the last signature\'s queueing fails while the next pad is open: that pad stays open', async () => {
    const padB = await nextPadOpenDuringSave(release => release.reject(new Error('quota (test)')))
    expect(matchJobs()).toHaveLength(0)
    expect(padB).toBeInTheDocument()
  })

  it('locked while the pad is open: "Sign on phone" is locked and a late phone result is not written', async () => {
    seed(BEFORE_SCORER)
    render(<MatchEnd matchId={1} />)
    await settle()
    fireEvent.click(await within(slot('scorer')).findByText(en.matchEnd.tapToSign))
    await screen.findByRole('button', { name: /^phone / })
    expect(pad.phone.locked).toBe(false)
    // Approved meanwhile (another device, the live query reloads)
    await act(async () => {
      store.tables.matches.set(1, { ...row(), approved: true })
      for (const l of [...store.listeners]) l()
    })
    await waitFor(() => expect(pad.phone.locked).toBe(true))
    expect(pad.phone.lockedReason).toBe(en.matchEnd.signatureLocked)
    fireEvent.click(screen.getByRole('button', { name: /^phone / }))
    await settle()
    expect(row().scorerSignature).toBeUndefined()
    expect(row().signatureSources).toBeUndefined()
    expect(matchJobs()).toHaveLength(0)
  })
})
