import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import en from '../../i18n/locales/en.json'

const lookup = (key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), en)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => String(lookup(key) ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => opts?.[k] ?? '') })
}))
vi.mock('../../utils/backendConfig', () => ({ getCloudApiUrl: (p) => `https://backend.test${p}` }))

import GlobalLiveList from '../GlobalLiveList'

afterEach(cleanup)

const court = (over = {}) => ({
  id: 'c1', home: { name: 'Bergtal IS', color: '#1d4ed8' }, away: { name: 'Seeblick IS', color: '#dc2626' },
  setsWon: { home: 1, away: 0 }, points: { home: 12, away: 9 }, sets: [], currentSet: 2, serving: 'home',
  status: 'live', ended: false, timeout: false, interval: false, hall: 'Hall 1', updatedAt: '2027-11-05T09:30:00Z', ...over
})
const answer = (data) => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data, error: null }) }))

describe('GlobalLiveList (cloud livescore)', () => {
  it('lists the opted-in live screens with their courts, each linking to its page', async () => {
    const fetchImpl = answer({ updatedAt: 'x', events: [{ code: 'ABCD2345', updatedAt: 'x', courts: [court(), court({ id: 'c2', hall: 'Hall 2' })] }] })
    render(<GlobalLiveList fetchImpl={fetchImpl} pollMs={60000} />)
    await waitFor(() => expect(screen.getAllByTestId('global-live-court-row')).toHaveLength(2))
    expect(fetchImpl.mock.calls[0][0]).toBe('https://backend.test/api/global/live')
    expect(screen.getByText('Global matches')).toBeTruthy()
    expect(screen.getByRole('link').getAttribute('href')).toBe('?t=ABCD2345')
    expect(screen.getAllByText('Bergtal IS')).toHaveLength(2)
  })
  it('shows nothing while no event is listed, or when the backend fails', async () => {
    const fetchImpl = answer({ updatedAt: null, events: [] })
    const { container } = render(<GlobalLiveList fetchImpl={fetchImpl} pollMs={60000} />)
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
    cleanup()
    const broken = vi.fn(async () => { throw new Error('offline') })
    const r = render(<GlobalLiveList fetchImpl={broken} pollMs={60000} />)
    await waitFor(() => expect(broken).toHaveBeenCalled())
    expect(r.container.innerHTML).toBe('')
  })
})
