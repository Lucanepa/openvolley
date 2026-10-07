// OpenBeach's Tournaments tab (manager-beach, plan phase T1): the list and a
// new tournament, a draw's pairs and seeds, drawing the bracket after a
// preview, entering a result, the schedule and the ranking CSV. The server
// is mocked (lib/tournamentApi); its rules are tested in the backend suite.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => (typeof opts === 'string' ? opts : key),
    i18n: { language: 'en', changeLanguage: vi.fn() }
  })
}))

const auth = vi.hoisted(() => ({ value: null }))
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth.value }))

const ok = (data) => ({ data, error: null, status: 200 })
const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  generate: vi.fn(),
  putSeeds: vi.fn(),
  enterResult: vi.fn(),
  updateMatch: vi.fn(),
  schedule: vi.fn(),
  ranking: vi.fn(),
  addEntry: vi.fn()
}))
vi.mock('../lib/tournamentApi', async (orig) => ({ ...(await orig()), tournamentApi: api }))
const teams = vi.hoisted(() => ({ fetchBundle: vi.fn() }))
vi.mock('../lib/accountApi', async (orig) => ({ ...(await orig()), savedTeamsApi: teams }))
const ask = vi.hoisted(() => ({ askConfirm: vi.fn(async () => true), askText: vi.fn(async () => null) }))
vi.mock('../utils/askConfirm', () => ({ askConfirm: ask.askConfirm, default: ask.askConfirm }))
vi.mock('../utils/askText', () => ({ askText: ask.askText, default: ask.askText }))

import TournamentsPanel from '../components/manage/tournaments/TournamentsPanel'
import { accessFromRoles } from '../lib/access'

const TOUR = {
  id: 't1', slug: 'zuri-open-2026', title: 'Züri Open', venue: 'Mythenquai', city: 'Zürich', starts_on: '2026-07-11', ends_on: '2026-07-12',
  day_start: '09:00', day_end: '19:00', status: 'draft', public: false, can_edit: true, updated_at: '2026-10-07T10:00:00Z'
}
const entry = (i, extra = {}) => ({ id: `e${i}`, draw_id: 'd1', seed: i, name: `Pair ${i}`, player1: { first: 'A', last: `L${i}` }, player2: { first: 'B', last: `M${i}` }, status: 'registered', final_rank: null, team_id: null, ...extra })
const COURTS = [{ id: 'c1', number: 1, name: null, active: true, flex: false }, { id: 'c2', number: 2, name: 'Center', active: true, flex: false }]
const DRAW = { id: 'd1', tournament_id: 't1', category: 'A1', gender: 'women', format: 'DE', status: 'seeded', slot_minutes: 50, rest_minutes: 0, scoring: { best_of: 3, points: [21, 21, 15] } }
const bundle = (over = {}) => ({ tournament: TOUR, managers: [{ id: 'u-1', email: 'mia@club.ch', name: 'Mia', creator: true }], courts: COURTS, draws: [DRAW], entries: [1, 2, 3, 4].map(i => entry(i)), matches: [], ...over })

function setAuth(roles) {
  auth.value = { user: { id: 'u-1' }, access: { ...accessFromRoles(roles), known: true } }
}

beforeEach(() => {
  vi.clearAllMocks()
  setAuth(['beach:competition_manager'])
  api.list.mockResolvedValue(ok({ tournaments: [{ ...TOUR, draws: 1 }] }))
  api.get.mockResolvedValue(ok(bundle()))
  teams.fetchBundle.mockResolvedValue(ok({ competitions: [], teams: [] }))
})

const openTournament = async () => {
  render(<TournamentsPanel />)
  fireEvent.click(await screen.findByRole('button', { name: 'Züri Open' }))
  await screen.findByRole('heading', { name: 'Züri Open' })
}
const openDraw = async () => {
  await openTournament()
  fireEvent.click(await screen.findByRole('button', { name: 'A1 · tournaments.genders.women' }))
}

