import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key, i18n: { language: 'en' } })
}))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))
vi.mock('../../hooks/useScaledLayout', () => ({ useScaledLayout: () => ({ scaleFactor: 1 }) }))
vi.mock('../../utils/backendConfig', () => ({ getCloudApiUrl: (p) => `https://api.test${p}` }))

// apiFrom('svrz_games'): a thenable builder that records its calls and answers
// from `api.rows` (or with `api.error`), applying eq/gte/gt/order/limit and the
// row cap (`api.maxRows`) like the server does.
const api = vi.hoisted(() => ({ rows: [], error: null, queries: [], maxRows: 1000 }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: (table) => {
    const q = { table, select: null, eq: {}, gte: {}, gt: {}, order: [], limit: null }
    api.queries.push(q)
    const b = {
      select: (cols) => { q.select = cols; return b },
      eq: (col, v) => { q.eq[col] = v; return b },
      gte: (col, v) => { q.gte[col] = v; return b },
      gt: (col, v) => { q.gt[col] = v; return b },
      limit: (n) => { q.limit = n; return b },
      order: (col, opts) => { q.order.push({ col, ascending: opts?.ascending !== false }); return b },
      then: (resolve, reject) => {
        if (api.error) return Promise.resolve({ data: null, error: api.error }).then(resolve, reject)
        const data = api.rows.filter(r =>
          Object.entries(q.eq).every(([c, v]) => r[c] === v) &&
          Object.entries(q.gte).every(([c, v]) => r[c] >= v) &&
          Object.entries(q.gt).every(([c, v]) => r[c] > v))
        for (const { col, ascending } of [...q.order].reverse()) {
          data.sort((a, z) => (a[col] < z[col] ? -1 : a[col] > z[col] ? 1 : 0) * (ascending ? 1 : -1))
        }
        data.splice(Math.min(q.limit ?? api.maxRows, api.maxRows))
        return Promise.resolve({ data, error: null }).then(resolve, reject)
      }
    }
    return b
  }
}))

import LoadOfficialMatchModal, { levelFromSchedule, mapSupabaseToMatchFormat, matchDataFromSchedule } from '../LoadOfficialMatchModal'

// svrz_games.datetime is TEXT like "2026-10-17T11:30:00.000000+00:00"
const isoInDays = (days) => {
  const d = new Date()
  d.setDate(d.getDate() + days)
  d.setHours(12, 0, 0, 0)
  return d.toISOString().replace(/\.\d{3}Z$/, '.000000+00:00')
}
let lastId = 0
const game = (n, gender, league, days) => ({
  id: ++lastId,
  game_number: n, gender, league, datetime: isoInDays(days), team_home: `Home ${n}`, team_away: `Away ${n}`
})

const leagueSelect = () => screen.getByRole('combobox', { name: 'loadOfficialMatch.league' })
const chooseGender = (g) => fireEvent.change(screen.getByRole('combobox', { name: 'loadOfficialMatch.gender' }), { target: { value: g } })

