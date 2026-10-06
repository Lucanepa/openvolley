import { describe, it, expect } from 'vitest'
import { isLocalNetworkHost, backendOnLocalNetwork } from '../localNetwork'

describe('isLocalNetworkHost', () => {
  it('accepts this machine and the venue LAN', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.20',
      '169.254.3.4', '100.114.142.10', '::1', '[::1]', 'fd12:3456::1', 'fe80::1', 'openvolley.local', 'pi.lan', 'box.home.arpa', 'scoretable', 'openvolley']) {
      expect(isLocalNetworkHost(h), h).toBe(true)
    }
  })

  it('rejects the cloud and public addresses', () => {
    for (const h of ['backend.openvolley.app', 'app.openvolley.app', '8.8.8.8', '172.32.0.1', '192.169.0.1', '100.128.0.1', '', null, 'localhost.example.com']) {
      expect(isLocalNetworkHost(h), String(h)).toBe(false)
    }
  })
})

describe('backendOnLocalNetwork', () => {
  it('reads the backend URL host', () => {
    expect(backendOnLocalNetwork({ backendUrl: 'https://backend.openvolley.app' })).toBe(false)
    expect(backendOnLocalNetwork({ backendUrl: 'http://192.168.1.50:8080' })).toBe(true)
    expect(backendOnLocalNetwork({ backendUrl: 'http://127.0.0.1:5173' })).toBe(true)
    expect(backendOnLocalNetwork({ backendUrl: 'http://scoretable:3000' })).toBe(true)
  })

  it('without a backend URL: local only when served by the local server', () => {
    expect(backendOnLocalNetwork({ backendUrl: null, servedFromLocalServer: true })).toBe(true)
    expect(backendOnLocalNetwork({ backendUrl: null, servedFromLocalServer: false })).toBe(false)
  })

  it('treats a malformed URL as not local', () => {
    expect(backendOnLocalNetwork({ backendUrl: 'not a url' })).toBe(false)
  })
})
