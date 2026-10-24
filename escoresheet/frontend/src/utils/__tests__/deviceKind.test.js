import { describe, it, expect } from 'vitest'
import { detectDevice, detectOs } from '../deviceKind'

const UA = {
  androidPhone: 'Mozilla/5.0 (Linux; Android 16; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
}
const win = (userAgent, extra = {}) => ({ navigator: { userAgent, maxTouchPoints: 0, ...extra.nav }, screen: extra.screen || { width: 1920, height: 1080 }, ...extra.win })

describe('deviceKind', () => {
  it('reads the OS from the user agent', () => {
    expect(detectOs(win(UA.androidPhone))).toBe('android')
    expect(detectOs(win(UA.iphone))).toBe('ios')
    expect(detectOs(win(UA.windows))).toBe('windows')
    expect(detectOs(win(UA.linux))).toBe('linux')
    expect(detectOs(win(UA.chromebook))).toBe('chromeos')
    expect(detectOs(win(UA.ipadDesktop))).toBe('macos')
    expect(detectOs({})).toBe(null)
  })

  it('an iPad asking for the desktop site is iOS (it has a touch screen)', () => {
    expect(detectOs(win(UA.ipadDesktop, { nav: { maxTouchPoints: 5 } }))).toBe('ios')
  })

  it('the native app says its platform; userAgentData is used when there is one', () => {
    const cap = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } }
    expect(detectDevice(win(UA.linux, { win: cap, screen: { width: 412, height: 915 } }))).toEqual({ os: 'android', mobile: true, phone: true, nativeApp: true })
    expect(detectOs(win('', { nav: { userAgentData: { platform: 'Windows' } } }))).toBe('windows')
  })

  it('a phone is a mobile device with a phone-sized screen; a tablet is mobile, not a phone', () => {
    expect(detectDevice(win(UA.androidPhone, { screen: { width: 412, height: 915 } }))).toMatchObject({ mobile: true, phone: true, nativeApp: false })
    expect(detectDevice(win(UA.androidTablet, { screen: { width: 1280, height: 800 } }))).toMatchObject({ os: 'android', mobile: true, phone: false })
    expect(detectDevice(win(UA.windows))).toMatchObject({ os: 'windows', mobile: false, phone: false })
  })
})
