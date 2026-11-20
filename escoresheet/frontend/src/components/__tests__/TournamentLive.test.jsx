import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import en from '../../i18n/locales/en.json'

const lookup = (key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), en)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => String(lookup(key) ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => opts?.[k] ?? '') })
}))
vi.mock('../../utils/backendConfig', () => ({ getCloudApiUrl: (p) => `https://backend.test${p}` }))

import TournamentLive from '../TournamentLive'

afterEach(cleanup)

const court = (over = {}) => ({
  id: 'c1', home: { name: 'Bergtal IS', color: '#1d4ed8' }, away: { name: 'Seeblick IS', color: '#dc2626' },
  setsWon: { home: 1, away: 0 }, points: { home: 12, away: 9 }, sets: [{ home: 25, away: 20 }],
  currentSet: 2, bestOf: 5, serving: 'home', status: 'live', ended: false, timeout: false, interval: false,
  hall: 'Hall 1', gameNumber: '3', updatedAt: '2027-11-05T09:30:00Z', ...over
})
const answer = (data) => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data, error: null }) }))

describe('TournamentLive', () => {
  it('asks the backend for its code and shows every court', async () => {
    const fetchImpl = answer({ code: 'ABCD2345', courts: [court(), court({ id: 'c2', hall: 'Hall 2', ended: true, status: 'final' })] })
    render(<TournamentLive code="ABCD2345" fetchImpl={fetchImpl} pollMs={60000} />)
    await waitFor(() => expect(screen.getAllByTestId('tournament-live-court')).toHaveLength(2))
    expect(fetchImpl.mock.calls[0][0]).toBe('https://backend.test/api/global/live/ABCD2345')
    expect(screen.getAllByText('Bergtal IS')).toHaveLength(2)
    expect(screen.getByText('12')).toBeTruthy()
    expect(screen.getByText(en.globalLive.page.final)).toBeTruthy()
    expect(screen.getByText('Set 2')).toBeTruthy()
    expect(screen.getByText('ABCD 2345')).toBeTruthy()
  })

  it('waits quietly while nothing is live', async () => {
    render(<TournamentLive code="ABCD2345" fetchImpl={answer({ code: 'ABCD2345', courts: [] })} pollMs={60000} />)
    expect(await screen.findByText(en.globalLive.page.empty)).toBeTruthy()
  })

  it('says when the backend cannot be reached', async () => {
    render(<TournamentLive code="ABCD2345" fetchImpl={vi.fn(async () => { throw new Error('offline') })} pollMs={60000} />)
    expect(await screen.findByText(en.globalLive.page.offline)).toBeTruthy()
  })
})
