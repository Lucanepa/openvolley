/**
 * Which way a phone can reach a signing session (utils/phoneSignTransport.js,
 * docs/qr-signing-spec.md 5.2 and 5.4): every row of both tables.
 */
import { describe, it, expect } from 'vitest'
import { availableTransports, mayStartPhoneSign, rememberTransport, rememberedTransport, REASON_KEYS, TRANSPORT_KEY } from '../phoneSignTransport'

const scorer = { roles: ['scorer'], isAdmin: false }
const relayStatus = (interfaces, extra = {}) => ({ running: true, port: 5173, protocol: 'http', interfaces, ...extra })
const HALL = { name: 'wlan0', ip: '192.168.1.10', kind: 'wifi' }
const ETH = { name: 'eth0', ip: '10.0.0.5', kind: 'ethernet' }
const SPOT = { name: 'hotspot', ip: '10.42.0.1', kind: 'hotspot' }
const online = { online: true, cloudApiBase: 'https://backend.openvolley.app/', signedIn: true, access: scorer }
const relay = { relayOrigin: 'http://localhost:5173', relayStatus: relayStatus([HALL]) }

describe('availableTransports', () => {
  it('cloud: online, signed in with a scorer, referee or admin account', () => {
    const t = availableTransports(online)
    expect(t.cloud).toEqual({ ok: true, apiBase: 'https://backend.openvolley.app', phoneBase: 'https://backend.openvolley.app' })
    expect(t.default).toBe('cloud')
    expect(t.lan).toMatchObject({ ok: false, reason: 'noRelay' })
  })

  it('cloud is out offline, without a cloud, on a refused port, signed out or without a role', () => {
    expect(availableTransports({ ...online, online: false }).cloud.reason).toBe('offline')
    expect(availableTransports({ ...online, cloudApiBase: null }).cloud.reason).toBe('offline')
    expect(availableTransports({ ...online, cloudBlocked: true }).cloud.reason).toBe('offline')
    expect(availableTransports({ ...online, signedIn: false }).cloud.reason).toBe('signIn')
    expect(availableTransports({ ...online, access: { roles: ['competition_manager'] } }).cloud.reason).toBe('role')
    expect(availableTransports({ ...online, access: { roles: [] , isAdmin: true } }).cloud.ok).toBe(true)
    expect(availableTransports({ ...online, access: { roles: ['beach:referee'] } }).cloud.ok).toBe(true)
  })

  it('lan: the relay serving this page and an address a phone can open', () => {
    const t = availableTransports({ ...relay, online: false })
    expect(t.lan).toMatchObject({ ok: true, apiBase: 'http://localhost:5173', phoneBase: 'http://192.168.1.10:5173', ip: '192.168.1.10', wifiStep: false })
    expect(t.default).toBe('lan')
  })

  it('lan: the hall Wi-Fi first, the picked address when there are several', () => {
    const status = relayStatus([SPOT, ETH, HALL])
    expect(availableTransports({ ...relay, relayStatus: status }).lan.ip).toBe('192.168.1.10')
    expect(availableTransports({ ...relay, relayStatus: status, hallIp: '10.0.0.5' }).lan.ip).toBe('10.0.0.5')
    expect(availableTransports({ ...relay, relayStatus: status }).lan.addresses.map((a) => a.ip)).toEqual(['192.168.1.10', '10.0.0.5', '10.42.0.1'])
  })

  it('lan: the laptop\'s own Wi-Fi needs the Wi-Fi step first', () => {
    const t = availableTransports({ ...relay, relayStatus: relayStatus([HALL, SPOT]), lanMode: 'laptop', hotspot: { active: true, gatewayIp: '10.42.0.1' } })
    expect(t.lan).toMatchObject({ ok: true, ip: '10.42.0.1', phoneBase: 'http://10.42.0.1:5173', wifiStep: true })
    // Only the laptop's Wi-Fi, no hall network
    const only = availableTransports({ ...relay, relayStatus: relayStatus([]), lanMode: 'laptop', hotspot: { active: true, gatewayIp: '10.42.0.1' } })
    expect(only.lan.ok).toBe(true)
    // Laptop mode chosen but the Wi-Fi is off: the hall address
    expect(availableTransports({ ...relay, lanMode: 'laptop', hotspot: { active: false } }).lan).toMatchObject({ ip: '192.168.1.10', wifiStep: false })
  })

  it('lan: a page opened by its LAN address gives the phone the same address', () => {
    const t = availableTransports({ relayOrigin: 'http://192.168.1.10:5173', relayStatus: relayStatus([]), pageOrigin: 'http://192.168.1.10:5173', pageOnLanAddress: true })
    expect(t.lan).toMatchObject({ ok: true, phoneBase: 'http://192.168.1.10:5173' })
  })

  it('lan: https relays give https links', () => {
    expect(availableTransports({ ...relay, relayStatus: relayStatus([HALL], { protocol: 'https', port: 8443 }) }).lan.phoneBase).toBe('https://192.168.1.10:8443')
  })

  it('both work: the cloud by default (D6), the remembered choice wins', () => {
    expect(availableTransports({ ...online, ...relay }).default).toBe('cloud')
    expect(availableTransports({ ...online, ...relay, remembered: 'lan' }).default).toBe('lan')
    expect(availableTransports({ ...online, remembered: 'lan' }).default).toBe('cloud')
  })

  it('the reasons of 5.4 when nothing works', () => {
    // No internet and no relay at all
    expect(availableTransports({ online: false }).reason).toBe('none')
    // Online, not signed in, no relay
    expect(availableTransports({ ...online, signedIn: false }).reason).toBe('signIn')
    // Signed in without a scorer, referee or admin role, no relay
    expect(availableTransports({ ...online, access: { roles: [] } }).reason).toBe('role')
    // A relay, but no address a phone can reach
    expect(availableTransports({ ...online, signedIn: false, relayOrigin: 'http://localhost:5173', relayStatus: relayStatus([]) }).reason).toBe('noNetwork')
    // Something works: no reason
    expect(availableTransports(online).reason).toBeNull()
    for (const r of ['none', 'signIn', 'role', 'noNetwork']) expect(REASON_KEYS[r]).toMatch(/^phoneSign\.reason/)
  })
})

describe('mayStartPhoneSign and the remembered choice', () => {
  it('the same callers as account approval (D2)', () => {
    expect(mayStartPhoneSign(scorer)).toBe(true)
    expect(mayStartPhoneSign({ roles: ['referee'] })).toBe(true)
    expect(mayStartPhoneSign({ roles: ['beach:scorer'] })).toBe(true)
    expect(mayStartPhoneSign({ roles: ['competition_manager'] })).toBe(false)
    expect(mayStartPhoneSign(null)).toBe(false)
  })
  it('is stored and read safely', () => {
    const mem = new Map()
    const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }
    expect(rememberedTransport(storage)).toBeNull()
    rememberTransport('lan', storage)
    expect(mem.get(TRANSPORT_KEY)).toBe('lan')
    expect(rememberedTransport(storage)).toBe('lan')
    mem.set(TRANSPORT_KEY, 'carrier-pigeon')
    expect(rememberedTransport(storage)).toBeNull()
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(rememberedTransport(broken)).toBeNull()
    expect(() => rememberTransport('cloud', broken)).not.toThrow()
  })
})
