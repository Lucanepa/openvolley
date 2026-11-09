import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// db/025: who approves a sign-up request. The admin's Accounts tab ("Approve
// as requested", "Review request"), the Requests section of My club and of
// My teams, and the audit line of a decision.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => (typeof opts === 'string' ? opts : opts?.part ? `${key}|${opts.part}` : opts?.name ? `${key}|${opts.name}` : key),
    i18n: { language: 'en' }
  })
}))

const api = vi.hoisted(() => ({
  admin: { listAccounts: vi.fn(), setRoles: vi.fn(), decideRequests: vi.fn() },
  clubs: { list: vi.fn() },
  club: { requests: vi.fn(), decideRequests: vi.fn() },
  team: { requests: vi.fn(), decideRequests: vi.fn() },
  fetchPublicClubs: vi.fn()
}))
vi.mock('../../lib/accountApi', async (orig) => ({
  ...(await orig()),
  admin: api.admin,
  clubsApi: api.clubs,
  clubApi: api.club,
  teamApi: api.team,
  fetchPublicClubs: api.fetchPublicClubs
}))
const ui = vi.hoisted(() => ({ confirm: vi.fn(async () => true), toasts: [] }))
vi.mock('../../ui', async (orig) => {
  const real = await orig()
  return {
    ...real,
    confirmDialog: (...a) => ui.confirm(...a),
    toast: { ...real.toast, success: (m) => ui.toasts.push(['ok', m]), error: (m) => ui.toasts.push(['error', m]), info: (m) => ui.toasts.push(['info', m]) }
  }
})

import AccountsPanel, { deletion } from '../manage/AccountsPanel'
import RequestsSection from '../manage/RequestsSection'
import { auditDetailsLine } from '../manage/AuditPanel'

const ok = (data) => ({ data, error: null, status: 200 })
const CLUBS = [
  { id: 'c-must', name: 'VBC Musterdorf', teams: [{ id: 't-h1', name: 'VBC Musterdorf H1' }, { id: 't-d2', name: 'VBC Musterdorf D2' }] },
  { id: 'c-msh', name: 'VBC Mustershausen', teams: [{ id: 't-msh1', name: 'VBC Mustershausen H1' }] }
]
const PARTS = [
  { id: 'r-sc', kind: 'scorer', club_id: 'c-must', club_name: 'VBC Musterdorf', team_id: null, team_name: null },
  { id: 'r-ref', kind: 'referee', club_id: null, club_name: null, team_id: null, team_name: null },
  { id: 'r-tm', kind: 'team_manager', club_id: 'c-must', club_name: 'VBC Musterdorf', team_id: 't-h1', team_name: 'VBC Musterdorf H1' }
]
const ANNA = { id: 'u-anna', email: 'anna@example.ch', first_name: 'Anna', last_name: 'Beispiel', roles: [], pending: true, clubs: [], requests: PARTS, managed_clubs: [], managed_teams: [] }
const NEWBIE = { id: 'u-new', email: 'new@example.ch', first_name: 'Pat', last_name: 'Pending', roles: [], pending: true, clubs: [], requests: [], managed_clubs: [], managed_teams: [] }

beforeEach(() => {
  vi.clearAllMocks()
  ui.toasts = []
  ui.confirm.mockResolvedValue(true)
  api.admin.listAccounts.mockResolvedValue(ok({ accounts: [ANNA, NEWBIE], can_delete: true }))
  api.admin.decideRequests.mockResolvedValue(ok({ approved: 3, rejected: 0, requests: [] }))
  api.fetchPublicClubs.mockResolvedValue(ok({ clubs: CLUBS }))
  api.clubs.list.mockResolvedValue(ok({ clubs: [] }))
})

