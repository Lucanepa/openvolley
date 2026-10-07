/**
 * Who and what wrote a log line: the device id, the running app version, the
 * platform and the account signed in on this device. Synchronous and never
 * throwing: these are read inside Dexie hooks.
 */
import { deviceId } from './deviceId'

export { deviceId }

const SESSION_KEY = 'api_auth_token' // lib/apiClient AUTH_TOKEN_STORAGE_KEY

/** The running app version (vite define __APP_VERSION__). */
export function appVersion() {
  try {
    // eslint-disable-next-line no-undef
    return typeof __APP_VERSION__ !== 'undefined' ? String(__APP_VERSION__).slice(0, 32) : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Id of the account whose (unexpired) session is stored on this device, or
 * null. Same rule as useSyncQueue's storedSessionUserId: works offline and
 * outside React.
 */
export function currentAccountId(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(SESSION_KEY)
    if (!raw) return null
    const session = JSON.parse(raw)
    if (!session?.access_token) return null
    if (session.expires_at && Date.now() / 1000 > session.expires_at) return null
    const id = session.user?.id
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

/**
 * 'web' | 'tauri-linux' | 'tauri-windows' | 'tauri-macos' | 'android' | 'ios' | 'electron'
 */
export function platformName(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win) return 'web'
  try {
    if (win.electronAPI || win.process?.versions?.electron) return 'electron'
    if (typeof win.__TAURI_INTERNALS__?.invoke === 'function') {
      const ua = String(win.navigator?.userAgent || '')
      if (/windows/i.test(ua)) return 'tauri-windows'
      if (/mac os/i.test(ua)) return 'tauri-macos'
      return 'tauri-linux'
    }
    if (win.Capacitor?.isNativePlatform?.()) {
      const p = win.Capacitor.getPlatform?.()
      return p === 'ios' ? 'ios' : 'android'
    }
  } catch {
    // a half-initialised bridge is treated as a browser
  }
  return 'web'
}
