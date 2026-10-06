import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/db', () => ({ db: {} }))
vi.mock('../backendConfig', () => ({ getApiUrl: (p) => `http://backend.test${p}`, getCloudApiUrl: (p) => `http://backend.test${p}` }))

const byPin = vi.hoisted(() => ({ calls: [], result: null }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: vi.fn(() => { throw new Error('fetchMatchByPin must not use /api/db') }),
  apiStorage: { from: vi.fn() },
  apiMatchRestoreByPin: async (gameN, pin) => {
    byPin.calls.push({ gameN, pin })
    return byPin.result
  }
}))

import { fetchMatchByPin } from '../backupManager'

describe('fetchMatchByPin (POST /api/match/restore-by-pin)', () => {
  beforeEach(() => {
    byPin.calls = []
  })

  it('asks the server with an integer game number and returns match, sets, events, live state', async () => {
    byPin.result = {
      data: {
        match: { id: 'uuid', external_id: 'seed', game_n: 12, status: 'live' },
        sets: [{ index: 1, home_points: 25, away_points: 20, finished: true }],
        events: [{ seq: 1, set_index: 1, type: 'point', payload: { team: 'home' } }],
        liveState: { points_a: 3, points_b: 1, current_set: 2 }
      },
      error: null,
      status: 200
    }
    const out = await fetchMatchByPin(' 123456 ', '12')
    expect(byPin.calls).toEqual([{ gameN: 12, pin: '123456' }])
    expect(out.match.id).toBe('uuid')
    expect(out.match.game_pin).toBe('123456') // the server strips it; the caller proved it
    expect(out.sets).toHaveLength(1)
    expect(out.liveState.points_a).toBe(3)
  })

  it('turns 404 and 429 into readable errors', async () => {
    byPin.result = { data: null, error: { code: 'OV_NOT_FOUND', status: 404, message: 'x' }, status: 404 }
    await expect(fetchMatchByPin('123456', 12)).rejects.toThrow('Match not found with this ID and PIN')
    byPin.result = { data: null, error: { code: 'OV_TOO_MANY_ATTEMPTS', status: 429, message: 'x' }, status: 429 }
    await expect(fetchMatchByPin('123456', 12)).rejects.toThrow(/Too many attempts/)
  })

  it('needs both a game number and a PIN', async () => {
    await expect(fetchMatchByPin('123456', undefined)).rejects.toThrow(/required/)
    await expect(fetchMatchByPin('', 12)).rejects.toThrow(/required/)
    expect(byPin.calls).toEqual([])
  })
})
