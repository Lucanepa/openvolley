import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'

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

import SupportFeedbackModal from '../SupportFeedbackModal'
import { setActiveMatch } from '../../utils/activity/activeMatch'

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
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setActiveMatch(null)
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

  it('"Include diagnostics" is off by default, shows what it sends, and sends exactly that', async () => {
    setActiveMatch({ id: 3, gameNumber: 4711 })
    render(<SupportFeedbackModal open onClose={() => {}} area="scoring" />)
    fillBug()
    const box = screen.getByLabelText(/supportFeedback\.includeDiagnostics/)
    expect(box.checked).toBe(false)
    expect(screen.queryByLabelText('supportFeedback.diagnosticsPreview')).toBeNull()
    fireEvent.click(box)
    const preview = screen.getByLabelText('supportFeedback.diagnosticsPreview')
    const shown = JSON.parse(preview.textContent)
    expect(shown).toMatchObject({ appVersion: '0.0.0-test', platform: 'web', displayMode: 'auto', online: true, gameNumber: 4711 })
    submit()
    await screen.findByText('supportFeedback.thankYouSupport')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body.get('diagnostics'))).toEqual(shown)
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

  it('no backend to send to: the email app at once', () => {
    api.url = null
    render(<SupportFeedbackModal open onClose={() => {}} area="install-updates" />)
    fillBug()
    submit()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(openAppWindow).toHaveBeenCalledTimes(1)
    expect(screen.getByText('supportFeedback.mailtoTitle')).toBeInTheDocument()
  })
})
