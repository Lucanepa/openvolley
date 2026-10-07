/**
 * Manager console: account approvals on match rows, the approval lookup and
 * the audit wording (account-approval spec 4.7).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import en from '../../i18n/locales/en.json'

const lookup = (key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), en)
const interpolate = (text, vars) => String(text).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars && vars[k] !== undefined ? vars[k] : ''))
const tMock = (key, opts) => {
  const found = lookup(key)
  if (typeof found === 'string') return interpolate(found, typeof opts === 'object' ? opts : undefined)
  if (typeof opts === 'string') return opts
  return opts?.defaultValue ?? key
}
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock, i18n: { language: 'en' } })
}))

const api = vi.hoisted(() => ({ admin: {} }))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), admin: api.admin }))

import ClosedMatchesPanel from '../manage/ClosedMatchesPanel'
import OfficialGamesPanel from '../manage/OfficialGamesPanel'
import { auditDetailsLine } from '../manage/AuditPanel'

const ok = (data) => ({ data, error: null, status: 200 })
const chip = (over = {}) => ({ slot: 'referee1', name: 'Muster Anna', approved_at: '2026-10-07T19:42:10.000Z', short_id: '6F1C2A9B', result_matches: true, ...over })

beforeEach(() => {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true })
  api.admin.listMatches = vi.fn(async () => ok({ matches: [{
    id: 'm-1', game_n: 4711, home_name: 'Home V', away_name: 'Away V', status: 'approved', closed_at: null,
    approvals: [chip(), chip({ slot: 'scorer', name: 'Scorer Sam', short_id: 'A1B2C3D4', result_matches: false })]
  }] }))
  api.admin.listOfficialGames = vi.fn(async () => ok({ games: [{
    game_number: 4711, team_home: 'Home V', team_away: 'Away V', date: '2026-10-07',
    claim: { match_id: 'm-1', status: 'ended', scorer_name: 'Sam', editors: 0, approvals: [chip({ slot: 'referee2', name: 'Beispiel Ben' })] }
  }] }))
  api.admin.listApprovals = vi.fn(async () => ok({ approvals: [{
    id: '6f1c2a9b-0000-4000-8000-000000000001', short_id: '6F1C2A9B', slot: 'referee1', name: 'Muster Anna',
    approved_at: '2026-10-07T19:42:10.000Z', result_key: 'ov-result-v1|1:25:20', result_matches: true, mine: false,
    user_id: 'u-anna', email: 'anna@example.ch', requested_by_name: 'Sam Scorer', ip_hash8: '95eef55b', device_hash8: '0a1b2c3d',
    revoked_at: '2026-10-07T20:00:00.000Z', revoked_reason: 'match_reopened', revoked_by_name: 'Ada Admin',
    match: { id: 'm-1', external_id: 'match_1', game_n: 4711, home_name: 'Home V', away_name: 'Away V', status: 'ended', closed_at: null }
  }] }))
})
afterEach(() => cleanup())

describe('approval chips', () => {
  it('closed matches: one chip per approval, a stale one amber with "Result changed"', async () => {
    render(<ClosedMatchesPanel />)
    const chips = await screen.findAllByTestId('approval-chip')
    expect(chips.map(c => c.textContent)).toEqual(['1st referee · Muster Anna', 'Scorer · Scorer Sam · Result changed'])
    expect(chips[0].parentElement).toHaveAttribute('title', 'Approved 07.10.2026 21:42 · ID 6F1C2A9B')
    expect(chips[1].parentElement.className).toContain('amber')
    expect(chips[0].parentElement.className).toContain('emerald')
  })

  it('official games: chips from the claim', async () => {
    render(<OfficialGamesPanel />)
    const chips = await screen.findAllByTestId('approval-chip')
    expect(chips.map(c => c.textContent)).toEqual(['2nd referee · Beispiel Ben'])
  })
})

describe('approval lookup', () => {
  it('looks up an ID with admin.listApprovals and lists the admin record', async () => {
    render(<ClosedMatchesPanel />)
    const box = await screen.findByTestId('approval-lookup')
    fireEvent.change(within(box).getByLabelText(en.manage.approvals.lookupPlaceholder), { target: { value: ' 6F1C2A9B ' } })
    fireEvent.click(within(box).getByLabelText(en.manage.approvals.includeRevoked))
    fireEvent.click(within(box).getByRole('button', { name: en.manage.approvals.lookupButton }))
    await waitFor(() => expect(api.admin.listApprovals).toHaveBeenCalledWith({ q: '6F1C2A9B', include_revoked: true, limit: 50 }))
    const text = (await within(box).findByText(/anna@example\.ch/)).closest('div[class*="divide"]').textContent
    expect(text).toContain('1st referee · Muster Anna')
    expect(text).toContain('ID 6F1C2A9B')
    expect(text).toContain('#4711 Home V vs Away V')
    expect(text).toContain(en.manage.approvals.revoked)
    expect(text).toContain('match reopened')
    expect(text).toContain('IP 95eef55b · device 0a1b2c3d')
  })

  it('nothing found', async () => {
    api.admin.listApprovals = vi.fn(async () => ok({ approvals: [] }))
    render(<ClosedMatchesPanel />)
    const box = await screen.findByTestId('approval-lookup')
    fireEvent.change(within(box).getByLabelText(en.manage.approvals.lookupPlaceholder), { target: { value: '4711' } })
    fireEvent.click(within(box).getByRole('button', { name: en.manage.approvals.lookupButton }))
    expect(await within(box).findByText(en.manage.approvals.lookupEmpty)).toBeInTheDocument()
  })
})

describe('audit wording', () => {
  it('approval entries: slot, ID, reason; PIN locks: failures and blocked', () => {
    expect(auditDetailsLine({ action: 'match.approve', details: { slot: 'referee1', short_id: '6F1C2A9B', external_id: 'match_1', game_n: 4711, result_key: 'x' } }, tMock))
      .toBe('1st referee · ID 6F1C2A9B · #4711')
    expect(auditDetailsLine({ action: 'match.approval_revoke', details: { slot: 'scorer', short_id: 'A1B2C3D4', reason: 'undo' } }, tMock))
      .toBe('Scorer · ID A1B2C3D4 · undone')
    expect(auditDetailsLine({ action: 'match.approval_void', details: { count: 2, reason: 'match_reopened', game_n: 4711 } }, tMock))
      .toBe('#4711 · × 2 · match reopened')
    expect(auditDetailsLine({ action: 'approval_pin.locked', details: { failures: 10, disabled: true } }, tMock))
      .toBe('10 wrong PINs · blocked')
    expect(auditDetailsLine({ action: 'approval_pin.locked', details: { failures: 5, disabled: false } }))
      .toBe('5 wrong PINs')
  })
  it('the action labels exist in every locale', async () => {
    const locales = await Promise.all(['en', 'de', 'de-CH', 'fr', 'it'].map(l => import(`../../i18n/locales/${l}.json`)))
    for (const l of locales) {
      for (const a of ['approval_pin_set', 'approval_pin_remove', 'approval_pin_locked', 'match_approve', 'match_approval_revoke', 'match_approval_void']) {
        expect(l.default.manage.audit.actions[a]).toBeTruthy()
      }
    }
  })
})
