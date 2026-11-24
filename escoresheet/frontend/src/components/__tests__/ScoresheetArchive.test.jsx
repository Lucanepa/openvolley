import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// The standalone archive (scoresheet subdomain): scoresheets are readable only
// by the uploading account, and this origin has its own session. It must offer
// a sign-in and open the scoresheet once signed in (no dead end). Its words are
// the app's (i18n, the real locale files here), in the page's language.

const state = vi.hoisted(() => ({ session: false, signInResult: { error: null }, listCalls: 0, extraRows: [] }))

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
      { external_id: 'm1', game_n: 992404, scheduled_at: '2026-10-06T18:00:00Z', match_info: { match_type_3: 'senior', match_type_1: 'championship', match_type_2: 'men', league: '2L' }, home_team: { name: 'E2E Home' }, away_team: { name: 'E2E Away' }, final_score: '3:0' },
      ...state.extraRows
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
import i18n from '../../i18n'

beforeEach(async () => {
  await i18n.changeLanguage('en')
  state.session = false
  state.signInResult = { error: null }
  state.listCalls = 0
  state.extraRows = []
})
afterEach(() => window.history.pushState({}, '', '/'))

describe('Scoresheet archive (standalone site)', () => {
  it('a league or match type named like an object member (constructor, __proto__) lists like any other', async () => {
    state.extraRows = ['constructor', '__proto__', 'toString'].map((name, i) => ({
      external_id: `x${i}`, game_n: 990000 + i, scheduled_at: '2026-10-07T18:00:00Z',
      match_info: { match_type_3: name, match_type_1: name, match_type_2: name, league: name },
      home_team: { name: 'Home' }, away_team: { name: 'Away' }, final_score: '3:1'
    }))
    render(<ScoresheetApp />)
    expect(await screen.findByText('Scoresheet archive')).toBeInTheDocument()
  })

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
    expect(await screen.findByText('Scoresheet not found')).toBeInTheDocument()
    // the redacted path, in the page's words: "<date>, game <n>"
    expect(screen.getByText(/found: 2026-10-06, game 111111\./)).toBeInTheDocument()
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

  it('speaks the page\'s language: German and French words, the sheet itself untouched', async () => {
    await i18n.changeLanguage('de')
    const { unmount } = render(<ScoresheetApp />)
    expect(await screen.findByRole('heading', { name: 'Archiv der Matchblätter' })).toBeInTheDocument()
    expect(screen.getByText('1 Matchblatt verfügbar')).toBeInTheDocument()
    expect(screen.getByText(/nur für das Schreiberkonto/)).toBeInTheDocument()
    // the archive's groups in Match Setup's words
    expect(screen.getByRole('button', { name: /Senior/ })).toBeInTheDocument()
    expect(screen.getByText('Archiv der Matchblätter').closest('[lang]')).toHaveAttribute('lang', 'de')
    fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }))
    expect(screen.getByLabelText('E-Mail')).toBeInTheDocument()
    expect(screen.getByLabelText('Passwort')).toBeInTheDocument()
    unmount()
    await i18n.changeLanguage('fr')
    window.history.pushState({}, '', '/?date=2026-10-06&game=992404')
    render(<ScoresheetApp />)
    expect(await screen.findByRole('heading', { name: 'Connecte-toi pour ouvrir cette feuille de match' })).toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Se connecter' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retour à la liste/ })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'scorer@example.ch' } })
    fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Se connecter' }))
    // the sheet (mocked here) opens as before
    expect(await screen.findByTestId('scoresheet')).toHaveTextContent('sheet of 992404')
  })
})