describe('LoadOfficialMatchModal league list', () => {
  beforeEach(() => {
    api.error = null
    api.queries = []
    api.maxRows = 1000
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

  // UI tour 14.11 (o00c): a lone "Men ♂" path line sat under the selectors
  // before a league was chosen, and a game read "vsVC Beispielstadt" (no space
  // in the text, only a margin)
  it('shows the selection path only with a league, and a game reads "home vs away"', async () => {
    render(<LoadOfficialMatchModal open onClose={() => {}} onSelectMatch={() => {}} />)
    await screen.findByRole('combobox', { name: 'loadOfficialMatch.gender' })
    chooseGender('men')
    expect(screen.queryByTestId('schedule-selection-path')).toBeNull()
    fireEvent.change(leagueSelect(), { target: { value: '1L D' } })
    expect(await screen.findByTestId('schedule-selection-path')).toHaveTextContent('1L D (♂)')
    const home = await screen.findByText('Home M3')
    expect(home.closest('.sg-teams').textContent.replace(/\s+/g, ' ').trim()).toBe('Home M3 common.vs Away M3')
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

  it('reads every svrz_games row past the 1000-row cap: no league and no upcoming game is lost', async () => {
    // Like production (1442 rows): the oldest league (4L B, only past games)
    // and the upcoming 3L games sit on both sides of the cap
    api.rows = [
      game('O0', 'men', '4L B', -400),
      ...Array.from({ length: 1438 }, (_, i) => game(`O${i + 1}`, 'men', '1L D', -300 + (i % 200))),
      game('N1', 'men', '3L', 2),
      game('N2', 'men', '3L', 9),
      game('N3', 'women', '2L', 4)
    ]
    expect(api.rows).toHaveLength(1442)
    render(<LoadOfficialMatchModal open onClose={() => {}} onSelectMatch={() => {}} />)
    await screen.findByRole('combobox', { name: 'loadOfficialMatch.gender' })
    chooseGender('men')

    // Two pages keyed on id; the second continues after the first page's last id
    const leagueQueries = api.queries.filter(q => q.select !== '*')
    expect(leagueQueries).toHaveLength(2)
    expect(leagueQueries[0].order).toEqual([{ col: 'id', ascending: true }])
    expect(leagueQueries[0].limit).toBe(1000)
    expect(leagueQueries[1].gt).toEqual({ id: api.rows[999].id })

    const options = within(leagueSelect()).getAllByRole('option')
    expect(options.map(o => o.value)).toEqual(['', '3L', '1L D', '4L B'])
    expect(options.map(o => o.disabled)).toEqual([false, false, true, true])
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

// owner 2026-10-24: the sheet's U23 / U19 / U17 / Other boxes stayed empty for
// youth games; the schedule says "junior" and the age is in the league
describe('the level from a schedule row', () => {
  it('senior and the setup ages as they are; junior from the league name', () => {
    expect(levelFromSchedule('senior', '2L')).toEqual({ type3: 'senior', type3Other: '' })
    expect(levelFromSchedule('junior', 'U23 2. Liga')).toEqual({ type3: 'U23', type3Other: '' })
    expect(levelFromSchedule('junior', 'SM Quali U23 A')).toEqual({ type3: 'U23', type3Other: '' })
    expect(levelFromSchedule('junior', 'U20 Ligamodus')).toEqual({ type3: 'other', type3Other: 'U20' })
    expect(levelFromSchedule('junior', 'Finalissima U16')).toEqual({ type3: 'other', type3Other: 'U16' })
    expect(levelFromSchedule('junior', 'Juniorinnen')).toEqual({ type3: 'other', type3Other: '' })
    expect(levelFromSchedule(null, '2L')).toEqual({ type3: undefined, type3Other: '' })
  })

  it('the age of the league whatever the level says: a U21 or U13 league synced as senior is no senior game', () => {
    expect(levelFromSchedule('senior', 'U21 Damen')).toEqual({ type3: 'U21', type3Other: '' })
    expect(levelFromSchedule('senior', 'U13 Mixed')).toEqual({ type3: 'other', type3Other: 'U13' })
    expect(levelFromSchedule(null, 'U19 Herren')).toEqual({ type3: 'U19', type3Other: '' })
    // no age in the league: the level as it is
    expect(levelFromSchedule('senior', '3L Damen')).toEqual({ type3: 'senior', type3Other: '' })
  })

  it('the match format only when the schedule knows it (3 or 5), else none: never a default', () => {
    expect(mapSupabaseToMatchFormat({ game_number: 1, match_format: 3 }).bestOf).toBe(3)
    expect(mapSupabaseToMatchFormat({ game_number: 1, match_format: 5 }).bestOf).toBe(5)
    expect(mapSupabaseToMatchFormat({ game_number: 1, match_format: null }).bestOf).toBeNull()
    expect(mapSupabaseToMatchFormat({ game_number: 1 }).bestOf).toBeNull()
    expect(mapSupabaseToMatchFormat({ game_number: 1, match_format: 4 }).bestOf).toBeNull()
  })

  it('the referees\' licence numbers (db/051) go to the match data; a row without them (an older backend) has none', () => {
    const row = { game_number: 1, referee_1_first_name: 'Rita', referee_1_last_name: 'Pfeife', referee_1_licence: '512345', referee_2_last_name: 'Linie', referee_2_licence: '623456' }
    const data = matchDataFromSchedule(mapSupabaseToMatchFormat(row))
    expect(data).toMatchObject({ referee1First: 'Rita', referee1Last: 'Pfeife', referee1Licence: '512345', referee2Last: 'Linie', referee2Licence: '623456' })
    expect(data.referee1Dob).toBeUndefined()
    const old = matchDataFromSchedule(mapSupabaseToMatchFormat({ game_number: 2, referee_1_last_name: 'Pfeife' }))
    expect(old.referee1Licence).toBeUndefined()
    expect(old.referee2Licence).toBeUndefined()
  })

  it('a row of game 406970 maps to championship, women, senior, regional', () => {
    const m = mapSupabaseToMatchFormat({ game_number: 406970, league: '2L', gender: 'women', match_type: 'championship', match_level: 'senior', championship_type: 'regional' })
    expect(m).toMatchObject({ type1: 'championship', type2: 'women', type3: 'senior', type3Other: '', championshipType: 'regional' })
  })
})

// owner 2026-11-15: "hide previous matches (matches with start time before
// current time) under 'earlier matches' in load schedule"
describe('LoadOfficialMatchModal earlier matches', () => {
  const row = (n, datetime, away = `Away ${n}`) => ({
    id: ++lastId, game_number: n, gender: 'men', league: '2L', datetime, team_home: `Home ${n}`, team_away: away
  })
  beforeEach(() => {
    // Only Date is faked: 15.11.2026 15:00 in Zürich
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-15T14:00:00Z'))
    api.error = null
    api.queries = []
    api.maxRows = 1000
    api.rows = [
      row('E1', '2026-11-15T08:00:00.000000+00:00', 'VBC Rämi'), // 09:00, this morning
      row('E2', '2026-11-15T13:30:00.000000+00:00'), // 14:30, already on
      row('U1', '2026-11-15T17:00:00.000000+00:00', 'VBC Rämi'), // 18:00, tonight
      row('U2', '2026-11-16T08:00:00.000000+00:00') // tomorrow 09:00
    ]
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  const openLeague = async () => {
    render(<LoadOfficialMatchModal open onClose={() => {}} onSelectMatch={() => {}} />)
    await screen.findByRole('combobox', { name: 'loadOfficialMatch.gender' })
    chooseGender('men')
    fireEvent.change(leagueSelect(), { target: { value: '2L' } })
    await screen.findByText('Home U1')
  }

  it('lists games that already started under a closed "Earlier matches", after the upcoming ones', async () => {
    await openLeague()
    expect(screen.getByText('Home U2')).toBeInTheDocument()
    expect(screen.queryByText('Home E1')).toBeNull()
    expect(screen.queryByText('Home E2')).toBeNull()

    const toggle = screen.getByTestId('schedule-earlier-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveTextContent('loadOfficialMatch.earlierMatches (2)')
    // after the upcoming games
    expect(screen.getByText('Home U2').compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const earlier = screen.getByTestId('schedule-earlier-games')
    expect(within(earlier).getAllByText(/^Home /).map(n => n.textContent)).toEqual(['Home E1', 'Home E2'])
    // the upcoming games keep their order
    const rows = [...screen.getByTestId('schedule-games').querySelectorAll('.sg-row .sg-num')].map(n => n.textContent)
    expect(rows).toEqual(['U1', 'U2', 'E1', 'E2'])

    fireEvent.click(toggle)
    expect(screen.queryByText('Home E1')).toBeNull()
  })

  it('a search keeps the groups', async () => {
    await openLeague()
    fireEvent.change(screen.getByRole('textbox', { name: 'loadOfficialMatch.searchPlaceholder' }), { target: { value: 'rämi' } })
    expect(screen.getByText('Home U1')).toBeInTheDocument()
    expect(screen.queryByText('Home U2')).toBeNull()
    const toggle = screen.getByTestId('schedule-earlier-toggle')
    expect(toggle).toHaveTextContent('(1)')
    expect(screen.queryByText('Home E1')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText('Home E1')).toBeInTheDocument()
    expect(screen.queryByText('Home E2')).toBeNull()
  })

  it('every game earlier: the empty state, with the section below it', async () => {
    api.rows = api.rows.filter(r => r.game_number.startsWith('E'))
    render(<LoadOfficialMatchModal open onClose={() => {}} onSelectMatch={() => {}} />)
    await screen.findByRole('combobox', { name: 'loadOfficialMatch.gender' })
    chooseGender('men')
    fireEvent.change(leagueSelect(), { target: { value: '2L' } })
    const empty = await screen.findByTestId('schedule-empty-upcoming')
    expect(empty).toHaveTextContent('loadOfficialMatch.noUpcomingMatches')
    const toggle = screen.getByTestId('schedule-earlier-toggle')
    expect(empty.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText('Home E1')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText('Home E1')).toBeInTheDocument()
  })
})
