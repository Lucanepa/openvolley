/**
 * Match Setup and the rosters teams send from the manager page (db/023), as
 * seen on 17.11.2026: a roster sent while Match Setup was open never showed
 * up, and "Search for roster" only looked for an upload made with the PIN.
 *  - the screen asks for the game's sent rosters again while it stays open
 *    (timer, screen shown again, focus), not once per opening; never once
 *    the setup is locked;
 *  - "Search for roster" looks in both places: a sent roster is pointed at
 *    (one put aside with "Not now" comes back), and with nothing anywhere
 *    the message says where it looked.
 * Harness as MatchSetupRosterSignatures.test.jsx (in-memory Dexie stand-in,
 * useLiveQuery run once per deps change). Made-up names.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => String(typeof fallback === 'string' ? fallback : key),
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

vi.mock('dexie-react-hooks', async () => {
  const React = await import('react')
  return {
    useLiveQuery: (fn, deps = []) => {
      const [value, setValue] = React.useState(undefined)
      React.useEffect(() => {
        let alive = true
        Promise.resolve(fn()).then((v) => { if (alive) setValue(v) })
        return () => { alive = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps)
      return value
    }
  }
})

const store = vi.hoisted(() => ({ tables: {}, nextId: 1 }))
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
    add: async (row) => { const id = row?.id ?? store.nextId++; rowsOf(name).set(id, { ...row, id }); return id },
    put: async (row) => { const id = row?.id ?? store.nextId++; rowsOf(name).set(id, { ...row, id }); return id },
    bulkAdd: async (rows) => { for (const r of rows) await table(name).add(r) },
    bulkPut: async (rows) => { for (const r of rows) await table(name).put(r) },
    update: async (id, changes) => {
      const r = rowsOf(name).get(id)
      if (!r) return 0
      const next = { ...r }
      for (const [k, v] of Object.entries(changes)) {
        // Dexie key paths ("signatureSources.homeCoachSignature")
        if (k.includes('.')) { const [a, b] = k.split('.'); next[a] = { ...(next[a] || {}), [b]: v } } else next[k] = v
      }
      rowsOf(name).set(id, next)
      return 1
    },
    delete: async (id) => { rowsOf(name).delete(id) },
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

vi.mock('../../lib/apiClient', () => {
  const chain = () => {
    const b = new Proxy({}, {
      get: (_, prop) => {
        if (prop === 'then') return (resolve) => Promise.resolve({ data: null, error: null }).then(resolve)
        return () => b
      }
    })
    return b
  }
  return {
    apiFrom: () => chain(),
    apiStorage: { from: () => chain() },
    AUTH_TOKEN_CHANGE_EVENT: 'ov-test-auth-token-change',
    AUTH_TOKEN_STORAGE_KEY: 'api_auth_token',
    apiMatchRestore: () => chain(),
    apiMatchClaim: () => chain()
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
  // what the server sends for the game: refresh.answer(), written to the device's copy
  refreshGameRosters: vi.fn(async (args) => { refresh.calls.push(args); refresh.answer?.(); return 'refreshed' })
}))
vi.mock('../SignaturePad', () => ({ default: () => null }))

import MatchSetup from '../MatchSetup'
import { ScaleProvider } from '../../contexts/ScaleContext'

const Setup = (props) => <ScaleProvider><MatchSetup onStart={() => {}} onReturn={() => {}} {...props} /></ScaleProvider>
const SENT_AT = '2026-11-17T18:40:00.000Z'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stored = () => store.tables.matches.get(1)

function storeMatch (extra = {}) {
  store.tables.matches = new Map([[1, {
    id: 1, status: 'setup', seed_key: 'match_1_sent', matchInfoConfirmedAt: '2026-11-17T18:00:00Z',
    homeTeamId: 11, awayTeamId: 12, homeName: 'Home V', awayName: 'Away V', homeShortName: 'HOM', awayShortName: 'AWA',
    scheduledAt: '2026-11-17T19:30:00.000Z', game_n: 991601, gameNumber: '991601', league: '3L', hall: 'Hall A', city: 'Town', bestOf: 5,
    gamePin: '654321', remarks: '', refereePin: '111111', homeTeamPin: '222222', awayTeamPin: '333333', homeTeamUploadPin: '444444', awayTeamUploadPin: '555555',
    bench_home: [{ role: 'Coach', firstName: 'Carla', lastName: 'Coach' }],
    bench_away: [{ role: 'Coach', firstName: 'Dora', lastName: 'Trainer' }],
    ...extra
  }]])
  store.tables.teams = new Map([[11, { id: 11, name: 'Home V' }], [12, { id: 12, name: 'Away V' }]])
  store.tables.players = new Map([
    [301, { id: 301, teamId: 12, number: 3, lastName: 'Kilo', firstName: 'K', isCaptain: true }]
  ])
}
function sentRow (extra = {}) {
  const players = [2, 5, 8, 10, 11, 14, 17, 18, 19, 20].map((n, i) => ({ number: n, first_name: `F${i}`, last_name: `Sent${i}`, dob: '2009-03-0' + ((i % 9) + 1), is_captain: i === 0 }))
  return {
    key: '991601|home', gameNumber: '991601', season: 2026, side: 'home', teamName: 'Home V', kickoff: '2026-11-17T19:30:00.000Z',
    players, staff: [{ role: 'Coach', first_name: 'Cora', last_name: 'Coach', dob: '1980-01-01' }],
    updatedAt: SENT_AT, updatedByName: 'Manager M', userId: 'u-scorer-1', ...extra
  }
}
const putSent = (row = sentRow()) => { (store.tables.game_rosters ||= new Map()).set(row.key, row) }

beforeEach(() => {
  store.tables = {}
  store.nextId = 100
  refresh.calls = []
  refresh.answer = null
  for (const f of Object.values(toasts)) f.mockClear()
  globalThis.ResizeObserver ||= class { observe () {} unobserve () {} disconnect () {} }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function openRemoteSearch () {
  fireEvent.click((await screen.findAllByRole('button', { name: 'matchSetup.editRoster' }))[0])
  fireEvent.click(await screen.findByRole('radio', { name: 'matchSetup.remote' }))
  expect(await screen.findByTestId('search-roster-hint-home')).toHaveTextContent('matchSetup.searchRosterHint')
  return screen.getByRole('button', { name: 'matchSetup.searchForRoster' })
}

describe('Match Setup asks for sent rosters while it stays open', () => {
  it('asks when it opens and again when the screen comes back, for this game only', async () => {
    storeMatch()
    let clock = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    render(<Setup matchId={1} />)
    await waitFor(() => expect(refresh.calls).toHaveLength(1))
    expect(refresh.calls[0]).toMatchObject({ userId: 'u-scorer-1', games: ['991601'] })

    // focus right after: not twice in a row
    window.dispatchEvent(new Event('focus'))
    await sleep(20)
    expect(refresh.calls).toHaveLength(1)

    // the scorer comes back to the tablet a while later
    clock += 60_000
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(refresh.calls).toHaveLength(2))
    clock += 60_000
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(refresh.calls).toHaveLength(3))
    expect(refresh.calls.every((c) => c.games?.[0] === '991601')).toBe(true)
  })

  it('does not ask once the setup is locked (the match runs)', async () => {
    storeMatch({ status: 'live' })
    render(<Setup matchId={1} />)
    await sleep(100)
    window.dispatchEvent(new Event('focus'))
    await sleep(20)
    expect(refresh.calls).toHaveLength(0)
  })
})

describe('Search for roster looks in both places', () => {
  it('a roster sent while Match Setup was open: found, pointed at, not "No roster"', async () => {
    storeMatch()
    store.tables.players.set(201, { id: 201, teamId: 11, number: 1, lastName: 'Old', firstName: 'O' })
    render(<Setup matchId={1} />)
    const search = await openRemoteSearch()
    // the team manager sends it now
    refresh.answer = () => putSent()
    const before = refresh.calls.length
    fireEvent.click(search)
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith('matchSetup.sentRosterFound'))
    expect(refresh.calls.length).toBeGreaterThan(before)
    expect(screen.queryByText('matchSetup.noRosterFound')).toBeNull()
    expect(screen.queryByText('matchSetup.noRosterFoundAnywhere')).toBeNull()
    // nothing stored or spent by searching
    expect(stored().pendingHomeRoster ?? null).toBeNull()
    expect(stored().sentRosterUsed).toBeUndefined()
    expect(store.tables.game_rosters.get('991601|home').usedPending).toBeUndefined()
  })

  it('one put aside with "Not now" comes back when searched for', async () => {
    storeMatch({ sentRosterDismissed: { home: SENT_AT } })
    store.tables.players.set(201, { id: 201, teamId: 11, number: 1, lastName: 'Old', firstName: 'O' })
    putSent()
    render(<Setup matchId={1} />)
    const search = await openRemoteSearch()
    expect(screen.queryByTestId('sent-roster-home')).toBeNull()
    fireEvent.click(search)
    await waitFor(() => expect(stored().sentRosterDismissed).toEqual({ home: null }))
    expect(toasts.info).toHaveBeenCalledWith('matchSetup.sentRosterFound')
  })

  it('one already used does not come back; with nothing anywhere the message says where it looked', async () => {
    storeMatch()
    store.tables.players.set(201, { id: 201, teamId: 11, number: 1, lastName: 'Old', firstName: 'O' })
    putSent(sentRow({ usedPending: true }))
    render(<Setup matchId={1} />)
    const search = await openRemoteSearch()
    fireEvent.click(search)
    expect(await screen.findByText('matchSetup.noRosterFoundAnywhere')).toBeInTheDocument()
    expect(toasts.info).not.toHaveBeenCalled()
  })
})