describe('Tournaments tab', () => {
  it('lists the tournaments and creates one', async () => {
    api.create.mockResolvedValue(ok({ tournament: { ...TOUR, id: 't2' } }))
    render(<TournamentsPanel />)
    expect(await screen.findByText('Züri Open')).toBeInTheDocument()
    expect(screen.getByText('11.–12.07.2026')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('tournament-new'))
    expect(screen.getByTestId('tournament-create')).toBeDisabled()
    fireEvent.change(screen.getByTestId('tournament-title'), { target: { value: '  Beach Cup ' } })
    fireEvent.change(screen.getByTestId('tournament-starts'), { target: { value: '2026-08-01' } })
    fireEvent.click(screen.getByTestId('tournament-create'))
    await waitFor(() => expect(api.create).toHaveBeenCalledWith({ title: 'Beach Cup', starts_on: '2026-08-01', ends_on: '2026-08-01', venue: null, city: null, courts: 2 }))
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('t2'))
  })

  it('a beach scorer reads, but cannot create', async () => {
    setAuth(['beach:scorer'])
    render(<TournamentsPanel />)
    expect(await screen.findByText('Züri Open')).toBeInTheDocument()
    expect(screen.queryByTestId('tournament-new')).toBeNull()
  })

  it('seeds: reorder the pairs, then save them in that order', async () => {
    api.putSeeds.mockResolvedValue(ok({ seeded: 4 }))
    await openDraw()
    const row = (await screen.findByText('Pair 2')).closest('.flex-wrap')
    fireEvent.click(within(row).getByRole('button', { name: 'tournaments.moveUp' }))
    fireEvent.click(screen.getByRole('button', { name: 'tournaments.saveSeeds' }))
    await waitFor(() => expect(api.putSeeds).toHaveBeenCalledWith('d1', ['e2', 'e1', 'e3', 'e4']))
  })

  it('draws the bracket after a preview the manager confirms', async () => {
    const matches = [{ game_n: 1 }, { game_n: 6 }]
    api.generate.mockResolvedValueOnce(ok({ teams: 4, board_size: 8, warnings: [{ code: 'too_few_teams', min: 8 }], matches }))
    api.generate.mockResolvedValueOnce(ok({ teams: 4, board_size: 8, warnings: [], matches }))
    await openDraw()
    fireEvent.click(await screen.findByTestId('bracket-generate'))
    await waitFor(() => expect(api.generate).toHaveBeenCalledTimes(2))
    expect(api.generate).toHaveBeenNthCalledWith(1, 'd1', { dryRun: true })
    expect(api.generate).toHaveBeenNthCalledWith(2, 'd1')
    expect(ask.askConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'tournaments.generateTitle', message: expect.stringContaining('tournaments.warnings.too_few_teams') }))
  })

  it('nothing is drawn when the preview is cancelled', async () => {
    ask.askConfirm.mockResolvedValueOnce(false)
    api.generate.mockResolvedValue(ok({ teams: 4, board_size: 8, warnings: [], matches: [{ game_n: 1 }] }))
    await openDraw()
    fireEvent.click(await screen.findByTestId('bracket-generate'))
    await waitFor(() => expect(ask.askConfirm).toHaveBeenCalled())
    expect(api.generate).toHaveBeenCalledTimes(1)
  })

  it('a result: the sets decide the winner, sent from the first pair\'s side', async () => {
    const m = (game_n, code, e1, e2, extra = {}) => ({
      id: `m${game_n}`, draw_id: 'd1', game_n, code, phase: 'winners', round: 1, position: game_n, wave: 1,
      source1: 'seed:1', source2: 'seed:4', entry1_id: e1, entry2_id: e2, status: 'ready', match_id: null, sets: null, result: null, winner_entry_id: null, ...extra
    })
    api.get.mockResolvedValue(ok(bundle({
      draws: [{ ...DRAW, status: 'drawn' }],
      matches: [m(1, 'W1', 'e1', 'e4'), m(2, 'W2', 'e2', 'e3'), m(3, 'W3', null, null, { round: 2, source1: 'winner:W1', source2: 'winner:W2', status: 'scheduled' })]
    })))
    api.enterResult.mockResolvedValue(ok({ match: {} }))
    await openDraw()
    // the open match names where its pairs come from
    expect(await screen.findAllByText('tournaments.sources.winner')).toHaveLength(2)
    expect(screen.queryByTestId('result-W3')).toBeNull()
    fireEvent.click(screen.getByTestId('result-W1'))
    const save = screen.getByTestId('result-save')
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByTestId('result-sets'), { target: { value: '15:21 21:19 12:15' } })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    // with the result this screen showed (none), so a result entered elsewhere meanwhile is not overwritten
    await waitFor(() => expect(api.enterResult).toHaveBeenCalledWith('m1', {
      winner: 2, result: 'played', sets: [[15, 21], [21, 19], [12, 15]], expect: { winner_entry_id: null, result: null, sets: null }
    }))
  })

  it('a result changed elsewhere meanwhile: no overwrite, the dialog closes and the draw reloads', async () => {
    api.get.mockResolvedValue(ok(bundle({
      draws: [{ ...DRAW, status: 'playing' }],
      matches: [{
        id: 'm1', draw_id: 'd1', game_n: 1, code: 'W1', phase: 'winners', round: 1, position: 1, wave: 1, source1: 'seed:1', source2: 'seed:4',
        entry1_id: 'e1', entry2_id: 'e4', status: 'finished', match_id: null, sets: [[21, 10], [21, 12]], result: 'played', winner_entry_id: 'e1'
      }]
    })))
    api.enterResult.mockResolvedValue({ data: null, error: { code: 'OV_RESULT_CHANGED', message: 'changed', status: 409 }, status: 409 })
    await openDraw()
    fireEvent.click(await screen.findByTestId('result-W1'))
    fireEvent.change(screen.getByTestId('result-sets'), { target: { value: '10:21 12:21' } })
    const loads = api.get.mock.calls.length
    fireEvent.click(screen.getByTestId('result-save'))
    await waitFor(() => expect(api.enterResult).toHaveBeenCalledWith('m1', {
      winner: 2, result: 'played', sets: [[10, 21], [12, 21]], expect: { winner_entry_id: 'e1', result: 'played', sets: [[21, 10], [21, 12]] }
    }))
    await waitFor(() => expect(screen.queryByTestId('result-save')).toBeNull())
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(loads))
  })

  it('the schedule: planned after a dry run, shown per day, time and court', async () => {
    api.get.mockResolvedValue(ok(bundle({
      draws: [{ ...DRAW, status: 'drawn' }],
      matches: [{ id: 'm1', draw_id: 'd1', game_n: 1, code: 'W1', phase: 'winners', round: 1, source1: 'seed:1', source2: 'seed:4', entry1_id: 'e1', entry2_id: 'e4', status: 'ready', court_id: 'c2', scheduled_at: '2026-07-11T07:00:00Z' }]
    })))
    api.schedule.mockResolvedValue(ok({ slots: [{ id: 'm1' }], unplaced: [], warnings: [] }))
    await openTournament()
    fireEvent.click(screen.getByRole('radio', { name: 'tournaments.sections.schedule' }))
    expect(await screen.findByTestId('slot-1')).toHaveTextContent('Pair 1')
    expect(screen.getByText('09:00')).toBeInTheDocument()
    expect(screen.getByText('Center')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('schedule-plan'))
    await waitFor(() => expect(api.schedule).toHaveBeenCalledTimes(2))
    expect(api.schedule).toHaveBeenNthCalledWith(1, 't1', { dryRun: true, day_start: '09:00', day_end: '19:00' })
    expect(api.schedule).toHaveBeenNthCalledWith(2, 't1', { day_start: '09:00', day_end: '19:00' })
  })

  it('a hand move that clashes with the schedule is saved only after the manager confirms it', async () => {
    api.get.mockResolvedValue(ok(bundle({
      draws: [{ ...DRAW, status: 'drawn' }],
      matches: [{ id: 'm1', draw_id: 'd1', game_n: 1, code: 'W1', phase: 'winners', round: 1, source1: 'seed:1', source2: 'seed:4', entry1_id: 'e1', entry2_id: 'e4', status: 'ready', court_id: 'c2', scheduled_at: '2026-07-11T07:00:00Z' }]
    })))
    const clash = { data: null, error: { code: 'OV_SLOT_CONFLICT', status: 409, details: { conflicts: [{ reason: 'court', game_n: 2, code: 'W2' }, { reason: 'hours' }] } }, status: 409 }
    api.updateMatch.mockResolvedValueOnce(clash).mockResolvedValueOnce(ok({ match: {} }))
    await openTournament()
    fireEvent.click(screen.getByRole('radio', { name: 'tournaments.sections.schedule' }))
    fireEvent.click(await screen.findByTestId('slot-1'))
    fireEvent.click(screen.getByRole('button', { name: 'tournaments.save' }))
    await waitFor(() => expect(api.updateMatch).toHaveBeenCalledTimes(2))
    const body = { referee: null, scorer: null, court_id: 'c2', scheduled_at: '2026-07-11T07:00:00.000Z' }
    expect(api.updateMatch).toHaveBeenNthCalledWith(1, 'm1', body)
    expect(api.updateMatch).toHaveBeenNthCalledWith(2, 'm1', { ...body, force: true })
    expect(ask.askConfirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'tournaments.slotConflictTitle',
      message: 'tournaments.slotConflicts.court\ntournaments.slotConflicts.hours',
      confirmLabel: 'tournaments.saveAnyway'
    }))
  })

  it('a clashing hand move the manager does not confirm is not saved', async () => {
    api.get.mockResolvedValue(ok(bundle({
      draws: [{ ...DRAW, status: 'drawn' }],
      matches: [{ id: 'm1', draw_id: 'd1', game_n: 1, code: 'W1', phase: 'winners', round: 1, source1: 'seed:1', source2: 'seed:4', entry1_id: 'e1', entry2_id: 'e4', status: 'ready', court_id: 'c2', scheduled_at: '2026-07-11T07:00:00Z' }]
    })))
    api.updateMatch.mockResolvedValue({ data: null, error: { code: 'OV_SLOT_CONFLICT', status: 409, details: { conflicts: [{ reason: 'days' }] } }, status: 409 })
    ask.askConfirm.mockResolvedValueOnce(false)
    await openTournament()
    fireEvent.click(screen.getByRole('radio', { name: 'tournaments.sections.schedule' }))
    fireEvent.click(await screen.findByTestId('slot-1'))
    fireEvent.click(screen.getByRole('button', { name: 'tournaments.save' }))
    await waitFor(() => expect(ask.askConfirm).toHaveBeenCalled())
    expect(api.updateMatch).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'tournaments.save' })).toBeInTheDocument()
  })

  it('the ranking: a table and the CSV for MyBeach', async () => {
    api.get.mockResolvedValue(ok(bundle({ draws: [{ ...DRAW, status: 'done' }] })))
    api.ranking.mockResolvedValue(ok({ draw: { ...DRAW, status: 'done' }, complete: true, ranking: [entry(1, { final_rank: 1, player1: { first: 'A', last: 'L1', licence: 'LIC-1' } })], csv: 'Rank;Seed\r\n1;1\r\n' }))
    const created = []
    URL.createObjectURL = vi.fn((b) => { created.push(b); return 'blob:x' })
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await openTournament()
    fireEvent.click(screen.getByRole('radio', { name: 'tournaments.sections.ranking' }))
    expect(await screen.findByText(/LIC-1/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('ranking-csv'))
    expect(click).toHaveBeenCalled()
    expect(created[0].type).toBe('text/csv;charset=utf-8')
    click.mockRestore()
  })
})
