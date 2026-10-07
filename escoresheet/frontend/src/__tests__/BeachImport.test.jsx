// OpenBeach's Excel/CSV import in the Tournaments tab (manager-beach, plan
// 3.4, phase T2): the template, a file read in the browser, the server's
// preview, the apply with the preview's hash, a preview gone stale, rows
// with errors, and "New tournament" from a file. The server is mocked
// (lib/tournamentApi); its rules are tested in the backend suite.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

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
  importPreview: vi.fn(),
  importApply: vi.fn()
}))
vi.mock('../lib/tournamentApi', async (orig) => ({ ...(await orig()), tournamentApi: api }))
const teams = vi.hoisted(() => ({ fetchBundle: vi.fn() }))
vi.mock('../lib/accountApi', async (orig) => ({ ...(await orig()), savedTeamsApi: teams }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('../ui', async (orig) => ({ ...(await orig()), toast }))

import TournamentsPanel from '../components/manage/tournaments/TournamentsPanel'
import { accessFromRoles } from '../lib/access'

const TOUR = {
  id: 't1', slug: 'zuri-open-2026', title: 'Züri Open', venue: null, city: null, starts_on: '2026-07-11', ends_on: '2026-07-12',
  day_start: '09:00', day_end: '19:00', status: 'draft', public: false, can_edit: true, updated_at: '2026-10-07T10:00:00Z'
}
const bundle = (over = {}) => ({ tournament: TOUR, managers: [], courts: [], draws: [], entries: [], matches: [], ...over })
const CSV = 'Draw;Gender;Seed;Player 1 last name;Player 2 last name;Comment\nA1;Damen;1;Muster;Beispiel;hi\nA1;Damen;;Keller;Frei;\n'
const PREVIEW = {
  hash: 'a'.repeat(64),
  can_apply: true,
  summary: { draws_new: 1, entries_new: 2, entries_changed: 0, entries_unchanged: 0, entries_removed: 0, brackets: 0, matches_changed: 0, matches_unchanged: 0, courts_new: 0, errors: 0, warnings: 1 },
  warnings: [],
  rows: {
    entries: [
      { row: 2, status: 'ok', op: 'new', category: 'A1', gender: 'women', name: 'Muster/Beispiel', messages: [] },
      { row: 3, status: 'warning', op: 'new', category: 'A1', gender: 'women', name: 'Keller/Frei', messages: [{ level: 'warning', code: 'no_licence' }] }
    ],
    matches: []
  },
  draws: [{ key: 'a1|women', category: 'A1', gender: 'women', op: 'new', draw_id: null, bracket: null }],
  entries: [
    { op: 'new', row: 2, key: 'a1|women', entry_id: null, name: 'Muster/Beispiel', values: { seed: 1 }, changes: [] },
    { op: 'new', row: 3, key: 'a1|women', entry_id: null, name: 'Keller/Frei', values: { seed: null }, changes: [] }
  ],
  matches: [],
  courts: []
}
const PAYLOAD = {
  entries: [
    { row: 2, draw: 'A1', gender: 'Damen', seed: '1', p1_last: 'Muster', p2_last: 'Beispiel' },
    { row: 3, draw: 'A1', gender: 'Damen', seed: '', p1_last: 'Keller', p2_last: 'Frei' }
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  auth.value = { user: { id: 'u-1' }, access: { ...accessFromRoles(['beach:competition_manager']), known: true } }
  api.list.mockResolvedValue(ok({ tournaments: [{ ...TOUR, draws: 0 }] }))
  api.get.mockResolvedValue(ok(bundle()))
  api.importPreview.mockResolvedValue(ok(PREVIEW))
  api.importApply.mockResolvedValue(ok({ applied: PREVIEW.summary, hash: PREVIEW.hash }))
  teams.fetchBundle.mockResolvedValue(ok({ competitions: [], teams: [] }))
})

const openImport = async () => {
  render(<TournamentsPanel />)
  fireEvent.click(await screen.findByRole('button', { name: 'Züri Open' }))
  fireEvent.click(await screen.findByTestId('import-open'))
  await waitFor(() => expect(screen.getByTestId('import-choose')).not.toBeDisabled())
}
const chooseFile = (name, text, type = 'text/csv') => {
  fireEvent.change(screen.getByTestId('import-file'), { target: { files: [new File([text], name, { type })] } })
}

describe('Tournament import', () => {
  it('reads a CSV, shows the server\'s preview and applies it with its hash', async () => {
    await openImport()
    expect(screen.getByTestId('import-apply')).toBeDisabled()
    chooseFile('entries.csv', CSV)
    await screen.findByTestId('import-preview')
    expect(api.importPreview).toHaveBeenCalledWith('t1', PAYLOAD)
    // the sheet found, the column not used
    expect(screen.getByText('entries.csv')).toBeInTheDocument()
    expect(screen.getByText('tournaments.import.ignoredColumns')).toBeInTheDocument()
    // the row with a warning and its message; the changes
    expect(screen.getByText('tournaments.import.msg.no_licence')).toBeInTheDocument()
    expect(screen.getByText('tournaments.import.status.warning')).toBeInTheDocument()
    expect(screen.getByText('tournaments.import.drawNew')).toBeInTheDocument()
    expect(screen.getAllByText('tournaments.import.ops.new').length).toBe(3)
    const calls = api.get.mock.calls.length
    fireEvent.click(screen.getByTestId('import-apply'))
    await waitFor(() => expect(api.importApply).toHaveBeenCalledWith('t1', PAYLOAD, PREVIEW.hash))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('tournaments.import.applied'))
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(calls))
    expect(screen.queryByTestId('import-preview')).not.toBeInTheDocument()
  })

  it('shows the new preview when the tournament changed since, and applies that one', async () => {
    const fresh = { ...PREVIEW, hash: 'b'.repeat(64) }
    api.importApply
      .mockResolvedValueOnce({ data: null, status: 409, error: { code: 'OV_IMPORT_CHANGED', message: 'x', details: { preview: fresh } } })
      .mockResolvedValueOnce(ok({ applied: fresh.summary, hash: fresh.hash }))
    await openImport()
    chooseFile('entries.csv', CSV)
    await screen.findByTestId('import-preview')
    fireEvent.click(screen.getByTestId('import-apply'))
    expect(await screen.findByText('tournaments.import.changed')).toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('import-apply'))
    await waitFor(() => expect(api.importApply).toHaveBeenLastCalledWith('t1', PAYLOAD, fresh.hash))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it('cannot apply rows with errors', async () => {
    api.importPreview.mockResolvedValue(ok({
      ...PREVIEW,
      can_apply: false,
      summary: { ...PREVIEW.summary, errors: 1 },
      rows: { entries: [{ row: 2, status: 'error', op: 'new', category: 'A1', gender: 'women', name: 'Muster/Beispiel', messages: [{ level: 'error', code: 'bad_gender', field: 'gender', value: 'Kids' }] }], matches: [] }
    }))
    await openImport()
    chooseFile('entries.csv', CSV)
    expect(await screen.findByText('tournaments.import.msg.bad_gender')).toBeInTheDocument()
    expect(screen.getByText('tournaments.import.hasErrors')).toBeInTheDocument()
    expect(screen.getByTestId('import-apply')).toBeDisabled()
  })

  it('names a file it cannot use without asking the server', async () => {
    await openImport()
    chooseFile('list.csv', 'Draw;Player 1 last name\nA1;Muster\n')
    expect(await screen.findByText('tournaments.import.problems.missing_columns')).toBeInTheDocument()
    chooseFile('old.xls', 'x', 'application/vnd.ms-excel')
    expect(await screen.findByText('tournaments.import.problems.xls')).toBeInTheDocument()
    expect(api.importPreview).not.toHaveBeenCalled()
  })

  it('downloads the template as an XLSX file', async () => {
    const createObjectURL = vi.fn(() => 'blob:template')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await openImport()
    fireEvent.click(screen.getByTestId('import-template'))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0]
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(blob.size).toBeGreaterThan(1000)
    expect(click).toHaveBeenCalled()
    click.mockRestore()
  })

  it('"New tournament" from a file opens the import right away', async () => {
    api.create.mockResolvedValue(ok({ tournament: { ...TOUR, id: 't2' } }))
    render(<TournamentsPanel />)
    fireEvent.click(await screen.findByTestId('tournament-new'))
    fireEvent.click(screen.getByRole('radio', { name: 'tournaments.startFile' }))
    expect(screen.getByText('tournaments.startFileHint')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('tournament-title'), { target: { value: 'Beach Cup' } })
    fireEvent.change(screen.getByTestId('tournament-starts'), { target: { value: '2026-07-11' } })
    fireEvent.click(screen.getByTestId('tournament-create'))
    await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Beach Cup', source: 'xlsx' })))
    expect(await screen.findByTestId('import-choose')).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledWith('t2')
  })

  it('offers no import on a tournament this account does not edit', async () => {
    api.get.mockResolvedValue(ok(bundle({ tournament: { ...TOUR, can_edit: false } })))
    render(<TournamentsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Züri Open' }))
    await screen.findByRole('heading', { name: 'Züri Open' })
    expect(screen.queryByTestId('import-open')).not.toBeInTheDocument()
  })
})
