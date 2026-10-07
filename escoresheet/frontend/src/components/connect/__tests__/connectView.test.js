import { describe, it, expect } from 'vitest'
import {
  VIEW_KEY, connectedSummary, defaultRole, formatPin, initialTransport, ipTail, readView, roleClients, roleStatus,
  saveView, transportOf, transportOptions, viewFor
} from '../connectView'

function memoryStorage(init = {}) {
  const data = { ...init }
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v) },
    data
  }
}

const opt = (options, id) => options.find(o => o.id === id)
const recommended = (options) => options.find(o => o.recommended)?.id

describe('connectView: saved view', () => {
  it('reads the QR-signing shape and drops unknown values', () => {
    const s = memoryStorage({ [VIEW_KEY]: JSON.stringify({ tab: 'lan', lanMode: 'laptop', hallIp: '10.0.0.5' }) })
    expect(readView(s)).toEqual({ tab: 'lan', lanMode: 'laptop', hallIp: '10.0.0.5' })
    expect(readView(memoryStorage({ [VIEW_KEY]: '{"tab":"usb","lanMode":"x"}' }))).toEqual({ tab: null, lanMode: 'hall', hallIp: null })
    expect(readView(memoryStorage({ [VIEW_KEY]: 'not json' }))).toEqual({ tab: null, lanMode: 'hall', hallIp: null })
    expect(readView(memoryStorage())).toEqual({ tab: null, lanMode: 'hall', hallIp: null })
  })

  it('saves tab, lanMode and hallIp', () => {
    const s = memoryStorage()
    saveView({ tab: 'server', lanMode: 'laptop', hallIp: '192.168.1.42', extra: 1 }, s)
    expect(JSON.parse(s.data[VIEW_KEY])).toEqual({ tab: 'server', lanMode: 'laptop', hallIp: '192.168.1.42' })
  })

  it('a storage that throws is ignored', () => {
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(readView(broken)).toEqual({ tab: null, lanMode: 'hall', hallIp: null })
    expect(() => saveView({ tab: 'lan' }, broken)).not.toThrow()
  })

  it('maps the four connections onto tab + lanMode and back', () => {
    const v = { tab: 'lan', lanMode: 'hall', hallIp: '1.2.3.4' }
    expect(viewFor(v, 'laptop')).toEqual({ tab: 'lan', lanMode: 'laptop', hallIp: '1.2.3.4' })
    expect(viewFor({ ...v, lanMode: 'laptop' }, 'server')).toEqual({ tab: 'server', lanMode: 'laptop', hallIp: '1.2.3.4' })
    expect(viewFor(v, 'bogus')).toBe(v)
    expect(transportOf({ tab: 'lan', lanMode: 'hall' })).toBe('hall')
    expect(transportOf({ tab: 'lan', lanMode: 'laptop' })).toBe('laptop')
    expect(transportOf({ tab: 'bluetooth' })).toBe('bluetooth')
    expect(transportOf({ tab: null })).toBeNull()
  })
})

