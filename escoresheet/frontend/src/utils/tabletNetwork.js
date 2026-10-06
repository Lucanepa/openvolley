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

export const hotspot = {
  status: (win) => call('hotspot_status', {}, win),
  /** Start with the remembered name / password, else the app's own for this run. */
  start: async (win) => {
    const saved = rememberedWifi()
    const status = await call('hotspot_start', saved ? { ssid: saved.ssid, password: saved.password } : {}, win)
    if (status?.ssid && status?.password) rememberWifi(status.ssid, status.password)
    return status
  },
  stop: (win) => call('hotspot_stop', {}, win)
}

export const bluetoothNetwork = {
  status: (win) => call('bluetooth_status', {}, win),
  start: (win) => call('bluetooth_start', {}, win),
  stop: (win) => call('bluetooth_stop', {}, win)
}

/** The name / password the dialog shows before the Wi-Fi is on: the remembered ones win. */
export function displayedWifi(status) {
  if (status?.active) return { ssid: status.ssid, password: status.password }
  return rememberedWifi() || (status?.ssid ? { ssid: status.ssid, password: status.password } : null)
}
