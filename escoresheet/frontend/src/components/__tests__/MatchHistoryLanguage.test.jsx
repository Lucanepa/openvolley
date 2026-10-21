// My matches in German: the role chip read "Scorer" / "Referee" (the raw role
// with CSS capitalize) and the date was in the browser's language.
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import de from '../../i18n/locales/de.json'

const lookup = (key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), de)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => { const v = lookup(key); return typeof v === 'string' ? v : String(typeof fallback === 'string' ? fallback : key) },
    i18n: { language: 'de' }
  })
}))
const authUser = vi.hoisted(() => ({ id: 'u1' }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: authUser }) }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: (table) => {
    const b = {
      select: () => b, eq: () => b, in: () => b, gt: () => b, order: () => b, limit: () => b,
      then (resolve) {
        const data = table === 'user_matches'
          ? [{ id: 'l1', match_external_id: 'match_1_a', role: 'referee', created_at: '2026-10-05T18:30:00Z' }]
          : [{ external_id: 'match_1_a', game_n: 991404, home_team: { name: 'Home V' }, away_team: { name: 'Away V' }, final_score: '2:0', status: 'final', scheduled_at: '2026-10-05T18:00:00Z' }]
        return Promise.resolve({ data, error: null }).then(resolve)
      }
    }
    return b
  }
}))

import MatchHistory from '../auth/MatchHistory'

describe('MatchHistory in the app\'s language', () => {
  it('the role chip is translated and the date follows the app language', async () => {
    render(<MatchHistory open onClose={() => {}} />)
    const chip = await screen.findByTestId('match-history-role')
    expect(chip.textContent).toBe('Schiedsrichter')
    expect(chip.className).not.toMatch(/\bcapitalize\b/)
    const date = new Date('2026-10-05T18:00:00Z').toLocaleDateString('de', { day: '2-digit', month: 'short', year: 'numeric' })
    expect(screen.getByText(date)).toBeTruthy()
  })
})
