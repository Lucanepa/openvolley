import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen, waitFor, act } from '@testing-library/react'

// Keys stay visible; the interpolated values the tests look for are appended
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k, o) => (typeof o === 'string' ? o : o?.email ? `${k}:${o.email}` : o?.name ? `${k}:${o.name}` : k),
    i18n: { language: 'de-CH' }
  })
}))
vi.mock('../../hooks/useScaledLayout', () => ({ useScaledLayout: () => ({ scaleFactor: 1 }) }))
// No backend is ever contacted: getCloudApiUrl answers a test URL and fetch is a stub
const api = vi.hoisted(() => ({ url: 'https://backend.example.test/api/contact' }))
vi.mock('../../utils/backendConfig', () => ({ getCloudApiUrl: () => api.url }))
const openAppWindow = vi.hoisted(() => vi.fn())
vi.mock('../../utils/openAppWindow', () => ({ openAppWindow }))
// The diagnostics report of the device (utils/diagnosticsCollect, loaded by the dialog when needed)
const diag = vi.hoisted(() => ({ make: null }))
vi.mock('../../utils/diagnosticsCollect', () => ({ createDiagnosticsReport: (...args) => diag.make(...args) }))
const REPORT = Object.freeze({
  text: 'OpenVolley diagnostics\n\n== 1. Summary ==\nApp:  OpenVolley – scorer app\n\n== 3. Timeline ==\n22:01:03.120  tap     "Point A"  Scoreboard\n\n== end of report ==\n',
  bytes: 131,
  lines: 9,
  fileName: 'openvolley-diagnostics-20261029-2201-g4711.txt'
})

import SupportFeedbackModal from '../SupportFeedbackModal'
import { setActiveMatch } from '../../utils/activity/activeMatch'
import { setLiveMatch } from '../../utils/appLifecycle'

const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' })

function selectByLabel(label, value) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

/** Fills the form down to the submit button: support, bug, severity 2. */
function fillBug({ email = 'tester@example.ch' } = {}) {
  selectByLabel('supportFeedback.contactTypeLabel', 'support')
  selectByLabel('supportFeedback.supportTypeLabel', 'bug')
  selectByLabel('supportFeedback.severityLabel', '2')
  fireEvent.change(screen.getByLabelText('supportFeedback.commentsLabel'), { target: { value: 'Undo does nothing after a time-out' } })
  fireEvent.change(screen.getByLabelText('supportFeedback.emailLabel'), { target: { value: email } })
}

const attach = (...files) => fireEvent.change(screen.getByLabelText('supportFeedback.attachmentsLabel'), { target: { files } })
const submit = () => fireEvent.click(screen.getByRole('button', { name: /supportFeedback\.send$/ }))

