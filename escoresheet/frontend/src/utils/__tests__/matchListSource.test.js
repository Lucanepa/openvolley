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

  it('web page (cloud first): cloud and relay lists merged by id, the relay\'s row winning', async () => {
    const listCloud = vi.fn().mockResolvedValue({ success: true, matches: [cloudMatch, { id: 'both', gameNumber: 3, homeTeam: 'cloud' }] })
    const listRelay = vi.fn().mockResolvedValue({ success: true, matches: [relayMatch, { id: 'both', gameNumber: 3, homeTeam: 'relay' }] })
    const r = await loadMatchList({ listCloud, listRelay })
    expect(r.source).toBe('supabase')
    expect(listRelay).toHaveBeenCalled()
    expect(r.result.success).toBe(true)
    expect(r.result.matches.map((m) => [m.id, m.listSource])).toEqual([
      ['cloud_1', 'supabase'], ['both', 'websocket'], ['relay_1', 'websocket']
    ])
    expect(r.result.matches.find((m) => m.id === 'both').homeTeam).toBe('relay')
  })

  it('web page: one cloud match no longer hides the hall\'s relay matches', async () => {
    const r = await loadMatchList({
      listCloud: vi.fn().mockResolvedValue({ success: true, matches: [cloudMatch] }),
      listRelay: vi.fn().mockResolvedValue({ success: true, matches: [relayMatch] })
    })
    expect(r.result.matches.map((m) => m.id).sort()).toEqual(['cloud_1', 'relay_1'])
  })

  it('web page: a relay that never answers holds up the cloud list for the grace time only', async () => {
    const started = Date.now()
    const r = await loadMatchList({
      listCloud: vi.fn().mockResolvedValue({ success: true, matches: [cloudMatch] }),
      listRelay: vi.fn(never),
      relayGraceMs: 50
    })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(r.result.matches.map((m) => m.id)).toEqual(['cloud_1'])
  })

  it('web page: a failing relay leaves the cloud list', async () => {
    const r = await loadMatchList({
      listCloud: vi.fn().mockResolvedValue({ success: true, matches: [cloudMatch] }),
      listRelay: vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    })
    expect(r).toMatchObject({ source: 'supabase', result: { success: true } })
    expect(r.result.matches.map((m) => m.id)).toEqual(['cloud_1'])
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
