import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))

const api = vi.hoisted(() => ({ list: vi.fn(), pdf: vi.fn(), viewLink: vi.fn(), reopen: vi.fn(), matchRecord: vi.fn(), rebuild: vi.fn(), approvals: vi.fn() }))
vi.mock('../../lib/accountApi', async (orig) => {
  const real = await orig()
  return { ...real, admin: { ...real.admin, reopenMatch: (...a) => api.reopen(...a) }, approvalsApi: { ...real.approvalsApi, list: (...a) => api.approvals(...a) }, scoresheetsApi: { list: (...a) => api.list(...a), pdf: (...a) => api.pdf(...a), viewLink: (...a) => api.viewLink(...a), matchRecord: (...a) => api.matchRecord(...a), rebuild: (...a) => api.rebuild(...a) } }
})
const toasts = vi.hoisted(() => ({ error: [], success: [] }))
vi.mock('../../ui', async (orig) => {
  const real = await orig()
  return { ...real, toast: { ...real.toast, error: (m) => toasts.error.push(m), success: (m) => toasts.success.push(m), info: (m) => (toasts.info = toasts.info || []).push(m) } }
})
// "Rebuild PDF": the sheet's drawing is the scoresheet's own (its tests); here
// the panel's steps: the record read, the remark, the PDF handed back, stored
const rebuildView = vi.hoisted(() => ({ props: null }))
vi.mock('../manage/RebuildScoresheet', () => ({
  default: (props) => { rebuildView.props = props; return <div data-testid="rebuild-scoresheet">{props.remark}</div> },
  blobToBase64: async () => 'JVBERi0xLjQ='
}))
const fromCloud = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../../utils/scoresheetFromCloud', () => ({ scoresheetDataFromCloud: (...a) => fromCloud.fn(...a) }))

import ScoresheetsPanel from '../manage/ScoresheetsPanel'

const MATCHES = [
  { id: 'm-1', game_n: 402397, status: 'final', scheduled_at: '2026-10-10T12:30:00Z', home_name: 'Voléro', away_name: 'Smash', league: '1L', scorer_name: 'Ada Scorer', sport: 'indoor', pdf: true, pdf_updated_at: '2026-10-10T16:40:00Z' },
  { id: 'm-2', game_n: 402398, status: 'live', scheduled_at: '2026-10-11T12:30:00Z', home_name: 'Musterdorf', away_name: 'Züri', sport: 'indoor', pdf: false, pdf_updated_at: null }
]
const pdfBlob = new Blob(['%PDF-1.4'], { type: 'application/pdf' })
// what a browser hands out: a blob: URL of this page's origin
const SHEET_URL = `blob:${window.location.origin}/0f1e2d3c`
const rowOf = (text) => screen.getByText(text).closest('.flex-wrap')
const VIEW_URL = 'https://backend.example/api/scoresheet-view/tok/game402397_1L_2026-10-10.pdf'

