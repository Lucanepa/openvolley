/**
 * Is diagnostics mode on for this page load? Off by default. On by any of:
 *   - the URL: ?diag=1 (this tab, until ?diag=0; ?diag=0 also overrides the rest)
 *   - the desktop app started with OPENVOLLEY_DIAGNOSTICS=1: its Rust side
 *     runs `window.__OV_DIAGNOSTICS__ = 'env'` before the page (diagnostics.rs)
 *   - Options > Logs > Diagnostics mode (localStorage, this device)
 * Never throws (storage may be blocked).
 */
export const DIAG_STORAGE_KEY = 'ov.diagnostics'
export const DIAG_SESSION_KEY = 'ov.diagnostics.url'
export const DIAG_URL_PARAM = 'diag'

const read = (storage, key) => {
  try { return storage?.getItem(key) ?? null } catch { return null }
}
const write = (storage, key, value) => {
  try {
    if (value == null) storage?.removeItem(key)
    else storage?.setItem(key, value)
  } catch { /* storage blocked */ }
}

/**
 * @param {{ win?: Window, local?: Storage, session?: Storage }} [opts]
 * @returns {{ on: boolean, source: 'url'|'env'|'options'|null }}
 */
export function diagnosticsSwitch({
  win = typeof window !== 'undefined' ? window : undefined,
  local = globalThis.localStorage,
  session = globalThis.sessionStorage
} = {}) {
  let param = null
  try {
    param = new URL(win?.location?.href || 'http://x/').searchParams.get(DIAG_URL_PARAM)
  } catch { /* no URL */ }
  if (param === '0') {
    write(session, DIAG_SESSION_KEY, null)
    return { on: false, source: 'url' }
  }
  if (param === '1') {
    write(session, DIAG_SESSION_KEY, '1')
    return { on: true, source: 'url' }
  }
  if (read(session, DIAG_SESSION_KEY) === '1') return { on: true, source: 'url' }
  if (win?.__OV_DIAGNOSTICS__) return { on: true, source: 'env' }
  if (read(local, DIAG_STORAGE_KEY) === '1') return { on: true, source: 'options' }
  return { on: false, source: null }
}

/** The Options switch (this device). */
export function diagnosticsOptionOn(local = globalThis.localStorage) {
  return read(local, DIAG_STORAGE_KEY) === '1'
}

export function setDiagnosticsOption(on, local = globalThis.localStorage) {
  write(local, DIAG_STORAGE_KEY, on ? '1' : null)
}
