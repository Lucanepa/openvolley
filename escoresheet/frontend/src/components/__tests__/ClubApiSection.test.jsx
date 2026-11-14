import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// db/032: the My club → API section (token list, create, shown once, revoke)
const tr = vi.hoisted(() => vi.fn((key, opts) => (typeof opts === 'string' ? opts : key)))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: tr, i18n: { language: 'en' } }) }))
const api = vi.hoisted(() => ({
  club: { apiTokens: vi.fn(), createApiToken: vi.fn(), revokeApiToken: vi.fn(), teams: vi.fn() }
}))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), clubApi: api.club }))
const ui = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }))
vi.mock('../../ui', async (orig) => ({ ...(await orig()), confirmDialog: (...a) => ui.confirm(...a) }))

import ClubApiSection, { curlSnippet } from '../manage/ClubApiSection'

const CLUB = { id: 'c1', name: 'VBC Musterdorf' }
const ok = (data, status = 200) => ({ data, error: null, status })
const TOKEN = { id: 't1', label: 'Website', prefix: 'ovk_AbCd', scopes: ['read'], team_id: null, created_at: '2026-11-14T10:00:00Z', last_used_at: null, expires_at: null, revoked_at: null }

beforeEach(() => {
  vi.clearAllMocks()
  api.club.apiTokens.mockResolvedValue(ok({ tokens: [TOKEN] }))
  api.club.teams.mockResolvedValue(ok({ teams: [{ id: 'team-h1', name: 'VBC Musterdorf H1', managers: [], open_links: 0 }] }))
})

describe('ClubApiSection', () => {
  it('lists the tokens without any secret', async () => {
    render(<ClubApiSection club={CLUB} />)
    expect(await screen.findByText('Website')).toBeTruthy()
    expect(screen.getByText('ovk_AbCd…')).toBeTruthy()
    expect(screen.getByText('read')).toBeTruthy()
  })

  it('makes a read token and shows it once with a curl line', async () => {
    api.club.createApiToken.mockResolvedValue(ok({ ...TOKEN, id: 't2', token: 'ovk_' + 'x'.repeat(43) }, 201))
    render(<ClubApiSection club={CLUB} />)
    await screen.findByText('Website')
    fireEvent.click(screen.getByText('manage.myClub.api.new'))
    fireEvent.change(await screen.findByRole('textbox', { name: /manage.myClub.api.label/ }), { target: { value: 'Site' } })
    fireEvent.click(screen.getByTestId('create-api-token'))
    await waitFor(() => expect(api.club.createApiToken).toHaveBeenCalled())
    expect(api.club.createApiToken.mock.calls[0][1]).toMatchObject({ label: 'Site', scopes: ['read'], expires_in_days: 365 })
    expect(api.club.createApiToken.mock.calls[0][1].password).toBeUndefined()
    expect((await screen.findByTestId('api-token')).textContent).toBe('ovk_' + 'x'.repeat(43))
    expect(document.body.textContent).toContain(curlSnippet('ovk_' + 'x'.repeat(43)))
  })

  it('a write scope asks for the password before it can be created', async () => {
    render(<ClubApiSection club={CLUB} />)
    await screen.findByText('Website')
    fireEvent.click(screen.getByText('manage.myClub.api.new'))
    fireEvent.change(await screen.findByRole('textbox', { name: /manage.myClub.api.label/ }), { target: { value: 'Sync' } })
    fireEvent.click(screen.getByLabelText(/rosters:write/))
    expect(screen.getByTestId('create-api-token').disabled).toBe(true)
    fireEvent.change(document.querySelector('input[type="password"]'), { target: { value: 'secret-pass' } })
    expect(screen.getByTestId('create-api-token').disabled).toBe(false)
  })

  it('revokes after a confirmation', async () => {
    api.club.revokeApiToken.mockResolvedValue(ok({ revoked: true }))
    render(<ClubApiSection club={CLUB} />)
    await screen.findByText('Website')
    fireEvent.click(screen.getByText('manage.myClub.api.revoke'))
    await waitFor(() => expect(api.club.revokeApiToken).toHaveBeenCalledWith('c1', 't1'))
    expect(ui.confirm).toHaveBeenCalled()
  })
})
