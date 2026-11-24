import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

vi.mock('../backendConfig', () => ({ getCloudApiUrl: (p) => `https://backend.test${p}` }))
import { pushGlobalLive, pushesGlobalLive, pickSummary, resetGlobalLivePush, PUSH_MS } from '../globalLivePush'

const db = {
  teams: { get: async (id) => ({ id, name: id === 1 ? 'Bergtal IS' : 'Seeblick IS', players: ['no'] }) },
  sets: { where: () => ({ equals: () => ({ toArray: async () => [{ index: 2, homePoints: 3, awayPoints: 1, finished: false }, { index: 1, homePoints: 25, awayPoints: 20, finished: true }] }) }) }
}
const match = { id: 7, global: true, globalKey: 'k'.repeat(22), homeTeamId: 1, awayTeamId: 2, coinTossTeamA: 'home', hall: 'Hall 1', refereePin: '316271' }
const live = (p) => ({ team_a_name: 'Bergtal IS', points_a: p, points_b: 0, lineup_a: { I: 7 }, sanctions_a: [1] })
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => resetGlobalLivePush())
afterEach(() => { vi.useRealTimers(); resetGlobalLivePush() })

describe('globalLivePush', () => {
  it('only the desktop app pushes', () => {
    expect(pushesGlobalLive({ __TAURI_INTERNALS__: {} })).toBe(true)
    expect(pushesGlobalLive({ Capacitor: { isNativePlatform: () => true } })).toBe(false)
    expect(pushesGlobalLive({})).toBe(false)
  })

  it('sends the court summary only: no line-ups, sanctions, PINs or players', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }))
    pushGlobalLive({ code: 'ABCD2345', match, liveState: live(3), db, matchId: 7, fetchImpl })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://backend.test/api/global/live/ABCD2345')
    expect(init.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(init.body)
    expect(body.court).toMatch(/^[0-9a-f]{32}$/)
    expect(body.liveState).toEqual({ team_a_name: 'Bergtal IS', points_a: 3, points_b: 0 })
    expect(body.homeTeam).toEqual({ name: 'Bergtal IS' })
    expect(body.sets).toEqual([{ index: 1, homePoints: 25, awayPoints: 20, finished: true }])
    // a Global match is listed on the livescore unless the device turned it off
    expect(body.listed).toBe(true)
    expect(init.body).not.toContain('316271')
    expect(init.body).not.toContain('players')
    expect(pickSummary({ lineup_a: 1, points_a: 2 })).toEqual({ points_a: 2 })
  })

  it('at most one request per match per window; the newest state goes out after it', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async () => ({ ok: true }))
    pushGlobalLive({ code: 'ABCD2345', match, liveState: live(1), db, matchId: 7, fetchImpl })
    pushGlobalLive({ code: 'ABCD2345', match, liveState: live(2), db, matchId: 7, fetchImpl })
    pushGlobalLive({ code: 'ABCD2345', match, liveState: live(3), db, matchId: 7, fetchImpl })
    await vi.advanceTimersByTimeAsync(10)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(PUSH_MS + 10)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).liveState.points_a).toBe(3)
  })

  it('never offline', async () => {
    const fetchImpl = vi.fn()
    pushGlobalLive({ code: 'ABCD2345', match, liveState: live(1), db, matchId: 7, fetchImpl, online: () => false })
    await flush()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
