// Contact support in the "?" panel with the real support form and the app's
// English texts: the form opens on the section it was asked from and sends
// that section as its area (POST /api/contact, stubbed: nothing leaves).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import i18n from '../../../i18n'
import en from '../../../i18n/locales/en.json'

const api = vi.hoisted(() => ({ url: 'https://backend.example.test/api/contact' }))
vi.mock('../../../utils/backendConfig', async (importOriginal) => ({
  ...(await importOriginal()),
  getCloudApiUrl: () => api.url
}))
vi.mock('../../../utils/openAppWindow', () => ({ openAppWindow: vi.fn(() => ({ ok: true })) }))

import ContextualHelpPanel from '../ContextualHelpPanel'

const sectionEl = (id) => screen.getByTestId(`help-section-${id}`)
const select = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe('ContextualHelpPanel: Contact support with the real support form', () => {
  let fetchMock
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    localStorage.removeItem('offlineMode')
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('opens on the section it was asked from and sends it as the area; the panel stays open behind it', async () => {
    const onClose = vi.fn()
    render(<ContextualHelpPanel open onClose={onClose} screen="connectTablets" />)
    // not the screen's main section (connections): the bench's
    fireEvent.click(within(sectionEl('bench')).getAllByRole('button')[0])
    fireEvent.click(within(sectionEl('bench')).getByRole('button', { name: en.contextHelp.contactSupport }))
    expect(screen.getByText(en.supportFeedback.title)).toBeInTheDocument()

    select(en.supportFeedback.contactTypeLabel, 'support')
    const area = screen.getByLabelText(en.supportFeedback.areaLabel)
    expect(area.value).toBe('bench')
    expect(area.selectedOptions[0].textContent).toBe(en.supportFeedback.areas.bench)

    select(en.supportFeedback.supportTypeLabel, 'help')
    fireEvent.change(screen.getByLabelText(en.supportFeedback.commentsLabel), { target: { value: 'The bench tablet shows no time-outs' } })
    fireEvent.change(screen.getByLabelText(en.supportFeedback.emailLabel), { target: { value: 'scorer@example.ch' } })
    fireEvent.click(screen.getByRole('button', { name: en.supportFeedback.send }))
    await screen.findByText(en.supportFeedback.thankYouSupport)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://backend.example.test/api/contact')
    const fd = init.body
    expect([fd.get('contactType'), fd.get('area'), fd.get('supportType'), fd.get('source'), fd.get('language')])
      .toEqual(['support', 'bench', 'help', 'app', 'en'])

    // Escape is the form's while it is open; closed, the panel is still there
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    // the form's own Close, under its thank-you
    fireEvent.click(within(screen.getByRole('status').parentElement).getByRole('button', { name: en.common.close }))
    expect(screen.queryByText(en.supportFeedback.thankYouSupport)).toBeNull()
    expect(screen.getByTestId('help-panel').getAttribute('aria-modal')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a dialog\'s screen (Match › Corrections) passes its section, not its own name', () => {
    render(<ContextualHelpPanel open onClose={() => {}} screen="liveCorrections" />)
    fireEvent.click(within(sectionEl('corrections')).getByRole('button', { name: en.contextHelp.contactSupport }))
    select(en.supportFeedback.contactTypeLabel, 'feedback')
    expect(screen.getByLabelText(en.supportFeedback.areaLabel).value).toBe('corrections')
  })
})
