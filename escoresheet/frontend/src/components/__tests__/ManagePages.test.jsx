import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { useState } from 'react'

// Owner 2026-11-10: "make sure every page there gets their own page (team,
// club, game, player etc)". An account (#accounts/<id>), an official game
// (#games/<game number>) and a match (#matches/<id>) are pages: opened from
// their row, opened from the URL (also when the list does not show them),
// the way back, and a page whose thing is not there.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => (typeof opts === 'string' ? opts : opts?.name ? `${key}|${opts.name}` : key),
    i18n: { language: 'en' }
  })
}))

const api = vi.hoisted(() => ({
  admin: {
    listAccounts: vi.fn(), setRoles: vi.fn(), setAccountClubs: vi.fn(), deleteAccount: vi.fn(), rejectAccount: vi.fn(), decideRequests: vi.fn(),
    listMatches: vi.fn(), listRevisions: vi.fn(), listMatchClosures: vi.fn(), reopenMatch: vi.fn(), listApprovals: vi.fn(),
    listOfficialGames: vi.fn(), addMatchEditor: vi.fn(), releaseGame: vi.fn(), readMatchPin: vi.fn(), resetMatchPin: vi.fn(),
    finalMailStatus: vi.fn(), sendFinalMail: vi.fn()
  },
  clubs: { list: vi.fn() },
  fetchPublicClubs: vi.fn()
}))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), admin: api.admin, clubsApi: api.clubs, fetchPublicClubs: api.fetchPublicClubs }))
const ui = vi.hoisted(() => ({ confirm: vi.fn(async () => true), toasts: [] }))
vi.mock('../../ui', async (orig) => {
  const real = await orig()
  return {
    ...real,
    confirmDialog: (...a) => ui.confirm(...a),
    toast: { ...real.toast, success: (m) => ui.toasts.push(['ok', m]), error: (m) => ui.toasts.push(['error', m]), info: (m) => ui.toasts.push(['info', m]) }
  }
})

import AccountsPanel from '../manage/AccountsPanel'
import OfficialGamesPanel from '../manage/OfficialGamesPanel'
import ClosedMatchesPanel from '../manage/ClosedMatchesPanel'
import RevisionsModal from '../manage/RevisionsModal'

const ok = (data) => ({ data, error: null, status: 200 })

/** A panel with its route kept as the console keeps it; returns the go() calls ([path, opts]). */
function routed(Panel, props = {}, initial = '') {
  const calls = []
  function Harness() {
    const [route, setRoute] = useState(initial)
    return <Panel {...props} route={route} onRoute={(path, opts) => { calls.push([path, opts]); setRoute(path) }} />
  }
  render(<Harness />)
  return calls
}

beforeEach(() => {
  vi.clearAllMocks()
  ui.toasts = []
  ui.confirm.mockResolvedValue(true)
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true })
})

// ── Accounts ──

const NEWBIE = {
  id: 'u-new', email: 'new@example.ch', first_name: 'Pat', last_name: 'Pending', roles: [], pending: true, clubs: [],
  created_at: '2026-11-01T08:00:00Z', last_sign_in_at: null, email_confirmed: false, managed_clubs: [], managed_teams: [], requests: []
}
const SCORER = {
  id: 'u-sc', email: 'sam@example.ch', first_name: 'Sam', last_name: 'Scorer', roles: ['scorer'], pending: false,
  clubs: [{ id: 'c-must', name: 'VBC Musterdorf' }], created_at: '2026-10-01T08:00:00Z', last_sign_in_at: '2026-11-02T08:00:00Z',
  email_confirmed: true, managed_clubs: [], managed_teams: [{ id: 't-h1', name: 'VBC Musterdorf H1', club_id: 'c-must' }], requests: []
}

