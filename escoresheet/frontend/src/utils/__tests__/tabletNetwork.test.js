import { describe, it, expect, vi, beforeEach } from 'vitest'
import { bluetoothNetwork, displayedWifi, hotspot, isTabletNetworkAvailable, netError, rememberedWifi } from '../tabletNetwork'

function fakeTauri(handlers) {
  const invoke = vi.fn(async (cmd, args) => {
    const h = handlers[cmd]
    if (!h) throw { code: 'unknown', detail: cmd }
    return h(args)
  })
  return { win: { __TAURI_INTERNALS__: { invoke } }, invoke }
}

describe('tabletNetwork', () => {
  beforeEach(() => localStorage.clear())

  it('is only available in the desktop app', async () => {
    expect(isTabletNetworkAvailable({})).toBe(false)
    expect(isTabletNetworkAvailable(fakeTauri({}).win)).toBe(true)
    await expect(hotspot.status({})).rejects.toMatchObject({ code: 'not-desktop' })
  })

  it('starts with the remembered name and password so tablets rejoin by themselves', async () => {
    const { win, invoke } = fakeTauri({
      hotspot_start: (args) => ({ active: true, ssid: args.ssid || 'OpenVolley-NEW1', password: args.password || 'genpass12345', gatewayIp: '10.42.0.1' })
    })
    const first = await hotspot.start(win)
    expect(invoke).toHaveBeenLastCalledWith('hotspot_start', {})
    expect(first.ssid).toBe('OpenVolley-NEW1')
    expect(rememberedWifi()).toEqual({ ssid: 'OpenVolley-NEW1', password: 'genpass12345' })

    await hotspot.start(win)
    expect(invoke).toHaveBeenLastCalledWith('hotspot_start', { ssid: 'OpenVolley-NEW1', password: 'genpass12345' })
  })

  it('shows the remembered credentials until the Wi-Fi runs', () => {
    expect(displayedWifi({ active: false, ssid: 'OpenVolley-RUN1', password: 'session12345' })).toEqual({ ssid: 'OpenVolley-RUN1', password: 'session12345' })
    localStorage.setItem('ov_tablet_wifi', JSON.stringify({ ssid: 'OpenVolley-OLD1', password: 'oldpass12345' }))
    expect(displayedWifi({ active: false, ssid: 'OpenVolley-RUN1', password: 'session12345' })).toEqual({ ssid: 'OpenVolley-OLD1', password: 'oldpass12345' })
    expect(displayedWifi({ active: true, ssid: 'OpenVolley-RUN1', password: 'session12345' })).toEqual({ ssid: 'OpenVolley-RUN1', password: 'session12345' })
    localStorage.setItem('ov_tablet_wifi', '{broken')
    expect(rememberedWifi()).toBeNull()
  })

  it('calls the Bluetooth commands and normalises errors', async () => {
    const { win, invoke } = fakeTauri({ bluetooth_status: () => ({ supported: false, reason: 'windows-cannot-serve' }) })
    expect(await bluetoothNetwork.status(win)).toMatchObject({ reason: 'windows-cannot-serve' })
    expect(invoke).toHaveBeenCalledWith('bluetooth_status', {})
    await expect(bluetoothNetwork.start(win)).rejects.toMatchObject({ code: 'unknown' })
    expect(netError({ code: 'no-ap-mode', detail: 'wlp1s0' })).toEqual({ code: 'no-ap-mode', detail: 'wlp1s0' })
    expect(netError('boom')).toEqual({ code: 'failed', detail: 'boom' })
    expect(netError(new Error('x'))).toEqual({ code: 'failed', detail: 'x' })
  })
})
