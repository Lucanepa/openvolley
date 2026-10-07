import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../utils/backendConfig', () => ({
  getApiUrl: (path) => `http://relay.test${path}`,
  getCloudApiUrl: (path) => `http://backend.test${path}`
}))

import { apiRequest } from '../apiClient'
import { redeemInvite, officialCheck, admin, savedTeamsApi, errorKeyOf, formatInviteCode, fetchMe, joinApp, OFFICIAL_CHECK_CONFIRM_TIMEOUT_MS } from '../accountApi'

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const call = (n = 0) => {
  const [url, init] = globalThis.fetch.mock.calls[n]
  return { url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body), headers: init.headers }
}

describe('apiRequest', () => {
  beforeEach(() => {
    localStorage.setItem('api_auth_token', JSON.stringify({ access_token: 'tok', expires_at: Date.now() / 1000 + 3600 }))
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: { ok: true }, error: null }))
  })
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('sends the bearer token and no body for GET and DELETE', async () => {
    const res = await apiRequest('GET', '/api/saved-teams')
    expect(res).toEqual({ data: { ok: true }, error: null, status: 200 })
    expect(call().method).toBe('GET')
    expect(call().body).toBeUndefined()
    expect(call().headers.Authorization).toBe('Bearer tok')
    await apiRequest('DELETE', '/api/saved-teams/teams/x')
    expect(call(1).body).toBeUndefined()
  })

  it('returns the error envelope with code and extra fields', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: null, error: { message: 'taken', code: 'OV_GAME_TAKEN', claim: { game_n: 1 } } }, 409))
    const res = await apiRequest('POST', '/api/db', {})
    expect(res.status).toBe(409)
    expect(res.error).toMatchObject({ code: 'OV_GAME_TAKEN', claim: { game_n: 1 }, status: 409 })
  })

  it('turns a network failure into status 0', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const res = await apiRequest('GET', '/api/admin/invites')
    expect(res.status).toBe(0)
    expect(res.error.network).toBe(true)
  })
})

describe('officialCheck timeout (the courtesy check before creating a match)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('gives up after timeoutMs with a network-style error, so creation is not held up', async () => {
    // a stalled venue network: fetch only settles when its signal aborts
    globalThis.fetch = vi.fn((url, init) => new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const started = Date.now()
    const res = await officialCheck({ game_n: 5 }, { timeoutMs: 50 })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(res.status).toBe(0)
    expect(res.error.network).toBe(true)
    expect(OFFICIAL_CHECK_CONFIRM_TIMEOUT_MS).toBeLessThanOrEqual(4000)
  })
})

describe('accountApi endpoints', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: {}, error: null }))
  })
  afterEach(() => vi.restoreAllMocks())

  it('hits the exact paths and bodies of the contract', async () => {
    await redeemInvite(' abcd-efgh-jkmn ')
    await officialCheck({ game_n: 123, scheduled_at: null, external_id: 'match_1' })
    await admin.listAccounts({ filter: 'all', q: 'a b' })
    await admin.setRoles('u-1', { add: ['scorer'] })
    await admin.createInvite({ label: 'Club', max_uses: null, expires_at: null })
    await admin.revokeInvite('i-1')
    await admin.listOfficialGames({ from: '2026-10-01', to: '2026-10-14' })
    await admin.listMatches({ state: 'open', limit: 50 })
    await admin.reopenMatch('m-1', { reason: 'typo' })
    await admin.addMatchEditor('m-1', { email: 'x@y.z' })
    await admin.releaseGame('m-1', { reason: 'wrong number' })
    await admin.listAudit({ before: 10, action: 'match.reopen' })
    await savedTeamsApi.fetchBundle()
    await savedTeamsApi.fetchBundle({ sport: 'beach' })
    await savedTeamsApi.fetchBundle({ sport: 'all' })
    await savedTeamsApi.createCompetition({ name: 'L', season: '2026/27' })
    await savedTeamsApi.createCompetition({ name: 'Tour', season: '2026', sport: 'beach', vm_leagues: [] })
    await savedTeamsApi.updateCompetition('c-1', { archived: true })
    await savedTeamsApi.deleteCompetition('c-1')
    await savedTeamsApi.createTeam({ competition_id: 'c-1', name: 'T' })
    await savedTeamsApi.updateTeam('t-1', { color: '#ffffff' })
    await savedTeamsApi.deleteTeam('t-1')
    await savedTeamsApi.putRoster('t-1', { players: [], staff: [] })

    const calls = globalThis.fetch.mock.calls.map((_, i) => call(i))
    expect(calls.map(c => `${c.method} ${c.url.replace('http://backend.test', '')}`)).toEqual([
      'POST /api/account/redeem-invite',
      'POST /api/match/official-check',
      'GET /api/admin/accounts?filter=all&q=a%20b',
      'POST /api/admin/accounts/u-1/roles',
      'POST /api/admin/invites',
      'POST /api/admin/invites/i-1/revoke',
      'GET /api/admin/official-games?from=2026-10-01&to=2026-10-14',
      'GET /api/admin/matches?state=open&limit=50',
      'POST /api/admin/matches/m-1/reopen',
      'POST /api/admin/matches/m-1/editors',
      'POST /api/admin/matches/m-1/release-game',
      'GET /api/admin/audit?before=10&action=match.reopen',
      'GET /api/saved-teams',
      'GET /api/saved-teams?sport=beach',
      'GET /api/saved-teams?sport=all',
      'POST /api/saved-teams/competitions',
      'POST /api/saved-teams/competitions',
      'PATCH /api/saved-teams/competitions/c-1',
      'DELETE /api/saved-teams/competitions/c-1',
      'POST /api/saved-teams/teams',
      'PATCH /api/saved-teams/teams/t-1',
      'DELETE /api/saved-teams/teams/t-1',
      'PUT /api/saved-teams/teams/t-1/roster'
    ])
    expect(calls[0].body).toEqual({ code: 'abcd-efgh-jkmn' })
    expect(calls[1].body).toEqual({ game_n: 123, scheduled_at: null, sport_type: 'indoor', external_id: 'match_1' })
    expect(calls[3].body).toEqual({ add: ['scorer'], remove: [] })
    expect(calls[4].body).toEqual({ label: 'Club', club: null, role: 'scorer', max_uses: null, expires_at: null })
    expect(calls[8].body).toEqual({ reason: 'typo' })
    expect(calls[22].body).toEqual({ players: [], staff: [] })
    expect(calls[13].body).toBeUndefined()
    expect(calls[14].body).toBeUndefined()
    expect(calls[12].body).toBeUndefined()
    expect(calls[16].body).toEqual({ name: 'Tour', season: '2026', sport: 'beach', vm_leagues: [] })
  })
})