describe('SupportFeedbackModal', () => {
  let fetchMock
  beforeEach(() => {
    api.url = 'https://backend.example.test/api/contact'
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    openAppWindow.mockClear()
    diag.make = vi.fn(async () => REPORT)
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setActiveMatch(null)
    setLiveMatch('none')
  })

  it('starts on the section the help panel passes; older page names are mapped', () => {
    const { unmount } = render(<SupportFeedbackModal open onClose={() => {}} area="subs-timeouts" />)
    selectByLabel('supportFeedback.contactTypeLabel', 'support')
    expect(screen.getByLabelText('supportFeedback.areaLabel').value).toBe('subs-timeouts')
    unmount()
    render(<SupportFeedbackModal open onClose={() => {}} currentPage="options" />)
    selectByLabel('supportFeedback.contactTypeLabel', 'feedback')
    const areas = screen.getByLabelText('supportFeedback.areaLabel')
    expect(areas.value).toBe('home')
    expect([...areas.options].map((o) => o.value)).toEqual(['', 'home', 'setup', 'coin-toss', 'scoring', 'subs-timeouts', 'sanctions',
      'set-end', 'match-end', 'corrections', 'connections', 'referee', 'bench', 'livescore', 'handover', 'sync-offline', 'install-updates', 'other'])
  })

  it('sends the message with its attachments for real, then says where the answer goes', async () => {
    render(<SupportFeedbackModal open onClose={() => {}} area="scoring" />)
    fillBug()
    attach(png(), new File(['{"a":1}'], 'backup.json', { type: 'application/json' }))
    expect(screen.getByText('shot.png')).toBeInTheDocument()
    submit()
    await screen.findByText('supportFeedback.thankYouSupport')
    expect(screen.getByText('supportFeedback.replyTo:tester@example.ch')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://backend.example.test/api/contact')
    const fd = init.body
    expect(fd).toBeInstanceOf(FormData)
    expect([fd.get('contactType'), fd.get('area'), fd.get('supportType'), fd.get('severity'), fd.get('email')])
      .toEqual(['support', 'scoring', 'bug', '2', 'tester@example.ch'])
    expect([fd.get('source'), fd.get('language')]).toEqual(['app', 'de-CH'])
    expect(fd.getAll('files').map((f) => f.name)).toEqual(['shot.png', 'backup.json'])
    expect(fd.has('diagnostics')).toBe(false)
    expect(openAppWindow).not.toHaveBeenCalled()
  })

  const matchBox = () => screen.getByLabelText('supportFeedback.matchRunning')
  const sentForm = () => fetchMock.mock.calls[0][1].body

  it('"A match is running right now": ticked while this device scores an official match, and sent as matchRunning=1', async () => {
    // App.jsx's live match: the local match in status 'live' (coin toss to match end)
    setLiveMatch('official')
    render(<SupportFeedbackModal open onClose={() => {}} area="scoring" />)
    fillBug()
    expect(matchBox().checked).toBe(true)
    submit()
    await screen.findByText('supportFeedback.thankYouSupport')
    expect(sentForm().get('matchRunning')).toBe('1')
  })

  it('not ticked without a match scored here, nor for a test or easy match; then not sent', async () => {
    for (const live of ['none', 'test']) {
      setLiveMatch(live)
      fetchMock.mockClear()
      const { unmount } = render(<SupportFeedbackModal open onClose={() => {}} area="scoring" />)
      fillBug()
      expect(matchBox().checked, live).toBe(false)
      submit()
      await screen.findByText('supportFeedback.thankYouSupport')
      expect(sentForm().has('matchRunning'), live).toBe(false)
      unmount()
    }
  })

  it('follows the match until the user ticks or unticks it; unticked, it is not sent', async () => {
    const { rerender } = render(<SupportFeedbackModal open onClose={() => {}} area="scoring" />)
    fillBug()
    expect(matchBox().checked).toBe(false)
    act(() => setLiveMatch('official'))
    expect(matchBox().checked, 'the match went live while the dialog was open').toBe(true)
    fireEvent.click(matchBox())
    expect(matchBox().checked).toBe(false)
    act(() => { setLiveMatch('none'); setLiveMatch('official') })
    expect(matchBox().checked, 'the user\'s choice stays').toBe(false)
    submit()
    await screen.findByText('supportFeedback.thankYouSupport')
    expect(sentForm().has('matchRunning')).toBe(false)
    // closed and opened again: detected afresh
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
    rerender(<SupportFeedbackModal open={false} onClose={() => {}} area="scoring" />)
    rerender(<SupportFeedbackModal open onClose={() => {}} area="scoring" />)
    selectByLabel('supportFeedback.contactTypeLabel', 'feedback')
    expect(matchBox().checked).toBe(true)
  })

  it('shown for every contact type; ticked by hand for feedback, it is sent', async () => {
    render(<SupportFeedbackModal open onClose={() => {}} area="home" />)
    expect(screen.queryByLabelText('supportFeedback.matchRunning')).toBeNull()
    for (const type of ['support', 'request', 'feedback']) {
      selectByLabel('supportFeedback.contactTypeLabel', type)
      expect(matchBox().checked, type).toBe(false)
    }
    fireEvent.click(matchBox())
    fireEvent.change(screen.getByLabelText('supportFeedback.commentsLabel'), { target: { value: 'The court lines are hard to read' } })
    fireEvent.change(screen.getByLabelText('supportFeedback.emailLabel'), { target: { value: 'tester@example.ch' } })
    submit()
    await screen.findByText('supportFeedback.thankYouFeedback')
    expect([sentForm().get('contactType'), sentForm().get('matchRunning')]).toEqual(['feedback', '1'])
  })

  it('a severity left from a bug report is not sent once the message is feedback or a question', async () => {
    render(<SupportFeedbackModal open onClose={() => {}} area="scoring" />)
    fillBug()
    selectByLabel('supportFeedback.supportTypeLabel', 'help')
    submit()
    await screen.findByText('supportFeedback.thankYouSupport')
    expect([sentForm().get('supportType'), sentForm().get('severity')]).toEqual(['help', ''])
  })

  const diagBox = () => screen.getByLabelText(/supportFeedback\.includeDiagnostics/)
  const showButton = () => screen.findByRole('button', { name: /supportFeedback\.(show|hide)Diagnostics/ })

  it('"Include diagnostics" is ticked for a bug report; "Show what is sent" shows exactly the file that goes', async () => {
    setActiveMatch({ id: 3, gameNumber: 4711 })
    render(<SupportFeedbackModal open onClose={() => {}} area="scoring" />)
    fillBug()
    expect(diagBox().checked).toBe(true)
    const toggle = await showButton()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText('supportFeedback.diagnosticsSize')).toBeInTheDocument()
    expect(screen.queryByLabelText('supportFeedback.diagnosticsPreview')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toContain('supportFeedback.hideDiagnostics')
    expect(screen.getByLabelText('supportFeedback.diagnosticsPreview').textContent).toBe(REPORT.text)
    submit()
    await screen.findByText('supportFeedback.thankYouSupport')
    const fd = sentForm()
    const file = fd.get('diagnosticsFile')
    expect(file.name).toBe(REPORT.fileName)
    expect(await file.text()).toBe(REPORT.text)
    expect(fd.getAll('files')).toEqual([])
    expect(fd.has('diagnostics')).toBe(false)
    expect(diag.make).toHaveBeenCalledTimes(1)
    expect(diag.make).toHaveBeenCalledWith({ gameNumber: undefined, language: 'de-CH' })
  })

  it('ticked for a question too', async () => {
    render(<SupportFeedbackModal open onClose={() => {}} area="connections" />)
    selectByLabel('supportFeedback.contactTypeLabel', 'support')
    selectByLabel('supportFeedback.supportTypeLabel', 'help')
    expect(diagBox().checked).toBe(true)
    await showButton()
    fireEvent.change(screen.getByLabelText('supportFeedback.commentsLabel'), { target: { value: 'How do I connect the bench?' } })
    fireEvent.change(screen.getByLabelText('supportFeedback.emailLabel'), { target: { value: 'tester@example.ch' } })
    submit()
    await screen.findByText('supportFeedback.thankYouSupport')
    expect(sentForm().get('diagnosticsFile').name).toBe(REPORT.fileName)
  })

  it('unticked for feedback and requests: nothing made or sent; ticked by hand, the report is made and sent', async () => {
    render(<SupportFeedbackModal open onClose={() => {}} area="home" />)
    for (const type of ['feedback', 'request']) {
      selectByLabel('supportFeedback.contactTypeLabel', type)
      expect(diagBox().checked, type).toBe(false)
    }
    expect(diag.make).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('supportFeedback.commentsLabel'), { target: { value: 'A dark mode please' } })
    fireEvent.change(screen.getByLabelText('supportFeedback.emailLabel'), { target: { value: 'tester@example.ch' } })
    submit()
    await screen.findByText('supportFeedback.thankYouRequest')
    expect(sentForm().has('diagnosticsFile')).toBe(false)
    expect(sentForm().has('diagnostics')).toBe(false)
    expect(diag.make).not.toHaveBeenCalled()
  })

  it('feedback ticked by hand: the report is made then, and sent', async () => {
    render(<SupportFeedbackModal open onClose={() => {}} area="home" />)
    selectByLabel('supportFeedback.contactTypeLabel', 'feedback')
    fireEvent.click(diagBox())
    expect(diagBox().checked).toBe(true)
    await showButton()
    fireEvent.change(screen.getByLabelText('supportFeedback.commentsLabel'), { target: { value: 'Lovely app' } })
    fireEvent.change(screen.getByLabelText('supportFeedback.emailLabel'), { target: { value: 'tester@example.ch' } })
    submit()
    await screen.findByText('supportFeedback.thankYouFeedback')
    expect(sentForm().get('diagnosticsFile').name).toBe(REPORT.fileName)
  })

  it('unticked by the user: not sent, and a change of type keeps the choice; ticked again, a new report', async () => {
    render(<SupportFeedbackModal open onClose={() => {}} area="scoring" />)
    fillBug()
    await showButton()
    fireEvent.click(diagBox())
    expect(diagBox().checked).toBe(false)
    expect(screen.queryByRole('button', { name: /supportFeedback\.showDiagnostics/ })).toBeNull()
    selectByLabel('supportFeedback.supportTypeLabel', 'help')
    expect(diagBox().checked, 'the user\'s choice stays').toBe(false)
    submit()
    await screen.findByText('supportFeedback.thankYouSupport')
    expect(sentForm().has('diagnosticsFile')).toBe(false)
    expect(sentForm().has('diagnostics')).toBe(false)
    expect(diag.make).toHaveBeenCalledTimes(1)
  })

  it('ticked again after unticking: a new snapshot', async () => {
    render(<SupportFeedbackModal open onClose={() => {}} area="scoring" />)
    fillBug()
    await showButton()
    fireEvent.click(diagBox())
    fireEvent.click(diagBox())
    await showButton()
    expect(diag.make).toHaveBeenCalledTimes(2)
  })

  it('still being made when Send is pressed: the message waits for it', async () => {
    let finish
    diag.make = vi.fn(() => new Promise((resolve) => { finish = resolve }))
    render(<SupportFeedbackModal open onClose={() => {}} area="scoring" />)
    fillBug()
    expect(screen.getByRole('status').textContent).toBe('supportFeedback.diagnosticsPreparing')
    submit()
    await act(async () => { await Promise.resolve() })
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => { finish(REPORT) })
    await screen.findByText('supportFeedback.thankYouSupport')
    expect(sentForm().get('diagnosticsFile').name).toBe(REPORT.fileName)
  })

  it('the report cannot be made: the short JSON is shown, and sent instead', async () => {
    diag.make = vi.fn(async () => { throw new Error('IndexedDB blocked') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setActiveMatch({ id: 3, gameNumber: 4711 })
    render(<SupportFeedbackModal open onClose={() => {}} area="scoring" />)
    fillBug()
    const preview = await screen.findByLabelText('supportFeedback.diagnosticsPreview')
    expect(screen.getByText('supportFeedback.diagnosticsFailed')).toBeInTheDocument()
    const shown = JSON.parse(preview.textContent)
    expect(shown).toMatchObject({ appVersion: '0.0.0-test', platform: 'web', displayMode: 'auto', online: true, gameNumber: 4711 })
    submit()
    await screen.findByText('supportFeedback.thankYouSupport')
    expect(JSON.parse(sentForm().get('diagnostics'))).toEqual(shown)
    expect(sentForm().has('diagnosticsFile')).toBe(false)
    warn.mockRestore()
  })

  it('sending failed: "Download diagnostics" saves the same file to attach to the email', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: false, code: 'send_failed' }), { status: 502 }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const blobs = []
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn((b) => { blobs.push(b); return 'blob:diag' }), revokeObjectURL: vi.fn() }))
    const clicked = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { clicked.push([this.download, this.href]) })
    render(<SupportFeedbackModal open onClose={() => {}} area="scoring" />)
    fillBug()
    await showButton()
    submit()
    expect((await screen.findByRole('alert')).textContent).toBe('supportFeedback.sendError')
    fireEvent.click(screen.getByRole('button', { name: /supportFeedback\.downloadDiagnostics/ }))
    expect(clicked).toEqual([[REPORT.fileName, 'blob:diag']])
    expect(await blobs[0].text()).toBe(REPORT.text)
    fireEvent.click(screen.getByRole('button', { name: /supportFeedback\.sendByEmail/ }))
    const body = new URL(openAppWindow.mock.calls[0][0]).searchParams.get('body')
    expect(body).toContain(`Diagnostics file to attach: ${REPORT.fileName}`)
    // the email app's screen offers the file again
    expect(screen.getByText('supportFeedback.mailtoAttachDiagnostics')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /supportFeedback\.downloadDiagnostics/ }))
    expect(clicked).toHaveLength(2)
    click.mockRestore()
    err.mockRestore()
  })

  it('no download button when diagnostics are unticked', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 503 }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<SupportFeedbackModal open onClose={() => {}} area="scoring" />)
    fillBug()
    await showButton()
    fireEvent.click(diagBox())
    submit()
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: /supportFeedback\.sendByEmail/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /supportFeedback\.downloadDiagnostics/ })).toBeNull()
    err.mockRestore()
  })

  it('refuses a file of another kind or one too many when picked', () => {
    render(<SupportFeedbackModal open onClose={() => {}} area="home" />)
    fillBug()
    attach(new File(['MZ'], 'setup.exe'))
    expect(screen.getByRole('alert').textContent).toBe('supportFeedback.fileType:setup.exe')
    expect(screen.queryByText('setup.exe')).toBeNull()
    attach(png(), png(), png(), png(), png())
    expect(screen.queryByRole('alert')).toBeNull()
    attach(png())
    expect(screen.getByRole('alert').textContent).toBe('supportFeedback.tooManyFiles')
    expect(screen.getAllByText('shot.png')).toHaveLength(5)
  })

  it('checks the address before sending', () => {
    render(<SupportFeedbackModal open onClose={() => {}} area="home" />)
    fillBug({ email: 'tester@example' })
    submit()
    expect(screen.getByRole('alert').textContent).toBe('supportFeedback.invalidEmail')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sending failed: the error, and the same message by email', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: false, code: 'unavailable' }), { status: 503 }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<SupportFeedbackModal open onClose={() => {}} area="connections" />)
    fillBug()
    attach(png())
    submit()
    expect((await screen.findByRole('alert')).textContent).toBe('supportFeedback.sendError')
    fireEvent.click(screen.getByRole('button', { name: /supportFeedback\.sendByEmail/ }))
    expect(openAppWindow).toHaveBeenCalledTimes(1)
    const href = openAppWindow.mock.calls[0][0]
    expect(href.startsWith('mailto:support@openvolley.app?')).toBe(true)
    expect(new URL(href).searchParams.get('body')).toContain('1 file(s) to attach: shot.png')
    expect(screen.getByText('supportFeedback.mailtoOpened')).toBeInTheDocument()
    expect(screen.getByText('supportFeedback.mailtoAttach')).toBeInTheDocument()
    err.mockRestore()
  })

  it('a refusal the user can fix (bad file on the server) shows it, without the email button', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: false, code: 'file_type', file: 'x.png' }), { status: 415 }))
    render(<SupportFeedbackModal open onClose={() => {}} area="home" />)
    fillBug()
    submit()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('supportFeedback.fileType:x.png'))
    expect(screen.queryByRole('button', { name: /supportFeedback\.sendByEmail/ })).toBeNull()
  })

  it('offline: no request, the email button at once', () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(<SupportFeedbackModal open onClose={() => {}} area="sync-offline" />)
    fillBug()
    submit()
    expect(screen.getByRole('alert').textContent).toBe('supportFeedback.offline')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /supportFeedback\.sendByEmail/ })).toBeInTheDocument()
    online.mockRestore()
  })

  it('no backend to send to: the email app at once, and the diagnostics file to download for it', async () => {
    api.url = null
    render(<SupportFeedbackModal open onClose={() => {}} area="install-updates" />)
    fillBug()
    submit()
    await screen.findByText('supportFeedback.mailtoTitle')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(openAppWindow).toHaveBeenCalledTimes(1)
    expect(new URL(openAppWindow.mock.calls[0][0]).searchParams.get('body')).toContain(`Diagnostics file to attach: ${REPORT.fileName}`)
    expect(screen.getByRole('button', { name: /supportFeedback\.downloadDiagnostics/ })).toBeInTheDocument()
  })
})