describe('connectView: step 1 options', () => {
  const HALLS = [{ ip: '192.168.1.42', kind: 'wifi' }]

  it('web build: only Internet works, and is recommended', () => {
    const o = transportOptions({ served: false, desktop: false })
    expect(opt(o, 'hall')).toMatchObject({ available: false, reasonKey: 'needsServer' })
    expect(opt(o, 'laptop')).toMatchObject({ available: false, reasonKey: 'needsDesktop' })
    expect(opt(o, 'server')).toMatchObject({ available: true })
    expect(opt(o, 'bluetooth')).toMatchObject({ available: false, reasonKey: 'needsLinuxDesktop', experimental: true })
    expect(recommended(o)).toBe('server')
  })

  it('desktop on the hall Wi-Fi: Hall Wi-Fi recommended (also while the addresses are being read)', () => {
    expect(recommended(transportOptions({ served: true, desktop: true, halls: HALLS }))).toBe('hall')
    const loading = transportOptions({ served: true, desktop: true, relayLoading: true })
    expect(recommended(loading)).toBe('hall')
    expect(opt(loading, 'hall').available).toBe(true)
  })

  it('desktop on no network: the computer\'s own Wi-Fi', () => {
    const o = transportOptions({ served: true, desktop: true, halls: [] })
    expect(opt(o, 'hall')).toMatchObject({ available: false, reasonKey: 'noNetwork' })
    expect(recommended(o)).toBe('laptop')
  })

  it('a hotspot already on wins', () => {
    expect(recommended(transportOptions({ served: true, desktop: true, halls: HALLS, hotspot: { supported: true, active: true } }))).toBe('laptop')
  })

  it('no hotspot possible and no network: Internet', () => {
    const o = transportOptions({ served: true, desktop: true, halls: [], hotspot: { supported: false, active: false, reason: 'no-ap-mode' } })
    expect(opt(o, 'laptop')).toMatchObject({ available: false, reasonKey: 'cannotCreateWifi' })
    expect(recommended(o)).toBe('server')
  })

  it('cloud blocked, nothing else: falls back to Hall Wi-Fi', () => {
    const o = transportOptions({ served: true, desktop: false, halls: [], cloudBlocked: true })
    expect(opt(o, 'server')).toMatchObject({ available: false, reasonKey: 'cloudBlocked' })
    expect(recommended(o)).toBe('hall')
  })

  it('Bluetooth: Windows cannot serve, Linux can; a page elsewhere only when the relay reports one', () => {
    expect(opt(transportOptions({ served: true, desktop: true, platform: 'windows' }), 'bluetooth').reasonKey).toBe('windowsBluetooth')
    expect(opt(transportOptions({ served: true, desktop: true, bluetooth: { supported: false, reason: 'windows-cannot-serve' } }), 'bluetooth').reasonKey).toBe('windowsBluetooth')
    expect(opt(transportOptions({ served: true, desktop: true, bluetooth: { supported: false, reason: 'no-adapter' } }), 'bluetooth').reasonKey).toBe('btNotHere')
    expect(opt(transportOptions({ served: true, desktop: true, platform: 'linux' }), 'bluetooth').available).toBe(true)
    expect(opt(transportOptions({ served: true, desktop: false, bluetoothFound: true }), 'bluetooth').available).toBe(true)
  })

  it('opens on the saved connection only where it can work', () => {
    const web = transportOptions({ served: false, desktop: false })
    expect(initialTransport('hall', web)).toBe('server')
    expect(initialTransport(null, web)).toBe('server')
    const desk = transportOptions({ served: true, desktop: true, relayLoading: true })
    expect(initialTransport('laptop', desk)).toBe('laptop')
    expect(initialTransport('bluetooth', desk)).toBe('bluetooth')
    expect(initialTransport(null, desk)).toBe('hall')
  })
})

