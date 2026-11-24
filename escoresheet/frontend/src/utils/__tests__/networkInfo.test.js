import { describe, it, expect, vi } from 'vitest'
import {
  buildAppUrls,
  buildWebSocketUrl,
  buildCloudUrls,
  copyToClipboard,
  isSecureContext
} from '../networkInfo'

describe('buildAppUrls', () => {
  it('builds correct URLs from IP and port', () => {
    const urls = buildAppUrls('192.168.1.100', '8080')
    expect(urls.main).toBe('http://192.168.1.100:8080')
    expect(urls.referee).toBe('http://192.168.1.100:8080/referee')
    expect(urls.bench).toBe('http://192.168.1.100:8080/bench')
    expect(urls.livescore).toBe('http://192.168.1.100:8080/livescore')
    expect(urls.uploadRoster).toBe('http://192.168.1.100:8080/upload_roster')
  })

  it('uses custom protocol', () => {
    const urls = buildAppUrls('10.0.0.1', '443', 'https')
    expect(urls.main).toBe('https://10.0.0.1:443')
    expect(urls.referee).toBe('https://10.0.0.1:443/referee')
  })

  it('defaults to http protocol', () => {
    const urls = buildAppUrls('192.168.1.1', '3000')
    expect(urls.main).toMatch(/^http:\/\//)
  })
})

describe('buildWebSocketUrl', () => {
  it('builds ws:// URL by default', () => {
    expect(buildWebSocketUrl('192.168.1.100', 8080)).toBe('ws://192.168.1.100:8080')
  })

  it('builds wss:// URL when secure', () => {
    expect(buildWebSocketUrl('192.168.1.100', 8080, true)).toBe('wss://192.168.1.100:8080')
  })

  it('uses default port 8080', () => {
    expect(buildWebSocketUrl('10.0.0.1')).toBe('ws://10.0.0.1:8080')
  })
})

describe('buildCloudUrls', () => {
  it('returns null for null/undefined input', () => {
    expect(buildCloudUrls(null)).toBeNull()
    expect(buildCloudUrls(undefined)).toBeNull()
  })

  it('builds correct URLs from backend URL', () => {
    const urls = buildCloudUrls('https://backend.openvolley.app')
    expect(urls.main).toBe('https://backend.openvolley.app')
    expect(urls.referee).toBe('https://backend.openvolley.app/referee')
    expect(urls.bench).toBe('https://backend.openvolley.app/bench')
    expect(urls.livescore).toBe('https://backend.openvolley.app/livescore')
  })

  it('strips trailing slash', () => {
    const urls = buildCloudUrls('https://backend.openvolley.app/')
    expect(urls.main).toBe('https://backend.openvolley.app')
  })
})

describe('copyToClipboard', () => {
  it('uses navigator.clipboard.writeText when available', async () => {
    navigator.clipboard.writeText.mockResolvedValue(undefined)
    const result = await copyToClipboard('test text')
    expect(result.success).toBe(true)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('test text')
  })
})

describe('isSecureContext', () => {
  it('returns true for https:', () => {
    Object.defineProperty(window, 'location', {
      value: { protocol: 'https:', hostname: 'example.com' },
      writable: true,
      configurable: true
    })
    expect(isSecureContext()).toBe(true)
  })

  it('returns true for localhost', () => {
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', hostname: 'localhost' },
      writable: true,
      configurable: true
    })
    expect(isSecureContext()).toBe(true)
  })

  it('returns false for http: on non-localhost', () => {
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', hostname: '192.168.1.100' },
      writable: true,
      configurable: true
    })
    expect(isSecureContext()).toBe(false)
  })
})
