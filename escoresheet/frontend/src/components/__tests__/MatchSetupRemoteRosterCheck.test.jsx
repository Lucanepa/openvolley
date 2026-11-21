/**
 * Match Setup's Remote panel as a "refresh from the server" (owner
 * 21.11.2026: "in case the roster has to be reuploaded etc, why can't we have
 * a 'refresh' button here so that it looks for rosters on the server"):
 *  - the button says what it does ("Check server for rosters"), with a
 *    refresh icon, and the panel says when it last asked ("Last checked
 *    14:32", "Not checked yet", "Offline");
 *  - while the panel is open it asks by itself every 30 s and when the
 *    device is online again, silently (no "no roster" message), never
 *    offline, and not once the panel closes;
 *  - an upload made again after Accept is offered as "A new version of the
 *    roster is available", never filled in by itself; the version accepted
 *    is not offered again, also before the server's copy is cleared;
 *  - a roster sent again from the manager page after it was used: its card
 *    says it is a new version, and nothing is filled in without the tap.
 * Harness as MatchSetupSentRosterRefresh.test.jsx (in-memory Dexie stand-in,
 * useLiveQuery run once per deps change); the interval and the clock are
 * fake, setTimeout stays real (Testing Library waits with it). Made-up names.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // the key, with the time and team it was given (the line and the toasts say them)
    t: (key, opts) => (typeof opts === 'string' ? opts : [key, opts?.time, opts?.team].filter(Boolean).join(' ')),
    i18n: { language: 'en', changeLanguage: () => Promise.resolve() }
  })
}))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn(), showConfirm: vi.fn() }) }))
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-scorer-1' }, profile: null, getCachedProfile: () => null, access: { canReadTeams: true, canManageTeams: false } })
}))
vi.mock('../../lib/accountApi', async (orig) => ({
  ...(await orig()),
  markGameRosterUsed: async () => ({ data: { used: true }, error: null, status: 200 }),
  fetchGameRosters: async () => ({ data: { rosters: [], games: [] }, error: null, status: 200 })
}))

// A live query runs again when the matches or the sent rosters change, as
// Dexie's does (a card appears when a check stores what it found)
const live = vi.hoisted(() => ({ subs: new Set(), notify (name) { if (name === 'matches' || name === 'game_rosters') for (const f of [...live.subs]) f() } }))
vi.mock('dexie-react-hooks', async () => {
  const React = await import('react')
  return {
    useLiveQuery: (fn, deps = []) => {
      const [value, setValue] = React.useState(undefined)
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => {
        const f = () => setTick((n) => n + 1)
        live.subs.add(f)
        return () => { live.subs.delete(f) }
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

const store = vi.hoisted(() => ({ tables: {}, nextId: 1, writes: [] }))
vi.mock('../../db/db', () => {
  const rowsOf = (name) => (store.tables[name] ||= new Map())
  const collection = (rows, name) => {
    const c = {
      equals: () => c, above: () => c, below: () => c, anyOf: () => c, between: () => c,
      filter: () => c, and: () => c, reverse: () => c, limit: () => c, offset: () => c,
      toArray: async () => rows, sortBy: async () => rows, first: async () => rows[0],
      last: async () => rows[rows.length - 1], count: async () => rows.length,
      modify: async () => 0, each: async () => {}, primaryKeys: async () => [],
      delete: async () => {
        const map = rowsOf(name)
        for (const [k, v] of [...map.entries()]) if (rows.includes(v)) map.delete(k)
        return rows.length
      }
    }
    return c
  }
  const table = (name) => ({
    get: async (id) => rowsOf(name).get(id),
    add: async (row) => { const id = row?.id ?? store.nextId++; rowsOf(name).set(id, { ...row, id }); live.notify(name); return id },
    put: async (row) => { const id = row?.key ?? row?.id ?? store.nextId++; rowsOf(name).set(id, { ...row, id }); live.notify(name); return id },
    bulkAdd: async (rows) => { for (const r of rows) await table(name).add(r) },
    bulkPut: async (rows) => { for (const r of rows) await table(name).put(r) },
    update: async (id, changes) => {
      const r = rowsOf(name).get(id)
      if (!r) return 0
      store.writes.push({ name, id, changes })
      const next = { ...r }
      for (const [k, v] of Object.entries(changes)) {
        if (k.includes('.')) { const [a, b] = k.split('.'); next[a] = { ...(next[a] || {}), [b]: v } } else next[k] = v
      }
      rowsOf(name).set(id, next)
      live.notify(name)
      return 1
    },
    delete: async (id) => { rowsOf(name).delete(id); live.notify(name) },
    toArray: async () => [...rowsOf(name).values()],
    count: async () => rowsOf(name).size,
    where: (field) => ({ equals: (v) => collection([...rowsOf(name).values()].filter((r) => r[field] === v), name) }),
    orderBy: () => collection([], name),
    filter: () => collection([], name),
    clear: async () => rowsOf(name).clear(),
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

// The server: the match row's connections (the team's upload), counted per ask
const server = vi.hoisted(() => ({ connections: {}, asks: 0, fail: false }))
vi.mock('../../lib/apiClient', () => {
  const chain = (table) => {
    const call = { table, select: null }
    const b = new Proxy({}, {
      get: (_, prop) => {
        if (prop === 'then') {
          return (resolve) => {
            if (call.table === 'matches' && call.select === 'connections') {
              server.asks++
              if (server.fail) return Promise.resolve({ data: null, error: { message: 'unreachable', status: 0 } }).then(resolve)
              return Promise.resolve({ data: { connections: server.connections }, error: null }).then(resolve)
            }
            return Promise.resolve({ data: null, error: null }).then(resolve)
          }
        }
        if (prop === 'select') return (cols) => { call.select = cols; return b }
        return () => b
      }
    })
    return b
  }
  return {
    apiFrom: (table) => chain(table),
    apiStorage: { from: () => chain('storage') },
    AUTH_TOKEN_CHANGE_EVENT: 'ov-test-auth-token-change',
    AUTH_TOKEN_STORAGE_KEY: 'api_auth_token',
    apiMatchRestore: () => chain('restore'),
    apiMatchClaim: () => chain('claim')
  }
})
vi.mock('../../utils/logger', () => ({ uploadBackupToCloud: vi.fn(), uploadLogsToCloud: vi.fn() }))
vi.mock('../../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() }))
vi.mock('../../db/rememberedPlayers', () => ({ rememberedRosters: async () => [] }))
const toasts = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('../../ui', async (orig) => { const ui = await orig(); return { ...ui, confirmDialog: async () => true, toast: { ...ui.toast, ...toasts } } })
const refresh = vi.hoisted(() => ({ calls: [], answer: null }))
vi.mock('../../db/gameRosters', async (orig) => ({
  ...(await orig()),
  refreshGameRosters: vi.fn(async (args) => { refresh.calls.push(args); refresh.answer?.(); return 'refreshed' })
}))
vi.mock('../SignaturePad', () => ({ default: () => null }))

import MatchSetup from '../MatchSetup'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { REMOTE_PANEL_CHECK_MS } from '../../hooks/useSentRosterRefresh'
import { sentRosterFingerprint, takenAfter } from '../../domain/rosterVersions'

const Setup = (props) => <ScaleProvider><MatchSetup onStart={() => {}} onReturn={() => {}} {...props} /></ScaleProvider>
const stored = () => store.tables.matches.get(1)
// 13:32 UTC = 14:32 in Zürich (winter time)
const START = new Date('2026-11-21T13:32:10.000Z')

const upload = (timestamp, lastName = 'Upload') => ({
  players: [
    { number: 4, firstName: 'Anna', lastName, dob: '', libero: '', isCaptain: true, isLfp: false },
    { number: 9, firstName: 'Eva', lastName, dob: '', libero: 'libero1', isCaptain: false, isLfp: false }
  ],
  bench: [{ role: 'Coach', firstName: 'Hans', lastName, dob: '' }],
  coachSignature: null,
  captainSignature: null,
  timestamp
})
const V1 = upload('2026-11-21T13:00:00.000Z')
const V2 = upload('2026-11-21T13:40:00.000Z', 'Again')

function storeMatch (extra = {}) {
  store.tables.matches = new Map([[1, {
    id: 1, status: 'setup', seed_key: 'match_1_check', matchInfoConfirmedAt: '2026-11-21T12:00:00Z',
    homeTeamId: 11, awayTeamId: 12, homeName: 'Home V', awayName: 'Away V', homeShortName: 'HOM', awayShortName: 'AWA',
    scheduledAt: '2026-11-21T19:30:00.000Z', game_n: 991701, gameNumber: '991701', league: '3L', hall: 'Hall A', city: 'Town', bestOf: 5,
    gamePin: '654321', remarks: '', refereePin: '111111', homeTeamPin: '222222', awayTeamPin: '333333', homeTeamUploadPin: '444444', awayTeamUploadPin: '555555',
    bench_home: [{ role: 'Coach', firstName: 'Carla', lastName: 'Coach' }],
    bench_away: [{ role: 'Coach', firstName: 'Dora', lastName: 'Trainer' }],
    ...extra
  }]])
  store.tables.teams = new Map([[11, { id: 11, name: 'Home V' }], [12, { id: 12, name: 'Away V' }]])
  store.tables.players = new Map([
    [201, { id: 201, teamId: 11, number: 1, lastName: 'Hall', firstName: 'H', isCaptain: true }],
    [301, { id: 301, teamId: 12, number: 3, lastName: 'Kilo', firstName: 'K', isCaptain: true }]
  ])
}
const pendingWrites = () => store.writes.filter((w) => w.name === 'matches' && 'pendingHomeRoster' in w.changes)
const setOnline = (online) => {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online })
  window.dispatchEvent(new Event(online ? 'online' : 'offline'))
}
// the next 30 s of the panel, and the checks it starts
const nextPanelCheck = async () => {
  await act(async () => { vi.advanceTimersByTime(REMOTE_PANEL_CHECK_MS) })
}

async function openRemote (side = 'home') {
  fireEvent.click((await screen.findAllByRole('button', { name: 'matchSetup.editRoster' }))[side === 'home' ? 0 : 1])
  fireEvent.click(await screen.findByRole('radio', { name: 'matchSetup.remote' }))
  return screen.findByTestId(`check-server-roster-${side}`)
}

beforeEach(() => {
  live.subs.clear()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(START)
  store.tables = {}
  store.nextId = 100
  store.writes = []
  server.connections = {}
  server.asks = 0
  server.fail = false
  refresh.calls = []
  refresh.answer = null
  for (const f of Object.values(toasts)) f.mockClear()
  setOnline(true)
  globalThis.ResizeObserver ||= class { observe () {} unobserve () {} disconnect () {} }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  setOnline(true)
})

describe('the Remote panel checks the server', () => {
  it('says what the button does and when it last asked: at once, then every 30 s, silently', async () => {
    storeMatch()
    render(<Setup matchId={1} />)
    const button = await openRemote()
    expect(button).toHaveTextContent('matchSetup.rosterCheck.button')
    expect(button.querySelector('svg')).not.toBeNull() // the refresh icon
    expect(screen.getByTestId('search-roster-hint-home')).toHaveTextContent('matchSetup.rosterCheck.hint')
    // the panel asked as it opened: the time of that check
    await waitFor(() => expect(screen.getByTestId('roster-check-status-home')).toHaveTextContent('matchSetup.rosterCheck.lastChecked 14:32'))
    expect(server.asks).toBe(1)
    expect(refresh.calls.at(-1)).toMatchObject({ games: ['991701'] })
    // nothing found: no message (only a tap says "no roster")
    expect(screen.queryByText(/noRosterFound/)).toBeNull()

    vi.setSystemTime(new Date('2026-11-21T13:33:20.000Z'))
    await nextPanelCheck()
    await waitFor(() => expect(screen.getByTestId('roster-check-status-home')).toHaveTextContent('matchSetup.rosterCheck.lastChecked 14:33'))
    expect(server.asks).toBe(2)
    expect(screen.queryByText(/noRosterFound/)).toBeNull()
    expect(toasts.info).not.toHaveBeenCalled()

    // a tap asks now and, with nothing anywhere, says so
    fireEvent.click(button)
    expect(await screen.findByText('matchSetup.noRosterFoundAnywhere')).toBeInTheDocument()
    expect(server.asks).toBe(3)
  })

  it('"Not checked yet" before the first answer; "Server not reached" when it fails', async () => {
    storeMatch()
    server.fail = true
    render(<Setup matchId={1} />)
    await openRemote()
    await waitFor(() => expect(screen.getByTestId('roster-check-status-home')).toHaveTextContent('matchSetup.rosterCheck.failed'))
    expect(screen.getByTestId('roster-check-status-home')).not.toHaveTextContent('lastChecked')
    expect(screen.queryByText('matchSetup.errorSearchingRoster')).toBeNull() // silent
    server.fail = false
    await nextPanelCheck()
    await waitFor(() => expect(screen.getByTestId('roster-check-status-home')).toHaveTextContent('matchSetup.rosterCheck.lastChecked 14:32'))
  })

  it('offline: says so and does not ask; back online it asks at once', async () => {
    storeMatch()
    setOnline(false)
    render(<Setup matchId={1} />)
    await openRemote()
    await waitFor(() => expect(screen.getByTestId('roster-check-status-home')).toHaveTextContent('matchSetup.rosterCheck.offline'))
    await nextPanelCheck()
    await nextPanelCheck()
    expect(server.asks).toBe(0)
    act(() => setOnline(true))
    await waitFor(() => expect(server.asks).toBe(1))
    // (a minute of fake clock went by offline)
    await waitFor(() => expect(screen.getByTestId('roster-check-status-home')).toHaveTextContent('matchSetup.rosterCheck.lastChecked 14:33'))
  })

  it('stops when the panel closes (Local) and when Match Setup goes', async () => {
    storeMatch()
    const { unmount } = render(<Setup matchId={1} />)
    await openRemote()
    await waitFor(() => expect(server.asks).toBe(1))
    fireEvent.click(screen.getByRole('radio', { name: 'matchSetup.local' }))
    await nextPanelCheck()
    await nextPanelCheck()
    expect(server.asks).toBe(1)
    fireEvent.click(screen.getByRole('radio', { name: 'matchSetup.remote' }))
    await waitFor(() => expect(server.asks).toBe(2))
    unmount()
    await nextPanelCheck()
    expect(server.asks).toBe(2)
  })

  it('a new upload while the panel is open: its card appears with a toast, once', async () => {
    storeMatch()
    render(<Setup matchId={1} />)
    await openRemote()
    await waitFor(() => expect(server.asks).toBe(1))
    expect(screen.queryByTestId('pending-roster-home')).toBeNull()
    // the team uploads now
    server.connections = { pending_home_roster: V1 }
    await nextPanelCheck()
    expect(await screen.findByTestId('pending-roster-home')).toBeInTheDocument()
    expect(screen.getByTestId('pending-roster-title-home')).toHaveTextContent('matchSetup.rosterUploaded')
    expect(toasts.info).toHaveBeenCalledWith('matchSetup.rosterCheck.uploadFound Home V')
    expect(stored().pendingHomeRoster).toEqual(V1)
    // the same upload again: nothing stored, no toast
    await nextPanelCheck()
    await waitFor(() => expect(server.asks).toBe(3))
    await act(async () => {})
    expect(pendingWrites()).toHaveLength(1)
    expect(toasts.info).toHaveBeenCalledTimes(1)
    // never filled in by itself
    expect([...store.tables.players.values()].filter((p) => p.teamId === 11).map((p) => p.number)).toEqual([1])
  })
})

describe('an upload made again after Accept', () => {
  it('Accept: the clear names the upload, and the server\'s copy (not cleared yet) does not come back', async () => {
    storeMatch({ pendingHomeRoster: V1 })
    server.connections = { pending_home_roster: V1 }
    render(<Setup matchId={1} />)
    await openRemote()
    fireEvent.click(await screen.findByRole('button', { name: 'matchSetup.acceptRoster' }))
    await waitFor(() => expect(stored().pendingHomeRoster).toBeNull())
    expect(stored().uploadedRosterTaken.home.accepted).toMatchObject({ version: V1.timestamp })
    const clear = [...(store.tables.sync_queue?.values() || [])].find((j) => j.payload?.connections && 'pending_home_roster' in j.payload.connections)
    expect(clear.onlyIfPending).toMatchObject({ key: 'pending_home_roster', version: V1.timestamp })
    // the queue has not sent the clear: the server still has V1
    const asks = server.asks
    await nextPanelCheck()
    await waitFor(() => expect(server.asks).toBe(asks + 1))
    await act(async () => {})
    expect(stored().pendingHomeRoster).toBeNull()
    expect(screen.queryByTestId('pending-roster-home')).toBeNull()
    // a tap says it is the latest
    fireEvent.click(screen.getByTestId('check-server-roster-home'))
    expect(await screen.findByText('matchSetup.rosterCheck.upToDate')).toBeInTheDocument()
  })

  it('the team uploads again: offered as a new version (Accept / Reject), not filled in', async () => {
    storeMatch({ uploadedRosterTaken: takenAfter(null, 'home', V1, 'accepted') })
    server.connections = { pending_home_roster: V1 }
    render(<Setup matchId={1} />)
    await openRemote()
    await waitFor(() => expect(server.asks).toBe(1))
    await act(async () => {})
    expect(screen.queryByTestId('pending-roster-home')).toBeNull()
    server.connections = { pending_home_roster: V2 }
    await nextPanelCheck()
    expect(await screen.findByTestId('pending-roster-home')).toBeInTheDocument()
    expect(screen.getByTestId('pending-roster-title-home')).toHaveTextContent('matchSetup.rosterCheck.newVersion')
    expect(toasts.info).toHaveBeenCalledWith('matchSetup.rosterCheck.newVersionFound Home V')
    expect(screen.getByRole('button', { name: 'matchSetup.acceptRoster' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'matchSetup.rejectRoster' })).toBeInTheDocument()
    expect([...store.tables.players.values()].filter((p) => p.teamId === 11).map((p) => p.number)).toEqual([1])
    // Reject: not offered again, the accepted one stays the one in use
    fireEvent.click(screen.getByRole('button', { name: 'matchSetup.rejectRoster' }))
    await waitFor(() => expect(stored().pendingHomeRoster).toBeNull())
    expect(stored().uploadedRosterTaken.home).toMatchObject({ accepted: { version: V1.timestamp }, rejected: { version: V2.timestamp } })
    await nextPanelCheck()
    await act(async () => {})
    expect(stored().pendingHomeRoster).toBeNull()
  })

  it('the same content uploaded again: not offered (nothing would change)', async () => {
    storeMatch({ uploadedRosterTaken: takenAfter(null, 'home', V1, 'accepted') })
    server.connections = { pending_home_roster: { ...V1, timestamp: '2026-11-21T13:45:00.000Z' } }
    render(<Setup matchId={1} />)
    await openRemote()
    await waitFor(() => expect(server.asks).toBe(1))
    await act(async () => {})
    expect(stored().pendingHomeRoster ?? null).toBeNull()
    expect(toasts.info).not.toHaveBeenCalled()
  })
})

describe('a roster sent again from the manager page after it was used', () => {
  const sentPlayers = (names) => names.map((n, i) => ({ number: i + 2, first_name: `F${i}`, last_name: n, license_number: String(100000 + i), is_captain: i === 0 }))
  const sentRow = (updatedAt, names) => ({
    key: '991701|home', gameNumber: '991701', season: 2026, side: 'home', teamName: 'Home V', kickoff: '2026-11-21T19:30:00.000Z',
    players: sentPlayers(names), staff: [{ role: 'Coach', first_name: 'Cora', last_name: 'Coach', license_number: '200000' }],
    updatedAt, updatedByName: 'Manager M', userId: 'u-scorer-1'
  })
  const FIRST = sentRow('2026-11-21T12:00:00.000Z', ['One', 'Two', 'Three', 'Four', 'Five', 'Six'])

  it('a new version: found by the panel\'s check, a card that says so, nothing filled in', async () => {
    storeMatch({ sentRosterUsed: { home: FIRST.updatedAt }, sentRosterUsedFp: { home: sentRosterFingerprint(FIRST) } })
    render(<Setup matchId={1} />)
    await openRemote()
    await waitFor(() => expect(refresh.calls.length).toBeGreaterThan(0))
    expect(screen.queryByTestId('sent-roster-home')).toBeNull()
    // the manager sends a changed roster
    refresh.answer = () => { (store.tables.game_rosters ||= new Map()).set('991701|home', sentRow('2026-11-21T13:40:00.000Z', ['One', 'Two', 'Three', 'Four', 'Five', 'Seven'])) }
    await nextPanelCheck()
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith('matchSetup.rosterCheck.newVersionFound Home V'))
    // the card comes with the device's copy (its live query), Accept / Not now
    expect(await screen.findByTestId('sent-roster-new-version-home')).toHaveTextContent('matchSetup.rosterCheck.newVersion')
    expect(screen.getByTestId('sent-roster-use-home')).toBeInTheDocument()
    expect(screen.getByTestId('sent-roster-dismiss-home')).toBeInTheDocument()
    // the next checks: no second toast for the same version
    await nextPanelCheck()
    await waitFor(() => expect(refresh.calls.length).toBeGreaterThan(2))
    expect(toasts.info).toHaveBeenCalledTimes(1)
    // never filled in by itself, never told to the server as used
    expect([...store.tables.players.values()].filter((p) => p.teamId === 11).map((p) => p.number)).toEqual([1])
    expect(store.tables.game_rosters.get('991701|home').usedPending).toBeUndefined()
    expect(stored().sentRosterUsed).toEqual({ home: FIRST.updatedAt })
  })

  it('sent again unchanged: no card, recorded as used', async () => {
    const again = { ...sentRow('2026-11-21T13:40:00.000Z', ['One', 'Two', 'Three', 'Four', 'Five', 'Six']) }
    storeMatch({ sentRosterUsed: { home: FIRST.updatedAt }, sentRosterUsedFp: { home: sentRosterFingerprint(FIRST) } })
    store.tables.game_rosters = new Map([['991701|home', again]])
    render(<Setup matchId={1} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'matchSetup.editRoster' }))[0])
    await waitFor(() => expect(stored().sentRosterUsed).toEqual({ home: again.updatedAt }))
    await waitFor(() => expect(store.tables.game_rosters.get('991701|home')?.usedPending ?? 'gone').toBeTruthy())
    expect(screen.queryByTestId('sent-roster-home')).toBeNull()
  })
})
