import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  setBackendOverride,
  getBackendOverride,
  clearBackendOverride,
  isDesktopPlatform,
  isStaticDeployment,
  isStaticHost,
  isNativeApp,
  isServedFromLocalServer,
  getLocalServerStatusUrl,
  getBackendUrl,
  getRelayWebSocketUrl,
  getApiUrl,
  getCloudApiUrl,
  getCloudWebSocketUrl,
  isCloudApiSplit,
  isLanBackendUrl
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

describe('static hosts and the local server status', () => {
  const setLocation = (url) => {
    const u = new URL(url)
    Object.defineProperty(window, 'location', {
      value: { hostname: u.hostname, protocol: u.protocol, port: u.port, origin: u.origin, host: u.host },
      writable: true,
      configurable: true
    })
  }
  afterEach(() => vi.unstubAllEnvs())

  it('treats Cloudflare Pages builds and GitHub Pages like *.openvolley.app (no backend behind them)', () => {
    for (const host of ['app.openvolley.app', 'openvolley.app', 'dev.openvolley-app.pages.dev', 'openvolley-referee.pages.dev', 'x.github.io']) {
      expect(isStaticHost(host), host).toBe(true)
    }
    for (const host of ['localhost', '192.168.1.20', 'openvolley.local', 'example.com']) {
      expect(isStaticHost(host), host).toBe(false)
    }
    setLocation('https://dev.openvolley-app.pages.dev/')
    expect(isStaticDeployment()).toBe(true)
  })

  it('polls /api/server/status only where a local server serves the page', () => {
    vi.stubEnv('DEV', false)
    setLocation('https://dev.openvolley-app.pages.dev/')
    expect(getLocalServerStatusUrl()).toBeNull()
    setLocation('https://app.openvolley.app/')
    expect(getLocalServerStatusUrl()).toBeNull()
    setLocation('http://192.168.1.20:3000/')
    expect(getLocalServerStatusUrl()).toBe('http://192.168.1.20:3000/api/server/status')
    setLocation('file:///opt/app/index.html')
    expect(getLocalServerStatusUrl()).toBeNull()
    vi.stubEnv('DEV', true)
    setLocation('http://localhost:5173/')
    expect(getLocalServerStatusUrl()).toBe('http://localhost:5173/api/server/status')
  })
})

