import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// The referee, bench and livescore pages share DashboardHeader: its menu ends
// with the legal links (privacy policy, terms, legal notice).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'de', resolvedLanguage: 'de' }
  })
}))
vi.mock('../../i18n', () => ({ default: { language: 'de', changeLanguage: () => {} } }))
vi.mock('../../hooks/useServiceWorker', () => ({ clearCachesAndReload: async () => true }))

import DashboardHeader from '../DashboardHeader'

describe('DashboardHeader menu (referee, bench, livescore)', () => {
  it('ends with the legal links in the app language', () => {
    render(<DashboardHeader title="Referee" />)
    expect(screen.queryByTestId('legal-links')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'header.menu' }))
    const hrefs = [...screen.getByTestId('legal-links').querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual([
      'https://openvolley.app/datenschutz',
      'https://openvolley.app/nutzungsbedingungen',
      'https://openvolley.app/impressum'
    ])
  })
})
