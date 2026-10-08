import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => String(typeof fallback === 'string' ? fallback : key) })
}))
// One user object, like the real context: a new one per render would refetch
const authUser = vi.hoisted(() => ({ id: 'u1' }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: authUser }) }))

// Records every apiFrom query; matches rows as the backend returns them
// (`api.links`, when set, is the user_matches table, paged by id like the server)
const api = vi.hoisted(() => ({ calls: [], links: null }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: (table) => {
    const call = { table, columns: null, filters: [], order: [], limit: null }
    const b = {
      select(cols) { call.columns = cols; return b },
      eq(c, v) { call.filters.push(['eq', c, v]); return b },
      in(c, v) { call.filters.push(['in', c, v]); return b },
      gt(c, v) { call.filters.push(['gt', c, v]); return b },
      order(c, o) { call.order.push([c, o?.ascending !== false]); return b },
      limit(n) { call.limit = n; return b },
      then(resolve) {
        api.calls.push(call)
        if (table === 'user_matches' && api.links) {
          const after = call.filters.find(f => f[0] === 'gt')?.[2] ?? 0
          const data = api.links.filter(r => r.id > after).slice(0, Math.min(call.limit ?? 1000, 1000))
          return Promise.resolve({ data, error: null }).then(resolve)
        }
        if (table === 'matches' && api.links) {
          const ids = call.filters.find(f => f[0] === 'in')[2]
          const data = ids.map(id => ({ external_id: id, game_n: Number(id.slice(2)), home_team: { name: `Home ${id}` }, away_team: { name: 'Away' }, status: 'final', scheduled_at: '2026-10-05T18:00:00Z' }))
          return Promise.resolve({ data: data.slice(0, 1000), error: null }).then(resolve)
        }
        if (table === 'user_matches') {
          return Promise.resolve({ data: [{ id: 'l1', match_external_id: 'match_1_a', role: 'scorer', created_at: '2026-10-05T18:30:00Z' }], error: null }).then(resolve)
        }
        return Promise.resolve({
          data: [{ external_id: 'match_1_a', game_n: 991404, home_team: { name: 'Home V' }, away_team: { name: 'Away V' }, final_score: '2:0', status: 'final', scheduled_at: '2026-10-05T18:00:00Z', created_at: '2026-10-05T17:00:00Z' }],
          error: null
        }).then(resolve)
      }
    }
    return b
  }
}))

import MatchHistory, { matchStatusPill } from '../auth/MatchHistory'

afterEach(() => {
  api.calls = []
  api.links = null
  vi.restoreAllMocks()
})

describe('MatchHistory (My Matches)', () => {
  it('reads columns matches has and shows the teams; a final match opens its scoresheet', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<MatchHistory open onClose={() => {}} />)

    expect(await screen.findByText('Home V')).toBeInTheDocument()
    expect(screen.getByText('Away V')).toBeInTheDocument()
    const matchesQuery = api.calls.find(c => c.table === 'matches')
    for (const col of ['team_a', 'team_b', 'start_time']) expect(matchesQuery.columns).not.toContain(col)
    expect(matchesQuery.filters).toContainEqual(['in', 'external_id', ['match_1_a']])

    fireEvent.click(screen.getByText('Home V'))
    expect(open).toHaveBeenCalledWith(`${window.location.origin}/scoresheet/?date=2026-10-05&game=991404`, '_blank', 'noopener')
  })

  it('a final match is a keyboard-reachable row with a done (not amber) Final pill', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<MatchHistory open onClose={() => {}} />)
    const row = await screen.findByRole('button', { name: /Home V – Away V 2:0: Open scoresheet/ })
    expect(row).toHaveAttribute('tabindex', '0')
    const pill = screen.getByText('Final')
    expect(pill.className).toContain('emerald')
    expect(pill.className).not.toContain('amber')
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(open).toHaveBeenCalledWith(`${window.location.origin}/scoresheet/?date=2026-10-05&game=991404`, '_blank', 'noopener')
  })
})

describe('MatchHistory past the 1000-row cap', () => {
  it('lists every linked match, newest first, reading the links in pages and the matches in chunks', async () => {
    // 1500 links; created_at rises with id, so the newest is the last one read
    api.links = Array.from({ length: 1500 }, (_, i) => ({
      id: i + 1, match_external_id: `m_${i + 1}`, role: 'scorer',
      created_at: new Date(Date.UTC(2024, 0, 1) + i * 3600e3).toISOString()
    }))
    render(<MatchHistory open onClose={() => {}} />)
    expect(await screen.findByText('Home m_1500')).toBeInTheDocument()
    expect(screen.getByText('Home m_1')).toBeInTheDocument()

    const links = api.calls.filter(c => c.table === 'user_matches')
    expect(links).toHaveLength(2)
    expect(links[0].order).toEqual([['id', true]])
    expect(links[1].filters).toContainEqual(['gt', 'id', 1000])
    const lookups = api.calls.filter(c => c.table === 'matches')
    expect(lookups.map(c => c.filters.find(f => f[0] === 'in')[2].length)).toEqual([1000, 500])

    const rows = screen.getAllByText(/^Home m_/).map(el => el.textContent)
    expect(rows).toHaveLength(1500)
    expect(rows[0]).toBe('Home m_1500')
    expect(rows[1499]).toBe('Home m_1')
  })
})

describe('matchStatusPill', () => {
  it('maps every database status to a word and never to amber', () => {
    for (const s of ['live', 'final', 'ended', 'approved', 'setup', 'finished', 'something']) {
      expect(matchStatusPill(s).className).not.toContain('amber')
    }
    expect(matchStatusPill('final').fallback).toBe('Final')
    expect(matchStatusPill('ended').fallback).toBe('Final')
    expect(matchStatusPill('live').fallback).toBe('Live')
  })
})
