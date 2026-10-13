import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))

const api = vi.hoisted(() => ({ list: vi.fn(), pdf: vi.fn() }))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), scoresheetsApi: { list: (...a) => api.list(...a), pdf: (...a) => api.pdf(...a) } }))
const toasts = vi.hoisted(() => ({ error: [] }))
vi.mock('../../ui', async (orig) => {
  const real = await orig()
  return { ...real, toast: { ...real.toast, error: (m) => toasts.error.push(m) } }
})

import ScoresheetsPanel from '../manage/ScoresheetsPanel'

const MATCHES = [
  { id: 'm-1', game_n: 402397, status: 'final', scheduled_at: '2026-10-10T12:30:00Z', home_name: 'Voléro', away_name: 'Smash', league: '1L', scorer_name: 'Ada Scorer', sport: 'indoor', pdf: true, pdf_updated_at: '2026-10-10T16:40:00Z' },
  { id: 'm-2', game_n: 402398, status: 'live', scheduled_at: '2026-10-11T12:30:00Z', home_name: 'Wiedikon', away_name: 'Züri', sport: 'indoor', pdf: false, pdf_updated_at: null }
]
const pdfBlob = new Blob(['%PDF-1.4'], { type: 'application/pdf' })
// what a browser hands out: a blob: URL of this page's origin
const SHEET_URL = `blob:${window.location.origin}/0f1e2d3c`
const rowOf = (text) => screen.getByText(text).closest('.flex-wrap')

describe('ScoresheetsPanel', () => {
  let opened
  beforeEach(() => {
    vi.clearAllMocks()
    toasts.error = []
    api.list.mockResolvedValue({ data: { matches: MATCHES }, error: null, status: 200 })
    URL.createObjectURL = vi.fn(() => SHEET_URL)
    URL.revokeObjectURL = vi.fn()
    opened = { closed: false }
    vi.spyOn(window, 'open').mockImplementation(() => opened)
  })
  afterEach(() => vi.restoreAllMocks())

  it('lists the app\'s matches (all by default) with what is stored', async () => {
    render(<ScoresheetsPanel app="beach" />)
    expect(await screen.findByText('Voléro vs Smash')).toBeInTheDocument()
    expect(api.list).toHaveBeenCalledWith({ app: 'beach', state: 'all', q: undefined, limit: 200 })
    expect(screen.getByText('manage.scoresheets.storedAt')).toBeInTheDocument()
    expect(screen.getByText('manage.scoresheets.noPdfYet')).toBeInTheDocument()
    // no PDF: nothing to open
    const none = rowOf('Wiedikon vs Züri')
    expect(within(none).queryByRole('button', { name: 'manage.scoresheets.view' })).toBeNull()
    expect(within(none).queryByRole('button', { name: 'manage.scoresheets.download' })).toBeNull()
    expect(within(rowOf('Voléro vs Smash')).getByRole('button', { name: 'manage.scoresheets.view' })).toBeEnabled()
    fireEvent.click(screen.getByRole('radio', { name: 'manage.matches.filterClosed' }))
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith({ app: 'beach', state: 'closed', q: undefined, limit: 200 }))
  })

  it('View opens the PDF in a window (openAppWindow); a blocked popup saves it instead', async () => {
    api.pdf.mockResolvedValue({ blob: pdfBlob, filename: 'scoresheet_game402397_2026-10-10.pdf' })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<ScoresheetsPanel />)
    await screen.findByText('Voléro vs Smash')
    const view = () => within(rowOf('Voléro vs Smash')).getByRole('button', { name: 'manage.scoresheets.view' })
    fireEvent.click(view())
    await waitFor(() => expect(window.open).toHaveBeenCalledWith(SHEET_URL, '_blank', expect.any(String)))
    expect(api.pdf).toHaveBeenCalledWith('m-1', { download: false })
    expect(click).not.toHaveBeenCalled()

    window.open.mockImplementation(() => null)
    await waitFor(() => expect(view()).not.toBeDisabled())
    fireEvent.click(view())
    await waitFor(() => expect(click).toHaveBeenCalled())
    expect(click.mock.contexts[0].download).toBe('scoresheet_game402397_2026-10-10.pdf')
  })

  it('Download saves the file under the server\'s name; an error says why', async () => {
    api.pdf.mockResolvedValueOnce({ blob: pdfBlob, filename: 'scoresheet_game402397_2026-10-10.pdf' })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<ScoresheetsPanel />)
    await screen.findByText('Voléro vs Smash')
    const row = rowOf('Voléro vs Smash')
    fireEvent.click(within(row).getByRole('button', { name: 'manage.scoresheets.download' }))
    await waitFor(() => expect(click).toHaveBeenCalled())
    expect(click.mock.contexts[0].download).toBe('scoresheet_game402397_2026-10-10.pdf')
    expect(api.pdf).toHaveBeenCalledWith('m-1', { download: true })
    expect(window.open).not.toHaveBeenCalled()

    api.pdf.mockResolvedValueOnce({ error: { code: 'OV_SCORESHEET_NOT_FOUND', status: 404 } })
    await waitFor(() => expect(within(row).getByRole('button', { name: 'manage.scoresheets.view' })).not.toBeDisabled())
    fireEvent.click(within(row).getByRole('button', { name: 'manage.scoresheets.view' }))
    await waitFor(() => expect(toasts.error).toEqual(['manage.scoresheets.noPdf']))
    expect(window.open).not.toHaveBeenCalled()
  })
})
