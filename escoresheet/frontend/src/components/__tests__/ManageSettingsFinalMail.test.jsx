import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// db/021: the final scoresheet by email. The Settings tab's switch (admins
// and competition managers, off by default, asks before turning on), the
// referees' optional addresses, and the test match's mail request

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))
const api = vi.hoisted(() => ({ settings: { get: vi.fn(), setFinalEmail: vi.fn() } }))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), settingsApi: api.settings }))
const ui = vi.hoisted(() => ({ confirm: vi.fn(async () => true), toasts: [] }))
vi.mock('../../ui', async (orig) => {
  const real = await orig()
  return {
    ...real,
    confirmDialog: (...a) => ui.confirm(...a),
    toast: { ...real.toast, success: (m) => ui.toasts.push(['ok', m]), error: (m) => ui.toasts.push(['error', m]) }
  }
})
vi.mock('../../utils/backendConfig', async (orig) => ({ ...(await orig()), getCloudApiUrl: (p) => `http://backend.test${p}` }))

import SettingsPanel from '../manage/SettingsPanel'
import { manageTabsFor } from '../manage/ManageConsole'
import { accessFromRoles } from '../../lib/access'
import { MANAGER_BRANDS } from '../../managerBrand'
import { cleanEmail } from '../MatchSetup'

const okRes = (data) => ({ data, error: null, status: 200 })

describe('the Settings tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ui.toasts = []
    ui.confirm.mockResolvedValue(true)
  })

  it('is OpenVolley\'s, for admins and competition managers', () => {
    expect(manageTabsFor(accessFromRoles(['competition_manager']), MANAGER_BRANDS.indoor)).toContain('settings')
    expect(manageTabsFor(accessFromRoles(['admin']), MANAGER_BRANDS.indoor)).toContain('settings')
    expect(manageTabsFor(accessFromRoles(['scorer']), MANAGER_BRANDS.indoor)).not.toContain('settings')
    expect(manageTabsFor(accessFromRoles(['admin']), MANAGER_BRANDS.beach)).not.toContain('settings')
  })

  it('off by default; turning it on asks first (the privacy policy), then saves', async () => {
    api.settings.get.mockResolvedValue(okRes({ settings: { send_final_email: false, changed_at: null }, mail: true }))
    api.settings.setFinalEmail.mockResolvedValue(okRes({ settings: { send_final_email: true }, mail: true }))
    render(<SettingsPanel />)
    const sw = await screen.findByTestId('final-email-switch')
    await waitFor(() => expect(sw).not.toBeDisabled())
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    await waitFor(() => expect(api.settings.setFinalEmail).toHaveBeenCalledWith(true))
    expect(ui.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'manage.settings.finalEmailOnTitle', message: 'manage.settings.finalEmailOnBody' }))

    // declined: nothing changes
    api.settings.setFinalEmail.mockClear()
    ui.confirm.mockResolvedValueOnce(false)
    fireEvent.click(sw)
    await waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(2))
    expect(api.settings.setFinalEmail).not.toHaveBeenCalled()
  })

  it('turning it off asks nothing; a server without email says so', async () => {
    api.settings.get.mockResolvedValue(okRes({ settings: { send_final_email: true, changed_at: '2026-10-29T10:00:00Z' }, mail: false }))
    api.settings.setFinalEmail.mockResolvedValue(okRes({ settings: { send_final_email: false }, mail: false }))
    render(<SettingsPanel />)
    expect(await screen.findByTestId('final-email-no-mail')).toBeInTheDocument()
    const sw = screen.getByTestId('final-email-switch')
    await waitFor(() => expect(sw).not.toBeDisabled())
    fireEvent.click(sw)
    await waitFor(() => expect(api.settings.setFinalEmail).toHaveBeenCalledWith(false))
    expect(ui.confirm).not.toHaveBeenCalled()
  })
})

describe('a referee\'s optional address', () => {
  it('kept trimmed and lower-case; anything else is dropped', () => {
    expect(cleanEmail('  Rita.Ref@Example.CH ')).toBe('rita.ref@example.ch')
    expect(cleanEmail('')).toBeNull()
    expect(cleanEmail('not an address')).toBeNull()
    expect(cleanEmail(undefined)).toBeNull()
  })
})

describe('the test match\'s mail request', () => {
  beforeEach(() => {
    localStorage.setItem('api_auth_token', JSON.stringify({ access_token: 'tok', expires_at: Date.now() / 1000 + 3600 }))
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { sent: true, to: 'me@example.ch' }, error: null }) }))
  })
  afterEach(() => localStorage.clear())

  it('carries the PDF as base64, the teams and the result', async () => {
    const { sendTestScoresheet } = await vi.importActual('../../lib/accountApi')
    const pdf = new Blob([new TextEncoder().encode('%PDF-1.4 test')], { type: 'application/pdf' })
    const res = await sendTestScoresheet(pdf, { teams: 'Home – Away', result: '3:1' })
    expect(res.data).toEqual({ sent: true, to: 'me@example.ch' })
    const [url, init] = globalThis.fetch.mock.calls[0]
    expect(url).toBe('http://backend.test/api/scoresheet/test-mail')
    const body = JSON.parse(init.body)
    expect(atob(body.pdf)).toBe('%PDF-1.4 test')
    expect(body).toMatchObject({ teams: 'Home – Away', result: '3:1' })
  })
})
