import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key, i18n: { language: 'en' } })
}))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))
vi.mock('../../hooks/useScaledLayout', () => ({ useScaledLayout: () => ({ scaleFactor: 1 }) }))
vi.mock('../../utils/backendConfig', () => ({ getCloudApiUrl: (p) => `https://api.test${p}` }))

// apiFrom('svrz_games'): a thenable builder that records its calls and answers
// from `api.rows` (or with `api.error`), applying eq/gte like the server does.
const api = vi.hoisted(() => ({ rows: [], error: null, queries: [] }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: (table) => {
    const q = { table, select: null, eq: {}, gte: {} }
    api.queries.push(q)
    const b = {
      select: (cols) => { q.select = cols; return b },
      eq: (col, v) => { q.eq[col] = v; return b },
      gte: (col, v) => { q.gte[col] = v; return b },
      order: () => b,
      then: (resolve, reject) => {
        if (api.error) return Promise.resolve({ data: null, error: api.error }).then(resolve, reject)
        const data = api.rows.filter(r =>
          Object.entries(q.eq).every(([c, v]) => r[c] === v) &&
          Object.entries(q.gte).every(([c, v]) => r[c] >= v))
        return Promise.resolve({ data, error: null }).then(resolve, reject)
      }
    }
    return b
  }
}))

import LoadOfficialMatchModal from '../LoadOfficialMatchModal'

// svrz_games.datetime is TEXT like "2026-10-17T11:30:00.000000+00:00"
const isoInDays = (days) => {
  const d = new Date()
  d.setDate(d.getDate() + days)
  d.setHours(12, 0, 0, 0)
  return d.toISOString().replace(/\.\d{3}Z$/, '.000000+00:00')
}
const game = (n, gender, league, days) => ({
  game_number: n, gender, league, datetime: isoInDays(days), team_home: `Home ${n}`, team_away: `Away ${n}`
})

const leagueSelect = () => screen.getByRole('combobox', { name: 'loadOfficialMatch.league' })
const chooseGender = (g) => fireEvent.change(screen.getByRole('combobox', { name: 'loadOfficialMatch.gender' }), { target: { value: g } })

describe('LoadOfficialMatchModal league list', () => {
  beforeEach(() => {
    api.error = null
    api.queries = []
    api.rows = [
      game('M1', 'men', '1L', -200), // one-off, long past
      game('M2', 'men', '1L D', -10),
      game('M3', 'men', '1L D', 5),
      game('M4', 'men', '3L', 3),
      game('M5', 'men', '4L B', -1), // yesterday: not upcoming
      game('W1', 'women', '2L', 7)
    ]
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('lists leagues without upcoming games disabled, after the active ones, in one leagues request', async () => {
    render(<LoadOfficialMatchModal open onClose={() => {}} onSelectMatch={() => {}} />)
    await screen.findByRole('combobox', { name: 'loadOfficialMatch.gender' })
    chooseGender('men')

    // One request for every league, with the dates to count upcoming games
    expect(api.queries).toHaveLength(1)
    expect(api.queries[0].select).toContain('datetime')

    const select = leagueSelect()
    const options = within(select).getAllByRole('option')
    expect(options.map(o => o.value)).toEqual(['', '1L D', '3L', '1L', '4L B'])
    expect(options.map(o => o.disabled)).toEqual([false, false, false, true, true])

    const group = select.querySelector('optgroup')
    expect(group.getAttribute('label')).toBe('loadOfficialMatch.noUpcomingGames')
    expect([...group.querySelectorAll('option')].map(o => o.value)).toEqual(['1L', '4L B'])
    expect(within(select).getByRole('option', { name: '1L D (♂)' }).parentElement).toBe(select)

    // A disabled league cannot be chosen: no match query, nothing selected
    fireEvent.change(select, { target: { value: '1L' } })
    expect(api.queries).toHaveLength(1)
    expect(screen.queryByText('loadOfficialMatch.noUpcomingMatches')).toBeNull()
  })

  it('an active league is selectable and still loads its upcoming matches', async () => {
    render(<LoadOfficialMatchModal open onClose={() => {}} onSelectMatch={() => {}} />)
    await screen.findByRole('combobox', { name: 'loadOfficialMatch.gender' })
    chooseGender('men')
    fireEvent.change(leagueSelect(), { target: { value: '1L D' } })

    expect(await screen.findByText('Home M3')).toBeInTheDocument()
    expect(screen.queryByText('Home M2')).toBeNull() // past game of the same league
    expect(leagueSelect().value).toBe('1L D')
    const matchQuery = api.queries[1]
    expect(matchQuery.eq).toEqual({ gender: 'men', league: '1L D' })
    expect(matchQuery.gte.datetime).toBeTypeOf('string')
  })

  it('a gender with every league active shows no greyed-out group', async () => {
    render(<LoadOfficialMatchModal open onClose={() => {}} onSelectMatch={() => {}} />)
    await screen.findByRole('combobox', { name: 'loadOfficialMatch.gender' })
    chooseGender('women')
    const select = leagueSelect()
    expect(select.querySelector('optgroup')).toBeNull()
    expect(within(select).getAllByRole('option').map(o => o.disabled)).toEqual([false, false])
  })

  it('ICAL fallback leagues have no dates and all stay enabled', async () => {
    api.error = new Error('schedule down')
    const fetchMock = vi.fn(async (url) => ({
      ok: true,
      json: async () => (url.includes('/leagues')
        ? { success: true, leagues: [{ code: '2L', gender: 'men', federation: 'SVRZ' }, { code: '4L B', gender: 'men', federation: 'SVRZ' }] }
        : { success: true, matches: [] })
    }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    render(<LoadOfficialMatchModal open onClose={() => {}} onSelectMatch={() => {}} />)
    await screen.findByRole('combobox', { name: 'loadOfficialMatch.gender' })
    chooseGender('men')

    const select = leagueSelect()
    expect(select.querySelector('optgroup')).toBeNull()
    const options = within(select).getAllByRole('option')
    expect(options.map(o => o.value)).toEqual(['', '2L', '4L B'])
    expect(options.every(o => !o.disabled)).toBe(true)

    fireEvent.change(select, { target: { value: '4L B' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('league=4L B')))
    expect(leagueSelect().value).toBe('4L B')
  })
})
