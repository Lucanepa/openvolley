/**
 * A photo of the list goes straight into the roster editor (owner 27.11.2026:
 * "just already import them in the official roster and fix there"): the
 * fields the reading was unsure of are marked on the editor's own rows (red =
 * fix, amber = check) until the scorer changes them; the banner on top names
 * the rows struck out, shows the reading's time and offers Undo (the roster
 * and bench officials as before). The marks are UI state only: a Save stores
 * none of them. The photo dialog is a stand-in here (its own tests cover it).
 * Made-up people.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => String(typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en', changeLanguage: () => Promise.resolve() }
  })
}))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn(), showConfirm: vi.fn() }) }))
const auth = vi.hoisted(() => ({ user: null, access: undefined }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.user, profile: null, getCachedProfile: () => null, access: auth.access }) }))

// useLiveQuery: run the query once per deps change (no Dexie observation)
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

// In-memory Dexie stand-in: get/update/add on rows, empty collections otherwise
const store = vi.hoisted(() => ({ tables: {}, nextId: 1 }))
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
    update: async (id, changes) => { const r = rowsOf(name).get(id); if (!r) return 0; rowsOf(name).set(id, { ...r, ...changes }); return 1 },
    delete: async (id) => { rowsOf(name).delete(id) },
    toArray: async () => [...rowsOf(name).values()],
    count: async () => rowsOf(name).size,
    // players: by team (the roster editor reads them), club_players by account; empty otherwise
    where: (field) => name === 'players' || name === 'club_players'
      ? { equals: (v) => collection([...rowsOf(name).values()].filter((r) => r[field] === v)) }
      : collection([]),
    orderBy: () => collection([]),
    filter: () => collection([]),
    clear: async () => rowsOf(name).clear(),
    hook: () => {} // useSyncQueue installs a 'creating' hook on sync_queue at module load
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
    // useSyncQueue (via utils/syncToast) installs its auth listeners at module load
    AUTH_TOKEN_CHANGE_EVENT: 'ov-test-auth-token-change',
    AUTH_TOKEN_STORAGE_KEY: 'api_auth_token',
    apiMatchRestore: () => chain(),
    apiMatchClaim: () => chain()
  }
})
vi.mock('../../utils/logger', () => ({ uploadBackupToCloud: vi.fn(), uploadLogsToCloud: vi.fn() }))
vi.mock('../../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import

// the photo dialog: a stand-in that hands MatchSetup a reading, as the real one does after "Read the list"
const photo = vi.hoisted(() => ({ roster: null, meta: { readMs: 11400 } }))
vi.mock('../rosterPhoto/RosterPhotoImport', () => ({
  default: ({ side, onApply }) => <button type="button" data-testid={`fake-photo-read-${side}`} onClick={() => onApply(photo.roster, photo.meta)}>read</button>
}))
import MatchSetup from '../MatchSetup'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { importedRosterOf } from '../../domain/importedRoster'

const Setup = (props) => <ScaleProvider><MatchSetup onStart={() => {}} onReturn={() => {}} {...props} /></ScaleProvider>
const PINS = { refereePin: '111111', homeTeamPin: '222222', awayTeamPin: '333333', homeTeamUploadPin: '444444', awayTeamUploadPin: '555555' }

const sure = { number: 0.95, licence: 0.95, firstName: 0.95, lastName: 0.95 }
const P = (number, lastName, firstName, licence, extra = {}) => ({ number, lastName, firstName, licence, confidence: sure, ...extra })
// six players: one last name hard to read, one with no licence; the coach's first name unsure; a row struck out
function reading ({ duplicate = false, count = 6 } = {}) {
  const players = [
    P(1, 'Exempel', 'Lia', '123451', { isCaptain: true }),
    P(duplicate ? 1 : 2, 'Muslr', 'Noa', '123452', { confidence: { ...sure, lastName: 0.4 } }),
    P(3, 'Probe', 'Ida', ''),
    P(4, 'Beispiel', 'Mia', '123454'),
    P(5, 'Muster', 'Zoe', '123455'),
    P(6, 'Fiktiv', 'Ana', '123456')
  ]
  for (let n = 7; n <= count; n++) players.push(P(n, `Extra${n}`, 'Eva', String(123400 + n)))
  return importedRosterOf({
    players,
    coach: { firstName: 'Hxns', lastName: 'Trainer', licence: '10001', confidence: { firstName: 0.3, lastName: 0.95, licence: 0.95 } },
    struck: [{ firstName: 'Rita', lastName: 'Gestrichen', licence: '123459' }]
  }, 'ocr')
}

function seed () {
  store.tables.matches = new Map([[1, {
    id: 1, status: 'setup', test: true, seed_key: null, matchInfoConfirmedAt: '2026-11-27T10:00:00Z',
    homeTeamId: 11, awayTeamId: 12, game_n: null, ...PINS,
    bench_home: [{ role: 'Coach', firstName: 'Old', lastName: 'Coach', dob: '' }]
  }]])
  store.tables.teams = new Map([[11, { id: 11, name: 'Home V' }], [12, { id: 12, name: 'Away V' }]])
  store.tables.players = new Map([
    [201, { id: 201, teamId: 11, number: 10, lastName: 'Vorher', firstName: 'Vera', dob: '', libero: '', isCaptain: true }],
    [202, { id: 202, teamId: 11, number: 11, lastName: 'Bisher', firstName: 'Ben', dob: '', libero: '', isCaptain: false }]
  ])
}
async function openPhoto () {
  render(<Setup matchId={1} />)
  fireEvent.click((await screen.findAllByRole('button', { name: 'matchSetup.editRoster' }))[0])
  await screen.findByTestId('roster-import-home')
  fireEvent.click(screen.getByRole('radio', { name: 'matchSetup.rosterImport.photo' }))
}
const lastNames = () => [...document.querySelectorAll('.roster-grid:not(.roster-add) input.cell-last')].map((i) => i.value)
const rowInput = (lastName, cls) => [...document.querySelectorAll('.roster-grid:not(.roster-add) .roster-grid-row')]
  .find((r) => r.querySelector('input.cell-last')?.value === lastName)?.querySelector(cls)
const benchInput = (cls) => document.querySelector(`.bench-grid .bench-grid-row:not(.grid-header) input.${cls}`)
const marked = () => [...document.querySelectorAll('[data-photo-mark]')]

beforeEach(() => {
  store.tables = {}
  store.nextId = 1000
  auth.user = null
  auth.access = undefined
  photo.roster = reading()
  photo.meta = { readMs: 11400 }
  localStorage.removeItem('ov.rosterImportMode')
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a photo straight into the roster', () => {
  it('is applied at once (no check screen): the players, the coach; the banner counts, names the struck row, shows the time', async () => {
    seed()
    await openPhoto()
    fireEvent.click(screen.getByTestId('fake-photo-read-home'))
    await waitFor(() => expect(lastNames()).toEqual(['Exempel', 'Muslr', 'Probe', 'Beispiel', 'Muster', 'Fiktiv']))
    expect(benchInput('cell-first').value).toBe('Hxns')
    // no import summary dialog: the banner says it
    expect(screen.queryByText('matchSetup.importSummary')).toBeNull()
    const banner = screen.getByTestId('photo-import-banner-home')
    expect(within(banner).getByTestId('photo-import-summary-home')).toHaveTextContent('rosterPhoto.applied.summary')
    expect(within(banner).getByTestId('photo-import-summary-home')).toHaveTextContent('rosterPhoto.confirm.toCheck')
    expect(within(banner).getByTestId('photo-import-struck-home')).toHaveTextContent('rosterPhoto.confirm.struck')
    expect(within(banner).getByTestId('photo-import-method-home')).toHaveTextContent('rosterPhoto.confirm.readIn')
    expect(lastNames()).not.toContain('Gestrichen')
  })

  it('marks the unsure fields on the rows (also the coach), and a field\'s mark goes once it is changed', async () => {
    seed()
    photo.roster = reading({ duplicate: true })
    await openPhoto()
    fireEvent.click(screen.getByTestId('fake-photo-read-home'))
    await waitFor(() => expect(lastNames()).toContain('Muslr'))
    expect(rowInput('Muslr', 'input.cell-last')).toHaveAttribute('data-photo-mark', 'low')
    expect(rowInput('Muslr', 'input.cell-last').title).toBe('rosterPhoto.issue.unsure')
    // 1 twice: both numbers red
    expect(rowInput('Exempel', 'input.cell-head')).toHaveAttribute('data-photo-mark', 'invalid')
    expect(rowInput('Muslr', 'input.cell-head')).toHaveAttribute('data-photo-mark', 'invalid')
    // no licence read: its field amber
    expect(rowInput('Probe', '.cell-dob input')).toHaveAttribute('data-photo-mark', 'low')
    expect(benchInput('cell-first')).toHaveAttribute('data-photo-mark', 'low')
    expect(screen.getByTestId('photo-import-summary-home')).toHaveTextContent('rosterPhoto.confirm.toFix')

    // the scorer corrects the last name: its mark goes, the row's red number stays
    fireEvent.change(rowInput('Muslr', 'input.cell-last'), { target: { value: 'Musler' } })
    expect(rowInput('Musler', 'input.cell-last')).not.toHaveAttribute('data-photo-mark')
    expect(rowInput('Musler', 'input.cell-head')).toHaveAttribute('data-photo-mark', 'invalid')
    fireEvent.change(benchInput('cell-first'), { target: { value: 'Hans' } })
    expect(benchInput('cell-first')).not.toHaveAttribute('data-photo-mark')
  })

  it('the banner goes once no mark is left, or when dismissed', async () => {
    seed()
    await openPhoto()
    fireEvent.click(screen.getByTestId('fake-photo-read-home'))
    await screen.findByTestId('photo-import-banner-home')
    fireEvent.change(rowInput('Muslr', 'input.cell-last'), { target: { value: 'Musler' } })
    fireEvent.change(rowInput('Probe', '.cell-dob input'), { target: { value: '123453' } })
    expect(screen.getByTestId('photo-import-banner-home')).toBeInTheDocument()
    fireEvent.change(benchInput('cell-first'), { target: { value: 'Hans' } })
    expect(marked()).toHaveLength(0)
    expect(screen.queryByTestId('photo-import-banner-home')).toBeNull()

    // another reading, dismissed: the banner goes, the marks stay on the rows
    fireEvent.click(screen.getByTestId('fake-photo-read-home'))
    await screen.findByTestId('photo-import-banner-home')
    fireEvent.click(screen.getByTestId('photo-import-dismiss-home'))
    expect(screen.queryByTestId('photo-import-banner-home')).toBeNull()
    expect(marked().length).toBeGreaterThan(0)
  })

  it('Undo puts back the roster and the bench officials as they were before the photo', async () => {
    seed()
    await openPhoto()
    await waitFor(() => expect(lastNames()).toEqual(['Vorher', 'Bisher']))
    fireEvent.click(screen.getByTestId('fake-photo-read-home'))
    await waitFor(() => expect(lastNames()).toHaveLength(6))
    fireEvent.click(screen.getByTestId('photo-import-undo-home'))
    await waitFor(() => expect(lastNames()).toEqual(['Vorher', 'Bisher']))
    expect(benchInput('cell-last').value).toBe('Coach')
    expect(benchInput('cell-first').value).toBe('Old')
    expect(marked()).toHaveLength(0)
    expect(screen.queryByTestId('photo-import-banner-home')).toBeNull()
  })

  it('a Save stores none of the marks: players field by field, the bench, the match and the sync jobs without them', async () => {
    seed()
    await openPhoto()
    fireEvent.click(screen.getByTestId('fake-photo-read-home'))
    await waitFor(() => expect(lastNames()).toHaveLength(6))
    expect(marked().length).toBeGreaterThan(0)
    fireEvent.click(screen.getByTestId('roster-confirm-home'))
    await waitFor(() => expect([...store.tables.players.values()].filter((p) => p.teamId === 11).map((p) => p.lastName).sort())
      .toEqual(['Beispiel', 'Exempel', 'Fiktiv', 'Muslr', 'Muster', 'Probe']))
    const stored = [...store.tables.players.values()]
    const match = store.tables.matches.get(1)
    const jobs = [...(store.tables.sync_queue?.values() || [])]
    for (const row of [...stored, ...(match.bench_home || [])]) {
      expect(Object.getOwnPropertySymbols(row)).toEqual([])
      expect(Object.keys(row).filter((k) => /photo|mark|issue|confidence/i.test(k))).toEqual([])
    }
    const text = JSON.stringify({ stored, match, jobs })
    expect(text).not.toMatch(/photo|unsure|missingLicence|confidence|"low"|"invalid"/i)
  })

  it('a list of more than 14: who plays is ticked first, and the ticked rows keep their marks', async () => {
    seed()
    photo.roster = reading({ count: 16 })
    await openPhoto()
    fireEvent.click(screen.getByTestId('fake-photo-read-home'))
    const rows = await screen.findAllByTestId('player-pool-row')
    expect(rows).toHaveLength(16)
    // untick the last two
    fireEvent.click(rows[14])
    fireEvent.click(rows[15])
    fireEvent.click(screen.getByTestId('player-pool-apply'))
    await waitFor(() => expect(lastNames()).toHaveLength(14))
    expect(rowInput('Muslr', 'input.cell-last')).toHaveAttribute('data-photo-mark', 'low')
    expect(screen.getByTestId('photo-import-banner-home')).toBeInTheDocument()
  })
})
