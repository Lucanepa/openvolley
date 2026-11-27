/**
 * Edit roster › "Roster import" (owner 27.11.2026): one switch, Remote · PDF ·
 * Photo, with only the chosen way's controls below it; the way chosen last is
 * kept on the device; an official game opens on Remote, any other match on
 * PDF, a guest match has no Remote. The other ways (saved team, known
 * players, club, test roster) sit in the header row, Delete roster at its
 * side. The help's "Show me" and the walkthrough find each way's target in
 * every mode, once. Made-up names.
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

import MatchSetup from '../MatchSetup'
import { ScaleProvider } from '../../contexts/ScaleContext'

// As in main.jsx
const Setup = (props) => <ScaleProvider><MatchSetup onStart={() => {}} onReturn={() => {}} {...props} /></ScaleProvider>


const PINS = { refereePin: '111111', homeTeamPin: '222222', awayTeamPin: '333333', homeTeamUploadPin: '444444', awayTeamUploadPin: '555555' }
const KEY = 'ov.rosterImportMode'

function seed(fields = {}) {
  store.tables.matches = new Map([[1, {
    id: 1, status: 'setup', seed_key: 'match_1_import', matchInfoConfirmedAt: '2026-11-27T10:00:00Z',
    homeTeamId: 11, awayTeamId: 12, game_n: 991520, ...PINS, ...fields
  }]])
  store.tables.teams = new Map([[11, { id: 11, name: 'Home V' }], [12, { id: 12, name: 'Away V' }]])
}
async function openEditor(index = 0) {
  fireEvent.click((await screen.findAllByRole('button', { name: 'matchSetup.editRoster' }))[index])
  return screen.findByTestId(index === 0 ? 'roster-import-home' : 'roster-import-away')
}
const radio = (name) => screen.getByRole('radio', { name })
const helpTargets = (id) => document.querySelectorAll(`[data-help-id="${id}"]`)

beforeEach(() => {
  store.tables = {}
  store.nextId = 100
  auth.user = null
  auth.access = undefined
  localStorage.removeItem(KEY)
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.removeItem(KEY)
})

describe('Roster import: Remote · PDF · Photo', () => {
  it('an official game opens on Remote; each way shows only its controls, and the choice is kept', async () => {
    seed()
    render(<Setup matchId={1} />)
    const section = await openEditor()
    expect(within(section).getByText('matchSetup.rosterImport.title').tagName).toBe('H3')
    expect(section.dataset.mode).toBe('remote')
    expect(radio('matchSetup.remote')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('check-server-roster-home')).toBeInTheDocument()
    expect(screen.getByTestId('search-roster-hint-home')).toBeInTheDocument()
    expect(screen.getByText('444444')).toBeInTheDocument() // the upload PIN
    expect(screen.queryByTestId('upload-pdf-home')).toBeNull()
    expect(screen.queryByTestId('roster-photo-take-home')).toBeNull()

    fireEvent.click(radio('matchSetup.rosterImport.pdf'))
    expect(section.dataset.mode).toBe('pdf')
    expect(screen.getByTestId('upload-pdf-home')).toHaveTextContent('matchSetup.uploadPdf')
    expect(screen.getByText('matchSetup.rosterImport.pdfHint')).toBeInTheDocument()
    expect(screen.queryByTestId('check-server-roster-home')).toBeNull()
    expect(screen.queryByTestId('roster-photo-take-home')).toBeNull()
    expect(localStorage.getItem(KEY)).toBe('pdf')

    fireEvent.click(radio('matchSetup.rosterImport.photo'))
    expect(section.dataset.mode).toBe('photo')
    expect(screen.getByTestId('roster-photo-take-home')).toHaveTextContent('rosterPhoto.source.take')
    expect(screen.getByTestId('roster-photo-choose-home')).toHaveTextContent('rosterPhoto.source.choose')
    expect(screen.queryByTestId('upload-pdf-home')).toBeNull()
    expect(screen.queryByTestId('check-server-roster-home')).toBeNull()
    expect(localStorage.getItem(KEY)).toBe('photo')
  })

  it('the way chosen last opens the next roster: the other team, and the next Match setup', async () => {
    seed()
    const first = render(<Setup matchId={1} />)
    await openEditor()
    fireEvent.click(radio('matchSetup.rosterImport.photo'))
    fireEvent.click(screen.getByTestId('roster-back-home'))
    const away = await openEditor(1)
    expect(away.dataset.mode).toBe('photo')
    first.unmount()
    // another Match setup on this device
    render(<Setup matchId={1} />)
    expect((await openEditor()).dataset.mode).toBe('photo')
  })

  it('a test match opens on PDF (a game number of its own is no official game)', async () => {
    seed({ test: true, seed_key: null, game_n: 123456 })
    render(<Setup matchId={1} />)
    expect((await openEditor()).dataset.mode).toBe('pdf')
    expect(radio('matchSetup.rosterImport.pdf')).toHaveAttribute('aria-checked', 'true')
  })

  it('a guest match has no Remote: PDF, also when Remote was chosen last on the device', async () => {
    localStorage.setItem(KEY, 'remote')
    seed({ guest: true, seed_key: null, game_n: null })
    render(<Setup matchId={1} />)
    const section = await openEditor()
    expect(section.dataset.mode).toBe('pdf')
    expect(screen.queryByRole('radio', { name: 'matchSetup.remote' })).toBeNull()
    expect(within(section).getAllByRole('radio')).toHaveLength(2)
  })

  it('"Show me" and the walkthrough find each way once in every mode: its controls, or its segment', async () => {
    seed()
    render(<Setup matchId={1} />)
    await openEditor()
    const once = (id) => { expect(helpTargets(id), id).toHaveLength(1); return helpTargets(id)[0] }
    // Remote chosen: its panel; PDF and Photo: their segments
    expect(once('setup-remote-import').dataset.testid).toBe('roster-import-remote-panel-home')
    expect(once('setup-pdf-import')).toBe(radio('matchSetup.rosterImport.pdf'))
    expect(once('setup-photo-import')).toBe(radio('matchSetup.rosterImport.photo'))
    fireEvent.click(radio('matchSetup.rosterImport.pdf'))
    expect(once('setup-pdf-import')).toBe(screen.getByTestId('upload-pdf-home'))
    expect(once('setup-remote-import')).toBe(radio('matchSetup.remote'))
    fireEvent.click(radio('matchSetup.rosterImport.photo'))
    expect(once('setup-photo-import').contains(screen.getByTestId('roster-photo-take-home'))).toBe(true)
    expect(once('setup-pdf-import')).toBe(radio('matchSetup.rosterImport.pdf'))
  })

  it('Photo: "Take a photo" opens the camera at once, no source step first', async () => {
    seed()
    render(<Setup matchId={1} />)
    await openEditor()
    fireEvent.click(radio('matchSetup.rosterImport.photo'))
    const camera = screen.getByTestId('roster-photo-camera-home')
    const opened = vi.spyOn(camera, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByTestId('roster-photo-take-home'))
    expect(opened).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('roster-photo-source')).toBeNull()
  })

  it('the other ways sit in the header row, Delete roster at its side', async () => {
    seed({ test: true, seed_key: null })
    render(<Setup matchId={1} />)
    await openEditor()
    const ways = screen.getByTestId('roster-ways-home')
    expect(ways).toHaveAttribute('role', 'group')
    expect(ways).toHaveAttribute('aria-label', 'matchSetup.rosterWays')
    expect(within(ways).getByTestId('choose-players-home')).toBeInTheDocument()
    expect(within(ways).getByTestId('load-test-roster-home')).toBeInTheDocument()
    const del = screen.getByTestId('delete-roster-home')
    expect(ways.contains(del)).toBe(false)
    expect(del).toHaveTextContent('roster.deleteRoster')
    expect(screen.getByTestId('roster-import-home').contains(ways)).toBe(false)
  })

  it('the uploaded roster\'s notice opens Remote for that team, and keeps the way chosen on the device', async () => {
    localStorage.setItem(KEY, 'photo')
    seed({
      pendingHomeRoster: {
        players: [{ number: 4, firstName: 'Anna', lastName: 'Upload', dob: '14/03/2008', libero: '', isCaptain: true }],
        bench: [{ role: 'Coach', firstName: 'Hans', lastName: 'Upload', dob: '' }],
        timestamp: '2026-11-27T09:30:00.000Z'
      }
    })
    render(<Setup matchId={1} />)
    fireEvent.click(await screen.findByRole('button', { name: 'matchSetup.uploadedRosterOpen' }))
    expect((await screen.findByTestId('roster-import-home')).dataset.mode).toBe('remote')
    expect(await screen.findByTestId('pending-roster-home')).toBeInTheDocument()
    expect(localStorage.getItem(KEY)).toBe('photo')
  })
})
