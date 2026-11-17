import { describe, it, expect, vi } from 'vitest'
import { prefersShare, shareFile } from '../shareFile.js'

const blob = new Blob(['x'], { type: 'application/zip' })

function fakeWin({ ua = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', share, canShare = () => true, native = false } = {}) {
  const clicks = []
  return {
    clicks,
    navigator: { userAgent: ua, platform: 'iPad', maxTouchPoints: 5, share, canShare },
    File: class { constructor(parts, name, opts) { this.name = name; this.type = opts?.type } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    document: { createElement: () => { const a = { click: () => clicks.push(a.download) }; return a } },
    Capacitor: native ? { isNativePlatform: () => true, getPlatform: () => 'ios' } : undefined
  }
}

describe('prefersShare', () => {
  it('is true on an iPad browser and in the native app, false on a desktop', () => {
    expect(prefersShare(fakeWin())).toBe(true)
    expect(prefersShare(fakeWin({ native: true }))).toBe(true)
    expect(prefersShare({ navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', platform: 'Win32', maxTouchPoints: 0 } })).toBe(false)
  })
})

describe('shareFile (browser)', () => {
  it('opens the share sheet with the file', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const win = fakeWin({ share })
    await expect(shareFile(blob, 'a.zip', { win })).resolves.toBe('shared')
    expect(share).toHaveBeenCalledOnce()
    expect(share.mock.calls[0][0].files[0].name).toBe('a.zip')
    expect(win.clicks).toEqual([])
  })

  it('reports a closed share sheet as cancelled, without a download', async () => {
    const share = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'AbortError' }))
    const win = fakeWin({ share })
    await expect(shareFile(blob, 'a.zip', { win })).resolves.toBe('cancelled')
    expect(win.clicks).toEqual([])
  })

  it('falls back to the download when sharing files is not possible', async () => {
    const win = fakeWin({ share: vi.fn(), canShare: () => false })
    await expect(shareFile(blob, 'a.zip', { win })).resolves.toBe('downloaded')
    expect(win.clicks).toEqual(['a.zip'])
  })

  it('falls back to the download when the share is refused without a tap', async () => {
    const share = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    const win = fakeWin({ share })
    await expect(shareFile(blob, 'b.pdf', { win })).resolves.toBe('downloaded')
    expect(win.clicks).toEqual(['b.pdf'])
  })
})