describe('ScoresheetsPanel', () => {
  let opened
  beforeEach(() => {
    vi.clearAllMocks()
    toasts.error = []
    toasts.success = []
    toasts.info = []
    rebuildView.props = null
    api.list.mockResolvedValue({ data: { matches: MATCHES }, error: null, status: 200 })
    // a server before the view links (404): View falls back to the file
    api.viewLink.mockResolvedValue({ error: { code: 'OV_NOT_FOUND' }, status: 404 })
    api.approvals.mockResolvedValue({ data: { match: {}, approvals: [] }, error: null, status: 200 })
    URL.createObjectURL = vi.fn(() => SHEET_URL)
    URL.revokeObjectURL = vi.fn()
    opened = { closed: false, location: { href: '' }, close: vi.fn() }
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
    const none = rowOf('Musterdorf vs Züri')
    expect(within(none).queryByRole('button', { name: 'manage.scoresheets.view' })).toBeNull()
    expect(within(none).queryByRole('button', { name: 'manage.scoresheets.download' })).toBeNull()
    expect(within(rowOf('Voléro vs Smash')).getByRole('button', { name: 'manage.scoresheets.view' })).toBeEnabled()
    fireEvent.click(screen.getByRole('radio', { name: 'manage.matches.filterClosed' }))
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith({ app: 'beach', state: 'closed', q: undefined, limit: 200 }))
  })

  it('a match whose game an admin released is marked (db/040: not the official one, not mailed as final)', async () => {
    api.list.mockResolvedValue({ data: { matches: [{ ...MATCHES[0], released: true }, MATCHES[1]] }, error: null, status: 200 })
    render(<ScoresheetsPanel />)
    await screen.findByText('Voléro vs Smash')
    expect(within(rowOf('Voléro vs Smash')).getByText('manage.games.releaseGame')).toBeInTheDocument()
    expect(within(rowOf('Voléro vs Smash')).getByText('manage.scoresheets.storedAt')).toBeInTheDocument()
    expect(within(rowOf('Musterdorf vs Züri')).queryByText('manage.games.releaseGame')).toBeNull()
  })

  it('View opens a tab at the click (no popup blocker) and sends it to the server\'s view link; no file is fetched', async () => {
    let resolveLink
    api.viewLink.mockReturnValue(new Promise((r) => { resolveLink = r }))
    render(<ScoresheetsPanel />)
    await screen.findByText('Voléro vs Smash')
    fireEvent.click(within(rowOf('Voléro vs Smash')).getByRole('button', { name: 'manage.scoresheets.view' }))
    // the tab is open before the request has answered
    expect(window.open).toHaveBeenCalledWith('', '_blank')
    expect(opened.opener).toBeNull()
    resolveLink({ url: VIEW_URL, filename: 'game402397_1L_2026-10-10.pdf' })
    await waitFor(() => expect(opened.location.href).toBe(VIEW_URL))
    expect(window.open).toHaveBeenCalledTimes(1)
    expect(api.viewLink).toHaveBeenCalledWith('m-1')
    expect(api.pdf).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('a refused view link says why and opens nothing', async () => {
    api.viewLink.mockResolvedValue({ error: { code: 'OV_FORBIDDEN', status: 403 }, status: 403 })
    render(<ScoresheetsPanel />)
    await screen.findByText('Voléro vs Smash')
    fireEvent.click(within(rowOf('Voléro vs Smash')).getByRole('button', { name: 'manage.scoresheets.view' }))
    await waitFor(() => expect(toasts.error.length).toBe(1))
    // the tab opened at the click is closed again
    expect(opened.close).toHaveBeenCalled()
    expect(api.pdf).not.toHaveBeenCalled()
  })

  it('a server without view links: the tab gets the PDF itself; a blocked popup saves it instead', async () => {
    api.pdf.mockResolvedValue({ blob: pdfBlob, filename: 'scoresheet_game402397_2026-10-10.pdf' })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<ScoresheetsPanel />)
    await screen.findByText('Voléro vs Smash')
    const view = () => within(rowOf('Voléro vs Smash')).getByRole('button', { name: 'manage.scoresheets.view' })
    fireEvent.click(view())
    await waitFor(() => expect(opened.location.href).toBe(SHEET_URL))
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
    // the tab opened at the click is closed again; nothing else was opened
    expect(opened.close).toHaveBeenCalled()
    expect(window.open).toHaveBeenCalledTimes(1)
  })

  it('OpenBeach: a closed match has Reopen (beach competition managers too), which asks for a reason', async () => {
    api.list.mockResolvedValue({ data: { matches: [{ ...MATCHES[0], sport: 'beach', closed_at: '2026-10-10T16:40:00Z' }, { ...MATCHES[1], sport: 'beach' }] }, error: null, status: 200 })
    api.reopen.mockResolvedValue({ data: { match: { id: 'm-1' } }, error: null, status: 200 })
    render(<ScoresheetsPanel app="beach" />)
    await screen.findByText('Voléro vs Smash')
    // the open match has none
    expect(within(rowOf('Musterdorf vs Züri')).queryByRole('button', { name: 'manage.matches.reopen' })).toBeNull()
    fireEvent.click(within(rowOf('Voléro vs Smash')).getByRole('button', { name: 'manage.matches.reopen' }))
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Wrong pair' } })
    fireEvent.click(screen.getByTestId('reason-confirm'))
    await waitFor(() => expect(api.reopen).toHaveBeenCalledWith('m-1', { reason: 'Wrong pair' }))
    await waitFor(() => expect(api.list.mock.calls.length).toBeGreaterThan(1))
  })

  it('OpenVolley: no Reopen in the scoresheets (the admins reopen in Matches)', async () => {
    api.list.mockResolvedValue({ data: { matches: [{ ...MATCHES[0], closed_at: '2026-10-10T16:40:00Z' }] }, error: null, status: 200 })
    render(<ScoresheetsPanel app="indoor" />)
    await screen.findByText('Voléro vs Smash')
    expect(screen.queryByRole('button', { name: 'manage.matches.reopen' })).toBeNull()
  })

  it('an out-of-date PDF is marked (the match data changed after it)', async () => {
    api.list.mockResolvedValue({ data: { matches: [{ ...MATCHES[0], pdf_stale: true, data_changed_at: '2026-11-16T10:00:00Z' }, MATCHES[1]] }, error: null, status: 200 })
    render(<ScoresheetsPanel />)
    await screen.findByText('Voléro vs Smash')
    expect(within(rowOf('Voléro vs Smash')).getByTestId('scoresheet-stale')).toHaveTextContent('manage.scoresheets.stale')
    expect(within(rowOf('Musterdorf vs Züri')).queryByTestId('scoresheet-stale')).toBeNull()
  })

  it('Rebuild PDF: admins only; it asks why, draws the sheet from the server\'s data with the remark, and stores it', async () => {
    const closed = { ...MATCHES[0], closed_at: '2026-10-10T16:40:00Z', pdf_stale: true }
    api.list.mockResolvedValue({ data: { matches: [closed, MATCHES[1]] }, error: null, status: 200 })
    const record = { match: { id: 'm-1', game_n: 402397, external_id: 'match_1_abc' }, sets: [], events: [], liveState: null }
    const approval = { id: 'a1', slot: 'scorer', name: 'Ada Scorer', result_key: 'ov-result-v1|' }
    api.approvals.mockResolvedValue({ data: { match: {}, approvals: [approval] }, error: null, status: 200 })
    api.matchRecord.mockResolvedValue({ data: record, error: null, status: 200 })
    const drawn = { match: { id: 1 }, homeTeam: null, awayTeam: null, homePlayers: [], awayPlayers: [], sets: [], events: [] }
    fromCloud.fn.mockReturnValue(drawn)
    api.rebuild.mockResolvedValue({ data: { stored_at: '2026-11-16T10:05:00Z' }, error: null, status: 200 })

    // a competition manager: no Rebuild
    const { unmount } = render(<ScoresheetsPanel />)
    await screen.findByText('Voléro vs Smash')
    expect(screen.queryByTestId('scoresheet-rebuild')).toBeNull()
    unmount()

    render(<ScoresheetsPanel canRebuild />)
    await screen.findByText('Voléro vs Smash')
    // an open match without a PDF: nothing to rebuild
    expect(within(rowOf('Musterdorf vs Züri')).queryByTestId('scoresheet-rebuild')).toBeNull()
    fireEvent.click(within(rowOf('Voléro vs Smash')).getByTestId('scoresheet-rebuild'))
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Set start times corrected' } })
    fireEvent.click(screen.getByTestId('reason-confirm'))
    await waitFor(() => expect(api.matchRecord).toHaveBeenCalledWith('m-1'))
    // with the officials' account approvals: the stamps stay on the rebuilt sheet
    expect(api.approvals).toHaveBeenCalledWith('match_1_abc')
    expect(fromCloud.fn).toHaveBeenCalledWith({ ...record, approvals: [approval] })
    // drawn with the match's data and the remark: when and why
    const view = await screen.findByTestId('rebuild-scoresheet')
    expect(rebuildView.props.matchData).toBe(drawn)
    expect(view.textContent).toMatch(/^Rebuilt after the match: \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2} - Set start times corrected$/)
    // the PDF made: stored with the reason, the list read again
    const listed = api.list.mock.calls.length
    rebuildView.props.onDone({ blob: pdfBlob, filename: 'game402397_1L_2026-10-10.pdf' })
    await waitFor(() => expect(api.rebuild).toHaveBeenCalledWith('m-1', { reason: 'Set start times corrected', fileBase64: 'JVBERi0xLjQ=' }, expect.objectContaining({ signal: expect.anything() })))
    await waitFor(() => expect(toasts.success).toEqual(['manage.scoresheets.rebuilt']))
    await waitFor(() => expect(api.list.mock.calls.length).toBeGreaterThan(listed))
    expect(screen.queryByTestId('rebuild-scoresheet')).toBeNull()
  })

  it('Rebuild PDF: a sheet that could not be made stores nothing and says so', async () => {
    api.list.mockResolvedValue({ data: { matches: [{ ...MATCHES[0], closed_at: '2026-10-10T16:40:00Z' }] }, error: null, status: 200 })
    api.matchRecord.mockResolvedValue({ data: { match: { id: 'm-1' }, sets: [], events: [] }, error: null, status: 200 })
    fromCloud.fn.mockReturnValue({ match: {}, homePlayers: [], awayPlayers: [], sets: [], events: [] })
    render(<ScoresheetsPanel canRebuild />)
    await screen.findByText('Voléro vs Smash')
    fireEvent.click(screen.getByTestId('scoresheet-rebuild'))
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Times' } })
    fireEvent.click(screen.getByTestId('reason-confirm'))
    await screen.findByTestId('rebuild-scoresheet')
    rebuildView.props.onDone(null)
    await waitFor(() => expect(toasts.error).toEqual(['manage.scoresheets.rebuildFailed']))
    expect(api.rebuild).not.toHaveBeenCalled()
  })
  const openRebuild = async (reason = 'Times') => {
    fireEvent.click(screen.getByTestId('scoresheet-rebuild'))
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: reason } })
    fireEvent.click(screen.getByTestId('reason-confirm'))
  }
  const closedOnly = () => api.list.mockResolvedValue({ data: { matches: [{ ...MATCHES[0], closed_at: '2026-10-10T16:40:00Z' }] }, error: null, status: 200 })

  it('Rebuild PDF: cancelled while the PDF is made, a PDF that comes out late is never stored', async () => {
    closedOnly()
    api.matchRecord.mockResolvedValue({ data: { match: { id: 'm-1', external_id: 'x' }, sets: [], events: [] }, error: null, status: 200 })
    fromCloud.fn.mockReturnValue({ match: {}, homePlayers: [], awayPlayers: [], sets: [], events: [] })
    render(<ScoresheetsPanel canRebuild />)
    await screen.findByText('Voléro vs Smash')
    await openRebuild()
    await screen.findByTestId('rebuild-scoresheet')
    const late = rebuildView.props.onDone
    act(() => rebuildView.props.onCancel())
    expect(screen.queryByTestId('rebuild-scoresheet')).toBeNull()
    await act(async () => { await late({ blob: pdfBlob, filename: 'game402397.pdf' }) })
    await act(async () => { await late(null) })
    expect(api.rebuild).not.toHaveBeenCalled()
    expect(toasts.success).toEqual([])
    expect(toasts.error).toEqual([])
  })

  it('Rebuild PDF: Cancel while the PDF uploads aborts the request, shows no success, says it may be stored and reads the list again', async () => {
    closedOnly()
    api.matchRecord.mockResolvedValue({ data: { match: { id: 'm-1', external_id: 'x' }, sets: [], events: [] }, error: null, status: 200 })
    fromCloud.fn.mockReturnValue({ match: {}, homePlayers: [], awayPlayers: [], sets: [], events: [] })
    let signal = null
    let finish = () => {}
    api.rebuild.mockImplementation((_id, _body, opts) => {
      signal = opts?.signal
      return new Promise((resolve) => { finish = resolve; signal?.addEventListener('abort', () => resolve({ data: null, error: { aborted: true, message: 'Cancelled' }, status: 0 })) })
    })
    render(<ScoresheetsPanel canRebuild />)
    await screen.findByText('Voléro vs Smash')
    await openRebuild()
    await screen.findByTestId('rebuild-scoresheet')
    const listed = api.list.mock.calls.length
    let uploading
    act(() => { uploading = rebuildView.props.onDone({ blob: pdfBlob, filename: 'game402397.pdf' }) })
    await waitFor(() => expect(api.rebuild).toHaveBeenCalledTimes(1))
    expect(signal).toBeTruthy()
    act(() => rebuildView.props.onCancel())
    expect(signal.aborted).toBe(true)
    expect(screen.queryByTestId('rebuild-scoresheet')).toBeNull()
    await act(async () => { finish({ data: { stored_at: 'x' }, error: null, status: 200 }); await uploading })
    expect(toasts.success).toEqual([])
    expect(toasts.error).toEqual([])
    expect(toasts.info).toEqual(['manage.scoresheets.rebuildCancelledUpload'])
    await waitFor(() => expect(api.list.mock.calls.length).toBeGreaterThan(listed))
  })

  it('Rebuild PDF: no PDF in time says it took too long, stores nothing', async () => {
    closedOnly()
    api.matchRecord.mockResolvedValue({ data: { match: { id: 'm-1' }, sets: [], events: [] }, error: null, status: 200 })
    fromCloud.fn.mockReturnValue({ match: {}, homePlayers: [], awayPlayers: [], sets: [], events: [] })
    render(<ScoresheetsPanel canRebuild />)
    await screen.findByText('Voléro vs Smash')
    await openRebuild()
    await screen.findByTestId('rebuild-scoresheet')
    // no external id: no approvals to read
    expect(api.approvals).not.toHaveBeenCalled()
    rebuildView.props.onDone(null, { timedOut: true })
    await waitFor(() => expect(toasts.error).toEqual(['manage.scoresheets.rebuildTimedOut']))
    expect(screen.queryByTestId('rebuild-scoresheet')).toBeNull()
    expect(api.rebuild).not.toHaveBeenCalled()
  })

  it('Rebuild PDF: approvals that cannot be read stop it (the stamps would be lost); a server without the feature has none', async () => {
    closedOnly()
    api.matchRecord.mockResolvedValue({ data: { match: { id: 'm-1', external_id: 'match_1_abc' }, sets: [], events: [] }, error: null, status: 200 })
    fromCloud.fn.mockReturnValue({ match: {}, homePlayers: [], awayPlayers: [], sets: [], events: [] })
    api.approvals.mockResolvedValue({ data: null, error: { message: 'Bad gateway', status: 502 }, status: 502 })
    render(<ScoresheetsPanel canRebuild />)
    await screen.findByText('Voléro vs Smash')
    await openRebuild()
    expect(await screen.findByText('manage.scoresheets.rebuildApprovalsFailed')).toBeInTheDocument()
    expect(fromCloud.fn).not.toHaveBeenCalled()
    expect(screen.queryByTestId('rebuild-scoresheet')).toBeNull()

    api.approvals.mockResolvedValue({ data: null, error: { code: 'OV_APPROVAL_UNAVAILABLE' }, status: 503 })
    fireEvent.click(screen.getByTestId('reason-confirm'))
    await screen.findByTestId('rebuild-scoresheet')
    expect(fromCloud.fn).toHaveBeenCalledWith(expect.objectContaining({ approvals: [] }))
  })
})