describe('an account is a page (#accounts/<account id>)', () => {
  const props = { selfId: 'u-self', app: 'indoor' }
  beforeEach(() => {
    // the Pending filter shows the sign-up only; every account: both
    api.admin.listAccounts.mockImplementation(async ({ filter }) => ok({ accounts: filter === 'pending' ? [NEWBIE] : [NEWBIE, SCORER], can_delete: true }))
    api.clubs.list.mockResolvedValue(ok({ clubs: [] }))
  })

  it('opens from its row with what the row says and its actions; Back returns to the list', async () => {
    const calls = routed(AccountsPanel, props)
    fireEvent.click(await screen.findByRole('button', { name: 'Pat Pending' }))
    expect(calls).toEqual([['u-new', { push: true }]])
    const page = await screen.findByTestId('account-page')
    expect(within(page).getByRole('heading', { name: 'Pat Pending' })).toBeInTheDocument()
    expect(page).toHaveTextContent('new@example.ch')
    expect(page).toHaveTextContent('manage.accounts.emailUnconfirmed')
    expect(page).toHaveTextContent('manage.accounts.neverSignedIn')
    expect(page).toHaveTextContent('access.roles.pending')
    expect(within(page).getByTestId('approve-account')).toBeInTheDocument()
    expect(within(page).getByTestId('reject-account')).toBeInTheDocument()
    expect(within(page).queryByTestId('delete-account')).toBeNull()
    fireEvent.click(screen.getByTestId('account-page-back'))
    expect(calls.at(-1)).toEqual(['', { push: true }])
    expect(await screen.findByTestId('account-u-new')).toBeInTheDocument()
  })

  it('opens from the URL: an account the list does not show is looked up among all accounts', async () => {
    routed(AccountsPanel, props, 'u-sc')
    const page = await screen.findByTestId('account-page')
    expect(within(page).getByRole('heading', { name: 'Sam Scorer' })).toBeInTheDocument()
    expect(api.admin.listAccounts).toHaveBeenCalledWith({ filter: 'all', limit: 500, app: 'indoor' })
    expect(page).toHaveTextContent('access.roles.scorer')
    expect(page).toHaveTextContent('VBC Musterdorf')
    expect(page).toHaveTextContent('manage.requests.managesTeam|VBC Musterdorf H1')
    expect(within(page).getByTestId('delete-account')).toBeInTheDocument()
    expect(within(page).queryByTestId('approve-account')).toBeNull()
  })

  it('an account that is not there (deleted, an old link): not found, with the way back', async () => {
    const calls = routed(AccountsPanel, props, 'u-gone')
    expect(await screen.findByText('manage.pageNotFound')).toBeInTheDocument()
    fireEvent.click(within(screen.getByTestId('page-missing')).getByRole('button', { name: 'manage.tabs.accounts' }))
    expect(calls).toEqual([['', { push: true }]])
    expect(await screen.findByTestId('account-u-new')).toBeInTheDocument()
  })

  it('the page opens the same dialogs as the row; a deleted account leaves its page in place of the history entry', async () => {
    api.admin.deleteAccount.mockResolvedValue(ok({ id: 'u-sc', deleted: true }))
    const calls = routed(AccountsPanel, props, 'u-sc')
    const page = await screen.findByTestId('account-page')
    fireEvent.click(within(page).getByTestId('edit-roles'))
    expect(await screen.findByText('manage.accounts.rolesTitle|Sam Scorer')).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(within(page).getByTestId('edit-clubs'))
    expect(await screen.findByText('manage.accounts.clubsTitle|Sam Scorer')).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(within(page).getByTestId('delete-account'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByTestId('delete-account-email'), { target: { value: 'sam@example.ch' } })
    fireEvent.click(within(dialog).getByTestId('confirm-delete-account'))
    await waitFor(() => expect(api.admin.deleteAccount).toHaveBeenCalledWith('u-sc', { email: 'sam@example.ch' }))
    await waitFor(() => expect(calls.at(-1)).toEqual(['', { push: false }]))
    expect(ui.toasts).toContainEqual(['ok', 'manage.accounts.deleted|Sam Scorer'])
  })

  it('approved on its page, the account stays on the page though it left the Pending list', async () => {
    api.admin.setRoles.mockResolvedValue(ok({ roles: ['scorer'] }))
    routed(AccountsPanel, props, 'u-new')
    const page = await screen.findByTestId('account-page')
    api.admin.listAccounts.mockImplementation(async ({ filter }) => ok({ accounts: filter === 'pending' ? [] : [{ ...NEWBIE, roles: ['scorer'], pending: false }, SCORER], can_delete: true }))
    fireEvent.click(within(page).getByTestId('approve-account'))
    await waitFor(() => expect(api.admin.setRoles).toHaveBeenCalledWith('u-new', { add: ['scorer'], remove: [] }))
    await waitFor(() => expect(screen.getByTestId('account-page')).toHaveTextContent('access.roles.scorer'))
    expect(screen.getByTestId('account-page')).not.toHaveTextContent('access.roles.pending')
    expect(screen.queryByTestId('page-missing')).toBeNull()
    expect(api.admin.listAccounts).toHaveBeenCalledWith({ filter: 'all', limit: 500, app: 'indoor' })
  })

  it('a rejected sign-up leaves its page in place of the history entry', async () => {
    api.admin.rejectAccount.mockResolvedValue(ok({ id: 'u-new', deleted: true, rejected: true }))
    const calls = routed(AccountsPanel, props, 'u-new')
    fireEvent.click(within(await screen.findByTestId('account-page')).getByTestId('reject-account'))
    await waitFor(() => expect(api.admin.rejectAccount).toHaveBeenCalledWith('u-new', { email: 'new@example.ch' }))
    await waitFor(() => expect(calls.at(-1)).toEqual(['', { push: false }]))
  })
})

// ── Official games ──

const GAME = {
  game_number: '4711', datetime: '2026-11-12T19:30:00Z', team_home: 'Home V', team_away: 'Away V', league: '2. Liga', hall: 'Halle Nord', city: 'Musterdorf',
  claim: { match_id: 'm-1', external_id: 'match_1', status: 'ended', scorer_name: 'Sam Scorer', editors: 2, closed_at: null, approvals: [] }
}
const FREE = { game_number: '4712', datetime: '2026-11-13T19:30:00Z', team_home: 'Free H', team_away: 'Free A', league: '3. Liga', hall: null, city: null, claim: null }

describe('an official game is a page (#games/<game number>)', () => {
  beforeEach(() => {
    api.admin.listOfficialGames.mockImplementation(async ({ q }) => ok({ games: q === '9999' ? [{ ...FREE, game_number: '9999', team_home: 'Far H', team_away: 'Far A' }] : q ? [] : [GAME, FREE] }))
  })

  it('opens from its row with its facts, Add editor, Release game and its match\'s page', async () => {
    const navigate = vi.fn(() => true)
    const calls = routed(OfficialGamesPanel, { navigate, canOpen: (id) => id === 'matches' })
    fireEvent.click(await screen.findByRole('button', { name: 'Home V vs Away V' }))
    expect(calls).toEqual([['4711', { push: true }]])
    const page = await screen.findByTestId('official-game-page')
    expect(within(page).getByRole('heading', { name: 'Home V vs Away V' })).toBeInTheDocument()
    const facts = screen.getByTestId('official-game-facts')
    expect(facts).toHaveTextContent('#4711')
    expect(facts).toHaveTextContent('2. Liga')
    expect(facts).toHaveTextContent('Halle Nord, Musterdorf')
    expect(facts).toHaveTextContent('Sam Scorer')
    fireEvent.click(screen.getByTestId('official-game-match'))
    expect(navigate).toHaveBeenCalledWith('matches/m-1')
    fireEvent.click(screen.getByTestId('official-game-add-editor'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('manage.games.addEditorTitle')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByTestId('official-game-release'))
    expect(await screen.findByText('manage.games.releaseConfirmTitle')).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByTestId('official-game-back'))
    expect(calls.at(-1)).toEqual(['', { push: true }])
    expect(await screen.findByTestId('game-4711')).toBeInTheDocument()
  })

  it('shows each game\'s match format, an unknown one marked', async () => {
    api.admin.listOfficialGames.mockImplementation(async () => ok({ games: [{ ...GAME, match_format: 3 }, { ...FREE, match_format: null }] }))
    routed(OfficialGamesPanel, {})
    expect(await screen.findByTestId('game-4711')).toHaveTextContent('matchSetup.bestOf3')
    const free = screen.getByTestId('game-4712')
    expect(within(free).getByTestId('game-format-unknown')).toHaveTextContent('manage.games.formatUnknown')
  })

  it('a game nobody scores yet: "Not claimed", no actions', async () => {
    routed(OfficialGamesPanel, {}, '4712')
    const page = await screen.findByTestId('official-game-page')
    expect(page).toHaveTextContent('manage.games.notClaimed')
    expect(screen.queryByTestId('official-game-add-editor')).toBeNull()
    expect(screen.queryByTestId('official-game-match')).toBeNull()
  })

  it('opens from the URL on another day than the list shows: its number is looked up 120 days around today', async () => {
    routed(OfficialGamesPanel, {}, '9999')
    const page = await screen.findByTestId('official-game-page')
    expect(within(page).getByRole('heading', { name: 'Far H vs Far A' })).toBeInTheDocument()
    const lookups = api.admin.listOfficialGames.mock.calls.map(([o]) => o).filter((o) => o.q === '9999')
    expect(lookups).toHaveLength(2)
    for (const { from, to } of lookups) expect((Date.parse(to) - Date.parse(from)) / 86400000).toBeLessThanOrEqual(120)
  })

  it('a game that is not there: not found, with the way back', async () => {
    const calls = routed(OfficialGamesPanel, {}, '1234')
    expect(await screen.findByText('manage.pageNotFound')).toBeInTheDocument()
    fireEvent.click(within(screen.getByTestId('page-missing')).getByRole('button', { name: 'manage.tabs.games' }))
    expect(calls).toEqual([['', { push: true }]])
  })
})

// ── Matches ──

const MATCH = {
  id: 'm-1', external_id: 'match_1', game_n: 4711, status: 'final', home_name: 'Home V', away_name: 'Away V', league: '2. Liga',
  scheduled_at: '2026-10-07T17:00:00Z', scorer_name: 'Sam Scorer', editors: 1, closed_at: '2026-10-07T20:00:00Z', closed_by_name: 'Ada Admin',
  official_game_exempt: false, approvals: []
}
const OPEN = { ...MATCH, id: 'm-2', external_id: 'match_2', game_n: 4712, status: 'ended', home_name: 'Open H', away_name: 'Open A', closed_at: null, closed_by_name: null }
const REVISION = {
  id: 'r-1', op: 'void', reason: 'undo', event_type: 'point', event_seq: 3, applied: true, client_ts: '2026-10-07T18:00:00Z',
  actor_email: 'sam@example.ch', before: { type: 'point', payload: { team: 'home' } }
}
const CLOSURE = {
  id: '7', closed_at: '2026-10-07T19:00:00Z', reopened_at: '2026-10-07T19:30:00Z', reason: 'Sanction on the wrong player',
  reopened_by_name: 'Ada Admin', reclosed_at: '2026-10-07T20:00:00Z',
  closed_record: { status: 'approved', final_score: '3:1', remarks: 'Protest of the home team', sanctions: [{ type: 'warning' }], sets: [{ index: 1, home_points: 25, away_points: 20 }] },
  reclosed_record: { status: 'approved', final_score: '3:1', remarks: null, sanctions: [], sets: [{ index: 1, home_points: 25, away_points: 21 }] }
}

describe('a match is a page (#matches/<match id>)', () => {
  beforeEach(() => {
    api.admin.listMatches.mockImplementation(async ({ state }) => ok({ matches: state === 'all' ? [MATCH, OPEN] : state === 'open' ? [OPEN] : [MATCH] }))
    api.admin.listRevisions.mockResolvedValue(ok([REVISION]))
    api.admin.listMatchClosures.mockImplementation(async (id) => ok({ closures: id === 'm-1' ? [CLOSURE] : [] }))
    api.admin.reopenMatch.mockResolvedValue(ok({ reopened: true }))
    api.admin.finalMailStatus.mockResolvedValue(ok({ mail: true, switch_on: true, sendable: true, reason: null, recipients: 3, pdf: true, resend: false, state: { outcome: null, recipients: 0, sent_at: null } }))
  })

  it('opens from its row with its facts, its corrections, Reopen and Activity', async () => {
    const onShowActivity = vi.fn()
    const calls = routed(ClosedMatchesPanel, { onShowActivity })
    await screen.findByTestId('match-m-1')
    // the corrections are on the page, not a tool of the row
    expect(screen.queryByRole('button', { name: 'manage.matches.corrections' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Home V vs Away V' }))
    expect(calls).toEqual([['m-1', { push: true }]])
    const page = await screen.findByTestId('match-page')
    expect(within(page).getByRole('heading', { name: 'Home V vs Away V' })).toBeInTheDocument()
    const facts = screen.getByTestId('match-facts')
    expect(facts).toHaveTextContent('#4711')
    expect(facts).toHaveTextContent('Sam Scorer')
    expect(facts).toHaveTextContent('manage.matches.closedBy|Ada Admin')
    await waitFor(() => expect(api.admin.listRevisions).toHaveBeenCalledWith('m-1'))
    expect(await within(page).findByTestId('revisions-list')).toHaveTextContent('sam@example.ch')
    // the earlier close: the fields that changed, as closed and as closed again (db/039)
    const closure = await within(page).findByTestId('closure-7')
    expect(closure).toHaveTextContent('Sanction on the wrong player')
    expect(closure).toHaveTextContent('Protest of the home team')
    expect(closure).toHaveTextContent('25:20')
    expect(closure).toHaveTextContent('25:21')
    expect(within(closure).getByText('manage.matches.closures.fields.remarks')).toBeInTheDocument()
    expect(within(closure).queryByText('manage.matches.closures.fields.final_score')).toBeNull()
    fireEvent.click(screen.getByTestId('match-activity'))
    expect(onShowActivity).toHaveBeenCalledWith('match_1')
    fireEvent.click(screen.getByTestId('match-reopen'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Wrong score' } })
    fireEvent.click(within(dialog).getByTestId('reason-confirm'))
    await waitFor(() => expect(api.admin.reopenMatch).toHaveBeenCalledWith('m-1', { reason: 'Wrong score' }))
    expect(ui.toasts).toContainEqual(['ok', 'manage.matches.reopened'])
    fireEvent.click(screen.getByTestId('match-page-back'))
    expect(calls.at(-1)).toEqual(['', { push: true }])
    expect(await screen.findByTestId('match-m-1')).toBeInTheDocument()
  })

  it('opens from the URL: a match the list does not show (an open one) is looked up among the latest', async () => {
    routed(ClosedMatchesPanel, {}, 'm-2')
    const page = await screen.findByTestId('match-page')
    expect(within(page).getByRole('heading', { name: 'Open H vs Open A' })).toBeInTheDocument()
    expect(api.admin.listMatches).toHaveBeenCalledWith({ state: 'all', limit: 500 })
    // not closed: nothing to reopen; no activity tab for this account
    expect(screen.queryByTestId('match-reopen')).toBeNull()
    expect(screen.queryByTestId('match-activity')).toBeNull()
    await waitFor(() => expect(api.admin.listRevisions).toHaveBeenCalledWith('m-2'))
    expect(await within(page).findByText('manage.matches.closures.empty')).toBeInTheDocument()
  })

  // Owner 2026-11-15: "can i get the match pin here? ... otherwise how can i
  // reopen the game from thin air?" Hidden until asked, each read its own
  // (audited) request; a PIN the server keeps only hashed: a new one.
  describe('its game PIN', () => {
    let writeText
    beforeEach(() => {
      // the test setup's navigator.clipboard (not redefinable)
      writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    })

    it('is hidden until Show PIN, then shown with a copy button and hidden again', async () => {
      api.admin.readMatchPin.mockResolvedValue(ok({ pin: '135790', stored: 'plain', game_n: 4711 }))
      routed(ClosedMatchesPanel, {}, 'm-1')
      const box = await screen.findByTestId('match-pin')
      expect(screen.queryByTestId('match-pin-value')).toBeNull()
      expect(box).not.toHaveTextContent('135790')
      expect(api.admin.readMatchPin).not.toHaveBeenCalled()
      // the list never carried it
      expect(JSON.stringify(api.admin.listMatches.mock.results)).not.toContain('135790')
      fireEvent.click(within(box).getByTestId('match-pin-show'))
      expect(await within(box).findByTestId('match-pin-value')).toHaveTextContent('135790')
      expect(api.admin.readMatchPin).toHaveBeenCalledWith('m-1')
      expect(box).toHaveTextContent('manage.matches.pin.howTo')
      fireEvent.click(within(box).getByTestId('match-pin-copy'))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('135790'))
      expect(ui.toasts).toContainEqual(['ok', 'manage.matches.pin.copied'])
      fireEvent.click(within(box).getByTestId('match-pin-hide'))
      expect(within(box).queryByTestId('match-pin-value')).toBeNull()
      expect(within(box).getByTestId('match-pin-show')).toBeInTheDocument()
      // shown again: read (and audited) again
      fireEvent.click(within(box).getByTestId('match-pin-show'))
      await within(box).findByTestId('match-pin-value')
      expect(api.admin.readMatchPin).toHaveBeenCalledTimes(2)
    })

    it('a hashed PIN cannot be shown: Set new PIN, after a confirmation, shows the new one', async () => {
      api.admin.readMatchPin.mockResolvedValue(ok({ pin: null, stored: 'hashed', game_n: 4711 }))
      api.admin.resetMatchPin.mockResolvedValue(ok({ pin: '482913', stored: 'hashed', game_n: 4711 }))
      routed(ClosedMatchesPanel, {}, 'm-1')
      const box = await screen.findByTestId('match-pin')
      fireEvent.click(within(box).getByTestId('match-pin-show'))
      expect(await within(box).findByText('manage.matches.pin.hashed')).toBeInTheDocument()
      expect(within(box).queryByTestId('match-pin-value')).toBeNull()
      // declined: nothing changes
      ui.confirm.mockResolvedValueOnce(false)
      fireEvent.click(within(box).getByTestId('match-pin-reset'))
      await waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(1))
      expect(api.admin.resetMatchPin).not.toHaveBeenCalled()
      fireEvent.click(within(box).getByTestId('match-pin-reset'))
      expect(await within(box).findByTestId('match-pin-value')).toHaveTextContent('482913')
      expect(api.admin.resetMatchPin).toHaveBeenCalledWith('m-1')
      expect(ui.toasts).toContainEqual(['ok', 'manage.matches.pin.resetDone'])
      fireEvent.click(within(box).getByTestId('match-pin-copy'))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('482913'))
    })

    it('a refused read shows the error and no PIN', async () => {
      api.admin.readMatchPin.mockResolvedValue({ data: null, error: { code: 'OV_FORBIDDEN', status: 403 }, status: 403 })
      routed(ClosedMatchesPanel, {}, 'm-1')
      const box = await screen.findByTestId('match-pin')
      fireEvent.click(within(box).getByTestId('match-pin-show'))
      await waitFor(() => expect(within(box).getByRole('alert')).toBeInTheDocument())
      expect(within(box).queryByTestId('match-pin-value')).toBeNull()
    })
  })

  // Owner 2026-11-15: the switch mails only the matches closed after it was
  // turned on; an admin sends the final mail of one closed before (or again).
  describe('its final mail', () => {
    const status = (over = {}) => ok({ mail: true, switch_on: false, sendable: true, reason: null, recipients: 4, pdf: true, resend: false, state: { outcome: null, recipients: 0, sent_at: null }, ...over })

    it('shows the state, asks with the count and the PDF, sends, and shows the new state', async () => {
      api.admin.finalMailStatus.mockResolvedValueOnce(status()).mockResolvedValueOnce(status())
        .mockResolvedValue(status({ resend: true, state: { outcome: 'sent', recipients: 4, sent_at: '2026-11-15T18:00:00Z' } }))
      api.admin.sendFinalMail.mockResolvedValue(ok({ outcome: 'sent', recipients: 4, reached: 4, pdf: true, resend: false }))
      routed(ClosedMatchesPanel, {}, 'm-1')
      const box = await screen.findByTestId('final-mail')
      expect(await within(box).findByTestId('final-mail-state')).toHaveTextContent('manage.matches.finalMail.states.none')
      expect(box).toHaveTextContent('manage.matches.finalMail.hintOff')
      expect(api.admin.finalMailStatus).toHaveBeenCalledWith('m-1')
      const button = within(box).getByTestId('final-mail-send')
      expect(button).toHaveTextContent('manage.matches.finalMail.send')
      fireEvent.click(button)
      await waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(1))
      const asked = ui.confirm.mock.calls[0][0]
      expect(asked.title).toBe('manage.matches.finalMail.confirmTitle')
      expect(asked.message).toContain('manage.matches.finalMail.confirmRecipients')
      expect(asked.message).toContain('manage.matches.finalMail.confirmPdf')
      expect(asked.message).not.toContain('manage.matches.finalMail.confirmResend')
      // the count and the PDF read again right before asking
      expect(api.admin.finalMailStatus.mock.invocationCallOrder[1]).toBeLessThan(ui.confirm.mock.invocationCallOrder[0])
      await waitFor(() => expect(api.admin.sendFinalMail).toHaveBeenCalledWith('m-1'))
      await waitFor(() => expect(ui.toasts).toContainEqual(['ok', 'manage.matches.finalMail.sent']))
      expect(await within(box).findByText('manage.matches.finalMail.states.sent')).toBeInTheDocument()
      expect(within(box).getByTestId('final-mail-send')).toHaveTextContent('manage.matches.finalMail.sendAgain')
    })

    it('declined: nothing is sent', async () => {
      ui.confirm.mockResolvedValueOnce(false)
      routed(ClosedMatchesPanel, {}, 'm-1')
      const box = await screen.findByTestId('final-mail')
      fireEvent.click(await within(box).findByTestId('final-mail-send'))
      await waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(1))
      expect(api.admin.sendFinalMail).not.toHaveBeenCalled()
    })

    it('without a PDF and mailed before: the dialog says so, and the toast too', async () => {
      api.admin.finalMailStatus.mockResolvedValue(status({ pdf: false, resend: true, switch_on: true, state: { outcome: 'sent_no_pdf', recipients: 2, sent_at: '2026-11-15T18:00:00Z' } }))
      api.admin.sendFinalMail.mockResolvedValue(ok({ outcome: 'sent_no_pdf', recipients: 2, reached: 2, pdf: false, resend: true }))
      routed(ClosedMatchesPanel, {}, 'm-1')
      const box = await screen.findByTestId('final-mail')
      expect(await within(box).findByText('manage.matches.finalMail.states.sent_no_pdf')).toBeInTheDocument()
      fireEvent.click(within(box).getByTestId('final-mail-send'))
      await waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(1))
      const asked = ui.confirm.mock.calls[0][0]
      expect(asked.title).toBe('manage.matches.finalMail.confirmTitleAgain')
      expect(asked.message).toContain('manage.matches.finalMail.confirmNoPdf')
      expect(asked.message).toContain('manage.matches.finalMail.confirmResend')
      await waitFor(() => expect(ui.toasts).toContainEqual(['ok', 'manage.matches.finalMail.sentNoPdf']))
    })

    it('a failed send: an error toast', async () => {
      api.admin.sendFinalMail.mockResolvedValue({ data: null, error: { code: 'OV_FINAL_MAIL_BUSY', status: 409 }, status: 409 })
      routed(ClosedMatchesPanel, {}, 'm-1')
      const box = await screen.findByTestId('final-mail')
      fireEvent.click(await within(box).findByTestId('final-mail-send'))
      await waitFor(() => expect(ui.toasts).toContainEqual(['error', 'manage.matches.finalMail.busy']))
    })

    it('a match the mail is not for (a released game): why, and no button', async () => {
      api.admin.finalMailStatus.mockResolvedValue(status({ sendable: false, reason: 'released', recipients: 0, pdf: false }))
      routed(ClosedMatchesPanel, {}, 'm-1')
      const box = await screen.findByTestId('final-mail')
      expect(await within(box).findByText('manage.matches.finalMail.refused.released')).toBeInTheDocument()
      expect(within(box).queryByTestId('final-mail-send')).toBeNull()
    })

    it('an open match: no final mail box', async () => {
      routed(ClosedMatchesPanel, {}, 'm-2')
      await screen.findByTestId('match-page')
      expect(screen.queryByTestId('final-mail')).toBeNull()
      expect(api.admin.finalMailStatus).not.toHaveBeenCalled()
    })
  })

  it('a match that is not there: not found, with the way back', async () => {
    const calls = routed(ClosedMatchesPanel, {}, 'm-gone')
    expect(await screen.findByText('manage.pageNotFound')).toBeInTheDocument()
    expect(api.admin.listRevisions).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByTestId('page-missing')).getByRole('button', { name: 'manage.tabs.matches' }))
    expect(calls).toEqual([['', { push: true }]])
  })

  it('the corrections dialog still lists them for a caller that wants it', async () => {
    render(<RevisionsModal match={MATCH} onClose={() => {}} />)
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByTestId('revisions-list')).toHaveTextContent('sam@example.ch')
    expect(api.admin.listRevisions).toHaveBeenCalledWith('m-1')
  })
})
