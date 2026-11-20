import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import en from '../../i18n/locales/en.json'

const lookup = (key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), en)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => String(lookup(key) ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => opts?.[k] ?? ''), i18n: { language: 'en' } })
}))
vi.mock('../../utils/backendConfig', () => ({ getCloudApiUrl: (p) => `https://backend.test${p}` }))

import { SharedMatchPage, OrganizerPage } from '../GlobalCloudPages'

afterEach(cleanup)
const summary = (over = {}) => ({ home: { name: 'Bergtal IS', color: '#1d4ed8' }, away: { name: 'Seeblick IS' }, setsWon: { home: 3, away: 1 }, sets: [{ home: 25, away: 20 }], status: 'final', hall: 'Hall 1', ...over })
const answer = (data, status = 200) => vi.fn(async () => ({ ok: status < 400, status, json: async () => (status < 400 ? { data, error: null } : { data: null, error: { code: 'OV_NOT_FOUND' } }) }))

describe('Global cloud pages', () => {
  it('a shared match: result, sets and the PDF link', async () => {
    const fetchImpl = answer({ summary: summary(), updatedAt: 'x', hasPdf: true })
    render(<SharedMatchPage token={'S'.repeat(22)} fetchImpl={fetchImpl} pollMs={60000} />)
    await waitFor(() => expect(screen.getByText('Bergtal IS')).toBeTruthy())
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://backend.test/api/global/shared/${'S'.repeat(22)}`)
    expect(screen.getByText('Final')).toBeTruthy()
    expect(screen.getByTestId('global-cloud-pdf').getAttribute('href')).toBe(`https://backend.test/api/global/shared/${'S'.repeat(22)}/pdf`)
  })
  it('a link that was turned off says so', async () => {
    render(<SharedMatchPage token={'S'.repeat(22)} fetchImpl={answer(null, 404)} pollMs={60000} />)
    await waitFor(() => expect(screen.getByText(en.globalCloud.page.notShared)).toBeTruthy())
  })
  it('the organizer list: every match of the code, each with its PDF', async () => {
    const fetchImpl = answer({ matches: [{ id: 'u1', summary: summary(), hasPdf: true }, { id: 'u2', summary: summary({ status: 'live' }), hasPdf: false }] })
    render(<OrganizerPage code="ABCDE23456" fetchImpl={fetchImpl} pollMs={60000} />)
    await waitFor(() => expect(screen.getAllByTestId('global-organizer-match')).toHaveLength(2))
    expect(fetchImpl.mock.calls[0][0]).toBe('https://backend.test/api/global/organizer/ABCDE23456')
    expect(screen.getAllByTestId('global-cloud-pdf')).toHaveLength(1)
    expect(screen.getByText('ABCDE 23456')).toBeTruthy()
  })
})
