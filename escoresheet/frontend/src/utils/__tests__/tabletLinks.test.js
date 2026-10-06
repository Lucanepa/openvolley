import { describe, it, expect } from 'vitest'
import {
  LAN_UNAVAILABLE_ROLES, TABLET_ROLES, cloudRoleUrl, cloudScoretableBase, escapeWifiQr, firstOfKind, hallInterfaces, lanRoleUrl,
  roleAccess, statusInterfaces, wifiQrString
} from '../tabletLinks'

const MATCH = {
  id: 7,
  seed_key: 'match_1759740000000_ab12cd',
  refereePin: '123456',
  homeTeamPin: '234567',
  awayTeamPin: '345678',
  gamePin: '999999',
  refereeConnectionEnabled: true,
  homeTeamConnectionEnabled: true,
  awayTeamConnectionEnabled: false
}

describe('lanRoleUrl', () => {
  it('builds every role on the laptop address, the match preselected, benches with their team', () => {
    const urls = TABLET_ROLES.map(r => lanRoleUrl('10.42.0.1', 5173, r, MATCH.seed_key))
    expect(urls).toEqual([
      'http://10.42.0.1:5173/',
      'http://10.42.0.1:5173/referee?match=match_1759740000000_ab12cd',
      'http://10.42.0.1:5173/bench?match=match_1759740000000_ab12cd&team=home',
      'http://10.42.0.1:5173/bench?match=match_1759740000000_ab12cd&team=away',
      'http://10.42.0.1:5173/livescore'
    ])
  })

  it('never puts a PIN in a link', () => {
    for (const role of TABLET_ROLES) {
      const url = lanRoleUrl('192.168.1.42', 5173, role, MATCH.seed_key)
      for (const pin of ['123456', '234567', '345678', '999999']) expect(url).not.toContain(pin)
      expect(url).not.toMatch(/pin=/i)
    }
  })

  it('works without a match, without a port and gives nothing without an address', () => {
    expect(lanRoleUrl('192.168.1.42', 5173, 'referee', null)).toBe('http://192.168.1.42:5173/referee')
    expect(lanRoleUrl('192.168.1.42', 5173, 'bench_away', null)).toBe('http://192.168.1.42:5173/bench?team=away')
    expect(lanRoleUrl('192.168.1.42', '', 'livescore', null)).toBe('http://192.168.1.42/livescore')
    expect(lanRoleUrl(null, 5173, 'referee', 'x')).toBeNull()
    expect(lanRoleUrl('192.168.1.42', 5173, 'nope', 'x')).toBeNull()
  })
})

describe('cloudRoleUrl', () => {
  it('links the role site with the scorer\'s backend and the match', () => {
    const opts = { cloudApiBase: 'https://backend.openvolley.app', hostname: 'localhost' }
    expect(cloudRoleUrl('referee', 'm1', opts)).toBe('https://referee.openvolley.app/?server=https%3A%2F%2Fbackend.openvolley.app&match=m1')
    expect(cloudRoleUrl('bench_home', 'm1', opts)).toBe('https://bench.openvolley.app/?server=https%3A%2F%2Fbackend.openvolley.app&match=m1&team=home')
    expect(cloudRoleUrl('bench_away', 'm1', opts)).toBe('https://bench.openvolley.app/?server=https%3A%2F%2Fbackend.openvolley.app&match=m1&team=away')
    expect(cloudRoleUrl('livescore', 'm1', opts)).toBe('https://livescore.openvolley.app/?server=https%3A%2F%2Fbackend.openvolley.app')
    expect(cloudRoleUrl('main', 'm1', opts)).toBe('https://app.openvolley.app/')
  })

  it('stays on the scorer\'s deployment (dev, Pages previews)', () => {
    expect(cloudRoleUrl('referee', 'm1', { hostname: 'dev-app.openvolley.app' })).toBe('https://dev-referee.openvolley.app/?match=m1')
    expect(cloudRoleUrl('main', null, { hostname: 'dev-app.openvolley.app' })).toBe('https://dev-app.openvolley.app/')
    expect(cloudScoretableBase('feat-x.openvolley-app.pages.dev')).toBe('https://feat-x.openvolley-app.pages.dev')
    expect(cloudScoretableBase('localhost')).toBe('https://app.openvolley.app')
  })
})