describe('errorKeyOf and formatInviteCode', () => {
  it('maps codes to i18n keys', () => {
    expect(errorKeyOf({ code: 'OV_INVITE_EXPIRED', status: 410 })).toBe('access.errors.inviteExpired')
    expect(errorKeyOf({ code: 'OV_SELF_DEMOTE', status: 409 })).toBe('manage.accounts.selfDemote')
    expect(errorKeyOf({ code: 'OV_EMAIL_UNCONFIRMED', status: 409 })).toBe('access.errors.emailUnconfirmed')
    expect(errorKeyOf({ network: true, status: 0 })).toBe('manage.errors.offline')
    expect(errorKeyOf({ status: 403 })).toBe('manage.errors.forbidden')
    expect(errorKeyOf({ status: 500 })).toBe('manage.errors.generic')
    expect(errorKeyOf(null)).toBeNull()
  })
  it('groups an invite code as the user types', () => {
    expect(formatInviteCode('abcdefgh')).toBe('ABCD-EFGH')
    expect(formatInviteCode('ab cd-ef gh jk mn pq')).toBe('ABCD-EFGH-JKMN')
    expect(formatInviteCode('ABCD')).toBe('ABCD')
  })
})

describe('per-app calls (OpenBeach\'s manager)', () => {
  beforeEach(() => {
    localStorage.setItem('api_auth_token', JSON.stringify({ access_token: 'tok', expires_at: Date.now() / 1000 + 3600 }))
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: {}, error: null }))
  })
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('the admin lists take ?app=; without it the URLs are as before', async () => {
    await admin.listAccounts({ filter: 'all', app: 'beach' })
    await admin.listInvites({ app: 'beach' })
    await admin.listAudit({ limit: 50, app: 'beach' })
    await admin.listAccounts({ filter: 'pending' })
    await admin.listInvites()
    await admin.listAudit({ limit: 50 })
    expect(globalThis.fetch.mock.calls.map(c => c[0].replace('http://backend.test', ''))).toEqual([
      '/api/admin/accounts?filter=all&app=beach',
      '/api/admin/invites?app=beach',
      '/api/admin/audit?limit=50&app=beach',
      '/api/admin/accounts?filter=pending',
      '/api/admin/invites',
      '/api/admin/audit?limit=50'
    ])
  })

  it('a beach invite carries sport; an indoor one sends what it sent', async () => {
    await admin.createInvite({ label: 'Tour', role: 'scorer', max_uses: 30, sport: 'beach' })
    await admin.createInvite({ label: 'Club', role: 'scorer' })
    expect(call(0).body).toEqual({ label: 'Tour', club: null, role: 'scorer', max_uses: 30, sport: 'beach' })
    expect(call(1).body).toEqual({ label: 'Club', club: null, role: 'scorer', max_uses: 1 })
  })

  it('GET /api/me and POST /api/account/join', async () => {
    await fetchMe()
    await joinApp('beach')
    expect([call(0).method, call(0).url]).toEqual(['GET', 'http://backend.test/api/me'])
    expect([call(1).method, call(1).url, call(1).body]).toEqual(['POST', 'http://backend.test/api/account/join', { app: 'beach' }])
  })
})
