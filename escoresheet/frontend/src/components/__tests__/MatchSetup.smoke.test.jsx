/**
 * Smoke render of Match Setup: a new (empty) match and a created
 * (matchInfoConfirmedAt) match mount without throwing (a use-before-declare
 * crash once showed only "Something went wrong" in the browser), and the
 * once-per-match connection-PIN sync is queued only when it is needed.
 * The roster editor keeps a row in its place while its number is typed.
 * Choose players in the roster editor writes nothing before its Save.
 * A roster of more than 14 players is not ready for the coin toss.
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
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: null, profile: null, getCachedProfile: () => null }) }))

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
    // players: by team (the roster editor reads them); empty otherwise
    where: (field) => name === 'players'
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

const queued = () => [...(store.tables.sync_queue?.values() || [])]
const pinJobs = () => queued().filter((j) => j.resource === 'match' && j.action === 'update' && j.payload?.connection_pins)

beforeEach(() => {
  store.tables = {}
  store.nextId = 100
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const PINS = { refereePin: '111111', homeTeamPin: '222222', awayTeamPin: '333333', homeTeamUploadPin: '444444', awayTeamUploadPin: '555555' }

describe('MatchSetup smoke render', () => {
  it('renders a new, empty match', async () => {
    store.tables.matches = new Map([[1, { id: 1, status: 'setup', seed_key: 'match_1_new', ...PINS }]])
    render(<Setup matchId={1} />)
    expect(await screen.findAllByText('matchSetup.date')).not.toHaveLength(0) // the match info card rendered
    expect(screen.queryByText(/Something went wrong/i)).toBeNull()
    expect(pinJobs()).toHaveLength(0) // not created yet: nothing on the server to update
  })

  // City, hall and league (the competition) showed CSS-capitalized text
  // while the match stored it as typed ("zürich" shown "Zürich"), and Title
  // Case placeholders ("Enter City"). Values are shown as typed (parity with
  // OpenBeach 872eb48).
  it('city, hall and league are shown as typed (no CSS capitalize)', async () => {
    store.tables.matches = new Map([[1, { id: 1, status: 'setup', seed_key: 'match_1_new', ...PINS }]])
    render(<Setup matchId={1} />)
    // the match info form (opened from the info card)
    fireEvent.click(await screen.findByRole('button', { name: 'matchSetup.createMatch' }))
    for (const label of ['matchSetup.city', 'matchSetup.hall', 'matchSetup.league']) {
      const input = await screen.findByLabelText(label)
      expect(input.className).not.toMatch(/capitalize/)
      // nor on a wrapper of the field
      expect(input.closest('.capitalize')).toBeNull()
    }
  })

  it('renders a created match and queues its connection PINs once', async () => {
    store.tables.matches = new Map([[1, {
      id: 1, status: 'setup', seed_key: 'match_1_conf', matchInfoConfirmedAt: '2026-10-06T10:00:00Z',
      homeName: 'Home V', awayName: 'Away V', game_n: 991404, ...PINS
    }]])
    const first = render(<Setup matchId={1} />)
    await waitFor(() => expect(pinJobs()).toHaveLength(1))
    expect(pinJobs()[0].payload.id).toBe('match_1_conf')
    await waitFor(() => expect(store.tables.matches.get(1).connectionPinsQueuedAt).toBeTruthy())
    first.unmount()

    // Opened again: the PINs are already queued, no second server write
    render(<Setup matchId={1} />)
    await new Promise((r) => setTimeout(r, 50))
    expect(pinJobs()).toHaveLength(1)
    expect(screen.queryByText(/Something went wrong/i)).toBeNull()
  })

  // The colour picker's Custom tile: a hex picked there is saved on the team
  // and the match, and the team's shirt and number are drawn with it; a
  // saved colour that is none of the twelve presets selects the Custom tile.
  describe('custom team colour', () => {
    const created = (homeColor, awayColor = '#3b82f6') => {
      store.tables.matches = new Map([[1, {
        id: 1, status: 'setup', seed_key: 'match_1_col', matchInfoConfirmedAt: '2026-10-06T10:00:00Z',
        homeTeamId: 11, awayTeamId: 12, game_n: 991405, ...PINS
      }]])
      store.tables.teams = new Map([
        [11, { id: 11, name: 'Home V', color: homeColor }],
        [12, { id: 12, name: 'Away V', color: awayColor }]
      ])
    }
    const shirtsOf = (colour) => [...document.querySelectorAll('.shirt')].filter((el) => el.dataset.color === colour)
    const rgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`

    it('picking a custom hex saves it and the card shirt and number render with it', async () => {
      const { readableTextOn } = await import('../../utils/teamColours')
      created('#dc2626')
      render(<Setup matchId={1} />)
      // the stored team is loaded: a shirt in the default red shows before that
      await screen.findAllByText('Home V')
      await waitFor(() => expect(shirtsOf('#dc2626').length).toBeGreaterThan(0))
      fireEvent.click(shirtsOf('#dc2626')[0])
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(dialog.querySelector('[data-custom-tile]'))
      fireEvent.change(screen.getByLabelText('matchSetup.customColourHex'), { target: { value: '#0E7490' } })
      fireEvent.click(screen.getByRole('button', { name: 'matchSetup.applyColour' }))

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await waitFor(() => expect(store.tables.teams.get(11).color).toBe('#0e7490'))
      expect(store.tables.matches.get(1).homeColor).toBe('#0e7490')
      const shirt = shirtsOf('#0e7490')[0]
      expect(shirt).toBeTruthy()
      expect(shirt.querySelector('[data-part="body"]').getAttribute('fill')).toBe('#0e7490')
      expect(shirt.querySelector('.number').style.color).toBe(rgb(readableTextOn('#0e7490')))
      expect(shirtsOf('#dc2626')).toHaveLength(0)
    })

    it('a saved colour that is none of the presets selects the Custom tile, showing it', async () => {
      created('#7b1e2b')
      render(<Setup matchId={1} />)
      await waitFor(() => expect(shirtsOf('#7b1e2b').length).toBeGreaterThan(0))
      fireEvent.click(shirtsOf('#7b1e2b')[0])
      const dialog = await screen.findByRole('dialog')
      const custom = dialog.querySelector('[data-custom-tile]')
      expect(custom.getAttribute('aria-pressed')).toBe('true')
      expect(custom.getAttribute('aria-label')).toBe('matchSetup.customColour #7b1e2b')
      expect(custom.querySelector('.shirt').dataset.color).toBe('#7b1e2b')
      expect(dialog.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1)
    })

    it('a new match opens the picker on the red / light blue presets, not on Custom', async () => {
      const { DEFAULT_HOME_COLOUR, DEFAULT_AWAY_COLOUR, presetColour } = await import('../../utils/teamColours')
      expect(presetColour(DEFAULT_HOME_COLOUR)).toBeTruthy()
      expect(presetColour(DEFAULT_AWAY_COLOUR)).toBeTruthy()
      store.tables.matches = new Map([[1, { id: 1, status: 'setup', seed_key: 'match_1_new', ...PINS }]])
      render(<Setup matchId={1} />)
      for (const colour of ['#dc2626', '#3b82f6']) {
        await waitFor(() => expect(shirtsOf(colour).length).toBeGreaterThan(0))
        fireEvent.click(shirtsOf(colour)[0])
        const dialog = await screen.findByRole('dialog')
        expect(dialog.querySelector('[data-custom-tile]').getAttribute('aria-pressed'), colour).toBe('false')
        expect(within(dialog).getByRole('button', { name: `Select colour ${colour}` }).getAttribute('aria-pressed'), colour).toBe('true')
        fireEvent.keyDown(document, { key: 'Escape' })
        cleanup()
        render(<Setup matchId={1} />)
      }
      expect(shirtsOf('#ef4444')).toHaveLength(0)
    })

    it('two close team colours get the gentle note on the setup cards', async () => {
      created('#dc2626', '#e2001a')
      render(<Setup matchId={1} />)
      await waitFor(() => expect(shirtsOf('#e2001a').length).toBeGreaterThan(0))
      expect((await screen.findAllByText('matchSetup.closeToOtherTeamColour')).length).toBeGreaterThan(0)
    })
  })

  // Typing "1" then "5" in a row's number moved the row (demo recording,
  // 2026-10-21): it is sorted once focus leaves the list, so the Tab to its
  // last name stays on that player
  it('the roster editor keeps a row in place while its number is typed, and sorts when focus leaves the list', async () => {
    store.tables.matches = new Map([[1, {
      id: 1, status: 'setup', seed_key: 'match_1_roster', matchInfoConfirmedAt: '2026-10-06T10:00:00Z',
      homeTeamId: 11, awayTeamId: 12, game_n: 991406, ...PINS
    }]])
    store.tables.teams = new Map([[11, { id: 11, name: 'Home V' }], [12, { id: 12, name: 'Away V' }]])
    store.tables.players = new Map([
      [201, { id: 201, teamId: 11, number: 2, lastName: 'Alpha', firstName: 'A' }],
      [202, { id: 202, teamId: 11, number: 5, lastName: 'Bravo', firstName: 'B' }],
      [203, { id: 203, teamId: 11, number: 8, lastName: 'Charlie', firstName: 'C' }],
      [204, { id: 204, teamId: 11, number: 11, lastName: 'Delta', firstName: 'D' }],
      [205, { id: 205, teamId: 11, number: 14, lastName: 'Echo', firstName: 'E' }]
    ])
    render(<Setup matchId={1} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'matchSetup.editRoster' }))[0])
    const grid = await waitFor(() => {
      const g = document.querySelector('.roster-grid:not(.roster-add)')
      expect(g.querySelectorAll('input.cell-last')).toHaveLength(5)
      return g
    })
    const numbers = () => [...grid.querySelectorAll('input[aria-label="Player number"]')]
    const lastNames = () => [...grid.querySelectorAll('input.cell-last')].map((i) => i.value)
    expect(lastNames()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'])

    const charlie = numbers()[2]
    charlie.focus()
    fireEvent.focusIn(charlie)
    fireEvent.change(charlie, { target: { value: '1' } })
    expect(lastNames()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'])
    fireEvent.change(charlie, { target: { value: '15' } })
    expect(numbers()[2]).toBe(charlie)
    expect(charlie.value).toBe('15')
    // On to its last name (focus stays in the list): still Charlie's row
    const charlieLast = grid.querySelectorAll('input.cell-last')[2]
    fireEvent.focusOut(charlie, { relatedTarget: charlieLast })
    charlieLast.focus()
    expect(lastNames()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'])
    expect(document.activeElement.value).toBe('Charlie')

    // Focus leaves the list: sorted by number
    fireEvent.focusOut(charlieLast, { relatedTarget: null })
    await waitFor(() => expect(lastNames()).toEqual(['Alpha', 'Bravo', 'Delta', 'Echo', 'Charlie']))
    expect(numbers().map((i) => i.value)).toEqual(['2', '5', '11', '14', '15'])
  })

  // Stress test 2026-10-25: '1.5' typed with a tablet keypad's '.' (meant as
  // 15) passed the editor and its Confirm; the cloud then refused every rally
  // that player served (events.serve_player is an integer column)
  it('a shirt number keeps only its digits, and Confirm refuses one that is not a whole number', async () => {
    store.tables.matches = new Map([[1, {
      id: 1, status: 'setup', seed_key: 'match_1_decimal', matchInfoConfirmedAt: '2026-10-06T10:00:00Z',
      homeTeamId: 11, awayTeamId: 12, game_n: 991407, ...PINS
    }]])
    store.tables.teams = new Map([[11, { id: 11, name: 'Home V' }], [12, { id: 12, name: 'Away V' }]])
    // (a number stored by an earlier version, a saved team or an import)
    store.tables.players = new Map([
      [201, { id: 201, teamId: 11, number: 2, lastName: 'Alpha', firstName: 'A' }],
      [202, { id: 202, teamId: 11, number: 7.5, lastName: 'Bravo', firstName: 'B' }],
      [203, { id: 203, teamId: 11, number: 8, lastName: 'Charlie', firstName: 'C' }]
    ])
    render(<Setup matchId={1} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'matchSetup.editRoster' }))[0])
    const grid = await waitFor(() => {
      const g = document.querySelector('.roster-grid:not(.roster-add)')
      expect(g.querySelectorAll('input.cell-last')).toHaveLength(3)
      return g
    })
    const numbers = () => [...grid.querySelectorAll('input[aria-label="Player number"]')]

    // typed through a touch keyboard or pasted (no keypress): the digits only
    fireEvent.change(numbers()[0], { target: { value: '1.5' } })
    expect(numbers()[0].value).toBe('15')
    const addRow = document.querySelector('.roster-grid.roster-add') || document
    const addNumber = addRow.querySelector('input[aria-label="Player number"]')
    if (addNumber && !numbers().includes(addNumber)) {
      fireEvent.change(addNumber, { target: { value: '2.3' } })
      expect(addNumber.value).toBe('23')
    }

    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }))
    expect(await screen.findByText(/matchSetup.validation.fixIssues/)).toBeTruthy()
    expect(store.tables.players.get(201).number).toBe(2)
  })

  // Edit roster > Choose players > Use 3 of 5, then Back: the card showed 5
  // again, but the stored players were already the 3 (a reload, Continue
  // match and the coin toss read them)
  it('Choose players in the roster editor stores nothing before Save, so Back discards it', async () => {
    store.tables.matches = new Map([[1, {
      id: 1, status: 'setup', seed_key: 'match_1_pool', matchInfoConfirmedAt: '2026-10-06T10:00:00Z',
      homeTeamId: 11, awayTeamId: 12, game_n: 991407, ...PINS
    }]])
    store.tables.teams = new Map([[11, { id: 11, name: 'Home V' }], [12, { id: 12, name: 'Away V' }]])
    const players = [
      [201, { id: 201, teamId: 11, number: 2, lastName: 'Alpha', firstName: 'A' }],
      [202, { id: 202, teamId: 11, number: 5, lastName: 'Bravo', firstName: 'B' }],
      [203, { id: 203, teamId: 11, number: 8, lastName: 'Charlie', firstName: 'C' }],
      [204, { id: 204, teamId: 11, number: 11, lastName: 'Delta', firstName: 'D' }],
      [205, { id: 205, teamId: 11, number: 14, lastName: 'Echo', firstName: 'E' }]
    ]
    store.tables.players = new Map(players)
    render(<Setup matchId={1} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'matchSetup.editRoster' }))[0])
    await waitFor(() => expect(document.querySelectorAll('.roster-grid:not(.roster-add) input.cell-last')).toHaveLength(5))
    fireEvent.click(screen.getByTestId('choose-players-home'))
    const rows = await screen.findAllByTestId('player-pool-row')
    expect(rows).toHaveLength(5)
    // untick two
    fireEvent.click(rows[3])
    fireEvent.click(rows[4])
    fireEvent.click(screen.getByTestId('player-pool-apply'))
    await waitFor(() => expect(document.querySelectorAll('.roster-grid:not(.roster-add) input.cell-last')).toHaveLength(3))
    await new Promise((r) => setTimeout(r, 50))
    // nothing stored yet: the stored players are still the five
    expect([...store.tables.players.values()].map((p) => p.lastName)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'])
  })

  // Choose players with 18 ticked only warned, and 18 players reached the
  // coin toss and the match (FIVB 4.1.1: at most 14)
  it.each([[14, 'scoreboard.complete'], [15, 'scoreboard.incomplete']])('a roster of %i players: the home card is %s', async (count, badge) => {
    store.tables.matches = new Map([[1, {
      id: 1, status: 'setup', seed_key: 'match_1_max', matchInfoConfirmedAt: '2026-10-06T10:00:00Z',
      homeTeamId: 11, awayTeamId: 12, game_n: 991408, ...PINS,
      bench_home: [{ role: 'Coach', firstName: 'Carla', lastName: 'Coach' }]
    }]])
    store.tables.teams = new Map([[11, { id: 11, name: 'Home V' }], [12, { id: 12, name: 'Away V' }]])
    store.tables.players = new Map(Array.from({ length: count }, (_, i) => [300 + i, {
      id: 300 + i, teamId: 11, number: i + 1, lastName: `P${i + 1}`, firstName: 'X',
      isCaptain: i === 0, libero: i === count - 1 ? 'libero1' : i === count - 2 ? 'libero2' : ''
    }]))
    render(<Setup matchId={1} />)
    await screen.findAllByText('Home V')
    await waitFor(() => {
      // the team card's heading (the match info card names the team too)
      const heading = [...document.querySelectorAll('h1')].find((h) => h.textContent.includes('HOME V'))
      expect(heading.parentElement.querySelector('[aria-label^="scoreboard."]').getAttribute('aria-label')).toBe(badge)
    })
  })
})
