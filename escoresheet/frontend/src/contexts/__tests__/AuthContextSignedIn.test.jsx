import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'

const auth = vi.hoisted(() => ({ onChange: null }))

vi.mock('../../lib/apiClient', () => {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    then: (resolve) => resolve({ data: [], error: null }),
  }
  return {
    apiFrom: () => query,
    apiAuth: {
      onAuthStateChange: (cb) => {
        auth.onChange = cb
        return { data: { subscription: { unsubscribe: () => {} } } }
      },
      getSession: async () => ({ data: { session: null } }),
    },
  }
})
vi.mock('../../utils/backendConfig', () => ({ getCloudApiUrl: (path) => `https://example.test${path}` }))
vi.mock('../../db/savedTeams', () => ({ clearSavedTeams: vi.fn(async () => {}), refreshSavedTeams: vi.fn(async () => {}) }))

import { AuthProvider } from '../AuthContext'

// The update checks (Android: utils/androidUpdate.js, the desktop app:
// hooks/useDesktopUpdate.js) run on 'ov-signed-in'. Both update branches added
// a dispatch at different lines, which git merges without a conflict: this
// fails if a merge leaves two.
describe('AuthProvider sign-in event', () => {
  afterEach(() => { auth.onChange = null })

  it('fires ov-signed-in exactly once per sign-in, and not for other events', async () => {
    const seen = vi.fn()
    window.addEventListener('ov-signed-in', seen)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    render(<AuthProvider><div /></AuthProvider>)
    expect(typeof auth.onChange).toBe('function')

    await act(async () => { await auth.onChange('INITIAL_SESSION', null) })
    expect(seen).not.toHaveBeenCalled()

    await act(async () => { await auth.onChange('SIGNED_IN', { user: { id: 'u1' } }) })
    expect(seen).toHaveBeenCalledTimes(1)

    await act(async () => { await auth.onChange('TOKEN_REFRESHED', { user: { id: 'u1' } }) })
    expect(seen).toHaveBeenCalledTimes(1)

    window.removeEventListener('ov-signed-in', seen)
    log.mockRestore()
  })
})
