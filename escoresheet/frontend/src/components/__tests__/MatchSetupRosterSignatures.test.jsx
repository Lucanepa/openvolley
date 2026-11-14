/**
 * Match Setup's roster editor and the pre-match signatures (rollout audit,
 * setup-roster-editor-and-signatures):
 *  - once a team signed, a change of its players or bench clears its coach
 *    and captain signatures, with a remark;
 *  - Confirm sends no partial `signatures` object; Clear writes null at once
 *    (the whole object queued);
 *  - the libero select changes the editor only: Back discards it, Confirm
 *    writes it;
 *  - Confirm refuses a named player without a shirt number;
 *  - a sent-ahead roster used in the editor is stored and marked used only by
 *    the editor's Save; Back loses nothing;
 *  - Back after a pad signature given for an edited roster clears it, as the
 *    roster goes back to the one the signature was not given for.
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
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-scorer-1' }, profile: null, getCachedProfile: () => null, access: { canReadTeams: false, canManageTeams: false } })
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
vi.mock('../../ui', async (orig) => ({ ...(await orig()), confirmDialog: async () => true }))
vi.mock('../SignaturePad', () => ({
  default: ({ open, onSave, title }) => (open ? <button type="button" onClick={() => onSave(PAD_INK, { source: 'device' })}>draw {title}</button> : null)
}))

import MatchSetup from '../MatchSetup'
import { ScaleProvider } from '../../contexts/ScaleContext'

const Setup = (props) => <ScaleProvider><MatchSetup onStart={() => {}} onReturn={() => {}} {...props} /></ScaleProvider>
const queued = () => [...(store.tables.sync_queue?.values() || [])]
const sigJobs = () => queued().filter((j) => j.payload?.signatures)
const PINS = { refereePin: '111111', homeTeamPin: '222222', awayTeamPin: '333333', homeTeamUploadPin: '444444', awayTeamUploadPin: '555555' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const AWAY_COACH = 'data:image/png;base64,AWAYCOACH'
const AWAY_CAPT = 'data:image/png;base64,AWAYCAPT'
const SENT_AT = '2026-11-10T17:00:00.000Z'
const PAD_INK = 'data:image/png;base64,PADINK'

function storeMatch (extra = {}) {
  store.tables.matches = new Map([[1, {
    id: 1, status: 'setup', seed_key: 'match_1_roster', matchInfoConfirmedAt: '2026-11-01T10:00:00Z',
    homeTeamId: 11, awayTeamId: 12, homeName: 'Home V', awayName: 'Away V', homeShortName: 'HOM', awayShortName: 'AWA',
    scheduledAt: '2026-11-20T18:00:00.000Z', game_n: 991501, gameNumber: '991501', league: '3L', hall: 'Hall A', city: 'Town', bestOf: 5,
    gamePin: '654321', remarks: '',
    bench_home: [{ role: 'Coach', firstName: 'Carla', lastName: 'Coach' }],
    bench_away: [{ role: 'Coach', firstName: 'Dora', lastName: 'Trainer' }],
    ...PINS, ...extra
  }]])
  store.tables.teams = new Map([[11, { id: 11, name: 'Home V' }], [12, { id: 12, name: 'Away V' }]])
  store.tables.players = new Map([
    [201, { id: 201, teamId: 11, number: 2, lastName: 'Alpha', firstName: 'A', isCaptain: true }],
    [202, { id: 202, teamId: 11, number: 5, lastName: 'Bravo', firstName: 'B' }],
    [203, { id: 203, teamId: 11, number: 8, lastName: 'Charlie', firstName: 'C' }],
    [204, { id: 204, teamId: 11, number: 10, lastName: 'Delta', firstName: 'D', libero: 'libero1' }],
    [205, { id: 205, teamId: 11, number: 11, lastName: 'Echo', firstName: 'E', libero: 'libero2' }],
    [301, { id: 301, teamId: 12, number: 3, lastName: 'Kilo', firstName: 'K', isCaptain: true }],
    [302, { id: 302, teamId: 12, number: 4, lastName: 'Lima', firstName: 'L' }]
  ])
}
const signedAway = (extra = {}) => storeMatch({ awayCoachSignature: AWAY_COACH, awayCaptainSignature: AWAY_CAPT, ...extra })

function sentRosterRow () {
  const players = [2, 5, 8, 10, 11, 14, 17].map((n, i) => ({ number: n, first_name: `F${i}`, last_name: `Sent${i}`, dob: '2009-03-0' + (i + 1), is_captain: i === 0, is_libero: i === 6 }))
  store.tables.game_rosters = new Map([['991501|home', {
    key: '991501|home', gameNumber: '991501', season: 2026, side: 'home', teamName: 'Home V', kickoff: '2026-11-20T18:00:00.000Z',
    players, staff: [{ role: 'Coach', first_name: 'Cora', last_name: 'Coach', dob: '1980-01-01' }],
    coachSignature: 'data:image/png;base64,SENTCOACH', captainSignature: 'data:image/png;base64,SENTCAPT',
    updatedAt: SENT_AT, updatedByName: 'Manager M', userId: 'u-scorer-1'
  }]])
}

beforeEach(() => {
  store.tables = {}
  store.nextId = 100
  globalThis.ResizeObserver ||= class { observe () {} unobserve () {} disconnect () {} }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const editorRows = () => document.querySelectorAll('.roster-grid:not(.roster-add) input.cell-last')
async function openEditor (index, rows) {
  fireEvent.click((await screen.findAllByRole('button', { name: 'matchSetup.editRoster' }))[index])
  await waitFor(() => expect(editorRows()).toHaveLength(rows))
}
function addPlayer ({ number = '', last, first }) {
  const addRow = document.querySelector('.roster-grid.roster-add')
  if (number) fireEvent.change(addRow.querySelector('input[aria-label="Player number"]'), { target: { value: number } })
  fireEvent.change(addRow.querySelector('input.cell-last'), { target: { value: last } })
  fireEvent.change(addRow.querySelector('input.cell-first'), { target: { value: first } })
  fireEvent.click(addRow.querySelector('.cell-action button'))
}
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }))
const back = () => fireEvent.click(screen.getByRole('button', { name: /common.back/ }))
const stored = () => store.tables.matches.get(1)
const teamPlayers = (teamId) => [...store.tables.players.values()].filter((p) => p.teamId === teamId)

describe('Match Setup roster editor: libero select', () => {
  it('changes the editor only: Back keeps the stored liberos, Confirm writes them', async () => {
    storeMatch()
    render(<Setup matchId={1} />)
    await openEditor(0, 5)
    const libero = () => [...document.querySelectorAll('.roster-grid:not(.roster-add) select.cell-libero')]
    fireEvent.change(libero()[3], { target: { value: '' } }) // Delta (#10, L1) set to none by mistake
    await sleep(50)
    expect(store.tables.players.get(204).libero).toBe('libero1')
    expect(store.tables.players.get(205).libero).toBe('libero2')
    back()
    await sleep(50)
    expect(store.tables.players.get(204).libero).toBe('libero1')
    expect(store.tables.players.get(205).libero).toBe('libero2')

    await openEditor(0, 5)
    fireEvent.change(libero()[3], { target: { value: '' } })
    confirm()
    await waitFor(() => expect(queued().some((j) => j.payload?.players_home)).toBe(true))
    const byNumber = (n) => teamPlayers(11).find((p) => p.number === n)
    expect(byNumber(10).libero).toBe('')
    expect(byNumber(11).libero).toBe('libero1')
  })
})

describe('Match Setup roster editor: Confirm', () => {
  it('refuses a named player without a shirt number', async () => {
    storeMatch()
    render(<Setup matchId={1} />)
    await openEditor(0, 5)
    addPlayer({ last: 'Foxtrot', first: 'F' })
    await waitFor(() => expect(editorRows()).toHaveLength(6))
    confirm()
    await screen.findByText(/matchSetup.validation.fixIssues/)
    await sleep(50)
    expect(queued().filter((j) => j.payload?.players_home)).toHaveLength(0)
    expect(teamPlayers(11)).toHaveLength(5)
  })

  it('sends no partial signatures object: the other team\'s signatures stay', async () => {
    signedAway()
    render(<Setup matchId={1} />)
    await openEditor(0, 5)
    addPlayer({ number: '7', last: 'Foxtrot', first: 'F' })
    await waitFor(() => expect(editorRows()).toHaveLength(6))
    confirm()
    const job = await waitFor(() => {
      const j = queued().find((x) => x.payload?.players_home)
      expect(j).toBeTruthy()
      return j
    })
    expect(job.payload).not.toHaveProperty('signatures')
    expect(job.payload.players_home.map((p) => p.last_name)).toContain('Foxtrot')
    expect(teamPlayers(11).map((p) => p.lastName)).toContain('Foxtrot')
    expect(stored().awayCoachSignature).toBe(AWAY_COACH)
    expect(stored().awayCaptainSignature).toBe(AWAY_CAPT)
    // every signatures job carries the whole object
    for (const j of sigJobs()) expect(j.payload.signatures).toHaveProperty('away_coach', AWAY_COACH)
  })

  it('a change after signing clears that team\'s coach and captain signatures, with a remark', async () => {
    signedAway()
    render(<Setup matchId={1} />)
    await openEditor(1, 2)
    addPlayer({ number: '7', last: 'Golf', first: 'G' })
    await waitFor(() => expect(editorRows()).toHaveLength(3))
    confirm()
    await waitFor(() => expect(stored().awayCoachSignature).toBeNull())
    expect(stored().awayCaptainSignature).toBeNull()
    expect(stored().remarks).toMatch(/Roster of Away V changed after signing.*Captain and Coach signatures removed/)
    const last = sigJobs().pop()
    expect(last.payload.signatures).toMatchObject({ away_coach: '', away_captain: '' })
    expect(queued().find((j) => j.payload?.players_away).payload).not.toHaveProperty('signatures')
  })

  it('Clear, Delete roster and a new roster: no old signature is kept or re-sent', async () => {
    signedAway()
    render(<Setup matchId={1} />)
    await openEditor(1, 2)
    const clears = await screen.findAllByRole('button', { name: 'Clear' })
    expect(clears).toHaveLength(2)
    fireEvent.click(clears[0])
    // Clear writes at once, and queues the whole object
    await waitFor(() => expect(stored().awayCaptainSignature).toBeNull())
    expect(sigJobs().pop().payload.signatures).toMatchObject({ away_captain: '', away_coach: AWAY_COACH })
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(stored().awayCoachSignature).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'roster.deleteRoster' }))
    addPlayer({ number: '7', last: 'Golf', first: 'G' })
    await waitFor(() => expect(editorRows()).toHaveLength(1))
    confirm()
    const job = await waitFor(() => {
      const j = queued().find((x) => x.payload?.players_away)
      expect(j).toBeTruthy()
      return j
    })
    expect(job.payload.players_away.map((p) => p.last_name)).toEqual(['Golf'])
    expect(job.payload).not.toHaveProperty('signatures')
    expect(stored().awayCoachSignature).toBeNull()
    expect(stored().awayCaptainSignature).toBeNull()
  })

  it('Confirm without a change keeps the signatures and writes no remark', async () => {
    signedAway()
    render(<Setup matchId={1} />)
    await openEditor(1, 2)
    confirm()
    await sleep(100)
    expect(stored().awayCoachSignature).toBe(AWAY_COACH)
    expect(stored().awayCaptainSignature).toBe(AWAY_CAPT)
    expect(stored().remarks).toBe('')
  })
})

describe('Match Setup roster editor: Back after signing in the editor', () => {
  const signAwayCoach = async () => {
    fireEvent.click(screen.getAllByText('Tap to sign').at(-1)) // the coach slot comes last
    fireEvent.click(await screen.findByRole('button', { name: 'draw Away coach signature' }))
    await waitFor(() => expect(stored().awayCoachSignature).toBe(PAD_INK))
  }

  it('a signature given for an edited roster goes when Back restores the roster', async () => {
    storeMatch()
    render(<Setup matchId={1} />)
    await openEditor(1, 2)
    addPlayer({ number: '7', last: 'Golf', first: 'G' })
    await waitFor(() => expect(editorRows()).toHaveLength(3))
    await signAwayCoach()
    back()
    await waitFor(() => expect(stored().awayCoachSignature).toBeNull())
    expect(stored().remarks).toMatch(/Roster of Away V changed after signing.*Coach signature removed/)
    expect(sigJobs().pop().payload.signatures).toMatchObject({ away_coach: '' })
    expect(teamPlayers(12)).toHaveLength(2)
  })

  it('a signature given for the opening roster, and one from before, stay on Back', async () => {
    storeMatch({ awayCaptainSignature: AWAY_CAPT })
    render(<Setup matchId={1} />)
    await openEditor(1, 2)
    await signAwayCoach()
    addPlayer({ number: '7', last: 'Golf', first: 'G' })
    await waitFor(() => expect(editorRows()).toHaveLength(3))
    back()
    await sleep(100)
    expect(stored().awayCoachSignature).toBe(PAD_INK)
    expect(stored().awayCaptainSignature).toBe(AWAY_CAPT)
    expect(stored().remarks).toBe('')
  })

  it('Back after using a sent-ahead roster keeps the signature from before', async () => {
    storeMatch({ homeCoachSignature: AWAY_COACH })
    store.tables.players = new Map()
    sentRosterRow()
    render(<Setup matchId={1} />)
    await screen.findByTestId('sent-roster-home')
    await openEditor(0, 0)
    fireEvent.click(await screen.findByTestId('sent-roster-use-home'))
    await waitFor(() => expect(editorRows()).toHaveLength(7))
    back()
    await sleep(100)
    expect(stored().homeCoachSignature).toBe(AWAY_COACH)
    expect(stored().remarks).toBe('')
  })
})

describe('Match Setup roster editor: a sent-ahead roster', () => {
  it('is stored and marked used only by Save; Back loses nothing', async () => {
    storeMatch()
    store.tables.players = new Map()
    sentRosterRow()
    render(<Setup matchId={1} />)
    await screen.findByTestId('sent-roster-home')
    await openEditor(0, 0)
    fireEvent.click(await screen.findByTestId('sent-roster-use-home'))
    await waitFor(() => expect(editorRows()).toHaveLength(7))
    await sleep(50)
    // nothing stored or spent yet
    expect(stored().sentRosterUsed).toBeUndefined()
    expect(stored().homeCoachSignature).toBeUndefined()
    expect(store.tables.game_rosters.get('991501|home').usedPending).toBeUndefined()

    back()
    await sleep(50)
    expect(stored().sentRosterUsed).toBeUndefined()
    expect(stored().homeCoachSignature).toBeUndefined()
    expect(teamPlayers(11)).toHaveLength(0)
    expect(store.tables.game_rosters.get('991501|home').usedPending).toBeUndefined()

    // used again, and saved
    await openEditor(0, 0)
    fireEvent.click(await screen.findByTestId('sent-roster-use-home'))
    await waitFor(() => expect(editorRows()).toHaveLength(7))
    confirm()
    await waitFor(() => expect(stored().sentRosterUsed).toEqual({ home: SENT_AT }))
    expect(teamPlayers(11)).toHaveLength(7)
    expect(stored().homeCoachSignature).toBe('data:image/png;base64,SENTCOACH')
    expect(stored().homeCaptainSignature).toBe('data:image/png;base64,SENTCAPT')
    expect(store.tables.game_rosters.get('991501|home')?.usedPending ?? true).toBe(true)
    expect(stored().remarks).toBe('')
  })

  it('changed before Save: used, but its signatures are not stored', async () => {
    storeMatch()
    store.tables.players = new Map()
    sentRosterRow()
    render(<Setup matchId={1} />)
    await screen.findByTestId('sent-roster-home')
    await openEditor(0, 0)
    fireEvent.click(await screen.findByTestId('sent-roster-use-home'))
    await waitFor(() => expect(editorRows()).toHaveLength(7))
    addPlayer({ number: '20', last: 'Extra', first: 'X' })
    await waitFor(() => expect(editorRows()).toHaveLength(8))
    confirm()
    await waitFor(() => expect(stored().sentRosterUsed).toEqual({ home: SENT_AT }))
    await sleep(50)
    expect(teamPlayers(11)).toHaveLength(8)
    expect(stored().homeCoachSignature ?? null).toBeNull()
    expect(stored().homeCaptainSignature ?? null).toBeNull()
  })
})
