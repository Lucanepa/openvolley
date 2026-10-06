import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// The standalone archive (scoresheet subdomain): scoresheets are readable only
// by the uploading account, and this origin has its own session. It must offer
// a sign-in and open the scoresheet once signed in (no dead end).

const state = vi.hoisted(() => ({ session: false, signInResult: { error: null }, listCalls: 0 }))

vi.mock('../../i18n', () => ({}))
vi.mock('../../../scoresheet_pdf/App_Scoresheet', () => ({
  default: ({ matchData }) => <div data-testid="scoresheet">sheet of {matchData?.match?.gameNumber}</div>
}))
vi.mock('../../contexts/AuthContext', async () => {
  const React = await import('react')
  const Ctx = React.createContext(null)
  function AuthProvider({ children }) {
    const [user, setUser] = React.useState(state.session ? { id: 'u1', email: 'scorer@example.ch' } : null)
    const value = {
      user,
      loading: false,
      signIn: async (email) => {
        const r = state.signInResult
        if (!r.error) { state.session = true; setUser({ id: 'u1', email }) }
        return r
      },
      signOut: async () => { state.session = false; setUser(null); return { error: null } }
    }
    return React.createElement(Ctx.Provider, { value }, children)
  }
  return { AuthProvider, useAuth: () => React.useContext(Ctx) }
})
const FILE = 'game992404_k0123456789abcdef0123456789abcdef_final.json'
vi.mock('../../lib/apiClient', () => ({
  apiFrom: () => {
    const b = { select: () => b, eq: () => b, order: () => b, limit: () => Promise.resolve({ data: [
      { external_id: 'm1', game_n: 992404, scheduled_at: '2026-10-06T18:00:00Z', match_info: { match_type_3: 'senior', match_type_1: 'championship', match_type_2: 'men', league: '2L' }, home_team: { name: 'E2E Home' }, away_team: { name: 'E2E Away' }, final_score: '3:0' }
    ], error: null }) }
    return b
  },
  apiStorage: {
    from: () => ({
      list: async () => {
        state.listCalls++
        if (!state.session) return { data: null, error: { status: 401, code: 'missing_token', message: 'Authentication required' } }
        return { data: [{ name: FILE, id: 'scoresheets/x' }], error: null }
      },
      download: async () => ({ data: { text: async () => JSON.stringify({ match: { gameNumber: 992404 } }) }, error: null })
    })
  }
}))

import ScoresheetApp from '../../ScoresheetApp'

beforeEach(() => {
  state.session = false
  state.signInResult = { error: null }
  state.listCalls = 0
})
afterEach(() => window.history.pushState({}, '', '/'))

describe('Scoresheet archive (standalone site)', () => {
  it('a View link without a session asks for sign-in, then opens the scoresheet', async () => {
    window.history.pushState({}, '', '/?date=2026-10-06&game=992404')
    render(<ScoresheetApp />)
    expect(await screen.findByRole('heading', { name: 'Sign in to open this scoresheet' })).toBeInTheDocument()
    expect(screen.getByText(/only for the scorer account that uploaded them/)).toBeInTheDocument()

    state.signInResult = { error: { message: 'Invalid login credentials' } }
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'scorer@example.ch' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid login credentials')

    state.signInResult = { error: null }
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByTestId('scoresheet')).toHaveTextContent('sheet of 992404')
    expect(state.listCalls).toBe(1) // no request without a session; one with it
  })

  it('another account\'s scoresheet: "not yours", with a way to switch account', async () => {
    state.session = true
    window.history.pushState({}, '', '/?date=2026-10-06&game=111111')
    render(<ScoresheetApp />)
    expect(await screen.findByText('Scoresheet Not Found')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with another account' }))
    expect(await screen.findByRole('heading', { name: 'Sign in to open this scoresheet' })).toBeInTheDocument()
  })

  it('the list says who may open scoresheets and offers sign-in; signed in it shows the account', async () => {
    render(<ScoresheetApp />)
    expect(await screen.findByText('Scoresheet archive')).toBeInTheDocument()
    expect(screen.getByText(/only for the scorer account that uploaded them/)).toBeInTheDocument()
    const signIn = screen.getByRole('button', { name: 'Sign in' })
    expect(signIn).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(signIn)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'scorer@example.ch' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Sign out/ })).toBeInTheDocument())
    expect(screen.getByText('scorer@example.ch')).toBeInTheDocument()
    expect(screen.queryByText(/only for the scorer account that uploaded them/)).toBeNull()
  })
})
