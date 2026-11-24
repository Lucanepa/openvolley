import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

// Owner 23.11.2026: sign-up needs the licence number now; the accounts made
// before are asked for it at their next sign-in (LicenceAskHost, rendered by
// the real AuthProvider here, against a mocked backend).

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key, i18n: { language: 'en', changeLanguage: vi.fn() } })
}))

const db = vi.hoisted(() => ({ profile: null, updates: [], session: null }))
vi.mock('../../../lib/apiClient', () => {
  const from = () => {
    let update = null
    const query = {
      select: () => query,
      eq: () => query,
      update: (cols) => { update = cols; db.updates.push(cols); return query },
      maybeSingle: async () => ({ data: db.profile, error: null }),
      single: async () => {
        if (update) db.profile = { ...db.profile, ...update }
        return { data: db.profile, error: null }
      },
      then: (resolve) => resolve({ data: [], error: null })
    }
    return query
  }
  return {
    apiFrom: from,
    apiAuth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      getSession: async () => ({ data: { session: db.session } }),
      signInWithPassword: async () => ({ data: { user: { id: 'u-1', email: 'lea@club.ch' } }, error: null }),
      signOut: async () => ({ error: null })
    }
  }
})
vi.mock('../../../utils/backendConfig', () => ({ getCloudApiUrl: (path) => `https://example.test${path}` }))
vi.mock('../../../db/savedTeams', () => ({ clearSavedTeams: vi.fn(async () => {}), refreshSavedTeams: vi.fn(async () => {}) }))
vi.mock('../../../lib/accountApi', async (orig) => ({ ...(await orig()), fetchMe: vi.fn(async () => ({ data: null, error: { code: 'offline' }, status: 0 })) }))
const toasts = vi.hoisted(() => [])
vi.mock('../../../ui', async (orig) => {
  const real = await orig()
  return { ...real, toast: { ...real.toast, success: (m) => toasts.push(m) } }
})

import { AuthProvider, useAuth } from '../../../contexts/AuthContext'
import { askLicence, clearLicenceAsk, licenceAskPostponed } from '../licenceAsk'
import { clearPasskeyOffer, showPasskeyOffer } from '../passkeyOffer'

let api
function Probe () {
  api = useAuth()
  return null
}
const renderApp = () => render(<AuthProvider><Probe /></AuthProvider>)
const signIn = () => act(async () => { await api.signIn('lea@club.ch', 'secret1234') })

beforeEach(() => {
  db.profile = { user_id: 'u-1', first_name: 'Lea', last_name: 'Muster', country: 'CHE', license_number: null, roles: ['scorer'], sport_type: 'beach' }
  db.updates = []
  toasts.length = 0
  localStorage.clear()
  clearLicenceAsk()
  clearPasskeyOffer()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('LicenceAskHost', () => {
  it('a sign-in without a licence number asks for it; Save writes the licence number alone', async () => {
    renderApp()
    expect(screen.queryByTestId('licence-ask')).toBeNull()
    await signIn()
    const dialog = await screen.findByTestId('licence-ask')
    expect(dialog).toHaveTextContent('auth.licenceAsk.title')
    const input = screen.getByTestId('licence-ask-input')

    fireEvent.click(screen.getByTestId('licence-ask-save'))
    expect(await screen.findByText('auth.licenceNumberRequired')).toBeTruthy()
    fireEvent.change(input, { target: { value: '12' } })
    fireEvent.click(screen.getByTestId('licence-ask-save'))
    expect(await screen.findByText('auth.licenceNumberInvalid')).toBeTruthy()
    expect(db.updates).toEqual([])

    fireEvent.change(input, { target: { value: 'SV 123-456' } })
    expect(input).toHaveValue('123456')
    fireEvent.click(screen.getByTestId('licence-ask-save'))
    await waitFor(() => expect(screen.queryByTestId('licence-ask')).toBeNull())
    // only the licence number: an OpenBeach account keeps its sport and names
    expect(db.updates).toEqual([{ license_number: '123456' }])
    expect(api.profile.license_number).toBe('123456')
    expect(toasts).toContain('auth.licenceAsk.saved')
  })

  it('an account with a licence number is never asked', async () => {
    db.profile.license_number = '7654321'
    renderApp()
    await signIn()
    await act(async () => {})
    expect(screen.queryByTestId('licence-ask')).toBeNull()
  })

  it('"Later": not asked again here (the manager opening) until the next sign-in', async () => {
    renderApp()
    await signIn()
    fireEvent.click(await screen.findByTestId('licence-ask-later'))
    expect(screen.queryByTestId('licence-ask')).toBeNull()
    expect(licenceAskPostponed('u-1')).toBe(true)
    act(() => askLicence('u-1'))
    expect(screen.queryByTestId('licence-ask')).toBeNull()
    await signIn()
    expect(await screen.findByTestId('licence-ask')).toBeTruthy()
    expect(licenceAskPostponed('u-1')).toBe(false)
  })

  it('waits for the passkey offer after a password sign-in; never for another account', async () => {
    renderApp()
    act(() => showPasskeyOffer({ userId: 'u-1', password: 'secret1234' }))
    await signIn()
    await act(async () => {})
    expect(screen.queryByTestId('licence-ask')).toBeNull()
    act(() => clearPasskeyOffer())
    expect(await screen.findByTestId('licence-ask')).toBeTruthy()

    act(() => clearLicenceAsk())
    act(() => askLicence('u-other'))
    expect(screen.queryByTestId('licence-ask')).toBeNull()
  })

  it('signing out ends the question', async () => {
    renderApp()
    await signIn()
    await screen.findByTestId('licence-ask')
    await act(async () => { await api.signOut() })
    expect(screen.queryByTestId('licence-ask')).toBeNull()
  })
})
