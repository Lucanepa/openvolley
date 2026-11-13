import { describe, it, expect, vi } from 'vitest'
import { sendMatchInfoMail } from './matchInfoMail'

const reply = (status, body) => ({ status, json: async () => body })

describe('sendMatchInfoMail', () => {
  it('retries a 404 until the new match has synced', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply(404, { success: false, error: 'Match not found' }))
      .mockResolvedValueOnce(reply(200, { success: true }))
    const sleep = vi.fn(async () => {})
    const data = await sendMatchInfoMail({ url: '/api/match/send-info', headers: { Authorization: 'Bearer t' }, externalId: 'm-1', delaysMs: [10, 20], fetchImpl, sleep })
    expect(data.success).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(10)
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ externalId: 'm-1' })
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer t')
  })

  it('gives up after the last delay and does not retry other errors', async () => {
    const notFound = vi.fn(async () => reply(404, { success: false, error: 'Match not found' }))
    const out = await sendMatchInfoMail({ url: 'u', headers: {}, externalId: 'x', delaysMs: [1, 1], fetchImpl: notFound, sleep: async () => {} })
    expect(out.success).toBe(false)
    expect(notFound).toHaveBeenCalledTimes(3)
    const unconfirmed = vi.fn(async () => reply(409, { success: false, code: 'OV_EMAIL_UNCONFIRMED' }))
    await sendMatchInfoMail({ url: 'u', headers: {}, externalId: 'x', delaysMs: [1], fetchImpl: unconfirmed, sleep: async () => {} })
    expect(unconfirmed).toHaveBeenCalledTimes(1)
  })
})
