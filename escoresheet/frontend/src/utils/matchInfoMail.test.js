import { describe, it, expect, vi } from 'vitest'
import { sendMatchInfoMail, sendMatchPinMail } from './matchInfoMail'

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

describe('sendMatchPinMail', () => {
  it('posts the external id and the PIN as text, and answers the status with the JSON', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { success: true }))
    const out = await sendMatchPinMail({ url: '/api/match/send-pin', headers: { Authorization: 'Bearer t' }, externalId: 'm-1', gamePin: 654321, fetchImpl, sleep: async () => {} })
    expect(out).toEqual({ success: true, status: 200 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/match/send-pin')
    expect(JSON.parse(init.body)).toEqual({ externalId: 'm-1', gamePin: '654321' })
    expect(init.headers.Authorization).toBe('Bearer t')
    // never an address: the server mails the account's own
    expect(init.body).not.toMatch(/@/)
  })

  it('retries a 404 shortly (the new match still uploading), keeps the code of other errors', async () => {
    const sleep = vi.fn(async () => {})
    const notFound = vi.fn(async () => reply(404, { success: false, error: 'Match not found' }))
    const out = await sendMatchPinMail({ url: 'u', headers: {}, externalId: 'x', gamePin: '1', fetchImpl: notFound, sleep })
    expect(notFound).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([3000, 8000])
    expect(out.status).toBe(404)
    const mismatch = vi.fn(async () => reply(409, { success: false, code: 'OV_PIN_MISMATCH' }))
    expect(await sendMatchPinMail({ url: 'u', headers: {}, externalId: 'x', gamePin: '1', fetchImpl: mismatch, sleep })).toEqual({ success: false, code: 'OV_PIN_MISMATCH', status: 409 })
    expect(mismatch).toHaveBeenCalledTimes(1)
  })

  it('no answer: status 0 and network, never a throw', async () => {
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const out = await sendMatchPinMail({ url: 'u', headers: {}, externalId: 'x', gamePin: '1', fetchImpl: offline, sleep: async () => {} })
    expect(out).toMatchObject({ success: false, network: true, status: 0 })
  })
})
