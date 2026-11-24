/**
 * What kind of device this is, for the choices that depend on it ("Connect
 * tablets": owner 2026-10-24, a phone offered the desktop app's Wi-Fi and
 * Bluetooth).
 *
 *   os        'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'chromeos' | null
 *   mobile    a phone or a tablet (Android, iOS / iPadOS, the native app): the
 *             desktop app does not run there
 *   phone     a mobile device with a phone-sized screen
 *   nativeApp the Android / iOS app (Capacitor)
 *
 * The OS comes from the native app, else from navigator.userAgentData, else
 * from the user agent. An iPad asks for the desktop site ("Macintosh") but
 * has a touch screen, so it counts as iOS.
 */
import { isPhoneScreen } from '../components/scoreboard/phoneLayout.js'

function nativePlatform(win) {
  try {
    return win?.Capacitor?.isNativePlatform?.() ? (win.Capacitor.getPlatform?.() || null) : null
  } catch {
    return null
  }
}

/** @returns {'android'|'ios'|'windows'|'macos'|'linux'|'chromeos'|null} */
export function detectOs(win = typeof window !== 'undefined' ? window : undefined) {
  const native = nativePlatform(win)
  if (native === 'android' || native === 'ios') return native
  const nav = win?.navigator || {}
  const ua = String(nav.userAgent || '')
  const hint = String(nav.userAgentData?.platform || '')
  if (/android/i.test(hint) || /Android/.test(ua)) return 'android'
  if (/iOS/i.test(hint) || /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(nav.maxTouchPoints) > 1)) return 'ios'
  if (/chrome ?os/i.test(hint) || /\bCrOS\b/.test(ua)) return 'chromeos'
  if (/windows/i.test(hint) || /Windows/.test(ua)) return 'windows'
  if (/mac/i.test(hint) || /Macintosh|Mac OS X/.test(ua)) return 'macos'
  if (/linux/i.test(hint) || /Linux|X11/.test(ua)) return 'linux'
  return null
}

/** @returns {{ os: ReturnType<typeof detectOs>, mobile: boolean, phone: boolean, nativeApp: boolean }} */
export function detectDevice(win = typeof window !== 'undefined' ? window : undefined) {
  const os = detectOs(win)
  const mobile = os === 'android' || os === 'ios'
  return {
    os,
    mobile,
    phone: mobile && isPhoneScreen(win?.screen),
    nativeApp: !!nativePlatform(win)
  }
}
