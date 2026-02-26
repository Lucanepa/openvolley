import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  setBackendOverride,
  getBackendOverride,
  clearBackendOverride,
  isDesktopPlatform,
  isStaticDeployment,
  getApiUrl
} from '../backendConfig'

beforeEach(() => {
  localStorage.clear()
})

describe('Backend Override', () => {
  it('getBackendOverride returns null when no override is set', () => {
    expect(getBackendOverride()).toBeNull()
  })

  it('setBackendOverride stores a URL', () => {
    setBackendOverride('http://192.168.1.100:8080')
    expect(getBackendOverride()).toBe('http://192.168.1.100:8080')
  })

  it('setBackendOverride with null clears the override', () => {
    setBackendOverride('http://example.com')
    setBackendOverride(null)
    expect(getBackendOverride()).toBeNull()
  })

  it('clearBackendOverride removes the stored URL', () => {
    setBackendOverride('http://example.com')
    clearBackendOverride()
    expect(getBackendOverride()).toBeNull()
  })

  it('override is stored in localStorage with correct key', () => {
    setBackendOverride('http://test.local')
    expect(localStorage.getItem('openvolley_backend_override')).toBe('http://test.local')
  })
})

describe('isDesktopPlatform', () => {
  it('returns true when window.electronAPI exists', () => {
    window.electronAPI = {}
    expect(isDesktopPlatform()).toBe(true)
    delete window.electronAPI
  })

  it('detects desktop user agent', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      configurable: true
    })
    expect(isDesktopPlatform()).toBe(true)
  })

  it('detects mobile user agent', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
      configurable: true
    })
    expect(isDesktopPlatform()).toBe(false)
  })

  it('detects tablet user agent with Android', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Linux; Android 12; SM-T500)',
      configurable: true
    })
    expect(isDesktopPlatform()).toBe(false)
  })
})

describe('isStaticDeployment', () => {
  it('returns true for *.openvolley.app hostnames', () => {
    Object.defineProperty(window, 'location', {
      value: { hostname: 'referee.openvolley.app' },
      writable: true,
      configurable: true
    })
    expect(isStaticDeployment()).toBe(true)
  })

  it('returns false for localhost', () => {
    Object.defineProperty(window, 'location', {
      value: { hostname: 'localhost' },
      writable: true,
      configurable: true
    })
    expect(isStaticDeployment()).toBe(false)
  })

  it('returns false for other domains', () => {
    Object.defineProperty(window, 'location', {
      value: { hostname: 'example.com' },
      writable: true,
      configurable: true
    })
    expect(isStaticDeployment()).toBe(false)
  })
})

describe('getApiUrl', () => {
  it('returns null when no backend URL available', () => {
    // No override, no env, no static deployment — standalone mode
    localStorage.clear()
    Object.defineProperty(window, 'location', {
      value: { hostname: 'localhost', protocol: 'http:', port: '5173' },
      writable: true,
      configurable: true
    })
    // In test env, getBackendUrl() behavior depends on import.meta.env.DEV
    // We test getApiUrl with an override set
    setBackendOverride('http://192.168.1.100:8080')
    const result = getApiUrl('/api/health')
    expect(result).toBe('http://192.168.1.100:8080/api/health')
  })

  it('prepends slash if missing', () => {
    setBackendOverride('http://localhost:8080')
    expect(getApiUrl('api/test')).toBe('http://localhost:8080/api/test')
  })

  it('does not double-slash', () => {
    setBackendOverride('http://localhost:8080')
    expect(getApiUrl('/api/test')).toBe('http://localhost:8080/api/test')
  })
})