describe('Accounts: a sign-up request', () => {
  it('shows each part and approves every part as requested in one click', async () => {
    render(<AccountsPanel selfId="u-self" app="indoor" />)
    const row = await screen.findByTestId('account-u-anna')
    expect(row).toHaveTextContent('manage.requests.asks|access.requests.kinds.scorer · VBC Musterdorf')
    expect(row).toHaveTextContent('manage.requests.asks|access.requests.kinds.team_manager · VBC Musterdorf H1')
    expect(row).toHaveTextContent('manage.requests.asks|access.requests.kinds.referee')
    // "Approve as scorer" is for a pending account that asked for nothing
    expect(within(row).queryByText('manage.accounts.approve')).toBeNull()
    expect(within(screen.getByTestId('account-u-new')).getByText('manage.accounts.approve')).toBeInTheDocument()
    fireEvent.click(within(row).getByTestId('approve-as-requested'))
    await waitFor(() => expect(api.admin.decideRequests).toHaveBeenCalledWith('u-anna', { approve: [{ id: 'r-sc' }, { id: 'r-ref' }, { id: 'r-tm' }] }))
    expect(ui.toasts).toContainEqual(['ok', 'manage.requests.approved'])
  })

  it('review: change a club or a team, leave a part for later, reject one', async () => {
    render(<AccountsPanel selfId="u-self" app="indoor" />)
    const row = await screen.findByTestId('account-u-anna')
    fireEvent.click(within(row).getByTestId('review-request'))
    const scorer = await screen.findByTestId('review-part-r-sc')
    await waitFor(() => expect(within(scorer).getByTestId('review-club-r-sc')).toBeInTheDocument())
    fireEvent.change(within(scorer).getByTestId('review-club-r-sc'), { target: { value: 'c-msh' } })
    // the referee: rejected; the team manager part: another team, then another club's team
    fireEvent.click(within(screen.getByTestId('review-part-r-ref')).getByRole('radio', { name: 'manage.requests.decision.reject' }))
    const tm = screen.getByTestId('review-part-r-tm')
    fireEvent.change(within(tm).getByTestId('review-club-r-tm'), { target: { value: 'c-msh' } })
    // a club changed: its team must be picked again before saving
    expect(screen.getByTestId('save-request-review')).toBeDisabled()
    fireEvent.change(within(tm).getByTestId('review-team-r-tm'), { target: { value: 't-msh1' } })
    fireEvent.click(screen.getByTestId('save-request-review'))
    await waitFor(() => expect(api.admin.decideRequests).toHaveBeenCalledWith('u-anna', {
      approve: [{ id: 'r-sc', club_id: 'c-msh' }, { id: 'r-tm', team_id: 't-msh1' }],
      reject: ['r-ref']
    }))
  })

  it('review: "Later" leaves a part for the club\'s managers', async () => {
    render(<AccountsPanel selfId="u-self" app="indoor" />)
    fireEvent.click(within(await screen.findByTestId('account-u-anna')).getByTestId('review-request'))
    for (const id of ['r-sc', 'r-tm']) {
      fireEvent.click(within(await screen.findByTestId(`review-part-${id}`)).getByRole('radio', { name: 'manage.requests.decision.later' }))
    }
    fireEvent.click(screen.getByTestId('save-request-review'))
    await waitFor(() => expect(api.admin.decideRequests).toHaveBeenCalledWith('u-anna', { approve: [{ id: 'r-ref' }], reject: [] }))
  })

  it('a request decided meanwhile: says so and reloads', async () => {
    api.admin.decideRequests.mockResolvedValue({ data: null, error: { code: 'OV_REQUEST_GONE', message: 'gone' }, status: 409 })
    render(<AccountsPanel selfId="u-self" app="indoor" />)
    fireEvent.click(within(await screen.findByTestId('account-u-anna')).getByTestId('approve-as-requested'))
    await waitFor(() => expect(ui.toasts).toContainEqual(['info', 'manage.requests.gone']))
    // the list and the Pending count load again
    expect(api.admin.listAccounts.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('an account a team or club manager approved is deleted, not rejected; it shows what it manages', async () => {
    const coach = { ...NEWBIE, id: 'u-coach', pending: false, managed_teams: [{ id: 't-h1', name: 'VBC Musterdorf H1', club_id: 'c-must' }] }
    expect(deletion(coach, 'u-self')).toBe('delete')
    expect(deletion({ ...NEWBIE, managed_clubs: [{ id: 'c-must', name: 'VBC Musterdorf' }] }, 'u-self')).toBe('delete')
    expect(deletion(NEWBIE, 'u-self')).toBe('reject')
    api.admin.listAccounts.mockResolvedValue(ok({ accounts: [coach], can_delete: true }))
    render(<AccountsPanel selfId="u-self" app="indoor" />)
    const row = await screen.findByTestId('account-u-coach')
    expect(row).toHaveTextContent('manage.requests.managesTeam|VBC Musterdorf H1')
    expect(within(row).queryByTestId('reject-account')).toBeNull()
    expect(within(row).getByTestId('delete-account')).toBeInTheDocument()
  })
})

describe('Requests in My club and My teams', () => {
  const entry = { user: { id: 'u-anna', email: 'anna@example.ch', name: 'Anna Beispiel', created_at: '2026-11-09T08:00:00Z', email_confirmed: true }, parts: [PARTS[2], PARTS[0]] }

  it('the club\'s parts, one row each: approve and reject', async () => {
    api.club.requests.mockResolvedValue(ok({ requests: [entry] }))
    api.club.decideRequests.mockResolvedValue(ok({ approved: 1, rejected: 0, requests: [] }))
    render(<RequestsSection club={{ id: 'c-must', name: 'VBC Musterdorf' }} />)
    const scorer = await screen.findByTestId('request-r-sc')
    // scorer first, then the team part
    expect(screen.getAllByTestId(/^request-/).map((r) => r.dataset.testid)).toEqual(['request-r-sc', 'request-r-tm'])
    expect(scorer).toHaveTextContent('Anna Beispiel')
    expect(scorer).toHaveTextContent('anna@example.ch')
    fireEvent.click(within(scorer).getByText('manage.requests.approve'))
    await waitFor(() => expect(api.club.decideRequests).toHaveBeenCalledWith('c-must', 'u-anna', { approve: [{ id: 'r-sc' }] }))
    fireEvent.click(within(screen.getByTestId('request-r-tm')).getByText('manage.requests.reject'))
    await waitFor(() => expect(api.club.decideRequests).toHaveBeenCalledWith('c-must', 'u-anna', { reject: ['r-tm'] }))
    expect(ui.confirm).toHaveBeenCalledTimes(1)
    expect(api.club.requests.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('the team\'s team manager parts; an unconfirmed address is said so', async () => {
    api.team.requests.mockResolvedValue(ok({ requests: [{ ...entry, parts: [PARTS[2]] }] }))
    api.team.decideRequests.mockResolvedValue({ data: null, error: { code: 'OV_EMAIL_UNCONFIRMED', message: 'x' }, status: 409 })
    render(<RequestsSection team={{ id: 't-h1', name: 'VBC Musterdorf H1' }} />)
    const row = await screen.findByTestId('request-r-tm')
    fireEvent.click(within(row).getByText('manage.requests.approve'))
    await waitFor(() => expect(api.team.decideRequests).toHaveBeenCalledWith('t-h1', 'u-anna', { approve: [{ id: 'r-tm' }] }))
    expect(await within(row).findByText('manage.accounts.confirmEmailFirst')).toBeInTheDocument()
  })

  it('nothing open: says so; a server without requests: no section', async () => {
    api.club.requests.mockResolvedValue(ok({ requests: [] }))
    const { unmount } = render(<RequestsSection club={{ id: 'c-must', name: 'VBC Musterdorf' }} />)
    expect(await screen.findByText('manage.requests.empty')).toBeInTheDocument()
    unmount()
    api.club.requests.mockResolvedValue({ data: null, error: { code: 'OV_NOT_FOUND', message: 'Not found' }, status: 404 })
    render(<RequestsSection club={{ id: 'c-must', name: 'VBC Musterdorf' }} />)
    await waitFor(() => expect(screen.queryByTestId('club-requests')).toBeNull())
  })
})

describe('the audit line of a decision', () => {
  it('names the kind, the club, a change and who decided; never the person', () => {
    const t = (k, o) => (o?.defaultValue && !k.startsWith('access.') && !k.startsWith('manage.requests') ? o.defaultValue : k)
    expect(auditDetailsLine({ action: 'account.request_approve', club_name: 'VBC Musterdorf', details: { kind: 'team_manager', club_id: 'c-must', team_id: 't-h1', changed: true, via: 'club' } }, { t }))
      .toBe('access.requests.kinds.team_manager · VBC Musterdorf · manage.requests.changed · manage.requests.via.club')
    expect(auditDetailsLine({ action: 'account.request_reject', details: { kind: 'referee', via: 'admin' } }, { t }))
      .toBe('access.requests.kinds.referee · manage.requests.via.admin')
  })
})