describe('roleAccess', () => {
  it('gives the role PIN and whether the scorer let the role in; never the game PIN', () => {
    expect(roleAccess(MATCH, 'referee')).toMatchObject({ pin: '123456', enabled: true, field: 'refereeConnectionEnabled', syncField: 'referee_enabled' })
    expect(roleAccess(MATCH, 'bench_home')).toMatchObject({ pin: '234567', enabled: true, syncField: 'home_bench_enabled' })
    expect(roleAccess(MATCH, 'bench_away')).toMatchObject({ pin: '345678', enabled: false, syncField: 'away_bench_enabled' })
    for (const role of ['main', 'livescore']) {
      expect(roleAccess(MATCH, role)).toEqual({ pin: null, enabled: null, field: null, syncField: null, pinKey: null })
    }
    expect(roleAccess(null, 'referee')).toMatchObject({ pin: null, enabled: null })
    expect(roleAccess({ refereePin: '  ' }, 'referee').pin).toBeNull()
  })
})

describe('status interfaces', () => {
  const STATUS = {
    localIP: '192.168.1.42',
    port: 5173,
    interfaces: [
      { name: 'wlp1s0', ip: '10.42.0.1', kind: 'hotspot' },
      { name: 'enp0s31f6', ip: '10.0.0.5', kind: 'ethernet' },
      { name: 'wlx00', ip: '192.168.1.42', kind: 'wifi' },
      { name: 'pan-openvolley', ip: '10.42.1.1', kind: 'bluetooth' }
    ]
  }

  it('lists hall networks (Wi-Fi first), then the laptop\'s hotspot, never Bluetooth', () => {
    // a hotspot switched on outside the app is still a network tablets can be on
    expect(hallInterfaces(STATUS).map(i => i.ip)).toEqual(['192.168.1.42', '10.0.0.5', '10.42.0.1'])
    expect(hallInterfaces({ interfaces: [{ name: 'Local Area Connection* 10', ip: '192.168.137.1', kind: 'hotspot' }] }).map(i => i.ip)).toEqual(['192.168.137.1'])
    expect(firstOfKind(STATUS, 'hotspot').ip).toBe('10.42.0.1')
    expect(firstOfKind(STATUS, 'bluetooth').ip).toBe('10.42.1.1')
    expect(firstOfKind({ interfaces: [] }, 'hotspot')).toBeNull()
  })

  it('falls back to localIP for relays without interfaces, never loopback', () => {
    expect(statusInterfaces({ localIP: '192.168.1.20', port: 3000 })).toEqual([{ name: '', ip: '192.168.1.20', kind: 'other' }])
    expect(statusInterfaces({ localIP: '127.0.0.1' })).toEqual([])
    expect(statusInterfaces(null)).toEqual([])
  })
})

describe('LAN_UNAVAILABLE_ROLES', () => {
  it('lets every role on the local network: the livescore follows the relay', () => {
    expect(LAN_UNAVAILABLE_ROLES).toEqual({})
    for (const role of TABLET_ROLES) expect(LAN_UNAVAILABLE_ROLES[role]).toBeUndefined()
    expect(lanRoleUrl('10.42.0.1', 5173, 'livescore', 'match_1')).toBe('http://10.42.0.1:5173/livescore')
  })
})

describe('Wi-Fi QR code', () => {
  it('escapes backslash, semicolon, comma, colon and double quote', () => {
    expect(escapeWifiQr('a\\b;c,d:e"f')).toBe('a\\\\b\\;c\\,d\\:e\\"f')
    expect(escapeWifiQr('OpenVolley-AB12')).toBe('OpenVolley-AB12')
    expect(escapeWifiQr("it's ok")).toBe("it's ok")
  })

  it('builds the WIFI: URI tablets join from', () => {
    expect(wifiQrString({ ssid: 'OpenVolley-AB12', password: 'example-Pq2m' })).toBe('WIFI:T:WPA;S:OpenVolley-AB12;P:example-Pq2m;;')
    expect(wifiQrString({ ssid: 'Hall;1', password: 'p:a,s"s\\' })).toBe('WIFI:T:WPA;S:Hall\\;1;P:p\\:a\\,s\\"s\\\\;;')
    expect(wifiQrString({ ssid: 'Open hall' })).toBe('WIFI:T:nopass;S:Open hall;;')
    expect(wifiQrString({ ssid: 'Hidden', password: 'example1', hidden: true })).toBe('WIFI:T:WPA;S:Hidden;P:example1;H:true;;')
    expect(wifiQrString({ ssid: '' })).toBeNull()
  })
})
