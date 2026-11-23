// LOG-02 / LOG-10 (audit 26.11, record-pdf): "Rebuild PDF" is for a closed
// indoor match only. A beach match's sheet is OpenBeach's own: the sheet the
// manager (and the render service) draws is the indoor one, which printed a
// beach record without its pairs and at 0:0 (src/__audit__/record-pdf-beach-rebuild),
// and the server stored it over the device's signed beach PDF. A match
// reopened for a correction gets its PDF from the new approval: a rebuild in
// between made the scorer's re-approval PDF be refused. The server refuses
// both with 409, and a 409 never falls back to drawing the sheet here.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))

const api = vi.hoisted(() => ({ list: vi.fn(), pdf: vi.fn(), viewLink: vi.fn(), matchRecord: vi.fn(), rebuild: vi.fn(), rebuildVector: vi.fn(), approvals: vi.fn() }))
vi.mock('../../lib/accountApi', async (orig) => {
  const real = await orig()
  return { ...real, approvalsApi: { ...real.approvalsApi, list: (...a) => api.approvals(...a) }, scoresheetsApi: { list: (...a) => api.list(...a), pdf: (...a) => api.pdf(...a), viewLink: (...a) => api.viewLink(...a), matchRecord: (...a) => api.matchRecord(...a), rebuild: (...a) => api.rebuild(...a), rebuildVector: (...a) => api.rebuildVector(...a) } }
})
const toasts = vi.hoisted(() => ({ error: [], success: [] }))
vi.mock('../../ui', async (orig) => {
  const real = await orig()
  return { ...real, toast: { ...real.toast, error: (m) => toasts.error.push(m), success: (m) => toasts.success.push(m), info: () => {} } }
})
vi.mock('../manage/RebuildScoresheet', () => ({
  default: () => <div data-testid="rebuild-scoresheet" />,
  blobToBase64: async () => 'JVBERi0xLjQ='
}))
const fromCloud = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../../utils/scoresheetFromCloud', () => ({ scoresheetDataFromCloud: (...a) => fromCloud.fn(...a) }))

import ScoresheetsPanel from '../manage/ScoresheetsPanel'

const CLOSED = '2026-11-23T16:40:00Z'
const row = (o) => ({ status: 'final', scheduled_at: '2026-11-23T12:30:00Z', sport: 'indoor', pdf: true, pdf_updated_at: '2026-11-23T16:40:00Z', closed_at: CLOSED, ...o })
const rowOf = (text) => screen.getByText(text).closest('.flex-wrap')

describe('ScoresheetsPanel: Rebuild PDF only for a closed indoor match (LOG-02, LOG-10)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toasts.error = []
    toasts.success = []
    api.viewLink.mockResolvedValue({ error: { code: 'OV_NOT_FOUND' }, status: 404 })
    api.approvals.mockResolvedValue({ data: { match: {}, approvals: [] }, error: null, status: 200 })
  })

  it('no Rebuild on a beach match, closed or not, even with a stale PDF', async () => {
    api.list.mockResolvedValue({
      data: {
        matches: [
          row({ id: 'b-1', game_n: 7, sport: 'beach', home_name: 'Muster/Beispiel', away_name: 'Sand/Strand', pdf_stale: true }),
          row({ id: 'b-2', game_n: 8, sport: 'beach', home_name: 'Ost/West', away_name: 'Nord/Sued', closed_at: null })
        ]
      },
      error: null,
      status: 200
    })
    render(<ScoresheetsPanel app="beach" canRebuild />)
    await screen.findByText('Muster/Beispiel vs Sand/Strand')
    expect(screen.queryByTestId('scoresheet-rebuild')).toBeNull()
    // its PDF can still be viewed and downloaded, and the closed one reopened (OpenBeach)
    expect(within(rowOf('Muster/Beispiel vs Sand/Strand')).getByRole('button', { name: 'manage.scoresheets.view' })).toBeEnabled()
    expect(within(rowOf('Muster/Beispiel vs Sand/Strand')).getByRole('button', { name: 'manage.matches.reopen' })).toBeInTheDocument()
  })

  it('no Rebuild on an indoor match that is not closed (reopened for a correction), whatever PDF it has', async () => {
    api.list.mockResolvedValue({
      data: {
        matches: [
          row({ id: 'i-1', game_n: 402397, home_name: 'Volero', away_name: 'Smash' }),
          row({ id: 'i-2', game_n: 402398, home_name: 'Musterdorf', away_name: 'Zueri', closed_at: null, status: 'live', pdf_stale: true })
        ]
      },
      error: null,
      status: 200
    })
    render(<ScoresheetsPanel canRebuild />)
    await screen.findByText('Volero vs Smash')
    expect(within(rowOf('Volero vs Smash')).getByTestId('scoresheet-rebuild')).toBeInTheDocument()
    expect(within(rowOf('Musterdorf vs Zueri')).queryByTestId('scoresheet-rebuild')).toBeNull()
    expect(within(rowOf('Musterdorf vs Zueri')).getByRole('button', { name: 'manage.scoresheets.view' })).toBeEnabled()
  })

  it('a 409 from the server (OV_BEACH_SHEET, OV_NOT_CLOSED) is shown: no record read, nothing drawn or stored here', async () => {
    api.list.mockResolvedValue({ data: { matches: [row({ id: 'i-1', game_n: 402397, home_name: 'Volero', away_name: 'Smash' })] }, error: null, status: 200 })
    render(<ScoresheetsPanel canRebuild />)
    await screen.findByText('Volero vs Smash')
    for (const code of ['OV_NOT_CLOSED', 'OV_BEACH_SHEET']) {
      api.rebuildVector.mockResolvedValueOnce({ data: null, error: { code, status: 409, message: `refused: ${code}` }, status: 409 })
      fireEvent.click(screen.getByTestId('scoresheet-rebuild'))
      fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Set start times corrected' } })
      fireEvent.click(screen.getByTestId('reason-confirm'))
      await waitFor(() => expect(api.rebuildVector).toHaveBeenLastCalledWith('i-1', { reason: 'Set start times corrected' }))
      // the dialog stays open with the refusal
      expect(await screen.findByTestId('reason-confirm')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
      await waitFor(() => expect(screen.queryByTestId('reason-confirm')).toBeNull())
    }
    expect(api.matchRecord).not.toHaveBeenCalled()
    expect(fromCloud.fn).not.toHaveBeenCalled()
    expect(api.rebuild).not.toHaveBeenCalled()
    expect(screen.queryByTestId('rebuild-scoresheet')).toBeNull()
    expect(toasts.success).toEqual([])
  })
})
