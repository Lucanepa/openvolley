import { describe, it, expect, vi } from 'vitest'
import { loadMatchList } from '../matchListSource'

const cloudMatch = { id: 'cloud_1', gameNumber: 1 }
const relayMatch = { id: 'relay_1', gameNumber: 2 }
const never = () => new Promise(() => {})

describe('referee / bench match list source', () => {
  it('venue page (relay first): the relay list shows even when the cloud never answers', async () => {
    const listCloud = vi.fn(never)
    const listRelay = vi.fn().mockResolvedValue({ success: true, matches: [relayMatch] })
    const started = Date.now()
    const r = await loadMatchList({ listCloud, listRelay, relayFirst: true })
    expect(Date.now() - started).toBeLessThan(500)
    expect(r).toMatchObject({ source: 'websocket', result: { matches: [relayMatch] }, cloud: null })
    expect(listCloud).not.toHaveBeenCalled()
  })

  it('venue page with an empty relay still asks the cloud', async () => {
    const listCloud = vi.fn().mockResolvedValue({ success: true, matches: [cloudMatch] })
    const listRelay = vi.fn().mockResolvedValue({ success: true, matches: [] })
    const r = await loadMatchList({ listCloud, listRelay, relayFirst: true })
    expect(r.source).toBe('supabase')
    expect(r.result.matches).toEqual([cloudMatch])
  })

  it('venue page with neither server: the relay\'s answer, not a cloud error', async () => {
    const listCloud = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const listRelay = vi.fn().mockResolvedValue({ success: true, matches: [] })
    const r = await loadMatchList({ listCloud, listRelay, relayFirst: true })
    expect(r).toMatchObject({ source: 'websocket', result: { success: true, matches: [] }, cloud: { success: false } })
  })

  it('web page (cloud first): the cloud list wins and the relay is not asked', async () => {
    const listCloud = vi.fn().mockResolvedValue({ success: true, matches: [cloudMatch] })
    const listRelay = vi.fn()
    const r = await loadMatchList({ listCloud, listRelay })
    expect(r.source).toBe('supabase')
    expect(listRelay).not.toHaveBeenCalled()
  })

  it('web page: an empty or failing cloud falls back to the relay', async () => {
    const listRelay = vi.fn().mockResolvedValue({ success: true, matches: [relayMatch] })
    for (const cloudAnswer of [{ success: true, matches: [] }, { success: false, error: 'HTTP 404' }]) {
      const r = await loadMatchList({ listCloud: vi.fn().mockResolvedValue(cloudAnswer), listRelay })
      expect(r).toMatchObject({ source: 'websocket', result: { matches: [relayMatch] }, cloud: cloudAnswer })
    }
  })

  it('web page with an empty cloud and no relay keeps the cloud\'s empty list', async () => {
    const r = await loadMatchList({
      listCloud: vi.fn().mockResolvedValue({ success: true, matches: [] }),
      listRelay: vi.fn().mockResolvedValue({ success: false, matches: [], error: 'Failed to fetch' })
    })
    expect(r).toMatchObject({ source: 'supabase', result: { success: true, matches: [] } })
  })

  it('WebSocket mode never asks the cloud', async () => {
    const listCloud = vi.fn()
    const r = await loadMatchList({ listCloud, listRelay: vi.fn().mockResolvedValue({ success: true, matches: [relayMatch] }), useCloud: false })
    expect(r.source).toBe('websocket')
    expect(listCloud).not.toHaveBeenCalled()
  })
})
