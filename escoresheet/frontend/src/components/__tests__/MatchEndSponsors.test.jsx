/**
 * Sponsors on clothing at the match end (owner 2026-11-15): each team's box
 * while the option is on (or the match is marked); a marked match shows
 * (+) / (-) after the team names, whatever this device's option says; a
 * change after a post-match signature clears the signatures, as any change of
 * the sheet does. (Harness from MatchEndPostMatchChanges.test.jsx.)
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

const SEED = 'match_sponsors_1'
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
  pdf.wait = vi.fn(async () => ({ blob: new Blob(['%PDF-1.4'], { type: 'application/pdf' }), filename: 'sheet.pdf' }))
  URL.createObjectURL = vi.fn(() => 'blob:x')
  HTMLAnchorElement.prototype.click = () => {}
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true })
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => { cleanup() })

const box = (team) => screen.queryByTestId(`matchend-sponsors-${team}`)
const infoJobs = () => jobs().filter(j => j.resource === 'match' && j.payload?.match_info)

describe('match end: sponsors on clothing', () => {
  beforeEach(() => localStorage.removeItem('sponsorsOnClothing'))
  afterEach(() => localStorage.removeItem('sponsorsOnClothing'))

  it('option off and an unmarked match: no boxes and no marks', async () => {
    render(<MatchEnd matchId={1} />)
    await settle()
    await screen.findByTestId('signature-slot-captain-a')
    expect(screen.queryByTestId('matchend-sponsors')).toBeNull()
    expect(document.body.textContent).not.toContain('(+)')
    expect(document.body.textContent).not.toContain('(-)')
  })

  it('option on: a tick marks the match, shows the marks and sends match_info', async () => {
    localStorage.setItem('sponsorsOnClothing', 'true')
    render(<MatchEnd matchId={1} />)
    await settle()
    expect(await screen.findByTestId('matchend-sponsors')).toBeTruthy()
    expect(box('home')).not.toBeChecked()
    fireEvent.click(box('home'))
    await waitFor(() => expect(row()).toMatchObject({ homeSponsors: true, sponsorsMarked: true }))
    await waitFor(() => expect(box('home')).toBeChecked())
    expect(document.body.textContent).toContain('Home V (+)')
    expect(document.body.textContent).toContain('Away V (-)')
    expect(confirm.calls).toHaveLength(0)
    expect(infoJobs().at(-1).payload.match_info).toMatchObject({ sponsors_home: true, sponsors_away: false, sponsors_marked: true })
  })

  it('the match decides: a marked match shows its marks and boxes with the option off here', async () => {
    seed({ homeSponsors: false, awaySponsors: true, sponsorsMarked: true })
    render(<MatchEnd matchId={1} />)
    await settle()
    expect(await screen.findByTestId('matchend-sponsors')).toBeTruthy()
    expect(box('away')).toBeChecked()
    expect(document.body.textContent).toContain('Home V (-)')
    expect(document.body.textContent).toContain('Away V (+)')
  })

  it('after the signatures: asks, then clears them and logs the change after the match', async () => {
    localStorage.setItem('sponsorsOnClothing', 'true')
    seed(SIGNED)
    render(<MatchEnd matchId={1} />)
    await settle()
    fireEvent.click(await screen.findByTestId('matchend-sponsors-away'))
    await waitFor(() => expect(row().awaySponsors).toBe(true))
    expect(confirm.calls.map(c => c.title)).toEqual([en.matchEnd.signedSheetChange.title])
    expect(row().ref1Signature).toBeNull()
    expect(row().homePostGameCaptainSignature).toBeNull()
    expect(row().manualChanges.at(-1)).toMatchObject({ action: 'editSponsors', afterMatch: true, before: '(-)', after: '(+)' })
    expect(infoJobs().at(-1).payload.match_info).toMatchObject({ sponsors_away: true, sponsors_marked: true })
  })

  it('declined after the signatures: nothing changes', async () => {
    localStorage.setItem('sponsorsOnClothing', 'true')
    seed(SIGNED)
    confirm.answer = false
    render(<MatchEnd matchId={1} />)
    await settle()
    fireEvent.click(await screen.findByTestId('matchend-sponsors-away'))
    await waitFor(() => expect(confirm.calls).toHaveLength(1))
    await settle()
    expect(row().awaySponsors).toBeUndefined()
    expect(row().ref1Signature).toBe('data:ref1')
    expect(jobs()).toHaveLength(0)
  })
})
