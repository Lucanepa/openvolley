/**
 * The desktop app's own networks for the tablets (src-tauri/src/netshare):
 * the laptop's Wi-Fi (hotspot) and, on Linux, its Bluetooth network.
 *
 * Only the scoretable window of the desktop app (Tauri, http://localhost) has
 * these commands; everywhere else `isTabletNetworkAvailable()` is false and
 * the dialog explains the alternatives instead.
 */

const STORAGE_KEY = 'ov_tablet_wifi'

function tauriInvoke(win = typeof window !== 'undefined' ? window : undefined) {
  try {
    const invoke = win?.__TAURI_INTERNALS__?.invoke
    return typeof invoke === 'function' ? invoke.bind(win.__TAURI_INTERNALS__) : null
  } catch {
    return null
  }
}

export function isTabletNetworkAvailable(win) {
  return !!tauriInvoke(win)
}

function call(cmd, args, win) {
  const invoke = tauriInvoke(win)
  if (!invoke) return Promise.reject(Object.assign(new Error('not the desktop app'), { code: 'not-desktop' }))
  return invoke(cmd, args)
}

/** A command error ({ code, detail } from Rust, or anything thrown) as { code, detail }. */
export function netError(err) {
  if (err && typeof err === 'object' && typeof err.code === 'string') return { code: err.code, detail: err.detail || err.message || '' }
  return { code: 'failed', detail: typeof err === 'string' ? err : (err?.message || '') }
}

/** The network name / password the scorer last used, so tablets rejoin by themselves. */
export function rememberedWifi() {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (v && typeof v.ssid === 'string' && typeof v.password === 'string') return v
  } catch { /* private mode / bad JSON */ }
  return null
}

export function rememberWifi(ssid, password) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ssid, password })) } catch { /* private mode */ }
}

export function forgetWifi() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* private mode */ }
}

// Same rules as src-tauri/src/netshare/creds.rs: no 0/O, 1/I/l, 12
// characters, at least one letter beyond a-f (never read as a hex key).
const PASSWORD_CHARS = 'abcdefghijkmnpqrstuvwxyz' + 'ABCDEFGHJKMNPQRSTUVWXYZ' + '23456789'
const PASSWORD_LEN = 12

/** A fresh Wi-Fi password from the browser's random source. */
export function generateWifiPassword(cryptoImpl = globalThis.crypto) {
  for (;;) {
    const bytes = new Uint32Array(PASSWORD_LEN)
    cryptoImpl.getRandomValues(bytes)
    const p = Array.from(bytes, b => PASSWORD_CHARS[b % PASSWORD_CHARS.length]).join('')
    if (/[g-zG-Z]/.test(p)) return p
  }
}

/**
 * A new password for the tablets' Wi-Fi (it leaked, or the scorer wants a
 * fresh one): kept as the remembered one, used at the next start. Tablets
 * that joined with the old one must scan the Wi-Fi code again.
 * @param {{ ssid?: string }|null} current the name shown now (kept)
 */
export function renewWifiPassword(current) {
  const ssid = current?.ssid || rememberedWifi()?.ssid
  if (!ssid) return null
  const next = { ssid, password: generateWifiPassword() }
  rememberWifi(next.ssid, next.password)
  return next
}

export const hotspot = {
  status: (win) => call('hotspot_status', {}, win),
  /**
   * Start with the remembered name / password, else the app's own for this
   * run. Remembered ones the app refuses (edited storage, stricter rules in
   * a newer version) are forgotten and the run's own are used, so a bad pair
   * can never block the Wi-Fi for good.
   */
  start: async (win) => {
    const saved = rememberedWifi()
    let status
    try {
      status = await call('hotspot_start', saved ? { ssid: saved.ssid, password: saved.password } : {}, win)
    } catch (err) {
      if (!saved || err?.code !== 'invalid-credentials') throw err
      forgetWifi()
      status = await call('hotspot_start', {}, win)
    }
    if (status?.ssid && status?.password && !status?.external) rememberWifi(status.ssid, status.password)
    return status
  },
  stop: (win) => call('hotspot_stop', {}, win)
}

export const bluetoothNetwork = {
  status: (win) => call('bluetooth_status', {}, win),
  start: (win) => call('bluetooth_start', {}, win),
  stop: (win) => call('bluetooth_stop', {}, win)
}

/**
 * The name / password the dialog shows before the Wi-Fi is on: the
 * remembered ones win. A hotspot switched on outside the app shows what the
 * system tells (Windows: name and password; Linux: nothing).
 */
export function displayedWifi(status) {
  if (status?.active && status?.external) return status.ssid ? { ssid: status.ssid, password: status.password || null } : null
  if (status?.active) return { ssid: status.ssid, password: status.password }
  return rememberedWifi() || (status?.ssid ? { ssid: status.ssid, password: status.password } : null)
}