describe('connectView: live status', () => {
  const KEY = 'match_1'
  const ON = { pin: '123456', enabled: true }
  const at = (h, m) => `2026-10-07T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`
  const clients = [
    { role: 'referee', matchId: KEY, ip: '192.168.1.23', connectedAt: at(12, 40) },
    { role: 'bench', team: 'home', matchId: KEY, ip: '192.168.1.30', connectedAt: at(12, 10) },
    { role: 'bench', team: 'home', matchId: KEY, ip: '192.168.1.31', connectedAt: at(12, 5) },
    { role: 'referee', matchId: 'other', ip: '192.168.1.99', connectedAt: at(11, 0) },
    { role: 'livescore', matchId: KEY, ip: '192.168.1.50', connectedAt: at(11, 0) }
  ]

  it('off, then no PIN, come before anything the relay says', () => {
    expect(roleStatus({ role: 'referee', access: { pin: '1', enabled: false }, clients, matchKey: KEY, reachable: true }).status).toBe('off')
    expect(roleStatus({ role: 'bench_away', access: { pin: null, enabled: true }, clients, matchKey: KEY, reachable: true }).status).toBe('nopin')
  })

  it('livescore is public', () => {
    expect(roleStatus({ role: 'livescore', access: {}, clients, matchKey: KEY, reachable: true }).status).toBe('public')
  })

  it('waiting, connected (time + address), many', () => {
    expect(roleStatus({ role: 'bench_away', access: ON, clients, matchKey: KEY, reachable: true }).status).toBe('waiting')
    expect(roleStatus({ role: 'referee', access: ON, clients, matchKey: KEY, reachable: true }))
      .toEqual({ status: 'connected', count: 1, since: at(12, 40), ipTail: '23' })
    expect(roleStatus({ role: 'bench_home', access: ON, clients, matchKey: KEY, reachable: true }))
      .toEqual({ status: 'many', count: 2, since: at(12, 5), ipTail: '31' })
  })

  it('unknown when the relay cannot be read; remote on the internet with nobody seen here', () => {
    expect(roleStatus({ role: 'referee', access: ON, clients: null, matchKey: KEY, reachable: false }).status).toBe('unknown')
    expect(roleStatus({ role: 'bench_away', access: ON, clients, matchKey: KEY, reachable: true, transport: 'server' }).status).toBe('remote')
    expect(roleStatus({ role: 'referee', access: ON, clients: null, matchKey: KEY, reachable: false, transport: 'server' }).status).toBe('remote')
    // a tablet seen locally still counts on the internet tab
    expect(roleStatus({ role: 'referee', access: ON, clients, matchKey: KEY, reachable: true, transport: 'server' }).status).toBe('connected')
  })

  it('a bench that did not say its team counts for the one bench let in', () => {
    const anon = [{ role: 'bench', matchId: KEY, ip: '10.0.0.7', connectedAt: at(12, 0) }]
    const homeOnly = { homeTeamConnectionEnabled: true, awayTeamConnectionEnabled: false }
    expect(roleClients(anon, 'bench_home', KEY, homeOnly)).toHaveLength(1)
    expect(roleClients(anon, 'bench_away', KEY, homeOnly)).toHaveLength(0)
    expect(roleClients(anon, 'bench_home', KEY, { homeTeamConnectionEnabled: true, awayTeamConnectionEnabled: true })).toHaveLength(0)
  })

  it('ipTail', () => {
    expect(ipTail('192.168.1.23')).toBe('23')
    expect(ipTail('::ffff:10.0.0.5')).toBe('5')
    expect(ipTail('fe80::1a2b')).toBe('1a2b')
    expect(ipTail('')).toBe('')
  })

  it('footer summary counts roles with a tablet, of those let in', () => {
    const s = connectedSummary({
      referee: { status: 'connected' },
      bench_home: { status: 'waiting' },
      bench_away: { status: 'off' },
      livescore: { status: 'public' }
    })
    expect(s).toEqual({ connected: ['referee'], on: 2, known: true })
    expect(connectedSummary({ referee: { status: 'unknown' } }).known).toBe(false)
  })
})

describe('connectView: PIN and default tablet', () => {
  it('formatPin', () => {
    expect(formatPin('654949')).toBe('654 949')
    expect(formatPin(123456)).toBe('123 456')
    expect(formatPin('12345678')).toBe('1234 5678')
    expect(formatPin('1234')).toBe('1234')
    expect(formatPin(null)).toBe('')
  })

  it('defaultRole: first let in and not connected, else first let in, else the referee', () => {
    const access = (on) => (r) => ({ enabled: on.includes(r) })
    expect(defaultRole(access(['referee', 'bench_home']))).toBe('referee')
    expect(defaultRole(access(['referee', 'bench_home']), { referee: { status: 'connected' } })).toBe('bench_home')
    expect(defaultRole(access(['bench_away']))).toBe('bench_away')
    expect(defaultRole(access(['referee']), { referee: { status: 'many' } })).toBe('referee')
    expect(defaultRole(access([]))).toBe('referee')
  })
})
