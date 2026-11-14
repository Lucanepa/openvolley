/**
 * Match Setup after the coin toss and its info page (rollout audit,
 * setup-after-coin-toss-and-info):
 *  - read-only once the coin toss is confirmed or the match runs: no info,
 *    roster or schedule edits, no auto-save into the match;
 *  - info page edits stay in a per-match draft until Save (restored after a
 *    reload, cleared by Save and Back), never in the match row before Save;
 *  - officials stored in the cloud shape (first_name, ISO date) load;
 *  - the match format starts unset and Create match waits for it; a schedule
 *    game without a known format clears it;
 *  - Load match from schedule asks before renaming teams that have rosters,
 *    and swaps the rosters when the schedule has home and away the other way;
 *  - Coin toss on a match that is gone says so and creates nothing.
 * In-memory Dexie stand-in, useLiveQuery run once per deps change. Made-up names.
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
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: null, profile: null, getCachedProfile: () => null }) }))

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

const store = vi.hoisted(() => ({ tables: {}, nextId: 1, updates: [] }))
vi.mock('../../db/db', () => {
  const rowsOf = (name) => (store.tables[name] ||= new Map())
  const collection = (rows) => {
    const c = {
      equals: () => c, above: () => c, below: () => c, anyOf: () => c, between: () => c,
      filter: () => c, and: () => c, reverse: () => c, limit: () => c, offset: () => c,
      toArray: async () => rows, sortBy: async () => rows, first: async () => rows[0],
      last: async () => rows[rows.length - 1], count: async () => rows.length,
      modify: async () => 0, delete: async () => 0, each: async () => {}, primaryKeys: async () => []
    }
    return c
  }
  const table = (name) => ({
    get: async (id) => rowsOf(name).get(id),
    add: async (row) => { const id = row?.id ?? store.nextId++; rowsOf(name).set(id, { ...row, id }); return id },
    put: async (row) => { const id = row?.id ?? store.nextId++; rowsOf(name).set(id, { ...row, id }); return id },
    bulkAdd: async (rows) => { for (const r of rows) await table(name).add(r) },
    bulkDelete: async (ids) => { for (const id of ids) rowsOf(name).delete(id) },
    update: async (id, changes) => {
      store.updates.push([name, id, changes])
      const r = rowsOf(name).get(id); if (!r) return 0; rowsOf(name).set(id, { ...r, ...changes }); return 1
    },
    delete: async (id) => { rowsOf(name).delete(id) },
    toArray: async () => [...rowsOf(name).values()],
    count: async () => rowsOf(name).size,
    where: (field) => name === 'players'
      ? { equals: (v) => {
          const rows = [...rowsOf(name).values()].filter((r) => r[field] === v)
          return { ...collection(rows), delete: async () => { for (const r of rows) rowsOf(name).delete(r.id); return rows.length } }
        } }
      : collection([]),
    orderBy: () => collection([]),
    filter: () => collection([]),
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

// The schedule picker: a button that hands the test's game to Match setup
const schedule = vi.hoisted(() => ({ game: null }))
vi.mock('../LoadOfficialMatchModal', async (orig) => ({
  ...(await orig()),
  default: ({ open, onSelectMatch }) => (open ? <button type="button" onClick={() => onSelectMatch(schedule.game)}>pick-schedule-game</button> : null)
}))
const ui = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }))
vi.mock('../../ui', async (orig) => ({ ...(await orig()), confirmDialog: (...a) => ui.confirm(...a) }))

import MatchSetup from '../MatchSetup'
import { ScaleProvider } from '../../contexts/ScaleContext'

const Setup = (props) => <ScaleProvider><MatchSetup onStart={() => {}} onReturn={() => {}} {...props} /></ScaleProvider>
const queued = () => [...(store.tables.sync_queue?.values() || [])]
const drafts = () => [...(store.tables.match_setup?.values() || [])]
const PINS = { refereePin: '111111', homeTeamPin: '222222', awayTeamPin: '333333', homeTeamUploadPin: '444444', awayTeamUploadPin: '555555' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const matchUpdates = (key) => store.updates.filter(([table, , changes]) => table === 'matches' && key in changes)

const players = (teamId, base, prefix) => Array.from({ length: 6 }, (_, i) => [base + i, {
  id: base + i, teamId, number: i + 1, lastName: `${prefix}${i + 1}`, firstName: 'P', isCaptain: i === 0, dob: '01.01.2000'
}])

function storeMatch (extra = {}) {
  store.tables.matches = new Map([[1, {
    id: 1, status: 'setup', seed_key: 'match_1_setup', matchInfoConfirmedAt: '2026-11-01T10:00:00Z', connectionPinsQueuedAt: '2026-11-01T10:00:00Z',
    refereeConnectionEnabled: false, homeTeamConnectionEnabled: false, awayTeamConnectionEnabled: false,
    homeTeamId: 11, awayTeamId: 12, homeName: 'Alpha VC', awayName: 'Beta VC', homeShortName: 'ALP', awayShortName: 'BET',
    scheduledAt: '2026-11-20T18:00:00.000Z', game_n: 991501, league: '3L', hall: 'Halle A', city: 'Musterdorf', bestOf: 5,
    gamePin: '654321',
    bench_home: [{ role: 'Coach', firstName: 'Cora', lastName: 'Coach' }],
    bench_away: [{ role: 'Coach', firstName: 'Cleo', lastName: 'Coach' }],
    officials: [
      { role: '1st referee', firstName: 'Rita', lastName: 'Ref', country: 'CHE', dob: '01.01.1990' },
      { role: 'scorer', firstName: 'Sina', lastName: 'Scorer', country: 'CHE', dob: '02.02.2000' }
    ],
    ...PINS, ...extra
  }]])
  store.tables.teams = new Map([[11, { id: 11, name: 'Alpha VC', color: '#c00000' }], [12, { id: 12, name: 'Beta VC', color: '#0000c0' }]])
  store.tables.players = new Map([...players(11, 200, 'Alpha'), ...players(12, 300, 'Beta')])
}

beforeEach(() => {
  store.tables = {}
  store.nextId = 1000
  store.updates = []
  schedule.game = null
  ui.confirm.mockReset()
  ui.confirm.mockImplementation(async () => true)
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Match Setup after the coin toss is read-only', () => {
  for (const [label, extra] of [['a live match', { status: 'live', coinTossConfirmed: true }], ['a confirmed coin toss not yet live', { status: 'setup', coinTossConfirmed: true }], ['an ended match', { status: 'ended', coinTossConfirmed: true }]]) {
    it(`${label}: no edit, roster or schedule buttons, and nothing is written`, async () => {
      storeMatch(extra)
      render(<Setup matchId={1} />)
      expect(await screen.findByTestId('setup-locked')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'common.edit' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'matchSetup.editRoster' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'loadOfficialMatch.button' })).toBeNull()
      await sleep(800)
      expect(matchUpdates('hall')).toHaveLength(0)
      expect(matchUpdates('officials')).toHaveLength(0)
      expect(store.updates.filter(([table]) => table === 'teams')).toHaveLength(0)
    })
  }

  it('before the coin toss the setup stays editable', async () => {
    storeMatch()
    render(<Setup matchId={1} />)
    expect((await screen.findAllByRole('button', { name: 'matchSetup.editRoster' })).length).toBe(2)
    expect(screen.getByRole('button', { name: 'common.edit' })).toBeInTheDocument()
    expect(screen.queryByTestId('setup-locked')).toBeNull()
  })
})

describe('the info page keeps its edits in a draft until Save', () => {
  it('edits are not stored in the match before Save; reopened, the draft is back and Save sends it', async () => {
    storeMatch()
    const first = render(<Setup matchId={1} />)
    fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }))
    fireEvent.change(await screen.findByLabelText('matchSetup.hall'), { target: { value: 'Halle Neu' } })
    fireEvent.change(await screen.findByLabelText('matchSetup.gameNumber'), { target: { value: '991599' } })
    await waitFor(() => expect(drafts().some((d) => d.matchId === 1 && d.data?.hall === 'Halle Neu')).toBe(true), { timeout: 3000 })
    expect(store.tables.matches.get(1).hall).toBe('Halle A')
    expect(store.tables.matches.get(1).game_n).toBe(991501)
    // left without Save or Back (Home, a reload, an app killed)
    first.unmount()
    render(<Setup matchId={1} />)
    const hall = await screen.findByLabelText('matchSetup.hall')
    await waitFor(() => expect(hall).toHaveValue('Halle Neu'))
    expect(screen.getByLabelText('matchSetup.gameNumber')).toHaveValue(991599)
    fireEvent.click(screen.getByRole('button', { name: 'matchSetup.save' }))
    await waitFor(() => expect(store.tables.matches.get(1).hall).toBe('Halle Neu'))
    const insert = queued().find((j) => j.resource === 'match' && j.action === 'insert')
    expect(insert.payload.match_info.hall).toBe('Halle Neu')
    expect(insert.payload.game_n).toBe(991599)
    await waitFor(() => expect(drafts().filter((d) => d.matchId === 1)).toHaveLength(0))
  })

  it('Back discards the draft', async () => {
    storeMatch()
    render(<Setup matchId={1} />)
    fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }))
    fireEvent.change(await screen.findByLabelText('matchSetup.hall'), { target: { value: 'Halle Neu' } })
    await waitFor(() => expect(drafts().some((d) => d.matchId === 1)).toBe(true), { timeout: 3000 })
    fireEvent.click(screen.getByRole('button', { name: /common\.back/ }))
    await waitFor(() => expect(drafts().filter((d) => d.matchId === 1)).toHaveLength(0))
    await sleep(700)
    expect(store.tables.matches.get(1).hall).toBe('Halle A')
  })

  it('a draft of a match that is locked now, of another match or without a match is dropped, not restored', async () => {
    storeMatch({ status: 'live', coinTossConfirmed: true })
    store.tables.match_setup = new Map([
      [1, { id: 1, matchId: 1, view: 'info', data: { hall: 'Halle Alt' }, updatedAt: '2026-11-01T10:00:00Z' }],
      [2, { id: 2, homeRoster: [{ lastName: 'Old', dob: '01.01.2010' }], updatedAt: '2026-10-01T10:00:00Z' }],
      [3, { id: 3, matchId: 77, view: 'info', data: { hall: 'Gone' }, updatedAt: '2026-10-01T10:00:00Z' }]
    ])
    render(<Setup matchId={1} />)
    expect(await screen.findByTestId('setup-locked')).toBeInTheDocument()
    await waitFor(() => expect(drafts()).toHaveLength(0))
    expect(store.tables.matches.get(1).hall).toBe('Halle A')
  })
})

describe('officials in the cloud shape', () => {
  it('load with their names and are not erased by the auto-save', async () => {
    storeMatch({
      officials: [
        { role: '1st referee', first_name: 'Rita', last_name: 'Ref', country: 'CHE', dob: '1990-01-01', email: 'rita@example.invalid' },
        { role: '2nd referee', first_name: 'Rolf', last_name: 'Zwei', country: 'CHE', dob: '1985-05-05' },
        { role: 'scorer', first_name: 'Sina', last_name: 'Scorer', country: 'CHE', dob: '2000-02-02' }
      ]
    })
    render(<Setup matchId={1} />)
    await screen.findAllByText('Alpha VC')
    await sleep(900)
    const officials = store.tables.matches.get(1).officials
    const ref1 = officials.find((o) => o.role === '1st referee')
    expect(ref1.firstName ?? ref1.first_name).toBe('Rita')
    expect(ref1.email).toBe('rita@example.invalid')
    expect(officials.find((o) => o.role === 'scorer')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }))
    expect(await screen.findByDisplayValue('Rolf')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Zwei')).toBeInTheDocument()
  })
})

describe('the match format', () => {
  it('starts unset on a new match: Create match waits until a format is chosen', async () => {
    storeMatch({ matchInfoConfirmedAt: null, bestOf: undefined })
    render(<Setup matchId={1} />)
    fireEvent.click(await screen.findByRole('button', { name: 'matchSetup.createMatch' }))
    const format = await screen.findByLabelText('matchSetup.matchFormat')
    expect(format).toHaveValue('')
    const create = screen.getByRole('button', { name: 'matchSetup.createMatch' })
    expect(create).toBeDisabled()
    fireEvent.change(format, { target: { value: '3' } })
    expect(screen.getByRole('button', { name: 'matchSetup.createMatch' })).not.toBeDisabled()
  })

  it('a schedule game sets a known format and clears it otherwise', async () => {
    storeMatch({ matchInfoConfirmedAt: null, bestOf: undefined })
    store.tables.players = new Map()
    render(<Setup matchId={1} />)
    fireEvent.click(await screen.findByRole('button', { name: 'loadOfficialMatch.button' }))
    schedule.game = { gameN: '930010', date: '2026-11-20', time: '18:00', home: 'Alpha VC', away: 'Beta VC', league: '3L', hall: 'Halle A', city: 'Musterdorf', bestOf: 3 }
    fireEvent.click(await screen.findByRole('button', { name: 'pick-schedule-game' }))
    await waitFor(() => expect(screen.getByLabelText('matchSetup.matchFormat')).toHaveValue('3'))
    schedule.game = { ...schedule.game, gameN: '930011', bestOf: null }
    fireEvent.click(screen.getByRole('button', { name: 'pick-schedule-game' }))
    await waitFor(() => expect(screen.getByLabelText('matchSetup.matchFormat')).toHaveValue(''))
  })
})

describe('Load match from schedule with rosters entered', () => {
  it('home and away the other way round: asks, and the rosters move with their teams', async () => {
    storeMatch()
    render(<Setup matchId={1} />)
    fireEvent.click(await screen.findByRole('button', { name: 'loadOfficialMatch.button' }))
    schedule.game = { gameN: '930020', date: '2026-11-20', time: '18:00', home: 'Beta VC', away: 'Alpha VC', league: '3L', hall: 'Halle B', city: 'Musterdorf', bestOf: 5 }
    fireEvent.click(await screen.findByRole('button', { name: 'pick-schedule-game' }))
    await waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(1))
    expect(ui.confirm.mock.calls[0][0].title).toBe('matchSetup.scheduleSwapTitle')
    // short names are cleared by a schedule load: fill them in
    fireEvent.change(await screen.findByLabelText('common.home matchSetup.short'), { target: { value: 'BET' } })
    fireEvent.change(screen.getByLabelText('common.away matchSetup.short'), { target: { value: 'ALP' } })
    fireEvent.click(screen.getByRole('button', { name: 'matchSetup.save' }))
    await waitFor(() => expect(store.tables.matches.get(1).homeTeamId).toBe(12))
    const m = store.tables.matches.get(1)
    expect(m.awayTeamId).toBe(11)
    // the home team is Beta VC with Beta's players, its bench and colour
    expect(store.tables.teams.get(12).name).toBe('Beta VC')
    expect(store.tables.teams.get(11).name).toBe('Alpha VC')
    expect(m.bench_home[0].firstName).toBe('Cleo')
    const rosterJob = queued().find((j) => j.resource === 'match' && j.action === 'update' && j.payload.players_home)
    expect(rosterJob.payload.players_home[0].last_name).toBe('Beta1')
    expect(rosterJob.payload.players_away[0].last_name).toBe('Alpha1')
  })

  it('other team names: asks, and Cancel leaves the form as it was', async () => {
    storeMatch()
    ui.confirm.mockImplementation(async () => false)
    render(<Setup matchId={1} />)
    fireEvent.click(await screen.findByRole('button', { name: 'loadOfficialMatch.button' }))
    schedule.game = { gameN: '930021', home: 'Gamma VC', away: 'Delta VC', league: '3L', hall: 'Halle G', city: 'Musterdorf', bestOf: 5 }
    fireEvent.click(await screen.findByRole('button', { name: 'pick-schedule-game' }))
    await waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(1))
    expect(ui.confirm.mock.calls[0][0].title).toBe('matchSetup.scheduleTeamsTitle')
    await sleep(50)
    expect(screen.getByLabelText('matchSetup.hall')).toHaveValue('Halle A')
    expect(screen.getByLabelText('matchSetup.gameNumber')).toHaveValue(991501)
  })
})

describe('Coin toss on a match that is gone', () => {
  it('says "match not found" and creates nothing', async () => {
    storeMatch()
    const onOpenCoinToss = vi.fn()
    render(<Setup matchId={1} onOpenCoinToss={onOpenCoinToss} />)
    await screen.findAllByText('Alpha VC')
    const coinToss = await screen.findByRole('button', { name: 'matchSetup.coinToss' })
    await waitFor(() => expect(coinToss).not.toBeDisabled())
    store.tables.matches.delete(1)
    const before = store.tables.matches.size
    fireEvent.click(coinToss)
    expect(await screen.findByText('matchSetup.matchNotFound')).toBeInTheDocument()
    expect(store.tables.matches.size).toBe(before)
    expect(onOpenCoinToss).not.toHaveBeenCalled()
    expect(queued().filter((j) => j.resource === 'match')).toHaveLength(0)
  })
})
