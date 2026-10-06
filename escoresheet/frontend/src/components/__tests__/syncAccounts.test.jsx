import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, opts) => String(typeof fallback === 'string' ? fallback : key)
      .replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? ''))
  })
}))

// ConnectionStatus imports db (unused by these tests)
vi.mock('../../db/db', () => ({ db: {} }))
// Live sync queue counts (a Dexie live query in the app)
const live = vi.hoisted(() => ({ value: { pending: 0, error: 0, failed: 0 } }))
vi.mock('../../hooks/useSyncQueue', () => ({ useSyncQueueStats: () => live.value }))

const auth = vi.hoisted(() => ({ value: { user: null, loading: false } }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }))
vi.mock('../auth/LoginModal', () => ({ default: ({ open }) => (open ? <div>login-modal</div> : null) }))
vi.mock('../auth/SignUpModal', () => ({ default: () => null }))

import ConnectionStatus from '../ConnectionStatus'
import StartupConnectivityModal from '../StartupConnectivityModal'
import SyncSignInBanner, { shouldShowSyncSignIn } from '../auth/SyncSignInBanner'
import { confirmedProfileRow, profileUpdateColumns } from '../auth/profileWrite'
import { needsEmailConfirmation } from '../auth/signUpResult'

afterEach(() => {
  vi.restoreAllMocks()
  try { sessionStorage.clear() } catch { /* ignore */ }
})

const ONLINE_STATUSES = { supabase: 'connected', match: 'live', db: 'connected' }

describe('ConnectionStatus sync indicator', () => {
  it('offline shows "Offline" with the number of waiting changes, not "Error"', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(<ConnectionStatus connectionStatuses={{ ...ONLINE_STATUSES, supabase: 'offline' }} queueStats={{ pending: 7, error: 0, failed: 0 }} />)
    expect(screen.getByText('Offline (7 waiting)')).toBeInTheDocument()
    expect(screen.queryByText('Error')).toBeNull()
  })

  it('no external network but the local server/WebSocket connected (LAN) is not "Offline"', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(<ConnectionStatus connectionStatuses={{ ...ONLINE_STATUSES, supabase: 'offline', server: 'connected', websocket: 'connected' }} queueStats={{ pending: 3, error: 0, failed: 0 }} />)
    expect(screen.queryByText(/^Offline/)).toBeNull()
    expect(screen.getByText('Syncing...')).toBeInTheDocument()
  })

  it('an unreachable cloud without a local server reads as offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(<ConnectionStatus connectionStatuses={{ ...ONLINE_STATUSES, supabase: 'offline' }} queueStats={{ pending: 0, error: 0, failed: 0 }} />)
    expect(screen.getByText('Offline')).toBeInTheDocument()
  })

  it('a stuck (failed) job is not hidden behind "Connected"', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(<ConnectionStatus connectionStatuses={ONLINE_STATUSES} queueStats={{ pending: 0, error: 0, failed: 1 }} />)
    expect(screen.queryByText('Connected')).toBeNull()
    expect(screen.getByText('Error')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()

    // the dropdown lists it under the cloud row with a retry
    fireEvent.click(screen.getByText('Error'))
    expect(screen.getByText('Cloud sync:')).toBeInTheDocument()
    expect(screen.getByText('Refused by the server:')).toBeInTheDocument()
    expect(screen.getByText('Retry all')).toBeInTheDocument()
    expect(screen.queryByText(/Supabase/)).toBeNull()
  })

  it('says "Sign in to sync" when the cloud needs an account', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(<ConnectionStatus connectionStatuses={ONLINE_STATUSES} queueStats={{ pending: 3, error: 0, failed: 0, authRequired: true }} />)
    expect(screen.getByText('Sign in to sync')).toBeInTheDocument()
  })

  it('reads the counts from the local queue when the caller passes none (App, Referee)', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    live.value = { pending: 0, error: 1, failed: 2 }
    try {
      render(<ConnectionStatus connectionStatuses={ONLINE_STATUSES} queueStats={{ authRequired: false }} />)
      expect(screen.getByText('Error')).toBeInTheDocument()
      expect(screen.getByText('3')).toBeInTheDocument()
    } finally {
      live.value = { pending: 0, error: 0, failed: 0 }
    }
  })

  it('still renders when a caller passes the old sync status string', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(<ConnectionStatus connectionStatuses={ONLINE_STATUSES} queueStats="error" />)
    expect(screen.getByText('Connected')).toBeInTheDocument()
  })
})

describe('StartupConnectivityModal', () => {
  it('lists the cloud backend, not Supabase', () => {
    render(<StartupConnectivityModal open connectionStatuses={{ db: 'connected', supabase: 'connected', websocket: 'unknown' }} />)
    expect(screen.getByText('Cloud sync')).toBeInTheDocument()
    expect(screen.queryByText(/Supabase/)).toBeNull()
  })
})

