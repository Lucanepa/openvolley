// A sign-in fires `ov-signed-in` exactly once: the update checks listen for
// it. Two branches that each add their own dispatch merge without a conflict
// into two events per sign-in; this catches it.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'

const auth = vi.hoisted(() => ({ listener: null }))

vi.mock('../../utils/backendConfig', () => ({ getCloudApiUrl: (p) => `https://api.example.test${p}` }))
vi.mock('../../lib/apiClient', () => ({
  apiAuth: {
    onAuthStateChange: (cb) => {
      auth.listener = cb
      return { data: { subscription: { unsubscribe: () => {} } } }
    },
    getSession: () => new Promise(() => {}),
  },
  apiFrom: () => ({}),
}))
vi.mock('../../db/savedTeams', () => ({ clearSavedTeams: vi.fn(), refreshSavedTeams: vi.fn(() => Promise.resolve()) }))
vi.mock('../../lib/accountApi', () => ({ redeemInvite: vi.fn() }))
vi.mock('../../utils/logger', () => ({ discardUnsentLogs: vi.fn() }))

import { AuthProvider } from '../AuthContext'

describe('AuthProvider sign-in event', () => {
  let count
  const onSignedIn = () => { count += 1 }
  beforeEach(() => {
    count = 0
    window.addEventListener('ov-signed-in', onSignedIn)
  })
  afterEach(() => {
    window.removeEventListener('ov-signed-in', onSignedIn)
    cleanup()
  })

  it('fires ov-signed-in once per sign-in, and not for other auth events', async () => {
    render(<AuthProvider><div /></AuthProvider>)
    expect(auth.listener).toBeTypeOf('function')
    const session = { user: { id: 'u1' } }
    await act(async () => { await auth.listener('SIGNED_IN', session) })
    expect(count).toBe(1)
    await act(async () => { await auth.listener('USER_UPDATED', session) })
    await act(async () => { await auth.listener('SIGNED_OUT', null) })
    expect(count).toBe(1)
  })
})
