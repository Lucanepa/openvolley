/**
 * The key of a PIN slot (envelope.js): Argon2id (hash-wasm, WASM; WebCrypto
 * has no memory-hard KDF) from the PIN and the slot's salt, in a worker when
 * the platform has one, else on this thread (tests, a worker that cannot
 * start).
 *
 * Cost (2026-10-29, Node 24, one Ryzen 7 PRO 8700GE core):
 *   m=19 MiB t=2: 31 ms   m=32 MiB t=3: 76 ms   m=64 MiB t=1: 69 ms   m=64 MiB t=2: 114 ms
 * A mid-range Android tablet (Cortex-A76/A73 cores, WASM in the WebView) is
 * about 5x slower (4x to 8x): m=32 MiB t=3 is ~0.4 s there (0.3 to 0.6 s),
 * twice that for a wrong PIN at a restore (both slots are tried). 32 MiB also
 * fits a low-memory tablet's WebView. The sealer derives each PIN once per
 * match and session (sealer.js), never per file.
 *
 * A 6-digit PIN is a speed bump, not a lock: its 10^6 values cost about
 * 76 ms each, so a copied file falls to one 16-core desktop in about 80
 * minutes. It keeps a lost tablet's files from being read at a glance; the
 * recovery slot of a later phase (a server key) is the strong one.
 */

import { argon2idOptions } from './argon2'

export const KDF_PARAMS = Object.freeze({ alg: 'argon2id', memoryKiB: 32768, iterations: 3, parallelism: 1 })
export const SALT_BYTES = 16

// What a file may ask for: a damaged or crafted file must not make the app
// allocate gigabytes or spin for minutes
const LIMITS = { memoryKiB: [8192, 262144], iterations: [1, 16], parallelism: [1, 4] }

/** The KDF parameters of a slot, checked; throws for anything else. */
export function checkKdfParams(params) {
  if (params?.alg !== 'argon2id') throw new Error(`Unsupported key derivation: ${params?.alg}`)
  const out = { alg: 'argon2id' }
  for (const [name, [min, max]] of Object.entries(LIMITS)) {
    const v = params[name]
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`Key derivation ${name} out of range: ${v}`)
    out[name] = v
  }
  return out
}

async function deriveHere(pin, salt, params) {
  const { argon2id } = await import('hash-wasm')
  return argon2id(argon2idOptions(pin, salt, params))
}

// The worker: undefined until first asked, null when there is none (the rest
// of the session derives on this thread). Ended after a quiet minute: the
// WASM memory (32 MiB) is not given back while it runs.
const IDLE_MS = 60_000
let worker
let idleTimer = null
let nextJob = 0
const jobs = new Map()

function endWorker() {
  clearTimeout(idleTimer)
  idleTimer = null
  if (worker) worker.terminate()
  worker = undefined
}

function kdfWorker() {
  if (worker !== undefined) return worker
  worker = null
  if (typeof Worker !== 'function') return null
  try {
    const w = new Worker(new URL('./kdf.worker.js', import.meta.url), { type: 'module' })
    w.onmessage = ({ data }) => {
      const job = jobs.get(data?.id)
      if (!job) return
      jobs.delete(data.id)
      if (data.error) job.reject(new Error(data.error))
      else job.resolve(new Uint8Array(data.key))
      if (!jobs.size) idleTimer = setTimeout(endWorker, IDLE_MS)
    }
    // It could not load (or crashed): its jobs and the next ones run here
    w.onerror = (e) => {
      e?.preventDefault?.()
      console.warn('[BackupCrypto] KDF worker failed, deriving on the main thread:', e?.message || e)
      w.terminate()
      worker = null
      const waiting = [...jobs.values()]
      jobs.clear()
      for (const job of waiting) job.retryHere()
    }
    worker = w
  } catch {
    worker = null
  }
  return worker
}

/**
 * The 32-byte key of a PIN for one slot.
 * @param {string} pin
 * @param {Uint8Array} salt
 * @param {{ alg: 'argon2id', memoryKiB: number, iterations: number, parallelism: number }} [params]
 * @returns {Promise<Uint8Array>}
 */
export async function derivePinKey(pin, salt, params = KDF_PARAMS) {
  const checked = checkKdfParams(params)
  const w = kdfWorker()
  if (!w) return deriveHere(pin, salt, checked)
  clearTimeout(idleTimer)
  return new Promise((resolve, reject) => {
    const id = ++nextJob
    jobs.set(id, { resolve, reject, retryHere: () => deriveHere(pin, salt, checked).then(resolve, reject) })
    w.postMessage({ id, pin: String(pin), salt, params: checked })
  })
}
