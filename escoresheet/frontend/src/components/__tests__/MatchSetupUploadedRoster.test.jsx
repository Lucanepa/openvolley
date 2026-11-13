/**
 * A roster a team uploaded (Upload Roster app, or a relay), waiting in Match
 * Setup: checked again before Preview and Accept (domain/uploadedRoster),
 * Accept only before the coin toss and after the usual question when the
 * team has players already, the players replaced in one transaction, an
 * uploaded signature only into an empty slot; Reject always. Made-up names.
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
const confirmReplace = vi.hoisted(() => ({ fn: null }))
vi.mock('../SavedTeamPickerModal', async (importOriginal) => {
  const orig = await importOriginal()
  return { ...orig, confirmReplaceRoster: (...args) => confirmReplace.fn(...args) }
})

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

// In-memory Dexie stand-in; a transaction runs its function and keeps the
// tables as they were when it throws
const store = vi.hoisted(() => ({ tables: {}, nextId: 1, failBulkAdd: false }))
vi.mock('../../db/db', () => {
  const rowsOf = (name) => (store.tables[name] ||= new Map())
  const collection = (name, rows) => {
    const c = {
      equals: () => c, above: () => c, below: () => c, anyOf: () => c, between: () => c,
      filter: () => c, and: () => c, reverse: () => c, limit: () => c, offset: () => c,
      toArray: async () => rows, sortBy: async () => rows, first: async () => rows[0],
      last: async () => rows[rows.length - 1], count: async () => rows.length,
      modify: async () => 0, each: async () => {}, primaryKeys: async () => rows.map((r) => r.id),
      delete: async () => { for (const r of rows) rowsOf(name).delete(r.id); return rows.length }
    }
    return c
  }
  const table = (name) => ({
    get: async (id) => rowsOf(name).get(id),
    add: async (row) => { const id = row?.id ?? store.nextId++; rowsOf(name).set(id, { ...row, id }); return id },
    put: async (row) => { const id = row?.id ?? store.nextId++; rowsOf(name).set(id, { ...row, id }); return id },
    bulkAdd: async (rows) => {
      if (name === 'players' && store.failBulkAdd) throw new Error('bulkAdd failed (test)')
      for (const r of rows) await table(name).add(r)
    },
    update: async (id, changes) => { const r = rowsOf(name).get(id); if (!r) return 0; rowsOf(name).set(id, { ...r, ...changes }); return 1 },
    delete: async (id) => { rowsOf(name).delete(id) },
    toArray: async () => [...rowsOf(name).values()],
    count: async () => rowsOf(name).size,
    where: (field) => (name === 'players' || name === 'events' || name === 'club_players')
      ? { equals: (v) => collection(name, [...rowsOf(name).values()].filter((r) => r[field] === v)) }
      : collection(name, []),
    orderBy: () => collection(name, []),
    filter: () => collection(name, []),
    clear: async () => rowsOf(name).clear(),
    hook: () => {}
  })
  const db = new Proxy({}, {
    get: (_, prop) => {
      if (prop === 'transaction') {
        return async (...args) => {
          const before = Object.fromEntries(Object.entries(store.tables).map(([k, m]) => [k, new Map(m)]))
          try {
            return await args[args.length - 1]()
          } catch (err) {
            store.tables = before
            throw err
          }
        }
      }
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
vi.mock('../../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import

import MatchSetup from '../MatchSetup'
import { ScaleProvider } from '../../contexts/ScaleContext'

const Setup = (props) => <ScaleProvider><MatchSetup onStart={() => {}} onReturn={() => {}} {...props} /></ScaleProvider>
const PINS = { refereePin: '111111', homeTeamPin: '222222', awayTeamPin: '333333', homeTeamUploadPin: '444444', awayTeamUploadPin: '555555' }
const PNG = (tag) => `data:image/png;base64,${btoa(`png-${tag}`).replace(/=+$/, '')}`
const HALL = [2, 5, 8, 11, 14, 17]

const UPLOAD = {
  players: [
    { number: 4, firstName: 'Anna', lastName: 'Upload', dob: '14/03/2008', libero: '', isCaptain: true },
    { number: 9, firstName: 'Eva', lastName: 'Upload', dob: '02/03/2009', libero: 'libero1', isCaptain: false }
  ],
  bench: [{ role: 'Coach', firstName: 'Hans', lastName: 'Upload', dob: '' }],
  coachSignature: PNG('upload-coach'),
  captainSignature: PNG('upload-captain'),
  timestamp: '2026-11-12T18:30:00.000Z'
}

function seed({ status = 'setup', pending = UPLOAD, ...fields } = {}) {
  store.tables.matches = new Map([[1, {
    id: 1, status, seed_key: 'match_1_up', matchInfoConfirmedAt: '2026-11-12T17:00:00Z',
    homeTeamId: 11, awayTeamId: 12, homeName: 'Home V', awayName: 'Away V', game_n: 991501, ...PINS,
    homeCoachSignature: PNG('hall-coach'), homeCaptainSignature: null,
    bench_home: [{ role: 'Coach', firstName: 'Hall', lastName: 'Coach', dob: '' }],
    pendingHomeRoster: pending,
    ...fields
  }]])
  store.tables.teams = new Map([[11, { id: 11, name: 'Home V' }], [12, { id: 12, name: 'Away V' }]])
  store.tables.players = new Map(HALL.map((n, i) => [201 + i, { id: 201 + i, teamId: 11, number: n, lastName: `Hall${n}`, firstName: 'P', isCaptain: i === 0 }]))
}
const homeNumbers = () => [...store.tables.players.values()].filter((p) => p.teamId === 11).map((p) => p.number).sort((a, b) => a - b)
const clearJobs = () => [...(store.tables.sync_queue?.values() || [])].filter((j) => j.payload?.connections && 'pending_home_roster' in j.payload.connections)

// Edit roster -> Remote: the card of the team's upload
async function openCard() {
  render(<Setup matchId={1} />)
  fireEvent.click((await screen.findAllByRole('button', { name: 'matchSetup.editRoster' }))[0])
  fireEvent.click(await screen.findByRole('radio', { name: 'matchSetup.remote' }))
  await screen.findByText('matchSetup.rosterUploaded')
  return screen.getByText('matchSetup.rosterUploaded').parentElement
}

beforeEach(() => {
  store.tables = {}
  store.nextId = 1000
  store.failBulkAdd = false
  confirmReplace.fn = vi.fn(async () => true)
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Match Setup: an uploaded roster', () => {
  it('Accept asks, then replaces the players in one go; an uploaded signature fills an empty slot only', async () => {
    seed()
    await openCard()
    fireEvent.click(screen.getByRole('button', { name: 'matchSetup.acceptRoster' }))
    await waitFor(() => expect(store.tables.matches.get(1).pendingHomeRoster).toBeNull())
    expect(confirmReplace.fn).toHaveBeenCalledTimes(1)
    expect(homeNumbers()).toEqual([4, 9])
    // (the setup's auto-save writes the bench again from the screen, now the uploaded one)
    await waitFor(() => expect(store.tables.matches.get(1).bench_home).toEqual([{ role: 'Coach', firstName: 'Hans', lastName: 'Upload', dob: '' }]), { timeout: 3000 })
    const m = store.tables.matches.get(1)
    expect(m.homeCoachSignature).toBe(PNG('hall-coach')) // the match's own stays
    expect(m.homeCaptainSignature).toBe(PNG('upload-captain')) // the empty one is filled
    expect(clearJobs()).toHaveLength(1)
  })

  it('Accept answered "no" changes nothing', async () => {
    seed()
    confirmReplace.fn = vi.fn(async () => false)
    await openCard()
    fireEvent.click(screen.getByRole('button', { name: 'matchSetup.acceptRoster' }))
    await waitFor(() => expect(confirmReplace.fn).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 50))
    expect(homeNumbers()).toEqual(HALL)
    expect(store.tables.matches.get(1).pendingHomeRoster).toBeTruthy()
  })

  it('a failed write leaves the roster as it was', async () => {
    seed()
    store.failBulkAdd = true
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await openCard()
    fireEvent.click(screen.getByRole('button', { name: 'matchSetup.acceptRoster' }))
    expect(await screen.findByText('matchSetup.uploadedRosterSaveFailed')).toBeTruthy()
    expect(homeNumbers()).toEqual(HALL)
    expect(store.tables.matches.get(1).pendingHomeRoster).toBeTruthy()
  })

  it('a running match: only Reject, the played roster stays', async () => {
    seed({ status: 'live' })
    const card = await openCard()
    expect(card.textContent).toContain('matchSetup.uploadedRosterStarted')
    expect(screen.queryByRole('button', { name: 'matchSetup.acceptRoster' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'matchSetup.rejectRoster' }))
    await waitFor(() => expect(store.tables.matches.get(1).pendingHomeRoster).toBeNull())
    expect(homeNumbers()).toEqual(HALL)
    expect(store.tables.matches.get(1).homeCoachSignature).toBe(PNG('hall-coach'))
  })

  for (const [what, pending] of [
    ['players that are no list', { players: 'x', bench: [] }],
    ['objects as number and name', { players: [{ number: {}, lastName: {} }], bench: [] }],
    ['a bench role "constructor"', { players: [], bench: [{ role: 'constructor', lastName: 'X' }] }],
    ['two captains and "Libero 1" twice', { players: [{ number: 1, isCaptain: true, libero: 'libero1' }, { number: 2, isCaptain: true, libero: 'libero1' }], bench: [] }],
    ['a link as a signature', { ...UPLOAD, coachSignature: 'https://tracker.example/s.png' }]
  ]) {
    it(`refused (${what}): no Preview, no Accept, Reject clears it`, async () => {
      seed({ pending })
      const card = await openCard()
      expect(card.textContent).toContain('matchSetup.uploadedRosterInvalid')
      expect(screen.queryByRole('button', { name: 'matchSetup.previewRoster' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'matchSetup.acceptRoster' })).toBeNull()
      expect(document.querySelector('img[src^="https://"]')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'matchSetup.rejectRoster' }))
      await waitFor(() => expect(store.tables.matches.get(1).pendingHomeRoster).toBeNull())
      expect(homeNumbers()).toEqual(HALL)
      expect(clearJobs()).toHaveLength(1)
    })
  }

  it('the main view says a roster waits and opens its card', async () => {
    seed()
    render(<Setup matchId={1} />)
    fireEvent.click(await screen.findByRole('button', { name: 'matchSetup.uploadedRosterOpen' }))
    expect(await screen.findByTestId('pending-roster-home')).toBeTruthy()
  })

  it('Preview shows the dates of birth, the libero slots and what the team signed', async () => {
    seed()
    await openCard()
    fireEvent.click(screen.getByRole('button', { name: 'matchSetup.previewRoster' }))
    expect(await screen.findByText('14/03/2008')).toBeTruthy()
    expect(screen.getByText('L1')).toBeTruthy()
    expect(screen.getByAltText('Coach signature').getAttribute('src')).toBe(PNG('upload-coach'))
    expect(screen.getByAltText('Captain signature').getAttribute('src')).toBe(PNG('upload-captain'))
  })
})
