/**
 * A random id for this device (localStorage 'ov.deviceId'), shared by the
 * account approvals (domain/accountApproval re-exports it) and the activity
 * log. It names an installation, not a person: it is created on first use and
 * goes away with the browser's site data.
 */

const DEVICE_KEY = 'ov.deviceId'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A random RFC 4122 v4 uuid (crypto.randomUUID when there is one). */
export function randomUuid() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* fall through */ }
  const b = new Uint8Array(16)
  try { crypto.getRandomValues(b) } catch { for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256) }
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** A random id for this device (localStorage 'ov.deviceId'); null without storage. */
export function deviceId(storage = globalThis.localStorage) {
  try {
    const existing = storage.getItem(DEVICE_KEY)
    if (existing && UUID_RE.test(existing)) return existing
    const id = randomUuid()
    storage.setItem(DEVICE_KEY, id)
    return storage.getItem(DEVICE_KEY) === id ? id : null
  } catch {
    return null
  }
}
