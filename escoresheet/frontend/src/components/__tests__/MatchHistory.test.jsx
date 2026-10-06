import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => String(typeof fallback === 'string' ? fallback : key) })
}))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))

// Records every apiFrom query; matches rows as the backend returns them
const api = vi.hoisted(() => ({ calls: [] }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: (table) => {
    const call = { table, columns: null, filters: [] }
    const b = {
      select(cols) { call.columns = cols; return b },
      eq(c, v) { call.filters.push(['eq', c, v]); return b },
      in(c, v) { call.filters.push(['in', c, v]); return b },
      order() { return b },
      then(resolve) {
        api.calls.push(call)
        if (table === 'user_matches') {
          return Promise.resolve({ data: [{ match_external_id: 'match_1_a', role: 'scorer', created_at: '2026-10-05T18:30:00Z' }], error: null }).then(resolve)
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
    expect(open).toHaveBeenCalledWith('/scoresheet/?date=2026-10-05&game=991404', '_blank', 'noopener')
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
    expect(open).toHaveBeenCalledWith('/scoresheet/?date=2026-10-05&game=991404', '_blank', 'noopener')
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