describe('SyncSignInBanner', () => {
  it('shows only when the backend asked for a session', () => {
    expect(shouldShowSyncSignIn({ syncStatus: 'auth_required', user: null, loading: false, dismissed: false })).toBe(true)
    // a stored session the server revoked: the app still has a user
    expect(shouldShowSyncSignIn({ syncStatus: 'auth_required', user: { id: 'u' }, loading: false, dismissed: false })).toBe(true)
    expect(shouldShowSyncSignIn({ syncStatus: 'auth_required', user: null, loading: true, dismissed: false })).toBe(false)
    expect(shouldShowSyncSignIn({ syncStatus: 'auth_required', user: null, loading: false, dismissed: true })).toBe(false)
    // offline, LAN server without a cloud, synced: never
    for (const syncStatus of ['offline', 'online_no_supabase', 'synced', 'error']) {
      expect(shouldShowSyncSignIn({ syncStatus, user: null, loading: false, dismissed: false }), syncStatus).toBe(false)
    }
  })

  it('opens the sign-in and can be put off for the session', () => {
    auth.value = { user: null, loading: false }
    const { rerender } = render(<SyncSignInBanner syncStatus="auth_required" />)
    expect(screen.getByRole('status')).toHaveTextContent('saved on this device only')

    fireEvent.click(screen.getByText('Sign in'))
    expect(screen.getByText('login-modal')).toBeInTheDocument()

    rerender(<SyncSignInBanner syncStatus="synced" />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('a revoked or expired stored session asks to sign in again', () => {
    auth.value = { user: { id: 'u' }, loading: false }
    render(<SyncSignInBanner syncStatus="auth_required" />)
    expect(screen.getByRole('status')).toHaveTextContent('Session expired')
    fireEvent.click(screen.getByText('Sign in again'))
    expect(screen.getByText('login-modal')).toBeInTheDocument()
  })

  it('is a single compact line on the scoreboard', () => {
    auth.value = { user: null, loading: false }
    render(<SyncSignInBanner syncStatus="auth_required" compact />)
    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('saved on this device only')
    expect(banner).not.toHaveTextContent('Scoring keeps working')
    expect(banner.style.top).not.toBe('')
    expect(banner.style.bottom).toBe('')
  })

  it('"Later" hides it', () => {
    auth.value = { user: null, loading: false }
    render(<SyncSignInBanner syncStatus="auth_required" />)
    fireEvent.click(screen.getByText('Later'))
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('profile save', () => {
  const sent = profileUpdateColumns({ firstName: 'E2E Renamed', lastName: 'Tester2', country: 'CHE', dob: '' })

  it('sends only the editable columns (never roles)', () => {
    expect(sent).toEqual({ first_name: 'E2E Renamed', last_name: 'Tester2', country: 'CHE', dob: null, sport_type: 'indoor' })
    expect('roles' in profileUpdateColumns({ roles: ['admin'] })).toBe(false)
  })

  it('is confirmed only by the written row coming back', () => {
    const written = { user_id: 'u', first_name: 'E2E Renamed', last_name: 'Tester2', country: 'CHE', dob: null }
    expect(confirmedProfileRow(sent, written)).toBe(written)
    expect(confirmedProfileRow(sent, [written])).toBe(written)
    // an old client's SELECT answered with the unchanged row: not saved
    expect(confirmedProfileRow(sent, { ...written, first_name: 'E2E', last_name: 'Accounts' })).toBeNull()
    // no row at all
    expect(confirmedProfileRow(sent, null)).toBeNull()
    expect(confirmedProfileRow(sent, [])).toBeNull()
  })

  it('compares the date of birth by day', () => {
    const withDob = profileUpdateColumns({ firstName: 'A', lastName: 'B', country: 'CHE', dob: '1990-02-03' })
    expect(confirmedProfileRow(withDob, { first_name: 'A', last_name: 'B', country: 'CHE', dob: '1990-02-03' })).not.toBeNull()
    expect(confirmedProfileRow(withDob, { first_name: 'A', last_name: 'B', country: 'CHE', dob: '1990-02-04' })).toBeNull()
  })
})

describe('sign-up result', () => {
  it('asks to check the email only for an unconfirmed account', () => {
    expect(needsEmailConfirmation({ user: { id: 'u', email_confirmed_at: '2026-10-05T15:36:06Z' } })).toBe(false)
    expect(needsEmailConfirmation({ user: { id: 'u', email_confirmed_at: null } })).toBe(true)
    expect(needsEmailConfirmation(null)).toBe(false)
  })
})