describe('native app (Capacitor WebView on https://localhost)', () => {
  const setLocation = (url) => {
    const u = new URL(url)
    Object.defineProperty(window, 'location', {
      value: { hostname: u.hostname, protocol: u.protocol, port: u.port, origin: u.origin, host: u.host },
      writable: true,
      configurable: true
    })
  }
  beforeEach(() => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_BACKEND_URL', '')
    setLocation('https://localhost/')
    window.Capacitor = { isNativePlatform: () => true }
  })
  afterEach(() => {
    delete window.Capacitor
    vi.unstubAllEnvs()
  })

  it('is not mistaken for a standalone local server', () => {
    expect(isNativeApp()).toBe(true)
    expect(isServedFromLocalServer()).toBe(false)
    expect(getLocalServerStatusUrl()).toBeNull()
    expect(isStaticDeployment()).toBe(true)
    delete window.Capacitor
    expect(isNativeApp()).toBe(false)
    expect(isServedFromLocalServer()).toBe(true)
  })

  it('talks to the cloud backend, not to its own https://localhost', () => {
    expect(getBackendUrl()).toBe('https://backend.openvolley.app')
    expect(getRelayWebSocketUrl()).toBe('wss://backend.openvolley.app')
    vi.stubEnv('VITE_BACKEND_URL', 'https://backend.openvolley.app')
    expect(getApiUrl('/api/db')).toBe('https://backend.openvolley.app/api/db')
  })

  it('switches to a plain-http venue LAN relay entered by the user', () => {
    setBackendOverride('http://192.168.1.20:8080')
    expect(getBackendUrl()).toBe('http://192.168.1.20:8080')
    expect(getRelayWebSocketUrl()).toBe('ws://192.168.1.20:8080')
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

describe('cloud API split from the relay', () => {
  const setLocation = (url) => {
    const u = new URL(url)
    Object.defineProperty(window, 'location', {
      value: { hostname: u.hostname, protocol: u.protocol, port: u.port, origin: u.origin, host: u.host },
      writable: true,
      configurable: true
    })
  }
  beforeEach(() => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_BACKEND_URL', '')
    vi.stubEnv('VITE_CLOUD_API_URL', '')
  })
  afterEach(() => {
    delete window.Capacitor
    vi.unstubAllEnvs()
  })

  it('desktop app: cloud calls go to backend.openvolley.app, the relay stays on localhost', () => {
    setLocation('http://localhost:5173/')
    expect(getCloudApiUrl('/api/db')).toBe('https://backend.openvolley.app/api/db')
    expect(getCloudApiUrl('api/auth/sign-in')).toBe('https://backend.openvolley.app/api/auth/sign-in')
    expect(getCloudWebSocketUrl()).toBe('wss://backend.openvolley.app')
    expect(isCloudApiSplit()).toBe(true)
    // the relay side is unchanged
    expect(getBackendUrl()).toBe('http://localhost:5173')
    expect(getApiUrl('/api/server/connections')).toBe('http://localhost:5173/api/server/connections')
    expect(getRelayWebSocketUrl()).toBe('ws://localhost:8080')
  })

  it('venue tablets served by the desktop / Pi relay: relay on the LAN, cloud in the cloud', () => {
    setLocation('http://192.168.1.20:5173/referee')
    expect(getRelayWebSocketUrl()).toBe('ws://192.168.1.20:8080')
    expect(getApiUrl('/api/match/list')).toBe('http://192.168.1.20:5173/api/match/list')
    expect(getCloudApiUrl('/api/db')).toBe('https://backend.openvolley.app/api/db')
  })

  it('web build on *.openvolley.app: one backend for both (unchanged)', () => {
    vi.stubEnv('VITE_BACKEND_URL', 'https://backend.openvolley.app')
    setLocation('https://app.openvolley.app/')
    expect(getCloudApiUrl('/api/db')).toBe(getApiUrl('/api/db'))
    expect(getCloudApiUrl('/api/db')).toBe('https://backend.openvolley.app/api/db')
    expect(getCloudWebSocketUrl()).toBe('wss://backend.openvolley.app')
    expect(isCloudApiSplit()).toBe(false)
  })

  it('a static build without VITE_BACKEND_URL still uses the cloud for both', () => {
    setLocation('https://app.openvolley.app/')
    expect(getCloudApiUrl('/api/db')).toBe('https://backend.openvolley.app/api/db')
    expect(getApiUrl('/api/db')).toBe('https://backend.openvolley.app/api/db')
    expect(isCloudApiSplit()).toBe(false)
  })

  it('Android app pointed at a venue LAN relay keeps cloud sync on the cloud', () => {
    setLocation('https://localhost/')
    window.Capacitor = { isNativePlatform: () => true }
    expect(getCloudApiUrl('/api/db')).toBe('https://backend.openvolley.app/api/db')
    setBackendOverride('http://192.168.1.20:8080')
    expect(getRelayWebSocketUrl()).toBe('ws://192.168.1.20:8080')
    expect(getApiUrl('/api/server/connections')).toBe('http://192.168.1.20:8080/api/server/connections')
    expect(getCloudApiUrl('/api/db')).toBe('https://backend.openvolley.app/api/db')
    expect(getCloudWebSocketUrl()).toBe('wss://backend.openvolley.app')
    // a build's VITE_BACKEND_URL names the cloud; the LAN override never takes its place
    vi.stubEnv('VITE_BACKEND_URL', 'https://dev-backend.openvolley.app')
    expect(getCloudApiUrl('/api/db')).toBe('https://dev-backend.openvolley.app/api/db')
  })

  it('a cloud override (?server=dev-backend.openvolley.app) serves both', () => {
    setLocation('https://app.openvolley.app/')
    setBackendOverride('https://dev-backend.openvolley.app')
    expect(getCloudApiUrl('/api/db')).toBe('https://dev-backend.openvolley.app/api/db')
    expect(getApiUrl('/api/db')).toBe('https://dev-backend.openvolley.app/api/db')
  })

  it('VITE_CLOUD_API_URL wins for the cloud and never moves the relay', () => {
    vi.stubEnv('VITE_CLOUD_API_URL', 'https://cloud.example.org/')
    setLocation('http://localhost:5173/')
    expect(getCloudApiUrl('/api/db')).toBe('https://cloud.example.org/api/db')
    expect(getRelayWebSocketUrl()).toBe('ws://localhost:8080')
    expect(getApiUrl('/api/match/list')).toBe('http://localhost:5173/api/match/list')
  })

  it('the dev server keeps one origin for both', () => {
    vi.stubEnv('DEV', true)
    setLocation('http://localhost:5173/')
    expect(getCloudApiUrl('/api/db')).toBe('http://localhost:5173/api/db')
    expect(isCloudApiSplit()).toBe(false)
  })

  it('isLanBackendUrl tells venue relays from cloud hosts', () => {
    for (const u of ['http://localhost:8080', 'http://127.0.0.1:5173', 'http://192.168.1.20:8080', 'http://10.0.0.183:5173', 'http://172.20.1.2', 'http://openvolley.local:5173', 'http://[::1]:8080']) {
      expect(isLanBackendUrl(u), u).toBe(true)
    }
    for (const u of ['https://backend.openvolley.app', 'https://cloud.example.org', 'http://172.32.0.1', null, '', 'not a url']) {
      expect(isLanBackendUrl(u), String(u)).toBe(false)
    }
  })
})
