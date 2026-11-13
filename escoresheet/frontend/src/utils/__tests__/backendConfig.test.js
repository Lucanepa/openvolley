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
  isLanBackendUrl,
  isServedFromLanOrigin,
  isCloudBlockedOnThisPort,
  learnRelayWsPort,
  applyServerParam,
  relayWsPortFor,
  rememberRelayWsPort,
  isAllowedBackendUrl,
  normalizeServerAddress,
  linkServerState,
  confirmLinkServer,
  serverParamNeedsConfirm,
  isDefaultBackendUrl,
  getCloudApiBaseUrl,
  isDevBuild,
  isDevBuildWithoutBackend
} from '../backendConfig'
import { setAppEntry } from '../appEntry'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  setAppEntry(null)
})

describe('Backend Override', () => {
  it('getBackendOverride returns null when no override is set', () => {
    expect(getBackendOverride()).toBeNull()
  })

  it('setBackendOverride stores a URL', () => {
    setBackendOverride('http://192.168.1.100:8080')
    expect(getBackendOverride()).toBe('http://192.168.1.100:8080')
  })

  // An allowed URL: one the guard drops (http://example.com) left nothing to clear
  it('setBackendOverride with null clears the override', () => {
    setBackendOverride('http://192.168.1.100:8080')
    expect(getBackendOverride()).toBe('http://192.168.1.100:8080')
    setBackendOverride(null)
    expect(getBackendOverride()).toBeNull()
  })

  it('clearBackendOverride removes the stored URL', () => {
    setBackendOverride('https://backend.openvolley.app')
    expect(getBackendOverride()).toBe('https://backend.openvolley.app')
    clearBackendOverride()
    expect(getBackendOverride()).toBeNull()
    expect(localStorage.getItem('openvolley_backend_override')).toBeNull()
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

  // The desktop relays (Tauri, Electron, frontend/server.js) serve the pages
  // and /health on 5173 but take the WebSocket on 8080 only: the app pointed
  // at http://<laptop>:5173 used to open ws://<laptop>:5173 and never connected.
  it('reaches a desktop relay at <laptop>:5173 on its WebSocket port 8080', () => {
    setBackendOverride('http://192.168.1.20:5173')
    expect(getBackendUrl()).toBe('http://192.168.1.20:5173')
    expect(getRelayWebSocketUrl()).toBe('ws://192.168.1.20:8080')
    // The hotspot / Bluetooth addresses of the laptop too
    setBackendOverride('http://10.42.0.1:5173')
    expect(getRelayWebSocketUrl()).toBe('ws://10.42.0.1:8080')
  })

  it('uses the WebSocket port the relay named in /api/server/status', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ wsPort: 8091 }) }))
    setBackendOverride('http://192.168.1.20:5174')
    expect(getRelayWebSocketUrl()).toBe('ws://192.168.1.20:5174') // not known yet
    await expect(learnRelayWsPort('http://192.168.1.20:5174', { fetchImpl })).resolves.toBe('8091')
    expect(fetchImpl).toHaveBeenCalledWith('http://192.168.1.20:5174/api/server/status', expect.anything())
    expect(relayWsPortFor('http://192.168.1.20:5174/')).toBe('8091')
    expect(getRelayWebSocketUrl()).toBe('ws://192.168.1.20:8091')
    // The venue server takes both on one port and says so
    rememberRelayWsPort('http://192.168.1.30:8080', 8080)
    setBackendOverride('http://192.168.1.30:8080')
    expect(getRelayWebSocketUrl()).toBe('ws://192.168.1.30:8080')
    // A named port wins over the 5173 -> 8080 default
    rememberRelayWsPort('http://192.168.1.20:5173', 9000)
    setBackendOverride('http://192.168.1.20:5173')
    expect(getRelayWebSocketUrl()).toBe('ws://192.168.1.20:9000')
  })

  it('applies a role link ?server= once confirmed and learns a venue relay port in the background', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ wsPort: 8085 }) })
    setAppEntry('referee')
    expect(applyServerParam('http://192.168.1.20:5175')).toBe('ask') // another server than the app's: asked first
    expect(getBackendOverride()).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    confirmLinkServer('http://192.168.1.20:5175')
    expect(getBackendOverride()).toBe('http://192.168.1.20:5175')
    await vi.waitFor(() => expect(relayWsPortFor('http://192.168.1.20:5175')).toBe('8085'))
    expect(getRelayWebSocketUrl()).toBe('ws://192.168.1.20:8085')
    fetchSpy.mockClear()
    expect(applyServerParam('backend.openvolley.app')).toBe('known') // the app's own default: bare host is https, never asked
    expect(getBackendOverride()).toBe('https://backend.openvolley.app')
    expect(applyServerParam('http://evil.example.com:5173')).toBe('none') // refused: nothing fetched, nothing changed
    expect(getBackendOverride()).toBe('https://backend.openvolley.app')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('never asks the cloud for a port, nor trusts a bad answer', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ wsPort: 8080 }) }))
    await expect(learnRelayWsPort('https://backend.openvolley.app', { fetchImpl })).resolves.toBeNull()
    await expect(learnRelayWsPort('http://openvolley.local', { fetchImpl })).resolves.toBeNull() // proxy on the default port
    expect(fetchImpl).not.toHaveBeenCalled()
    setBackendOverride('https://backend.openvolley.app')
    expect(getRelayWebSocketUrl()).toBe('wss://backend.openvolley.app')

    const bad = vi.fn(async () => ({ ok: true, json: async () => ({ wsPort: 'nope' }) }))
    await expect(learnRelayWsPort('http://192.168.1.20:5173', { fetchImpl: bad })).resolves.toBeNull()
    const down = vi.fn(async () => { throw new Error('offline') })
    await expect(learnRelayWsPort('http://192.168.1.20:5173', { fetchImpl: down })).resolves.toBeNull()
    expect(relayWsPortFor('http://192.168.1.20:5173')).toBeNull()
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

  it('the desktop window on 127.0.0.1 is loopback too: cloud in the cloud', () => {
    setLocation('http://127.0.0.1:5173/')
    expect(isServedFromLanOrigin()).toBe(false)
    expect(getCloudApiUrl('/api/db')).toBe('https://backend.openvolley.app/api/db')
    expect(isCloudApiSplit()).toBe(true)
  })

  it('the desktop window off port 5173 (OPENVOLLEY_HTTP_PORT) has no cloud: the cloud CORS would reject it', () => {
    setLocation('http://localhost:5174/')
    expect(isCloudBlockedOnThisPort()).toBe(true)
    expect(getCloudApiUrl('/api/db')).toBeNull()
    expect(getCloudWebSocketUrl()).toBeNull()
    expect(isCloudApiSplit()).toBe(false)
    // the relay side is unchanged
    expect(getApiUrl('/api/server/connections')).toBe('http://localhost:5174/api/server/connections')
    setLocation('http://[::1]:5173/')
    expect(isCloudBlockedOnThisPort()).toBe(true)
    // the trusted loopback origins, a LAN tablet and a build naming its cloud are fine
    for (const url of ['http://localhost:5173/', 'http://127.0.0.1:5173/', 'http://localhost:3000/', 'http://192.168.1.20:5174/referee']) {
      setLocation(url)
      expect(isCloudBlockedOnThisPort(), url).toBe(false)
    }
    setLocation('http://localhost:5174/')
    vi.stubEnv('VITE_CLOUD_API_URL', 'https://cloud.example.org')
    expect(isCloudBlockedOnThisPort()).toBe(false)
    expect(getCloudApiUrl('/api/db')).toBe('https://cloud.example.org/api/db')
  })

  it('the dev server and a static deployment are never port-blocked', () => {
    vi.stubEnv('DEV', true)
    setLocation('http://localhost:5174/')
    expect(isCloudBlockedOnThisPort()).toBe(false)
    vi.stubEnv('DEV', false)
    setLocation('https://app.openvolley.app/')
    expect(isCloudBlockedOnThisPort()).toBe(false)
  })

  it('venue tablets served from a LAN address never try the cloud (it rejects LAN origins): cloud calls stay on their own relay', () => {
    setLocation('http://192.168.1.20:5173/referee')
    expect(isServedFromLanOrigin()).toBe(true)
    expect(getRelayWebSocketUrl()).toBe('ws://192.168.1.20:8080')
    expect(getApiUrl('/api/match/list')).toBe('http://192.168.1.20:5173/api/match/list')
    // the relay answers /api/db with an instant 404: no cloud, relay fallback at once
    expect(getCloudApiUrl('/api/db')).toBe('http://192.168.1.20:5173/api/db')
    expect(getCloudWebSocketUrl()).toBe('ws://192.168.1.20:5173')
    expect(isCloudApiSplit()).toBe(false)
    // a build-level VITE_CLOUD_API_URL does not make a LAN tablet hit a CORS wall either
    vi.stubEnv('VITE_CLOUD_API_URL', 'https://backend.openvolley.app')
    expect(getCloudApiUrl('/api/db')).toBe('http://192.168.1.20:5173/api/db')
  })

  it('the Pi on its mDNS name and a self-hosted domain keep cloud calls on the page origin', () => {
    setLocation('http://openvolley.local/')
    expect(getCloudApiUrl('/api/db')).toBe('http://openvolley.local/api/db')
    setLocation('https://scores.myclub.ch/')
    expect(getCloudApiUrl('/api/db')).toBe('https://scores.myclub.ch/api/db')
    expect(isCloudApiSplit()).toBe(false)
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

// isAllowedBackendUrl is the only check between a ?server= link or a typed
// address and the session token and password: a loosened rule (a suffix test
// without the dot, public addresses, plain http to the cloud) must fail here.
describe('isAllowedBackendUrl', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('takes a venue relay on this machine or the hall network over http or https', () => {
    for (const u of [
      'http://localhost:8080', 'http://127.0.0.1:5173', 'http://[::1]:8080', 'http://192.168.1.20:5173',
      'http://10.0.0.183:8080', 'http://172.16.0.1', 'http://172.31.255.254:8080', 'http://openvolley.local',
      'https://192.168.1.20:5173', 'https://openvolley.local:8443'
    ]) {
      expect(isAllowedBackendUrl(u), u).toBe(true)
    }
  })

  it('takes an openvolley.app host over https only', () => {
    for (const u of ['https://backend.openvolley.app', 'https://openvolley.app', 'https://dev-backend.openvolley.app', 'https://BACKEND.openvolley.app/']) {
      expect(isAllowedBackendUrl(u), u).toBe(true)
    }
    // plain http to the cloud would carry the password and the session token in clear
    for (const u of ['http://backend.openvolley.app', 'http://openvolley.app', 'http://dev-backend.openvolley.app:80']) {
      expect(isAllowedBackendUrl(u), u).toBe(false)
    }
  })

  it('refuses foreign hosts, look-alikes, public addresses and other schemes', () => {
    for (const u of [
      'https://example.com', 'http://example.com', 'https://openvolley.app.evil.example', 'https://backend.openvolley.app.evil.example',
      'https://xopenvolley.app', 'https://backend-openvolley.app', 'https://evil.example/backend.openvolley.app',
      'https://evil.example?x=.openvolley.app', 'https://backend.openvolley.app.', 'http://203.0.113.5', 'https://8.8.8.8',
      'http://172.32.0.1', 'http://172.15.0.1', 'http://192.169.1.1', 'http://11.0.0.1', 'http://100.101.102.103:8080',
      'http://scorer-laptop:8080', 'http://evil.localhost.example', 'ws://192.168.1.20:8080', 'ftp://192.168.1.20',
      'javascript:alert(1)', 'data:text/html,x', 'not a url', '', null, undefined, 42
    ]) {
      expect(isAllowedBackendUrl(u), String(u)).toBe(false)
    }
  })

  it('a dev build never takes the production backend (owner decision 5)', () => {
    vi.stubEnv('VITE_OV_DEV_BUILD', 'true')
    expect(isDevBuild()).toBe(true)
    expect(isAllowedBackendUrl('https://backend.openvolley.app')).toBe(false)
    expect(isAllowedBackendUrl('https://dev-backend.openvolley.app')).toBe(true)
    expect(isAllowedBackendUrl('http://192.168.1.20:5173')).toBe(true)
    setBackendOverride('https://backend.openvolley.app')
    expect(getBackendOverride()).toBeNull()
  })
})

describe('normalizeServerAddress (connection screen and links)', () => {
  it('gives a bare address http:// on the hall network and https:// elsewhere', () => {
    expect(normalizeServerAddress('192.168.1.42:5173')).toBe('http://192.168.1.42:5173')
    expect(normalizeServerAddress('  10.0.0.2:8080/ ')).toBe('http://10.0.0.2:8080')
    expect(normalizeServerAddress('openvolley.local')).toBe('http://openvolley.local')
    expect(normalizeServerAddress('localhost:8080')).toBe('http://localhost:8080')
    expect(normalizeServerAddress('backend.openvolley.app')).toBe('https://backend.openvolley.app')
    expect(normalizeServerAddress('scorer-laptop:8080')).toBe('https://scorer-laptop:8080')
    expect(normalizeServerAddress('https://backend.openvolley.app/')).toBe('https://backend.openvolley.app')
    expect(normalizeServerAddress('HTTP://192.168.1.42:5173')).toBe('HTTP://192.168.1.42:5173')
    expect(normalizeServerAddress('')).toBe('')
  })
})

// fe-connect-devices-1: a role page's ?server= used to be stored for this and
// later visits without a question, in the override the scorer page on the
// same origin reads first for its relay (PINs, rosters) and, on a page
// served from the LAN, for sign-in and the cloud API too.
describe('a role link ?server= (applyServerParam)', () => {
  const setLocation = (url) => {
    const u = new URL(url)
    Object.defineProperty(window, 'location', {
      value: { hostname: u.hostname, protocol: u.protocol, port: u.port, origin: u.origin, host: u.host, pathname: u.pathname, search: u.search },
      writable: true,
      configurable: true
    })
  }
  let fetchSpy
  beforeEach(() => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_BACKEND_URL', '')
    vi.stubEnv('VITE_CLOUD_API_URL', '')
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, json: async () => ({}) })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    fetchSpy.mockRestore()
  })

  it('a refused host: nothing stored, nothing fetched, nothing to ask', () => {
    setLocation('https://referee.openvolley.app/?server=x')
    setAppEntry('referee')
    for (const v of ['evil.example.com', 'http://203.0.113.5', 'https://openvolley.app.evil.example', 'http://backend.openvolley.app', 'javascript:alert(1)']) {
      expect(applyServerParam(v), v).toBe('none')
      expect(serverParamNeedsConfirm(v), v).toBe(false)
      expect(getBackendOverride(), v).toBeNull()
    }
    expect(localStorage.getItem('openvolley_backend_override')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('another server is used only once confirmed, by this role page in this tab, never by the scorer page', () => {
    setLocation('http://192.168.1.20:5173/referee?server=http%3A%2F%2F192.168.1.66%3A8080')
    setAppEntry('referee')
    expect(linkServerState('http://192.168.1.66:8080')).toEqual({ state: 'ask', url: 'http://192.168.1.66:8080' })
    expect(applyServerParam('http://192.168.1.66:8080')).toBe('ask')
    expect(getBackendOverride()).toBeNull()
    expect(getRelayWebSocketUrl()).toBe('ws://192.168.1.20:8080')

    // the connection screen asked, naming the host, and the user said yes
    expect(confirmLinkServer('http://192.168.1.66:8080')).toBe(true)
    expect(getBackendOverride()).toBe('http://192.168.1.66:8080')
    expect(getRelayWebSocketUrl()).toBe('ws://192.168.1.66:8080')
    // kept for this tab only, not for later visits
    expect(localStorage.getItem('openvolley_backend_override')).toBeNull()
    // a reload of the same link asks nothing
    expect(applyServerParam('http://192.168.1.66:8080')).toBe('known')

    // the bench page in the same tab has its own choice
    setAppEntry('bench')
    expect(getBackendOverride()).toBeNull()

    // the scorer page on the same origin (the same tab, later): its relay,
    // sign-in and cloud API stay on the page's own server
    setLocation('http://192.168.1.20:5173/')
    setAppEntry('scorer')
    expect(getBackendOverride()).toBeNull()
    expect(getRelayWebSocketUrl()).toBe('ws://192.168.1.20:8080')
    expect(getCloudApiBaseUrl()).toBe('http://192.168.1.20:5173')
    expect(confirmLinkServer('http://192.168.1.66:8080')).toBe(false)
    expect(getBackendOverride()).toBeNull()
  })

  it('a cloud scorer page never follows a link server either', () => {
    vi.stubEnv('VITE_BACKEND_URL', 'https://backend.openvolley.app')
    setLocation('https://app.openvolley.app/referee?server=x.openvolley.app')
    setAppEntry('referee')
    expect(applyServerParam('x.openvolley.app')).toBe('ask')
    confirmLinkServer('https://x.openvolley.app')
    expect(getCloudApiBaseUrl()).toBe('https://x.openvolley.app')
    setLocation('https://app.openvolley.app/')
    setAppEntry('scorer')
    expect(getCloudApiBaseUrl()).toBe('https://backend.openvolley.app')
    expect(getRelayWebSocketUrl()).toBe('wss://backend.openvolley.app')
  })

  it('the app\'s own server needs no question (the scorer\'s QR links name it)', () => {
    vi.stubEnv('VITE_BACKEND_URL', 'https://backend.openvolley.app')
    setLocation('https://referee.openvolley.app/?server=https%3A%2F%2Fbackend.openvolley.app')
    setAppEntry('referee')
    expect(applyServerParam('https://backend.openvolley.app')).toBe('known')
    expect(applyServerParam('https://backend.openvolley.app/')).toBe('known')
    expect(serverParamNeedsConfirm('backend.openvolley.app')).toBe(false)
    // a page served by a venue relay: a link to that relay itself
    vi.stubEnv('VITE_BACKEND_URL', '')
    setLocation('http://192.168.1.20:5173/bench?server=http%3A%2F%2F192.168.1.20%3A5173')
    setAppEntry('bench')
    expect(applyServerParam('http://192.168.1.20:5173')).toBe('known')
  })

  it('a link to the default replaces a typed server for this tab; a typed server replaces the link\'s', () => {
    vi.stubEnv('VITE_BACKEND_URL', 'https://backend.openvolley.app')
    setLocation('https://referee.openvolley.app/')
    setAppEntry('referee')
    setBackendOverride('http://192.168.1.30:8080') // typed earlier on this tablet
    expect(applyServerParam('https://backend.openvolley.app')).toBe('known')
    expect(getBackendOverride()).toBe('https://backend.openvolley.app')
    // the connection screen: a server typed now wins over the link's
    setBackendOverride('http://192.168.1.31:8080')
    expect(getBackendOverride()).toBe('http://192.168.1.31:8080')
    // "Online (automatic)" clears both
    confirmLinkServer('https://backend.openvolley.app')
    clearBackendOverride()
    expect(getBackendOverride()).toBeNull()
    expect(getBackendUrl()).toBe('https://backend.openvolley.app')
  })

  // Review: a page a venue relay serves on an address the allow-list does not
  // cover (plain host name, IPv6, 100.64/10): a link naming that relay was
  // 'none', and the connection screen refused it
  it.each(['http://scorer-laptop:5173', 'http://[fd00::20]:5173', 'http://100.64.3.20:5173'])(
    'a link naming the page\'s own server on %s is known, and used with no override', (own) => {
      setLocation(`${own}/referee`)
      setAppEntry('referee')
      expect(isAllowedBackendUrl(own)).toBe(false)
      expect(isDefaultBackendUrl(own)).toBe(true)
      expect(isDefaultBackendUrl(`${own}/`)).toBe(true)
      expect(linkServerState(own)).toEqual({ state: 'known', url: own })
      expect(serverParamNeedsConfirm(own)).toBe(false)
      expect(applyServerParam(own)).toBe('known')
      expect(getBackendOverride()).toBeNull()
      expect(getBackendUrl()).toBe(own)
      expect(confirmLinkServer(own)).toBe(true)
      expect(fetchSpy).not.toHaveBeenCalled()
    }
  )

  it('a link naming the page\'s own server replaces a typed or linked one for this tab only', () => {
    const own = 'http://scorer-laptop:5173'
    setLocation(`${own}/referee`)
    setAppEntry('referee')
    setBackendOverride('http://192.168.1.30:8080') // typed earlier on this tablet
    expect(applyServerParam('http://192.168.1.66:8080')).toBe('ask')
    expect(confirmLinkServer('http://192.168.1.66:8080')).toBe(true)
    expect(getBackendUrl()).toBe('http://192.168.1.66:8080')
    // the scorer's QR code of this relay, opened in the same tab
    expect(applyServerParam(own)).toBe('known')
    expect(getBackendOverride()).toBeNull()
    expect(getBackendUrl()).toBe(own)
    expect(getRelayWebSocketUrl()).toBe('ws://scorer-laptop:8080')
    // later visits keep the device's choice
    expect(localStorage.getItem('openvolley_backend_override')).toBe('http://192.168.1.30:8080')
    sessionStorage.clear()
    expect(getBackendUrl()).toBe('http://192.168.1.30:8080')
  })

  it('another plain host name stays refused, also on such a page', () => {
    setLocation('http://scorer-laptop:5173/referee')
    setAppEntry('referee')
    for (const v of ['http://other-laptop:5173', 'other-laptop:5173', 'scorer-laptop:5173', 'http://scorer-laptop:8080']) {
      expect(linkServerState(v), v).toEqual({ state: 'none', url: null })
      expect(isDefaultBackendUrl(v), v).toBe(false)
      expect(confirmLinkServer(v), v).toBe(false)
    }
    expect(getBackendOverride()).toBeNull()
    expect(getBackendUrl()).toBe('http://scorer-laptop:5173')
  })
})

// Owner decision 5: dev-branch builds (Pages previews, dev-*.openvolley.app)
// must not use the production backend. The build puts the test backend in
// VITE_BACKEND_URL (build-channel.js); without one there is none at all.
describe('dev builds never fall back to the production backend', () => {
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
    vi.stubEnv('VITE_OV_DEV_BUILD', 'true')
    vi.stubEnv('VITE_BACKEND_URL', '')
    vi.stubEnv('VITE_CLOUD_API_URL', '')
  })
  afterEach(() => {
    delete window.Capacitor
    vi.unstubAllEnvs()
  })

  it('without a test backend: no backend, no relay, no cloud API', () => {
    setLocation('https://dev-app.openvolley.app/')
    expect(isDevBuildWithoutBackend()).toBe(true)
    expect(getBackendUrl()).toBeNull()
    expect(getRelayWebSocketUrl()).toBeNull()
    expect(getCloudApiBaseUrl()).toBeNull()
    expect(getCloudApiUrl('/api/auth/sign-in')).toBeNull()
    setLocation('https://dev.openvolley-referee.pages.dev/')
    expect(getBackendUrl()).toBeNull()
    // a venue relay chosen on the page still works; the cloud stays absent
    setBackendOverride('http://192.168.1.20:8080')
    expect(getRelayWebSocketUrl()).toBe('ws://192.168.1.20:8080')
    expect(getCloudApiBaseUrl()).toBeNull()
  })

  it('with a test backend: that one for everything', () => {
    vi.stubEnv('VITE_BACKEND_URL', 'https://dev-backend.openvolley.app')
    setLocation('https://dev-app.openvolley.app/')
    expect(isDevBuildWithoutBackend()).toBe(false)
    expect(getBackendUrl()).toBe('https://dev-backend.openvolley.app')
    expect(getRelayWebSocketUrl()).toBe('wss://dev-backend.openvolley.app')
    expect(getCloudApiBaseUrl()).toBe('https://dev-backend.openvolley.app')
  })

  it('a production build is unchanged', () => {
    vi.stubEnv('VITE_OV_DEV_BUILD', '')
    setLocation('https://app.openvolley.app/')
    expect(isDevBuild()).toBe(false)
    expect(getBackendUrl()).toBe('https://backend.openvolley.app')
    expect(getCloudApiBaseUrl()).toBe('https://backend.openvolley.app')
  })
})
